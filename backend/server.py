from fastapi import FastAPI, APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, Response, RedirectResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import time
import logging
import asyncio
import httpx
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

# ---------- User-Agents ----------
_UA_CHROME       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
_UA_SAFARI       = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
_UA_IPHONE       = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
_UA_ANDROID_M    = "com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip"
_UA_TV           = "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15"

# Player-client fallback chain. Order matters: try the most-likely-to-work first.
_STREAM_CLIENTS = [
    (["tv_simply"],     _UA_TV),
    (["tv_embedded"],   _UA_TV),
    (["web_safari"],    _UA_SAFARI),
    (["mweb"],          _UA_IPHONE),
    (["android_music"], _UA_ANDROID_M),
    (["web_creator"],   _UA_CHROME),
    (["web"],           _UA_CHROME),
]

YDL_SEARCH_OPTS = {
    "quiet": True, "no_warnings": True, "skip_download": True,
    "extract_flat": True, "default_search": "ytsearch",
    "noplaylist": True, "socket_timeout": 15,
}

# ---------- TTL cache ----------
_CACHE: dict = {}
_CACHE_TTL_FEATURED = 60 * 60 * 6
_CACHE_TTL_SEARCH   = 60 * 30
_CACHE_TTL_STREAM   = 60 * 60 * 2

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


def _pick_audio_url(info):
    audio_url = info.get("url")
    if audio_url:
        return audio_url
    formats = info.get("formats") or []
    audios = [f for f in formats if f.get("url") and f.get("acodec") and f.get("acodec") != "none"]
    if not audios:
        audios = [f for f in formats if f.get("url")]
    if not audios:
        return None
    audios.sort(key=lambda f: (
        0 if (f.get("vcodec") in (None, "none") and f.get("ext") == "m4a") else
        1 if (f.get("vcodec") in (None, "none")) else 2,
        -(f.get("abr") or 0),
    ))
    return audios[0].get("url")


