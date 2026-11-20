/* OndaNative — thin bridge to Capacitor plugins.
 *
 * The app is bundler-free vanilla JS, so plugins are reached through the Capacitor
 * runtime (`Capacitor.Plugins.X` / `registerPlugin('X')`) instead of ES imports.
 * Every call is guarded: the same code runs in a normal browser for UI development. */
(function (g) {
  'use strict';
  const Cap = g.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const platform = isNative && Cap.getPlatform ? Cap.getPlatform() : 'web';
  const LIB_DIR = 'onda';

  function plugin(name) {
    if (!isNative) return null;
    try {
      if (typeof Cap.isPluginAvailable === 'function' && !Cap.isPluginAvailable(name)) return null;   // not installed → no-op
      if (Cap.Plugins && Cap.Plugins[name]) return Cap.Plugins[name];
      if (typeof Cap.registerPlugin === 'function') return Cap.registerPlugin(name);
    } catch (e) { /* ignore */ }
    return null;
  }

  const Haptics = plugin('Haptics');
  const StatusBar = plugin('StatusBar');
  const FilePicker = plugin('FilePicker');
  const FS = plugin('Filesystem');
  const MediaSession = plugin('MediaSession'); // optional (see README)
  const Lib = platform === 'android' ? plugin('OndaLibrary') : null; // MediaStore scan (native/android/OndaLibraryPlugin.java)
  const Player = platform === 'android' ? plugin('OndaPlayer') : null; // foreground playback service (OndaPlayerPlugin.java)
  const artCache = new WeakMap();

  const blobToB64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  const blobToDataURL = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  let libBase = null;
  const Native = {
    isNative, platform,

    /* ── lifecycle ─────────────────────────────────────────────────────────── */
    async init() {
      if (!isNative) return;
      // status bar: fire and forget (never block startup on it)
      try { if (StatusBar) { StatusBar.setStyle({ style: 'DARK' }).catch(() => {}); if (platform === 'android') StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {}); } } catch (e) { /* ignore */ }
      try {
        if (FS) {
          FS.rmdir({ path: 'art', directory: 'CACHE', recursive: true }).catch(() => {});
          try { await FS.mkdir({ path: LIB_DIR, directory: 'DATA', recursive: true }); } catch (e) { /* exists */ }
          const r = await FS.getUri({ path: LIB_DIR, directory: 'DATA' });
          libBase = r.uri.replace(/\/+$/, '');
        }
      } catch (e) { console.warn('Filesystem init failed', e); }
    },

    /* ── device music library (Android MediaStore) ─────────────────────────── */
    hasLibrary: !!Lib,
    lib: {
      async check() { try { return !!(await Lib.checkPermission()).granted; } catch (e) { return false; } },
      async request() { try { return !!(await Lib.requestPermission()).granted; } catch (e) { return false; } },
      async scan() { const r = await Lib.scan(); return (r && r.tracks) || []; },
      async remove(uris) { return await Lib.deleteTracks({ uris }); },
      /** writes ID3 tags into the real files: [{ uri, title, artist, album, albumArtist, genre, track, trackTotal, disc, discTotal, year }] */
      async tag(items) { return await Lib.tagTracks({ items }); },
      /** backup export: opens Android's "save as" dialog → { saved, cancelled } */
      async shareFiles(uris, title) { return Lib ? Lib.shareFiles({ uris, title: title || '' }).then(() => true).catch(() => false) : Promise.resolve(false); },
      async saveText(name, text) { return await Lib.saveText({ name, text }); },
      /** fires (debounced, native side) when songs are added / deleted / re-tagged on the phone */
      onChange(cb) { try { if (Lib && Lib.addListener) Lib.addListener('libraryChanged', cb); } catch (e) { /* ignore */ } },
      /** embedded cover of a file as a Blob (or null) */
      async art(uri, max) {
        try {
          const r = await Lib.getArt({ uri, max: max || 0 });
          if (!r || !r.data) return null;
          const bin = atob(r.data), arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const type = arr[0] === 0x89 ? 'image/png' : 'image/jpeg';
          return new Blob([arr], { type });
        } catch (e) { return null; }
      },
    },

    /** Re-encode an image Blob as a JPEG no larger than `max` px (keeps the library small & fast). */
    async downscale(blob, max) {
      max = max || 640;
      try {
        const bmp = await createImageBitmap(blob);
        const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
        if (k === 1 && blob.size < 300 * 1024) { if (bmp.close) bmp.close(); return blob; }
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        if (bmp.close) bmp.close();
        return await new Promise(res => c.toBlob(b => res(b || blob), 'image/jpeg', 0.86));
      } catch (e) { return blob; }
    },

    /* ── notification permission (Android 13+) — without it the media notification is hidden ── */
    async ensureNotifications() {
      if (!Player) return true;
      try {
        if ((await Player.checkNotifications()).granted) return true;
        if (localStorage.getItem('pl_notif_asked') === '1') return false;
        localStorage.setItem('pl_notif_asked', '1');
        return !!(await Player.requestNotifications()).granted;
      } catch (e) { return false; }
    },
    async notificationsGranted() {
      if (!Player) return true;
      try { return !!(await Player.checkNotifications()).granted; } catch (e) { return true; }
    },

    /** Album art as a small JPEG file in the cache dir (the media notification shows it). Cached per Blob. */
    artUri(track) {
      if (track && track.artFile && g.OndaMedia && g.OndaMedia.available) return Promise.resolve(g.OndaMedia.fileUri(track.artFile));   // already a file: nothing to write
      const b = track && track.artBlob;
      if (!b || !FS) return Promise.resolve('');
      if (artCache.has(b)) return artCache.get(b);
      const p = (async () => {
        const small = b.size > 250 * 1024 ? await Native.downscale(b, 512) : b;   // stored art is already small
        const data = await blobToB64(small);
        const name = 'art/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + '.jpg';
        await FS.writeFile({ path: name, directory: 'CACHE', data, recursive: true });
        return (await FS.getUri({ path: name, directory: 'CACHE' })).uri;
      })().catch(() => '');
      artCache.set(b, p);
      return p;
    },

    /* ── earphone balance (native per-ear gain) ───────────────────────────── */
    balance: {
      available: !!Player,
      async supported() { try { return !!(Player && (await Player.getBalanceSupport()).supported); } catch (e) { return false; } },
      /** db < 0 boosts the LEFT ear by |db|, db > 0 boosts the RIGHT ear by db (0 = off) */
      async set(db) {
        if (!Player) return;
        const g = Math.pow(10, Math.abs(db) / 20);
        try { await Player.setBalance({ left: db < 0 ? g : 1, right: db > 0 ? g : 1 }); } catch (e) { /* ignore */ }
      },
    },
    /* ── audio page: force audio focus + album-finished ding ─────────────── */
    audioOpts: {
      set(o) { if (!Player) return Promise.resolve(); return Player.setAudioOptions({ force: !!o.force, ding: !!o.ding }).catch(() => {}); },
      ding() { if (!Player) return Promise.resolve(); return Player.playDing().catch(() => {}); },
    },
    /* ── lyrics section loop (seconds in, handled by the player service so it is exact and survives a locked screen) ── */
    loop: {
      available: !!Player,
      set(a, b) { if (!Player) return Promise.resolve(); return Player.setLoop({ start: Math.round(a * 1000), end: Math.round(b * 1000) }).catch(() => {}); },
      clear() { if (!Player) return Promise.resolve(); return Player.setLoop({ start: 0, end: 0 }).catch(() => {}); },
    },
    /* ── equalizer (native player service) ────────────────────────────────── */
    eq: {
      available: !!Player,
      async supported() { try { return !!(Player && (await Player.getEqSupport()).supported); } catch (e) { return false; } },
      /** state: { on, gains[10] (dB), pre (dB) } — applies instantly, also while playing */
      set(state) {
        if (!Player) return Promise.resolve();
        return Player.setEq({ enabled: !!state.on, gains: state.gains, preamp: state.pre || 0 }).catch(() => {});
      },
    },
    /** attach artwork to a queued item after the fact (notification updates without interrupting playback) */
    async setArtwork(id, artUri) { if (Player && artUri) { try { await Player.setArtwork({ id, artUri }); } catch (e) { /* ignore */ } } },

    /* ── haptics ───────────────────────────────────────────────────────────── */
    // style: 'LIGHT' | 'MEDIUM' | 'HEAVY'  (== ImpactStyle.Light etc.)
    haptic(style) {
      if (!Haptics) return;
      try { Haptics.impact({ style: style || 'LIGHT' }); } catch (e) { /* ignore */ }
    },

    /* ── file picking / library storage ────────────────────────────────────── */
    /** backup import: pick a .json → its text (or null when cancelled) */
    async pickBackupText() {
      if (!FilePicker) throw new Error('FilePicker plugin not available');
      const res = await FilePicker.pickFiles({ types: ['application/json', 'text/plain', 'application/octet-stream', '*/*'], limit: 1, readData: true });
      const f = res && res.files && res.files[0]; if (!f) return null;
      if (f.data) { const bin = atob(f.data), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new TextDecoder('utf-8').decode(arr); }
      if (f.blob) return await f.blob.text();
      if (f.path) return await (await fetch(Cap.convertFileSrc(f.path))).text();
      return null;
    },
    async pickAudioFiles() {
      if (!FilePicker) throw new Error('FilePicker plugin not available');
      const res = await FilePicker.pickFiles({ types: ['audio/*'], limit: 0, readData: false });
      return (res && res.files) || [];
    },

    /** Copies a picked file into the app's private storage (so it survives restarts) and returns the relative path. */
    async importFile(file, id) {
      if (!FS) throw new Error('Filesystem plugin not available');
      const m = /\.([a-z0-9]{2,5})$/i.exec(file.name || '');
      const rel = `${LIB_DIR}/${id}.${m ? m[1].toLowerCase() : 'mp3'}`;
      try {
        await FS.copy({ from: file.path, to: rel, toDirectory: 'DATA' });
        return rel;
      } catch (e1) {
        // content:// URIs on some Android pickers can't be copied directly → stream through the WebView
        const blob = await (await fetch(Cap.convertFileSrc(file.path))).blob();
        await Native._writeBlob(rel, blob);
        return rel;
      }
    },
    async _writeBlob(rel, blob) {
      const CH = 3 * 512 * 1024; // multiple of 3 → clean base64 boundaries
      for (let off = 0, first = true; off < blob.size; off += CH, first = false) {
        const data = await blobToB64(blob.slice(off, off + CH));
        await FS.writeFile(first ? { path: rel, directory: 'DATA', data } : { path: rel, directory: 'DATA', data, append: true });
      }
    },
    /** relative path → native file:// URI. (Absolute paths change when iOS re-installs the app, so we store relative ones.) */
    uriFor(rel) { return libBase ? libBase + '/' + rel.split('/').pop() : ''; },
    /** URI usable by <img>/<audio>/fetch inside the WebView */
    webSrc(uri) { return Cap.convertFileSrc(uri); },
    async deleteLibraryFiles() {
      if (!FS) return;
      try { await FS.rmdir({ path: LIB_DIR, directory: 'DATA', recursive: true }); } catch (e) { /* ignore */ }
      try { await FS.mkdir({ path: LIB_DIR, directory: 'DATA', recursive: true }); } catch (e) { /* ignore */ }
    },
    async deleteFile(rel) {
      if (!FS) return;
      try { await FS.deleteFile({ path: rel, directory: 'DATA' }); } catch (e) { /* ignore */ }
    },

    /** First ~3 MB of a stored file as a Blob (enough for the ID3 tag + cover) */
    async headBlob(uri, bytes) {
      const res = await fetch(Native.webSrc(uri), { headers: { Range: 'bytes=0-' + ((bytes || 3 * 1024 * 1024) - 1) } });
      const blob = await res.blob();
      return blob.size > (bytes || 3 * 1024 * 1024) ? blob.slice(0, bytes || 3 * 1024 * 1024) : blob;
    },
    probeDuration(src) {
      return new Promise(resolve => {
        const a = new Audio();
        a.preload = 'metadata';
        const done = d => { clearTimeout(timer); a.removeAttribute('src'); try { a.load(); } catch (e) { /* ignore */ } resolve(d); };
        const timer = setTimeout(() => done(0), 4000);
        a.addEventListener('loadedmetadata', () => done(isFinite(a.duration) ? a.duration : 0));
        a.addEventListener('error', () => done(0));
        a.src = src;
      });
    },

    /* ── lock-screen / notification controls (optional plugin) ─────────────── */
    initMediaSession(h) {
      if (!MediaSession) return;
      const set = (action, fn) => { try { MediaSession.setActionHandler({ action }, fn); } catch (e) { /* ignore */ } };
      set('play', () => h.play());
      set('pause', () => h.pause());
      set('nexttrack', () => h.next());
      set('previoustrack', () => h.prev());
      set('seekto', d => { if (d && d.seekTime != null) h.seek(d.seekTime); });
    },
    async nowPlaying(track, albumName) {
      if (!MediaSession || !track) return;
      try {
        const meta = { title: track.title, artist: track.artist, album: albumName || track.album || '' };
        if (track.artBlob) {
          if (!track._artData) track._artData = await blobToDataURL(track.artBlob);
          meta.artwork = [{ src: track._artData, sizes: '512x512', type: track.artBlob.type || 'image/jpeg' }];
        }
        await MediaSession.setMetadata(meta);
      } catch (e) { /* ignore */ }
    },
    setPlaybackState(playing) {
      if (!MediaSession) return;
      try { MediaSession.setPlaybackState({ playbackState: playing ? 'playing' : 'paused' }); } catch (e) { /* ignore */ }
    },
    setPosition(duration, position) {
      if (!MediaSession || !duration) return;
      try { MediaSession.setPositionState({ duration, position: Math.min(position || 0, duration), playbackRate: 1 }); } catch (e) { /* ignore */ }
    },
  };

  g.OndaNative = Native;
})(window);
