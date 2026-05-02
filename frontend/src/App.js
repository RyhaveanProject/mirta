import React, { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";
import axios from "axios";
import {
  Home as HomeIcon, Search as SearchIcon, Heart, Music2,
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  ChevronDown, Volume2, ListMusic, Plus, MoreHorizontal,
  Loader2, TrendingUp, Sparkles, Clock, X
} from "lucide-react";

const BACKEND_URL = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
const API = `${BACKEND_URL}/api`;

/* ---------- helpers ---------- */
const fmtTime = (s) => {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
};

const getSessionId = () => {
  let id = localStorage.getItem("ryhavean_session");
  if (!id) {
    id = "sess_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("ryhavean_session", id);
  }
  return id;
};

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* Extract dominant color from image for dynamic background */
const sampleImageColor = (imgUrl) =>
  new Promise((resolve) => {
    if (!imgUrl) return resolve(null);
    const url = imgUrl.replace("/vi_webp/", "/vi/").replace(".webp", ".jpg");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 20; canvas.height = 20;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 20, 20);
        const data = ctx.getImageData(0, 0, 20, 20).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        resolve([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });

/* ---------- tiny toast ---------- */
const useToast = () => {
  const [msg, setMsg] = useState(null);
  const show = (m) => { setMsg(m); setTimeout(() => setMsg(null), 2400); };
  const node = msg ? <div className="toast" data-testid="toast">{msg}</div> : null;
  return { show, node };
};

/* ---------- YouTube IFrame Player loader ---------- */
let ytApiPromise = null;
const loadYTApi = () => {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(s);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
  });
  return ytApiPromise;
};

/* ---------- MediaSession + background keep-alive ---------- */
const updateMediaSession = (song, player) => {
  if (!("mediaSession" in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: song.title || "",
      artist: song.artist || "",
      album: "Ryhavean Spotify",
      artwork: song.thumbnail ? [
        { src: song.thumbnail, sizes: "96x96", type: "image/jpeg" },
        { src: song.thumbnail, sizes: "192x192", type: "image/jpeg" },
        { src: song.thumbnail, sizes: "512x512", type: "image/jpeg" },
      ] : [],
    });
    navigator.mediaSession.setActionHandler("play", () => player.togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => player.togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
  } catch {}
};

