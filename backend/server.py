from fastapi import FastAPI, APIRouter, HTTPException, Query, BackgroundTasks, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import time
import logging
import asyncio
from pathlib import Path
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone
import yt_dlp

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# MongoDB
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="Ryhavean Spotify")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ryhavean")

# ---------- yt-dlp config ----------
YDL_SEARCH_OPTS = {
    "quiet": True, "no_warnings": True, "skip_download": True,
    "extract_flat": True, "default_search": "ytsearch",
    "noplaylist": True, "socket_timeout": 15,
}
YDL_STREAM_OPTS = {
    "quiet": True, "no_warnings": True, "skip_download": True,
    "format": "bestaudio[ext=m4a]/bestaudio/best",
    "noplaylist": True, "socket_timeout": 15,
}

# ---------- TTL cache ----------
_CACHE: dict = {}
_CACHE_TTL_FEATURED = 60 * 60 * 6   # 6 hours
_CACHE_TTL_SEARCH   = 60 * 30       # 30 min

def cache_get(key: str):
    v = _CACHE.get(key)
    if not v: return None
    exp, data = v
    if time.time() > exp:
        _CACHE.pop(key, None)
        return None
    return data

def cache_set(key: str, data, ttl: int):
    _CACHE[key] = (time.time() + ttl, data)

# ---------- yt-dlp helpers ----------
def _search_sync(query: str, limit: int = 20):
    opts = dict(YDL_SEARCH_OPTS)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
        entries = info.get("entries", [])
        results = []
        for entry in entries[:limit]:
            results.append({
                "id": entry.get("id", ""),
                "title": entry.get("title", "Unknown"),
                "artist": entry.get("artist") or entry.get("channel", "Unknown artist"),
                "duration": entry.get("duration", 0),
                "thumbnail": entry.get("thumbnail", ""),
            })
        return results

async def yt_search(query: str, limit: int = 20, ttl: int = _CACHE_TTL_SEARCH):
    cache_key = f"search:{query}:{limit}"
    cached = cache_get(cache_key)
    if cached:
        return cached
    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(None, lambda: _search_sync(query, limit))
    cache_set(cache_key, results, ttl)
    return results

# ---- Stream ----
_STREAM_URL_CACHE: dict = {}

def _extract_info_sync(url: str, opts: dict):
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    except Exception:
        return None

@api.get("/stream")
async def get_stream(video_id: str = Query(...)):
    from fastapi.responses import RedirectResponse
    cached = _STREAM_URL_CACHE.get(video_id)
    if cached and time.time() < cached["exp"]:
        return RedirectResponse(url=cached["url"])
    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        opts = dict(YDL_STREAM_OPTS)
        loop = asyncio.get_event_loop()
        info = await loop.run_in_executor(None, lambda: _extract_info_sync(url, opts))
        if not info:
            raise HTTPException(404, "Stream info could not be extracted")
        stream_url = info.get("url")
        if not stream_url:
            formats = info.get("formats", [])
            if formats:
                audio_formats = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") != "none"]
                if audio_formats:
                    audio_formats.sort(key=lambda f: f.get("abr", 0) or 0, reverse=True)
                    stream_url = audio_formats[0].get("url")
            if not stream_url:
                raise HTTPException(404, "No audio stream URL found")
        _STREAM_URL_CACHE[video_id] = {"url": stream_url, "exp": time.time() + 900}
        return RedirectResponse(url=stream_url)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stream extraction failed for {video_id}: {e}")
        raise HTTPException(502, f"Stream extraction failed: {str(e)}")

# ---- Search ----
class SearchResult(BaseModel):
    id: str; title: str; artist: str; duration: int; thumbnail: str

@api.get("/search")
async def search(q: str = Query(..., min_length=1, max_length=200), limit: int = Query(default=20, le=50)):
    results = await yt_search(q, limit)
    return {"results": results, "query": q}

# ---- Play-count ----
class PlayCountBody(BaseModel):
    song_id: str

@api.post("/play-count")
async def play_count(body: PlayCountBody):
    await db.play_counts.update_one({"id": body.song_id}, {"$inc": {"plays": 1}}, upsert=True)
    return {"ok": True}

# ---- Favorites models ----
class SongInfo(BaseModel):
    id: str; title: Optional[str] = ""
    artist: Optional[str] = ""; duration: Optional[int] = 0
    thumbnail: Optional[str] = ""

class FavoriteCreate(BaseModel):
    session_id: str; song: SongInfo

class RecentCreate(BaseModel):
    session_id: str; song: SongInfo

# ---- Recommend ----
@api.get("/recommend")
async def recommend(video_id: str = "", session_id: Optional[str] = None):
    try:
        query = "azerbaijan music hits 2025"
        if video_id:
            recent = await db.recently_played.find({"session_id": session_id}).sort("played_at", -1).to_list(3)
            if recent:
                artists = [r["artist"] for r in recent if r["artist"] != "Unknown artist"]
                if artists:
                    query = f"{artists[0]} oxşar mahnılar"
        results = await yt_search(query, limit=20)
        results = [r for r in results if r["id"] != video_id]
        return {"results": results}
    except Exception:
        return {"results": []}

