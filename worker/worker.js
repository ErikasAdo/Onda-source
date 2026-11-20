// Onda API proxy (Cloudflare Worker) - see README for secrets and deploy steps
const USER_AGENT = 'Onda/1.0.0 ( https://onda.app )';

const ROUTES = {
  mb:     { base: 'https://musicbrainz.org/ws/2/',      ttl: 60 * 60 * 24,      forceJson: true },
  caa:    { base: 'https://coverartarchive.org/',       ttl: 60 * 60 * 24 * 30 },
  fanart: { base: 'https://webservice.fanart.tv/v3/',   ttl: 60 * 60 * 24 * 7,  key: 'FANART_API_KEY', param: 'api_key' },
  adb:    { base: env => 'https://www.theaudiodb.com/api/v1/json/' + (env.AUDIODB_KEY || '123') + '/', ttl: 60 * 60 * 24 * 7 },
  lrclib: { base: 'https://lrclib.net/api/',            ttl: 60 * 60 * 24 * 7 },
  assets: { base: 'https://assets.fanart.tv/',          ttl: 60 * 60 * 24 * 90 },
  unsplash: { base: 'https://api.unsplash.com/',        ttl: 60 * 60 * 24,      key: 'UNSPLASH_ACCESS_KEY', param: 'client_id' },
  lastfm: { base: 'https://ws.audioscrobbler.com/2.0/', ttl: 60 * 60 * 24 * 7,  key: 'LASTFM_API_KEY', param: 'api_key', exact: true },
};

// Origins used by Capacitor WebViews (+ local dev)
const DEFAULT_ALLOWED = [
  /^capacitor:\/\/localhost$/,        // iOS
  /^ionic:\/\/localhost$/,            // iOS (legacy)
  /^https?:\/\/localhost(:\d+)?$/,    // Android (androidScheme: 'https') + dev server
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

function originAllowed(origin, env) {
  if (!origin) return false;
  if (env.ALLOWED_ORIGINS) return env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin);
  return DEFAULT_ALLOWED.some(re => re.test(origin));
}

function corsHeaders(origin, env) {
  const h = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Range, X-Onda-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  });
  if (originAllowed(origin, env)) h.set('Access-Control-Allow-Origin', origin);
  return h;
}

function withCors(res, cors) {
  const out = new Response(res.body, res);
  cors.forEach((v, k) => out.headers.set(k, v));
  out.headers.delete('set-cookie');
  return out;
}

function json(obj, status, cors) {
  const h = new Headers(cors);
  h.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(obj), { status, headers: h });
}


/* ───────────────────────── per-install keys ───────────────────────── */
const enc = new TextEncoder();
const b64u = buf => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
const hmacKey = (raw, usage) => crypto.subtle.importKey('raw', typeof raw === 'string' ? enc.encode(raw) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, usage);

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SKEW = 300;            // seconds either side
const RATE_PER_MIN = 400;    // per key, per edge isolate (the app's own throttles stay far below this)
const STRIKES_TO_BLOCK = 30; // 429s within an hour
const MAX_NETWORKS = 8;      // distinct networks (/24, /48) per key per day
const REG_PER_HOUR = 8;      // registrations per network per hour
const BLOCK_TTL = 60 * 60 * 24 * 90;

// isolate-local state (cheap fast path; the edge cache + KV hold what must outlive an isolate)
const mem = { keys: new Map(), ok: new Map(), blocked: new Map(), live: new Map() };
const cap = (m, n) => { if (m.size > n) m.delete(m.keys().next().value); };
const stateReq = (kind, id) => new Request('https://onda-state.invalid/' + kind + '/' + id);

async function secretKeyFor(id, env) {
  let k = mem.keys.get(id);
  if (k) return k;
  const master = await hmacKey(env.MASTER_SECRET, ['sign']);
  const secret = b64u(await crypto.subtle.sign('HMAC', master, enc.encode('k:' + id)));
  k = { secret, key: await hmacKey(secret, ['verify']) };
  mem.keys.set(id, k); cap(mem.keys, 500);
  return k;
}

