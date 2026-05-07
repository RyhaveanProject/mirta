// src/audioManager.js
/**
 * RyAudioManager — iOS background-safe native HTML5 audio player.
 *
 *  Architecture:
 *  -------------
 *  Backend `/api/audio/{video_id}` returns a STABLE proxy URL with:
 *    • HTTP Range support (iOS lock screen / seek)
 *    • Auto-refresh of expired googlevideo upstreams
 *    • No service-worker interception
 *
 *  Frontend uses ONE SINGLETON <audio> element (never detached),
 *  attached directly to the DOM so iOS Safari keeps audio alive when
 *  the tab goes background / screen is locked.
 *
 *  CRITICAL: We do NOT use Web Audio API / AudioContext. iOS suspends
 *  AudioContext when the tab backgrounds, which would also kill any
 *  audio routed through it. Pure <audio> element works in background.
 */
class RyAudioManager {
  constructor() {
    if (typeof window === "undefined") return;

    if (!window.__RY_NATIVE_AUDIO__) {
      const audio = document.createElement("audio");
      audio.id = "ry-native-audio";
      audio.preload = "auto";
      audio.controls = false;
      audio.autoplay = false;
      audio.loop = false;
      audio.muted = false;
      audio.volume = 1.0;
      audio.crossOrigin = "anonymous";

      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");
      audio.setAttribute("x-webkit-airplay", "allow");

      audio.style.cssText =
        "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
      document.body.appendChild(audio);

      window.__RY_NATIVE_AUDIO__ = audio;
    }

    this.audio = window.__RY_NATIVE_AUDIO__;
    this._wantPlaying = false;
    this._unlocked = false;
    this._listeners = { play: [], pause: [], ended: [], timeupdate: [], loadedmetadata: [], error: [] };
    this._currentMeta = {};

    this._setupUnlock();
    this._setupAudioEvents();
    this._setupMediaSession();
    this._setupVisibility();
  }

  /* ----------- public event subscription ----------- */
  on(event, cb) {
    if (!this._listeners[event]) return () => {};
    this._listeners[event].push(cb);
    return () => {
      this._listeners[event] = this._listeners[event].filter((f) => f !== cb);
    };
  }
  _emit(event, payload) {
    (this._listeners[event] || []).forEach((cb) => {
      try { cb(payload); } catch {}
    });
  }

  /* ----------- iOS unlock on first gesture ----------- */
  _setupUnlock() {
    const unlock = async () => {
      if (this._unlocked) return;
      this._unlocked = true;
      try {
        const wasMuted = this.audio.muted;
        this.audio.muted = true;
        const p = this.audio.play();
        if (p && typeof p.then === "function") await p.catch(() => {});
        this.audio.pause();
        this.audio.muted = wasMuted;
      } catch {}
      ["touchstart", "touchend", "click", "keydown"].forEach((e) =>
        document.removeEventListener(e, unlock, true)
      );
    };
    ["touchstart", "touchend", "click", "keydown"].forEach((e) =>
      document.addEventListener(e, unlock, true)
    );
  }

