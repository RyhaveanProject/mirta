"# Ryhavean Spotify — PRD

## Original Problem
User has a Spotify-style website (GitHub: RyhaveanProject/mirta, deployed on
Render + Vercel). Requested fixes:
1. Songs load slowly on home page → must load fast.
2. English songs showing → must show Azerbaijani Top (Miri Yusif, Aygün
   Kazımova, Çakal, Alizade, Lvbel C5).
3. Need an X (clear) button next to search input.
4. Background playback stops when tab is hidden → must keep playing.
5. Like / favorite not working → must work.
6. Deliver complete final source files (no edit diffs).

## Architecture
- Backend: FastAPI + Motor (MongoDB) + yt-dlp, deployed on Render.
- Frontend: React + axios + lucide-react + YouTube IFrame API, deployed on Vercel.

## Implemented (2026-02)
- **Backend**
  - In-memory TTL cache for all yt-dlp searches (featured = 6h, generic = 30m).
  - Startup cache-warming of 9 Azerbaijani queries → home renders instantly.
  - New `/api/home-bootstrap` that returns three AZ sections in one call.
  - New `/api/az-top` merged AZ chart.
  - FEATURED_QUERIES replaced with AZ queries (Miri Yusif, Aygün Kazımova,
    Çakal rap, Alizade, Lvbel C5, + AZ-top chart queries).
  - Favorites POST now checks `existing` before incrementing like_counts
    (fixes inflation on repeated taps).
- **Frontend**
  - Home page calls `/api/home-bootstrap` first for instant first paint;
    recently-played and trending load lazily.
  - UI strings translated to Azerbaijani.
  - Search input has an X clear button that wipes text and refocuses.
  - Background playback:
    - MediaSession API metadata + play/pause/next/prev handlers for OS-level
      lock-screen/notification controls.
    - `visibilitychange` listener + 1.5 s keep-alive interval that force-
      resumes playback if the browser throttled/paused the iframe while hidden.
    - Wake Lock API (where supported) to reduce throttling.
    - YT player host kept at `opacity:0.01` (never `display:none`, which
      breaks playback).
  - Like / favorite:
    - Optimistic UI update (instant heart toggle).
    - Rollback by refetch on server error.
    - Heart button added to SongCard (hover), SongRow, and MiniPlayer — not
      only on the FullPlayer — so users can like without opening full player.
    - Concurrency guard (`likePending`) prevents double-clicks double-posting.

## Deliverables for user
Final source files written at `/tmp/final_repo/`:
- `backend/server.py`
- `backend/requirements.txt`
- `frontend/src/App.js`
- `frontend/src/App.css`
- `frontend/src/index.css`
- `frontend/src/index.js`
- `frontend/public/index.html`
- `frontend/package.json`
User pushes them to GitHub → Render + Vercel auto-deploy.

## Backlog / Next
- P2: Add playlist / collections feature.
- P2: Add OG / social meta tags so shared links show cover art.
- P2: Service-worker for true offline mini-cache of recently-played covers.