/* ---------- Player Hook ---------- */
const usePlayer = (toast) => {
  const [current, setCurrent] = useState(null);
  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState("off");
  const [fullOpen, setFullOpen] = useState(false);
  const [loadingStream, setLoadingStream] = useState(false);
  const ytPlayerRef = useRef(null);
  const ytReadyRef = useRef(false);
  const ytDivId = "yt-player-host";
  const progressTimerRef = useRef(null);
  const sessionId = getSessionId();
  const nextFnRef = useRef(null);
  const togglePlayRef = useRef(null);
  const prevFnRef = useRef(null);
  const playingRef = useRef(false);
  const wasPlayingBeforeHiddenRef = useRef(false);
  const repeatRef = useRef(repeat);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  useEffect(() => {
    let cancelled = false;
    let host = document.getElementById(ytDivId);
    if (!host) {
      host = document.createElement("div");
      host.id = ytDivId;
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:fixed;bottom:0;right:0;width:200px;height:200px;opacity:0.01;pointer-events:none;z-index:-1;";
      document.body.appendChild(host);
    }
    loadYTApi().then((YT) => {
      if (cancelled) return;
      ytPlayerRef.current = new YT.Player(ytDivId, {
        height: "200", width: "200",
        playerVars: {
          autoplay: 1, controls: 0, playsinline: 1,
          modestbranding: 1, rel: 0, origin: window.location.origin,
          enablejsapi: 1, widget_referrer: window.location.origin
        },
        events: {
          onReady: () => {
            ytReadyRef.current = true;
            try {
              ytPlayerRef.current.setVolume(90);
              ytPlayerRef.current.mute();
            } catch {}
          },
          onStateChange: (e) => {
            if (e.data === 1) { setPlaying(true); setLoadingStream(false); }
            else if (e.data === 2) {
              setPlaying(false);
            }
            else if (e.data === 3) { setLoadingStream(true); }
            else if (e.data === 0) {
              if (repeatRef.current === "one") {
                try { ytPlayerRef.current.seekTo(0, true); ytPlayerRef.current.playVideo(); } catch {}
              } else if (nextFnRef.current) {
                nextFnRef.current();
              }
            }
          },
          onError: () => {
            toast.show("Video unavailable. Trying another…");
            setLoadingStream(false);
            if (nextFnRef.current) nextFnRef.current();
          },
        },
      });
    });
    return () => { cancelled = true; };
  }, []);

  /* ---------- IOS BACKGROUND SILENCE LOOP ---------- */
  useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (!isIOS) return;

    const silentAudio = new Audio("https://raw.githubusercontent.com/anars/blank-audio/master/250-milliseconds-of-silence.mp3");
    silentAudio.loop = true;

    if (playing) {
      silentAudio.play().catch(() => {});
    } else {
      silentAudio.pause();
    }
    return () => silentAudio.pause();
  }, [playing]);

  /* ---------- BACKGROUND PLAYBACK KEEP-ALIVE ---------- */
  useEffect(() => {
    let wakeLock = null;

    const requestWakeLock = async () => {
      try {
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch {}
    };

    const releaseWakeLock = async () => {
      try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch {}
    };

    const onVisibilityChange = () => {
      const p = ytPlayerRef.current;
      if (!p || !ytReadyRef.current) return;
    };

    const keepAliveInterval = setInterval(() => {
      const p = ytPlayerRef.current;
      if (!p || !ytReadyRef.current) return;
      try {
        const state = p.getPlayerState ? p.getPlayerState() : -1;
        if (playingRef.current && state === 2) {
          p.playVideo();
        }
      } catch {}
    }, 1500);

    document.addEventListener("visibilitychange", onVisibilityChange);
    requestWakeLock();

    const onVisRelease = () => {
      if (document.visibilityState === "visible") requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisRelease);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("visibilitychange", onVisRelease);
      clearInterval(keepAliveInterval);
      releaseWakeLock();
    };
  }, []);

  useEffect(() => {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const p = ytPlayerRef.current;
      if (!p || !ytReadyRef.current) return;
      try {
        const cur = p.getCurrentTime ? p.getCurrentTime() : 0;
        const dur = p.getDuration ? p.getDuration() : 0;
        if (!isNaN(cur)) setProgress(cur);
        if (!isNaN(dur) && dur) setDuration(dur);
      } catch {}
    }, 500);
    return () => clearInterval(progressTimerRef.current);
  }, []);

  useEffect(() => {
    const p = ytPlayerRef.current;
    if (p && ytReadyRef.current) {
      try { p.setVolume(Math.round(volume * 100)); } catch {}
    }
  }, [volume]);

  const play = useCallback(async (song, opts = {}) => {
    if (!song || !song.id) return;
    setLoadingStream(true);
    const prevSong = current;
    setCurrent(song);
    setPlaying(true);
    setProgress(0);
    setDuration(song.duration || 0);

    for (let i = 0; i < 20 && !ytReadyRef.current; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      const p = ytPlayerRef.current;
      p.loadVideoById({ videoId: song.id, startSeconds: 0, suggestedQuality: "small" });
      setTimeout(() => {
        try {
          p.playVideo();
          setTimeout(() => { try { p.unMute(); p.setVolume(Math.round(volume * 100)); } catch {} }, 600);
        } catch {}
      }, 300);
    } catch {
      toast.show("Couldn't start playback.");
      setLoadingStream(false);
    }

    axios.get(`${API}/stream-info/${song.id}`).then(({ data }) => {
      if (data) setCurrent((c) => (c && c.id === song.id ? { ...c, ...data, id: song.id } : c));
    }).catch(() => {});

    axios.post(`${API}/recently-played`, {
      session_id: sessionId,
      song: {
        id: song.id, title: song.title, artist: song.artist,
        duration: song.duration || 0, thumbnail: song.thumbnail || "",
      },
    }).catch(() => {});

    if (!opts.skipHistory && prevSong) {
      setHistory((h) => [prevSong, ...h].slice(0, 50));
    }
  }, [current, sessionId, toast, volume]);

  const togglePlay = useCallback(() => {
    const p = ytPlayerRef.current;
    if (!p || !current) return;
    try {
      const state = p.getPlayerState ? p.getPlayerState() : -1;
      if (state === 1) { p.pauseVideo(); setPlaying(false); wasPlayingBeforeHiddenRef.current = false; }
      else { p.playVideo(); setPlaying(true); wasPlayingBeforeHiddenRef.current = true; }
    } catch {}
  }, [current]);

  const next = useCallback(async () => {
    let nextSong = null;
    if (queue.length) {
      const q = [...queue];
      if (shuffle) {
        const idx = Math.floor(Math.random() * q.length);
        nextSong = q.splice(idx, 1)[0];
      } else {
        nextSong = q.shift();
      }
      setQueue(q);
    } else if (current) {
      try {
        const { data } = await axios.get(`${API}/recommendations/${current.id}`);
        const recs = (data.results || []).filter((r) => r.id !== current.id);
        if (recs.length) {
          nextSong = recs[0];
          setQueue(recs.slice(1, 15));
        }
      } catch {}
    }
    if (nextSong) play(nextSong);
  }, [queue, shuffle, current, play]);

  useEffect(() => { nextFnRef.current = next; }, [next]);
  useEffect(() => { togglePlayRef.current = togglePlay; }, [togglePlay]);

  const prev = useCallback(() => {
    if (history.length) {
      const h = [...history];
      const p = h.shift();
      setHistory(h);
      if (p) play(p, { skipHistory: true });
    } else {
      const pl = ytPlayerRef.current;
      try { if (pl) pl.seekTo(0, true); } catch {}
    }
  }, [history, play]);

  useEffect(() => { prevFnRef.current = prev; }, [prev]);

  useEffect(() => {
    if (!current) return;
    updateMediaSession(current, {
      togglePlay: () => togglePlayRef.current && togglePlayRef.current(),
      next: () => nextFnRef.current && nextFnRef.current(),
      prev: () => prevFnRef.current && prevFnRef.current(),
    });
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch {}
    }
  }, [current, playing]);

  const seek = (ratio) => {
    const p = ytPlayerRef.current;
    try {
      const dur = p.getDuration ? p.getDuration() : duration;
      if (p && dur) p.seekTo(dur * ratio, true);
    } catch {}
  };

  const enqueue = (song) => {
    setQueue((q) => [...q, song]);
    toast.show(`Added to queue: ${song.title.slice(0, 30)}`);
  };

  return {
    current, queue, playing, progress, duration, volume, shuffle, repeat,
    fullOpen, loadingStream, sessionId, ytDivId,
    play, togglePlay, next, prev, seek, enqueue,
    setShuffle, setRepeat, setVolume, setFullOpen, setQueue,
  };
};

