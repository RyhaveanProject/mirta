/* Ryhavean — PWA UX v3.0 (iOS Background Audio Fix - Enhanced)
 * - Copy/selection blocker (except search inputs)
 * - iOS aggressive background audio keep-alive with auto-resume
 *   * Silent audio heartbeat + retry loop on pause
 *   * YouTube iframe postMessage auto-resume on visibility/focus
 *   * Web Audio API oscillator (inaudible) to keep AudioContext alive
 *   * MediaSession action chain for lock-screen play button
 *   * Wake Lock on non-iOS platforms
 *   * iOS specific: Short audio clip + loop hack for true background playback
 *
 * NO modifications required in App.js.
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
  // CRITICAL FIX: iOS requires a SHORT audio file that restarts quickly
  // when backgrounded. Longer files get suspended by iOS audio session.
  // Using a 0.5s silence that loops more aggressively.
  var SILENT_MP3_INLINE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

  var silentAudio = null;
  var userWantsPlay = false;
  var lastKnownIframe = null;
  var heartbeatInterval = null;
  var iosBackgroundLock = false; // Prevents recursive loops

  function ensureSilentAudio() {
    if (silentAudio && document.body.contains(silentAudio)) return silentAudio;
    try {
      // Remove old one if exists
      if (silentAudio && silentAudio.parentNode) {
        silentAudio.parentNode.removeChild(silentAudio);
      }
      silentAudio = document.createElement("audio");
      silentAudio.id = "ryhavean-silent-audio";
      silentAudio.src = SILENT_MP3_INLINE;
      silentAudio.loop = true;
      silentAudio.preload = "auto";
      silentAudio.setAttribute("playsinline", "true");
      silentAudio.setAttribute("webkit-playsinline", "true");
      // iOS CRITICAL: volume must be > 0 for audio to play in background
      silentAudio.volume = 0.01; // Very low but not zero
      silentAudio.muted = false;
      silentAudio.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0.01;pointer-events:none;";

      // iOS background pause recovery - more aggressive
      silentAudio.addEventListener("pause", function () {
        if (!userWantsPlay) return;
        if (iosBackgroundLock) return;
        iosBackgroundLock = true;
        
        setTimeout(function () {
          iosBackgroundLock = false;
          if (!userWantsPlay) return;
          // Reset and retry
          try {
            silentAudio.currentTime = 0;
            var p = silentAudio.play();
            if (p && p.catch) p.catch(function () {});
          } catch (e) {}
        }, 50);
      });

      silentAudio.addEventListener("ended", function () {
        if (userWantsPlay) {
          try {
            silentAudio.currentTime = 0;
            var p = silentAudio.play();
            if (p && p.catch) p.catch(function () {});
          } catch (e) {}
        }
      });

      // iOS error recovery
      silentAudio.addEventListener("error", function () {
        // Re-create audio element on error
        try {
          if (silentAudio && silentAudio.parentNode) {
            silentAudio.parentNode.removeChild(silentAudio);
          }
        } catch (e) {}
        silentAudio = null;
        setTimeout(ensureSilentAudio, 1000);
      });

      document.body.appendChild(silentAudio);
    } catch (e) {}
    return silentAudio;
  }

  function playSilent() {
    var a = ensureSilentAudio();
    if (!a) return false;
    try {
      a.currentTime = 0;
      var p = a.play();
      if (p && typeof p.then === "function") {
        p.catch(function () {});
      }
      return true;
    } catch (e) { return false; }
  }

  /* ========================================================= */
  /* 4. WEB AUDIO API CONTEXT KEEPER (extra iOS insurance)       */
  /* ========================================================= */
  var audioCtx = null;
  var oscillator = null;
  var gainNode = null;

  function ensureAudioContext() {
    if (audioCtx && audioCtx.state !== "closed") return audioCtx;
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
    if (!audioCtx || audioCtx.state === "closed") ensureAudioContext();
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

  // YouTube state tracking
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data) return;
    try {
      if (typeof data === "string") data = JSON.parse(data);
    } catch (e) { return; }
    
    if (data && data.event === "onStateChange") {
      if (data.info === 1) {
        userWantsPlay = true;
        playSilent();
        resumeAudioContext();
      } else if (data.info === 2) {
        // Only mark as paused if we're visible (user-initiated)
        if (document.visibilityState === "visible") {
          userWantsPlay = false;
        } else {
          // Background pause - restore in 500ms
          setTimeout(function () {
            if (document.visibilityState === "hidden" && userWantsPlay) {
              ytPlay();
            }
          }, 500);
        }
      }
    }
  });

  /* ========================================================= */
  /* 6. HEARTBEAT — iOS optimized                               */
  /* ========================================================= */
  function startHeartbeat() {
    if (heartbeatInterval) return;
    
    // iOS: More aggressive heartbeat (500ms instead of 1500ms)
    var interval = IS_IOS ? 800 : 1500;
    
    heartbeatInterval = setInterval(function () {
      if (!userWantsPlay) return;
      
      // Silent audio recovery
      if (silentAudio && silentAudio.paused) {
        try {
          silentAudio.currentTime = 0;
          var p = silentAudio.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
      
      // AudioContext recovery
      if (audioCtx && audioCtx.state === "suspended") {
        try { audioCtx.resume(); } catch (e) {}
      }
      
      // YouTube nudge
      ytPlay();
      
      // MediaSession keep-alive
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
  /* 7. VISIBILITY / FOCUS AUTO-RESUME                          */
  /* ========================================================= */
  function forceResume() {
    if (!userWantsPlay) return;
    
    resumeAudioContext();
    playSilent();
    
    // iOS: Multiple retries for YouTube (needs 3-4 attempts sometimes)
    var tries = 0;
    var retry = setInterval(function () {
      tries++;
      if (!userWantsPlay || tries > 8) { 
        clearInterval(retry); 
        return; 
      }
      ytPlay();
      // Also re-trigger silent audio on each attempt
      if (silentAudio && silentAudio.paused) {
        try {
          silentAudio.currentTime = 0;
          silentAudio.play().catch(function () {});
        } catch (e) {}
      }
    }, 300);
  }

  // Visibility change - THE KEY iOS EVENT
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      forceResume();
    } else {
      // Page is hidden - preemptively fire everything
      if (userWantsPlay) {
        playSilent();
        ytPlay();
        // Extra nudge for iOS
        setTimeout(function () {
          if (document.visibilityState === "hidden" && userWantsPlay) {
            playSilent();
            ytPlay();
          }
        }, 200);
      }
    }
  });

  window.addEventListener("pageshow", forceResume);
  window.addEventListener("focus", forceResume);
  window.addEventListener("online", forceResume);

  /* ========================================================= */
  /* 8. FIRST-USER-INTERACTION UNLOCK                           */
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
  /* 9. MEDIASESSION ENHANCED HANDLERS                          */
  /* ========================================================= */
  setTimeout(function () {
    if (!("mediaSession" in navigator)) return;
    try {
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
  /* 10. WAKE LOCK (Android + desktop)                          */
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
  /* 11. ZOOM & DOUBLE-TAP PREVENTION                          */
  /* ========================================================= */
  var lastTouchEnd = 0;
  document.addEventListener("touchend", function (e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300 && !isAllowed(e.target)) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

  /* ========================================================= */
  /* 12. PUBLIC API                                             */
  /* ========================================================= */
  window.RyhaveanAudio = {
    keepAliveStart: function () { 
      userWantsPlay = true; 
      startHeartbeat(); 
      playSilent();
      resumeAudioContext();
      ytPlay();
      return true;
    },
    keepAliveStop: function () { 
      userWantsPlay = false; 
      stopHeartbeat(); 
      if (silentAudio) { 
        try { silentAudio.pause(); } catch (e) {} 
      } 
    },
    requestWakeLock: acquireWakeLock,
    forceResume: function() {
      userWantsPlay = true;
      forceResume();
    },
    isIOS: IS_IOS,
    isStandalone: IS_STANDALONE,
    getState: function () {
      return {
        userWantsPlay: userWantsPlay,
        silentPaused: silentAudio ? silentAudio.paused : null,
        audioCtxState: audioCtx ? audioCtx.state : null,
        hasYTIframe: !!findYouTubeIframe(),
        visibility: document.visibilityState
      };
    }
  };

  // Auto-start heartbeat once page is ready
  if (document.readyState === "complete") {
    startHeartbeat();
  } else {
    window.addEventListener("load", startHeartbeat);
  }

  // Log for debugging
  console.log("[Ryhavean PWA UX v3.0] Loaded. iOS:", IS_IOS, "Standalone:", IS_STANDALONE);
})();
