from fastapi import FastAPI, APIRouter, HTTPException, Query, BackgroundTasks, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
import os
import time
import logging
import asyncio
import random
from pathlib import Path
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone
import yt_dlp
import httpx

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
# IMPORTANT: We rotate User-Agents and use mobile clients to reduce
# YouTube bot detection on the small number of resolves we still do.
_USER_AGENTS = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
]

def _make_search_opts():
    return {
        "quiet": True, "no_warnings": True, "skip_download": True,
        "extract_flat": True, "default_search": "ytsearch",
        "noplaylist": True, "socket_timeout": 15,
        "user_agent": random.choice(_USER_AGENTS),
        "extractor_args": {"youtube": {"player_client": ["ios", "web"]}},
    }

def _make_stream_opts():
    return {
        "quiet": True, "no_warnings": True, "skip_download": True,
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "noplaylist": True, "socket_timeout": 15,
        "user_agent": random.choice(_USER_AGENTS),
        # iOS client first → returns most-compatible URLs that the device
        # itself can fetch directly (so each user uses their own IP).
        "extractor_args": {"youtube": {"player_client": ["ios", "android", "web"]}},
    }

# ---------- TTL cache ----------
_CACHE: dict = {}
_CACHE_TTL_FEATURED = 60 * 60 * 6   # 6 hours
_CACHE_TTL_SEARCH   = 60 * 30       # 30 min
_CACHE_TTL_STREAM   = 60 * 60 * 4   # 4 hours (googlevideo URL TTL ~6h)

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
    opts = _make_search_opts()
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    entries = info.get("entries", []) if info else []
    results = []
    for e in entries:
        if not e: continue
        vid = e.get("id") or e.get("video_id")
        if not vid: continue
        thumbs = e.get("thumbnails") or []
        thumb = None
        for t in reversed(thumbs):
            u = t.get("url") or ""
            if u and "vi_webp" not in u:
                thumb = u; break
        if not thumb:
            thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        results.append({
            "id": vid,
            "title": e.get("title") or "Unknown",
            "artist": e.get("uploader") or e.get("channel") or "Unknown artist",
            "duration": int(e.get("duration") or 0),
            "thumbnail": thumb,
            "url": f"https://www.youtube.com/watch?v={vid}",
        })
    return results

def _stream_sync(video_id: str):
    opts = _make_stream_opts()
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info: return None
    audio_url = info.get("url")
    if not audio_url:
        formats = info.get("formats") or []
        af = [f for f in formats if f.get("acodec") and f.get("acodec") != "none"]
        if af:
            af.sort(key=lambda f: f.get("abr") or 0, reverse=True)
            audio_url = af[0].get("url")
    thumbs = info.get("thumbnails") or []
    thumb = None
    for t in reversed(thumbs):
        u = t.get("url") or ""
        if u and "vi_webp" not in u:
            thumb = u; break
    if not thumb:
        thumb = f"https://i.ytimg.com/vi/{info.get('id') or ''}/hqdefault.jpg"
    return {
        "stream_url": audio_url,
        "title": info.get("title"),
        "artist": info.get("uploader") or info.get("channel"),
        "duration": int(info.get("duration") or 0),
        "thumbnail": thumb,
    }

async def yt_search(query, limit=20, cache=True, ttl=_CACHE_TTL_SEARCH):
    key = f"search::{query}::{limit}"
    if cache:
        hit = cache_get(key)
        if hit is not None:
            return hit
    data = await asyncio.to_thread(_search_sync, query, limit)
    if cache and data:
        cache_set(key, data, ttl)
    return data

async def yt_stream(video_id):
    return await asyncio.to_thread(_stream_sync, video_id)


# ---------- Stream resolver with TTL cache ----------
_STREAM_LOCKS: dict = {}

def _get_stream_lock(video_id: str) -> asyncio.Lock:
    lock = _STREAM_LOCKS.get(video_id)
    if lock is None:
        lock = asyncio.Lock()
        _STREAM_LOCKS[video_id] = lock
    return lock

