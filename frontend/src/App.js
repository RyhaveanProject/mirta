import React, { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";
import axios from "axios";
import {
  Home as HomeIcon, Search as SearchIcon, Heart, Music2,
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  ChevronDown, Volume2, ListMusic, Plus, MoreHorizontal,
  Loader2, TrendingUp, Sparkles, Clock, X, Eye
} from "lucide-react";

// --- FIREBASE IMPORTLARI ---
import { ref, onValue, push, onDisconnect, set } from "firebase/database";
import { db } from "./firebase";

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

/* ---------- MediaSession (iOS lock-screen + background controls) ---------- */
const updateMediaSession = (song, player) => {
  if (!("mediaSession" in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: song.title || "",
      artist: song.artist || "",
      album: "Ryhavean Spotify",
      artwork: song.thumbnail ? [
        { src: song.thumbnail, sizes: "96x96",  type: "image/jpeg" },
        { src: song.thumbnail, sizes: "192x192", type: "image/jpeg" },
        { src: song.thumbnail, sizes: "512x512", type: "image/jpeg" },
      ] : [],
    });
    navigator.mediaSession.setActionHandler("play",         () => player.resume());
    navigator.mediaSession.setActionHandler("pause",        () => player.pause());
    navigator.mediaSession.setActionHandler("previoustrack",() => player.prev());
    navigator.mediaSession.setActionHandler("nexttrack",    () => player.next());
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (d.fastSeek && player.audio && "fastSeek" in player.audio) {
        try { player.audio.fastSeek(d.seekTime); return; } catch {}
      }
      if (player.audio && typeof d.seekTime === "number") {
        try { player.audio.currentTime = d.seekTime; } catch {}
      }
    });
  } catch {}
};

