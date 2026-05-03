from fastapi import FastAPI, APIRouter, HTTPException, Query
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import re
import time
import logging
import asyncio
from pathlib import Path
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone
from collections import Counter
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

# ---------- yt-dlp config (cookies-free) ----------
YT_UA = os.environ.get(
    "YT_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)


def _base_ydl_opts(player_client: Optional[str] = None) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "http_headers": {"User-Agent": YT_UA},
    }
    if player_client:
        opts["extractor_args"] = {"youtube": {"player_client": [player_client]}}
    return opts


# Search is light-weight – web client works best
YDL_SEARCH_OPTS = {**_base_ydl_opts("web"), "extract_flat": True, "default_search": "ytsearch"}

# Cookies-free stream extraction: these clients historically expose audio
# formats on googlevideo CDN without requiring login. Order matters.
STREAM_CLIENTS = ["ios", "android_music", "android", "mweb", "tv_embedded", "web"]

# ---------- TTL cache ----------
_CACHE: dict = {}
_CACHE_TTL_FEATURED = 60 * 60 * 6   # 6h
_CACHE_TTL_SEARCH = 60 * 30         # 30 min
# Googlevideo direct URLs expire (usually ~6h), keep a little shorter to be safe
_CACHE_TTL_STREAM = 60 * 60 * 2     # 2h


def cache_get(key: str):
    v = _CACHE.get(key)
    if not v:
        return None
    exp, data = v
    if time.time() > exp:
        _CACHE.pop(key, None)
        return None
    return data


def cache_set(key: str, data, ttl: int):
    _CACHE[key] = (time.time() + ttl, data)


# ---------- helpers ----------
def _pick_thumb(thumbs: List[dict], vid: str) -> str:
    if thumbs:
        for t in reversed(thumbs):
            u = (t or {}).get("url") or ""
            if u and "vi_webp" not in u:
                return u
    return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"


def _search_sync(query: str, limit: int = 20):
    opts = dict(YDL_SEARCH_OPTS)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    entries = (info or {}).get("entries") or []
    results = []
    for e in entries:
        if not e:
            continue
        vid = e.get("id") or e.get("video_id")
        if not vid:
            continue
        results.append({
            "id": vid,
            "title": e.get("title") or "Unknown",
            "artist": e.get("uploader") or e.get("channel") or "Unknown artist",
            "duration": int(e.get("duration") or 0),
            "thumbnail": _pick_thumb(e.get("thumbnails") or [], vid),
            "url": f"https://www.youtube.com/watch?v={vid}",
        })
    return results


def _extract_googlevideo_url(info: dict) -> Optional[str]:
    """Pick the best audio-only format that is hosted on googlevideo CDN."""
    if not info:
        return None

    formats = info.get("formats") or []
    audio_only = []
    for f in formats:
        url = f.get("url") or ""
        if not url or "googlevideo" not in url:
            continue
        acodec = f.get("acodec")
        vcodec = f.get("vcodec")
        if acodec and acodec != "none" and (not vcodec or vcodec == "none"):
            audio_only.append(f)

    def _rank(f):
        ext = f.get("ext") or ""
        abr = f.get("abr") or f.get("tbr") or 0
        ext_score = 2 if ext == "m4a" else (1 if ext in ("mp4", "mp3") else 0)
        return (ext_score, abr)

    audio_only.sort(key=_rank, reverse=True)
    if audio_only:
        return audio_only[0].get("url")

    for f in formats:
        url = f.get("url") or ""
        if url and "googlevideo" in url and f.get("acodec") and f.get("acodec") != "none":
            return url

    top = info.get("url") or ""
    if "googlevideo" in top:
        return top
    return None


def _stream_sync(video_id: str) -> Optional[dict]:
    url = f"https://www.youtube.com/watch?v={video_id}"
    last_err = None
    for player_client in STREAM_CLIENTS:
        opts = {**_base_ydl_opts(player_client), "format": "bestaudio[ext=m4a]/bestaudio/best"}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if not info:
                continue
            audio_url = _extract_googlevideo_url(info)
            if not audio_url:
                continue
            return {
                "stream_url": audio_url,
                "client": player_client,
                "title": info.get("title"),
                "artist": info.get("uploader") or info.get("channel"),
                "duration": int(info.get("duration") or 0),
                "thumbnail": _pick_thumb(info.get("thumbnails") or [], info.get("id") or video_id),
            }
        except Exception as e:
            last_err = e
            continue
    if last_err:
        logger.warning("yt-dlp all clients failed for %s: %s", video_id, last_err)
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


async def yt_stream(video_id):
    key = f"stream::{video_id}"
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
        results = await yt_search(q, min(max(limit, 1), 30))
        return {"query": q, "count": len(results), "results": results}
    except Exception as e:
        logger.exception("search failed")
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")


