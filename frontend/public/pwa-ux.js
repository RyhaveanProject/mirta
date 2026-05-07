/* Ryhavean — PWA UX v5.0 (iOS background-safe)
 *
 * CRITICAL iOS NOTE:
 * ------------------
 * Earlier versions used Web Audio API / AudioContext with an oscillator
 * as a "keep-alive". On iOS this BACKFIRES: once an AudioContext exists,
 * iOS may route the page's audio session through Web Audio, and iOS
 * SUSPENDS AudioContext whenever the tab goes background — which kills
 * playback.
 *
 * The native <audio> element (used by RyAudioManager) plays in background
 * by itself when properly configured. So we REMOVE AudioContext entirely
 * and only handle UX concerns here (copy blocker, wake lock on non-iOS,
 * zoom prevention).
 */
(function () {
  "use strict";

  /* ========== 1. COPY / SELECTION BLOCKER ========== */
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
    if ((e.ctrlKey || e.metaKey) && (low === "c" || low === "x" || low === "u" || low === "s" || low === "a")) e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (low === "i" || low === "j" || low === "c")) e.preventDefault();
    if (low === "f12") e.preventDefault();
  }, { capture: true });

  /* ========== 2. ENVIRONMENT DETECTION ========== */
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                 (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 0);
  const IS_STANDALONE = window.navigator.standalone === true ||
                        window.matchMedia("(display-mode: standalone)").matches;

  /* ========== 3. WAKE LOCK (non-iOS only) ========== */
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

  /* ========== 4. ZOOM PREVENTION ========== */
  var lastTouchEnd = 0;
  document.addEventListener("touchend", function (e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300 && !isAllowed(e.target)) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

  /* ========== 5. PUBLIC API (legacy-compat no-ops for iOS) ========== */
  window.RyhaveanAudio = {
    keepAliveStart: function () { return true; },
    keepAliveStop:  function () {},
    requestWakeLock: acquireWakeLock,
    isIOS: IS_IOS,
    isStandalone: IS_STANDALONE,
  };

  console.log("[Ryhavean PWA UX v5.0] Loaded. iOS:", IS_IOS, "Standalone:", IS_STANDALONE);
})();
