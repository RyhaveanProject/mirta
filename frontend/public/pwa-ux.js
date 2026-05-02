/* Ryhavean — PWA UX: copy-block + iOS background audio keep-alive */
(function () {
  "use strict";

  /* ========== 1. Copy / selection blocker ========== */
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

  document.addEventListener("touchstart", function () {}, { passive: true });

  document.addEventListener("keydown", function (e) {
    var k = e.key || "";
    var low = k.toLowerCase();
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

  /* ========== 2. iOS / Safari background audio keep-alive ========== */
  var SILENT_SRC = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwP///////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//sQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDEDQPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDEDQPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX=";

  var silentAudio = null;
  function ensureSilentAudio() {
    if (silentAudio) return silentAudio;
    try {
      silentAudio = document.createElement("audio");
      silentAudio.id = "ryhavean-silent-audio";
      silentAudio.src = SILENT_SRC;
      silentAudio.loop = true;
      silentAudio.preload = "auto";
      silentAudio.setAttribute("playsinline", "true");
      silentAudio.setAttribute("webkit-playsinline", "true");
      silentAudio.crossOrigin = "anonymous";
      silentAudio.volume = 0.001;
      silentAudio.muted = false;
      silentAudio.style.display = "none";
      document.body.appendChild(silentAudio);
    } catch (e) {}
    return silentAudio;
  }

  function unlockOnce() {
    var a = ensureSilentAudio();
    if (!a) return;
    var p = a.play();
    if (p && typeof p.catch === "function") p.catch(function () {});
    document.removeEventListener("touchend", unlockOnce, true);
    document.removeEventListener("click", unlockOnce, true);
    document.removeEventListener("keydown", unlockOnce, true);
  }
  document.addEventListener("touchend", unlockOnce, true);
  document.addEventListener("click", unlockOnce, true);
  document.addEventListener("keydown", unlockOnce, true);

  window.RyhaveanAudio = window.RyhaveanAudio || {};
  window.RyhaveanAudio.keepAliveStart = function () {
    var a = ensureSilentAudio();
    if (!a) return Promise.resolve(false);
    var p = a.play();
    if (p && typeof p.then === "function") return p.then(function () { return true; }).catch(function () { return false; });
    return Promise.resolve(true);
  };
  window.RyhaveanAudio.keepAliveStop = function () {
    if (silentAudio) { try { silentAudio.pause(); } catch (e) {} }
  };

  var wakeLock = null;
  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) {}
  }
  window.RyhaveanAudio.requestWakeLock = acquireWakeLock;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && wakeLock === null) acquireWakeLock();
  });

  var lastTouchEnd = 0;
  document.addEventListener("touchend", function (e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300 && !isAllowed(e.target)) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
})();