function netOf(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':');   // IPv6 /48
  return ip.split('.').slice(0, 3).join('.');                         // IPv4 /24
}

async function isBlocked(id, env, ctx) {
  const now = Date.now();
  const b = mem.blocked.get(id); if (b && b > now) return true;
  const okUntil = mem.ok.get(id); if (okUntil && okUntil > now) return false;
  let blocked = !!(await caches.default.match(stateReq('block', id)));
  if (!blocked && env.BLOCKS) { try { blocked = !!(await env.BLOCKS.get(id)); } catch (e) { /* KV hiccup → don't lock people out */ } }
  if (blocked) { mem.blocked.set(id, now + 5 * 60e3); cap(mem.blocked, 500); } else { mem.ok.set(id, now + 60e3); cap(mem.ok, 2000); }
  return blocked;
}

function blockKey(id, why, env, ctx) {
  mem.blocked.set(id, Date.now() + 5 * 60e3); mem.ok.delete(id);
  const marker = new Response(why, { headers: { 'Cache-Control': 'public, max-age=' + BLOCK_TTL } });
  ctx.waitUntil(caches.default.put(stateReq('block', id), marker));
  if (env.BLOCKS) ctx.waitUntil(env.BLOCKS.put(id, why, { expirationTtl: BLOCK_TTL }).catch(() => {}));
}

/** → null when the request may continue, otherwise a Response */
async function authorize(request, env, ctx, cors) {
  const h = request.headers.get('X-Onda-Key') || '';
  const parts = h.split('.');
  if (parts.length !== 3 || !ID_RE.test(parts[0])) return json({ error: 'key required' }, 401, cors);
  const [id, tsStr, sig] = parts;
  const ts = parseInt(tsStr, 10), now = Math.floor(Date.now() / 1000);
  if (!(ts > 0)) return json({ error: 'key required' }, 401, cors);
  if (Math.abs(now - ts) > SKEW) return json({ error: 'clock', now }, 401, cors);

  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', (await secretKeyFor(id, env)).key, unb64u(sig), enc.encode(id + '.' + tsStr)); } catch (e) { ok = false; }
  if (!ok) return json({ error: 'bad key' }, 401, cors);          // wrong secret ≠ proof the real key leaked → no block, just refuse

  if (await isBlocked(id, env, ctx)) return json({ error: 'blocked' }, 403, cors);

  // 1) a valid key used from a web page that isn't the app → it left the app
  const origin = request.headers.get('Origin') || '';
  if (origin && !originAllowed(origin, env)) { blockKey(id, 'origin', env, ctx); return json({ error: 'blocked' }, 403, cors); }

  // 2) per-key rate
  const minute = Math.floor(Date.now() / 60e3);
  let st = mem.live.get(id);
  if (!st) { st = { minute, n: 0, strikes: 0, hour: Math.floor(Date.now() / 36e5), nets: new Set() }; mem.live.set(id, st); cap(mem.live, 2000); }
  if (st.minute !== minute) { st.minute = minute; st.n = 0; }
  const hour = Math.floor(Date.now() / 36e5);
  if (st.hour !== hour) { st.hour = hour; st.strikes = 0; }
  if (++st.n > RATE_PER_MIN) {
    if (++st.strikes >= STRIKES_TO_BLOCK) { blockKey(id, 'rate', env, ctx); return json({ error: 'blocked' }, 403, cors); }
    const r = json({ error: 'slow down' }, 429, cors); r.headers.set('Retry-After', '30'); return r;
  }

  // 3) too many different networks in a day → the key is being shared
  const net = netOf(request);
  if (net && !st.nets.has(net)) {
    st.nets.add(net);
    const req = stateReq('nets', id);
    const prev = await caches.default.match(req);
    let list = []; try { list = prev ? await prev.json() : []; } catch (e) { list = []; }
    if (!list.includes(net)) list.push(net);
    if (list.length > MAX_NETWORKS) { blockKey(id, 'networks', env, ctx); return json({ error: 'blocked' }, 403, cors); }
    ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify(list), { headers: { 'Cache-Control': 'public, max-age=86400' } })));
  }
  return null;
}