/* ---------- Dynamic background ---------- */
const useDynamicBg = (song) => {
  useEffect(() => {
    if (!song?.thumbnail) return;
    sampleImageColor(song.thumbnail).then((rgb) => {
      if (!rgb) return;
      const [r, g, b] = rgb;
      const grad = `radial-gradient(at top, rgba(${r},${g},${b},0.9), #0a0a0b 70%)`;
      document.documentElement.style.setProperty("--dyn-grad", grad);
    });
  }, [song?.thumbnail]);
};

/* ---------- Components ---------- */
const BrandHeader = () => (
  <header className="brand-header" data-testid="brand-header">
    <div>
      <div className="brand-title"><span className="dot" />Raven Spotify</div>
      <div className="brand-sub">Creator @Ryhavean &lt;/&gt;</div>
    </div>
  </header>
);

const SongCard = ({ song, onPlay, onLike, liked }) => (
  <div className="song-card" data-testid={`song-card-${song.id}`} onClick={() => onPlay(song)}>
    <img className="cover" src={song.thumbnail} alt={song.title} loading="lazy"
         onError={(e) => { e.target.src = `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`; }} />
    <div className="title">{song.title}</div>
    <div className="artist">{song.artist}</div>
    <div className="play-pill"><Play size={18} fill="#000" /></div>
    {onLike && (
      <button
        className={`card-like-btn ${liked ? "liked" : ""}`}
        onClick={(e) => { e.stopPropagation(); onLike(song); }}
        data-testid={`card-like-${song.id}`}
        aria-label={liked ? "Unlike" : "Like"}
      >
        <Heart size={16} fill={liked ? "currentColor" : "none"} />
      </button>
    )}
  </div>
);

