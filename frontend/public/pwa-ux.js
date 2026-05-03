/* Ryhavean — PWA UX v4.0
 * - Copy/selection blocker
 * - iOS background audio keepalive (AudioContext oscillator)
 * - MediaSession lock-screen integration
 * - Wake Lock (non-iOS)
 * - Zoom prevention
 *
 * Designed to work with native <audio> element (NOT YouTube iframe).
 */
(function () {
  "use strict";

  /* ========================================================= */
  /* 1. COPY / SELECTION BLOCKER                               */
  /* ========================================================= */
  const ALLOW_SELECTORS = [
    'input[type="search"]', 'input[type="text"]', 'input[type="email"]',
    'input[type="password"]', 'input[type="url"]', 'input[type="tel"]',
    'input:not([type])', 'textarea',
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
    if ((e.ctrlKey || e.metaKey) && (low === "c" || low === "x" || low === "u" || low === "s" || low === "a")) {
      e.preventDefault();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (low === "i" || low === "j" || low === "c")) {
      e.preventDefault();
    }
    if (low === "f12") e.preventDefault();
  }, { capture: true });

  /* ========================================================= */
  /* 2. ENVIRONMENT DETECTION                                  */
  /* ========================================================= */
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                 (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 0);
  const IS_STANDALONE = window.navigator.standalone === true ||
                        window.matchMedia("(display-mode: standalone)").matches;

  /* ========================================================= */
  /* 3. SILENT AUDIO OSCILLATOR (background keepalive)         */
  /* ========================================================= */
  var audioCtx = null;
  var oscillator = null;
  var gainNode = null;

  function ensureAudioContext() {
    if (audioCtx) return;
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioCtx = new AudioCtx();
    } catch (e) {}
  }

  function resumeAudioContext() {
    if (!audioCtx) ensureAudioContext();
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") {
      try { audioCtx.resume(); } catch (e) {}
    }
  }

  function startOscillator() {
    if (!audioCtx) ensureAudioContext();
    if (!audioCtx) return;
    resumeAudioContext();
    try {
      if (oscillator) {
        try { oscillator.stop(); } catch (e) {}
        try { oscillator.disconnect(); } catch (e) {}
      }
      oscillator = audioCtx.createOscillator();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 0.001;
      oscillator.type = "sine";
      oscillator.frequency.value = 42;
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.start();
    } catch (e) {}
  }

  /* ========================================================= */
  /* 4. HEARTBEAT SYSTEM                                       */
  /* ========================================================= */
  var heartbeatInterval = null;
  var userWantsPlay = false;

  function startHeartbeat() {
    if (heartbeatInterval) return;
    var interval = IS_IOS ? 1000 : 3000;
    heartbeatInterval = setInterval(function () {
      if (!userWantsPlay) return;
      resumeAudioContext();
      if (!oscillator || !gainNode) startOscillator();
      try {
        if (navigator.mediaSession) {
          navigator.mediaSession.playbackState = "playing";
        }
      } catch (e) {}
    }, interval);
  }

  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  /* ========================================================= */
  /* 5. VISIBILITY HANDLER                                     */
  /* ========================================================= */
  function forceResume() {
    if (!userWantsPlay) return;
    resumeAudioContext();
    document.querySelectorAll("audio").forEach(function (audio) {
      if (!audio.paused && audio.readyState >= 2) {
        try {
          if (audio.context && audio.context.state === "suspended") {
            audio.context.resume();
          }
        } catch (e) {}
      }
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") forceResume();
  });
  window.addEventListener("pageshow", forceResume);
  window.addEventListener("focus", forceResume);

  /* ========================================================= */
  /* 6. FIRST-USER-INTERACTION UNLOCK                          */
  /* ========================================================= */
  function unlockOnce() {
    ensureAudioContext();
    resumeAudioContext();
    startOscillator();
    startHeartbeat();
    document.removeEventListener("touchend", unlockOnce, true);
    document.removeEventListener("click", unlockOnce, true);
    document.removeEventListener("keydown", unlockOnce, true);
  }
  document.addEventListener("touchend", unlockOnce, true);
  document.addEventListener("click", unlockOnce, true);
  document.addEventListener("keydown", unlockOnce, true);

  /* ========================================================= */
  /* 7. WAKE LOCK (non-iOS)                                    */
  /* ========================================================= */
  var wakeLock = null;
  async function acquireWakeLock() {
    if (IS_IOS) return;
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
  /* 8. ZOOM PREVENTION                                        */
  /* ========================================================= */
  var lastTouchEnd = 0;
  document.addEventListener("touchend", function (e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300 && !isAllowed(e.target)) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

  /* ========================================================= */
  /* 9. PUBLIC API                                             */
  /* ========================================================= */
  window.RyhaveanAudio = {
    keepAliveStart: function () {
      userWantsPlay = true;
      startHeartbeat();
      resumeAudioContext();
      startOscillator();
      return true;
    },
    keepAliveStop: function () {
      userWantsPlay = false;
      stopHeartbeat();
      if (oscillator) {
        try { oscillator.stop(); } catch (e) {}
        try { oscillator.disconnect(); } catch (e) {}
        oscillator = null;
      }
    },
    requestWakeLock: acquireWakeLock,
    isIOS: IS_IOS,
    isStandalone: IS_STANDALONE,
  };

  if (document.readyState === "complete") {
    startHeartbeat();
  } else {
    window.addEventListener("load", startHeartbeat);
  }

  console.log("[Ryhavean PWA UX v4.0] Loaded. iOS:", IS_IOS, "Standalone:", IS_STANDALONE);
})();