async def _resolve_stream(video_id: str, force: bool = False):
    key = f"streamdata::{video_id}"
    if not force:
        hit = cache_get(key)
        if hit is not None:
            return hit
    lock = _get_stream_lock(video_id)
    async with lock:
        if not force:
            hit = cache_get(key)
            if hit is not None:
                return hit
        try:
            data = await yt_stream(video_id)
        except Exception:
            logger.exception("yt-dlp resolve failed for %s", video_id)
            data = None
        if data and data.get("stream_url"):
            cache_set(key, data, _CACHE_TTL_STREAM)
        return data


# ---------- Models ----------
class Song(BaseModel):
    id: str
    title: str
    artist: str
    duration: int = 0
    thumbnail: str = ""

class FavoriteCreate(BaseModel):
    session_id: str
    song: Song

class RecentCreate(BaseModel):
    session_id: str
    song: Song


# ---------- Routes ----------
@api.get("/")
async def root():
    return {"app": "Ryhavean Spotify", "status": "ok"}


@api.get("/version")
async def version():
    """Used by IPA to detect when a new build is available (auto-update hook)."""
    return {
        "version": os.environ.get("APP_VERSION", "1.0.1"),
        "min_supported": "1.0.0",
        "build": int(time.time()),
    }


@api.get("/search")
async def search(q: str = Query(..., min_length=1), limit: int = 20):
    try:
        results = await yt_search(q, limit=min(max(limit, 1), 30))
        return {"query": q, "count": len(results), "results": results}
    except Exception as e:
        logger.exception("search failed")
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")


async def _increment_play(video_id, data):
    await db.play_counts.update_one(
        {"id": video_id},
        {"$inc": {"plays": 1},
         "$set": {"title": data.get("title") or "", "artist": data.get("artist") or "",
                  "thumbnail": data.get("thumbnail") or "", "duration": data.get("duration") or 0,
                  "last_played": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )


# ---------- /stream/{id} ----------
# CRITICAL CHANGE: Returns DIRECT googlevideo URL by default.
# Each user device fetches the audio bytes directly from googlevideo
# using their OWN IP — Vercel/Render is NOT used as a proxy for audio
# bytes anymore. This:
#   1. Eliminates server bandwidth load on Vercel/Render
#   2. Avoids YouTube blocking the shared server IP for bot abuse
#   3. Lets each device benefit from Google's CDN nearest to it
# Use ?proxy=1 query to fall back to the proxy mode (for older clients
# or when CDN refuses the device IP).
@api.get("/stream/{video_id}")
async def stream_meta(video_id: str, request: Request, proxy: int = 0):
    data = await _resolve_stream(video_id)
    if not data:
        try:
            rs = await yt_search(video_id, limit=1, cache=False)
            if rs:
                data = {
                    "title": rs[0]["title"], "artist": rs[0]["artist"],
                    "duration": rs[0]["duration"], "thumbnail": rs[0]["thumbnail"],
                    "stream_url": None,
                }
        except Exception:
            pass

    if not data:
        raise HTTPException(status_code=404, detail="Stream not found")

    # Choose stream URL strategy:
    #   - default: direct googlevideo URL (device's own IP)
    #   - proxy=1: route through our /api/audio proxy (server IP)
    if proxy and data.get("stream_url"):
        base = str(request.base_url).rstrip("/")
        out_url = f"{base}/api/audio/{video_id}"
    else:
        out_url = data.get("stream_url")  # direct googlevideo URL

    try:
        await _increment_play(video_id, data)
    except Exception:
        pass

    return {
        "video_id": video_id,
        "title": data.get("title"),
        "artist": data.get("artist"),
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
        "stream_url": out_url,
        "direct": not bool(proxy),
    }


@api.get("/stream-info/{video_id}")
async def stream_info(video_id: str, request: Request, proxy: int = 0):
    return await stream_meta(video_id, request, proxy)


# ---------- /audio/{id} - audio proxy stream (fallback only) ----------
_AUDIO_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=15.0)
_PROXY_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
)

async def _open_upstream(url: str, range_header: Optional[str]):
    headers = {"User-Agent": _PROXY_UA, "Accept": "*/*"}
    if range_header:
        headers["Range"] = range_header
    upstream_client = httpx.AsyncClient(timeout=_AUDIO_HTTP_TIMEOUT, follow_redirects=True)
    req = upstream_client.build_request("GET", url, headers=headers)
    try:
        resp = await upstream_client.send(req, stream=True)
    except Exception:
        await upstream_client.aclose()
        raise
    return upstream_client, resp


