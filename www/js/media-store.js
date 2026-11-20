/* OndaMedia — artwork as real files.
 *
 * Album covers, artist photos and artist logos are written once to the app's data folder
 * (onda-img/) and referenced by a stable URL. Result:
 *   • nothing has to be read back out of IndexedDB / decoded into blob: URLs at launch
 *   • the same URLs work in the saved start-screen snapshot (the app paints before any code has run)
 *   • the media notification gets a plain file path (no re-encoding per track)
 * In a plain browser (no Capacitor) it falls back to in-memory object URLs.
 */
(function (g) {
  'use strict';
  const Cap = g.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const DIR = 'onda-img';
  const plugin = n => { try { return (Cap.Plugins && Cap.Plugins[n]) || (Cap.registerPlugin && Cap.registerPlugin(n)); } catch (e) { return null; } };
  const FS = isNative ? plugin('Filesystem') : null;
  let base = '';                    // file:// uri of the folder
  let ok = false;

  const b64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  function hash(s) {                // 53-bit string hash → short base36 id
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const Media = {
    available: false,
    hash,
    async init() {
      if (!FS) return false;
      try {
        try { await FS.mkdir({ path: DIR, directory: 'DATA', recursive: true }); } catch (e) { /* exists */ }
        const r = await FS.getUri({ path: DIR, directory: 'DATA' });
        base = r.uri.replace(/\/+$/, '');
        ok = true;
      } catch (e) { console.warn('media store unavailable', e); ok = false; }
      Media.available = ok;
      return ok;
    },
    /** file:// uri (what the native player reads) */
    fileUri(name) { return ok && name ? base + '/' + name : ''; },
    /** URL the WebView can show in an <img> */
    url(name) { return ok && name ? Cap.convertFileSrc(base + '/' + name) : ''; },
    /** Writes `blob` as `<prefix>_<hash>_<time>.<ext>`; resolves the file name (or '' when it can't be stored). */
    async save(prefix, id, blob, ext) {
      if (!ok || !blob) return '';
      const name = prefix + '_' + hash(String(id)) + '_' + Date.now().toString(36) + '.' + (ext || 'jpg');
      try {
        await FS.writeFile({ path: DIR + '/' + name, directory: 'DATA', data: await b64(blob) });
        return name;
      } catch (e) { console.warn('media write failed', e); return ''; }
    },
    async remove(name) {
      if (!ok || !name) return;
      try { await FS.deleteFile({ path: DIR + '/' + name, directory: 'DATA' }); } catch (e) { /* ignore */ }
    },
    async clear() {
      if (!ok) return;
      try { await FS.rmdir({ path: DIR, directory: 'DATA', recursive: true }); } catch (e) { /* ignore */ }
      try { await FS.mkdir({ path: DIR, directory: 'DATA', recursive: true }); } catch (e) { /* ignore */ }
    },
    extFor(blob) { return blob && /png/.test(blob.type) ? 'png' : (blob && /webp/.test(blob.type) ? 'webp' : 'jpg'); },
  };
  g.OndaMedia = Media;
})(window);
