// src/audioManager.js

/**
 * RyAudioManager
 * --------------------------------------------------------------------------
 *  iOS arxa plan / kilid ekranı musiqisinin dayanmadan çalmasını təmin edir.
 *
 *  Backend tərəfində /api/audio/{video_id} adlı stabil proxy stream
 *  endpoint mövcuddur (Range request dəstəyi və avtomatik refresh ilə).
 *  Frontend-dən baxanda audio URL həmişə eynidir, ona görə iOS arxa
 *  planda Range request atanda CDN-də expired URL problemi yaranmır.
 *
 *  Public API (App.js bunlara güvənir):
 *    - attachStream(url, meta)
 *    - pause()
 *    - resume()
 *    - destroy()
 * --------------------------------------------------------------------------
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

      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");
      audio.setAttribute("x-webkit-airplay", "allow");

      audio.style.position = "fixed";
      audio.style.opacity = "0";
      audio.style.pointerEvents = "none";
      audio.style.width = "1px";
      audio.style.height = "1px";
      audio.style.left = "0";
      audio.style.bottom = "0";

      document.body.appendChild(audio);

      window.__RY_NATIVE_AUDIO__ = audio;
    }

    this.audio = window.__RY_NATIVE_AUDIO__;
    this._wantPlaying = false;
    this._unlocked = false;

    this._setupUnlock();
    this._setupAudioEvents();
    this._setupMediaSession();
    this._setupVisibility();
  }

  _isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  _setupUnlock() {
    const unlock = async () => {
      if (this._unlocked) return;
      this._unlocked = true;

      try {
        const wasMuted = this.audio.muted;
        this.audio.muted = true;
        const p = this.audio.play();
        if (p && typeof p.then === "function") {
          await p.catch(() => {});
        }
        this.audio.pause();
        this.audio.muted = wasMuted;
      } catch {}

      document.removeEventListener("touchstart", unlock, true);
      document.removeEventListener("touchend", unlock, true);
      document.removeEventListener("click", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };

    document.addEventListener("touchstart", unlock, true);
    document.addEventListener("touchend", unlock, true);
    document.addEventListener("click", unlock, true);
    document.addEventListener("keydown", unlock, true);
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
    try {
      navigator.mediaSession.playbackState = state;
    } catch {}
  }

  _setupAudioEvents() {
    const a = this.audio;

    a.addEventListener("play", () => {
      window.__RY_WAS_PLAYING__ = true;
      this._wantPlaying = true;
      this._setPlaybackState("playing");
    });

    a.addEventListener("playing", () => {
      window.__RY_WAS_PLAYING__ = true;
      this._wantPlaying = true;
      this._setPlaybackState("playing");
      this._updatePositionState();
    });

    a.addEventListener("pause", () => {
      if (this._wantPlaying) {
        const p = this.audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } else {
        this._setPlaybackState("paused");
      }
    });

    a.addEventListener("ended", () => {
      this._wantPlaying = false;
      this._setPlaybackState("none");
    });

    a.addEventListener("loadedmetadata", () => this._updatePositionState());
    a.addEventListener("durationchange", () => this._updatePositionState());
    a.addEventListener("timeupdate", () => this._updatePositionState());
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
  }

  _setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    const safeSet = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    };

    safeSet("play", async () => {
      this._wantPlaying = true;
      try {
        await this.audio.play();
      } catch {}
      this._setPlaybackState("playing");
    });

    safeSet("pause", () => {
      this._wantPlaying = false;
      this.audio.pause();
      this._setPlaybackState("paused");
    });

    safeSet("stop", () => {
      this._wantPlaying = false;
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
      } catch {}
      this._setPlaybackState("none");
    });

    safeSet("seekbackward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      try {
        this.audio.currentTime = Math.max(
          0,
          (this.audio.currentTime || 0) - skip
        );
      } catch {}
      this._updatePositionState();
    });

    safeSet("seekforward", (details) => {
      const skip = (details && details.seekOffset) || 10;
      try {
        const dur = isFinite(this.audio.duration)
          ? this.audio.duration
          : Number.MAX_SAFE_INTEGER;
        this.audio.currentTime = Math.min(
          dur,
          (this.audio.currentTime || 0) + skip
        );
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
      } else {
        this._setPlaybackState(this.audio.paused ? "paused" : "playing");
      }
    };

    document.addEventListener("visibilitychange", reassert);
    window.addEventListener("pageshow", reassert);
    window.addEventListener("focus", reassert);

    window.addEventListener("pagehide", () => {
      if (this._wantPlaying) this._setPlaybackState("playing");
    });

    document.addEventListener("freeze", () => {
      if (this._wantPlaying) this._setPlaybackState("playing");
    });

    document.addEventListener("resume", reassert);
  }

  async attachStream(url, meta = {}) {
    if (!url) return false;

    try {
      this._wantPlaying = true;

      if (
        "mediaSession" in navigator &&
        typeof window.MediaMetadata !== "undefined"
      ) {
        try {
          navigator.mediaSession.metadata = new window.MediaMetadata({
            title: meta.title || "",
            artist: meta.artist || "",
            album: meta.album || "Ryhavean Spotify",
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

      // Direct googlevideo URLs: do NOT set crossOrigin (would block due to CORS).
      // For same-origin proxy URLs we also keep it unset → simplest path.
      try { this.audio.removeAttribute("crossorigin"); } catch {}

      if (this.audio.src !== url) {
        this.audio.src = url;
        try {
          this.audio.load();
        } catch {}
      }

      // Wait briefly for metadata to confirm stream is reachable
      const ready = await new Promise((resolve) => {
        let done = false;
        const onOk = () => { if (!done) { done = true; cleanup(); resolve(true); } };
        const onErr = () => { if (!done) { done = true; cleanup(); resolve(false); } };
        const cleanup = () => {
          this.audio.removeEventListener("loadedmetadata", onOk);
          this.audio.removeEventListener("canplay", onOk);
          this.audio.removeEventListener("error", onErr);
        };
        this.audio.addEventListener("loadedmetadata", onOk, { once: true });
        this.audio.addEventListener("canplay", onOk, { once: true });
        this.audio.addEventListener("error", onErr, { once: true });
        // Hard timeout — if nothing happens in 6s, treat as failure
        setTimeout(() => { if (!done) { done = true; cleanup(); resolve(false); } }, 6000);
      });

      if (!ready) {
        console.warn("audioManager: stream not reachable", url);
        return false;
      }

      try {
        await this.audio.play();
      } catch (e) {
        // Some iOS Safari versions reject play() until user gesture.
        // We'll let the existing unlock logic re-trigger on next tap.
        console.log("audio.play() rejected (will retry on gesture)", e?.name);
      }

      window.__RY_WAS_PLAYING__ = true;
      this._setPlaybackState("playing");
      this._updatePositionState();

      return true;
    } catch (e) {
      console.log("audioManager attach failed", e);
      return false;
    }
  }

  pause() {
    this._wantPlaying = false;
    window.__RY_WAS_PLAYING__ = false;
    this.audio.pause();
    this._setPlaybackState("paused");
  }

  resume() {
    this._wantPlaying = true;
    window.__RY_WAS_PLAYING__ = true;
    this._setPlaybackState("playing");
    return this.audio.play();
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
