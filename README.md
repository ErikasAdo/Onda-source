# Onda — Capacitor project

Local-first, offline MP3 player. Vanilla JS/CSS inside a Capacitor 8 shell. App ID `com.erikasado.onda`.

```
onda/
├─ package.json            Capacitor 8 + file-picker, filesystem, haptics, status-bar (+ native-audio for iOS)
├─ capacitor.config.ts
├─ setup.sh                one-shot: install → add platforms → patch → sync
├─ scripts/patch-native.mjs   adds the Android service/plugins/permissions + iOS background audio
├─ native/android/
│  ├─ OndaPlaybackService.java   FOREGROUND MEDIA SERVICE (Media3 ExoPlayer + MediaSession)
│  ├─ OndaPlayerPlugin.java      WebView ⇄ service bridge
│  └─ OndaLibraryPlugin.java     MediaStore scan, permissions, embedded cover art
├─ www/
│  ├─ index.html
│  └─ js/  config · db · native · audio-engine (iOS/web) · service-engine (Android) · meta (online lookups)
└─ worker/                 optional Cloudflare Worker proxy
```

## Background playback (Android)

Audio is played by a **foreground service** (`OndaPlaybackService`), not by the WebView. That is what keeps music
going when you leave the app or turn the screen off, and it gives you the notification + lock-screen controls
(play/pause, next, previous, seek bar, artwork).

* The app hands the service a window of ~60 upcoming tracks; the service moves between them by itself (gapless).
* Notification buttons act on that same window.
* On Android 13+ the app asks for **notification permission** the first time you press play — without it the
  notification is hidden (playback still works). Allow it.
* Not available with the service engine: **crossfade** and **playback speed** (those settings are hidden on Android).
* Some phones (Xiaomi, Huawei, Oppo, Samsung "sleeping apps") kill background apps aggressively:
  Settings → Apps → Onda → Battery → **Unrestricted**.

## Earphone balance (Settings → Earphones)

One earphone quieter than the other? The slider boosts the left or right ear by up to 12 dB, applied natively to the
audio stream (so it also works with the screen off). The section only appears if the build supports it. The GitHub
workflow automatically retries *without* this feature if it ever fails to compile (look for the yellow
"retrying WITHOUT the earphone-balance feature" warning in the Action log).

## Speed notes

* Library is restored from the database first; the native player binds in the background.
* Tapping a song starts it immediately; the next ~60 tracks and artwork are queued right after.
* **Instant start:** the Home screen is saved as a snapshot (`localStorage`) and painted while the page is still
  loading — before any script runs. Taps on it are remembered and replayed once the app is ready. The database reads
  start in the page head, in parallel with script parsing; housekeeping (rescan, online lookups) waits a few seconds.
* **Artwork lives in files** (`onda-img/` in the app's data folder): covers, artist photos, logos. Stable URLs, nothing
  decoded at launch, and the notification reads the same file. Old database covers are moved into files once, quietly.
* Next / previous jump inside the native queue when the target is already buffered (no new queue); MP3 seeking uses
  constant-bitrate seeking (no scanning through the file).
* Tabs render only when shown *and* changed; new covers are patched into the screen instead of re-rendering lists.
* On Android (`html.lite`): no backdrop blur, no infinite animations, short sheet transitions, chunked list rendering,
  lazy images. Test in a desktop browser with `?lite` appended to the URL.

## Artist logos

TheAudioDB's (or Fanart.tv's) logo is cached and shown **instead of the artist's name** on the artist page; dark logos
are inverted automatically so they stay readable. No logo → the name is shown as text.

## Auto-scan

The library keeps itself in step with the phone. Android notifies the app (a `ContentObserver` on MediaStore) when a
song is added, deleted or re-tagged; new songs appear a moment later and deleted ones vanish, along with covers that
belonged only to them. The app also checks when it is opened and when you come back to it. Songs that are still there
keep their favourites, play counts and covers. Settings → Library → *Auto-scan* switches it off. (An empty scan result,
e.g. an unmounted SD card, never wipes the library.)

## Names & genres are unified