/* ---------- Player Hook (HTML5 <audio> – iOS PWA background-safe) ---------- */
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

  // Tək, qlobal HTML5 audio elementi – iOS PWA-da background-da işləyir.
  const audioRef = useRef(null);
  if (!audioRef.current && typeof window !== "undefined") {
    let a = document.getElementById("ryhavean-audio");
    if (!a) {
      a = document.createElement("audio");
      a.id = "ryhavean-audio";
      a.preload = "auto";
      a.setAttribute("playsinline", "");
      a.setAttribute("webkit-playsinline", "");
      a.setAttribute("x-webkit-airplay", "allow");
      // crossOrigin SİLİNDİ – CORS preflight audio stream-i bloklayırdı
      a.style.display = "none";
      document.body.appendChild(a);
    }
    audioRef.current = a;
  }
  const sessionId = getSessionId();
  const nextFnRef = useRef(null);
  const prevFnRef = useRef(null);
  const resumeFnRef = useRef(null);
  const pauseFnRef = useRef(null);
  const repeatRef = useRef(repeat);
  const currentIdRef = useRef(null);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);

  // Audio elementinə ümumi event-lər
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const onPlay     = () => { setPlaying(true);  setLoadingStream(false); };
    const onPause    = () => { setPlaying(false); };
    const onWaiting  = () => setLoadingStream(true);
    const onPlaying  = () => setLoadingStream(false);
    const onCanPlay  = () => setLoadingStream(false);
    const onLoaded   = () => {
      if (!isNaN(a.duration) && a.duration) setDuration(a.duration);
    };
    const onTime     = () => {
      if (!isNaN(a.currentTime)) setProgress(a.currentTime);
      if ("mediaSession" in navigator && navigator.mediaSession.setPositionState) {
        try {
          navigator.mediaSession.setPositionState({
            duration: isFinite(a.duration) ? a.duration : 0,
            playbackRate: a.playbackRate || 1,
            position: a.currentTime || 0,
          });
        } catch {}
      }
    };
    const onEnded = () => {
      if (repeatRef.current === "one") {
        try { a.currentTime = 0; a.play().catch(() => {}); } catch {}
      } else if (nextFnRef.current) {
        nextFnRef.current();
      }
    };
    const onError = () => {
      setLoadingStream(false);
      toast.show("Stream alınmadı, növbətiyə keçilir…");
      if (nextFnRef.current) nextFnRef.current();
    };

    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("waiting", onWaiting);
    a.addEventListener("playing", onPlaying);
    a.addEventListener("canplay", onCanPlay);
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("durationchange", onLoaded);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);

    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("waiting", onWaiting);
      a.removeEventListener("playing", onPlaying);
      a.removeEventListener("canplay", onCanPlay);
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("durationchange", onLoaded);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
    };
  }, [toast]);

  // Volume sync
  useEffect(() => {
    const a = audioRef.current;
    if (a) try { a.volume = Math.max(0, Math.min(1, volume)); } catch {}
  }, [volume]);

  const play = useCallback(async (song, opts = {}) => {
    if (!song || !song.id) return;
    const a = audioRef.current;
    if (!a) return;
    setLoadingStream(true);
    const prevSong = current;
    setCurrent(song);
    currentIdRef.current = song.id;
    setProgress(0);
    setDuration(song.duration || 0);

    const streamUrl = `${API}/audio/${encodeURIComponent(song.id)}`;
    try {
      a.src = streamUrl;
      a.load();
      // İlk play() istifadəçi jestindən gəlir – iOS bunu icazə verir.
      const p = a.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          setLoadingStream(false);
          toast.show("Oxutmaq alınmadı. Yenidən cəhd edin.");
        });
      }
    } catch {
      setLoadingStream(false);
      toast.show("Oxutmaq alınmadı.");
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
  }, [current, sessionId, toast]);

  const resume = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }, []);

  const pause = useCallback(() => {
    const a = audioRef.current;
    if (a) { try { a.pause(); } catch {} }
  }, []);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    if (a.paused) resume(); else pause();
  }, [current, resume, pause]);

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

  const prev = useCallback(() => {
    if (history.length) {
      const h = [...history];
      const p = h.shift();
      setHistory(h);
      if (p) play(p, { skipHistory: true });
    } else {
      const a = audioRef.current;
      try { if (a) a.currentTime = 0; } catch {}
    }
  }, [history, play]);

  useEffect(() => { nextFnRef.current = next; }, [next]);
  useEffect(() => { prevFnRef.current = prev; }, [prev]);
  useEffect(() => { resumeFnRef.current = resume; }, [resume]);
  useEffect(() => { pauseFnRef.current = pause; }, [pause]);

  // MediaSession – lock screen / control center / Bluetooth / AirPods
  useEffect(() => {
    if (!current) return;
    updateMediaSession(current, {
      audio: audioRef.current,
      resume: () => resumeFnRef.current && resumeFnRef.current(),
      pause:  () => pauseFnRef.current  && pauseFnRef.current(),
      next:   () => nextFnRef.current   && nextFnRef.current(),
      prev:   () => prevFnRef.current   && prevFnRef.current(),
    });
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch {}
    }
  }, [current, playing]);

  const seek = (ratio) => {
    const a = audioRef.current;
    if (!a) return;
    const dur = isFinite(a.duration) ? a.duration : duration;
    if (dur) {
      try { a.currentTime = Math.max(0, Math.min(dur, dur * ratio)); } catch {}
    }
  };

  const enqueue = (song) => {
    setQueue((q) => [...q, song]);
    toast.show(`Növbəyə əlavə olundu: ${song.title.slice(0, 30)}`);
  };

  return {
    current, queue, playing, progress, duration, volume, shuffle, repeat,
    fullOpen, loadingStream, sessionId,
    play, togglePlay, resume, pause, next, prev, seek, enqueue,
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

/* ---------- ACTIVE USER TRACKER (YENİ) ---------- */
const ActiveUserTracker = () => {
  const [count, setCount] = useState(1);

  useEffect(() => {
    const connectionsRef = ref(db, 'status/connections');
    const connectedRef = ref(db, '.info/connected');
    const userStatusRef = push(connectionsRef);

    onValue(connectedRef, (snap) => {
      if (snap.val() === true) {
        set(userStatusRef, true);
        onDisconnect(userStatusRef).remove();
      }
    });

    const unsub = onValue(connectionsRef, (snap) => {
      setCount(snap.size || 1);
    });

    return () => unsub();
  }, []);

  return <span className="active-num">{count}</span>;
};

/* ---------- Components ---------- */
const BrandHeader = () => {
  return (
    <header className="brand-header" data-testid="brand-header">
      <div>
        <div className="brand-title">
          <span className="dot" />
          Raven Spotify
        </div>
        <div className="brand-sub">Creator @Ryhavean &lt;/&gt;</div>
      </div>
      <div className="status-pill">
        <Eye size={14} color="var(--accent)" />
        <ActiveUserTracker />
      </div>
    </header>
  );
};

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

  const fetchTrending = useCallback(() => {
    axios.get(`${API}/trending?limit=10`)
      .then(r => setTrending(r.data.trending || []))
      .catch(() => {});
  }, []);

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
    
    fetchTrending();

    // Dinləyici əlavə edirik: bəyənmə dəyişəndə trendləri yenilə
    window.addEventListener("fav_updated", fetchTrending);

    return () => { 
      cancelled = true; 
      window.removeEventListener("fav_updated", fetchTrending);
    };
  }, [player.sessionId, fetchTrending]);

  return (
    <div className="page" data-testid="home-page">
     <h1 className="page-title vip-title"></h1>
      <div className="page-sub vip-subtitle">My Channel : @rveanx</div>

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head">
            <div className="section-title vip-section"><Clock size={16} style={{marginRight: 6, display:"inline"}} /> Son dinlənilənlər</div>
          </div>
          <div className="row-scroll">
  {recent.slice(0, 10).map((s) => (
    <SongCard key={s.id} song={s} onPlay={player.play}
              onLike={toggleFav} liked={isFav(s.id)} />
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
          {!activeCat && <div className="empty">Yuxarıdan janr seç və ya mahnı adını yazıb axtar</div>}
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
  
  const fetchTrending = useCallback(() => {
    axios.get(`${API}/trending?limit=10`)
      .then(r => setTrending(r.data.trending || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchTrending();
    window.addEventListener("fav_updated", fetchTrending);
    return () => window.removeEventListener("fav_updated", fetchTrending);
  }, [fetchTrending]);

  return (
    <div className="page" data-testid="favorites-page">
      <h1 className="page-title vip-title">My List</h1>
      <div className="page-sub vip-subtitle">{favs.length} bəyənilmiş mahnı</div>

      {favs.length === 0 ? (
        <div className="empty">Favorite Song</div>
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
          <div className="empty">Hələ bəyənilmiş mahnı yoxdur</div>
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
        <div className="label">Oxunur</div>
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
    { id: "home", label: "Home", Icon: HomeIcon },
    { id: "search", label: "Serach", Icon: SearchIcon },
    { id: "favs", label: "My List", Icon: Heart },
    { id: "nowp", label: "Player", Icon: Music2 },
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
        toast.show("❤️‍🔥");
      }
    } catch {
      toast.show("Əməliyyat alınmadı, yenidən cəhd edin");
      refreshFavs();
    } finally {
      setLikePending((p) => { const { [s.id]: _, ...rest } = p; return rest; });
      refreshFavs();
      // Trend siyahılarını yeniləmək üçün siqnal göndəririk
      window.dispatchEvent(new Event("fav_updated"));
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
