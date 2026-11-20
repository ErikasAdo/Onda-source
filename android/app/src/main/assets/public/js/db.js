/* OndaDB — tiny IndexedDB wrapper.
 *   tracks : persisted library (metadata + cover Blob + native file path)
 *   art    : album artwork records ({key, file|blob, colors, source, locked})
 *   artists: artist photo / logo files ({key, name, thumb, logo, invert})
 *   meta   : API cache (MusicBrainz / CAA / Fanart / Last.fm) with TTL */
(function (g) {
  'use strict';
  const DB_NAME = 'onda', VERSION = 3;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('art')) db.createObjectStore('art', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('artists')) db.createObjectStore('artists', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }

  function run(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let req;
      try { req = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  g.OndaDB = {
    putTrack: rec => run('tracks', 'readwrite', s => s.put(rec)),
    /** many records in one transaction (fast for big libraries) */
    putTracks: recs => open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('tracks', 'readwrite'); const s = t.objectStore('tracks');
      recs.forEach(r => s.put(r));
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    })),
    deleteTracks: ids => open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('tracks', 'readwrite'); const s = t.objectStore('tracks');
      ids.forEach(id => s.delete(id));
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    })),
    /** album artwork, keyed by album key: { key, blob, source, locked } (locked = user-chosen, never auto-replaced) */
    putArt: rec => run('art', 'readwrite', s => s.put(rec)),
    allArt: () => run('art', 'readonly', s => s.getAll()).then(r => r || []),
    clearArt: () => run('art', 'readwrite', s => s.clear()),
    deleteArt: key => run('art', 'readwrite', s => s.delete(key)),
    putArtists: recs => open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('artists', 'readwrite'); const s = t.objectStore('artists');
      recs.forEach(r => s.put(r));
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    })),
    allArtists: () => run('artists', 'readonly', s => s.getAll()).then(r => r || []),
    clearArtists: () => run('artists', 'readwrite', s => s.clear()),
    allTracks: () => run('tracks', 'readonly', s => s.getAll()).then(r => r || []),
    deleteTrack: id => run('tracks', 'readwrite', s => s.delete(id)),
    clearTracks: () => run('tracks', 'readwrite', s => s.clear()),

    /** resolves `undefined` on miss/expired, otherwise the stored value (which may be null = negative cache) */
    async metaGet(key) {
      const rec = await run('meta', 'readonly', s => s.get(key));
      if (!rec) return undefined;
      if (rec.exp && rec.exp < Date.now()) return undefined;
      return rec.value;
    },
    metaSet: (key, value, ttlMs) => run('meta', 'readwrite', s => s.put({ key, value, exp: Date.now() + (ttlMs || 0) })),
    // keys starting with "keep|" (your Last.fm history) are never part of a cache clear
    async clearMeta() {
      let keep = [];
      try { const all = await run('meta', 'readonly', s => s.getAll()); keep = (all || []).filter(r => r && String(r.key).startsWith('keep|')); } catch (e) { /* ignore */ }
      await run('meta', 'readwrite', s => s.clear());
      for (const r of keep) await run('meta', 'readwrite', s => s.put(r));
    },
  };
})(window);
