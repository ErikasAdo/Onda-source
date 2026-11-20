# Privacy policy for Onda

## Effective 19 November 2026

This is the privacy policy for the Onda Android app (com.erikasado.onda). Onda has no accounts, so there is no account data to describe. Everything here is about what the app does with information on your phone and what it sends over the internet.


## Who we are

- Onda is made by an independent developer, Erikas (@ErikasAdo on Telegram). In this policy, "we" means that developer.
- Questions or requests: t.me/ErikasAdo

## The short version

- You do not need an account, and Onda has none.
- No ads, no analytics, no crash reporting.
- Your music files are never uploaded anywhere.
- Your library, favourites, playlists, play counts and listening stats stay on your phone.
- When online features are on, Onda sends song, artist and album names to public music databases to fetch covers, lyrics, biographies and similar artists.
- We do not sell your data or share it for advertising.
- You can turn online features off at any time.
- Onda never asks for your name, email, phone number, location, contacts, camera or microphone, and does not read your advertising ID or device ID.

## What stays on your phone

- Your library index: titles, artists, albums, genres, track numbers, durations and where each song is stored.
- Artwork: covers and artist pictures, stored in the app’s folder. Covers inside your own files are read directly from them.
- Your activity: favourites, playlists, play counts, skips and listening stats.
- Settings: theme, audio options, online and data-saving choices.
- Saved lookups: lyrics, biographies, album info, tags and similar artists, so they work offline.
- Your Last.fm username, only if you connect Last.fm.
- A random install key (see “Onda’s own proxy”), created the first time Onda goes online.
- Android’s app sandbox stops other apps reading this. Clearing Onda’s storage in Android settings, or uninstalling, deletes all of it.

## Permissions Onda asks for

- Music and audio (Storage on Android 12 and older): to find and play your songs and read the cover art inside them.
- Storage write (Android 9 and older only): only when you ask to delete a song or save fixed tags into a file.
- Notifications (Android 13 and newer): to show playback controls on the lock screen and in the notification.
- Foreground service (media playback) and wake lock: to keep music playing with the screen off.
- Internet: for the online features. Onda works without it.
- Onda never requests location, contacts, camera, microphone, messages, phone, calendar or advertising ID.

## Online features: what is sent, and to whom

- Online features are on by default so covers, lyrics and artist info work. You can switch them off in Settings, and choose Standard or Extended at setup. With them off, Onda sends nothing.
- LRCLIB (lyrics): song title, artist, album and duration. Direct.
- MusicBrainz and Cover Art Archive (album matching, details, covers): artist, album and song names and release identifiers. Direct.
- TheAudioDB (artist photos, logos, bios): artist name. Direct.
- Deezer (covers and artist photos): artist and album names. Direct.
- iTunes Search by Apple (covers and album details): artist and album names. Direct.
- Wikipedia, Wikimedia Commons and Openverse (bios and pictures): artist and album names. Direct.
- Last.fm (tags, similar artists, play counts, album write-ups, and your history if you connect it): artist, song and album names, and your Last.fm username if you connect it. Through Onda’s proxy.
- fanart.tv (fan art for artists and genre pictures): artist name or MusicBrainz identifier. Through Onda’s proxy.
- For direct requests, the service receives your IP address and the usual technical details of a web request, such as the app name and version. Each service handles that under its own privacy policy.
- Never sent: your audio files or their paths, your full library list, playlists, favourites, play counts, listening stats, your location, or any device identifier or advertising ID. Onda does not post to any service and does not scrobble.

## Onda’s own proxy