const SongRow = ({ song, onPlay, rank, onLike, liked }) => (
  <div className={rank ? "row-ranked" : "song-row"} onClick={() => onPlay(song)} data-testid={`song-row-${song.id}`}>
    {rank && <div className="rank-num">{rank}</div>}
    <img className="cover" src={song.thumbnail} alt={song.title} loading="lazy"
         onError={(e) => { e.target.src = `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`; }} />
    <div className="meta">
      <div className="title">{song.title}</div>
      <div className="artist">{song.artist}</div>
    </div>
    {onLike && (
      <button
        className={`row-like-btn ${liked ? "liked" : ""}`}
        onClick={(e) => { e.stopPropagation(); onLike(song); }}
        data-testid={`row-like-${song.id}`}
        aria-label={liked ? "Unlike" : "Like"}
      >
        <Heart size={16} fill={liked ? "currentColor" : "none"} />
      </button>
    )}
    <div className="duration">{fmtTime(song.duration)}</div>
  </div>
);

const Skeleton = ({ w = "100%", h = 120 }) => (
  <div className="skeleton" style={{ width: w, height: h, flex: `0 0 ${w}` }} />
);

/* ---------- Pages ---------- */
const HomePage = ({ player, toggleFav, isFav }) => {
  const [recent, setRecent] = useState([]);
  const [trending, setTrending] = useState([]);
  const [topAz, setTopAz] = useState([]);
  const [artists, setArtists] = useState([]);
  const [discovery, setDiscovery] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const sid = player.sessionId;

    axios.get(`${API}/home-bootstrap`).then(({ data }) => {
      if (cancelled) return;
      setTopAz(data.top || []);
      setArtists(data.artists || []);
      setDiscovery(data.discovery || []);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });

    axios.get(`${API}/recently-played?session_id=${sid}&limit=12`)
      .then(r => !cancelled && setRecent((r.data.recent || []).map(x => ({...x, id: x.song_id}))))
      .catch(() => {});
    axios.get(`${API}/trending?limit=10`)
      .then(r => !cancelled && setTrending(r.data.trending || []))
      .catch(() => {});

    return () => { cancelled = true; };
  }, [player.sessionId]);

  return (
    <div className="page" data-testid="home-page">
     <h1 className="page-title vip-title"></h1>
      <div className="page-sub vip-subtitle">My Channel : @rveanx</div>

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head">
            <div className="section-title vip-section"><Clock size={16} style={{marginRight: 6, display:"inline"}} /> Son dinlənilənlər</div>
          </div>
          <div className="grid-2">
            {recent.slice(0, 6).map((s) => (
              <div key={s.id} className="grid-card" onClick={() => player.play(s)} data-testid={`recent-${s.id}`}>
                <img className="cover" src={s.thumbnail} alt="" loading="lazy" />
                <div className="title">{s.title}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <div className="section-title vip-section"><Sparkles size={16} style={{marginRight: 6, display:"inline"}} /> Azerbayjan Top Music 🇦🇿</div>
        </div>
        {loading ? (
          <div className="row-scroll">{[...Array(5)].map((_, i) => <Skeleton key={i} w="150px" h="190px" />)}</div>
        ) : (
          <div className="row-scroll">
            {topAz.map((s) => (
              <SongCard key={s.id} song={s} onPlay={player.play}
                        onLike={toggleFav} liked={isFav(s.id)} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title vip-section">Miri Yusif & daha çox</div>
        </div>
        {loading ? (
          <div className="row-scroll">{[...Array(5)].map((_, i) => <Skeleton key={i} w="150px" h="190px" />)}</div>
        ) : (
          <div className="row-scroll">
            {artists.map((s) => (
              <SongCard key={s.id} song={s} onPlay={player.play}
                        onLike={toggleFav} liked={isFav(s.id)} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title vip-section">Aygün Kazımova kolleksiyası</div>
        </div>
        {loading ? (
          <div className="row-scroll">{[...Array(5)].map((_, i) => <Skeleton key={i} w="150px" h="190px" />)}</div>
        ) : (
          <div className="row-scroll">
            {discovery.map((s) => (
              <SongCard key={s.id} song={s} onPlay={player.play}
                        onLike={toggleFav} liked={isFav(s.id)} />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title vip-section"><TrendingUp size={16} style={{marginRight: 6, display:"inline"}} /> Ən çox bəyənilənlər</div>
        </div>
        {trending.length ? (
          <div className="row-scroll">
            {trending.map((s) => (
              <SongCard key={s.id} song={s} onPlay={player.play}
                        onLike={toggleFav} liked={isFav(s.id)} />
            ))}
          </div>
        ) : (
          <div className="empty">Pop Trend Music Playlist</div>
        )}
      </section>
    </div>
  );
};

const SearchPage = ({ player, toggleFav, isFav }) => {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [cats, setCats] = useState([]);
  const [activeCat, setActiveCat] = useState(null);
  const [catResults, setCatResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    axios.get(`${API}/featured/categories`).then(r => setCats(r.data.categories || []));
  }, []);

  const doSearch = useCallback(debounce(async (query) => {
    if (!query.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/search?q=${encodeURIComponent(query)}&limit=20`);
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, 350), []);

  useEffect(() => { doSearch(q); }, [q, doSearch]);

  const clearQuery = () => {
    setQ("");
    setResults([]);
    if (inputRef.current) inputRef.current.focus();
  };

  const pickCategory = async (c) => {
    setActiveCat(c);
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/featured?category=${encodeURIComponent(c)}`);
      setCatResults(data.results || []);
    } finally { setLoading(false); }
  };

  return (
    <div className="page" data-testid="search-page">
      <h1 className="page-title vip-title">Axtarış</h1>
      <div className="search-wrap">
        <SearchIcon className="search-icon" size={18} />
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Mahnı, ifaçı, əhval…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="search-input"
          autoFocus
        />
        {q && (
          <button
            type="button"
            className="search-clear-btn"
            onClick={clearQuery}
            data-testid="search-clear-btn"
            aria-label="Axtarışı təmizlə"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {q.trim() === "" && (
        <>
          <div className="chip-row" data-testid="category-chips">
            {cats.map((c) => (
              <div key={c} className={`chip ${activeCat === c ? "active" : ""}`}
                   onClick={() => pickCategory(c)}
                   data-testid={`chip-${c.replace(/\s+/g, '-')}`}>{c}</div>
            ))}
          </div>
          {activeCat && (
            <div className="section search-results">
              <div className="section-title vip-section" style={{marginBottom: 12, textTransform: "capitalize"}}>{activeCat}</div>
              <div className="song-list">
                {catResults.map((s) => (
                  <SongRow key={s.id} song={s} onPlay={player.play}
                           onLike={toggleFav} liked={isFav(s.id)} />
                ))}
              </div>
            </div>
          )}
          {!activeCat && <div className="empty">Yuxarıdan janr seç və ya yazıb axtar</div>}
        </>
      )}

      {q.trim() !== "" && (
        <div className="search-results">
          {loading ? (
            <div className="song-list">{[...Array(6)].map((_, i) => <Skeleton key={i} h="58px" />)}</div>
          ) : results.length === 0 ? (
            <div className="empty">"{q}" üçün nəticə tapılmadı</div>
          ) : (
            <div className="song-list">
              {results.map((s) => (
                <SongRow key={s.id} song={s} onPlay={player.play}
                         onLike={toggleFav} liked={isFav(s.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const FavoritesPage = ({ player, favs, toggleFav, isFav }) => {
  const [trending, setTrending] = useState([]);
  useEffect(() => {
    axios.get(`${API}/trending?limit=10`).then(r => setTrending(r.data.trending || [])).catch(() => {});
  }, []);

  return (
    <div className="page" data-testid="favorites-page">
      <h1 className="page-title vip-title">Sevimlilərin</h1>
      <div className="page-sub vip-subtitle">{favs.length} bəyənilmiş mahnı</div>

      {favs.length === 0 ? (
        <div className="empty">İstənilən mahnının ürəyinə tıkla və burada saxlansın</div>
      ) : (
        <div className="song-list" data-testid="favorites-list">
          {favs.map((s) => {
            const song = { id: s.song_id, title: s.title, artist: s.artist, duration: s.duration, thumbnail: s.thumbnail };
            return <SongRow key={s.song_id} song={song} onPlay={player.play}
                            onLike={toggleFav} liked={isFav(song.id)} />;
          })}
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <div className="section-title vip-section"><TrendingUp size={16} style={{marginRight:6, display:"inline"}} /> Ən çox bəyənilənlər</div>
        </div>
        {trending.length === 0 ? (
          <div className="empty">Hələ bəyəni yoxdur. İlk sən ol!</div>
        ) : (
          <div className="song-list">
            {trending.map((s, i) => (
              <SongRow key={s.id} song={s} onPlay={player.play} rank={i + 1}
                       onLike={toggleFav} liked={isFav(s.id)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

/* ---------- Full Player ---------- */
const FullPlayer = ({ player, toggleFav, isFav }) => {
  if (!player.current) return null;
  const s = player.current;
  const pct = player.duration ? player.progress / player.duration : 0;
  const liked = isFav(s.id);

  return (
    <div className="full-player" data-testid="full-player">
      <div className="full-top">
        <button className="ctrl" onClick={() => player.setFullOpen(false)} data-testid="full-close">
          <ChevronDown size={22} />
        </button>
        <div className="label">İndi Oynayır</div>
        <button className="ctrl"><MoreHorizontal size={20} /></button>
      </div>

      <div className="full-body">
        <div className="art-wrap">
          <div className={`art-inner ${player.playing ? "playing" : ""}`}
               style={{ backgroundImage: `url(${s.thumbnail})` }} />
        </div>

        <div className="track-info">
          <div className="t">{s.title}</div>
          <div className="a">{s.artist}</div>
          {player.playing && (
            <div className="visualizer" style={{justifyContent:"center", marginTop:12}}>
              <span /><span /><span /><span />
            </div>
          )}
        </div>

        <div className="progress-wrap">
          <div className="progress-bar" data-testid="progress-bar"
               onClick={(e) => {
                 const r = e.currentTarget.getBoundingClientRect();
                 player.seek((e.clientX - r.left) / r.width);
               }}>
            <div className="fill" style={{ width: `${pct * 100}%` }} />
            <div className="knob" style={{ left: `${pct * 100}%` }} />
          </div>
          <div className="time-row">
            <span>{fmtTime(player.progress)}</span>
            <span>{fmtTime(player.duration || s.duration)}</span>
          </div>
        </div>

        <div className="controls-row">
          <button className={`ctrl ${player.shuffle ? "active" : ""}`}
                  onClick={() => player.setShuffle(!player.shuffle)}
                  data-testid="shuffle-btn"><Shuffle size={18} /></button>
          <button className="ctrl" onClick={player.prev} data-testid="prev-btn"><SkipBack size={22} fill="currentColor" /></button>
          <button className="ctrl play" onClick={player.togglePlay} data-testid="play-pause-btn">
            {player.loadingStream ? <Loader2 size={24} className="animate-spin" /> :
              player.playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </button>
          <button className="ctrl" onClick={player.next} data-testid="next-btn"><SkipForward size={22} fill="currentColor" /></button>
          <button className={`ctrl ${player.repeat !== "off" ? "active" : ""}`}
                  onClick={() => {
                    const order = ["off", "all", "one"];
                    player.setRepeat(order[(order.indexOf(player.repeat) + 1) % 3]);
                  }}
                  data-testid="repeat-btn">
            {player.repeat === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
          </button>
        </div>

        <div className="extra-row">
          <button className={`ctrl like-btn ${liked ? "liked heart-burst" : ""}`}
                  onClick={() => toggleFav(s)} data-testid="fav-btn">
            <Heart size={20} fill={liked ? "currentColor" : "none"} />
          </button>
          <button className="ctrl" onClick={() => player.enqueue(s)} data-testid="queue-btn"><Plus size={20} /></button>
          <button className="ctrl"><ListMusic size={20} /></button>
        </div>

        <div className="vol-wrap">
          <Volume2 size={16} style={{ color: "var(--text-dim)" }} />
          <div className="vol-bar"
               onClick={(e) => {
                 const r = e.currentTarget.getBoundingClientRect();
                 player.setVolume(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
               }}>
            <div className="fill" style={{ width: `${player.volume * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
};

const MiniPlayer = ({ player, toggleFav, isFav }) => {
  if (!player.current) return null;
  const pct = player.duration ? player.progress / player.duration : 0;
  const liked = isFav(player.current.id);
  return (
    <div className="mini-player" onClick={() => player.setFullOpen(true)} data-testid="mini-player">
      <img className="cover" src={player.current.thumbnail} alt="" />
      <div className="info">
        <div className="title">{player.current.title}</div>
        <div className="artist">{player.current.artist}</div>
      </div>
      <div className="controls" onClick={(e) => e.stopPropagation()}>
        <button className={`ctrl-btn ${liked ? "liked" : ""}`}
                onClick={() => toggleFav(player.current)}
                data-testid="mini-like-btn"
                aria-label={liked ? "Unlike" : "Like"}>
          <Heart size={18} fill={liked ? "currentColor" : "none"} />
        </button>
        <button className="ctrl-btn" onClick={player.togglePlay} data-testid="mini-play-pause">
          {player.loadingStream ? <Loader2 size={18} className="animate-spin" /> :
            player.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button className="ctrl-btn" onClick={player.next} data-testid="mini-next">
          <SkipForward size={18} fill="currentColor" />
        </button>
      </div>
      <div className="progress-line" style={{ width: `${pct * 100}%` }} />
    </div>
  );
};

const BottomNav = ({ tab, setTab }) => {
  const items = [
    { id: "home", label: "Ana", Icon: HomeIcon },
    { id: "search", label: "Axtar", Icon: SearchIcon },
    { id: "favs", label: "Sevimlilər", Icon: Heart },
    { id: "nowp", label: "Oynayır", Icon: Music2 },
  ];
  return (
    <nav className="bottom-nav" data-testid="bottom-nav">
      {items.map(({ id, label, Icon }) => (
        <button key={id} className={`nav-btn ${tab === id ? "active" : ""}`}
                onClick={() => setTab(id)} data-testid={`nav-${id}`}>
          <Icon size={22} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
};

function App() {
  const toast = useToast();
  const player = usePlayer(toast);
  const [tab, setTab] = useState("home");
  const [favs, setFavs] = useState([]);
  const [likePending, setLikePending] = useState({});
  useDynamicBg(player.current);

  const refreshFavs = useCallback(() => {
    axios.get(`${API}/favorites?session_id=${player.sessionId}`)
      .then(r => setFavs(r.data.favorites || []))
      .catch(() => {});
  }, [player.sessionId]);

  useEffect(() => { refreshFavs(); }, [refreshFavs]);

  const isFav = useCallback((id) => favs.some(f => f.song_id === id), [favs]);

  const toggleFav = useCallback(async (s) => {
    if (!s || !s.id) return;
    if (likePending[s.id]) return;
    setLikePending((p) => ({ ...p, [s.id]: true }));

    const currentlyFav = favs.some(f => f.song_id === s.id);

    if (currentlyFav) {
      setFavs((prev) => prev.filter(f => f.song_id !== s.id));
    } else {
      setFavs((prev) => [{
        song_id: s.id, title: s.title, artist: s.artist,
        duration: s.duration || 0, thumbnail: s.thumbnail || "",
        created_at: new Date().toISOString(),
      }, ...prev]);
    }

    try {
      if (currentlyFav) {
        await axios.delete(`${API}/favorites/${s.id}?session_id=${player.sessionId}`);
        toast.show("Sevimlilərdən silindi");
      } else {
        await axios.post(`${API}/favorites`, {
          session_id: player.sessionId,
          song: { id: s.id, title: s.title || "", artist: s.artist || "",
                  duration: s.duration || 0, thumbnail: s.thumbnail || "" },
        });
        toast.show("Sevimlilərə əlavə edildi ♥");
      }
    } catch {
      toast.show("Əməliyyat alınmadı, yenidən cəhd edin");
      refreshFavs();
    } finally {
      setLikePending((p) => { const { [s.id]: _, ...rest } = p; return rest; });
      refreshFavs(); // Xətanın düzəldildiyi əsas hissə: Məlumatları bazadan təkrar çəkir
    }
  }, [favs, likePending, player.sessionId, refreshFavs, toast]);

  useEffect(() => {
    if (tab === "nowp") {
      if (player.current) player.setFullOpen(true);
      else toast.show("Əvvəlcə bir mahnı seç");
      setTab((t) => (t === "nowp" ? "home" : t));
    }
  }, [tab, player.current]);

  let pageEl;
  if (tab === "home") pageEl = <HomePage player={player} toggleFav={toggleFav} isFav={isFav} />;
  else if (tab === "search") pageEl = <SearchPage player={player} toggleFav={toggleFav} isFav={isFav} />;
  else if (tab === "favs") pageEl = <FavoritesPage player={player} favs={favs} toggleFav={toggleFav} isFav={isFav} />;
  else pageEl = <HomePage player={player} toggleFav={toggleFav} isFav={isFav} />;

  return (
    <div className="app-shell">
      <div className="dynamic-bg" />
      <BrandHeader />
      {pageEl}
      <MiniPlayer player={player} toggleFav={toggleFav} isFav={isFav} />
      <BottomNav tab={tab} setTab={setTab} />
      {player.fullOpen && <FullPlayer player={player} toggleFav={toggleFav} isFav={isFav} />}
      {toast.node}
    </div>
  );
}

export default App;
