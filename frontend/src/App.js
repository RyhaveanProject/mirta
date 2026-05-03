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

/* ---------- MediaSession Helper ---------- */
const updateMediaSession = (song, handlers) => {
  if (!("mediaSession" in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: song.title || "",
      artist: song.artist || "",
      album: "Ryhavean",
      artwork: song.thumbnail ? [
        { src: song.thumbnail, sizes: "512x512", type: "image/jpeg" },
      ] : [],
    });
    navigator.mediaSession.setActionHandler("play", handlers.togglePlay);
    navigator.mediaSession.setActionHandler("pause", handlers.togglePlay);
    navigator.mediaSession.setActionHandler("previoustrack", handlers.prev);
    navigator.mediaSession.setActionHandler("nexttrack", handlers.next);
  } catch (e) {}
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
  
  const audioRef = useRef(null);
  const progressTimerRef = useRef(null);
  const sessionId = getSessionId();
  const currentRef = useRef(null);
  const volumeRef = useRef(0.9);
  const repeatRef = useRef("off");
  const shuffleRef = useRef(false);

  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => { volumeRef.current = volume; if(audioRef.current) audioRef.current.volume = volume; }, [volume]);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      audio.play().catch(() => toast.show("Play xətası"));
    } else {
      audio.pause();
    }
  }, [current, toast]);

  const loadSong = useCallback(async (song) => {
    if (!song || !song.id) return;
    setLoadingStream(true);
    setCurrent(song);
    setProgress(0);
    setDuration(song.duration || 0);

    try {
      const audio = audioRef.current;
      if (!audio) return;
      audio.src = `${API}/stream?video_id=${song.id}`;
      audio.volume = volumeRef.current;
      await audio.play();
      setPlaying(true);
      setLoadingStream(false);
    } catch (err) {
      console.error("[loadSong] Failed:", err);
      setLoadingStream(false);
      setPlaying(false);
    }

    axios.get(`${API}/stream-info/${song.id}`).then(({ data }) => {
      if (data) setCurrent((c) => (c && c.id === song.id ? { ...c, ...data } : c));
    }).catch(() => {});
  }, [toast]);

  const next = useCallback(() => {
    const q = [...queue];
    if (q.length === 0) {
      if (repeatRef.current === "all" && currentRef.current) {
        loadSong(currentRef.current);
      } else {
        setPlaying(false);
      }
      return;
    }
    if (currentRef.current) setHistory(prev => [...prev, currentRef.current].slice(-50));
    let nextS;
    if (shuffleRef.current) {
      const idx = Math.floor(Math.random() * q.length);
      nextS = q.splice(idx, 1)[0];
    } else {
      nextS = q.shift();
    }
    setQueue(q);
    loadSong(nextS);
  }, [queue, loadSong]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (history.length > 0) {
      const h = [...history];
      const p = h.pop();
      setHistory(h);
      if (currentRef.current) setQueue(q => [currentRef.current, ...q]);
      loadSong(p);
    }
  }, [history, loadSong]);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = volume;
    
    audio.addEventListener("timeupdate", () => setProgress(audio.currentTime));
    audio.addEventListener("durationchange", () => setDuration(audio.duration));
    audio.addEventListener("play", () => setPlaying(true));
    audio.addEventListener("pause", () => setPlaying(false));
    audio.addEventListener("waiting", () => setLoadingStream(true));
    audio.addEventListener("canplay", () => setLoadingStream(false));
    audio.addEventListener("ended", () => {
      if (repeatRef.current === "one") {
        audio.currentTime = 0;
        audio.play();
      } else {
        next();
      }
    });

    audioRef.current = audio;
    return () => { audio.pause(); audio.src = ""; };
  }, [next]); // eslint-disable-line

  useEffect(() => {
    if (current) {
      updateMediaSession(current, { togglePlay, next, prev });
    }
  }, [current, togglePlay, next, prev]);

  const seek = (ratio) => {
    if (audioRef.current && duration) audioRef.current.currentTime = ratio * duration;
  };

  const enqueue = (song) => {
    setQueue((q) => [...q, song]);
    toast.show(`Sıraya əlavə edildi`);
  };

  return {
    current, queue, playing, progress, duration, volume, shuffle, repeat,
    fullOpen, loadingStream, sessionId,
    play: loadSong, togglePlay, next, prev, seek, enqueue,
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

/* ---------- ACTIVE USER TRACKER ---------- */
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
    const unsub = onValue(connectionsRef, (snap) => setCount(snap.size || 1));
    return () => unsub();
  }, []);
  return <span className="active-num">{count}</span>;
};

