/* OndaEQ — 10-band equalizer (data, presets, curve maths, web fallback).
 *
 * Android: the sound is shaped inside the native player service (native/android/OndaPlaybackService.java —
 * ten peaking filters + preamp on the PCM stream, so it also works with the screen off).
 * Browser / iOS: the same filters as a Web Audio chain on the <audio> elements. */
(function (g) {
  'use strict';
  const FREQ = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
  const Q = 1.41;
  const RANGE = 12;
  const PRESETS = [
    { name: 'Flat',          g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'Bass Boost',    g: [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0] },
    { name: 'Bass Reducer',  g: [-5, -4, -3, -1.5, 0, 0, 0, 0, 0, 0] },
    { name: 'Treble Boost',  g: [0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6] },
    { name: 'Vocal',         g: [-2, -2, -1, 1, 3, 4, 3.5, 2, 0, -1] },
    { name: 'Rock',          g: [5, 4, 2.5, 1, -1, -1.5, 0.5, 2.5, 4, 5] },
    { name: 'Pop',           g: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
    { name: 'Hip-Hop',       g: [5, 4.5, 2, 3, -0.5, -0.5, 1.5, -0.5, 2, 3] },
    { name: 'Electronic',    g: [5, 4, 1, 0, -2, 2, 0, 1.5, 4, 5] },
    { name: 'Jazz',          g: [3, 2, 1, 2, -1.5, -1.5, 0, 1, 2, 3] },
    { name: 'Classical',     g: [4, 3, 2.5, 2, -1, -1, 0, 2, 3, 3.5] },
    { name: 'Acoustic',      g: [4, 4, 3, 1, 1.5, 1.5, 3, 3, 3, 2] },
    { name: 'Loudness',      g: [6, 4, 0, 0, -1, 0, -0.5, 0, 3, 5] },
    { name: 'Spoken word',   g: [-3, -2, 0, 1, 3, 4, 4, 3, 1, -2] },
  ];

  const clampGain = v => Math.max(-RANGE, Math.min(RANGE, Math.round(v * 2) / 2));

  /** magnitude (dB) of one RBJ peaking filter at frequency f */
  function peakDb(f0, gDb, f, fs) {
    if (Math.abs(gDb) < 0.01) return 0;
    const A = Math.pow(10, gDb / 40), w0 = 2 * Math.PI * f0 / fs, al = Math.sin(w0) / (2 * Q), cs = Math.cos(w0);
    const a0 = 1 + al / A;
    const b0 = (1 + al * A) / a0, b1 = (-2 * cs) / a0, b2 = (1 - al * A) / a0, a1 = b1, a2 = (1 - al / A) / a0;
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  /** combined response in dB at n log-spaced points between 20 Hz and 20 kHz */
  function response(gains, n) {
    n = n || 64;
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = 20 * Math.pow(1000, i / (n - 1));
      let db = 0;
      for (let b = 0; b < 10; b++) db += peakDb(FREQ[b], gains[b] || 0, f, 44100);
      out.push(db);
    }
    return out;
  }
  function presetName(gains) {
    const p = PRESETS.find(x => x.g.every((v, i) => Math.abs(v - (gains[i] || 0)) < 0.01));
    return p ? p.name : 'Custom';
  }
  function defaults() { return { on: false, preset: 'Flat', gains: new Array(10).fill(0), pre: 0 }; }
  /** accepts whatever was saved before and returns a valid state */
  function normalize(s) {
    const d = defaults();
    if (!s || typeof s !== 'object') return d;
    d.on = !!s.on;
    if (Array.isArray(s.gains)) d.gains = d.gains.map((_, i) => clampGain(Number(s.gains[i]) || 0));
    d.pre = Math.max(-RANGE, Math.min(RANGE, Math.round((Number(s.pre) || 0) * 2) / 2));
    d.preset = presetName(d.gains);
    return d;
  }

  /* ── Web Audio fallback (browser / iOS) ───────────────────────────────────── */
  let ctx = null, filters = null, preGain = null;
  const hooked = new Map();            // <audio> → MediaElementSource
  let wanted = null;
  function build() {
    if (ctx) return true;
    const AC = g.AudioContext || g.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      filters = FREQ.map(f => { const b = ctx.createBiquad ? ctx.createBiquad() : ctx.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.Q.value = Q; b.gain.value = 0; return b; });
      preGain = ctx.createGain();
      filters.reduce((a, b) => { a.connect(b); return b; }, filters[0]).connect(preGain);
      preGain.connect(ctx.destination);
      return true;
    } catch (e) { ctx = null; return false; }
  }
  function attach(el) {
    if (!ctx || hooked.has(el)) return;
    try { const src = ctx.createMediaElementSource(el); src.connect(filters[0]); hooked.set(el, src); } catch (e) { /* already routed */ }
  }
  const EQ = {
    FREQ, LABELS, PRESETS, RANGE, response, presetName, defaults, normalize, clampGain,
    /** called by the web audio channels for every <audio> element they create */
    hookAudio(el) {
      el.addEventListener('play', () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); });
      if (wanted && wanted.on) { if (build()) attach(el); } else hooked.set(el, null);
    },
    applyWeb(state) {
      wanted = state;
      if (state.on && build()) {
        for (const [el, src] of hooked) if (!src) { hooked.delete(el); attach(el); }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      }
      if (!ctx) return;
      const maxBoost = Math.max(0, ...state.gains);
      filters.forEach((f, i) => { f.gain.value = state.on ? state.gains[i] : 0; });
      preGain.gain.value = state.on ? Math.pow(10, (state.pre - 0.6 * maxBoost) / 20) : 1;
    },
  };
  g.OndaEQ = EQ;
})(window);
