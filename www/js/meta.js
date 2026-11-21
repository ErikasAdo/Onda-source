/* OndaMeta — online metadata.
 *
 *   MusicBrainz        release / artist lookup (1 request per 1.1 s, as MB requires)
 *   Cover Art Archive  album covers: every image of the release + other editions of the album
 *   TheAudioDB         album art variants (cover, CD, 3D case…), artist bio, photos, facts  (free key, 30 req/min)
 *   Wikimedia Commons / Openverse   keyless image search (fallback for covers & artist photos)
 *   LRCLIB             synced (LRC) and plain lyrics
 *   Fanart.tv          optional extra artist images (only if FANART_KEY is set)
 *   Wikipedia          artist biography (intro, CC BY-SA), lead photo, link; album pages → cover candidates
 *   iTunes Search      high-resolution album covers (no key)
 *   Deezer             artist photos and album covers (no key)
 *
 * Network: inside the app everything goes through Capacitor's native HTTP client (no CORS, real
 * User-Agent). In a desktop browser it falls back to fetch(). If config.js has a PROXY_BASE, the
 * MusicBrainz / CAA / AudioDB / LRCLIB / Fanart calls go through your Cloudflare Worker instead.
 * Everything is cached in IndexedDB; "not found" is cached too so we don't re-ask every launch. */