# ---- Favorites ----
@api.get("/favorites")
async def list_favorites(session_id: str):
    items = await db.favorites.find({"session_id": session_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return {"favorites": items}

@api.post("/favorites")
async def add_favorite(body: FavoriteCreate):
    existing = await db.favorites.find_one({"session_id": body.session_id, "song_id": body.song.id})
    if existing:
        return {"ok": True, "message": "Already liked by this session"}
    doc = {"session_id": body.session_id, "song_id": body.song.id,
           "title": body.song.title, "artist": body.song.artist,
           "duration": body.song.duration, "thumbnail": body.song.thumbnail,
           "created_at": datetime.now(timezone.utc).isoformat()}
    await db.favorites.insert_one(doc)
    await db.like_counts.update_one(
        {"id": body.song.id},
        {"$inc": {"likes": 1},
         "$set": {"title": body.song.title, "artist": body.song.artist,
                  "thumbnail": body.song.thumbnail, "duration": body.song.duration}},
        upsert=True)
    return {"ok": True}

@api.delete("/favorites/{song_id}")
async def remove_favorite(song_id: str, session_id: str):
    res = await db.favorites.delete_one({"session_id": session_id, "song_id": song_id})
    if res.deleted_count:
        await db.like_counts.update_one(
            {"id": song_id, "likes": {"$gt": 0}}, {"$inc": {"likes": -1}})
    return {"ok": True, "removed": res.deleted_count}

# ---- Recently played ----
@api.post("/recently-played")
async def add_recent(body: RecentCreate):
    doc = {"session_id": body.session_id, "song_id": body.song.id,
           "title": body.song.title, "artist": body.song.artist,
           "duration": body.song.duration, "thumbnail": body.song.thumbnail,
           "played_at": datetime.now(timezone.utc).isoformat()}
    await db.recently_played.update_one(
        {"session_id": body.session_id, "song_id": body.song.id},
        {"$set": doc}, upsert=True)
    return {"ok": True}

@api.get("/recently-played")
async def list_recent(session_id: str, limit: int = 20):
    items = await db.recently_played.find({"session_id": session_id}, {"_id": 0}).sort("played_at", -1).to_list(limit)
    return {"recent": items}

# ---- Trending ----
@api.get("/trending")
async def trending(limit: int = 20):
    items = await db.like_counts.find({"likes": {"$gt": 0}}, {"_id": 0}).sort("likes", -1).to_list(limit)
    if not items:
        items = await db.play_counts.find({}, {"_id": 0}).sort("plays", -1).to_list(limit)
    return {"trending": items}

# ---- Featured ----
AZ_ARTIST_QUERIES = ["Miri Yusif", "Aygün Kazımova", "Çakal rap", "Alizade Azerbaijan", "Lvbel C5"]
AZ_TOP_QUERIES = ["azerbaijan top mahnilar 2025", "azeri top music 2025", "azerbaycan yeni mahnilar", "azeri hit mahnilar"]
FEATURED_QUERIES = AZ_TOP_QUERIES + AZ_ARTIST_QUERIES + ["azeri pop 2025", "azeri rap 2025", "azerbaycan rep", "Turkish Azeri hits"]

async def _warm_cache():
    for q in AZ_TOP_QUERIES[:2]:
        try:
            await yt_search(q, limit=15, ttl=_CACHE_TTL_FEATURED)
        except Exception:
            pass

@api.get("/featured")
async def featured(category: str = "azerbaijan top mahnilar 2025"):
    results = await yt_search(category, limit=15, ttl=_CACHE_TTL_FEATURED)
    return {"category": category, "results": results}

@api.get("/featured/categories")
async def featured_categories():
    return {"categories": FEATURED_QUERIES}

@api.get("/home-bootstrap")
async def home_bootstrap(session_id: Optional[str] = None):
    query_top = AZ_TOP_QUERIES[0]
    query_discovery = AZ_ARTIST_QUERIES[1]
    if session_id:
        recent = await db.recently_played.find({"session_id": session_id}).sort("played_at", -1).to_list(5)
        if len(recent) >= 3:
            fav_artist = recent[0]["artist"]
            query_discovery = f"{fav_artist} oxşar hitlər"
    top_task = asyncio.create_task(yt_search(query_top, limit=15, ttl=_CACHE_TTL_FEATURED))
    artists_task = asyncio.create_task(yt_search(AZ_ARTIST_QUERIES[0], limit=15, ttl=_CACHE_TTL_FEATURED))
    discovery_task = asyncio.create_task(yt_search(query_discovery, limit=15, ttl=_CACHE_TTL_FEATURED))
    top, artists, disc = await asyncio.gather(top_task, artists_task, discovery_task, return_exceptions=True)
    def _ok(x): return x if isinstance(x, list) else []
    return {"top": _ok(top), "artists": _ok(artists), "discovery": _ok(disc)}

app.include_router(api)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
async def _startup():
    asyncio.create_task(_warm_cache())

@app.on_event("shutdown")
async def _shutdown():
    client.close()
