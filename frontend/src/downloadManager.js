// src/downloadManager.js
// ----------------------------------------------------------------------------
// Ryhavean Download Manager
// ----------------------------------------------------------------------------
//  - Capacitor (native iOS/Android) mühitində mahnını cihaz yaddaşına yazır
//    (Filesystem plugin, Directory.Data) və Preferences plugin-i ilə metadata
//    saxlayır.
//  - Web brauzerdə isə Cache Storage API + IndexedDB ilə eyni interfeysi
//    təmin edir (PWA offline işləməsi üçün).
//
//  Public API (App.js bu funksiyalara güvənir):
//    - downloadSong(song, opts)      → mahnını endir
//    - getDownloads()                → endirilmiş mahnıların siyahısı
//    - removeDownload(id)            → endirilmişi sil
//    - getOfflineUrl(id)             → offline çalmaq üçün URL (blob: və ya file://)
//    - isDownloaded(id)              → boolean
//    - onProgress(cb), offProgress(cb)
// ----------------------------------------------------------------------------

const BACKEND_URL = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");

// Capacitor pluginlərini lazy import: web build üçün də işləməlidir
let Filesystem = null;
let Directory = null;
let Preferences = null;
let Capacitor = null;

const loadCap = async () => {
  if (Capacitor) return Capacitor;
  try {
    const core = await import("@capacitor/core");
    Capacitor = core.Capacitor;
    if (Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
      const fs = await import("@capacitor/filesystem");
      Filesystem = fs.Filesystem;
      Directory = fs.Directory;
      const pref = await import("@capacitor/preferences");
      Preferences = pref.Preferences;
    }
  } catch {
    // Capacitor mövcud deyil — web mode
  }
  return Capacitor;
};

const META_KEY = "ryhavean_downloads_v1";
const DB_NAME = "ryhavean_offline";
const DB_STORE = "songs";

const isNative = () =>
  Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform();

// ---------- Metadata storage ----------
async function readMeta() {
  await loadCap();
  if (isNative()) {
    const { value } = await Preferences.get({ key: META_KEY });
    if (!value) return [];
    try { return JSON.parse(value); } catch { return []; }
  }
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function writeMeta(list) {
  await loadCap();
  const json = JSON.stringify(list);
  if (isNative()) {
    await Preferences.set({ key: META_KEY, value: json });
  } else {
    try { localStorage.setItem(META_KEY, json); } catch {}
  }
}

// ---------- IndexedDB (web) ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(id, blob) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(blob, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const r = tx.objectStore(DB_STORE).get(id);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}
async function idbDel(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---------- Progress event bus ----------
const _listeners = new Set();
function emitProgress(payload) {
  _listeners.forEach((cb) => { try { cb(payload); } catch {} });
}
export function onProgress(cb) { _listeners.add(cb); }
export function offProgress(cb) { _listeners.delete(cb); }

// ---------- Helpers ----------
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result || "";
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function fetchWithProgress(url, songId) {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status}`);
  }
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    emitProgress({
      id: songId,
      received,
      total,
      pct: total ? Math.min(99, Math.round((received / total) * 100)) : null,
    });
  }
  const contentType = res.headers.get("content-type") || "audio/mp4";
  return new Blob(chunks, { type: contentType });
}

// ---------- Public API ----------
export async function downloadSong(song, opts = {}) {
  if (!song || !song.id) throw new Error("song.id required");
  await loadCap();

  const meta = await readMeta();
  if (meta.find((m) => m.id === song.id)) {
    return { ok: true, alreadyDownloaded: true };
  }

  const url = `${BACKEND_URL}/api/audio/${song.id}`;
  emitProgress({ id: song.id, pct: 0, received: 0, total: 0 });

  const blob = await fetchWithProgress(url, song.id);
  const ext = (blob.type.includes("mpeg") ? "mp3" : "m4a");
  const filename = `${song.id}.${ext}`;

  if (isNative()) {
    const base64 = await blobToBase64(blob);
    await Filesystem.writeFile({
      path: `ryhavean/${filename}`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
  } else {
    await idbPut(song.id, blob);
  }

  const entry = {
    id: song.id,
    title: song.title || "",
    artist: song.artist || "",
    duration: song.duration || 0,
    thumbnail: song.thumbnail || "",
    filename,
    mime: blob.type,
    size: blob.size,
    downloaded_at: new Date().toISOString(),
  };
  await writeMeta([entry, ...meta.filter((m) => m.id !== song.id)]);

  emitProgress({ id: song.id, pct: 100, received: blob.size, total: blob.size, done: true });
  return { ok: true, entry };
}

export async function getDownloads() {
  return await readMeta();
}

export async function isDownloaded(id) {
  const meta = await readMeta();
  return meta.some((m) => m.id === id);
}

export async function removeDownload(id) {
  await loadCap();
  const meta = await readMeta();
  const entry = meta.find((m) => m.id === id);
  if (!entry) return { ok: true, removed: false };

  try {
    if (isNative()) {
      await Filesystem.deleteFile({
        path: `ryhavean/${entry.filename}`,
        directory: Directory.Data,
      });
    } else {
      await idbDel(id);
    }
  } catch {}
  await writeMeta(meta.filter((m) => m.id !== id));
  return { ok: true, removed: true };
}

// Returns a URL playable by HTMLAudioElement (blob: on web, capacitor:// or file:// on native)
export async function getOfflineUrl(id) {
  await loadCap();
  const meta = await readMeta();
  const entry = meta.find((m) => m.id === id);
  if (!entry) return null;

  if (isNative()) {
    const r = await Filesystem.getUri({
      path: `ryhavean/${entry.filename}`,
      directory: Directory.Data,
    });
    // Capacitor.convertFileSrc → http(s)://localhost/_capacitor_file_/...
    if (Capacitor && typeof Capacitor.convertFileSrc === "function") {
      return Capacitor.convertFileSrc(r.uri);
    }
    return r.uri;
  }
  const blob = await idbGet(id);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

const api = {
  downloadSong, getDownloads, isDownloaded,
  removeDownload, getOfflineUrl, onProgress, offProgress,
};
export default api;