`www/js/canon.js` normalises artists, albums and genres on every launch (originals are kept, nothing in the files is
changed): `Hip-Hop` = `Hip Hop` = `hip hop`, `Jay Z` = `Jay-Z`, `Pop, Pop` = `Pop`, `Beyonce` = `Beyoncé`,
`feat.` credits are dropped from the artist, `R&B`/`RnB`/`Rhythm and Blues`, numeric ID3v1 genres, multi-genre tags
(`Rock/Pop` → both), typos close to a bigger genre are merged. The most common / best-written spelling is shown.

## Explore & Search

*Explore* shows an artist wall (logos when cached, photo + name otherwise), a daily *Rediscover* shelf and genre chips.
The genre squares moved to *Search* (empty state); typing also matches genres. Logos also replace the name under artist
circles on Home and in Library → Artists.

## First run

A setup window asks for permission to read your audio files (Android: "Music and audio"), scans the phone's music
library (MediaStore), reads each file's embedded cover, and saves everything. After that the library re-syncs quietly
on launch (new/removed songs). Settings → Library → *Rescan device music* forces it.
Setup offers **Standard** (scan; the rest of the artwork is fetched quietly in the background) or **Extended**
(also fetches every cover, artist photo, logo and bio right away, with a progress bar and a *Continue in background*
button). Settings → Online → *Extended artwork* / *Fetch artwork now* do the same later.
iOS has no equivalent library access, so there you add files with the picker (they're copied into the app).

## Online sources

Wikipedia (artist biography, CC BY-SA with credit + link, lead photo; album articles as cover candidates), iTunes Search
and Deezer (high-resolution covers, artist photos), MusicBrainz + Cover Art Archive, TheAudioDB, Wikimedia Commons /
Openverse, LRCLIB lyrics, optional Fanart.tv. All keyless except the optional ones; everything is cached.

## Online features (toggle in Settings → Online)

| What | Source |
|---|---|
| Synced + plain lyrics | LRCLIB (lrclib.net) — no key |
| Covers (auto fallback chain) | embedded in your file → Cover Art Archive (via MusicBrainz release) → TheAudioDB |
| "Choose a cover" carousel (album page → Covers) | Cover Art Archive editions, TheAudioDB, Wikimedia Commons, Openverse |
| Artist photo, bio, facts, links | TheAudioDB, MusicBrainz, Wikimedia Commons / Openverse photos, optional Fanart.tv |

Inside the app these go through Capacitor's native HTTP client (no CORS problems, custom User-Agent). Only artist,
album and song names are sent. Results are cached in IndexedDB.

Optional: `www/js/config.js` → `FANART_KEY` (extra artist images), `AUDIODB_KEY` (default is the public free key `123`),
`PROXY_BASE` (your Cloudflare Worker in `worker/` — routes `mb`, `caa`, `adb`, `lrclib`, `fanart`).

## Build

```bash
bash setup.sh          # then: npx cap open android   (or ios)
```
Phone-only: upload the zip to a GitHub repo — `.github/workflows/build-apk.yml` builds `app-debug.apk` and publishes it
under **Releases → latest**.

## Known limits

* Covers found online for a track with no embedded art are best-effort matches — use *Covers* to pick another.
* Wikimedia/Openverse results are generic photos/art and are often not the right album; they are listed last.
* The sleep timer is a JS timer; the fade-out itself runs natively.

## Equalizer

Settings → Sound → Equalizer: 10 bands (31 Hz–16 kHz, ±12 dB), preamp, 14 presets, live response curve. On Android it runs inside the native player service (works with the screen off); in a browser it uses Web Audio. Needs the full build (the "safe" fallback player has no EQ and the sheet says so). Boosts are auto-trimmed slightly to avoid clipping.

## Genre photos (Unsplash)

The Search genre tiles get a photo per genre, fetched once through your Cloudflare Worker (`/unsplash` route, key stored as the `UNSPLASH_ACCESS_KEY` secret — never in the app), saved on the phone, and credited ("Photo by … on Unsplash", linked, as Unsplash requires). Set the Worker URL in `www/js/config.js` → `UNSPLASH_BASE`. Free tier = 50 requests/hour, so at most 18 genres are fetched per run; the rest follow on later launches.

## Playlists

Library → Playlists. Create, rename, delete; add songs with the **Songs** button inside a playlist (search + tick), from Now Playing (the list icon next to the heart), from the list icon in any album / artist / genre header (adds the whole thing), or by pressing and holding a song. Reorder / remove in **Edit**. **Favorites** is an automatic playlist of hearted songs. Stored on the device (`pl_lists` in localStorage).

## Support

Settings → Support shows the Telegram link, Bitcoin and Monero addresses (tap to copy). These are the only donation addresses in the project (set once in the build script, read from the page when copying).

## Sleep timer, listening stats, car mode, widget

- **Sleep timer** (Now Playing → moon, or Settings → Listening): 5 min – 2 h, custom minutes, end of this song / album, +5 min. Runs inside the native player so it fires with the screen off, and fades the music out (20 s for timed, 3 s for song/album).
- **Listening stats** (Settings → Listening stats): time listened per day / track, week · month · year · all-time, bar chart, streaks, top artists / songs / albums / genres, vs-previous-period change. Stored on the phone (`pl_stats2`).
- **Car mode** (Now Playing → car icon, or Settings): black, huge buttons, swipe the cover to skip, tap-to-seek bar, Library picker (shuffle all, Favorites, playlists, recent albums), keeps the screen on.
- **Home-screen widget** (Android): long-press the home screen → Widgets → Onda. Cover, title, artist, previous / play-pause / next. It is added by `scripts/patch-native.mjs`; it updates as music plays (cover, title, artist, play/pause state) and the buttons control playback; if a build ever fails because of it, the GitHub workflow automatically retries without it (`node scripts/patch-native.mjs --no-widget`).

## Launch, Back button, stats accuracy, smart mixes
- **Launch**: a black Onda logo screen holds until Home is fully drawn (text and covers decoded), then fades out — nothing pops in. A fail-safe removes it after 5 s.
- **Back button** (the Android 3-button / swipe-back): closes the top-most screen or sheet and walks back through where you were — track list → Now Playing → car mode → back to Now Playing; non-Home tabs go back to Home; Back on Home leaves the app as usual. Implemented with browser history (`glue_back.js`).
- **Listening stats** are now counted inside the playback service (`OndaStats.java`), so they keep counting with the screen off. The web layer collects them (`drainStats`). The old in-page counter remains only as a fallback for builds without the native counter.
- **Smart mixes** (`glue_smart.js`): Daily Mix 1–5, On Repeat, Discovery, Rewind, Repeat Rewind, Favorites, New Music, Deep Cuts, The Works, Workout, Wind Down, genre mixes (Rock Mix…), decade mixes, and artist mixes. Scored from recency-weighted listening time, completed plays, skips (a song dropped in its first 25 s), favorites and artist/genre taste. Stable for the day. Home → Made For You shows the best ones; Library → Playlists → Made for You lists all; any mix can be saved as a real playlist (Save, top right). Workout/Wind Down use genre energy (MP3 tags carry no tempo).
- **Black system bars (permanent)**: `scripts/patch-native.mjs` writes a black status bar / navigation bar / window / launch background into the Android theme (`styles.xml`) *and* re-applies black bars with light icons in `MainActivity` on every start/resume, so the phone's day/night theme can never turn them white.
- **App icon**: the Onda wave mark. Sources in `native/android/icons/` (adaptive + legacy launcher icons, installed by `patch-native.mjs`); `onda-icon-1024.png` is the full-size version.
- **Now Playing "•••"** (top right): a labelled menu — Add to Playlist, Equalizer, Sleep Timer, Car Mode, Delete from Device. The old icon row now only keeps Lyrics and Queue.
- **Back button**: `MainActivity` sends Android's Back to the web layer (`window.__ondaBack`), which closes the top-most screen (Now Playing → album → Home …). On Home, Back sends the app to the phone's home screen and music keeps playing.
- **Press-and-hold a song** → Add to Playlist / Favorite / **Delete from Device**. Deleting asks for confirmation here, then Android asks once more on Android 10+ (system rule). On Android 9 (e.g. Galaxy S8) it needs the storage-write permission, which Onda asks for the first time you delete.
- Artist / album / genre pages always open scrolled to the top.

## Last.fm (play counts, tags, similar artists, your history)

The phone never holds the key. Add it to the Worker once:
Cloudflare → Workers → `onda-proxy` → Settings → Variables and Secrets → add a **secret** named `LASTFM_API_KEY`, then redeploy.
Until it is set, every Last.fm feature quietly does nothing.

What it does (Settings → Last.fm, on by default):
- **Artists**: listeners, play counts, real genre/mood tags, and similar artists (feeds Discovery, Daily Mixes, Workout, Wind Down).
- **Songs**: global play counts. Powers the **Hits** mix, the **Hidden Gems** mix (songs you love that few others know), "Most played" tie-breaks and the "· 9M plays" badges on artist pages.
- **Your profile**: enter a Last.fm username to import your top tracks, loved tracks and last month, matched to songs on the device.
- Everything is cached on the phone (artists 45 days, songs 90 days) and fetched at about 5 requests per second, a few hundred songs per pass. Network failures are retried later and never cached as "unknown".
- Scrobbling is not included (it needs a signing secret in the Worker).

### Artist page: Top Songs menu
The pill beside "Top Songs" picks the ranking: **Most played by you**, **Most scrobbled from your library** (Last.fm worldwide plays, only songs you own), or **Title A–Z**. A fourth row switches between the top 5 and every song. The choice is remembered.

## Fix tags, smart playlists, Now Playing (this round)

- **Fix (album page, or long-press a song → Fix Album Info…)**: for albums with missing tags a white **Fix** pill with a black wrench appears. Type the album ("metallica black album"), pick the right release, check the file → track matches (each row has a dropdown), tap **Write**. The ID3 tags are written into the real files (`OndaTagWriter.java`: keeps cover art / lyrics / comments, drops the stale ID3v1 block, restores the original if a write fails), MediaStore is updated and the library re-reads the files. Android 11+ asks once to allow editing; Android 10 may ask per file; Android 9 asks nothing extra.
- **Smart Playlist** (Library → Playlists → "Smart Playlist"): rules for genre, decade, artist, plays, favorites, added, length, Last.fm popularity, order and size, with a live match count. They refill themselves; "Rules" on the playlist reopens the builder.
- **Queue sync after delete**: deleted songs also leave the Android service queue (`removeItems`), so Previous / Next never hits a deleted file.
- **Notification** uses the Onda mark (`ic_stat_onda.xml`, a white vector) as its small icon.
- **Now Playing**: scrobble stats under the artist, tap the artist to open their page, swipe up on the player for lyrics (swipe down to come back), an **Up next** card in the last 20 seconds (tap → queue), and **Queue / Lyrics / Go to Artist** in the ••• menu.

## Fix v2, select mode (hold anything)

- **Fix finds albums from your songs.** It searches Deezer, MusicBrainz, iTunes and Last.fm, and also looks up each song title to see which albums contain it. Every candidate's track list is checked against your files and ranked by "12 of 13 songs match" — best match first, no typing needed (typing artist/album only helps). Same album from several catalogues is merged; the year, genre and cover are taken from whichever has them.
- **Enter by hand** works for anything obscure: album, artist, year, genre plus an editable title and number per file. All the fields (also in the matched view) can be edited before writing.
- **Hold anything to select**: songs, albums, artists, on any screen. Tap to add more. The bar offers Add to Playlist, Fix and Delete (bin). Back or Cancel leaves select mode.
- The "Rules" button now only shows on your own Smart Playlists, not on Daily Mix etc.


## Hold-to-select now includes playlists; heart animation; widget fix
- Press and hold one of **your playlists** (Library → Playlists) to enter selection mode. Pick several, then tap the bin to delete them (songs stay in your library). Playlists are picked on their own — they can't be mixed with songs/albums/artists. Favorites and the generated mixes can't be deleted, so they aren't selectable.
- Hearting a track on an album page now pops (and a ring bursts); un-hearting shrinks it, and the heart now actually fills/empties right away.
- Widget: the playback service now addresses its updates to the widget by explicit component name. Before, the broadcast used package + custom action only, and the widget's intent-filter never listed that action, so Android dropped every update and the widget stayed on "Onda / Tap to open your music". It also shows "paused" when the service stops.

## Last.fm history sync + full backup (export / import)
**Last.fm → Settings → Last.fm → "Your Last.fm profile"** (tap it; first time it asks for your username, after that it offers Sync now / Read all history again / Change username).
- Reads your all-time play counts → they become the play counts in Onda (never lower than what Onda counted itself).
- Reads your dated scrobble history (`user.getRecentTracks`) and adds it to **Listening stats** and the mixes — **only for songs that exist on this phone** (matched by artist + title, ignoring "(Remastered)", track-number prefixes, etc.).
- Safe to repeat: it remembers which part of your history it has read, so nothing is counted twice. New scrobbles are added at each sync (automatically about once an hour while Onda is open). A first sync reads up to ~12,000 scrobbles per run and continues on the next run until the last 800 days are in.
- Added new songs to the phone? Use **Read all history again** — it removes what came from Last.fm and imports it again with the bigger library.

**Settings → Backup**
- **Export everything**: Android's "save as" dialog opens, so you choose where `onda-backup-DATE.json` goes (Downloads, Drive, USB…). It contains favorites, playlists (incl. smart-playlist rules), play counts, skips, all listening stats (+ the Last.fm history markers), settings, Last.fm caches and your profile import.
- **Import from a backup**: pick the file on the other phone. Songs have different ids on every phone, so they are matched by artist / title / album / length. It's a merge (counts never go down, playlists with the same id get their songs merged, stats take the larger value per day and song), so importing the same file twice changes nothing — copy your music over first, import, and if some songs were missing import again later.
- After an import a summary shows how many songs matched and how many weren't found yet. Restart Onda after importing so restored settings apply.

## Battery (power pass)
- No timer runs while the screen is off: the playback poll (now 1 s while playing and the screen is on, 0.3 s only with synced lyrics open), Now Playing Last.fm refresh, background artwork / Last.fm / history jobs all stop. The player service plays on its own.
- Background network/CPU jobs (artwork fetching, Last.fm enrichment, history sync, cover extraction) work in 10 s bursts and rest 50 s on battery (45 s on / 6 s rest when charging) and pause below 20 % battery. Jobs you start yourself (progress toast, "Fetch artwork now", Sync now) run at full speed.
- No infinite animations: the Now Playing hint no longer pulses forever (it was keeping the GPU at ~40 frames/s), the equalizer bars in lists are static on Android.
- The big blurred backgrounds (Now Playing, album page, lyrics) are baked once into a tiny soft picture instead of a live 36–90 px GPU blur.
Measured in the test rig: Now Playing open went from ~40 compositor frames/s to ~2/s; with the screen "off" there is no activity at all.

## Whole Last.fm history, deep Listening Stats, landscape, virtual songs list

**History store.** Syncing Last.fm now keeps *every* scrobble (all songs, not only the ones on the phone) in a compact store (`keep|lfhist` in IndexedDB; it survives "clear caches"). Songs are matched to your library when read, so an album you add later shows its Last.fm plays straight away. Play counts shown in the app are `max(on-device plays, your scrobbles)`. The store is part of Backup → Export / Import.

**Your scrobbles on artists** (only with Last.fm connected + history synced): artist pages show "you: N scrobbles" and the Top Songs sort menu has "Your scrobbles".

**Listening Stats** (Settings → Listening Stats) is a Last.fm-style deep dive built on `glue_stats2.js`: any range (today … all time, any month/year, custom dates), source (Onda + Last.fm / Last.fm / Onda), all music or only what is on the phone, plays or minutes. Overview cards, over-time chart (tap a bar, tap again to zoom to that period), hour-of-day, weekday, calendar heatmap (tap a day → everything you played, with times), Top artists/albums/songs with "See all", genres, decades, and drill-down pages for any artist / album / song (first & last played, by month, every listen). Search covers your whole history. Minutes for Last.fm plays use the song's length (or the artist's average, or 3:35), so they are estimates.