  _updatePositionState() {
    if (!("mediaSession" in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== "function") return;
    const a = this.audio;
    const dur = a.duration;
    if (!isFinite(dur) || dur <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: Math.max(0, Math.min(a.currentTime || 0, dur)),
        playbackRate: a.playbackRate || 1,
      });
    } catch {}
  }

  _setPlaybackState(state) {
    if (!("mediaSession" in navigator)) return;
    try { navigator.mediaSession.playbackState = state; } catch {}
  }

  _setupAudioEvents() {
    const a = this.audio;

    a.addEventListener("play", () => {
      this._wantPlaying = true;
      this._setPlaybackState("playing");
      this._emit("play");
    });

    a.addEventListener("playing", () => {
      this._wantPlaying = true;
      this._setPlaybackState("playing");
      this._updatePositionState();
      this._emit("play");
    });

    a.addEventListener("pause", () => {
      // If the user did NOT request a pause but the browser paused us
      // (e.g., iOS backgrounding glitch), try to resume once.
      if (this._wantPlaying) {
        const p = this.audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } else {
        this._setPlaybackState("paused");
        this._emit("pause");
      }
    });

    a.addEventListener("ended", () => {
      this._wantPlaying = false;
      this._setPlaybackState("none");
      this._emit("ended");
    });

    a.addEventListener("loadedmetadata", () => {
      this._updatePositionState();
      this._emit("loadedmetadata", { duration: a.duration });
    });

    a.addEventListener("durationchange", () => this._updatePositionState());
    a.addEventListener("timeupdate", () => {
      this._updatePositionState();
      this._emit("timeupdate", { currentTime: a.currentTime, duration: a.duration });
    });
    a.addEventListener("seeked", () => this._updatePositionState());

    a.addEventListener("stalled", () => {
      if (this._wantPlaying) {
        const p = this.audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    });

    a.addEventListener("suspend", () => {
      if (this._wantPlaying && this.audio.paused) {
        const p = this.audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    });

    a.addEventListener("error", (e) => {
      this._emit("error", e);
    });
  }

  _setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const safeSet = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
    };

    safeSet("play", async () => {
      this._wantPlaying = true;
      try { await this.audio.play(); } catch {}
      this._setPlaybackState("playing");
    });
    safeSet("pause", () => {
      this._wantPlaying = false;
      this.audio.pause();
      this._setPlaybackState("paused");
    });
    safeSet("stop", () => {
      this._wantPlaying = false;
      try { this.audio.pause(); this.audio.currentTime = 0; } catch {}
      this._setPlaybackState("none");
    });
    safeSet("seekbackward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      try { this.audio.currentTime = Math.max(0, (this.audio.currentTime || 0) - skip); } catch {}
      this._updatePositionState();
    });
    safeSet("seekforward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      try {
        const dur = isFinite(this.audio.duration) ? this.audio.duration : Number.MAX_SAFE_INTEGER;
        this.audio.currentTime = Math.min(dur, (this.audio.currentTime || 0) + skip);
      } catch {}
      this._updatePositionState();
    });
    safeSet("seekto", (details) => {
      if (!details || typeof details.seekTime !== "number") return;
      try {
        if (details.fastSeek && typeof this.audio.fastSeek === "function") {
          this.audio.fastSeek(details.seekTime);
        } else {
          this.audio.currentTime = details.seekTime;
        }
      } catch {}
      this._updatePositionState();
    });
    // Prev/Next handlers are set from App via setNextPrev()
  }

  setNextPrev(nextFn, prevFn) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("nexttrack", () => nextFn && nextFn());
      navigator.mediaSession.setActionHandler("previoustrack", () => prevFn && prevFn());
    } catch {}
  }

  _setupVisibility() {
    const reassert = () => {
      if (this._wantPlaying) {
        if (this.audio.paused) {
          const p = this.audio.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
        this._setPlaybackState("playing");
        this._updatePositionState();
      }
    };
    document.addEventListener("visibilitychange", reassert);
    window.addEventListener("pageshow", reassert);
    window.addEventListener("focus", reassert);
    document.addEventListener("resume", reassert);
  }

  /* ----------- public playback API ----------- */
  async attachStream(url, meta = {}) {
    if (!url) return false;
    try {
      this._wantPlaying = true;
      this._currentMeta = meta || {};

      if ("mediaSession" in navigator && typeof window.MediaMetadata !== "undefined") {
        try {
          navigator.mediaSession.metadata = new window.MediaMetadata({
            title: meta.title || "",
            artist: meta.artist || "",
            album: meta.album || "Ryhavean Music",
            artwork: meta.thumbnail
              ? [
                  { src: meta.thumbnail, sizes: "96x96", type: "image/jpeg" },
                  { src: meta.thumbnail, sizes: "192x192", type: "image/jpeg" },
                  { src: meta.thumbnail, sizes: "256x256", type: "image/jpeg" },
                  { src: meta.thumbnail, sizes: "384x384", type: "image/jpeg" },
                  { src: meta.thumbnail, sizes: "512x512", type: "image/jpeg" },
                ]
              : [],
          });
        } catch {}
      }

      if (this.audio.src !== url) {
        this.audio.src = url;
        try { this.audio.load(); } catch {}
      }

      await this.audio.play();
      this._setPlaybackState("playing");
      this._updatePositionState();
      return true;
    } catch (e) {
      console.log("[AudioManager] attach failed", e);
      return false;
    }
  }

  pause() {
    this._wantPlaying = false;
    this.audio.pause();
    this._setPlaybackState("paused");
  }

  async resume() {
    this._wantPlaying = true;
    try {
      await this.audio.play();
      this._setPlaybackState("playing");
    } catch {}
  }

  seek(seconds) {
    try {
      const dur = this.audio.duration;
      if (!isFinite(dur) || dur <= 0) return;
      this.audio.currentTime = Math.max(0, Math.min(seconds, dur));
      this._updatePositionState();
    } catch {}
  }

  setVolume(v) {
    try { this.audio.volume = Math.max(0, Math.min(1, v)); } catch {}
  }

  getCurrentTime() {
    return this.audio.currentTime || 0;
  }

  getDuration() {
    return isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  isPaused() {
    return this.audio.paused;
  }

  destroy() {
    this._wantPlaying = false;
    try {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    } catch {}
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      } catch {}
    }
  }
}

const instance = new RyAudioManager();
export default instance;
