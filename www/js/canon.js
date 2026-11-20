/* OndaCanon — makes messy tags agree with each other.
 *
 *   "Hip-Hop" = "Hip Hop" = "hip hop" = "Hip-Hop/Rap" = "Rap"        → Hip-Hop
 *   "Jay Z" = "Jay-Z" = "JAY-Z" = "Jay-Z feat. Beyoncé"              → Jay-Z   (most common / best-written spelling wins)
 *   "Pop, Pop" = "Pop;Pop" = "pop" = "(13)"                           → Pop
 *   "Beyoncé" = "Beyonce",  "The Beatles" = "Beatles",  "AC/DC" = "ACDC"
 *
 * Pipeline (all pure, no DOM):
 *   1. key()      — fold case, accents, punctuation, "&"/"and", leading "The"  → comparison key
 *   2. split      — multi-value genres on ; / , | and artist "feat." credits
 *   3. aliases    — hand-made table for well known synonyms (hiphop/rap, rnb/r&b, dnb/drum and bass …)
 *   4. fuzzy      — leftover genre keys that differ by one typo / a plural 's' are merged
 *   5. voting     — every key group is shown with its most common spelling (ties: mixed case, accents, punctuation)
 *
 * apply(library) rewrites track.artist / albumArtist / album / genre / genres from the *Raw fields,
 * so it is idempotent and can run after every library change.
 */
