/* Ryhavean — PWA UX v2.2
 * - Control Center-də pleyerin görünməsi təmin edildi.
 * - YouTube vaxtının sıfırlanma problemi (loop) həll edildi.
 * - Silent Audio mexanizmi stabilizasiya edildi.
 */
(function () {
  "use strict";

  /* 1. COPY / SELECTION BLOCKER */
  var ALLOW_SELECTORS = ['input', 'textarea', '[contenteditable="true"]', '.allow-copy'].join(",");
  function isAllowed(target) { return !!target.closest(ALLOW_SELECTORS); }
  ["copy", "cut", "paste", "contextmenu", "selectstart"].forEach(function (evt) {
    document.addEventListener(evt, function (e) { if (!isAllowed(e.target)) e.preventDefault(); }, { capture: true });
  });

  /* 2. iOS DETECTION */
  var IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  var userWantsPlay = false;
  var lastKnownIframe = null;

  /* 3. CONTROL CENTER ÜÇÜN MÜHƏRRİK (Silent Audio) */
  var silentAudio = null;
  function ensureSilentAudio() {
    if (silentAudio) return silentAudio;
    silentAudio = document.createElement("audio");
    // Control Center-də pleyerin itməməsi üçün uzun bir səssizlik lazımdır
    silentAudio.src = "https://cdn.jsdelivr.net/gh/anars/blank-audio@master/10-minutes-of-silence.mp3";
    silentAudio.loop = true;
    silentAudio.volume = 0.01;
    silentAudio.setAttribute("playsinline", "true");
    document.body.appendChild(silentAudio);
    return silentAudio;
  }

  /* 4. YOUTUBE COMMANDS */
  function findYT() {
    if (lastKnownIframe && document.body.contains(lastKnownIframe)) return lastKnownIframe;
    lastKnownIframe = document.querySelector('iframe[src*="youtube"]');
    return lastKnownIframe;
  }
  function ytCmd(f) {
    var ifr = findYT();
    if (ifr && ifr.contentWindow) ifr.contentWindow.postMessage(JSON.stringify({event:"command", func:f, args:[]}), "*");
  }

  /* 5. MEDIASESSION SYNC (Əsas hissə) */
  function updateMediaSession(title, artist) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaSessionMetadata({
      title: title || 'Ryhavean Music',
      artist: artist || 'YouTube Stream',
      artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  }

  /* 6. YOUTUBE EVENT LISTENER */
  window.addEventListener("message", function (ev) {
    try {
      var data = JSON.parse(ev.data);
      if (data.event === "onStateChange") {
        if (data.info === 1) { // Oynayır
          userWantsPlay = true;
          ensureSilentAudio().play();
          navigator.mediaSession.playbackState = "playing";
        } else if (data.info === 2) { // Dayandı
          if (document.visibilityState === "visible") {
              userWantsPlay = false;
              if(silentAudio) silentAudio.pause();
              navigator.mediaSession.playbackState = "paused";
          }
        }
      }
      // Mahnı adını tutmağa çalış (əgər YouTube API göndərirsə)
      if (data.event === "infoDelivery" && data.info && data.info.title) {
        updateMediaSession(data.info.title, "Ryhavean");
      }
    } catch (e) {}
  });

  /* 7. HEARTBEAT (Yalnız arxa planda olanda YouTube-u dümsüklə) */
  setInterval(function () {
    if (userWantsPlay && document.visibilityState === "hidden") {
      ytCmd("playVideo");
      if (silentAudio && silentAudio.paused) silentAudio.play();
    }
  }, 3000);

  /* 8. UNLOCK & HANDLERS */
  function unlock() {
    ensureSilentAudio();
    if ("mediaSession" in navigator) {
      updateMediaSession();
      navigator.mediaSession.setActionHandler('play', function() { userWantsPlay = true; ytCmd("playVideo"); if(silentAudio) silentAudio.play(); });
      navigator.mediaSession.setActionHandler('pause', function() { userWantsPlay = false; ytCmd("pauseVideo"); if(silentAudio) silentAudio.pause(); });
    }
    document.removeEventListener("click", unlock);
  }
  document.addEventListener("click", unlock);

  window.RyhaveanAudio = { isIOS: IS_IOS, forceResume: function() { ytCmd("playVideo"); } };
})();