/* ---------- Components ---------- */
const BrandHeader = () => (
  <header className="brand-header">
    <div>
      <div className="brand-title"><span className="dot" />Raven Spotify</div>
      <div className="brand-sub">Creator @Ryhavean &lt;/&gt;</div>
    </div>
    <div className="status-pill"><Eye size={14} color="var(--accent)" /><ActiveUserTracker /></div>
  </header>
);

const SongCard = ({ song, onPlay, onLike, liked }) => (
  <div className="song-card" onClick={() => onPlay(song)}>
    <img className="cover" src={song.thumbnail} alt="" loading="lazy" />
    <div className="title">{song.title}</div>
    <div className="artist">{song.artist}</div>
    <div className="play-pill"><Play size={18} fill="#000" /></div>
    {onLike && (
      <button className={`card-like-btn ${liked ? "liked" : ""}`} onClick={(e) => { e.stopPropagation(); onLike(song); }}>
        <Heart size={16} fill={liked ? "currentColor" : "none"} />
      </button>
    )}
  </div>
);

const SongRow = ({ song, onPlay, rank, onLike, liked }) => (
  <div className={rank ? "row-ranked" : "song-row"} onClick={() => onPlay(song)}>
    {rank && <div className="rank-num">{rank}</div>}
    <img className="cover" src={song.thumbnail} alt="" />
    <div className="meta">
      <div className="title">{song.title}</div>
      <div className="artist">{song.artist}</div>
    </div>
    {onLike && (
      <button className={`row-like-btn ${liked ? "liked" : ""}`} onClick={(e) => { e.stopPropagation(); onLike(song); }}>
        <Heart size={16} fill={liked ? "currentColor" : "none"} />
      </button>
    )}
    <div className="duration">{fmtTime(song.duration)}</div>
  </div>
);

const Skeleton = ({ w = "100%", h = 120 }) => <div className="skeleton" style={{ width: w, height: h, flex: `0 0 ${w}` }} />;

/* ---------- Pages ---------- */
const HomePage = ({ player, toggleFav, isFav }) => {
  const [recent, setRecent] = useState([]);
  const [trending, setTrending] = useState([]);
  const [topAz, setTopAz] = useState([]);
  const [artists, setArtists] = useState([]);
  const [discovery, setDiscovery] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(() => {
    axios.get(`${API}/home-bootstrap`).then(({ data }) => {
      setTopAz(data.top || []);
      setArtists(data.artists || []);
      setDiscovery(data.discovery || []);
      setLoading(false);
    });
    axios.get(`${API}/trending?limit=10`).then(r => setTrending(r.data.trending || []));
    axios.get(`${API}/recently-played?session_id=${player.sessionId}&limit=12`)
      .then(r => setRecent((r.data.recent || []).map(x => ({...x, id: x.song_id}))));
  }, [player.sessionId]);

  useEffect(() => {
    fetchData();
    window.addEventListener("fav_updated", fetchData);
    return () => window.removeEventListener("fav_updated", fetchData);
  }, [fetchData]);

  return (
    <div className="page">
      <div className="page-sub vip-subtitle">My Channel : @rveanx</div>
      {recent.length > 0 && (
        <section className="section">
          <div className="section-title vip-section"><Clock size={16} /> Son dinlənilənlər</div>
          <div className="row-scroll">
            {recent.map(s => <SongCard key={s.id} song={s} onPlay={player.play} onLike={toggleFav} liked={isFav(s.id)} />)}
          </div>
        </section>
      )}
      <section className="section">
        <div className="section-title vip-section">Azerbayjan Top Music 🇦🇿</div>
        {loading ? <div className="row-scroll">{[...Array(5)].map((_, i) => <Skeleton key={i} w="150px" h="190px" />)}</div> :
          <div className="row-scroll">{topAz.map(s => <SongCard key={s.id} song={s} onPlay={player.play} onLike={toggleFav} liked={isFav(s.id)} />)}</div>}
      </section>
      <section className="section">
        <div className="section-title vip-section"><TrendingUp size={16} /> Ən çox bəyənilənlər</div>
        <div className="row-scroll">{trending.map(s => <SongCard key={s.id} song={s} onPlay={player.play} onLike={toggleFav} liked={isFav(s.id)} />)}</div>
      </section>
    </div>
  );
};

