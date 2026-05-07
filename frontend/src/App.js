import React, { useState, useEffect, useRef, useCallback } from "react";
import AudioManager from "./audioManager";
import "./App.css";
import axios from "axios";
import {
  Home as HomeIcon, Search as SearchIcon, Heart, Music2,
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  ChevronDown, Volume2, ListMusic, Plus, MoreHorizontal,
  Loader2, TrendingUp, Sparkles, Clock, X, Eye,
  Headphones, Radio, Zap, ArrowRight
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

/* NOTE: YouTube IFrame Player was removed in v2.0 â iOS Safari blocks
 * 3rd-party iframe background audio. Playback is now driven entirely by
 * a native <audio> element via RyAudioManager + backend /api/audio proxy. */

/* ---------- Player Hook ----------
 * Native <audio> via RyAudioManager. Stream source = backend proxy
 * /api/audio/{video_id} (stable URL, Range-enabled, auto-refresh).
 * iOS plays this in background + lock screen. */
const usePlayer = (toast) => {
  const [current, setCurrent] = useState(null);
  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.9);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState("off");
  const [fullOpen, setFullOpen] = useState(false);
  const [loadingStream, setLoadingStream] = useState(false);
  const sessionId = getSessionId();
  const nextFnRef = useRef(null);
  const togglePlayRef = useRef(null);
  const prevFnRef = useRef(null);
  const currentIdRef = useRef(null);
  const repeatRef = useRef(repeat);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { currentIdRef.current = current?.id || null; }, [current]);

  /* ---------- AudioManager event wiring ---------- */
  useEffect(() => {
    const offTime = AudioManager.on("timeupdate", ({ currentTime, duration: d }) => {
      if (!isNaN(currentTime)) setProgress(currentTime);
      if (!isNaN(d) && d) setDuration(d);
    });
    const offMeta = AudioManager.on("loadedmetadata", ({ duration: d }) => {
      if (!isNaN(d) && d) setDuration(d);
      setLoadingStream(false);
    });
    const offPlay = AudioManager.on("play", () => {
      setPlaying(true);
      setLoadingStream(false);
    });
    const offPause = AudioManager.on("pause", () => setPlaying(false));
    const offEnded = AudioManager.on("ended", () => {
      if (repeatRef.current === "one") {
        AudioManager.seek(0);
        AudioManager.resume();
      } else if (nextFnRef.current) {
        nextFnRef.current();
      }
    });
    const offError = AudioManager.on("error", () => {
      toast.show("Stream failed. Trying nextâ¦");
      setLoadingStream(false);
      if (nextFnRef.current) setTimeout(() => nextFnRef.current(), 300);
    });
    return () => {
      offTime(); offMeta(); offPlay(); offPause(); offEnded(); offError();
    };
  }, [toast]);

  /* ---------- Volume ---------- */
  const setVolume = useCallback((v) => {
    setVolumeState(v);
    AudioManager.setVolume(v);
  }, []);
  useEffect(() => { AudioManager.setVolume(volume); }, []); // initial

  /* ---------- Play song via backend proxy ---------- */
  const play = useCallback(async (song, opts = {}) => {
    if (!song || !song.id) return;
    setLoadingStream(true);
    const prevSong = current;
    setCurrent(song);
    setProgress(0);
    setDuration(song.duration || 0);

    // Fire stream resolution and attach â single source of truth
    try {
      const { data } = await axios.get(`${API}/stream/${song.id}`);
      // Guard: user may have switched tracks while we were waiting
      if (currentIdRef.current !== song.id) return;

      if (data?.stream_url) {
        await AudioManager.attachStream(data.stream_url, {
          title: song.title || data.title,
          artist: song.artist || data.artist,
          thumbnail: song.thumbnail || data.thumbnail,
        });
        setCurrent((c) =>
          c && c.id === song.id ? { ...c, ...data, id: song.id } : c
        );
      } else {
        toast.show("Stream not available.");
        setLoadingStream(false);
      }
    } catch (e) {
      toast.show("Couldn't start playback.");
      setLoadingStream(false);
    }

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

  const togglePlay = useCallback(() => {
    if (!current) return;
    if (AudioManager.isPaused()) {
      AudioManager.resume();
      setPlaying(true);
    } else {
      AudioManager.pause();
      setPlaying(false);
    }
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
    // If we are >3 seconds in, rewind to start instead of going back
    if (AudioManager.getCurrentTime() > 3) {
      AudioManager.seek(0);
      return;
    }
    if (history.length) {
      const h = [...history];
      const p = h.shift();
      setHistory(h);
      if (p) play(p, { skipHistory: true });
    } else {
      AudioManager.seek(0);
    }
  }, [history, play]);

  useEffect(() => { prevFnRef.current = prev; }, [prev]);

  /* ---------- MediaSession prev/next hooks ---------- */
  useEffect(() => {
    AudioManager.setNextPrev(
      () => nextFnRef.current && nextFnRef.current(),
      () => prevFnRef.current && prevFnRef.current()
    );
  }, [next, prev]);

  const seek = (ratio) => {
    const dur = AudioManager.getDuration() || duration;
    if (dur) AudioManager.seek(dur * ratio);
  };

  const enqueue = (song) => {
    setQueue((q) => [...q, song]);
    toast.show(`Added to queue: ${song.title.slice(0, 30)}`);
  };

  return {
    current, queue, playing, progress, duration, volume, shuffle, repeat,
    fullOpen, loadingStream, sessionId,
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

/* ---------- ACTIVE USER TRACKER (YENÄ°) ---------- */
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

    // DinlÉyici ÉlavÉ edirik: bÉyÉnmÉ dÉyiÅÉndÉ trendlÉri yenilÉ
    window.addEventListener("fav_updated", fetchTrending);

    return () => { 
      cancelled = true; 
      window.removeEventListener("fav_updated", fetchTrending);
    };
  }, [player.sessionId, fetchTrending]);

  return (
    <div className="page" data-testid="home-page">
     <h1 className="page-title vip-title">Premium Music</h1>
      <div className="page-sub vip-subtitle"></div>

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head">
            <div className="section-title vip-section"><Clock size={16} style={{marginRight: 6, display:"inline"}} /> Son dinlÉnilÉnlÉr</div>
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
          <div className="section-title vip-section"><Sparkles size={16} style={{marginRight: 6, display:"inline"}} /> Azerbayjan Top Music ð¦ð¿</div>
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
          <div className="section-title vip-section">Miri Yusif & daha Ã§ox</div>
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
          <div className="section-title vip-section">AygÃ¼n KazÄ±mova kolleksiyasÄ±</div>
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
          <div className="section-title vip-section"><TrendingUp size={16} style={{marginRight: 6, display:"inline"}} /> Æn Ã§ox bÉyÉnilÉnlÉr</div>
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
      <h1 className="page-title vip-title">AxtarÄ±Å</h1>
      <div className="search-wrap">
        <SearchIcon className="search-icon" size={18} />
        <input
          ref={inputRef}
          className="search-input"
          placeholder="MahnÄ±, ifaÃ§Ä±, Éhvalâ¦"
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
            aria-label="AxtarÄ±ÅÄ± tÉmizlÉ"
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
          {!activeCat && <div className="empty">YuxarÄ±dan janr seÃ§ vÉ ya mahnÄ± adÄ±nÄ± yazÄ±b axtar</div>}
        </>
      )}

      {q.trim() !== "" && (
        <div className="search-results">
          {loading ? (
            <div className="song-list">{[...Array(6)].map((_, i) => <Skeleton key={i} h="58px" />)}</div>
          ) : results.length === 0 ? (
            <div className="empty">"{q}" Ã¼Ã§Ã¼n nÉticÉ tapÄ±lmadÄ±</div>
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
      <div className="page-sub vip-subtitle">{favs.length} bÉyÉnilmiÅ mahnÄ±</div>

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
          <div className="section-title vip-section"><TrendingUp size={16} style={{marginRight:6, display:"inline"}} /> Æn Ã§ox bÉyÉnilÉnlÉr</div>
        </div>
        {trending.length === 0 ? (
          <div className="empty">HÉlÉ bÉyÉnilmiÅ mahnÄ± yoxdur</div>
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

/* ---------- PREMIUM WELCOME / GÄ°RÄ°Å EKRANI ---------- */
const WelcomeScreen = ({ onEnter }) => {
  const [leaving, setLeaving] = useState(false);
  const handle = () => {
    setLeaving(true);
    setTimeout(() => onEnter(), 480);
  };
  return (
    <div className={`welcome-screen ${leaving ? "leaving" : ""}`} data-testid="welcome-screen">
      <div className="welcome-orb o1" />
      <div className="welcome-orb o2" />
      <div className="welcome-orb o3" />
      <div className="welcome-grid" />

      <div className="welcome-top">
        <div className="welcome-brand">
          <span className="logo-pulse" />
          Raven
        </div>
        <div className="welcome-badge">
          <Sparkles size={11} /> Premium
        </div>
      </div>

      <div className="welcome-center">
        <div className="welcome-disc" aria-hidden="true">
          <div className="welcome-disc-inner" />
        </div>
        <div className="welcome-text">
          <h1 className="welcome-title">
            Ryhavean Studio 
            <span className="accent-line">Spotify</span>
          </h1>
          <p className="welcome-sub">
            Global Én yaxÅÄ± mahnÄ±lar â premium, reklamsÄ±z vÉ limitsiz dinlÉmÉ imkanÄ±.
          </p>
        </div>
      </div>

      <div className="welcome-bottom">
        <div className="welcome-features">
          <div className="welcome-feature"><Headphones size={13} /> HD Audio</div>
          <div className="welcome-feature"><Radio size={13} /> CanlÄ± Top</div>
          <div className="welcome-feature"><Zap size={13} /> Background</div>
        </div>
        <button className="welcome-btn" onClick={handle} data-testid="welcome-enter-btn">
           <ArrowRight size={18} />
        </button>
        <div className="welcome-foot">
          Creator <span className="gold">Ryhavean</span>
        </div>
      </div>
    </div>
  );
};

function App() {
  const toast = useToast();
  const player = usePlayer(toast);
  const [tab, setTab] = useState("home");
  const [favs, setFavs] = useState([]);
  const [likePending, setLikePending] = useState({});
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      return !localStorage.getItem("ryhavean_welcomed_v2");
    } catch {
      return true;
    }
  });
  useDynamicBg(player.current);

  const dismissWelcome = useCallback(() => {
    try { localStorage.setItem("ryhavean_welcomed_v2", "1"); } catch {}
    setShowWelcome(false);
  }, []);

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
        toast.show("SevimlilÉrdÉn silindi");
      } else {
        await axios.post(`${API}/favorites`, {
          session_id: player.sessionId,
          song: { id: s.id, title: s.title || "", artist: s.artist || "",
                  duration: s.duration || 0, thumbnail: s.thumbnail || "" },
        });
        toast.show("â¤ï¸âð¥");
      }
    } catch {
      toast.show("ÆmÉliyyat alÄ±nmadÄ±, yenidÉn cÉhd edin");
      refreshFavs();
    } finally {
      setLikePending((p) => { const { [s.id]: _, ...rest } = p; return rest; });
      refreshFavs();
      // Trend siyahÄ±larÄ±nÄ± yenilÉmÉk Ã¼Ã§Ã¼n siqnal gÃ¶ndÉririk
      window.dispatchEvent(new Event("fav_updated"));
    }
  }, [favs, likePending, player.sessionId, refreshFavs, toast]);

  useEffect(() => {
    if (tab === "nowp") {
      if (player.current) player.setFullOpen(true);
      else toast.show("ÆvvÉlcÉ bir mahnÄ± seÃ§");
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
      {showWelcome && <WelcomeScreen onEnter={dismissWelcome} />}
    </div>
  );
}

export default App;
