/* Ryhavean PWA Registration & Install Helpers */
(function () {
  "use strict";
  var API = (window.RyhaveanPWA = window.RyhaveanPWA || {});
  var deferredPrompt = null;
  var updateCallback = null;

  API.isStandalone = function () {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
           window.navigator.standalone === true;
  };

  API.onUpdateReady = function (cb) { updateCallback = cb; };

  API.promptInstall = function () {
    if (!deferredPrompt) return Promise.resolve(false);
    deferredPrompt.prompt();
    return deferredPrompt.userChoice.then(function (choice) {
      deferredPrompt = null;
      return choice && choice.outcome === "accepted";
    });
  };

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent("ryhavean:installable"));
  });

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    window.dispatchEvent(new CustomEvent("ryhavean:installed"));
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/service-worker.js", { scope: "/" })
        .then(function (reg) {
          setInterval(function () { try { reg.update(); } catch (e) {} }, 60 * 60 * 1000);
          reg.addEventListener("updatefound", function () {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener("statechange", function () {
              if (nw.state === "installed" && navigator.serviceWorker.controller) {
                if (typeof updateCallback === "function") {
                  updateCallback(function () { nw.postMessage("SKIP_WAITING"); });
                } else {
                  nw.postMessage("SKIP_WAITING");
                }
              }
            });
          });
        })
        .catch(function (err) { console.warn("[Ryhavean PWA] SW registration failed:", err); });

      var refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    });
  }

  if (API.isStandalone()) {
    document.addEventListener("click", function (e) {
      var el = e.target;
      while (el && el.tagName !== "A") el = el.parentElement;
      if (!el) return;
      var href = el.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;
      if (el.target === "_blank") return;
      if (el.hasAttribute("download")) return;
      try {
        var url = new URL(href, window.location.href);
        if (url.origin === window.location.origin) {
          e.preventDefault();
          window.location.href = url.href;
        }
      } catch (err) {}
    });
  }
})();