(function (g) {
  'use strict';
  const CFG = g.ONDA_CONFIG || {};
  const Cap = g.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const DB = g.OndaDB;
  const DAY = 864e5;
  const UA = 'Onda/1.0.0 ( https://github.com/ErikasAdo/Onda-source )';
  /* ── the user's own keys / proxy (Settings → Own API keys & proxy). Stored only on this phone under "onda_custom",
        never in backups, never sent to the developer. When ON, Onda stops using the developer's server completely. ── */
  let OWN = null;
  try { const o = JSON.parse(g.localStorage.getItem('onda_custom') || 'null'); if (o && o.on === true) OWN = o; } catch (e) { OWN = null; }
  const ownKey = (k, min) => { const v = String(k || '').trim(); return new RegExp('^[A-Za-z0-9_-]{' + min + ',64}$').test(v) ? v : ''; };
  const ownUrl = u => { try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' && !x.username && !x.password && !x.search && !x.hash ? x.origin + x.pathname.replace(/\/+$/, '') : ''; } catch (e) { return ''; } };
  const OWN_PROXY = OWN ? ownUrl(OWN.proxy) : '';
  const OWN_LFM = OWN ? ownKey(OWN.lastfm, 8) : '';
  const FANART_KEY = OWN ? ownKey(OWN.fanart, 8) : (CFG.FANART_KEY || '');
  const ADB_KEY = OWN ? (ownKey(OWN.audiodb, 3) || '123') : (CFG.AUDIODB_KEY || '123');
  const LFM_DIRECT = !!(OWN && OWN_LFM && !OWN_PROXY);   // your own Last.fm key, straight to Last.fm
  const PROXY = OWN ? OWN_PROXY : (/^https?:\/\//.test(CFG.PROXY_BASE || '') && !/YOUR-SUBDOMAIN/.test(CFG.PROXY_BASE) ? CFG.PROXY_BASE.replace(/\/+$/, '') : '');
  const LFM = OWN ? OWN_PROXY : (/^https?:\/\//.test(CFG.LASTFM_BASE || CFG.UNSPLASH_BASE || '') ? (CFG.LASTFM_BASE || CFG.UNSPLASH_BASE).replace(/\/+$/, '') : '');
  const UNS = OWN ? OWN_PROXY : (/^https?:\/\//.test(CFG.UNSPLASH_BASE || '') ? CFG.UNSPLASH_BASE.replace(/\/+$/, '') : '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let Http = null;
  if (isNative) {
    try { Http = (Cap.Plugins && Cap.Plugins.CapacitorHttp) || Cap.registerPlugin('CapacitorHttp'); } catch (e) { Http = null; }
  }

  /* ── endpoints ─────────────────────────────────────────────────────────── */
  const DIRECT = {
    mb: 'https://musicbrainz.org/ws/2/',
    caa: 'https://coverartarchive.org/',
    adb: 'https://www.theaudiodb.com/api/v1/json/' + ADB_KEY + '/',
    lrclib: 'https://lrclib.net/api/',
    fanart: 'https://webservice.fanart.tv/v3/',
  };
  function urlFor(kind, path) {
    if (PROXY) return PROXY + '/' + kind + '/' + path;
    if (kind === 'fanart' && !FANART_KEY && LFM) return LFM + '/fanart/' + path;     // the Worker holds the Fanart.tv key
    let u = DIRECT[kind] + path;
    if (kind === 'fanart') u += (u.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(FANART_KEY);
    return u;
  }
  const https = u => (u ? String(u).replace(/^http:\/\//i, 'https://') : u);


  /* ── per-install key (the Worker's "2FA"): registered once, HMAC-signed per minute ───────────── */
  const WORKER_ORIGINS = OWN ? [] : Array.from(new Set([PROXY, LFM, UNS].filter(Boolean).map(u => { try { return new URL(u).origin; } catch (e) { return ''; } }).filter(Boolean)));
  const isWorker = url => { for (let i = 0; i < WORKER_ORIGINS.length; i++) if (url.indexOf(WORKER_ORIGINS[i] + '/') === 0) return true; return false; };
  const LS = { get(k) { try { return g.localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { g.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }, del(k) { try { g.localStorage.removeItem(k); } catch (e) { /* ignore */ } } };
  const enc = new TextEncoder();
  const b64u = buf => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const KEY = { failAt: 0, rec: null, ck: null, open: false, pending: null, skew: 0, hdr: '', hdrAt: 0, blocked: false, regAt: 0 };
  try { const r = JSON.parse(LS.get('onda_key') || 'null'); if (r && r.id && r.secret) KEY.rec = r; } catch (e) { /* none */ }
  try { const b = JSON.parse(LS.get('onda_key_blocked') || 'null'); if (b && b.at && Date.now() - b.at < DAY) KEY.blocked = true; else if (b) LS.del('onda_key_blocked'); } catch (e) { /* none */ }
  KEY.regAt = parseInt(LS.get('onda_key_reg') || '0', 10) || 0;

  function keyEvent(type) { try { g.dispatchEvent(new CustomEvent('onda-key', { detail: type })); } catch (e) { /* ignore */ } }
  /** get (or create) this install's key. Resolves to a record, or null when the Worker runs open / is unreachable. */
  function ensureKey(force) {
    if (OWN || (!PROXY && !LFM && !UNS)) return Promise.resolve(null);
    if (KEY.open && !force) return Promise.resolve(null);
    if (KEY.blocked && !force) return Promise.resolve(null);
    if (KEY.rec && !force) return Promise.resolve(KEY.rec);
    if (KEY.pending) return KEY.pending;
    if (!force && Date.now() - KEY.failAt < 30e3) return Promise.resolve(null);   // just failed (offline?) — don't hammer /register
    KEY.pending = (async () => {
      try {
        const base = WORKER_ORIGINS[0];
        const r = await http(base + '/register', 'json', true);
        if (!r.ok) { KEY.failAt = Date.now(); return KEY.rec; }
        const d = r.data || {};
        if (d.open) { KEY.open = true; KEY.rec = null; KEY.ck = null; LS.del('onda_key'); return null; }
        if (!d.id || !d.secret) return KEY.rec;
        KEY.rec = { id: d.id, secret: d.secret }; KEY.ck = null; KEY.hdr = ''; KEY.open = false;
        if (d.now) KEY.skew = d.now * 1000 - Date.now();
        LS.set('onda_key', JSON.stringify(KEY.rec)); KEY.regAt = Date.now(); LS.set('onda_key_reg', String(KEY.regAt));
        return KEY.rec;
      } catch (e) { KEY.failAt = Date.now(); return KEY.rec; } finally { KEY.pending = null; }
    })();
    return KEY.pending;
  }
  async function keyHeader() {
    if (KEY.open) return '';
    if (KEY.blocked) {                                   // blocked → pause a day, then ask for a fresh key
      const b = (() => { try { return JSON.parse(LS.get('onda_key_blocked') || 'null'); } catch (e) { return null; } })();
      if (b && Date.now() - b.at < DAY) return null;
      KEY.blocked = false; LS.del('onda_key_blocked'); KEY.rec = null; LS.del('onda_key');
    }
    const rec = KEY.rec || await ensureKey();
    if (!rec) return KEY.open ? '' : null;
    const now = Date.now();
    if (KEY.hdr && now - KEY.hdrAt < 50e3) return KEY.hdr;
    if (!(g.crypto && g.crypto.subtle)) return null;
    if (!KEY.ck) KEY.ck = await g.crypto.subtle.importKey('raw', enc.encode(rec.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const ts = Math.floor((now + KEY.skew) / 1000);
    const sig = b64u(await g.crypto.subtle.sign('HMAC', KEY.ck, enc.encode(rec.id + '.' + ts)));
    KEY.hdr = rec.id + '.' + ts + '.' + sig; KEY.hdrAt = now;
    return KEY.hdr;
  }

  /* ── HTTP (native → CapacitorHttp, browser → fetch) ───────────────────── */
  function headersFor(extra) {
    const h = Object.assign({ Accept: 'application/json' }, extra || {});
    if (isNative) { h['User-Agent'] = UA; h['Lrclib-Client'] = UA; }
    return h;
  }
  function b64ToBlob(b64, type) {
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || 'image/jpeg' });
  }
  function hdr(h, name) {
    if (!h) return '';
    const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
    return k ? String(h[k]) : '';
  }
  /** → { ok, status, data }   (data: parsed JSON or Blob). Throws only on network failure. */
  async function http(url, as, noKey, again) {
    as = as || 'json';
    const mine = !noKey && isWorker(url);
    let extra = null;
    if (mine) {
      const k = await keyHeader();
      if (k === null) return { ok: false, status: KEY.blocked ? 403 : 599, data: null };   // blocked → 403; no key yet (offline?) → 599 = try again later
      if (k) extra = { 'X-Onda-Key': k };
    }
    let out;
    if (Http) {
      const r = await Http.get({ url, headers: headersFor(Object.assign(as === 'blob' ? { Accept: 'image/*' } : {}, extra || {})), responseType: as === 'blob' ? 'blob' : 'json', connectTimeout: 15000, readTimeout: 20000 });
      const ok = r.status >= 200 && r.status < 300;
      if (!ok) out = { ok: false, status: r.status, data: r.data };
      else if (as === 'blob') out = { ok: true, status: r.status, data: b64ToBlob(r.data, hdr(r.headers, 'content-type').split(';')[0]) };
      else {
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* leave string */ } }
        out = { ok: true, status: r.status, data: d };
      }
    } else {
      const r = await fetch(url, { headers: Object.assign(as === 'blob' ? { Accept: 'image/*' } : { Accept: 'application/json' }, extra || {}) });
      if (!r.ok) { let d = null; try { d = await r.json(); } catch (e) { /* none */ } out = { ok: false, status: r.status, data: d }; }
      else out = { ok: true, status: r.status, data: as === 'blob' ? await r.blob() : await r.json() };
    }
    if (mine && !out.ok && (out.status === 401 || out.status === 403)) {
      let d = out.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
      const why = d && d.error;
      if (out.status === 403 && why === 'blocked') {                       // this key is dead → remember for a day
        KEY.blocked = true; LS.set('onda_key_blocked', JSON.stringify({ at: Date.now(), id: KEY.rec && KEY.rec.id })); keyEvent('blocked');
      } else if (!again && why === 'clock' && d.now) {                      // phone clock is off → align to the Worker and retry once
        KEY.skew = d.now * 1000 - Date.now(); KEY.hdr = ''; return http(url, as, noKey, true);
      } else if (!again && out.status === 401 && Date.now() - KEY.regAt > 3600e3) {   // unknown key (e.g. secret rotated) → one fresh key per hour
        KEY.rec = null; KEY.ck = null; KEY.hdr = ''; LS.del('onda_key');
        if (await ensureKey(true)) return http(url, as, noKey, true);
      }
    }
    return out;
  }
  async function httpRetry(url, as, gate) {
    const run = () => (gate ? gate(() => http(url, as)) : http(url, as));
    let r = await run();
    if (r.status === 503 || r.status === 429) { await sleep(2500); r = await run(); }
    return r;
  }

  /* ── per-service throttles ────────────────────────────────────────────── */
  function makeGate(gapMs) {
    let chain = Promise.resolve(), last = 0;
    return fn => {
      const run = chain.then(async () => {
        const wait = Math.max(0, last + gapMs - Date.now());
        if (wait) await sleep(wait);
        last = Date.now();
        return fn();
      });
      chain = run.catch(() => {});
      return run;
    };
  }
  const mbGate = makeGate(1100);
  const adbGate = makeGate(2100); // free key: 30 requests / minute
  const wikiGate = makeGate(250);
  const itunesGate = makeGate(3200);   // ~20 requests / minute
  const deezerGate = makeGate(180);
  const lfmGate = makeGate(260);       // Last.fm allows ~5 requests / second
  const kfold = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
  const keyOfArtist = s => kfold(s).replace(/^the/, '');
  const MUSIC_RE = /\b(band|singer|rapper|musician|group|duo|trio|quartet|composer|songwriter|vocalist|guitarist|drummer|pianist|dj|producer|rock|hip[- ]hop|pop|metal|punk|jazz|electronic|recording artist|orchestra|ensemble)\b/i;
  const cutSentence = (t, max) => {
    t = String(t || '').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max), i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
    return i > max * 0.5 ? cut.slice(0, i + 1) : cut.replace(/\s+\S*$/, '') + '…';
  };

  /* ── cache ────────────────────────────────────────────────────────────── */
  async function cached(key, ttl, producer, negTtl) {
    try { const hit = await DB.metaGet(key); if (hit !== undefined) return hit; } catch (e) { /* ignore */ }
    const v = await producer();
    try { await DB.metaSet(key, v == null ? null : v, v == null ? (negTtl || 7 * DAY) : ttl); } catch (e) { /* ignore */ }
    return v == null ? null : v;
  }

  const esc = s => String(s || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const unknown = a => !a || /^unknown( artist)?$/i.test(a);
  const lc = s => String(s || '').toLowerCase().trim();
  const cleanTitle = t => String(t || '').replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/\s+-\s+(remaster(ed)?|live|mono|stereo|single version|radio edit).*$/i, '').trim();

  let online = true;
  let lfmDead = '';

  const Meta = {
    get enabled() { return online; },
    setOnline(v) { online = !!v; },
    get hasProxy() { return !!PROXY; },
    get customMode() { return !!OWN; },
    get hasUnsplash() { return !!UNS; },
    /** true when the internet really answers (not just "wifi connected"): a 4 s ping to the Worker's health route */
    async reachable() {
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
        const base = WORKER_ORIGINS[0]; if (!base) return true;
        const t = new Promise(r => setTimeout(() => r(false), 4000));
        const ping = http(base + '/', 'json', true).then(r => r.ok || r.status > 0 && r.status < 500).catch(() => false);
        return await Promise.race([ping, t]);
      } catch (e) { return false; }
    },
    /** make sure this install has its Worker key (call at setup / startup — fire and forget) */
    ensureKey() { return ensureKey(); },
    get keyState() { return KEY.blocked ? 'blocked' : KEY.open ? 'open' : KEY.rec ? 'active' : 'none'; },
    get keyId() { return KEY.rec ? KEY.rec.id : ''; },

    /* ═══ Unsplash (through the Worker — the key never leaves it) ═══════ */
    /** best landscape photo for a genre → { id, img, user, userUrl, pageUrl, ping } | null */
    unsplashGenre(name) {
      if (!online || !UNS) return Promise.resolve(null);
      const q = String(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' music';
      return cached('unsp|' + lc(q), 90 * DAY, async () => {
        const r = await httpRetry(UNS + '/unsplash/search/photos?per_page=1&orientation=landscape&content_filter=high&query=' + encodeURIComponent(q), 'json');
        if (!r.ok) { const e = new Error('Unsplash ' + r.status); e.status = r.status; throw e; }
        const p = (((r.data || {}).results) || [])[0];
        if (!p || !p.urls) return null;
        const utm = u => String(u || '') + (String(u).includes('?') ? '&' : '?') + 'utm_source=onda&utm_medium=referral';
        let ping = '';
        try { const l = new URL(p.links.download_location); ping = l.pathname.replace(/^\//, '') + l.search; } catch (e) { /* none */ }
        return { id: p.id, img: https(p.urls.small), user: (p.user || {}).name || 'Unsplash', userUrl: utm(((p.user || {}).links || {}).html || 'https://unsplash.com'), pageUrl: utm('https://unsplash.com/'), ping };
      }, 14 * DAY);
    },
    async unsplashBlob(p) {
      const r = await httpRetry(p.img, 'blob');
      return r.ok && r.data && r.data.size > 1000 ? r.data : null;
    },
    /** Unsplash asks apps to register a download when a photo is used */
    unsplashPing(p) {
      if (!UNS || !p || !p.ping) return Promise.resolve();
      return httpRetry(UNS + '/unsplash/' + p.ping, 'json').catch(() => {});
    },

    /* ═══ Last.fm (through the Worker — the key stays in the Worker as LASTFM_API_KEY) ═══ */
    get hasLastfm() { return (!!LFM || LFM_DIRECT) && !lfmDead; },
    get lastfmDead() { return lfmDead; },
    /** one call → parsed JSON, null when Last.fm doesn't know it. Marks itself dead when the Worker has no key (501) or the key is rejected. */
    async lfm(params) {                                   // → data | null (Last.fm doesn't know it) | undefined (network / busy — try again later)
      if (!online || (!LFM && !LFM_DIRECT) || lfmDead) return undefined;
      const qs = Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
      let r;
      try { r = await httpRetry(LFM_DIRECT ? 'https://ws.audioscrobbler.com/2.0/?' + qs + (/(^|&)format=/.test(qs) ? '' : '&format=json') + '&api_key=' + encodeURIComponent(OWN_LFM) : LFM + '/lastfm?' + qs, 'json', lfmGate); } catch (e) { return undefined; }
      if (r.status === 501) { lfmDead = 'nokey'; return undefined; }
      if (r.status === 401 || r.status === 403) { lfmDead = 'badkey'; return undefined; }
      if (r.status === 404) return null;
      if (!r.ok || !r.data) return undefined;
      const d = r.data;
      if (d.error) { if (d.error === 10 || d.error === 26) { lfmDead = 'badkey'; return undefined; } return [11, 16, 8, 29].includes(d.error) ? undefined : null; }
      return d;
    },
    /** → { listeners, plays, tags:[name], similar:[[name, match]] } | null */
    async lastfmArtist(name) {
      if (unknown(name)) return null;
      const info = await Meta.lfm({ method: 'artist.getInfo', artist: name, autocorrect: 1 });
      if (info === undefined) return undefined;
      const a = info && info.artist; if (!a) return null;
      const arr = x => (Array.isArray(x) ? x : x ? [x] : []);
      const sim = await Meta.lfm({ method: 'artist.getSimilar', artist: name, autocorrect: 1, limit: 40 });
      return {
        listeners: parseInt((a.stats || {}).listeners, 10) || 0,
        plays: parseInt((a.stats || {}).playcount, 10) || 0,
        tags: arr((a.tags || {}).tag).map(t => String(t.name || '').toLowerCase()).filter(Boolean).slice(0, 6),
        similar: arr(((sim || {}).similarartists || {}).artist).map(x => [String(x.name || ''), Math.round((parseFloat(x.match) || 0) * 100) / 100]).filter(x => x[0]),
      };
    },
    /** Everything the web knows about an album: Last.fm (tags, listeners, write-up) + iTunes (date, genre, copyright)
     *  + MusicBrainz (label, country).  → { year, released, genre, label, country, tags[], listeners, plays, summary, url, copyright, sources[] } | null */
    albumInfo(artist, album) {
      if (!online || !album) return Promise.resolve(null);
      return cached('albinfo|' + lc(artist) + '|' + lc(album), 30 * DAY, async () => {
        const ar = unknown(artist) ? '' : artist;
        const arr = x => (Array.isArray(x) ? x : x ? [x] : []);
        const out = { year: 0, released: '', genre: '', label: '', country: '', tags: [], listeners: 0, plays: 0, summary: '', url: '', copyright: '', sources: [] };
        let failed = 0, asked = 0;
        const note = (name, ok) => { if (ok) out.sources.push(name); };
        await Promise.all([
          // Last.fm
          (async () => {
            if ((!LFM && !LFM_DIRECT) || lfmDead) return;
            asked++;
            const d = await Meta.lfm(Object.assign({ method: 'album.getInfo', album, autocorrect: 1 }, ar ? { artist: ar } : {}));
            if (d === undefined) { failed++; return; }
            const a = d && d.album; if (!a) return;
            out.tags = arr((a.tags || {}).tag).map(t => String(t.name || '').toLowerCase()).filter(Boolean).slice(0, 6);
            out.listeners = parseInt(a.listeners, 10) || 0; out.plays = parseInt(a.playcount, 10) || 0;
            const w = a.wiki && a.wiki.summary ? String(a.wiki.summary).replace(/<a [^>]*>.*?<\/a>/gi, '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim() : '';
            if (w) out.summary = w;
            if (a.wiki && a.wiki.published && !out.released) { const y = (String(a.wiki.published).match(/\b(19|20)\d\d\b/) || [])[0]; if (y) out.wikiYear = +y; }
            out.url = a.url || '';
            note('Last.fm', out.tags.length || out.listeners || out.summary);
          })().catch(() => { failed++; }),
          // iTunes
          (async () => {
            asked++;
            const term = (ar ? ar + ' ' : '') + album;
            const r = await httpRetry('https://itunes.apple.com/search?media=music&entity=album&limit=6&term=' + encodeURIComponent(term), 'json', itunesGate);
            if (!r.ok) { failed++; return; }
            let data = r.data; if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
            const bk = kfold(album), ak = keyOfArtist(ar);
            const hit = ((data || {}).results || []).find(x => x.collectionName && (kfold(x.collectionName).startsWith(bk) || bk.startsWith(kfold(x.collectionName))) &&
              (!ar || keyOfArtist(x.artistName).includes(ak) || ak.includes(keyOfArtist(x.artistName))));
            if (!hit) return;
            if (hit.releaseDate) { out.released = String(hit.releaseDate).slice(0, 10); out.year = parseInt(out.released, 10) || 0; }
            out.genre = hit.primaryGenreName || ''; out.copyright = hit.copyright || '';
            out.count = hit.trackCount || 0;
            note('iTunes', true);
          })().catch(() => { failed++; }),
          // MusicBrainz
          (async () => {
            asked++;
            const rel = await Meta.lookupRelease({ artist: ar, album });
            if (!rel || !rel.releaseId) return;
            const r = await httpRetry(urlFor('mb', 'release/' + rel.releaseId + '?fmt=json&inc=labels'), 'json', mbGate);
            if (!r.ok) { failed++; return; }
            const d = r.data || {};
            const li = arr(d['label-info']).find(x => x.label && x.label.name && !/^\[no label\]$/i.test(x.label.name));
            if (li) out.label = li.label.name;
            if (d.country) out.country = d.country;
            if (d.date && !out.released) { out.released = String(d.date); out.year = parseInt(d.date, 10) || 0; }
            note('MusicBrainz', out.label || out.country || d.date);
          })().catch(() => { failed++; }),
        ]);
        if (!out.year && out.wikiYear) out.year = out.wikiYear;
        if (!out.sources.length && failed) throw new Error('album info: sources unreachable');   // not cached → tried again next time
        return out.sources.length ? out : null;
      }, 7 * DAY);
    },
    /** → { listeners, plays, tags } | null */
    async lastfmTrack(artist, title) {
      const d = await Meta.lfm({ method: 'track.getInfo', artist: unknown(artist) ? '' : artist, track: cleanTitle(title) || title, autocorrect: 1 });
      if (d === undefined) return undefined;
      const t = d && d.track; if (!t) return null;
      const arr = x => (Array.isArray(x) ? x : x ? [x] : []);
      return { listeners: parseInt(t.listeners, 10) || 0, plays: parseInt(t.playcount, 10) || 0, tags: arr((t.toptags || {}).tag).map(x => String(x.name || '').toLowerCase()).slice(0, 5) };
    },
    /** one page of a profile's scrobble history (newest first) → { tracks: [{ artist, title, album, uts }], totalPages, total } | null (no such profile) | undefined (try again later) */
    async lastfmRecent(user, o) {
      o = o || {};
      const q = { method: 'user.getRecentTracks', user, limit: 200, page: o.page || 1, cb: Math.floor(Date.now() / 300000) };
      if (o.from) q.from = o.from;
      if (o.to) q.to = o.to;
      const d = await Meta.lfm(q);
      if (d === undefined) return undefined;
      const box = d && d.recenttracks; if (!box) return null;
      const arr = x => (Array.isArray(x) ? x : x ? [x] : []);
      const tracks = [];
      for (const t of arr(box.track)) {
        if (t['@attr'] && t['@attr'].nowplaying) continue;
        const uts = parseInt((t.date || {}).uts, 10); if (!uts) continue;
        tracks.push({ artist: String((t.artist || {})['#text'] || (t.artist || {}).name || ''), title: String(t.name || ''), album: String((t.album || {})['#text'] || ''), uts });
      }
      const at = box['@attr'] || {};
      return { tracks, totalPages: parseInt(at.totalPages, 10) || 1, total: parseInt(at.total, 10) || 0 };
    },
    /** a public Last.fm profile's tracks: kind 'top' (period overall|1month|3month|12month) or 'loved' → [{ artist, title, plays }] */
    async lastfmUserTracks(user, kind, period, maxPages) {
      const out = [];
      const arr = x => (Array.isArray(x) ? x : x ? [x] : []);
      for (let page = 1; page <= (maxPages || 3); page++) {
        const d = await Meta.lfm(kind === 'loved' ? { method: 'user.getLovedTracks', user, limit: 500, page, cb: Math.floor(Date.now() / 3600000) } : { method: 'user.getTopTracks', user, period: period || 'overall', limit: 500, page, cb: Math.floor(Date.now() / 3600000) });
        if (d === undefined && page === 1) return undefined;
        const box = d && (d.toptracks || d.lovedtracks); if (!box) { if (page === 1) return null; break; }
        for (const t of arr(box.track)) out.push({ artist: String((t.artist || {}).name || (t.artist || {})['#text'] || ''), title: String(t.name || ''), plays: parseInt(t.playcount, 10) || 0 });
        const tp = parseInt(((box['@attr'] || {}).totalPages), 10) || 1;
        if (page >= tp) break;
      }
      return out;
    },

    /* ═══ MusicBrainz ════════════════════════════════════════════════════ */
    /** → { releaseId, groupId, artistId, album } | null */
    lookupRelease({ artist, album, title }) {
      if (!online) return Promise.resolve(null);
      const ar = unknown(artist) ? '' : esc(artist), al = esc(album), ti = esc(title);
      if (!al && !(ti && ar)) return Promise.resolve(null);
      return cached('rel|' + [ar, al, al ? '' : ti].join('|').toLowerCase(), 30 * DAY, async () => {
        if (al) {
          const q = `release:"${al}"` + (ar ? ` AND artist:"${ar}"` : '');
          const r = await httpRetry(urlFor('mb', 'release?fmt=json&limit=3&query=' + encodeURIComponent(q)), 'json', mbGate);
          if (!r.ok) throw new Error('MusicBrainz ' + r.status);
          const rel = ((r.data || {}).releases || []).find(x => (x.score || 0) >= 85);
          return rel ? {
            releaseId: rel.id,
            groupId: (rel['release-group'] || {}).id || '',
            artistId: (((rel['artist-credit'] || [])[0] || {}).artist || {}).id || '',
            album: rel.title,
          } : null;
        }
        const q = `recording:"${ti}" AND artist:"${ar}"`;
        const r = await httpRetry(urlFor('mb', 'recording?fmt=json&limit=3&query=' + encodeURIComponent(q)), 'json', mbGate);
        if (!r.ok) throw new Error('MusicBrainz ' + r.status);
        const rec = ((r.data || {}).recordings || []).find(x => (x.score || 0) >= 90 && (x.releases || []).length);
        if (!rec) return null;
        const rel = rec.releases[0];
        return {
          releaseId: rel.id,
          groupId: (rel['release-group'] || {}).id || '',
          artistId: (((rec['artist-credit'] || [])[0] || {}).artist || {}).id || '',
          album: rel.title,
        };
      });
    },

    lookupArtist(name) {
      if (!online || unknown(name)) return Promise.resolve(null);
      return cached('art|' + lc(name), 90 * DAY, async () => {
        const r = await httpRetry(urlFor('mb', 'artist?fmt=json&limit=3&query=' + encodeURIComponent(`artist:"${esc(name)}"`)), 'json', mbGate);
        if (!r.ok) throw new Error('MusicBrainz ' + r.status);
        const a = ((r.data || {}).artists || []).find(x => (x.score || 0) >= 90);
        return a ? a.id : null;
      });
    },

    /* ═══ covers ═════════════════════════════════════════════════════════ */
    /** Best single cover as a Blob (CAA front, 500 px) — used for automatic artwork. */
    coverBlob(rel) {
      if (!online || !rel || !rel.releaseId) return Promise.resolve(null);
      return cached('cov|' + rel.releaseId, 90 * DAY, async () => {
        const px = g.__data && g.__data.saver() ? 250 : 500;           // smaller picture on mobile data
        const paths = ['release/' + rel.releaseId + '/front-' + px];
        if (rel.groupId) paths.push('release-group/' + rel.groupId + '/front-' + px);
        for (const p of paths) {
          const r = await httpRetry(urlFor('caa', p), 'blob');
          if (r.ok && r.data && r.data.size > 1000) return r.data;
          if (!r.ok && r.status !== 404) throw new Error('CAA ' + r.status);
        }
        return null;
      });
    },

    /** Automatic fallback when MusicBrainz/CAA has nothing: TheAudioDB album thumb. */
    async audioDbCoverBlob({ artist, album }) {
      if (!online || unknown(artist) || !album) return null;
      const alb = await Meta._adbAlbum(artist, album);
      const url = alb && (alb.strAlbumThumbHQ || alb.strAlbumThumb);
      if (!url) return null;
      const r = await httpRetry(https(url), 'blob');
      return r.ok ? r.data : null;
    },

    _adbAlbum(artist, album) {
      return cached('adbalb|' + lc(artist) + '|' + lc(album), 30 * DAY, async () => {
        const r = await httpRetry(urlFor('adb', 'searchalbum.php?s=' + encodeURIComponent(artist) + '&a=' + encodeURIComponent(album)), 'json', adbGate);
        if (!r.ok) throw new Error('TheAudioDB ' + r.status);
        return (((r.data || {}).album) || [])[0] || null;
      });
    },

    /** Every alternative cover we can find, delivered progressively: onBatch([{id, source, label, thumb, full}]). */
    async coverCandidates({ artist, album, title, rel }, onBatch) {
      if (!online) return;
      const seen = new Set();
      const push = list => {
        const fresh = list.filter(c => c.full && !seen.has(c.full) && seen.add(c.full));
        if (fresh.length) onBatch(fresh);
      };
      const safe = async fn => { try { await fn(); } catch (e) { console.debug('cover source skipped:', e && e.message); } };

      rel = rel || await Meta.lookupRelease({ artist, album, title }).catch(() => null);

      // 1 — Cover Art Archive: all images of the matched release
      await safe(async () => {
        if (!rel) return;
        const list = await cached('covimg|' + rel.releaseId, 14 * DAY, async () => {
          const r = await httpRetry(urlFor('caa', 'release/' + rel.releaseId), 'json');
          if (r.status === 404) return null;
          if (!r.ok) throw new Error('CAA ' + r.status);
          return ((r.data || {}).images || []).map(im => ({
            label: (im.types || []).join(' / ') || 'Image',
            thumb: https((im.thumbnails || {})['500'] || (im.thumbnails || {}).large || im.image),
            full: https((im.thumbnails || {})['1200'] || (im.thumbnails || {})['500'] || im.image),
          }));
        });
        push((list || []).map((c, i) => ({ id: 'caa' + i, source: 'Cover Art Archive', label: c.label, thumb: c.thumb, full: c.full })));
      });

      // 2 — other editions/pressings of the same album (different cover designs)
      await safe(async () => {
        if (!rel || !rel.groupId) return;
        const eds = await cached('coved|' + rel.groupId, 14 * DAY, async () => {
          const r = await httpRetry(urlFor('mb', 'release?fmt=json&limit=40&release-group=' + rel.groupId), 'json', mbGate);
          if (!r.ok) throw new Error('MusicBrainz ' + r.status);
          return ((r.data || {}).releases || [])
            .filter(x => x.id !== rel.releaseId && x['cover-art-archive'] && x['cover-art-archive'].front)
            .slice(0, 14)
            .map(x => ({ id: x.id, label: [x.date, x.country, x.disambiguation].filter(Boolean).join(' · ') || 'Edition' }));
        });
        push((eds || []).map(e => ({
          id: 'ed' + e.id, source: 'Cover Art Archive', label: e.label,
          thumb: 'https://coverartarchive.org/release/' + e.id + '/front-250',
          full: 'https://coverartarchive.org/release/' + e.id + '/front-1200',
        })));
      });

      // 3 — TheAudioDB: cover, HQ cover, CD art, 3D case …
      await safe(async () => {
        if (unknown(artist) || !album) return;
        const a = await Meta._adbAlbum(artist, album);
        if (!a) return;
        const fields = [['strAlbumThumbHQ', 'Cover (HQ)'], ['strAlbumThumb', 'Cover'], ['strAlbumThumbBack', 'Back'], ['strAlbumCDart', 'Disc'],
          ['strAlbum3DCase', '3D case'], ['strAlbum3DFlat', '3D flat'], ['strAlbum3DFace', '3D face'], ['strAlbumSpine', 'Spine']];
        push(fields.filter(f => a[f[0]]).map(f => ({ id: 'adb' + f[0], source: 'TheAudioDB', label: f[1], thumb: https(a[f[0]]), full: https(a[f[0]]) })));
      });

      // 3b — iTunes, Deezer, Wikipedia (album article lead image)
      await safe(async () => {
        if (!album) return;
        const it = await Meta.itunesAlbums(artist, album);
        push(it.slice(0, 2).map((x, i) => ({ id: 'itunes' + i, source: 'iTunes', label: x.title, thumb: x.art, full: x.art.replace('600x600bb', '1000x1000bb') })));
      });
      await safe(async () => {
        if (!album) return;
        const d = await Meta.deezerAlbum(artist, album);
        if (d) push([{ id: 'deezer', source: 'Deezer', label: d.title, thumb: d.thumb, full: d.full }]);
      });
      await safe(async () => {
        if (!album) return;
        const w = await Meta.wikipediaAlbum(artist, album);
        if (w) push([{ id: 'wiki', source: 'Wikipedia', label: w.title, thumb: w.thumb, full: w.thumb }]);
      });

      // 4 — keyless web sources (hit-and-miss for album art — shown last)
      await safe(async () => {
        const q = [artist && !unknown(artist) ? artist : '', album || title, 'album cover'].filter(Boolean).join(' ');
        const [c, o] = await Promise.all([Meta.commonsImages(q, 4).catch(() => []), Meta.openverseImages(q, 4).catch(() => [])]);
        push(c.concat(o).map((x, i) => Object.assign({ id: 'web' + i }, x)));
      });
    },

    /* ═══ keyless image search ═══════════════════════════════════════════ */
    commonsImages(query, limit) {
      return cached('commons|' + lc(query) + '|' + limit, 14 * DAY, async () => {
        const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=600'
          + '&gsrlimit=' + (limit || 4) + '&gsrsearch=' + encodeURIComponent(query + ' filetype:bitmap');
        const r = await http(u, 'json');
        if (!r.ok) throw new Error('Commons ' + r.status);
        const pages = Object.values(((r.data || {}).query || {}).pages || {});
        return pages.map(p => (p.imageinfo || [])[0]).filter(ii => ii && /^image\/(jpeg|png|webp)/.test(ii.mime || ''))
          .map(ii => ({ source: 'Wikimedia Commons', label: 'Web image', thumb: https(ii.thumburl || ii.url), full: https(ii.thumburl || ii.url) }));
      }, 3 * DAY).then(v => v || []);
    },
    openverseImages(query, limit) {
      return cached('openverse|' + lc(query) + '|' + limit, 14 * DAY, async () => {
        const r = await http('https://api.openverse.org/v1/images/?mature=false&page_size=' + (limit || 4) + '&q=' + encodeURIComponent(query), 'json');
        if (!r.ok) throw new Error('Openverse ' + r.status);
        return (((r.data || {}).results) || []).filter(x => x.thumbnail || x.url)
          .map(x => ({ source: 'Openverse', label: x.creator ? 'by ' + x.creator : 'Web image', thumb: https(x.thumbnail || x.url), full: https(x.url || x.thumbnail) }));
      }, 3 * DAY).then(v => v || []);
    },

    /** Download an image (any candidate) as a Blob. */
    async imageBlob(url) {
      const r = await httpRetry(https(url), 'blob');
      if (!r.ok || !r.data || r.data.size < 500) throw new Error('Image download failed (' + r.status + ')');
      return r.data;
    },

    /* ═══ artist profile ═════════════════════════════════════════════════ */
    /** → { name, mbid, bio, genre, style, mood, formed, disbanded, born, country, type, area, tags[], links[], images[], thumb } */
    artistProfile(name, mbidHint) {
      if (!online || unknown(name)) return Promise.resolve(null);
      return cached('profile2|' + lc(name), 30 * DAY, async () => {
        const p = { name, mbid: mbidHint || '', bio: '', genre: '', style: '', mood: '', formed: '', disbanded: '', born: '',
          country: '', type: '', area: '', tags: [], links: [], images: [], thumb: '', logo: '', bioSource: '', bioUrl: '' };
        const addImg = (label, url, source) => { if (url && !p.images.some(i => i.url === https(url))) p.images.push({ label, url: https(url), source }); };

        // TheAudioDB (bio, facts, photos)
        try {
          const r = await httpRetry(urlFor('adb', 'search.php?s=' + encodeURIComponent(name)), 'json', adbGate);
          const a = r.ok ? (((r.data || {}).artists) || [])[0] : null;
          if (a && lc(a.strArtist) === lc(name)) {
            p.bio = (a.strBiographyEN || '').trim(); if (p.bio) p.bioSource = 'TheAudioDB';
            p.genre = a.strGenre || ''; p.style = a.strStyle || ''; p.mood = a.strMood || '';
            p.formed = a.intFormedYear || ''; p.disbanded = a.intDiedYear || ''; p.born = a.intBornYear || '';
            p.country = a.strCountry || '';
            if (!p.mbid && a.strMusicBrainzID) p.mbid = a.strMusicBrainzID;
            const link = (label, u) => { if (u) p.links.push({ label, url: /^https?:\/\//i.test(u) ? u : 'https://' + u }); };
            link('Website', a.strWebsite); link('Facebook', a.strFacebook); link('Twitter', a.strTwitter);
            addImg('Portrait', a.strArtistThumb, 'TheAudioDB');
            addImg('Wide', a.strArtistWideThumb, 'TheAudioDB');
            ['strArtistFanart', 'strArtistFanart2', 'strArtistFanart3', 'strArtistFanart4'].forEach((k, i) => addImg('Fan art ' + (i + 1), a[k], 'TheAudioDB'));
            addImg('Banner', a.strArtistBanner, 'TheAudioDB');
            if (a.strArtistLogo) p.logo = https(a.strArtistLogo);
          }
        } catch (e) { console.debug('AudioDB artist skipped:', e && e.message); }

        // MusicBrainz (type, area, life-span, tags, links)
        try {
          if (!p.mbid) p.mbid = (await Meta.lookupArtist(name)) || '';
          if (p.mbid) {
            const r = await httpRetry(urlFor('mb', 'artist/' + p.mbid + '?fmt=json&inc=tags+url-rels'), 'json', mbGate);
            if (r.ok && r.data) {
              const d = r.data;
              p.type = d.type || ''; p.area = (d.area || {}).name || '';
              const ls = d['life-span'] || {};
              if (!p.formed && ls.begin) p.formed = String(ls.begin).slice(0, 4);
              if (!p.disbanded && ls.end) p.disbanded = String(ls.end).slice(0, 4);
              p.tags = (d.tags || []).sort((x, y) => (y.count || 0) - (x.count || 0)).slice(0, 6).map(t => t.name);
              const want = { 'official homepage': 'Website', bandcamp: 'Bandcamp', 'social network': 'Social', youtube: 'YouTube', wikipedia: 'Wikipedia', discogs: 'Discogs', 'last.fm': 'Last.fm' };
              (d.relations || []).forEach(rel => {
                const label = want[rel.type]; const u = rel.url && rel.url.resource;
                if (label && u && !p.links.some(l => l.url === u)) p.links.push({ label, url: u });
              });
              p.links.push({ label: 'MusicBrainz', url: 'https://musicbrainz.org/artist/' + p.mbid });
            }
          }
        } catch (e) { console.debug('MusicBrainz artist skipped:', e && e.message); }

        // Wikipedia: biography (preferred), lead photo, article link
        try {
          const w = await Meta.wikipediaArtist(name);
          if (w) {
            if (w.extract && (w.extract.length > 120 || !p.bio)) { p.bio = w.extract; p.bioSource = 'Wikipedia'; p.bioUrl = w.url; }
            p.links = p.links.filter(l => l.label !== 'Wikipedia'); p.links.unshift({ label: 'Wikipedia', url: w.url });
            if (w.thumb) addImg('Photo (Wikipedia)', w.thumb, 'Wikipedia');
          }
        } catch (e) { console.debug('Wikipedia artist skipped:', e && e.message); }

        // Deezer: a good square artist photo
        try { const u = await Meta.deezerArtistPhoto(name); if (u) addImg('Photo (Deezer)', u, 'Deezer'); } catch (e) { console.debug('Deezer artist skipped:', e && e.message); }

        // Fanart.tv (optional, needs a key or the proxy)
        try {
          if (p.mbid && (PROXY || FANART_KEY || LFM)) {
            const r = await httpRetry(urlFor('fanart', 'music/' + p.mbid), 'json');
            if (r.ok && r.data) {
              (r.data.artistthumb || []).slice(0, 3).forEach((x, i) => addImg('Photo ' + (i + 1), x.url, 'Fanart.tv'));
              (r.data.artistbackground || []).slice(0, 3).forEach((x, i) => addImg('Background ' + (i + 1), x.url, 'Fanart.tv'));
              (r.data.musicbanner || []).slice(0, 1).forEach(x => addImg('Banner', x.url, 'Fanart.tv'));
              if (!p.logo) { const lg = (r.data.hdmusiclogo || r.data.musiclogo || [])[0]; if (lg && lg.url) p.logo = https(lg.url); }
            }
          }
        } catch (e) { console.debug('Fanart skipped:', e && e.message); }

        // keyless fallback photos
        try {
          if (p.images.length < 2) {
            const [c, o] = await Promise.all([Meta.commonsImages(name + ' band', 3).catch(() => []), Meta.openverseImages(name + ' musician', 3).catch(() => [])]);
            c.concat(o).forEach(x => addImg('Photo', x.full, x.source));
          }
        } catch (e) { /* ignore */ }

        p.thumb = (p.images.find(i => i.label === 'Portrait') || p.images.find(i => i.label.startsWith('Photo')) || p.images[0] || {}).url || '';
        const empty = !p.bio && !p.images.length && !p.genre && !p.type && !p.area && !p.logo;
        return empty ? null : p;
      }, 7 * DAY);
    },

    /** Fan art for an artist as a Blob (Fanart.tv background → photo → banner; small "preview" size). null when there is none. */
    artistFanart(name) {
      if (!online || !name || !(PROXY || FANART_KEY || LFM) || unknown(name)) return Promise.resolve(null);
      return cached('fanimg|' + lc(name), 90 * DAY, async () => {
        const mbid = await Meta.lookupArtist(name);
        if (!mbid) return null;
        const r = await httpRetry(urlFor('fanart', 'music/' + mbid), 'json');
        if (!r.ok || !r.data) return null;
        const d = r.data;
        const pick = ((d.artistbackground || [])[0]) || ((d.artistthumb || [])[0]) || ((d.musicbanner || [])[0]);
        if (!pick || !pick.url) return null;
        const u = https(pick.url);
        for (const url of [u.replace('assets.fanart.tv/fanart/', 'assets.fanart.tv/preview/'), u]) {
          const b = await httpRetry(url, 'blob');
          if (b.ok && b.data && b.data.size > 2000) return b.data;
        }
        return null;
      }, 3 * DAY);
    },

    /** Artist circle image as a cached Blob. */
    artistThumbBlob(profile) {
      if (!online || !profile || !profile.thumb) return Promise.resolve(null);
      return cached('athumb|' + lc(profile.name), 90 * DAY, async () => {
        const r = await httpRetry(profile.thumb, 'blob');
        if (r.ok && r.data && r.data.size > 500) return r.data;
        return null;
      }, 7 * DAY);
    },

    /** Artist logo (TheAudioDB / Fanart.tv) as a cached Blob — shown instead of the artist's name. */
    artistLogoBlob(profile) {
      const url = profile && (profile.logo || ((profile.images || []).find(i => i.label === 'Logo') || {}).url);
      if (!online || !url) return Promise.resolve(null);
      return cached('alogo|' + lc(profile.name), 365 * DAY, async () => {
        const r = await httpRetry(https(url), 'blob');
        if (r.ok && r.data && r.data.size > 300) return r.data;
        return null;
      }, 14 * DAY);
    },


    /* ═══ Wikipedia / iTunes / Deezer ════════════════════════════════════ */
    async _wikiSearch(q, limit) {
      const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&generator=search&gsrnamespace=0&gsrlimit=' + (limit || 4) +
        '&gsrsearch=' + encodeURIComponent(q) + '&prop=extracts|pageimages|info&exintro=1&explaintext=1&exlimit=' + (limit || 4) + '&piprop=thumbnail&pithumbsize=800&inprop=url';
      const r = await httpRetry(u, 'json', wikiGate);
      if (!r.ok) throw new Error('Wikipedia ' + r.status);
      const pages = Object.values(((r.data || {}).query || {}).pages || {});
      return pages.sort((a, b) => (a.index || 0) - (b.index || 0));
    },

    /** → { title, extract, thumb, url } | null    (the artist's Wikipedia article: intro text, lead photo, link) */
    wikipediaArtist(name) {
      if (!online || unknown(name)) return Promise.resolve(null);
      return cached('wiki|' + lc(name), 30 * DAY, async () => {
        const k = keyOfArtist(name);
        const pages = await Meta._wikiSearch(name + ' musician OR band OR singer OR rapper OR group', 5);
        for (const p of pages) {
          const ex = p.extract || '';
          if (!ex || /may refer to|disambiguation/i.test(ex.slice(0, 200))) continue;
          const tk = keyOfArtist(String(p.title || '').replace(/\s*\(.*?\)\s*$/, ''));
          const head = kfold(ex.slice(0, 160));
          if (!(tk === k || tk.startsWith(k) || k.startsWith(tk) && tk.length > 3 || head.includes(k))) continue;
          if (!MUSIC_RE.test(ex.slice(0, 500))) continue;
          return { title: p.title, extract: cutSentence(ex, 1800), thumb: p.thumbnail ? https(p.thumbnail.source) : '', url: p.fullurl || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(String(p.title).replace(/ /g, '_'))) };
        }
        return null;
      }, 7 * DAY);
    },

    /** Album article's lead image is usually the cover. → { thumb, title, url } | null */
    wikipediaAlbum(artist, album) {
      if (!online || !album) return Promise.resolve(null);
      return cached('wikialb|' + lc(artist) + '|' + lc(album), 30 * DAY, async () => {
        const ak = keyOfArtist(artist), bk = kfold(album);
        const pages = await Meta._wikiSearch((unknown(artist) ? '' : artist + ' ') + album + ' album', 4);
        for (const p of pages) {
          if (!p.thumbnail || !/\balbum|\bEP\b|soundtrack|mixtape/i.test((p.extract || '').slice(0, 300))) continue;
          if (!kfold(p.title).includes(bk) && !kfold((p.extract || '').slice(0, 200)).includes(bk)) continue;
          if (ak && !kfold((p.extract || '').slice(0, 400)).includes(ak)) continue;
          return { thumb: https(p.thumbnail.source), title: p.title, url: p.fullurl || '' };
        }
        return null;
      }, 7 * DAY);
    },

    /** → [{ title, artist, art (600 px), genre }]  best matches first */
    itunesAlbums(artist, album) {
      if (!online || !album) return Promise.resolve([]);
      return cached('itunes|' + lc(artist) + '|' + lc(album), 30 * DAY, async () => {
        const term = (unknown(artist) ? '' : artist + ' ') + album;
        const r = await httpRetry('https://itunes.apple.com/search?media=music&entity=album&limit=6&term=' + encodeURIComponent(term), 'json', itunesGate);
        if (!r.ok) throw new Error('iTunes ' + r.status);
        let data = r.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
        const bk = kfold(album), ak = keyOfArtist(artist);
        return ((data || {}).results || [])
          .filter(x => x.artworkUrl100 && (kfold(x.collectionName).startsWith(bk) || bk.startsWith(kfold(x.collectionName))) &&
                       (unknown(artist) || keyOfArtist(x.artistName).includes(ak) || ak.includes(keyOfArtist(x.artistName))))
          .map(x => ({ title: x.collectionName, artist: x.artistName, art: String(x.artworkUrl100).replace(/\d+x\d+bb/, '600x600bb'), genre: x.primaryGenreName || '' }));
      }, 7 * DAY);
    },
    /** Fix tool: album candidates for a typed query ("metallica black album"). → [{ key, source, album, artist, year, genre, count, art }] */
    async fixSearch(query) {
      const q = String(query || '').trim();
      if (!q || !online) return [];
      const out = [];
      try {
        const r = await httpRetry('https://itunes.apple.com/search?media=music&entity=album&limit=8&term=' + encodeURIComponent(q), 'json', itunesGate);
        let data = r.data; if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
        for (const x of ((data || {}).results || [])) {
          if (!x.collectionId || !x.collectionName) continue;
          out.push({ key: 'it' + x.collectionId, source: 'iTunes', id: String(x.collectionId), album: x.collectionName, artist: x.artistName || '',
            year: parseInt(String(x.releaseDate || '').slice(0, 4), 10) || 0, genre: x.primaryGenreName || '', count: x.trackCount || 0,
            art: x.artworkUrl100 ? String(x.artworkUrl100).replace(/\d+x\d+bb/, '200x200bb') : '' });
        }
      } catch (e) { console.debug('iTunes search skipped:', e && e.message); }
      try {
        const r = await httpRetry(urlFor('mb', 'release?fmt=json&limit=8&query=' + encodeURIComponent(q)), 'json', mbGate);
        for (const x of ((r.data || {}).releases || [])) {
          if (!x.id || !x.title || (x.score || 0) < 60) continue;
          const ac = (x['artist-credit'] || []).map(c => (c.name || (c.artist || {}).name || '') + (c.joinphrase || '')).join('').trim();
          out.push({ key: 'mb' + x.id, source: 'MusicBrainz', id: x.id, album: x.title, artist: ac,
            year: parseInt(String(x.date || '').slice(0, 4), 10) || 0, genre: '', count: x['track-count'] || 0, art: '' });
        }
      } catch (e) { console.debug('MusicBrainz search skipped:', e && e.message); }
      // the same album from both sources shows once (iTunes first: it knows the genre)
      const seen = new Set();
      return out.filter(c => { const k = kfold(c.album) + '|' + keyOfArtist(c.artist) + '|' + c.count; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
    },

    /** Fix tool, Deezer: albums for a typed query */
    async fixDzAlbums(q) {
      if (!online || !q) return [];
      try {
        const r = await httpRetry('https://api.deezer.com/search/album?limit=12&q=' + encodeURIComponent(q), 'json', deezerGate);
        return (((r.data || {}).data) || []).filter(x => x && x.id && x.title).map(x => ({ key: 'dz' + x.id, source: 'Deezer', id: String(x.id), album: x.title, artist: (x.artist || {}).name || '', count: x.nb_tracks || 0, year: 0, genre: '', art: x.cover_medium || x.cover || '', type: x.record_type || '' }));
      } catch (e) { return []; }
    },
    /** Fix tool, Deezer: the albums a song title appears on (this is how an album is found from its songs alone) */
    async fixDzByTrack(title, artist) {
      if (!online || !title) return [];
      const q = artist ? 'track:"' + String(title).replace(/"/g, '') + '" artist:"' + String(artist).replace(/"/g, '') + '"' : 'track:"' + String(title).replace(/"/g, '') + '"';
      try {
        const r = await httpRetry('https://api.deezer.com/search/track?limit=25&q=' + encodeURIComponent(q), 'json', deezerGate);
        return (((r.data || {}).data) || []).filter(x => x && x.album && x.album.id).map(x => ({ key: 'dz' + x.album.id, source: 'Deezer', id: String(x.album.id), album: x.album.title || '', artist: (x.artist || {}).name || '', count: 0, year: 0, genre: '', art: x.album.cover_medium || x.album.cover || '', type: '' }));
      } catch (e) { return []; }
    },
    /** Fix tool, Last.fm: albums for a typed query (needs the Worker key) */
    async fixLfAlbums(q) {
      if (!online || !q) return [];
      const d = await Meta.lfm({ method: 'album.search', album: q, limit: 10 });
      const arr = x => (Array.isArray(x) ? x : x ? [x] : []);
      return arr(((d || {}).results || {}).albummatches && d.results.albummatches.album).filter(x => x && x.name && x.artist).map(x => {
        const img = arr(x.image).slice(-1)[0];
        return { key: 'lf' + kfold(x.artist) + '|' + kfold(x.name), source: 'Last.fm', id: x.artist + '\u0001' + x.name, album: x.name, artist: x.artist, count: 0, year: 0, genre: '', art: (img && img['#text']) || '', type: '' };
      });
    },

    /** Fix tool: year + genre of the chosen candidate (Deezer has them on the album page) */
    async fixDetail(c) {
      try {
        if (c.source === 'Deezer') {
          const r = await httpRetry('https://api.deezer.com/album/' + encodeURIComponent(c.id), 'json', deezerGate);
          const d = r.data || {};
          return { year: parseInt(String(d.release_date || '').slice(0, 4), 10) || 0, genre: (((d.genres || {}).data || [])[0] || {}).name || '' };
        }
      } catch (e) { /* ignore */ }
      return {};
    },

    /** Fix tool: the track list of one candidate → [{ disc, no, title, artist, ms }] */
    async fixTracks(c) {
      if (!c) return [];
      if (c.source === 'Deezer') {
        const r = await httpRetry('https://api.deezer.com/album/' + encodeURIComponent(c.id) + '/tracks?limit=200', 'json', deezerGate);
        const list = ((r.data || {}).data) || [];
        let i = 0;
        const rel = list.filter(x => x && x.title).map(x => ({ disc: x.disk_number || 1, discs: 1, no: x.track_position || ++i, total: 0, title: x.title, artist: (x.artist || {}).name || c.artist, ms: (x.duration || 0) * 1000, genre: c.genre }))
          .sort((a, b) => a.disc - b.disc || a.no - b.no);
        const discs = rel.reduce((m, t) => Math.max(m, t.disc), 1);
        rel.forEach(t => { t.discs = discs; t.total = rel.filter(u => u.disc === t.disc).length; });
        return rel;
      }
      if (c.source === 'Last.fm') {
        const [artist, album] = String(c.id).split('\u0001');
        const d = await Meta.lfm({ method: 'album.getInfo', artist, album, autocorrect: 1 });
        const arr = x => (Array.isArray(x) ? x : x ? [x] : []);
        const tr = arr(((d || {}).album || {}).tracks && d.album.tracks.track);
        const rel = tr.filter(x => x && x.name).map((x, i) => ({ disc: 1, discs: 1, no: parseInt((x['@attr'] || {}).rank, 10) || i + 1, total: tr.length, title: x.name, artist: (x.artist || {}).name || artist, ms: (parseInt(x.duration, 10) || 0) * 1000, genre: '' }));
        const tag = arr(((d || {}).album || {}).tags && d.album.tags.tag)[0];
        if (tag && tag.name) rel.forEach(t => { t.genre = tag.name; });
        return rel;
      }
      if (c.source === 'iTunes') {
        const r = await httpRetry('https://itunes.apple.com/lookup?entity=song&limit=200&id=' + encodeURIComponent(c.id), 'json', itunesGate);
        if (!r.ok) throw new Error('iTunes ' + r.status);
        let data = r.data; if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
        return ((data || {}).results || []).filter(x => x.wrapperType === 'track' && x.trackName)
          .map(x => ({ disc: x.discNumber || 1, discs: x.discCount || 1, no: x.trackNumber || 0, total: x.trackCount || 0, title: x.trackName, artist: x.artistName || c.artist, ms: x.trackTimeMillis || 0, genre: x.primaryGenreName || c.genre }))
          .sort((a, b) => a.disc - b.disc || a.no - b.no);
      }
      const r = await httpRetry(urlFor('mb', 'release/' + c.id + '?fmt=json&inc=recordings+artist-credits+genres'), 'json', mbGate);
      if (!r.ok) throw new Error('MusicBrainz ' + r.status);
      const rel = r.data || {}, out = [], media = rel.media || [];
      const genre = ((rel.genres || []).sort((a, b) => (b.count || 0) - (a.count || 0))[0] || {}).name || '';
      media.forEach((m, mi) => (m.tracks || []).forEach(t => {
        const ac = (t['artist-credit'] || (t.recording || {})['artist-credit'] || []).map(x => (x.name || (x.artist || {}).name || '') + (x.joinphrase || '')).join('').trim();
        out.push({ disc: mi + 1, discs: media.length, no: parseInt(t.number, 10) || t.position || 0, total: (m['track-count'] || (m.tracks || []).length), title: t.title || (t.recording || {}).title || '', artist: ac || c.artist, ms: t.length || (t.recording || {}).length || 0, genre: genre || c.genre });
      }));
      return out.filter(t => t.title);
    },

    async itunesCoverBlob({ artist, album }) {
      const list = await Meta.itunesAlbums(artist, album).catch(() => []);
      if (!list.length) return null;
      const r = await httpRetry(https(list[0].art), 'blob');
      return r.ok && r.data && r.data.size > 1000 ? r.data : null;
    },

    deezerAlbum(artist, album) {
      if (!online || !album) return Promise.resolve(null);
      return cached('dzalb|' + lc(artist) + '|' + lc(album), 30 * DAY, async () => {
        const q = (unknown(artist) ? '' : 'artist:"' + esc(artist) + '" ') + 'album:"' + esc(album) + '"';
        const r = await httpRetry('https://api.deezer.com/search/album?limit=4&q=' + encodeURIComponent(q), 'json', deezerGate);
        if (!r.ok) throw new Error('Deezer ' + r.status);
        const bk = kfold(album), ak = keyOfArtist(artist);
        const hit = (((r.data || {}).data) || []).find(x => x.cover_xl && !/\/cover\/\//.test(x.cover_xl) &&
          (kfold(x.title).startsWith(bk) || bk.startsWith(kfold(x.title))) && (unknown(artist) || keyOfArtist((x.artist || {}).name).includes(ak) || ak.includes(keyOfArtist((x.artist || {}).name))));
        return hit ? { title: hit.title, thumb: https(hit.cover_medium || hit.cover_big || hit.cover_xl), full: https(hit.cover_xl || hit.cover_big) } : null;
      }, 7 * DAY);
    },
    async deezerCoverBlob({ artist, album }) {
      const a = await Meta.deezerAlbum(artist, album).catch(() => null);
      if (!a) return null;
      const r = await httpRetry(a.full, 'blob');
      return r.ok && r.data && r.data.size > 1000 ? r.data : null;
    },
    deezerArtistPhoto(name) {
      if (!online || unknown(name)) return Promise.resolve('');
      return cached('dzart|' + lc(name), 60 * DAY, async () => {
        const r = await httpRetry('https://api.deezer.com/search/artist?limit=4&q=' + encodeURIComponent(name), 'json', deezerGate);
        if (!r.ok) throw new Error('Deezer ' + r.status);
        const k = keyOfArtist(name);
        const hit = (((r.data || {}).data) || []).find(x => keyOfArtist(x.name) === k && x.picture_xl && !/\/artist\/\//.test(x.picture_xl));
        return hit ? https(hit.picture_xl) : '';
      }, 7 * DAY);
    },

    /* ═══ lyrics (LRCLIB) ════════════════════════════════════════════════ */
    /** → { synced, plain, instrumental } | null */
    lyrics({ artist, title, album, duration }) {
      if (!online || unknown(artist) || !title) return Promise.resolve(null);
      const dur = Math.round(duration || 0);
      const key = 'lrc|' + [lc(artist), lc(title), lc(album), Math.round(dur / 3)].join('|');
      return cached(key, 365 * DAY, async () => {
        const get = async (t, withAlbum) => {
          let q = 'get?artist_name=' + encodeURIComponent(artist) + '&track_name=' + encodeURIComponent(t);
          if (withAlbum && album) q += '&album_name=' + encodeURIComponent(album);
          if (dur) q += '&duration=' + dur;
          const r = await httpRetry(urlFor('lrclib', q), 'json');
          if (r.status === 404) return null;
          if (!r.ok) throw new Error('LRCLIB ' + r.status);
          return r.data;
        };
        const norm = d => (d && (d.syncedLyrics || d.plainLyrics || d.instrumental))
          ? { synced: d.syncedLyrics || '', plain: d.plainLyrics || '', instrumental: !!d.instrumental } : null;

        let res = norm(await get(title, true));
        if (!res && album) res = norm(await get(title, false));
        const ct = cleanTitle(title);
        if (!res && ct && ct !== title) res = norm(await get(ct, false));
        if (!res) {
          const r = await httpRetry(urlFor('lrclib', 'search?artist_name=' + encodeURIComponent(artist) + '&track_name=' + encodeURIComponent(ct || title)), 'json');
          if (r.ok && Array.isArray(r.data)) {
            const ok = r.data.filter(x => (x.syncedLyrics || x.plainLyrics) && (!dur || !x.duration || Math.abs(x.duration - dur) <= 4));
            ok.sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0));
            res = norm(ok[0]);
          }
        }
        return res;
      }, 14 * DAY);
    },
  };

  g.OndaMeta = Meta;
})(window);
