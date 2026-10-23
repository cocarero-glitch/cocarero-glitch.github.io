// IndexedDB storage. Audio is stored as ArrayBuffer (most reliable on iOS Safari).
const DB_NAME = 'context-recorder';
const DB_VERSION = 1;
const STORE = 'recordings';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Recording shape:
 * { id, createdAt, updatedAt, title, durationMs, mimeType, audio:ArrayBuffer|null,
 *   transcript, transcriptSource:'webspeech'|'manual'|'whisper', memo, people:[], themes:[],
 *   summary:null|string, ai:{} }  */
export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}
export const put = rec => tx('readwrite', s => { rec.updatedAt = Date.now(); s.put(rec); return rec; });
export const get = id => tx('readonly', s => reqP(s.get(id)));
export const remove = id => tx('readwrite', s => { s.delete(id); });
export const all = () => tx('readonly', s => reqP(s.getAll())).then(list => list.sort((a, b) => b.createdAt - a.createdAt));
/** Metadata only (no audio) – lighter for list rendering. */
export async function allMeta() {
  const list = await all();
  return list.map(({ audio, ...m }) => ({ ...m, hasAudio: !!audio, audioBytes: audio ? audio.byteLength : 0 }));
}
export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
export async function estimate() {
  try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch {}
  return null;
}
