/* Ryhavean — PWA UX v2.0
 * - Copy/selection blocker (except search inputs)
 * - iOS aggressive background audio keep-alive with auto-resume
 *   * Optimized for iOS Lock Screen & Control Center stability
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
  /* 3. SILENT AUDIO KEEP-ALIVE (Optimized for Lock Screen)      */
  /* ========================================================= */
  var SILENT_MP3_URL = "https://cdn.jsdelivr.net/gh/anars/blank-audio@master/5-seconds-of-silence.mp3";
  var SILENT_MP3_INLINE = "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////////////////////////////////////////////////////////////////////////////////////////8AAAAATGF2YzU3LjEwAAAAAAAAAAAAAAAAJAYAAAAAAAAAAnGMHkkIAAAAAP/7kGQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//uQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

  var silentAudio = null;
  var userWantsPlay = false;
  var lastKnownIframe = null;
  var heartbeatInterval = null;

  function ensureSilentAudio() {
    if (silentAudio) return silentAudio;
    try {
      silentAudio = document.createElement("audio");
      silentAudio.id = "ryhavean-silent-audio";
      silentAudio.src = SILENT_MP3_URL;
      silentAudio.loop = true;
      silentAudio.preload = "auto";
      silentAudio.setAttribute("playsinline", "true");
      silentAudio.setAttribute("webkit-playsinline", "true");
      silentAudio.volume = 0.05; 
      silentAudio.muted = false;
      silentAudio.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";

      silentAudio.addEventListener("error", function () {
        if (silentAudio.src !== SILENT_MP3_INLINE) {
          silentAudio.src = SILENT_MP3_INLINE;
          try { silentAudio.load(); } catch (e) {}
        }
      });

      // Prevention of 5s loop jumping in Control Center
      silentAudio.addEventListener("timeupdate", function() {
        if (silentAudio.currentTime > 4) {
          silentAudio.currentTime = 0.1;
        }
      });

      silentAudio.addEventListener("pause", function () {
        if (!userWantsPlay) return;
        setTimeout(function () {
          if (!userWantsPlay) return;
          var p = silentAudio.play();
          if (p && p.catch) p.catch(function () {});
        }, 100);
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
  /* 4. WEB AUDIO API CONTEXT KEEPER                             */
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
      gainNode.gain.value = 0.0001; 
      gainNode.connect(audioCtx.destination);
      oscillator = audioCtx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = 1;
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
  /* 5. YOUTUBE IFRAME AUTO-RESUME                               */
  /* ========================================================= */
  function findYouTubeIframe() {
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

  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data) return;
    try { if (typeof data === "string") data = JSON.parse(data); } catch (e) { return; }
    if (data && data.event === "onStateChange") {
      if (data.info === 1) {
        userWantsPlay = true;
        playSilent();
        resumeAudioContext();
      } else if (data.info === 2) {
        if (document.visibilityState === "hidden" && userWantsPlay) {
          setTimeout(function () { if (userWantsPlay) ytPlay(); }, 300);
        } else {
          userWantsPlay = false;
        }
      }
    }
  });

  /* ========================================================= */
  /* 6. HEARTBEAT — Master Nudge                                 */
  /* ========================================================= */
  function startHeartbeat() {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(function () {
      if (!userWantsPlay) return;
      if (silentAudio && silentAudio.paused) silentAudio.play().catch(function(){});
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(function(){});
      
      ytPlay();

      if (navigator.mediaSession && navigator.mediaSession.playbackState !== "playing") {
        navigator.mediaSession.playbackState = "playing";
      }
    }, 2000);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  }

  /* ========================================================= */
  /* 7. VISIBILITY / FOCUS / PAGESHOW                            */
  /* ========================================================= */
  function forceResume() {
    if (!userWantsPlay) return;
    resumeAudioContext();
    playSilent();
    var tries = 0;
    var retry = setInterval(function () {
      tries++;
      if (!userWantsPlay || tries > 6) { clearInterval(retry); return; }
      ytPlay();
    }, 400);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") forceResume();
    else if (userWantsPlay) { playSilent(); ytPlay(); }
  });

  window.addEventListener("pageshow", forceResume);
  window.addEventListener("focus", forceResume);

  /* ========================================================= */
  /* 8. FIRST-TAP UNLOCK                                         */
  /* ========================================================= */
  function unlockOnce() {
    ensureSilentAudio();
    ensureAudioContext();
    resumeAudioContext();
    playSilent();
    startHeartbeat();
    document.removeEventListener("touchend", unlockOnce, true);
    document.removeEventListener("click", unlockOnce, true);
  }
  document.addEventListener("touchend", unlockOnce, true);
  document.addEventListener("click", unlockOnce, true);

  /* ========================================================= */
  /* 9. MEDIASESSION ENHANCED HANDLERS                           */
  /* ========================================================= */
  setTimeout(function () {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaSessionMetadata({
        title: 'Ryhavean Music',
        artist: 'Streaming...',
        artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });

      if ('setPositionState' in navigator.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration: 999,
          playbackRate: 1,
          position: 0
        });
      }

      navigator.mediaSession.setActionHandler('play', function() {
        userWantsPlay = true;
        playSilent();
        resumeAudioContext();
        ytPlay();
      });
      navigator.mediaSession.setActionHandler('pause', function() {
        userWantsPlay = false;
        ytPause();
        if (silentAudio) silentAudio.pause();
      });
    } catch (e) {}
  }, 1000);

  /* ========================================================= */
  /* 10. WAKE LOCK                                               */
  /* ========================================================= */
  var wakeLock = null;
  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
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
    isStandalone:   IS_STANDALONE
  };

  if (document.readyState === "complete") startHeartbeat();
  else window.addEventListener("load", startHeartbeat);
})();
