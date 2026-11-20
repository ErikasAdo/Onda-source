/* ─────────────────────────────────────────────────────────────────────────────
 * NativeAudioEngine
 *
 * Dual-channel player built on @capacitor-community/native-audio.
 *
 *   channel A  ─┐                      ┌─ plays the current track
 *               ├─ ping-pong ──────────┤
 *   channel B  ─┘                      └─ preloads the NEXT track (standby)
 *
 * Gapless  : the standby channel already has the next file decoded/buffered. A short
 *            timer fires ~80 ms before the current track ends and starts it.
 * Crossfade: when `settings.crossfade` >= 0.5 s the standby channel is started
 *            `crossfade` seconds before the end and the two channels' volumes are
 *            ramped with an equal-power curve (cos/sin) via setVolume().
 * Fallback : outside Capacitor (browser preview) the same logic runs on two
 *            HTMLAudioElements, so you can develop the UI in a normal browser.
 *
 * Public API (used by index.html):
 *   await engine.ready
 *   engine.settings = { gapless, crossfade, speed }
 *   engine.getNext  = () => ({ track, index }) | null     (queue provider)
 *   engine.on(evt, fn)  evt ∈ timeupdate | state | loaded | transition | ended | error
 *   engine.playTrack(track)  engine.play()  engine.pause()  engine.seek(t)  engine.stop()
 *   engine.refreshPreload()  engine.fadeOutAndPause(ms)
 *   engine.paused / .currentTime (get/set) / .duration / .volume / .playbackRate
 *   engine.currentTrack, engine.isNative, engine.supportsRate
 * ───────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const Cap = global.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());

  function getPlugin(name) {
    try {
      if (Cap && Cap.Plugins && Cap.Plugins[name]) return Cap.Plugins[name];
      if (Cap && typeof Cap.registerPlugin === 'function') return Cap.registerPlugin(name);
    } catch (e) { /* ignore */ }
    return null;
  }

  const NA = isNative ? getPlugin('NativeAudio') : null;
  const useNative = !!NA;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ── channel base: serialises load/unload so assetIds never collide ───────── */
  class BaseChannel {
    constructor(id) {
      this.id = id;
      this.track = null;
      this.trackId = null;
      this.duration = 0;
      this.state = 'empty'; // empty | loading | ready | playing | paused | ended
      this._chain = Promise.resolve();
      this._token = 0;
    }
    _enqueue(fn) {
      const run = this._chain.then(fn, fn);
      this._chain = run.catch(() => {});
      return run;
    }
  }

  /* ── native channel (NativeAudio plugin) ──────────────────────────────────── */
  class NativeChannel extends BaseChannel {
    load(track) {
      const token = ++this._token;
      this.track = track; this.trackId = track.id; this.state = 'loading'; this.duration = 0;
      return this._enqueue(async () => {
        if (token !== this._token) return false;
        try { await NA.unload({ assetId: this.id }); } catch (e) { /* not loaded */ }
        if (token !== this._token) return false;
        // isUrl:true + a file:// URI = stream the file in place (no copy into app bundle)
        await NA.preload({ assetId: this.id, assetPath: track.url, audioChannelNum: 1, isUrl: true, volume: 1.0 });
        if (token !== this._token) return false;
        try {
          const d = await NA.getDuration({ assetId: this.id });
          this.duration = (d && d.duration) || 0;
        } catch (e) { this.duration = 0; }
        this.state = 'ready';
        return true;
      });
    }
    async play() {
      if (this.state === 'paused') await NA.resume({ assetId: this.id });
      else await NA.play({ assetId: this.id, time: 0 });
      this.state = 'playing';
    }
    async pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      await NA.pause({ assetId: this.id });
    }
    async stop() {
      this._token++;
      const wasLoaded = this.state !== 'empty';
      this.state = 'empty'; this.track = null; this.trackId = null; this.duration = 0;
      if (!wasLoaded) return;
      return this._enqueue(async () => {
        try { await NA.stop({ assetId: this.id }); } catch (e) { /* ignore */ }
        try { await NA.unload({ assetId: this.id }); } catch (e) { /* ignore */ }
      });
    }
    async seek(t) { try { await NA.setCurrentTime({ assetId: this.id, time: t }); } catch (e) { /* ignore */ } }
    async getTime() {
      try { const r = await NA.getCurrentTime({ assetId: this.id }); return (r && r.currentTime) || 0; }
      catch (e) { return 0; }
    }
    async setVolume(v) {
      try { await NA.setVolume({ assetId: this.id, volume: Math.max(0, Math.min(1, v)) }); } catch (e) { /* ignore */ }
    }
    setRate() { /* NativeAudio has no playback-rate control */ }
  }

  /* ── web channel (HTMLAudioElement) — browser preview / fallback ──────────── */
  class WebChannel extends BaseChannel {
    constructor(id, onComplete) {
      super(id);
      this.a = new Audio();
      this.a.preload = 'auto';
      this.a.setAttribute('playsinline', '');
      if (global.OndaEQ) global.OndaEQ.hookAudio(this.a);
      this.a.addEventListener('ended', () => onComplete(this.id));
    }
    load(track) {
      const token = ++this._token;
      this.track = track; this.trackId = track.id; this.state = 'loading'; this.duration = 0;
      return this._enqueue(async () => {
        if (token !== this._token) return false;
        const a = this.a;
        a.src = track.url;
        a.load();
        await new Promise((res, rej) => {
          const ok = () => { clean(); res(); };
          const bad = () => { clean(); rej(new Error('Audio failed to load')); };
          const clean = () => { a.removeEventListener('loadedmetadata', ok); a.removeEventListener('error', bad); };
          a.addEventListener('loadedmetadata', ok);
          a.addEventListener('error', bad);
        });
        if (token !== this._token) return false;
        this.duration = a.duration || 0;
        this.state = 'ready';
        return true;
      });
    }
    async play() {
      await this.a.play();
      this.state = 'playing';
    }
    async pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      this.a.pause();
    }
    async stop() {
      this._token++;
      this.a.pause();
      try { this.a.removeAttribute('src'); this.a.load(); } catch (e) { /* ignore */ }
      this.state = 'empty'; this.track = null; this.trackId = null; this.duration = 0;
    }
    async seek(t) { try { this.a.currentTime = t; } catch (e) { /* ignore */ } }
    async getTime() { return this.a.currentTime || 0; }
    async setVolume(v) { this.a.volume = Math.max(0, Math.min(1, v)); }
    setRate(r) { this.a.playbackRate = r; }
  }

  /* ── engine ───────────────────────────────────────────────────────────────── */
  const GAPLESS_LEAD = 0.08; // seconds before the end at which the next track is kicked off
  const POLL_MS = 250;

  class NativeAudioEngine {
    constructor() {
      this.isNative = useNative;
      this.supportsRate = !useNative;
      this.settings = { gapless: true, crossfade: 0, speed: 1 };
      this.getNext = () => null;
      this.currentTrack = null;
      this.crossfading = false;
      this._listeners = {};
      this._master = 1;
      this._playing = false;
      this._time = 0;
      this._playToken = 0;
      this._fadeToken = 0;
      this._ticking = false;
      this._scheduled = null;      // { trackId, timer }
      this._rate = 1;
      this.active = 0;
      const Ch = useNative ? NativeChannel : WebChannel;
      const done = id => this._onComplete(id);
      this.channels = [new Ch('onda-a', done), new Ch('onda-b', done)];
      this.ready = this._init();
    }

    async _init() {
      if (useNative) {
        try { await NA.configure({ fade: false, focus: true, background: true }); } catch (e) { /* older plugin */ }
        try { await NA.addListener('complete', ev => this._onComplete(ev && ev.assetId)); } catch (e) { /* ignore */ }
      }
      setInterval(() => this._tick(), POLL_MS);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this._tick(); });
      }
    }

    /* events */
    on(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); return this; }
    emit(evt, payload) { (this._listeners[evt] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } }); }

    /* accessors */
    get cur() { return this.channels[this.active]; }
    get standby() { return this.channels[this.active ^ 1]; }
    get paused() { return !this._playing; }
    get duration() { return this.cur.duration || (this.currentTrack && this.currentTrack.duration) || 0; }
    get currentTime() { return this._time; }
    set currentTime(t) { this.seek(t); }
    get volume() { return this._master; }
    set volume(v) { this._master = v; if (!this.crossfading) this.cur.setVolume(v); }
    get playbackRate() { return this._rate; }
    set playbackRate(r) { this._rate = r; this.channels.forEach(c => c.setRate(r)); }

    /* ── transport ───────────────────────────────────────────────────────────── */
    async playTrack(track) {
      await this.ready;
      const token = ++this._playToken;
      this._fadeToken++;
      this._cancelSchedule();
      this.crossfading = false;
      this._time = 0;

      const usePreloaded = this.standby.trackId === track.id && this.standby.state === 'ready';
      if (usePreloaded) {
        const old = this.cur;
        this.active ^= 1;
        old.stop().catch(() => {});
      } else {
        await Promise.all(this.channels.filter(c => c !== this.cur).map(c => c.stop()));
        await this.cur.stop();
        const ok = await this.cur.load(track);
        if (!ok || token !== this._playToken) return;
      }
      if (token !== this._playToken) return;

      const ch = this.cur;
      ch.setRate(this._rate);
      await ch.setVolume(this._master);
      await ch.play();
      if (token !== this._playToken) return;

      this.currentTrack = track;
      this._playing = true;
      this.emit('loaded', { track, duration: ch.duration });
      this.emit('state', { playing: true });
      this.refreshPreload();
    }

    async play() {
      if (!this.currentTrack) return;
      const c = this.cur;
      this._playing = true;
      if (c.state === 'ended') { c.state = 'ready'; }
      if (c.state === 'paused' || c.state === 'ready') await c.play();
      if (this.crossfading) {
        const o = this.standby;
        if (o.state === 'paused') o.play().catch(() => {});
      }
      this.emit('state', { playing: true });
    }

    pause() {
      this._playing = false;
      this._fadeToken++;
      this.channels.forEach(c => { if (c.state === 'playing') c.pause().catch(() => {}); });
      this.emit('state', { playing: false });
    }

    async seek(t) {
      if (!this.currentTrack) return;
      const d = this.duration;
      t = Math.max(0, d ? Math.min(t, Math.max(0, d - 0.05)) : t);
      this._time = t;
      this._cancelSchedule();
      await this.cur.seek(t);
    }

    stop() {
      this._playToken++;
      this._fadeToken++;
      this._cancelSchedule();
      this._playing = false;
      this.crossfading = false;
      this.currentTrack = null;
      this._time = 0;
      this.channels.forEach(c => c.stop().catch(() => {}));
      this.emit('state', { playing: false });
    }

    async fadeOutAndPause(ms) {
      const token = ++this._fadeToken;
      const t0 = performance.now();
      const start = this._master;
      await new Promise(res => {
        const step = () => {
          if (token !== this._fadeToken) return res();
          const p = Math.min((performance.now() - t0) / ms, 1);
          this.cur.setVolume(start * (1 - p));
          if (p < 1) setTimeout(step, 100); else res();
        };
        step();
      });
      if (token !== this._fadeToken) return;
      this.pause();
      this.cur.setVolume(this._master);
    }

    /* ── next-track preloading (gapless) ─────────────────────────────────────── */
    refreshPreload() {
      this._cancelSchedule();
      if (this.crossfading) return;
      const next = this.getNext();
      const s = this.standby;
      if (!next || !next.track) { if (s.state !== 'empty') s.stop().catch(() => {}); return; }
      if (s.trackId === next.track.id && s.state !== 'empty') return;
      s.load(next.track).catch(err => console.warn('preload failed', err));
    }

    _cancelSchedule() {
      if (this._scheduled) { clearTimeout(this._scheduled.timer); this._scheduled = null; }
    }

    /* ── polling loop: progress events + transition scheduling ───────────────── */
    async _tick() {
      if (this._ticking || !this._playing || !this.currentTrack) return;
      this._ticking = true;
      try {
        const c = this.cur;
        const t = await c.getTime();
        if (!this._playing) return;
        this._time = t;
        if (!c.duration && c.state === 'playing') {
          if (useNative) { try { const d = await NA.getDuration({ assetId: c.id }); c.duration = (d && d.duration) || 0; } catch (e) { /* ignore */ } }
          else c.duration = c.a.duration || 0;
        }
        const d = c.duration;
        this.emit('timeupdate', { currentTime: t, duration: d });
        if (this.crossfading || !d) return;

        const remaining = d - t;
        const xf = this.settings.crossfade >= 0.5 ? this.settings.crossfade : 0;

        if (xf) {
          if (remaining <= xf + 0.05 && remaining > 0.1) this._advance(Math.min(xf, remaining));
        } else if (this.settings.gapless) {
          const cid = this.currentTrack.id;
          if (remaining <= 1.2 && (!this._scheduled || this._scheduled.trackId !== cid)) {
            this._cancelSchedule();
            const delay = Math.max(0, (remaining - GAPLESS_LEAD) * 1000 - 25);
            this._scheduled = { trackId: cid, timer: setTimeout(() => { this._scheduled = null; this._advance(0); }, delay) };
          }
        }
      } finally { this._ticking = false; }
    }

    /* Start the standby channel and (optionally) crossfade into it. */
    async _advance(fadeSec) {
      if (this.crossfading) return;
      const next = this.getNext();
      if (!next || !next.track) return;
      const from = this.cur, to = this.standby;
      const token = this._playToken;
      this.crossfading = true;
      this._cancelSchedule();
      try {
        if (to.trackId !== next.track.id || to.state === 'empty' || to.state === 'loading') {
          const ok = await to.load(next.track);
          if (!ok) { this.crossfading = false; return; }
        }
        if (token !== this._playToken) { this.crossfading = false; return; }
        const ramp = fadeSec >= 0.2;
        to.setRate(this._rate);
        await to.setVolume(ramp ? 0 : this._master);
        await to.play();
        if (token !== this._playToken) { this.crossfading = false; return; }
      } catch (e) {
        this.crossfading = false;
        this.emit('error', e);
        return;
      }

      // flip logical channel right away so the UI/timeline follow the new track
      this.active ^= 1;
      this.currentTrack = next.track;
      this._time = 0;
      this.emit('loaded', { track: next.track, duration: to.duration });
      this.emit('transition', { track: next.track, index: next.index });

      if (!ramp_(fadeSec)) {
        setTimeout(() => from.stop().catch(() => {}), 160);
        this.crossfading = false;
        this.refreshPreload();
        return;
      }

      const t0 = performance.now(), dur = fadeSec * 1000, master = this._master;
      await new Promise(res => {
        const step = () => {
          if (token !== this._playToken) return res();
          const p = Math.min((performance.now() - t0) / dur, 1);
          from.setVolume(master * Math.cos(p * Math.PI / 2));
          to.setVolume(master * Math.sin(p * Math.PI / 2));
          if (p < 1) setTimeout(step, 33); else res();
        };
        step();
      });
      if (token !== this._playToken) return;
      await from.stop();
      await to.setVolume(master);
      this.crossfading = false;
      this.refreshPreload();
    }

    /* A channel finished by itself. */
    _onComplete(assetId) {
      const ch = this.channels.find(c => c.id === assetId);
      if (!ch || ch !== this.cur || this.crossfading || !this._playing) return;
      ch.state = 'ended';
      // Backgrounded apps may miss the timer — if a next track is queued, just start it.
      if ((this.settings.gapless || this.settings.crossfade >= 0.5) && this.getNext()) { this._advance(0); return; }
      this._playing = false;
      this.emit('state', { playing: false });
      this.emit('ended', { track: this.currentTrack });
    }
  }

  function ramp_(s) { return s >= 0.2; }

  global.NativeAudioEngine = NativeAudioEngine;
})(window);
