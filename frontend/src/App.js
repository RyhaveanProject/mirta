
8️⃣ frontend/src/App.js
import { useEffect, useState, useRef, useCallback } from "react";
import "./App.css";
import axios from "axios";
import {
  Home as HomeIcon, Search as SearchIcon, Heart, Music2,
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1,
  ChevronDown, Volume2, ListMusic, Plus, MoreHorizontal,
  Loader2, TrendingUp, Sparkles, Clock
} from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
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
  const repeatRef = useRef(repeat);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);

  // Initialize YT player once — mount host div OUTSIDE React to avoid reconciliation conflicts
  useEffect(() => {
    let cancelled = false;
    let host = document.getElementById(ytDivId);
    if (!host) {
      host = document.createElement("div");
      host.id = ytDivId;
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;";
      document.body.appendChild(host);
    }
    loadYTApi().then((YT) => {
      if (cancelled) return;
      ytPlayerRef.current = new YT.Player(ytDivId, {
        height: "2", width: "2",
        playerVars: {
          autoplay: 1, controls: 0, playsinline: 1,
          modestbranding: 1, rel: 0, origin: window.location.origin,
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
            else if (e.data === 2) { setPlaying(false); }
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
    // eslint-disable-next-line
  }, []);

  // Progress ticker
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
      // eslint-disable-next-line no-await-in-loop
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
    } catch (e) {
      toast.show("Couldn't start playback.");
      setLoadingStream(false);
    }

    axios.get(`${API}/stream-info/${song.id}`).then(({ data }) => {
      if (data) setCurrent((c) => (c && c.id === song.id ? { ...c, ...data } : c));
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

  const togglePlay = () => {
    const p = ytPlayerRef.current;
    if (!p || !current) return;
    try {
      const state = p.getPlayerState ? p.getPlayerState() : -1;
      if (state === 1) { p.pauseVideo(); setPlaying(false); }
      else { p.playVideo(); setPlaying(true); }
    } catch {}
  };

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

  const prev = () => {
    if (history.length) {
      const h = [...history];
      const p = h.shift();
      setHistory(h);
      if (p) play(p, { skipHistory: true });
    } else {
      const pl = ytPlayerRef.current;
      try { if (pl) pl.seekTo(0, true); } catch {}
    }
  };

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
      <div className="brand-title"><span className="dot" />Ryhavean Spotify</div>
      <div className="brand-sub">Creator @Ryhavean &lt;\&gt;</div>
    </div>
  </header>
);

const SongCard = ({ song, onPlay }) => (
  <div className="song-card" data-testid={`song-card-${song.id}`} onClick={() => onPlay(song)}>
    <img className="cover" src={song.thumbnail} alt={song.title} loading="lazy"
         onError={(e) => { e.target.src = `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`; }} />
    <div className="title">{song.title}</div>
    <div className="artist">{song.artist}</div>
    <div className="play-pill"><Play size={18} fill="#000" /></div>
  </div>
);

const SongRow = ({ song, onPlay, rank }) => (
  <div className={rank ? "row-ranked" : "song-row"} onClick={() => onPlay(song)} data-testid={`song-row-${song.id}`}>
    {rank && <div className="rank-num">{rank}</div>}
    <img className="cover" src={song.thumbnail} alt={song.title} loading="lazy"
         onError={(e) => { e.target.src = `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`; }} />
    <div className="meta">
      <div className="title">{song.title}</div>
      <div className="artist">{song.artist}</div>
    </div>
    <div className="duration">{fmtTime(song.duration)}</div>
  </div>
);

const Skeleton = ({ w = "100%", h = 120 }) => (
  <div className="skeleton" style={{ width: w, height: h, flex: `0 0 ${w}` }} />
);

/* ---------- Pages ---------- */
const HomePage = ({ player }) => {
  const [recent, setRecent] = useState([]);
  const [trending, setTrending] = useState([]);
  const [featured, setFeatured] = useState([]);
  const [discovery, setDiscovery] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const sid = player.sessionId;
    Promise.allSettled([
      axios.get(`${API}/recently-played?session_id=${sid}&limit=12`),
      axios.get(`${API}/trending?limit=10`),
      axios.get(`${API}/featured?category=top%20hits%202025`),
      axios.get(`${API}/featured?category=chill%20lofi%20beats`),
    ]).then((res) => {
      setRecent(res[0].status === "fulfilled" ? (res[0].value.data.recent || []).map(r => ({...r, id: r.song_id})) : []);
      setTrending(res[1].status === "fulfilled" ? (res[1].value.data.trending || []) : []);
      setFeatured(res[2].status === "fulfilled" ? (res[2].value.data.results || []) : []);
      setDiscovery(res[3].status === "fulfilled" ? (res[3].value.data.results || []) : []);
      setLoading(false);
    });
  }, [player.sessionId]);

  return (
    <div className="page" data-testid="home-page">
      <h1 className="page-title">Good vibes</h1>
      <div className="page-sub">Your soundtrack, always evolving</div>

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head">
            <div className="section-title"><Clock size={16} style={{marginRight: 6, display:"inline"}} /> Recently played</div>
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
          <div className="section-title"><TrendingUp size={16} style={{marginRight: 6, display:"inline"}} /> Trending now</div>
        </div>
        {loading ? (
          <div className="row-scroll">{[...Array(5)].map((_, i) => <Skeleton key={i} w="150px" h="190px" />)}</div>
        ) : trending.length ? (
          <div className="row-scroll">
            {trending.map((s) => <SongCard key={s.id} song={s} onPlay={player.play} />)}
          </div>
        ) : (
          <div className="empty">Trending songs will appear as people like tracks</div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title"><Sparkles size={16} style={{marginRight: 6, display:"inline"}} /> Top hits today</div>
        </div>
        {loading ? (
          <div className="row-scroll">{[...Array(5)].map((_, i) => <Skeleton key={i} w="150px" h="190px" />)}</div>
        ) : (
          <div className="row-scroll">
            {featured.map((s) => <SongCard key={s.id} song={s} onPlay={player.play} />)}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title">Chill discovery mix</div>
        </div>
        {loading ? (
          <div className="row-scroll">{[...Array(5)].map((_, i) => <Skeleton key={i} w="150px" h="190px" />)}</div>
        ) : (
          <div className="row-scroll">
            {discovery.map((s) => <SongCard key={s.id} song={s} onPlay={player.play} />)}
          </div>
        )}
      </section>
    </div>
  );
};

const SearchPage = ({ player }) => {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [cats, setCats] = useState([]);
  const [activeCat, setActiveCat] = useState(null);
  const [catResults, setCatResults] = useState([]);
  const [loading, setLoading] = useState(false);

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
  }, 450), []);

  useEffect(() => { doSearch(q); }, [q, doSearch]);

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
      <h1 className="page-title">Search</h1>
      <div className="search-wrap">
        <SearchIcon className="search-icon" size={18} />
        <input
          className="search-input"
          placeholder="Songs, artists, moods…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="search-input"
          autoFocus
        />
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
              <div className="section-title" style={{marginBottom: 12, textTransform: "capitalize"}}>{activeCat}</div>
              <div className="song-list">
                {catResults.map((s) => <SongRow key={s.id} song={s} onPlay={player.play} />)}
              </div>
            </div>
          )}
          {!activeCat && <div className="empty">Tap a genre above or start typing to explore</div>}
        </>
      )}

      {q.trim() !== "" && (
        <div className="search-results">
          {loading ? (
            <div className="song-list">{[...Array(6)].map((_, i) => <Skeleton key={i} h="58px" />)}</div>
          ) : results.length === 0 ? (
            <div className="empty">No results for "{q}"</div>
          ) : (
            <div className="song-list">
              {results.map((s) => <SongRow key={s.id} song={s} onPlay={player.play} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const FavoritesPage = ({ player, favs }) => {
  const [trending, setTrending] = useState([]);
  useEffect(() => {
    axios.get(`${API}/trending?limit=10`).then(r => setTrending(r.data.trending || [])).catch(() => {});
  }, []);

  return (
    <div className="page" data-testid="favorites-page">
      <h1 className="page-title">Your favorites</h1>
      <div className="page-sub">{favs.length} liked {favs.length === 1 ? "song" : "songs"}</div>

      {favs.length === 0 ? (
        <div className="empty">Tap the heart on any song to save it here</div>
      ) : (
        <div className="song-list" data-testid="favorites-list">
          {favs.map((s) => {
            const song = { id: s.song_id, title: s.title, artist: s.artist, duration: s.duration, thumbnail: s.thumbnail };
            return <SongRow key={s.song_id} song={song} onPlay={player.play} />;
          })}
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <div className="section-title"><TrendingUp size={16} style={{marginRight:6, display:"inline"}} /> Top liked worldwide</div>
        </div>
        {trending.length === 0 ? (
          <div className="empty">No global likes yet. Be the first!</div>
        ) : (
          <div className="song-list">
            {trending.map((s, i) => <SongRow key={s.id} song={s} onPlay={player.play} rank={i + 1} />)}
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
        <div className="label">Now Playing</div>
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

const MiniPlayer = ({ player }) => {
  if (!player.current) return null;
  const pct = player.duration ? player.progress / player.duration : 0;
  return (
    <div className="mini-player" onClick={() => player.setFullOpen(true)} data-testid="mini-player">
      <img className="cover" src={player.current.thumbnail} alt="" />
      <div className="info">
        <div className="title">{player.current.title}</div>
        <div className="artist">{player.current.artist}</div>
      </div>
      <div className="controls" onClick={(e) => e.stopPropagation()}>
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
    { id: "search", label: "Search", Icon: SearchIcon },
    { id: "favs", label: "Favorites", Icon: Heart },
    { id: "nowp", label: "Now Playing", Icon: Music2 },
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

/* ---------- Main App ---------- */
function App() {
  const toast = useToast();
  const player = usePlayer(toast);
  const [tab, setTab] = useState("home");
  const [favs, setFavs] = useState([]);
  useDynamicBg(player.current);

  const refreshFavs = useCallback(() => {
    axios.get(`${API}/favorites?session_id=${player.sessionId}`)
      .then(r => setFavs(r.data.favorites || []))
      .catch(() => {});
  }, [player.sessionId]);

  useEffect(() => { refreshFavs(); }, [refreshFavs]);

  const isFav = (id) => favs.some(f => f.song_id === id);

  const toggleFav = async (s) => {
    if (isFav(s.id)) {
      await axios.delete(`${API}/favorites/${s.id}?session_id=${player.sessionId}`);
      toast.show("Removed from favorites");
    } else {
      await axios.post(`${API}/favorites`, {
        session_id: player.sessionId,
        song: { id: s.id, title: s.title, artist: s.artist, duration: s.duration || 0, thumbnail: s.thumbnail || "" },
      });
      toast.show("Added to favorites ♥");
    }
    refreshFavs();
  };

  useEffect(() => {
    if (tab === "nowp") {
      if (player.current) player.setFullOpen(true);
      else toast.show("Play a song first");
      setTab((t) => (t === "nowp" ? "home" : t));
    }
    // eslint-disable-next-line
  }, [tab, player.current]);

  let pageEl;
  if (tab === "home") pageEl = <HomePage player={player} />;
  else if (tab === "search") pageEl = <SearchPage player={player} />;
  else if (tab === "favs") pageEl = <FavoritesPage player={player} favs={favs} />;
  else pageEl = <HomePage player={player} />;

  return (
    <div className="app-shell">
      <div className="dynamic-bg" />
      <BrandHeader />
      {pageEl}
      <MiniPlayer player={player} />
      <BottomNav tab={tab} setTab={setTab} />
      {player.fullOpen && <FullPlayer player={player} toggleFav={toggleFav} isFav={isFav} />}
      {toast.node}
    </div>
  );
}

export default App;
