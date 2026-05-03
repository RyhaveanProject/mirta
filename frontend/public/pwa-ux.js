/* Ryhavean — PWA UX v2.1
 * - Arxa planda YouTube-un dayanmaması üçün optimizasiya edilib.
 * - Silent Audio ləğv edildi (Control Center-dəki problemi həll edir).
 * - Web Audio API Oscillator ilə səs kanalı aktiv saxlanılır.
 */
(function () {
  "use strict";

  /* 1. COPY / SELECTION BLOCKER */
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

  /* 2. iOS DETECTION */
  var IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  var userWantsPlay = false;
  var lastKnownIframe = null;
  var heartbeatInterval = null;

  /* 3. WEB AUDIO API KEEPER (Silent Audio-nu əvəz edir) */
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
      gainNode.gain.value = 0.001; // İnadible səs
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

  /* 4. YOUTUBE IFRAME CONTROL */
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

  /* 5. HEARTBEAT (Sürət azaldıldı ki, pleyer titrəməsin) */
  function startHeartbeat() {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(function () {
      if (!userWantsPlay) return;
      resumeAudioContext();
      // Arxa planda YouTube-u yoxla və davam etdir
      if (document.visibilityState === "hidden") {
         ytPlay();
      }
    }, 3000); 
  }

  /* 6. VISIBILITY / FOCUS */
  function forceResume() {
    if (!userWantsPlay) return;
    resumeAudioContext();
    ytPlay();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") forceResume();
  });

  /* 7. FIRST-TAP UNLOCK */
  function unlockOnce() {
    ensureAudioContext();
    resumeAudioContext();
    startHeartbeat();
    document.removeEventListener("touchend", unlockOnce, true);
    document.removeEventListener("click", unlockOnce, true);
  }
  document.addEventListener("touchend", unlockOnce, true);
  document.addEventListener("click", unlockOnce, true);

  /* 8. MEDIASESSION (YouTube pleyerini Control Center-ə bağlayır) */
  setTimeout(function () {
    if (!("mediaSession" in navigator)) return;
    
    // Youtube dövlətini dinləmək üçün
    window.addEventListener("message", function(ev) {
        try {
            var data = JSON.parse(ev.data);
            if (data.event === "onStateChange") {
                if (data.info === 1) { // Playing
                    userWantsPlay = true;
                    navigator.mediaSession.playbackState = "playing";
                } else if (data.info === 2) { // Paused
                    if (document.visibilityState === "visible") userWantsPlay = false;
                    navigator.mediaSession.playbackState = "paused";
                }
            }
        } catch(e) {}
    });

    navigator.mediaSession.setActionHandler('play', function() {
      userWantsPlay = true;
      resumeAudioContext();
      ytPlay();
    });
    navigator.mediaSession.setActionHandler('pause', function() {
      userWantsPlay = false;
      ytPause();
    });
  }, 1000);

  /* 9. PUBLIC API */
  window.RyhaveanAudio = {
    keepAliveStart: function () { userWantsPlay = true; startHeartbeat(); },
    keepAliveStop:  function () { userWantsPlay = false; if (heartbeatInterval) clearInterval(heartbeatInterval); },
    forceResume:    forceResume,
    isIOS:          IS_IOS
  };

  if (document.readyState === "complete") startHeartbeat();
  else window.addEventListener("load", startHeartbeat);
})();