@api.get("/audio/{video_id}")
async def audio_proxy(video_id: str, request: Request):
    range_header = request.headers.get("range")
    data = await _resolve_stream(video_id)
    if not data or not data.get("stream_url"):
        raise HTTPException(status_code=404, detail="Audio not available")

    upstream_url = data["stream_url"]
    upstream_client = None
    resp = None
    try:
        upstream_client, resp = await _open_upstream(upstream_url, range_header)
        if resp.status_code in (403, 404, 410):
            try: await resp.aclose()
            except Exception: pass
            try: await upstream_client.aclose()
            except Exception: pass
            data = await _resolve_stream(video_id, force=True)
            if not data or not data.get("stream_url"):
                raise HTTPException(status_code=404, detail="Audio re-fetch failed")
            upstream_client, resp = await _open_upstream(data["stream_url"], range_header)
    except HTTPException:
        raise
    except Exception:
        if upstream_client:
            try: await upstream_client.aclose()
            except Exception: pass
        logger.exception("audio_proxy upstream error for %s", video_id)
        raise HTTPException(status_code=502, detail="Upstream error")

    async def _body():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        except Exception:
            pass
        finally:
            try: await resp.aclose()
            except Exception: pass
            try: await upstream_client.aclose()
            except Exception: pass

    pass_headers = {}
    for h in ("content-type", "content-length", "content-range",
              "accept-ranges", "etag", "last-modified"):
        v = resp.headers.get(h)
        if v:
            pass_headers[h.title()] = v
    pass_headers.setdefault("Accept-Ranges", "bytes")
    pass_headers.setdefault("Cache-Control", "no-store")
    pass_headers.setdefault("Content-Type", "audio/mp4")

    return StreamingResponse(
        _body(),
        status_code=resp.status_code,
        headers=pass_headers,
        media_type=pass_headers.get("Content-Type"),
    )


@api.get("/recommendations/{video_id}")
async def recommendations(video_id: str, session_id: Optional[str] = None):
    try:
        query = "azerbaijan top mahnilar 2025"
        if session_id:
            recent = await db.recently_played.find({"session_id": session_id}).sort("played_at", -1).to_list(3)
            if recent:
                artists = [r["artist"] for r in recent if r["artist"] != "Unknown artist"]
                if artists:
                    query = f"{artists[0]} oxsar mahnilar"

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


# ---- Featured (Azerbaijani TOP) ----
AZ_ARTIST_QUERIES = ["Miri Yusif", "Aygun Kazimova", "Cakal rap", "Alizade Azerbaijan", "Lvbel C5"]
AZ_TOP_QUERIES = ["azerbaijan top mahnilar 2025", "azeri top music 2025", "azerbaycan yeni mahnilar", "azeri hit mahnilar"]
FEATURED_QUERIES = AZ_TOP_QUERIES + AZ_ARTIST_QUERIES + ["azeri pop 2025", "azeri rap 2025", "azerbaycan rep", "Turkish Azeri hits"]


async def _warm_cache():
    for q in AZ_TOP_QUERIES[:2]:
        try: await yt_search(q, limit=15, ttl=_CACHE_TTL_FEATURED)
        except Exception: pass


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
            query_discovery = f"{fav_artist} oxsar hitler"

    top_task = asyncio.create_task(yt_search(query_top, limit=15, ttl=_CACHE_TTL_FEATURED))
    artists_task = asyncio.create_task(yt_search(AZ_ARTIST_QUERIES[0], limit=15, ttl=_CACHE_TTL_FEATURED))
    discovery_task = asyncio.create_task(yt_search(query_discovery, limit=15, ttl=_CACHE_TTL_FEATURED))

    top, artists, disc = await asyncio.gather(top_task, artists_task, discovery_task, return_exceptions=True)
    def _ok(x): return x if isinstance(x, list) else []

    return {
        "top": _ok(top),
        "artists": _ok(artists),
        "discovery": _ok(disc),
    }


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
async def _startup():
    asyncio.create_task(_warm_cache())

@app.on_event("shutdown")
async def _shutdown():
    client.close()