async def _increment_play(video_id, data):
    await db.play_counts.update_one(
        {"id": video_id},
        {
            "$inc": {"plays": 1},
            "$set": {
                "title": data.get("title") or "",
                "artist": data.get("artist") or "",
                "thumbnail": data.get("thumbnail") or "",
                "duration": data.get("duration") or 0,
                "last_played": datetime.now(timezone.utc).isoformat(),
            },
        },
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
                data = {
                    "title": rs[0]["title"],
                    "artist": rs[0]["artist"],
                    "duration": rs[0]["duration"],
                    "thumbnail": rs[0]["thumbnail"],
                }
        except Exception:
            pass
    if not data:
        data = {
            "title": "Unknown",
            "artist": "Unknown",
            "duration": 0,
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        }
    await _increment_play(video_id, data)
    return {
        "video_id": video_id,
        "title": data.get("title"),
        "artist": data.get("artist"),
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
        "stream_url": f"/api/audio/{video_id}",
    }


def _redirect_headers(url: str) -> dict:
    return {
        "Location": url,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Location",
    }


@api.head("/audio/{video_id}")
async def audio_head(video_id: str):
    if not re.match(r"^[A-Za-z0-9_-]{5,15}$", video_id):
        raise HTTPException(status_code=400, detail="Invalid video id")
    data = await yt_stream(video_id)
    upstream = (data or {}).get("stream_url")
    if not upstream:
        return Response(status_code=503)
    return Response(status_code=302, headers=_redirect_headers(upstream))


@api.get("/audio/{video_id}")
async def audio_redirect(video_id: str):
    """Redirects the client straight to the googlevideo CDN URL.

    The browser's <audio> element follows 302 redirects transparently, so the
    actual byte stream (and all Range requests) flows directly between the
    user's browser and googlevideo – the backend never proxies audio bytes.
    """
    if not re.match(r"^[A-Za-z0-9_-]{5,15}$", video_id):
        raise HTTPException(status_code=400, detail="Invalid video id")

    data = await yt_stream(video_id)
    upstream = (data or {}).get("stream_url")
    if not upstream:
        _CACHE.pop(f"stream::{video_id}", None)
        data = await yt_stream(video_id)
        upstream = (data or {}).get("stream_url")

    if not upstream:
        raise HTTPException(status_code=503, detail="Stream unavailable")

    return Response(status_code=302, headers=_redirect_headers(upstream))


# ---------- Recommendation engine ----------
_STOPWORDS = {
    "official", "video", "audio", "music", "lyrics", "lyric", "mv", "hd",
    "hq", "4k", "remix", "ft", "feat", "featuring", "prod", "by", "the",
    "and", "ve", "ile", "from", "mahni", "mahnisi", "mahnilari", "mahnılar",
    "yeni", "new", "kliplər", "klip", "cover", "live", "version", "edit",
}


def _norm_artist(name: str) -> str:
    name = (name or "").strip().lower()
    name = re.sub(r"\s*-\s*topic$", "", name)
    name = re.sub(r"\s*\(.*?\)\s*", " ", name)
    return name.strip()


def _keywords_from(songs: List[dict]) -> List[str]:
    tokens = []
    for s in songs:
        for blob in (s.get("title") or "", s.get("artist") or ""):
            for w in re.findall(r"[A-Za-zƏəĞğİıÖöÜüÇçŞşА-Яа-я0-9]+", blob):
                w = w.lower()
                if len(w) >= 3 and w not in _STOPWORDS:
                    tokens.append(w)
    return [w for w, _ in Counter(tokens).most_common(5)]


async def _taste_queries(session_id: Optional[str], fallback_query: str) -> List[str]:
    queries: List[str] = []
    if session_id:
        recent = await db.recently_played.find(
            {"session_id": session_id}, {"_id": 0}
        ).sort("played_at", -1).to_list(15)
        if recent:
            artists = []
            for r in recent:
                a = _norm_artist(r.get("artist") or "")
                if a and a != "unknown artist" and a not in artists:
                    artists.append(a)
                if len(artists) >= 4:
                    break
            for a in artists[:3]:
                queries.append(f"{a} oxşar mahnılar")
            kws = _keywords_from(recent)
            if kws:
                queries.append(" ".join(kws[:3]))
    if not queries:
        queries.append(fallback_query)
    return queries


async def _recently_played_ids(session_id: Optional[str], limit: int = 60) -> set:
    if not session_id:
        return set()
    rows = await db.recently_played.find(
        {"session_id": session_id}, {"_id": 0, "song_id": 1}
    ).sort("played_at", -1).to_list(limit)
    return {r["song_id"] for r in rows if r.get("song_id")}


@api.get("/recommendations/{video_id}")
async def recommendations(video_id: str, session_id: Optional[str] = None, limit: int = 20):
    try:
        played = await _recently_played_ids(session_id, 40)
        played.add(video_id)

        seed = await yt_stream(video_id)
        seed_query: Optional[str] = None
        if seed:
            artist = _norm_artist(seed.get("artist") or "")
            if artist and artist != "unknown artist":
                seed_query = f"{artist} oxşar mahnılar"

        queries = []
        if seed_query:
            queries.append(seed_query)
        queries += await _taste_queries(session_id, "azerbaijan top mahnilar 2025")

        seen_q = set()
        queries = [q for q in queries if not (q in seen_q or seen_q.add(q))]

        results: List[dict] = []
        seen_ids: set = set(played)

        for q in queries[:4]:
            try:
                rs = await yt_search(q, limit=15)
                for r in rs:
                    if r["id"] in seen_ids:
                        continue
                    seen_ids.add(r["id"])
                    results.append(r)
                    if len(results) >= limit:
                        break
                if len(results) >= limit:
                    break
            except Exception:
                continue

        return {"results": results[:limit]}
    except Exception:
        logger.exception("recommendations failed")
        return {"results": []}


@api.get("/favorites")
async def list_favorites(session_id: str):
    items = await db.favorites.find(
        {"session_id": session_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(500)
    return {"favorites": items}


@api.post("/favorites")
async def add_favorite(body: FavoriteCreate):
    existing = await db.favorites.find_one({"session_id": body.session_id, "song_id": body.song.id})
    if existing:
        return {"ok": True, "message": "Already liked by this session"}

    doc = {
        "session_id": body.session_id,
        "song_id": body.song.id,
        "title": body.song.title,
        "artist": body.song.artist,
        "duration": body.song.duration,
        "thumbnail": body.song.thumbnail,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.favorites.insert_one(doc)

    await db.like_counts.update_one(
        {"id": body.song.id},
        {
            "$inc": {"likes": 1},
            "$set": {
                "title": body.song.title,
                "artist": body.song.artist,
                "thumbnail": body.song.thumbnail,
                "duration": body.song.duration,
            },
        },
        upsert=True,
    )
    return {"ok": True}


@api.delete("/favorites/{song_id}")
async def remove_favorite(song_id: str, session_id: str):
    res = await db.favorites.delete_one({"session_id": session_id, "song_id": song_id})
    if res.deleted_count:
        await db.like_counts.update_one(
            {"id": song_id, "likes": {"$gt": 0}}, {"$inc": {"likes": -1}}
        )
    return {"ok": True, "removed": res.deleted_count}


@api.post("/recently-played")
async def add_recent(body: RecentCreate):
    doc = {
        "session_id": body.session_id,
        "song_id": body.song.id,
        "title": body.song.title,
        "artist": body.song.artist,
        "duration": body.song.duration,
        "thumbnail": body.song.thumbnail,
        "played_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.recently_played.update_one(
        {"session_id": body.session_id, "song_id": body.song.id},
        {"$set": doc},
        upsert=True,
    )
    return {"ok": True}


@api.get("/recently-played")
async def list_recent(session_id: str, limit: int = 20):
    items = await db.recently_played.find(
        {"session_id": session_id}, {"_id": 0}
    ).sort("played_at", -1).to_list(limit)
    return {"recent": items}


@api.get("/trending")
async def trending(limit: int = 20):
    items = await db.like_counts.find(
        {"likes": {"$gt": 0}}, {"_id": 0}
    ).sort("likes", -1).to_list(limit)

    if not items:
        items = await db.play_counts.find(
            {}, {"_id": 0}
        ).sort("plays", -1).to_list(limit)

    return {"trending": items}


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
    played = await _recently_played_ids(session_id, 80)
    queries = await _taste_queries(session_id, AZ_ARTIST_QUERIES[1])

    top_task = asyncio.create_task(yt_search(AZ_TOP_QUERIES[0], limit=15, ttl=_CACHE_TTL_FEATURED))
    artists_task = asyncio.create_task(yt_search(AZ_ARTIST_QUERIES[0], limit=15, ttl=_CACHE_TTL_FEATURED))

    async def _discovery():
        out: List[dict] = []
        seen = set(played)
        for q in queries[:4]:
            try:
                rs = await yt_search(q, limit=15)
                for r in rs:
                    if r["id"] in seen:
                        continue
                    seen.add(r["id"])
                    out.append(r)
                    if len(out) >= 15:
                        break
                if len(out) >= 15:
                    break
            except Exception:
                continue
        return out

    discovery_task = asyncio.create_task(_discovery())

    top, artists, disc = await asyncio.gather(
        top_task, artists_task, discovery_task, return_exceptions=True
    )

    def _ok(x):
        return x if isinstance(x, list) else []

    return {
        "top": _ok(top),
        "artists": _ok(artists),
        "discovery": _ok(disc),
    }


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length", "Location"],
)


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_warm_cache())


@app.on_event("shutdown")
async def _shutdown():
    client.close()
