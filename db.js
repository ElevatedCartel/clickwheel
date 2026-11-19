// Tiny promise wrapper over IndexedDB.
// Stores: tracks (metadata), audio (song/video data), art (cover blobs), playlists.

const NAME = 'clickwheel';
const VERSION = 1;
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('tracks', { keyPath: 'id' });
      d.createObjectStore('audio');
      d.createObjectStore('art');
      d.createObjectStore('playlists', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      // iOS closes the connection when the app sits in the background; reopen on next use.
      d.onclose = () => { opening = null; };
      d.onversionchange = () => { d.close(); opening = null; };
      resolve(d);
    };
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}

function attempt(d, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode); // throws if the connection was closed under us
    let result;
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function run(store, mode, fn) {
  try {
    return await attempt(await open(), store, mode, fn);
  } catch (err) {
    if (err?.name === 'QuotaExceededError') throw err;
    // Stale or lost connection ("Connection to Indexed Database server lost"): reconnect once.
    opening = null;
    return attempt(await open(), store, mode, fn);
  }
}

export const db = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
};