**Landscape.** Turned sideways the app switches to a side rail, split Now Playing (cover left / controls right), multi-column grids, compact mini player, and detail pages with the cover pinned. Applies when the screen is short (`orientation: landscape` and height ≤ 600 px).

**Songs list** is virtual: only the ~40 rows around the screen exist in the DOM, however many songs you own (`glue_vlist.js`).

## Audio page, themes, share, swipe, faster setup

- **Settings → Audio**: left/right balance (moved here), **Force audio** (Onda stops handling audio focus, so other apps can't pause it; stored natively in `onda_audio` prefs), and a **ding when an album finishes** (native bell synthesised in `OndaPlaybackService.playDing`; triggers when ≥2 tracks of the same album played through in a row, or the queue ends after one).
- **Repeat**: off → repeat all (queue/album/single) → repeat one (a "1" shows in the icon) → off.
- **Share File**: in the ••• menu, the press-and-hold menu and the selection bar (`OndaLibraryPlugin.shareFiles`, Android share sheet with the MP3 attached).
- **Themes** (Settings → Themes): 14 accent + background palettes. The build turns the old hard-coded colours into CSS variables (`--accent`, `--accent2`, `--accent-rgb`, `--bg`); the choice is stored in `settings.theme` and `pl_theme`.
- **Features** (Settings → Features): the full list of what Onda does.
- **Setup**: Onda logo instead of the music note, rotating tips under the progress bar and on the finish screen. Standard setup finishes as soon as the songs are found; covers load in the background four at a time (native side shrinks big embedded covers before they cross the bridge). Choosing Extended now also flips the Settings switch.
- **Swipe between tabs** (Settings → Swipe between tabs): drag left/right; inside Library it walks Albums → Artists → Songs → Playlists first.
- Songs added after setup now get their Last.fm history, play counts and Last.fm info automatically.
- Fonts: Onda never loaded web fonts; it uses the phone's system font.

## Latest
- **Explore tab removed** (tab bar is Home · Library · Search · Settings; nothing renders for it any more).
- **Album page → artist name** is a tappable link; the album / artist / genre pages now stack in the order you open them (an artist opened from an album used to open behind it). Albums whose album-artist has no page (e.g. "Various Artists") offer a pick list of the artists on the album.
- **Support addresses** (Settings → Support) are exactly: Bitcoin, Bitcoin Cash, Monero, Ethereum, Dogecoin (+ Telegram). They live in `patch_extra.py` (`COINS`); no other addresses exist in the project.

## Per-install key for the proxy ("2FA")

Every install registers itself with the Worker the first time it runs (`GET /register` → `{id, secret}`, kept in
the app's private storage — it is **not** inside the APK). From then on each request to the Worker carries
`X-Onda-Key: id.time.HMAC` (re-signed once a minute). The Worker derives each secret from `MASTER_SECRET`,
so it stores nothing per install.

A key is **blocked** (403) when it is used:
- from a web page whose origin isn't the app (a key lifted out of the app and used in a browser/site),
- from more than 8 different networks in a day (shared around),
- or by hammering past 400 requests/min until it collects 30 strikes in an hour.

A blocked install shows one toast, pauses online features, and asks for a fresh key after 24 h.
Registration is limited to 8 per network per hour. Phone clock wrong? The app aligns to the Worker's clock.

Deploy (from `worker/`):
```
npx wrangler secret put MASTER_SECRET        # any long random string — this turns the system on
npx wrangler kv namespace create BLOCKS      # optional: blocks become permanent and worldwide
#   → paste the printed id into the [[kv_namespaces]] block in wrangler.toml
npx wrangler deploy
```
Without `MASTER_SECRET` the Worker stays open (old behaviour). Tunables are the constants at the top of the key
section in `worker.js` (`RATE_PER_MIN`, `MAX_NETWORKS`, `REG_PER_HOUR`…).

Limits: a sideloaded APK can't be truly attested, so someone who registers their own keys from a script still gets
a small quota per key/network before being blocked — this caps abuse, it doesn't make it impossible.

## Latest changes

- **Proxy URL** is now `https://pleasedonthack.erikas4445-992.workers.dev` (`www/js/config.js`).
- **Pages on top:** album / artist / genre pages always open above playlist, Listening stats and the Audio/Themes pages (also when reached from Now Playing).
- **Album info:** the album page has an "About this album" card (release date, genre, label, country, tags, listeners, write-up) from Last.fm + iTunes + MusicBrainz, cached for 30 days.
- **Notification state:** if another app grabs audio focus for more than 5 s (Force audio off), Onda really pauses so the notification shows ▶ instead of a stale pause icon.
- **Lyrics loop:** hold a line, tap more lines (scroll freely) to stretch the selection, press *Loop*. The player service repeats that section until you press *Stop* or the song changes (`OndaPlayer.setLoop`).
- **Theme fix:** the default / Sunset / Violet themes wrote `var(--accent)` into themselves (the build step rewrote their colour literals), which blanked the accent colour. Fixed.
- **Proxy key:** a failed first registration (offline) no longer switches Last.fm off for the session.

## Signed release APK (Uptodown / F-Droid / sideload)

1. GitHub → **Actions → "Make signing key (run ONCE)" → Run workflow**. Open the finished run, download the artifact
   `onda-signing-key-DELETE-AFTER-DOWNLOAD`, then delete it (it is only kept 1 day).
2. **Settings → Secrets and variables → Actions → New repository secret** — create four secrets, pasting the text from the files:
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
3. Keep `onda.jks` + the passwords somewhere safe (password manager). **Lose it and you can never update the app for existing users.**
4. Run **Build Android APK**. With the secrets present it builds a signed `assembleRelease` APK (`Onda-1.0.<run>.apk`, versionCode = run number,
   so every build is a valid update); without them it still builds the debug APK. The file lands in the `latest` release.

## Privacy (what leaves the phone)

- Song / artist / album **names** → MusicBrainz, Cover Art Archive, TheAudioDB, LRCLIB, Deezer, iTunes, Wikipedia, Last.fm and your Worker (optional; Settings → Online features).
- The Worker sees a **random per-install key id** and the request's IP address (Cloudflare's normal logs). No account, no name, no email, no device id, no analytics.
- Everything else (library, history, stats, playlists, settings) stays on the phone.

## Offline first, genre art, privacy

- **Offline first run:** with no internet the setup screen says so, skips the online options and finishes normally. The app is fully usable
  (library, covers from your files, stats, playlists, lyrics saved in the songs). When a connection appears Onda shows
  *"Onda is much more than what you just experienced — Standard or extended?"* and fetches artist photos etc. with the choice you make
  (`glue_offline.js`, flag `pl_pending_online`). "Not now" snoozes it for a day.
- **Genre tiles** (Search tab) show two random artists of the genre side by side, melting into the tile gradient:
  Fanart.tv fan art when online (through the Worker's `/fanart` route → needs the `FANART_API_KEY` secret), otherwise artist photos, otherwise
  two album covers from your own files — so it also looks good offline. Unsplash is no longer used (`glue_genreduo.js`).
- **Settings → Privacy & data** lists exactly what Onda collects.

## Save mobile data, hourly images, cover fix
- **Save mobile data** (Settings → Online): on mobile data / Android Data Saver all background downloads (covers, artist photos, genre fan art) pause and catch up on Wi-Fi. Cover Art Archive pictures drop to 250 px. Lyrics for the playing song and everything already saved keep working. Detected with `navigator.connection` (`glue_data.js`).
- **Genre images change every hour**: each genre keeps up to 4 fan-art images on the phone and shows a different pair each hour (free). On Wi-Fi a few genres per hour download more to choose from. Offline, the pair comes from your own album covers and also changes hourly.
- **Genre page header** wears the same artist pair.
- **Covers**: a track with no cover of its own now borrows its album's (same album, or same album name by the same lead artist) — mini player, Now Playing, lists and notification.

**App ID is now `com.erikasado.onda`** (was `com.erikas.onda`). It's a different app to Android: uninstall any older build first, and sign with the same keystore as before.

## Licence
Onda is free software under the **GNU GPL v3 or later**. See `LICENSE`. F-Droid steps: `FDROID.md`.
