/* ─────────────────────────────────────────────────────────────────────────────
 * ServiceEngine (Android)
 *
 * Drop-in replacement for NativeAudioEngine that hands playback to the native foreground
 * service (OndaPlaybackService: ExoPlayer + MediaSession, see native/android/).
 *
 *  • The player lives in the service, not in the WebView → keeps playing with the screen off /
 *    app in the background, and shows the media notification + lock-screen controls.
 *  • The WebView sends a WINDOW of upcoming tracks (plan). The service advances through it by
 *    itself (gapless); JS tops the window up whenever it is awake.
 *  • Notification buttons (next / previous / play / pause / seek) act on that same window.
 *
 * Not available in this engine: crossfade and playback speed.
 * ───────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const Cap = global.Capacitor;
  const isAndroid = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform() &&
                       Cap.getPlatform && Cap.getPlatform() === 'android');
  if (!isAndroid) return;                                  // iOS / browser keep the generic engine

  let P = null;
  try { P = (Cap.Plugins && Cap.Plugins.OndaPlayer) || Cap.registerPlugin('OndaPlayer'); } catch (e) { /* ignore */ }
  if (!P) return;

  const WINDOW = 60;         // tracks handed to the service at once
  const TOP_UP_AT = 15;      // when fewer than this many are left, send more
  const POLL_MS = 1000;            // UI refresh while the screen is on and music is playing (the service itself needs no polling)
  const POLL_FAST_MS = 300;        // only while synced lyrics are on screen

  class ServiceEngine {
    constructor() {
      this.isNative = true;
      this.serviceBased = true;
      this.supportsRate = false;
      this.settings = { gapless: true, crossfade: 0, speed: 1 };
      this.getNext = () => null;
      this.extendPlan = () => [];            // (afterQueueIndex, count) → [{track,index}]   (set by index.html)
      this.isRepeatOne = () => false;        // set by index.html
      this.currentTrack = null;
      this._listeners = {};
      this._plan = [];                       // parallel to the service's playlist: [{track,index}]
      this._nativeIndex = 0;
      this._playing = false;
      this._time = 0;
      this._dur = 0;
      this._token = 0;
      this._polling = false;
      this._master = 1;
      this._rate = 1;
      this.ready = this._init();
    }

    async _init() {
      try {
        await P.init();
      } catch (e) {
        console.error('Player service failed to start', e);
        this.emit('error', e);
        return;
      }
      P.addListener('mediaChanged', ev => this._onMedia(ev));
      P.addListener('playState', ev => {
        const playing = !!(ev && ev.playing);
        if (playing === this._playing) return;
        this._playing = playing;
        this.emit('state', { playing });
      });
      P.addListener('ended', () => {
        // the service ran out of queued tracks (window exhausted or end of queue)
        this._playing = false;
        this.emit('state', { playing: false });
        this.emit('ended', { track: this.currentTrack });
      });
      P.addListener('playerError', ev => console.warn('player error', ev));
      // no timer at all while the screen is off or nothing plays: one chained timeout, re-armed by events
      this._pt = 0;
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.sync(); this._arm(); } else { clearTimeout(this._pt); this._pt = 0; } });
    }

    on(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); return this; }
    emit(evt, payload) {
      (this._listeners[evt] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
      if (evt === 'state' || evt === 'loaded') this._arm();       // (re)start the screen-on refresh whenever playback starts
    }

    get paused() { return !this._playing; }
    get duration() { return this._dur || (this.currentTrack && this.currentTrack.duration) || 0; }
    get currentTime() { return this._time; }
    set currentTime(t) { this.seek(t); }
    get volume() { return this._master; }
    set volume(v) { this._master = v; P.setVolume({ volume: v }).catch(() => {}); }
    get playbackRate() { return 1; }
    set playbackRate(r) { /* not supported by the native service */ }

    /* ── helpers ─────────────────────────────────────────────────────────────── */
    _art(track) {
      const N = global.OndaNative;
      try { return N && N.artUri ? N.artUri(track) : Promise.resolve(''); } catch (e) { return Promise.resolve(''); }
    }
    _mk(track, artUri) {
      return {
        id: track.id,
        uri: track.contentUri || track.url,
        title: track.title || track.name || '',
        artist: track.artist || '',
        album: track.album || '',
        artUri: artUri || '',
      };
    }
    /** Builds items without ever waiting long for artwork; late artwork is attached afterwards. */
    async _items(entries, waitMs, token) {
      const N = global.OndaNative;
      const TIMEOUT = {};
      const items = await Promise.all(entries.map(async e => {
        const p = this._art(e.track);
        const uri = await Promise.race([p, new Promise(r => setTimeout(() => r(TIMEOUT), waitMs))]);
        if (uri === TIMEOUT) {
          p.then(u => { if (u && (token == null || token === this._token)) N.setArtwork(e.track.id, u); });
          return this._mk(e.track, '');
        }
        return this._mk(e.track, uri);
      }));
      return items;
    }

    _planTail(afterIndex, count) {
      let list = [];
      try { list = this.extendPlan(afterIndex, count) || []; } catch (e) { console.warn(e); }
      return list;
    }

    /* ── transport ───────────────────────────────────────────────────────────── */
    async playTrack(track, queueIndex) {
      await this.ready;
      const token = ++this._token;
      const first = { track, index: queueIndex };

      // 1) START IMMEDIATELY with just this track (artwork only if it is already prepared)
      this._plan = [first];
      this._nativeIndex = 0;
      this.currentTrack = track;
      this._time = 0;
      this._dur = track.duration || 0;
      const [item0] = await this._items([first], 40, token);
      if (token !== this._token) return;
      const repeatOne = !!this.isRepeatOne();
      await P.setQueue({ items: [item0], startIndex: 0, positionMs: 0, play: true, repeatOne });
      if (token !== this._token) return;
      this._playing = true;
      this.emit('loaded', { track, duration: this._dur });
      this.emit('state', { playing: true });

      // 2) queue the upcoming tracks in the background (gapless continues from here)
      const tail = this._planTail(queueIndex, WINDOW - 1);
      if (!tail.length) return;
      const items = await this._items(tail, 600, token);
      if (token !== this._token) return;
      this._plan = [first].concat(tail);
      try { await P.setTail({ items, repeatOne }); } catch (e) { console.warn(e); }
    }

    async play() {
      if (!this.currentTrack) return;
      this._playing = true;
      this.emit('state', { playing: true });
      try { await P.play(); } catch (e) { console.warn(e); }
    }

    pause() {
      this._playing = false;
      this.emit('state', { playing: false });
      P.pause().catch(() => {});
    }

    async seek(t) {
      if (!this.currentTrack) return;
      t = Math.max(0, t);
      this._time = t;
      try { await P.seek({ positionMs: Math.round(t * 1000) }); } catch (e) { /* ignore */ }
    }

    stop() {
      this._token++;
      this._playing = false;
      this.currentTrack = null;
      this._plan = [];
      this._time = 0;
      P.stop().catch(() => {});
      this.emit('state', { playing: false });
    }

    fadeOutAndPause(ms) {
      this._playing = false;
      P.fadeOutAndPause({ ms }).catch(() => {});
      setTimeout(() => this.emit('state', { playing: false }), ms + 100);
    }

    /** Next / previous when the service already holds that item: no new queue, no re-buffering. */
    fastSkip(dir, queueIndex) {
      if (!this.currentTrack) return false;
      const e = this._plan[this._nativeIndex + dir];
      if (!e || !e.track || !e.track.id || e.index !== queueIndex) return false;
      (dir > 0 ? P.next() : P.previous()).catch(() => {});
      this._playing = true;
      this._time = 0;
      return true;
    }

    /* The upcoming order changed (shuffle / repeat toggled, queue edited) → rebuild the tail. */
    async refreshPreload() {
      if (!this.currentTrack || !this._plan.length) return;
      const cur = this._plan[Math.min(this._nativeIndex, this._plan.length - 1)];
      if (!cur) return;
      const tail = this._planTail(cur.index, WINDOW - 1);
      const items = await this._items(tail, 600, this._token);
      this._plan = this._plan.slice(0, this._nativeIndex + 1).concat(tail);
      try { await P.setTail({ items, repeatOne: !!this.isRepeatOne() }); } catch (e) { console.warn(e); }
    }

    /** Songs were deleted from the phone: forget them in the plan and in the service queue, re-point the plan at the edited queue, rebuild the tail. */
    async dropTracks(ids, queue) {
      const set = new Set(ids || []);
      if (!set.size || !this._plan.length) return;
      const cur = this._plan[this._nativeIndex];
      this._plan = this._plan.filter(e => e === cur || !set.has(e.track.id));
      this._nativeIndex = Math.max(0, this._plan.indexOf(cur));
      for (const e of this._plan) { const i = (queue || []).findIndex(t => t.id === e.track.id); if (i >= 0) e.index = i; }
      try { await P.removeItems({ ids: [...set] }); } catch (e) { console.warn(e); }
      try { await this.refreshPreload(); } catch (e) { console.warn(e); }
    }

    /** queue index that will play after the current track (so the UI's "next" matches the service) */
    nextQueueIndex() {
      const e = this._plan[this._nativeIndex + 1];
      return e ? e.index : -1;
    }

    /* ── keeping JS in step with the service ─────────────────────────────────── */
    _onMedia(ev) {
      if (!ev) return;
      if (this.currentTrack && ev.id === this.currentTrack.id && ev.index === this._nativeIndex) return;
      let i = ev.index;
      if (!(this._plan[i] && this._plan[i].track.id === ev.id)) i = this._plan.findIndex(e => e.track.id === ev.id);
      if (i < 0) return;
      const entry = this._plan[i];
      this._nativeIndex = i;
      if (this.currentTrack && this.currentTrack.id === entry.track.id && ev.reason === 0) { this._time = 0; return; } // repeat-one loop
      this.currentTrack = entry.track;
      this._time = 0;
      this._dur = entry.track.duration || 0;
      this.emit('loaded', { track: entry.track, duration: this._dur });
      this.emit('transition', { track: entry.track, index: entry.index });
      this._topUp();
    }

    async _topUp() {
      const left = this._plan.length - 1 - this._nativeIndex;
      if (left >= TOP_UP_AT || !this._plan.length) return;
      const last = this._plan[this._plan.length - 1];
      const more = this._planTail(last.index, WINDOW - left);
      if (!more.length) return;
      const items = await this._items(more, 600, this._token);
      this._plan = this._plan.concat(more);
      try { await P.append({ items }); } catch (e) { console.warn(e); }
    }

    /** Re-read the service state (called when the app comes back to the foreground). */
    async sync() {
      if (this._busy) return;
      this._busy = true;
      try {
        const s = await P.getState();
        if (!s) return;
        this._time = (s.positionMs || 0) / 1000;
        if (s.durationMs) this._dur = s.durationMs / 1000;
        const playing = !!s.playWhenReady && s.state !== 4;
        if (s.id) this._onMedia({ index: s.index, id: s.id, reason: 1 });
        if (playing !== this._playing) { this._playing = playing; this.emit('state', { playing }); }
        if (this.currentTrack) {
          this.emit('timeupdate', { currentTime: this._time, duration: this.duration });
          if (this._dur && this.currentTrack && !this.currentTrack.duration) this.currentTrack.duration = this._dur;
        }
        this._topUp();
      } catch (e) { /* service not ready */ }
      finally { this._busy = false; }
    }

    _tick() {
      this._pt = 0;
      if (document.hidden || !this.currentTrack || !this._playing) return;   // no UI to update → don't wake the bridge, don't re-arm
      this.sync();
      this._arm();
    }
    _arm() {
      if (this._pt || document.hidden || !this._playing || !this.currentTrack) return;
      const fast = typeof global.__fastPoll === 'function' && global.__fastPoll();
      this._pt = setTimeout(() => this._tick(), fast ? POLL_FAST_MS : POLL_MS);
    }

    /** The app was relaunched while the service kept playing: report what it is playing. */
    async peek() {
      try { await this.ready; const s = await P.getState(); return s && s.id && s.count ? s : null; } catch (e) { return null; }
    }
    /** Re-attach to a track the service is already playing (after the activity was recreated). */
    attach(track, queueIndex, state) {
      this.currentTrack = track;
      const at = Math.max(0, (state && state.index) || 0);
      this._plan = [];
      for (let i = 0; i < at; i++) this._plan.push({ track: { id: '' }, index: -1 });   // already-played slots
      this._plan.push({ track, index: queueIndex });
      this._nativeIndex = at;
      this._playing = !!(state && state.playWhenReady);
      this._time = ((state && state.positionMs) || 0) / 1000;
      this._dur = ((state && state.durationMs) || 0) / 1000 || track.duration || 0;
      this.emit('loaded', { track, duration: this._dur });
      this.emit('state', { playing: this._playing });
      this.refreshPreload();
    }
  }

  global.NativeAudioEngine = ServiceEngine;
})(window);