const SearchPage = ({ player, toggleFav, isFav }) => {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  const doSearch = useCallback(debounce(async (query) => {
    if (!query.trim()) { setResults([]); return; }
    setLoading(true);
    const { data } = await axios.get(`${API}/search?q=${encodeURIComponent(query)}&limit=20`);
    setResults(data.results || []);
    setLoading(false);
  }, 350), []);

  useEffect(() => { doSearch(q); }, [q, doSearch]);

  return (
    <div className="page">
      <h1 className="page-title vip-title">Axtarış</h1>
      <div className="search-wrap">
        <SearchIcon className="search-icon" size={18} />
        <input className="search-input" placeholder="Mahnı, ifaçı..." value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="search-results">
        {results.map(s => <SongRow key={s.id} song={s} onPlay={player.play} onLike={toggleFav} liked={isFav(s.id)} />)}
      </div>
    </div>
  );
};

const FavoritesPage = ({ player, favs, toggleFav, isFav }) => (
  <div className="page">
    <h1 className="page-title vip-title">My List</h1>
    <div className="song-list">
      {favs.map(s => {
        const song = { id: s.song_id, title: s.title, artist: s.artist, duration: s.duration, thumbnail: s.thumbnail };
        return <SongRow key={s.song_id} song={song} onPlay={player.play} onLike={toggleFav} liked={isFav(song.id)} />;
      })}
    </div>
  </div>
);

const FullPlayer = ({ player, toggleFav, isFav }) => {
  if (!player.current) return null;
  const s = player.current;
  const pct = player.duration ? player.progress / player.duration : 0;
  const liked = isFav(s.id);
  return (
    <div className="full-player">
      <div className="full-top">
        <button className="ctrl" onClick={() => player.setFullOpen(false)}><ChevronDown size={22} /></button>
        <div className="label">Oxunur</div>
        <button className="ctrl"><MoreHorizontal size={20} /></button>
      </div>
      <div className="full-body">
        <div className="art-wrap">
          <div className={`art-inner ${player.playing ? "playing" : ""}`} style={{ backgroundImage: `url(${s.thumbnail})` }} />
        </div>
        <div className="track-info"><div className="t">{s.title}</div><div className="a">{s.artist}</div></div>
        <div className="progress-wrap">
          <div className="progress-bar" onClick={(e) => player.seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.getBoundingClientRect().width)}>
            <div className="fill" style={{ width: `${pct * 100}%` }} />
          </div>
          <div className="time-row"><span>{fmtTime(player.progress)}</span><span>{fmtTime(player.duration)}</span></div>
        </div>
        <div className="controls-row">
          <button className={`ctrl ${player.shuffle ? "active" : ""}`} onClick={() => player.setShuffle(!player.shuffle)}><Shuffle size={18} /></button>
          <button className="ctrl" onClick={player.prev}><SkipBack size={22} fill="currentColor" /></button>
          <button className="ctrl play" onClick={player.togglePlay}>
            {player.loadingStream ? <Loader2 size={24} className="animate-spin" /> : player.playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </button>
          <button className="ctrl" onClick={player.next}><SkipForward size={22} fill="currentColor" /></button>
          <button className={`ctrl ${player.repeat !== "off" ? "active" : ""}`} onClick={() => {
            const o = ["off", "all", "one"]; player.setRepeat(o[(o.indexOf(player.repeat) + 1) % 3]);
          }}><Repeat size={18} /></button>
        </div>
        <div className="extra-row">
          <button className={`ctrl like-btn ${liked ? "liked" : ""}`} onClick={() => toggleFav(s)}><Heart size={20} fill={liked ? "currentColor" : "none"} /></button>
          <button className="ctrl" onClick={() => player.enqueue(s)}><Plus size={20} /></button>
        </div>
      </div>
    </div>
  );
};