async function register(request, env, ctx, cors) {
  const h = new Headers(cors); h.set('Content-Type', 'application/json'); h.set('Cache-Control', 'no-store');
  if (!env.MASTER_SECRET) return new Response(JSON.stringify({ open: true }), { headers: h });   // system off → app sends no key
  const net = netOf(request) || 'x';
  const req = new Request('https://onda-state.invalid/reg/' + encodeURIComponent(net));
  const prev = await caches.default.match(req);
  let n = 0, first = Date.now();
  if (prev) { try { const o = await prev.json(); n = o.n | 0; first = o.t || first; } catch (e) { /* fresh */ } }
  if (n >= REG_PER_HOUR) return json({ error: 'too many registrations, try later' }, 429, cors);
  ctx.waitUntil(caches.default.put(req, new Response(JSON.stringify({ n: n + 1, t: first }), { headers: { 'Cache-Control': 'public, max-age=' + Math.max(60, 3600 - Math.floor((Date.now() - first) / 1000)) } })));
  const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const { secret } = await secretKeyFor(id, env);
  return new Response(JSON.stringify({ id, secret, now: Math.floor(Date.now() / 1000) }), { headers: h });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405, cors);

    const url = new URL(request.url);
    const [, name, ...rest] = url.pathname.split('/');
    if (!name) return json({ ok: true, service: 'onda-proxy', routes: Object.keys(ROUTES) }, 200, cors);

    if (name === 'register') return register(request, env, ctx, cors);

    const route = ROUTES[name];
    if (!route) return json({ error: 'Unknown route', routes: Object.keys(ROUTES) }, 404, cors);

    // per-install key check — before the cache lookup, so cached answers are protected too
    if (env.MASTER_SECRET) {
      const denied = await authorize(request, env, ctx, cors);
      if (denied) return denied;
    }

    // never let a caller smuggle their own key through
    const base = typeof route.base === 'function' ? route.base(env) : route.base;
    const upstream = new URL(route.exact ? base : base + rest.join('/'));
    url.searchParams.forEach((v, k) => { if (k !== 'api_key' && k !== 'client_id' && k !== 'fmt') upstream.searchParams.set(k, v); });
    if (route.forceJson) upstream.searchParams.set('fmt', 'json');
    if (name === 'lastfm') upstream.searchParams.set('format', 'json');

    if (route.key) {
      const secret = env[route.key];
      if (!secret) return json({ error: `${route.key} is not configured on the Worker` }, 501, cors);
      upstream.searchParams.set(route.param, secret);
    }

    // Edge cache — key is the *public* request URL (no secrets)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, cors);

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream.toString(), {
        headers: { 'User-Agent': USER_AGENT, 'Lrclib-Client': USER_AGENT, 'Accept': request.headers.get('Accept') || '*/*' },
        redirect: 'follow',
        cf: { cacheTtl: route.ttl, cacheEverything: true },
      });
    } catch (e) {
      return json({ error: 'Upstream fetch failed' }, 502, cors);
    }

    const res = new Response(upstreamRes.body, upstreamRes);
    if (upstreamRes.ok) {
      res.headers.set('Cache-Control', `public, max-age=${route.ttl}`);
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    } else if (upstreamRes.status === 404) {
      res.headers.set('Cache-Control', 'public, max-age=3600'); // short negative cache
    } else {
      res.headers.set('Cache-Control', 'no-store');
    }
    return withCors(res, cors);
  },
};