- Last.fm and fanart.tv need secret keys that must not ship inside the app, so requests to them go through a small server we run on Cloudflare Workers. It also caches public responses briefly so repeat lookups are faster.
- It receives the lookup itself (for example an artist name).
- It receives a random install key. The first time Onda goes online it asks the proxy for a random identifier and a secret. They are not linked to you, your device or any account. Each request is signed with that key so we can tell it came from a real copy of the app. The key is kept in the app’s private storage.
- Your IP address: Cloudflare, our host, handles it to deliver the request. The proxy looks at a shortened network prefix in memory only, to spot a key being shared widely or abused. We do not store it.
- We keep no logs of what you look up and build no profiles.
- If a key is used abusively, the proxy records that key’s random identifier and the reason for up to 90 days so it stays blocked. It does not identify a person.
- Cached public responses (such as an artist’s tags) are not tied to you. Cloudflare may keep its own standard operational logs under its privacy policy.

## Last.fm (optional)

- If you enter a Last.fm username, Onda sends it through our proxy to Last.fm to read your public listening history, loved tracks and play counts, matches them to songs on your phone and stores the results on your phone.
- Onda never asks for your Last.fm password. You can change or remove the username at any time.

## Backups and sharing

- Settings has a backup export with your favourites, playlists, play counts, stats, settings, saved lookups and Last.fm username. Android asks where to save it. It goes only where you put it. We never receive it, so keep it as private as the data inside.
- When you share a song, Onda hands the MP3 to Android’s share sheet and the app you pick receives it. That app’s own privacy policy applies from then on.

## How long data is kept

- On your phone: until you clear Onda’s storage or uninstall it. Saved lookups refresh after a while, roughly 30 days for album details, 45 days for artist information and 90 days for song information. Failed lookups are retried after a few days.
- Proxy: no per-person data. Blocked-key records last up to 90 days. Cached public responses last a short time.
- Third-party services keep request data under their own policies.

## Your choices

- Turn off online features in Settings to stop every request listed above.
- Save mobile data: on mobile data, Onda pauses background downloads and catches up on Wi-Fi.
- Skip the online setup: choose Standard instead of Extended, or set Onda up offline.
- Disconnect Last.fm by removing the username.
- Refuse a permission in Android settings. Features that need it stop; the rest keep working.
- Delete everything by clearing Onda’s storage in Android settings, or by uninstalling.
- Take your data with you using the backup export.

## Legal basis and your rights

- Where data protection law such as the UK GDPR or EU GDPR applies, the developer named above is the controller of anything described under “Onda’s own proxy”. We process it to run the features you use and, for abuse prevention, for our legitimate interest in keeping the service available and its keys from being misused. Turning online features off stops the processing described above.
- You can ask for access to, correction of or deletion of personal data we hold about you, restrict or object to processing, take your data elsewhere and withdraw consent. You can complain to your data protection authority, for example the Information Commissioner’s Office in the UK.
- In practice nearly all your data is on your phone, under your control. We hold no account or contact details, and the random install key is not visible to you or connected to your identity, so we may not be able to find anything about you. Ask anyway on Telegram and we will check and reply.
- Residents of California and other US states: we do not sell or share personal information for advertising and have no financial incentive programmes.

## Where data goes

Cloudflare and the music services run servers in many countries, including outside the UK and EU. When online features are on, the names Onda sends may be processed wherever those services operate.


## Children

Onda is not aimed at children under 13 and we do not knowingly collect personal information from them. Onda collects no personal information from anyone, apart from the exceptions explained above.


## Security

- Every online request uses HTTPS.
- The Last.fm and fanart.tv secrets are kept on the server, never inside the app.
- Requests to the proxy are signed with the install key, and abusive keys are blocked.
- Your data on the phone sits in Android’s app sandbox.
- No system is perfectly secure, but Onda is designed to hold as little as possible.

## Third-party content

Covers, artist pictures, lyrics and biographies in Onda come from public services and belong to their owners. Onda displays them for you and does not host them. If you are a rights holder with a concern, contact us on Telegram.


## Changes to this policy

If Onda’s behaviour changes in a way that affects privacy, we will update this policy and its date before the change reaches the app.


## Contact

Questions, requests or concerns: @ErikasAdo on Telegram (t.me/ErikasAdo).