(function (g) {
  'use strict';

  /* ── 1. comparison keys ─────────────────────────────────────────────────── */
  function fold(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')         // accents (Latin only; keeps Japanese dakuten)
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/[‘’ʼ`´]/g, "'")
      .replace(/\s*&\s*/g, ' and ')
      .replace(/\b(?:n|\'n\'|\'n)\b/g, ' and ');                    // rock n roll / rock 'n' roll
  }
  // libraries repeat the same few hundred strings thousands of times → memoise the string functions
  function memo(fn) { const m = new Map(); return s => { let v = m.get(s); if (v === undefined) { v = fn(s); if (m.size > 20000) m.clear(); m.set(s, v); } return v; }; }
  const key = memo(s => fold(s).replace(/[^\p{L}\p{N}]+/gu, ''));
  const artistKey = memo(s => fold(s).replace(/^\s*the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ''));

  /* ── 2. splitting ───────────────────────────────────────────────────────── */
  const ID3V1 = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','Alternative Rock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock'];

  function splitGenres(raw) {
    let s = String(raw == null ? '' : raw).replace(/\u0000/g, ';');
    // ID3v1 "(13)" / "(13)Pop" / "13"
    s = s.replace(/\((\d{1,3})\)/g, (m, n) => ';' + (ID3V1[+n] || '') + ';');
    if (/^\s*\d{1,3}\s*$/.test(s)) s = ID3V1[+s] || '';
    s = s.replace(/\((?:RX|CR)\)/gi, ';');
    return s.split(/[;\/\\|,]+|\s{2,}|\s+[-–—]\s+/).map(x => x.trim()).filter(Boolean);
  }

  const FEAT = /\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring)\b[^\)\]]*[\)\]]/ig;
  const FEAT_INLINE = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
  /** "Drake feat. Future" → "Drake";  "A; B" → "A";  "AC/DC", "Earth, Wind & Fire", "Tyler, The Creator" stay intact */
  const primaryArtist = memo(primaryArtistRaw);
  function primaryArtistRaw(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    s = s.replace(FEAT, '').replace(FEAT_INLINE, '');
    s = s.split(/\s*;\s*|\s+\/\s+|\s+&\s+(?=feat)/i)[0];
    return s.trim();
  }

  /* ── 3. aliases (key → display, or array for composites) ────────────────── */
  const ALIAS_SRC = {
    'Hip-Hop': ['hiphop', 'rap', 'hiphoprap', 'rapandhiphop', 'hiphopandrap', 'gangstarap', 'hardcorerap', 'undergroundhiphop', 'undergroundrap', 'eastcoasthiphop', 'westcoasthiphop', 'southernhiphop', 'dirtysouth', 'rapmusic', 'hiphopmusic', 'oldschoolhiphop', 'boombap', 'conscioushiphop', 'alternativehiphop', 'alternativerap'],
    'R&B': ['rnb', 'randb', 'rhythmandblues', 'contemporaryrandb', 'contemporaryrnb', 'rnbmusic', 'alternativernb', 'alternativerandb', 'urbanrnb'],
    'Electronic': ['electronic', 'electronica', 'edm', 'electronicdance', 'electronicdancemusic', 'electro', 'electronicmusic', 'electropop'],
    'Dance': ['dance', 'dancemusic', 'dancepop', 'club'],
    'Alternative': ['alternative', 'alt', 'altrock', 'alternativerock', 'alternativemusic', 'indiealternative', 'alternativeandpunk', 'alternativeindie'],
    'Rock & Roll': ['rockandroll', 'rocknroll', 'rockroll', 'rockandrollmusic'],
    'Drum & Bass': ['drumandbass', 'dnb', 'drumnbass', 'drumbass', 'drumandbassmusic'],
    'K-Pop': ['kpop', 'koreanpop', 'kpopmusic'],
    'J-Pop': ['jpop', 'japanesepop', 'jpopmusic'],
    'Lo-Fi': ['lofi', 'lofihiphop', 'lofibeats'],
    'Synth-Pop': ['synthpop', 'synthpopmusic'],
    'Soundtrack': ['soundtrack', 'soundtracks', 'ost', 'filmscore', 'score', 'film', 'movie', 'movies', 'originalsoundtrack', 'videogamesoundtrack', 'filmmusic', 'tvsoundtrack', 'motionpicturesoundtrack'],
    'Country': ['country', 'countrymusic', 'countrywestern', 'countryandwestern', 'countrypop'],
    'Latin': ['latin', 'latinmusic', 'latino', 'latinpop', 'musicalatina'],
    'World': ['world', 'worldmusic', 'worldbeat', 'international'],
    'Gospel': ['gospel', 'christiangospel', 'gospelchristian'],
    'Pop': ['pop', 'popmusic', 'popular', 'top40', 'topforty', 'popsong'],
    'Metal': ['metal', 'heavymetal', 'metalmusic'],
    'Classical': ['classical', 'classicalmusic', 'orchestral'],
    'Jazz': ['jazz', 'jazzmusic'],
    'Rock': ['rock', 'rockmusic'],
    'Blues': ['blues', 'bluesmusic'],
    'Folk': ['folk', 'folkmusic'],
    'Soul': ['soul', 'soulmusic'],
    'Reggae': ['reggae', 'reggaemusic'],
    'Punk': ['punk', 'punkrock', 'punkmusic'],
    'Indie': ['indie', 'indiemusic'],
    'Funk': ['funk', 'funkmusic'],
    'Ambient': ['ambient', 'ambientmusic'],
    'Instrumental': ['instrumental', 'instrumentals'],
  };
  const COMPOSITE_SRC = {
    'rnbhiphop': ['R&B', 'Hip-Hop'], 'hiphoprnb': ['R&B', 'Hip-Hop'], 'hiphopandrnb': ['R&B', 'Hip-Hop'], 'rnbandhiphop': ['R&B', 'Hip-Hop'],
    'rnbsoul': ['R&B', 'Soul'], 'rnbandsoul': ['R&B', 'Soul'], 'soulrnb': ['R&B', 'Soul'], 'soulandrnb': ['R&B', 'Soul'],
    'poprock': ['Pop', 'Rock'], 'rockpop': ['Pop', 'Rock'],
  };
  const UNKNOWN = new Set(['', 'unknown', 'unknowngenre', 'other', 'none', 'blank', 'genre', 'undefined', 'null', 'misc', 'miscellaneous', 'unclassifiable', 'unclassified', 'notset', 'nogenre', 'na', 'various']);
  const ALIAS = new Map();
  for (const disp of Object.keys(ALIAS_SRC)) for (const k of ALIAS_SRC[disp]) ALIAS.set(k, disp);
  for (const k of Object.keys(COMPOSITE_SRC)) ALIAS.set(k, COMPOSITE_SRC[k]);

  /* ── 4. fuzzy ───────────────────────────────────────────────────────────── */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function sameGenre(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (la >= 4 && lb >= 4 && (a === b + 's' || b === a + 's')) return true;            // soundtrack / soundtracks
    const min = Math.min(la, lb);
    if (min >= 11) return editDistance(a, b, 2) <= 2;
    if (min >= 7) return editDistance(a, b, 1) <= 1;
    return false;
  }

  /* ── 5. display names ───────────────────────────────────────────────────── */
  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-\/(])([\p{L}])/gu, (m, p, c) => p + c.toUpperCase());
  }
  function quality(s, punct) {                             // tie-breaker: prefer the "properly written" variant
    let q = 0;
    if (/[a-z]/.test(s) && /[A-Z]/.test(s)) q += 4;        // Mixed Case beats ALLCAPS / lowercase
    if (/[^\u0000-\u007f]/.test(s)) q += 2;                // diacritics: Beyoncé > Beyonce
    if (punct && /[-.'&!$]/.test(s)) q += 1;               // official punctuation: Jay-Z > Jay Z  (names only, not genres)
    return q;
  }
  function pickDisplay(counts, punct) {                    // counts: Map(spelling → n)
    let best = null, bn = -1, bq = -1;
    for (const [s, n] of counts) {
      const q = quality(s, punct);
      if (n > bn || (n === bn && q > bq) || (n === bn && q === bq && best && s.length > best.length)) { best = s; bn = n; bq = q; }
    }
    return best;
  }
  function tidyCase(s) {
    if (s === s.toLowerCase() || s === s.toUpperCase()) return s.length <= 3 && s === s.toUpperCase() ? s : titleCase(s);
    return s;
  }

  /* ── building the maps over a whole library ─────────────────────────────── */
  function groupVote(pairs) {                              // pairs: [[key, spelling], …] → Map(key → display)
    const byKey = new Map();
    for (const [k, s] of pairs) {
      if (!k || !s) continue;
      let m = byKey.get(k);
      if (!m) { m = new Map(); byKey.set(k, m); }
      m.set(s, (m.get(s) || 0) + 1);
    }
    const out = new Map();
    for (const [k, counts] of byKey) out.set(k, pickDisplay(counts, true));   // names keep their spelling (AC/DC, JAY-Z)
    return out;
  }

  function buildGenreMap(rawGenres) {
    // 1. every individual genre token with its frequency
    const tokens = new Map();                              // key → Map(spelling → n)
    for (const raw of rawGenres) {
      for (const tok of splitGenres(raw)) {
        const k = key(tok);
        if (!k || UNKNOWN.has(k)) continue;
        let m = tokens.get(k); if (!m) { m = new Map(); tokens.set(k, m); }
        m.set(tok, (m.get(tok) || 0) + 1);
      }
    }
    // 2. aliases → fixed display; the rest are clustered by fuzzy equality (most frequent key is the cluster head)
    const resolved = new Map();                            // key → display | [display…]
    const rest = [];
    for (const [k, counts] of tokens) {
      if (ALIAS.has(k)) resolved.set(k, ALIAS.get(k));
      else { let n = 0; for (const c of counts.values()) n += c; rest.push({ k, counts, n }); }
    }
    rest.sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));
    const clusters = [];
    for (const item of rest) {
      let home = null;
      for (const c of clusters) if (sameGenre(c.k, item.k)) { home = c; break; }
      if (!home) { home = { k: item.k, counts: new Map() }; clusters.push(home); }
      for (const [s, n] of item.counts) home.counts.set(s, (home.counts.get(s) || 0) + n);
      item.cluster = home;
      resolved.set(item.k, home);
    }
    for (const c of clusters) c.display = tidyCase(pickDisplay(c.counts, false));
    for (const [k, v] of resolved) if (v && v.display) resolved.set(k, v.display);
    return resolved;
  }

  function genresFor(raw, map) {
    const out = [], seen = new Set();
    for (const tok of splitGenres(raw)) {
      const k = key(tok);
      if (!k || UNKNOWN.has(k)) continue;
      const v = map.get(k) || tidyCase(tok);
      for (const d of (Array.isArray(v) ? v : [v])) { const dk = key(d); if (!seen.has(dk)) { seen.add(dk); out.push(d); } }
    }
    return out;
  }

  /** Rewrites artist / albumArtist / album / genre(s) of every track from its *Raw fields. */
  function apply(library) {
    for (const t of library) {                             // remember what the file really says
      if (t.artistRaw == null || t.artistRaw === '') t.artistRaw = t.artist || '';
      if (t.albumArtistRaw == null || t.albumArtistRaw === '') t.albumArtistRaw = t.albumArtist || '';
      if (t.albumRaw == null || t.albumRaw === '') t.albumRaw = t.album || '';
      if (t.genreRaw == null || t.genreRaw === '') t.genreRaw = t.genre || '';
    }
    // artists (track artist and album artist share one namespace so they unify)
    const pairs = [];
    for (const t of library) {
      const a = primaryArtist(t.artistRaw); if (a) pairs.push([artistKey(a), a]);
      const b = primaryArtist(t.albumArtistRaw); if (b) pairs.push([artistKey(b), b]);
    }
    const artistMap = groupVote(pairs);
    const artistOf = raw => { const p = primaryArtist(raw); if (!p) return ''; return artistMap.get(artistKey(p)) || p; };
    // genres
    const genreMap = buildGenreMap(library.map(t => t.genreRaw));
    // albums: unify spellings inside the same (canonical) album artist
    const albumPairs = [];
    for (const t of library) {
      if (!t.albumRaw) continue;
      const aa = artistOf(t.albumArtistRaw) || artistOf(t.artistRaw) || 'Unknown Artist';
      albumPairs.push([artistKey(aa) + '\u0001' + key(t.albumRaw), t.albumRaw]);
    }
    const albumMap = groupVote(albumPairs);
    for (const t of library) {
      const artist = artistOf(t.artistRaw);
      t.artist = artist || 'Unknown Artist';
      const aa = artistOf(t.albumArtistRaw);
      t.albumArtist = aa || '';
      if (t.albumRaw) {
        const ak = artistKey(aa || artist || 'Unknown Artist');
        t.album = albumMap.get(ak + '\u0001' + key(t.albumRaw)) || t.albumRaw;
      } else t.album = '';
      const gs = genresFor(t.genreRaw, genreMap);
      t.genres = gs;
      t.genre = gs[0] || '';
    }
    return library;
  }

  g.OndaCanon = { key, artistKey, splitGenres, primaryArtist, buildGenreMap, genresFor, apply, sameGenre, titleCase };
})(typeof window !== 'undefined' ? window : globalThis);
