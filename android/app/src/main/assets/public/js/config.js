/* Onda runtime config. Everything here is optional.
 *
 * Inside the app, online lookups (MusicBrainz, Cover Art Archive, TheAudioDB, Wikimedia Commons,
 * Openverse, LRCLIB) use Capacitor's native HTTP client — no proxy needed.
 *
 * AUDIODB_KEY : TheAudioDB's public free key is "123" (30 requests/minute). Get your own at theaudiodb.com.
 * FANART_KEY  : optional Fanart.tv key → extra artist images.
 * UNSPLASH_BASE : your Cloudflare Worker URL (needs the UNSPLASH_ACCESS_KEY secret) → photos on the genre tiles.
 * LASTFM_BASE : your Cloudflare Worker URL (needs the LASTFM_API_KEY secret) → play counts, tags, similar artists. Falls back to UNSPLASH_BASE.
 * PROXY_BASE  : optional Cloudflare Worker (see worker/). If set, MusicBrainz/CAA/AudioDB/LRCLIB/Fanart
 *               calls go through it (keeps keys off the device). Leave '' to go direct. */
window.ONDA_CONFIG = {
  AUDIODB_KEY: '123',
  FANART_KEY: '',
  UNSPLASH_BASE: 'https://pleasedonthack.erikas4445-992.workers.dev',
  LASTFM_BASE: 'https://pleasedonthack.erikas4445-992.workers.dev',
  // Address of the privacy policy page on your website (e.g. https://your-site.vercel.app/privacy). Shown as a link in Settings > Privacy. Leave '' to hide it.
  PRIVACY_URL: '',
  PROXY_BASE: '',
};
