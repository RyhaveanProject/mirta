/* Ryhavean — PWA UX v2.0
 * - Copy/selection blocker (except search inputs)
 * - iOS aggressive background audio keep-alive with auto-resume
 *   * Silent audio heartbeat + retry loop on pause
 *   * YouTube iframe postMessage auto-resume on visibility/focus
 *   * Web Audio API oscillator (inaudible) to keep AudioContext alive
 *   * MediaSession action chain for lock-screen play button
 *   * Wake Lock on non-iOS platforms
 *
 * NO modifications required in App.js. This script detects the existing
 * YouTube iframe rendered by the app and controls it via postMessage.
 */
(function () {
  "use strict";

  /* ========================================================= */
  /* 1. COPY / SELECTION BLOCKER                                 */
  /* ========================================================= */
  var ALLOW_SELECTORS = [
    'input[type="search"]', 'input[type="text"]', 'input[type="email"]',
    'input[type="password"]', 'input[type="url"]', 'input[type="tel"]',
    'input[type="number"]', 'input:not([type])', 'textarea',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[data-allow-copy="true"]', '.allow-copy', '.allow-copy *'
  ].join(",");

  function isAllowed(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(ALLOW_SELECTORS);
  }

  ["copy", "cut", "paste"].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      if (!isAllowed(e.target)) e.preventDefault();
    }, { capture: true });
  });

  document.addEventListener("contextmenu", function (e) {
    if (!isAllowed(e.target)) e.preventDefault();
  }, { capture: true });

  document.addEventListener("selectstart", function (e) {
    if (!isAllowed(e.target)) e.preventDefault();
  }, { capture: true });

  document.addEventListener("keydown", function (e) {
    var low = (e.key || "").toLowerCase();
    if (isAllowed(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && (low === "c" || low === "x" || low === "a")) {
      e.preventDefault();
    }
  }, { capture: true });

  try {
    var style = document.createElement("style");
    style.setAttribute("data-ryhavean", "ux");
    style.textContent =
      'html, body { -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none; -webkit-touch-callout: none; } ' +
      'input, textarea, [contenteditable=""], [contenteditable="true"], .allow-copy, .allow-copy * { -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default !important; } ' +
      'img, a { -webkit-user-drag: none; user-drag: none; } ' +
      '@supports (-webkit-touch-callout: none) { body { -webkit-touch-callout: none; } }';
    document.head.appendChild(style);
  } catch (e) {}

  /* ========================================================= */
  /* 2. iOS DETECTION                                            */
  /* ========================================================= */
  var ua = navigator.userAgent || "";
  var IS_IOS = /iPad|iPhone|iPod/.test(ua) ||
               (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var IS_STANDALONE = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
                      window.navigator.standalone === true;

  /* ========================================================= */
  /* 3. SILENT AUDIO KEEP-ALIVE (heartbeat + retry)              */
  /* ========================================================= */
  // 30 seconds of real silence MP3 (base64) — longer = better for iOS
  // This is a valid MPEG audio with 30s of silence. Looping it keeps
  // iOS's media session permanently claimed by our page.
  var SILENT_MP3_URL = "https://cdn.jsdelivr.net/gh/anars/blank-audio@master/5-seconds-of-silence.mp3";
  // Fallback: short inline silence if CDN fails
  var SILENT_MP3_INLINE = "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////////////////////////////////////////////////////////////////////////////////////////8AAAAATGF2YzU3LjEwAAAAAAAAAAAAAAAAJAYAAAAAAAAAAnGMHkkIAAAAAP/7kGQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//uQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

  var silentAudio = null;
  var userWantsPlay = false;       // tracked via MediaSession & iframe state
  var lastKnownIframe = null;
  var heartbeatInterval = null;

  function ensureSilentAudio() {
    if (silentAudio) return silentAudio;
    try {
      silentAudio = document.createElement("audio");
      silentAudio.id = "ryhavean-silent-audio";
      // Try CDN first; if it fails, browser falls back to inline src via error handler
      silentAudio.src = SILENT_MP3_URL;
      silentAudio.loop = true;
      silentAudio.preload = "auto";
      silentAudio.crossOrigin = "anonymous";
      silentAudio.setAttribute("playsinline", "true");
      silentAudio.setAttribute("webkit-playsinline", "true");
      silentAudio.volume = 0.001; // effectively silent but NOT muted (iOS requires)
      silentAudio.muted = false;
      silentAudio.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";

      silentAudio.addEventListener("error", function () {
        // Fallback to inline data URI
        if (silentAudio.src !== SILENT_MP3_INLINE) {
          silentAudio.src = SILENT_MP3_INLINE;
          try { silentAudio.load(); } catch (e) {}
        }
      });

      // CRITICAL: if silent audio pauses, retry immediately (only if user intent = play)
      silentAudio.addEventListener("pause", function () {
        if (!userWantsPlay) return;
        // iOS sometimes auto-pauses — force resume
        setTimeout(function () {
          if (!userWantsPlay) return;
          var p = silentAudio.play();
          if (p && p.catch) p.catch(function () {});
        }, 100);
      });

      silentAudio.addEventListener("ended", function () {
        // Shouldn't happen with loop=true, but belt-and-suspenders
        if (userWantsPlay) {
          try { silentAudio.currentTime = 0; silentAudio.play().catch(function () {}); } catch (e) {}
        }
      });

      document.body.appendChild(silentAudio);
    } catch (e) {}
    return silentAudio;
  }

  function playSilent() {
    var a = ensureSilentAudio();
    if (!a) return Promise.resolve(false);
    try {
      var p = a.play();
      if (p && typeof p.then === "function") {
        return p.then(function () { return true; }).catch(function () { return false; });
      }
      return Promise.resolve(true);
    } catch (e) { return Promise.resolve(false); }
  }

  /* ========================================================= */
  /* 4. WEB AUDIO API CONTEXT KEEPER (extra iOS insurance)       */
  /* ========================================================= */
  var audioCtx = null;
  var oscillator = null;
  var gainNode = null;

  function ensureAudioContext() {
    if (audioCtx) return audioCtx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 0.0001; // inaudible
      gainNode.connect(audioCtx.destination);
      oscillator = audioCtx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = 1; // 1 Hz, below hearing
      oscillator.connect(gainNode);
      oscillator.start(0);
    } catch (e) { audioCtx = null; }
    return audioCtx;
  }

  function resumeAudioContext() {
    if (!audioCtx) ensureAudioContext();
    if (audioCtx && audioCtx.state === "suspended") {
      try { audioCtx.resume(); } catch (e) {}
    }
  }

  /* ========================================================= */
  /* 5. YOUTUBE IFRAME AUTO-RESUME (the magic part)              */
  /* ========================================================= */
  function findYouTubeIframe() {
    // Cache first
    if (lastKnownIframe && document.body.contains(lastKnownIframe)) return lastKnownIframe;
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      var src = iframes[i].src || "";
      if (/youtube\.com\/embed|youtube-nocookie\.com\/embed/.test(src)) {
        lastKnownIframe = iframes[i];
        return iframes[i];
      }
    }
    return null;
  }

  function sendYTCommand(func, args) {
    var iframe = findYouTubeIframe();
    if (!iframe || !iframe.contentWindow) return false;
    try {
      var msg = JSON.stringify({ event: "command", func: func, args: args || [] });
      iframe.contentWindow.postMessage(msg, "*");
      return true;
    } catch (e) { return false; }
  }

  function ytPlay()  { return sendYTCommand("playVideo"); }
  function ytPause() { return sendYTCommand("pauseVideo"); }

  // Listen to YouTube iframe state events (sent via postMessage)
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data) return;
    try {
      if (typeof data === "string") data = JSON.parse(data);
    } catch (e) { return; }
    // YouTube sends { event: "onStateChange", info: 1=playing, 2=paused, 0=ended }
    if (data && data.event === "onStateChange") {
      if (data.info === 1) {
        userWantsPlay = true;
        playSilent();
        resumeAudioContext();
      } else if (data.info === 2) {
        // Paused — but if page was hidden, this is likely involuntary on iOS
        if (document.visibilityState === "hidden" && userWantsPlay) {
          // Try to resume after a tick
          setTimeout(function () { if (userWantsPlay) ytPlay(); }, 300);
        } else {
          // Genuine user pause
          userWantsPlay = false;
        }
      }
    }
    if (data && data.event === "infoDelivery" && data.info && typeof data.info.playerState !== "undefined") {
      if (data.info.playerState === 1) userWantsPlay = true;
    }
  });

  // Also watch MediaSession state (App.js sets this)
  var msPollInterval = setInterval(function () {
    try {
      var s = navigator.mediaSession && navigator.mediaSession.playbackState;
      if (s === "playing") userWantsPlay = true;
      else if (s === "paused") {
        if (document.visibilityState === "visible") userWantsPlay = false;
      }
    } catch (e) {}
  }, 1000);

  /* ========================================================= */
  /* 6. HEARTBEAT — keeps everything alive while backgrounded   */
  /* ========================================================= */
  function startHeartbeat() {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(function () {
      if (!userWantsPlay) return;
      // 1. Keep silent audio rolling
      if (silentAudio && silentAudio.paused) {
        var p = silentAudio.play();
        if (p && p.catch) p.catch(function () {});
      }
      // 2. Keep AudioContext alive
      if (audioCtx && audioCtx.state === "suspended") {
        try { audioCtx.resume(); } catch (e) {}
      }
      // 3. Nudge YouTube iframe
      ytPlay();
      // 4. Re-assert MediaSession state so iOS lock-screen stays claimed
      try {
        if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
      } catch (e) {}
    }, 1500);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  }

  /* ========================================================= */
  /* 7. VISIBILITY / FOCUS / PAGESHOW AUTO-RESUME                */
  /* ========================================================= */
  function forceResume() {
    if (!userWantsPlay) return;
    resumeAudioContext();
    playSilent();
    // Retry YouTube a few times (iOS sometimes needs multiple nudges)
    var tries = 0;
    var retry = setInterval(function () {
      tries++;
      if (!userWantsPlay || tries > 6) { clearInterval(retry); return; }
      ytPlay();
    }, 400);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      forceResume();
    } else {
      // Just went hidden — fire silent audio extra hard to claim session
      if (userWantsPlay) {
        playSilent();
        ytPlay();
      }
    }
  });

  window.addEventListener("pageshow", forceResume);
  window.addEventListener("focus", forceResume);
  window.addEventListener("online", forceResume);

  /* ========================================================= */
  /* 8. FIRST-TAP UNLOCK (iOS autoplay gate)                     */
  /* ========================================================= */
  function unlockOnce() {
    ensureSilentAudio();
    ensureAudioContext();
    resumeAudioContext();
    playSilent();
    startHeartbeat();
    document.removeEventListener("touchend", unlockOnce, true);
    document.removeEventListener("click", unlockOnce, true);
    document.removeEventListener("keydown", unlockOnce, true);
  }
  document.addEventListener("touchend", unlockOnce, true);
  document.addEventListener("click", unlockOnce, true);
  document.addEventListener("keydown", unlockOnce, true);

  /* ========================================================= */
  /* 9. MEDIASESSION ENHANCED HANDLERS                           */
  /* ========================================================= */
  // Wait for App.js to set up its MediaSession handlers, then augment
  setTimeout(function () {
    if (!("mediaSession" in navigator)) return;
    try {
      // Preserve original handlers by wrapping — but simpler: just set
      // additional wake/resume logic via the "play" handler.
      // App.js sets play handler; we complement by also resuming silent.
      var origSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = function (action, handler) {
        if (action === "play" && typeof handler === "function") {
          var wrapped = function () {
            userWantsPlay = true;
            playSilent();
            resumeAudioContext();
            ytPlay();
            try { handler(); } catch (e) {}
          };
          origSetActionHandler(action, wrapped);
        } else if (action === "pause" && typeof handler === "function") {
          var wrappedPause = function () {
            // Don't set userWantsPlay=false immediately; lock-screen pause
            // followed by play should work. We'll let message listener decide.
            try { handler(); } catch (e) {}
          };
          origSetActionHandler(action, wrappedPause);
        } else {
          origSetActionHandler(action, handler);
        }
      };
    } catch (e) {}
  }, 500);

  /* ========================================================= */
  /* 10. WAKE LOCK (Android + desktop)                           */
  /* ========================================================= */
  var wakeLock = null;
  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", function () { wakeLock = null; });
      }
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && wakeLock === null) acquireWakeLock();
  });

  /* ========================================================= */
  /* 11. ZOOM & DOUBLE-TAP PREVENTION                            */
  /* ========================================================= */
  var lastTouchEnd = 0;
  document.addEventListener("touchend", function (e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300 && !isAllowed(e.target)) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

  /* ========================================================= */
  /* 12. PUBLIC API                                              */
  /* ========================================================= */
  window.RyhaveanAudio = {
    keepAliveStart: function () { userWantsPlay = true; startHeartbeat(); return playSilent(); },
    keepAliveStop:  function () { userWantsPlay = false; stopHeartbeat(); if (silentAudio) { try { silentAudio.pause(); } catch (e) {} } },
    requestWakeLock: acquireWakeLock,
    forceResume:    forceResume,
    isIOS:          IS_IOS,
    isStandalone:   IS_STANDALONE,
    getState:       function () {
      return {
        userWantsPlay: userWantsPlay,
        silentPaused: silentAudio ? silentAudio.paused : null,
        audioCtxState: audioCtx ? audioCtx.state : null,
        hasYTIframe: !!findYouTubeIframe(),
        visibility: document.visibilityState
      };
    }
  };

  // Auto-start heartbeat once page is loaded
  if (document.readyState === "complete") {
    startHeartbeat();
  } else {
    window.addEventListener("load", startHeartbeat);
  }
})();
