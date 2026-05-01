"""
Ryhavean Spotify - FastAPI backend
Full music streaming via yt-dlp + MongoDB favorites (anonymous session_id).
"""
from fastapi import FastAPI, APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, StreamingResponse
import httpx
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import asyncio
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, timezone
from functools import lru_cache
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


def _search_sync(query: str, limit: int = 20):
    opts = dict(YDL_SEARCH_OPTS)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    entries = info.get("entries", []) if info else []
    results = []
    for e in entries:
        if not e:
            continue
        vid = e.get("id") or e.get("video_id")
        if not vid:
            continue
        thumbs = e.get("thumbnails") or []
        thumb = None
        for t in reversed(thumbs):
            u = t.get("url") or ""
            if u and "vi_webp" not in u:
                thumb = u
                break
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
    opts = dict(YDL_STREAM_OPTS)
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        return None
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
            thumb = u
            break
    if not thumb:
        thumb = f"https://i.ytimg.com/vi/{info.get('id') or ''}/hqdefault.jpg"
    return {
        "stream_url": audio_url,
        "title": info.get("title"),
        "artist": info.get("uploader") or info.get("channel"),
        "duration": int(info.get("duration") or 0),
        "thumbnail": thumb,
    }


async def yt_search(query, limit=20):
    return await asyncio.to_thread(_search_sync, query, limit)


async def yt_stream(video_id):
    return await asyncio.to_thread(_stream_sync, video_id)


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
         "$set": {"title": data.get("title") or "",
                  "artist": data.get("artist") or "",
                  "thumbnail": data.get("thumbnail") or "",
                  "duration": data.get("duration") or 0,
                  "last_played": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )


@api.get("/stream-info/{video_id}")
async def stream_info(video_id: str):
    data = None
    try:
        data = await yt_stream(video_id)
    except Exception:
        logger.exception("yt-dlp extract failed; fallback")
    if not data:
        try:
            rs = await yt_search(video_id, limit=1)
            if rs:
                data = {"title": rs[0]["title"], "artist": rs[0]["artist"],
                        "duration": rs[0]["duration"], "thumbnail": rs[0]["thumbnail"]}
        except Exception:
            pass
    if not data:
        data = {"title": "Unknown", "artist": "Unknown", "duration": 0,
                "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"}
    await _increment_play(video_id, data)
    return {"video_id": video_id, "title": data.get("title"),
            "artist": data.get("artist"), "duration": data.get("duration"),
            "thumbnail": data.get("thumbnail")}


@api.get("/recommendations/{video_id}")
async def recommendations(video_id: str):
    try:
        meta = None
        try:
            rs = await yt_search(video_id, limit=1)
            if rs:
                meta = rs[0]
        except Exception:
            pass
        query = (meta.get("artist") if meta else None) or (meta.get("title") if meta else None) or "top music hits"
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
    doc = {"session_id": body.session_id, "song_id": body.song.id,
           "title": body.song.title, "artist": body.song.artist,
           "duration": body.song.duration, "thumbnail": body.song.thumbnail,
           "created_at": datetime.now(timezone.utc).isoformat()}
    await db.favorites.update_one(
        {"session_id": body.session_id, "song_id": body.song.id},
        {"$set": doc}, upsert=True)
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
FEATURED_QUERIES = [
    "top hits 2025", "chill lofi beats", "pop hits", "hip hop 2025",
    "indie rock", "bollywood hits", "kpop 2025", "edm party",
    "acoustic covers", "jazz classics",
]


@api.get("/featured")
async def featured(category: str = "top hits 2025"):
    if category not in FEATURED_QUERIES:
        category = "top hits 2025"
    results = await yt_search(category, limit=15)
    return {"category": category, "results": results}


@api.get("/featured/categories")
async def featured_categories():
    return {"categories": FEATURED_QUERIES}


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"], allow_headers=["*"],
)


@app.on_event("shutdown")
async def _shutdown():
    client.close()