def _stream_sync(video_id: str):
    """Try each player_client until we get a usable audio URL."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    last_err = None
    for clients, ua in _STREAM_CLIENTS:
        try:
            opts = {
                "quiet": True, "no_warnings": True, "skip_download": True,
                "format": "bestaudio/best",
                "noplaylist": True, "socket_timeout": 15,
                "extractor_args": {"youtube": {"player_client": clients}},
                "http_headers": {"User-Agent": ua},
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            audio_url = _pick_audio_url(info or {})
            if not audio_url:
                continue
            client_ua = (info.get("http_headers") or {}).get("User-Agent") or ua
            thumbs = info.get("thumbnails") or []
            thumb = None
            for t in reversed(thumbs):
                u = t.get("url") or ""
                if u and "vi_webp" not in u:
                    thumb = u; break
            if not thumb:
                thumb = f"https://i.ytimg.com/vi/{info.get('id') or video_id}/hqdefault.jpg"
            return {
                "stream_url": audio_url,
                "client_ua": client_ua,
                "title": info.get("title"),
                "artist": info.get("uploader") or info.get("channel"),
                "duration": int(info.get("duration") or 0),
                "thumbnail": thumb,
            }
        except Exception as e:
            last_err = e
            continue
    if last_err:
        logger.warning("yt-dlp all clients failed for %s: %s", video_id, str(last_err)[:200])
    return None


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


async def yt_stream(video_id, use_cache=True):
    key = f"stream::{video_id}"
    if use_cache:
        hit = cache_get(key)
        if hit is not None:
            return hit
    data = await asyncio.to_thread(_stream_sync, video_id)
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
    song: Song
    session_id: Optional[str] = None  # ignored — backwards compat

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
         "$set": {"title": data.get("title") or "", "artist": data.get("artist") or "",
                  "thumbnail": data.get("thumbnail") or "", "duration": data.get("duration") or 0,
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
            rs = await yt_search(video_id, limit=1, cache=False)
            if rs:
                data = {"title": rs[0]["title"], "artist": rs[0]["artist"],
                        "duration": rs[0]["duration"], "thumbnail": rs[0]["thumbnail"]}
        except Exception: pass
    if not data:
        data = {"title": "Unknown", "artist": "Unknown", "duration": 0,
                "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"}
    await _increment_play(video_id, data)
    return {"video_id": video_id, "title": data.get("title"), "artist": data.get("artist"),
            "duration": data.get("duration"), "thumbnail": data.get("thumbnail"),
            "stream_url": data.get("stream_url")}


# ---------- Audio proxy ----------
@api.get("/audio-proxy/{video_id}")
@api.head("/audio-proxy/{video_id}")
async def audio_proxy(video_id: str, request: Request):
    data = None
    for attempt in range(2):
        try:
            data = await yt_stream(video_id, use_cache=(attempt == 0))
            if data and data.get("stream_url"):
                break
        except Exception:
            logger.exception("yt_stream failed")
    if not data or not data.get("stream_url"):
        raise HTTPException(status_code=502, detail="Could not resolve audio stream")

    upstream_url = data["stream_url"]

    # Mode selection (default: stream / proxy through server).
    if os.environ.get("AUDIO_PROXY_MODE", "stream").lower() == "redirect":
        headers = {
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        }
        return RedirectResponse(url=upstream_url, status_code=302, headers=headers)

    # ---- Streaming-proxy mode (default) ----
    client_ua = data.get("client_ua") or _UA_CHROME
    range_hdr = request.headers.get("range") or request.headers.get("Range")
    fwd_headers = {
        "User-Agent": client_ua,
        "Accept": "*/*",
        "Accept-Encoding": "identity;q=1, *;q=0",
        "Connection": "keep-alive",
    }
    if range_hdr:
        fwd_headers["Range"] = range_hdr

    client_http = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None), follow_redirects=True)

    async def _retry_resolve():
        nonlocal upstream_url, client_ua, fwd_headers
        fresh = await yt_stream(video_id, use_cache=False)
        if fresh and fresh.get("stream_url"):
            upstream_url = fresh["stream_url"]
            client_ua = fresh.get("client_ua") or _UA_CHROME
            fwd_headers["User-Agent"] = client_ua
            return True
        return False

    try:
        req = client_http.build_request("GET", upstream_url, headers=fwd_headers)
        resp = await client_http.send(req, stream=True)

        if resp.status_code in (403, 410):
            try: await resp.aclose()
            except Exception: pass
            if await _retry_resolve():
                req = client_http.build_request("GET", upstream_url, headers=fwd_headers)
                resp = await client_http.send(req, stream=True)

        if resp.status_code >= 400:
            try: await resp.aclose()
            except Exception: pass
            await client_http.aclose()
            raise HTTPException(status_code=502, detail=f"Upstream error {resp.status_code}")

        passthru = {}
        for h in ("content-type", "content-length", "content-range", "accept-ranges",
                  "last-modified", "etag", "cache-control"):
            v = resp.headers.get(h)
            if v:
                passthru[h] = v
        passthru.setdefault("Accept-Ranges", "bytes")
        passthru.setdefault("Content-Type", "audio/mp4")
        passthru["Cache-Control"] = "public, max-age=3600"
        passthru["Access-Control-Allow-Origin"] = "*"
        passthru["Access-Control-Allow-Headers"] = "Range"
        passthru["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"

        if request.method == "HEAD":
            status = resp.status_code
            try: await resp.aclose()
            except Exception: pass
            await client_http.aclose()
            return Response(status_code=status, headers=passthru)

        async def _body():
            try:
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    yield chunk
            except Exception:
                pass
            finally:
                try: await resp.aclose()
                except Exception: pass
                try: await client_http.aclose()
                except Exception: pass

        return StreamingResponse(_body(), status_code=resp.status_code, headers=passthru)
    except HTTPException:
        raise
    except Exception as e:
        try: await client_http.aclose()
        except Exception: pass
        logger.exception("audio proxy failed")
        raise HTTPException(status_code=502, detail=f"Proxy error: {e}")


@api.get("/recommendations/{video_id}")
async def recommendations(video_id: str):
    try:
        meta = None
        try:
            rs = await yt_search(video_id, limit=1, cache=False)
            if rs: meta = rs[0]
        except Exception: pass
        query = (meta.get("artist") if meta else None) or (meta.get("title") if meta else None) or "azerbaijan top mahnilar"
        results = await yt_search(query, limit=20)
        results = [r for r in results if r["id"] != video_id]
        return {"results": results}
    except Exception:
        return {"results": []}


# ---- Favorites (GLOBAL — everyone sees same likes) ----
@api.get("/favorites")
async def list_favorites(session_id: Optional[str] = None):
    items = await db.global_favorites.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return {"favorites": items}


@api.post("/favorites")
async def add_favorite(body: FavoriteCreate):
    song = body.song
    existing = await db.global_favorites.find_one({"song_id": song.id})
    doc = {
        "song_id": song.id,
        "title": song.title,
        "artist": song.artist,
        "duration": song.duration,
        "thumbnail": song.thumbnail,
        "created_at": existing["created_at"] if existing and existing.get("created_at") else datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.global_favorites.update_one(
        {"song_id": song.id},
        {"$set": doc},
        upsert=True,
    )
    if not existing:
        await db.like_counts.update_one(
            {"id": song.id},
            {"$inc": {"likes": 1},
             "$set": {"title": song.title, "artist": song.artist,
                      "thumbnail": song.thumbnail, "duration": song.duration}},
            upsert=True,
        )
    return {"ok": True, "favorited": True}


@api.delete("/favorites/{song_id}")
async def remove_favorite(song_id: str, session_id: Optional[str] = None):
    res = await db.global_favorites.delete_one({"song_id": song_id})
    if res.deleted_count:
        await db.like_counts.update_one(
            {"id": song_id, "likes": {"$gt": 0}}, {"$inc": {"likes": -1}}
        )
    return {"ok": True, "removed": res.deleted_count}


# ---- Recently played (per-session) ----
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
AZ_ARTIST_QUERIES = [
    "Miri Yusif",
    "Aygün Kazımova",
    "Çakal rap",
    "Alizade Azerbaijan",
    "Lvbel C5",
]
AZ_TOP_QUERIES = [
    "azerbaijan top mahnilar 2025",
    "azeri top music 2025",
    "azerbaycan yeni mahnilar",
    "azeri hit mahnilar",
]
FEATURED_QUERIES = AZ_TOP_QUERIES + AZ_ARTIST_QUERIES + [
    "azeri pop 2025",
    "azeri rap 2025",
    "azerbaycan rep",
    "Turkish Azeri hits",
]


async def _warm_cache():
    to_warm = AZ_TOP_QUERIES + AZ_ARTIST_QUERIES
    logger.info("Warming featured cache for %d queries...", len(to_warm))
    for q in to_warm:
        try:
            await yt_search(q, limit=15, ttl=_CACHE_TTL_FEATURED)
        except Exception:
            logger.warning("warm failed for %s", q)
    logger.info("Featured cache warmed.")


@api.get("/featured")
async def featured(category: str = "azerbaijan top mahnilar 2025"):
    results = await yt_search(category, limit=15, ttl=_CACHE_TTL_FEATURED)
    return {"category": category, "results": results}


@api.get("/featured/categories")
async def featured_categories():
    return {"categories": FEATURED_QUERIES}


@api.get("/az-top")
async def az_top(limit: int = 20):
    merged: list = []
    seen = set()
    for q in AZ_TOP_QUERIES + AZ_ARTIST_QUERIES:
        try:
            rs = await yt_search(q, limit=10, ttl=_CACHE_TTL_FEATURED)
        except Exception:
            rs = []
        for s in rs:
            if s["id"] in seen: continue
            seen.add(s["id"])
            merged.append(s)
            if len(merged) >= limit * 2: break
        if len(merged) >= limit * 2: break
    return {"results": merged[:limit]}


@api.get("/home-bootstrap")
async def home_bootstrap():
    top_task = asyncio.create_task(yt_search(AZ_TOP_QUERIES[0], limit=15, ttl=_CACHE_TTL_FEATURED))
    artists_task = asyncio.create_task(yt_search(AZ_ARTIST_QUERIES[0], limit=15, ttl=_CACHE_TTL_FEATURED))
    chill_task = asyncio.create_task(yt_search(AZ_ARTIST_QUERIES[1], limit=15, ttl=_CACHE_TTL_FEATURED))
    top, artists, chill = await asyncio.gather(top_task, artists_task, chill_task, return_exceptions=True)
    def _ok(x): return x if isinstance(x, list) else []
    return {
        "top": _ok(top),
        "artists": _ok(artists),
        "discovery": _ok(chill),
    }


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_warm_cache())


@app.on_event("shutdown")
async def _shutdown():
    client.close()