const MiniPlayer = ({ player, toggleFav, isFav }) => {
  if (!player.current) return null;
  const pct = player.duration ? player.progress / player.duration : 0;
  return (
    <div className="mini-player" onClick={() => player.setFullOpen(true)}>
      <img className="cover" src={player.current.thumbnail} alt="" />
      <div className="info"><div className="title">{player.current.title}</div><div className="artist">{player.current.artist}</div></div>
      <div className="controls" onClick={(e) => e.stopPropagation()}>
        <button className="ctrl-btn" onClick={player.togglePlay}>{player.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
        <button className="ctrl-btn" onClick={player.next}><SkipForward size={18} fill="currentColor" /></button>
      </div>
      <div className="progress-line" style={{ width: `${pct * 100}%` }} />
    </div>
  );
};

const BottomNav = ({ tab, setTab }) => (
  <nav className="bottom-nav">
    {[ {id:"home", Icon:HomeIcon}, {id:"search", Icon:SearchIcon}, {id:"favs", Icon:Heart}, {id:"nowp", Icon:Music2} ].map(i => (
      <button key={i.id} className={`nav-btn ${tab === i.id ? "active" : ""}`} onClick={() => setTab(i.id)}><i.Icon size={22} /></button>
    ))}
  </nav>
);

function App() {
  const toast = useToast();
  const player = usePlayer(toast);
  const [tab, setTab] = useState("home");
  const [favs, setFavs] = useState([]);
  useDynamicBg(player.current);

  const refreshFavs = useCallback(() => {
    axios.get(`${API}/favorites?session_id=${player.sessionId}`).then(r => setFavs(r.data.favorites || []));
  }, [player.sessionId]);

  useEffect(() => { refreshFavs(); }, [refreshFavs]);
  const isFav = useCallback((id) => favs.some(f => f.song_id === id), [favs]);

  const toggleFav = useCallback(async (s) => {
    const currentlyFav = isFav(s.id);
    try {
      if (currentlyFav) {
        await axios.delete(`${API}/favorites/${s.id}?session_id=${player.sessionId}`);
      } else {
        await axios.post(`${API}/favorites`, { session_id: player.sessionId, song: s });
      }
      refreshFavs();
      window.dispatchEvent(new Event("fav_updated"));
    } catch { toast.show("Xəta baş verdi"); }
  }, [isFav, player.sessionId, refreshFavs, toast]);

  useEffect(() => {
    if (tab === "nowp") {
      if (player.current) player.setFullOpen(true);
      setTab("home");
    }
  }, [tab, player.current]);

  return (
    <div className="app-shell">
      <div className="dynamic-bg" />
      <BrandHeader />
      {tab === "home" && <HomePage player={player} toggleFav={toggleFav} isFav={isFav} />}
      {tab === "search" && <SearchPage player={player} toggleFav={toggleFav} isFav={isFav} />}
      {tab === "favs" && <FavoritesPage player={player} favs={favs} toggleFav={toggleFav} isFav={isFav} />}
      <MiniPlayer player={player} toggleFav={toggleFav} isFav={isFav} />
      <BottomNav tab={tab} setTab={setTab} />
      {player.fullOpen && <FullPlayer player={player} toggleFav={toggleFav} isFav={isFav} />}
      {toast.node}
    </div>
  );
}

export default App;
