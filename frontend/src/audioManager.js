// src/audioManager.js

/**
 * RyAudioManager
 * --------------------------------------------------------------------------
 *  iOS-da arxa plana və ya kilid ekranına düşdükdə musiqinin dayanmaması
 *  üçün hazırlanmış manager. App-i tamamilə bağlayanda iOS bütün audio
 *  session-u dayandırır (bu sistem davranışıdır), amma app yalnız arxa
 *  plana keçəndə (home button / safari ikonu / kilid ekranı) çalmağa
 *  davam edir.
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

      // iOS-da inline / arxa plan səsi üçün vacibdir.
      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");
      audio.setAttribute("x-webkit-airplay", "allow");

      // QEYD: crossOrigin="anonymous" QƏSDƏN qoyulmayıb.
      // iOS WebKit CORS bayraqlı media element-ləri "remote media" kimi
      // tanımır və arxa plana keçəndə audio session-u dərhal dayandırır.
      // Bu, iOS-da arxa planda çalmamağın əsas səbəblərindəndir.

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
    this._lastMeta = {};
    this._reassertTimer = null;

    this._setupUnlock();
    this._setupAudioEvents();
    this._setupMediaSession();
    this._setupVisibility();
  }

  _isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
    );
  }

  /**
   * iOS-da audio element-i yalnız user gesture daxilində ilk dəfə
   * play() etdikdə "active media session" qazanır. Buna görə ilk
   * touch/click anında səssiz şəkildə audio-nu prime edirik.
   */
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
      // Əgər istifadəçi (yaxud pause()) qəsdən pauz edibsə,
      // _wantPlaying artıq false-dur və biz bir şey etmirik.
      // Əgər biz hələ də çalmaq istəyiriksə (məs. iOS arxa
      // planda spurious pause atıb), dərhal davam etdirməyə
      // çalışırıq.
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

    a.addEventListener("loadedmetadata", () => {
      this._updatePositionState();
    });

    a.addEventListener("durationchange", () => {
      this._updatePositionState();
    });

    a.addEventListener("timeupdate", () => {
      this._updatePositionState();
    });

    a.addEventListener("seeked", () => {
      this._updatePositionState();
    });

    // Şəbəkə buferi tükənəndə iOS bəzən pauz atır — yenidən başlat.
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
      } catch {
        /* not supported */
      }
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
        if (
          details.fastSeek &&
          typeof this.audio.fastSeek === "function"
        ) {
          this.audio.fastSeek(details.seekTime);
        } else {
          this.audio.currentTime = details.seekTime;
        }
      } catch {}
      this._updatePositionState();
    });
  }

  /**
   * iOS PWA arxa plana keçəndə `visibilitychange`, `pagehide`, `freeze`
   * event-lərini atır. Bu anlarda mediaSession.playbackState-i yenidən
   * "playing" kimi təyin etmək, audio session-un OS tərəfindən "yaşayan"
   * sayılmasını və beləliklə kilid ekranında çalmağa davam etməsini
   * təmin edir.
   */
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

    document.addEventListener("visibilitychange", () => {
      reassert();
    });

    window.addEventListener("pageshow", reassert);
    window.addEventListener("focus", reassert);

    // iOS Safari arxa plana keçəndə `pagehide` və `freeze` atır.
    // Burada playbackState="playing" qoymaq sistemə audio session-un
    // hələ də aktiv olduğunu söyləyir.
    window.addEventListener("pagehide", () => {
      if (this._wantPlaying) {
        this._setPlaybackState("playing");
      }
    });

    document.addEventListener("freeze", () => {
      if (this._wantPlaying) {
        this._setPlaybackState("playing");
      }
    });

    document.addEventListener("resume", reassert);
  }

  async attachStream(url, meta = {}) {
    if (!url) return false;

    try {
      this._lastMeta = meta || {};
      this._wantPlaying = true;

      if (this.audio.src !== url) {
        this.audio.src = url;
        try {
          this.audio.load();
        } catch {}
      }

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

      await this.audio.play();

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
