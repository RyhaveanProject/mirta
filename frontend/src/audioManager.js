// src/audioManager.js

class RyAudioManager {
  constructor() {
    if (typeof window === "undefined") return;

    if (!window.__RY_NATIVE_AUDIO__) {
      const audio = document.createElement("audio");

      audio.id = "ry-native-audio";
      audio.preload = "auto";
      audio.crossOrigin = "anonymous";

      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");

      audio.style.position = "fixed";
      audio.style.opacity = "0";
      audio.style.pointerEvents = "none";
      audio.style.width = "1px";
      audio.style.height = "1px";

      document.body.appendChild(audio);

      window.__RY_NATIVE_AUDIO__ = audio;
    }

    this.audio = window.__RY_NATIVE_AUDIO__;

    this.keepAliveInterval = null;

    this.setupIOS();
    this.setupMediaSession();
  }

  setupIOS() {
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !window.MSStream;

    if (!isIOS) return;

    const unlock = async () => {
      try {
        await this.audio.play();
        this.audio.pause();
      } catch {}

      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("click", unlock);
    };

    document.addEventListener("touchstart", unlock);
    document.addEventListener("click", unlock);

    document.addEventListener("visibilitychange", async () => {
      if (
        document.visibilityState === "visible" &&
        window.__RY_WAS_PLAYING__
      ) {
        try {
          await this.audio.play();
        } catch {}
      }
    });
  }

  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", async () => {
      try {
        await this.audio.play();
      } catch {}
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      this.audio.pause();
    });
  }

  async attachStream(url, meta = {}) {
    if (!url) return false;

    try {
      if (this.audio.src !== url) {
        this.audio.src = url;
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || "",
        artist: meta.artist || "",
        album: "Ryhavean Spotify",
        artwork: meta.thumbnail
          ? [
              {
                src: meta.thumbnail,
                sizes: "512x512",
                type: "image/jpeg",
              },
            ]
          : [],
      });

      await this.audio.play();

      window.__RY_WAS_PLAYING__ = true;

      this.startKeepAlive();

      return true;
    } catch (e) {
      console.log("audioManager attach failed", e);
      return false;
    }
  }

  startKeepAlive() {
    this.stopKeepAlive();

    this.keepAliveInterval = setInterval(async () => {
      try {
        if (
          this.audio.paused &&
          window.__RY_WAS_PLAYING__
        ) {
          await this.audio.play();
        }
      } catch {}
    }, 2000);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  pause() {
    window.__RY_WAS_PLAYING__ = false;
    this.audio.pause();
  }

  resume() {
    window.__RY_WAS_PLAYING__ = true;
    return this.audio.play();
  }

  destroy() {
    this.stopKeepAlive();

    try {
      this.audio.pause();
      this.audio.src = "";
    } catch {}
  }
}

const instance = new RyAudioManager();

export default instance;
