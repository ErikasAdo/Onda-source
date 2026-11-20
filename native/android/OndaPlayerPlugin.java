package com.erikasado.onda;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.SystemClock;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * OndaPlayer — bridge between the WebView UI and the native foreground playback service
 * (OndaPlaybackService, ExoPlayer + MediaSession).
 *
 * The UI hands over a whole window of upcoming tracks, so the service can move from song to song
 * (gapless) on its own while the WebView is frozen in the background.
 *
 *   init()                                   connect to the service
 *   setQueue({items,startIndex,positionMs,play,repeatOne})
 *   setTail({items,repeatOne})               replace everything after the current item
 *   append({items})
 *   play() pause() stop() seek({positionMs}) setVolume({volume}) fadeOutAndPause({ms})
 *   getState()  → { playWhenReady, playing, positionMs, durationMs, index, id, state, count }
 *   checkNotifications() / requestNotifications()   (Android 13+ runtime permission)
 *
 * events: mediaChanged {index,id,reason}  playState {playing}  ended {}  playerError {message,index}
 *
 * item = { id, uri, title, artist, album, artUri }  (artUri = file:// JPEG, optional)
 */
@CapacitorPlugin(
    name = "OndaPlayer",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class OndaPlayerPlugin extends Plugin {

    private interface Op {
        void run(MediaController c, PluginCall call) throws Exception;
    }

    private static class Pending {
        final PluginCall call;
        final Op op;
        Pending(PluginCall call, Op op) { this.call = call; this.op = op; }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Pending> pending = new ArrayList<>();
    private MediaController controller;
    private boolean connecting = false;
    private Runnable fadeRunnable;

    /* ── connection ───────────────────────────────────────────────────────────── */

    private void withController(final PluginCall call, final Op op) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (controller != null) {
                    exec(controller, call, op);
                    return;
                }
                pending.add(new Pending(call, op));
                if (connecting) return;
                connecting = true;
                Context ctx = getContext();
                SessionToken token = new SessionToken(ctx, new ComponentName(ctx, OndaPlaybackService.class));
                final ListenableFuture<MediaController> future = new MediaController.Builder(ctx, token).buildAsync();
                future.addListener(new Runnable() {
                    @Override
                    public void run() {
                        connecting = false;
                        List<Pending> todo = new ArrayList<>(pending);
                        pending.clear();
                        try {
                            controller = future.get();
                            controller.addListener(playerListener);
                        } catch (Exception e) {
                            controller = null;
                            for (Pending p : todo) p.call.reject("Could not start the player service: " + e.getMessage());
                            return;
                        }
                        for (Pending p : todo) exec(controller, p.call, p.op);
                    }
                }, ContextCompat.getMainExecutor(ctx));
            }
        });
    }

    private void exec(MediaController c, PluginCall call, Op op) {
        try {
            op.run(c, call);
        } catch (Exception e) {
            call.reject("Player error: " + e.getMessage());
        }
    }

    /* ── player events → JS ───────────────────────────────────────────────────── */

    private final Player.Listener playerListener = new Player.Listener() {
        @Override
        public void onMediaItemTransition(MediaItem item, int reason) {
            JSObject o = new JSObject();
            o.put("index", controller != null ? controller.getCurrentMediaItemIndex() : -1);
            o.put("id", item != null ? item.mediaId : "");
            o.put("reason", reason);
            notifyListeners("mediaChanged", o);
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            JSObject o = new JSObject();
            o.put("playing", playWhenReady);
            notifyListeners("playState", o);
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_ENDED) notifyListeners("ended", new JSObject());
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            JSObject o = new JSObject();
            o.put("message", String.valueOf(error.getMessage()));
            o.put("index", controller != null ? controller.getCurrentMediaItemIndex() : -1);
            notifyListeners("playerError", o);
            // unreadable file → move on to the next one instead of stalling
            if (controller != null && controller.hasNextMediaItem()) {
                controller.seekToNextMediaItem();
                controller.prepare();
                controller.play();
            }
        }
    };

    /* ── building media items (off the main thread: reads small artwork files) ── */

    private List<MediaItem> buildItems(JSONArray arr) throws Exception {
        List<MediaItem> list = new ArrayList<>();
        Map<String, byte[]> artCache = new HashMap<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            MediaMetadata.Builder mb = new MediaMetadata.Builder()
                .setTitle(o.optString("title", ""))
                .setArtist(o.optString("artist", ""))
                .setAlbumTitle(o.optString("album", ""))
                .setIsPlayable(true);
            String art = o.optString("artUri", "");
            if (!art.isEmpty()) {
                mb.setArtworkUri(Uri.parse(art));      // the home-screen widget reads the cover from this file
                byte[] bytes = artCache.get(art);
                if (bytes == null && !artCache.containsKey(art)) {
                    bytes = readFile(art);
                    artCache.put(art, bytes);
                }
                if (bytes != null && bytes.length > 0) {
                    mb.setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
                }
            }
            list.add(new MediaItem.Builder()
                .setMediaId(o.optString("id", ""))
                .setUri(Uri.parse(o.optString("uri", "")))
                .setMediaMetadata(mb.build())
                .build());
        }
        return list;
    }

    private byte[] readFile(String uri) {
        InputStream in = null;
        try {
            String path = uri.startsWith("file://") ? Uri.parse(uri).getPath() : uri;
            if (path == null) return null;
            in = new FileInputStream(path);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 2 * 1024 * 1024) return null; // sanity cap
            }
            return out.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) { }
        }
    }

    /* ── methods ──────────────────────────────────────────────────────────────── */

    @PluginMethod
    public void init(PluginCall call) {
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void setQueue(final PluginCall call) {
        final JSONObject data = call.getData();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<MediaItem> items;
                try {
                    items = buildItems(data.getJSONArray("items"));
                } catch (Exception e) {
                    call.reject("Bad queue: " + e.getMessage());
                    return;
                }
                final int start = data.optInt("startIndex", 0);
                final long pos = data.optLong("positionMs", 0);
                final boolean play = data.optBoolean("play", true);
                final boolean repeatOne = data.optBoolean("repeatOne", false);
                withController(call, new Op() {
                    @Override
                    public void run(MediaController c, PluginCall call) {
                        cancelFade(c);
                        c.setMediaItems(items, Math.max(0, Math.min(start, items.size() - 1)), pos);
                        c.setRepeatMode(repeatOne ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
                        c.prepare();
                        if (play) c.play();
                        call.resolve();
                    }
                });
            }
        }).start();
    }

    @PluginMethod
    public void setTail(final PluginCall call) {
        final JSONObject data = call.getData();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<MediaItem> items;
                try {
                    items = buildItems(data.getJSONArray("items"));
                } catch (Exception e) {
                    call.reject("Bad queue: " + e.getMessage());
                    return;
                }
                final boolean repeatOne = data.optBoolean("repeatOne", false);
                withController(call, new Op() {
                    @Override
                    public void run(MediaController c, PluginCall call) {
                        int cur = c.getCurrentMediaItemIndex();
                        int count = c.getMediaItemCount();
                        if (cur >= 0 && cur + 1 < count) c.removeMediaItems(cur + 1, count);
                        if (!items.isEmpty()) c.addMediaItems(items);
                        c.setRepeatMode(repeatOne ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
                        call.resolve();
                    }
                });
            }
        }).start();
    }

    @PluginMethod
    public void append(final PluginCall call) {
        final JSONObject data = call.getData();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<MediaItem> items;
                try {
                    items = buildItems(data.getJSONArray("items"));
                } catch (Exception e) {
                    call.reject("Bad queue: " + e.getMessage());
                    return;
                }
                withController(call, new Op() {
                    @Override
                    public void run(MediaController c, PluginCall call) {
                        if (!items.isEmpty()) c.addMediaItems(items);
                        // the queue had run dry → continue with the new items
                        if (c.getPlaybackState() == Player.STATE_ENDED && c.getPlayWhenReady()) {
                            c.seekToNextMediaItem();
                            c.prepare();
                            c.play();
                        }
                        call.resolve();
                    }
                });
            }
        }).start();
    }

    /** Drops songs (by id) from the service queue, e.g. after they were deleted from the phone. The playing item is never touched. */
    @PluginMethod
    public void removeItems(final PluginCall call) {
        final JSONObject data = call.getData();
        final java.util.HashSet<String> ids = new java.util.HashSet<>();
        try {
            JSONArray a = data.optJSONArray("ids");
            for (int i = 0; a != null && i < a.length(); i++) ids.add(a.getString(i));
        } catch (Exception e) { /* ignore */ }
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                int cur = c.getCurrentMediaItemIndex();
                for (int i = c.getMediaItemCount() - 1; i >= 0; i--) {
                    if (i == cur) continue;
                    if (ids.contains(c.getMediaItemAt(i).mediaId)) c.removeMediaItem(i);
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void next(PluginCall call) {
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                cancelFade(c);
                if (c.hasNextMediaItem()) c.seekToNextMediaItem();
                if (c.getPlaybackState() == Player.STATE_IDLE) c.prepare();
                c.play();
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void previous(PluginCall call) {
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                cancelFade(c);
                if (c.hasPreviousMediaItem()) c.seekToPreviousMediaItem(); else c.seekTo(0);
                if (c.getPlaybackState() == Player.STATE_IDLE) c.prepare();
                c.play();
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                cancelFade(c);
                if (c.getPlaybackState() == Player.STATE_IDLE) c.prepare();
                if (c.getPlaybackState() == Player.STATE_ENDED) c.seekTo(0);
                c.play();
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                cancelFade(c);
                c.pause();
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                cancelFade(c);
                c.stop();
                c.clearMediaItems();
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void seek(final PluginCall call) {
        final long pos = call.getData().optLong("positionMs", 0);
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                c.seekTo(Math.max(0, pos));
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void setVolume(final PluginCall call) {
        final float v = (float) call.getData().optDouble("volume", 1.0);
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                c.setVolume(Math.max(0f, Math.min(1f, v)));
                call.resolve();
            }
        });
    }

    /** Sleep timer fade — runs natively so it still works while the WebView is frozen. */
    @PluginMethod
    public void fadeOutAndPause(final PluginCall call) {
        final long ms = Math.max(200, call.getData().optLong("ms", 4000));
        withController(call, new Op() {
            @Override
            public void run(final MediaController c, PluginCall call) {
                cancelFade(c);
                final int steps = 30;
                final long every = ms / steps;
                final float start = 1f;
                final int[] n = { 0 };
                fadeRunnable = new Runnable() {
                    @Override
                    public void run() {
                        n[0]++;
                        float p = Math.min(1f, n[0] / (float) steps);
                        c.setVolume(start * (1f - p));
                        if (p < 1f) {
                            main.postDelayed(this, every);
                        } else {
                            fadeRunnable = null;
                            c.pause();
                            c.setVolume(1f);
                        }
                    }
                };
                main.post(fadeRunnable);
                call.resolve();
            }
        });
    }


    /* ── sleep timer: runs in the app process next to the player service, so it fires with the screen off ── */

    private Runnable sleepRunnable;
    private long sleepAt = 0;
    private long sleepFadeMs = 15000;
    private boolean sleepFading = false;

    private void clearSleep() {
        if (sleepRunnable != null) main.removeCallbacks(sleepRunnable);
        sleepRunnable = null;
        if (sleepFading && controller != null) controller.setVolume(1f);
        sleepFading = false;
        sleepAt = 0;
    }

    private void sleepTick() {
        if (sleepAt == 0 || controller == null) return;
        long left = sleepAt - SystemClock.elapsedRealtime();
        if (left <= 0) {
            controller.pause();
            controller.setVolume(1f);
            sleepFading = false; sleepRunnable = null; sleepAt = 0;
            notifyListeners("sleepEnded", new JSObject());
            return;
        }
        if (left <= sleepFadeMs) {
            if (!controller.getPlayWhenReady()) {          // paused by hand while fading → cancel quietly
                controller.setVolume(1f);
                sleepFading = false; sleepRunnable = null; sleepAt = 0;
                notifyListeners("sleepEnded", new JSObject());
                return;
            }
            sleepFading = true;
            float v = (float) left / (float) sleepFadeMs;
            controller.setVolume(Math.max(0f, v * v));      // ease-out curve
            main.postDelayed(sleepRunnable, 100);
        } else {
            main.postDelayed(sleepRunnable, Math.min(1000, left - sleepFadeMs));
        }
    }

    @PluginMethod
    public void setSleep(final PluginCall call) {
        final long ms = Math.max(1000, call.getData().optLong("ms", 0));
        final long fade = Math.max(300, Math.min(60000, call.getData().optLong("fadeMs", 15000)));
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                clearSleep();
                cancelFade(c);
                sleepAt = SystemClock.elapsedRealtime() + ms;
                sleepFadeMs = Math.min(fade, ms);
                sleepRunnable = new Runnable() {
                    @Override
                    public void run() { sleepTick(); }
                };
                main.post(sleepRunnable);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void cancelSleep(final PluginCall call) {
        main.post(new Runnable() {
            @Override
            public void run() {
                clearSleep();
                call.resolve();
            }
        });
    }

    /** Listening time counted by the playback service (works with the screen off). Returns and clears it. */
    @PluginMethod
    public void drainStats(PluginCall call) {
        try {
            java.util.Map<String, long[]> m = OndaStats.drain(getContext());
            com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
            for (java.util.Map.Entry<String, long[]> e : m.entrySet()) {
                String k = e.getKey();
                int i = k.indexOf('|');
                if (i < 0) continue;
                JSObject o = new JSObject();
                o.put("day", k.substring(0, i));
                o.put("id", k.substring(i + 1));
                o.put("ms", e.getValue()[0]);
                o.put("plays", e.getValue()[1]);
                arr.put(o);
            }
            JSObject out = new JSObject();
            out.put("entries", arr);
            out.put("native", OndaStats.active);
            call.resolve(out);
        } catch (Throwable t) {
            call.reject("stats unavailable");
        }
    }

    @PluginMethod
    public void getSleep(PluginCall call) {
        JSObject o = new JSObject();
        long left = sleepAt == 0 ? 0 : Math.max(0, sleepAt - SystemClock.elapsedRealtime());
        o.put("active", sleepAt != 0);
        o.put("remainingMs", left);
        call.resolve(o);
    }

    private void cancelFade(MediaController c) {
        if (fadeRunnable != null) {
            main.removeCallbacks(fadeRunnable);
            fadeRunnable = null;
            c.setVolume(1f);
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        withController(call, new Op() {
            @Override
            public void run(MediaController c, PluginCall call) {
                JSObject o = new JSObject();
                long dur = c.getDuration();
                MediaItem item = c.getCurrentMediaItem();
                o.put("playWhenReady", c.getPlayWhenReady());
                o.put("playing", c.isPlaying());
                o.put("positionMs", Math.max(0, c.getCurrentPosition()));
                o.put("durationMs", dur < 0 ? 0 : dur);
                o.put("index", c.getCurrentMediaItemIndex());
                o.put("id", item != null ? item.mediaId : "");
                o.put("state", c.getPlaybackState());
                o.put("count", c.getMediaItemCount());
                call.resolve(o);
            }
        });
    }


    /* ── per-ear balance ─────────────────────────────────────────────────────── */

    @PluginMethod
    public void getBalanceSupport(PluginCall call) {
        JSObject o = new JSObject();
        o.put("supported", OndaPlaybackService.BALANCE_SUPPORTED);
        call.resolve(o);
    }

    @PluginMethod
    public void getEqSupport(PluginCall call) {
        JSObject o = new JSObject();
        o.put("supported", OndaPlaybackService.EQ_SUPPORTED);
        call.resolve(o);
    }

    /** { enabled, gains: [10 × dB], preamp: dB } — applies instantly, also to the playing track. */
    @PluginMethod
    public void setEq(PluginCall call) {
        org.json.JSONArray arr = call.getData().optJSONArray("gains");
        float[] g = new float[10];
        for (int i = 0; i < 10; i++) g[i] = arr == null ? 0f : (float) arr.optDouble(i, 0.0);
        OndaPlaybackService.setEq(call.getData().optBoolean("enabled", false), g, (float) call.getData().optDouble("preamp", 0.0));
        call.resolve();
    }

    /** left / right linear gains (1.0 = unchanged). Applies instantly, also to the playing track. */
    @PluginMethod
    public void setBalance(PluginCall call) {
        float l = (float) call.getData().optDouble("left", 1.0);
        float r = (float) call.getData().optDouble("right", 1.0);
        OndaPlaybackService.setBalance(l, r);
        call.resolve();
    }

    /** { force: bool, ding: bool } — saved natively so they also apply when the service is started without the app. */
    @PluginMethod
    public void setAudioOptions(PluginCall call) {
        boolean force = call.getData().optBoolean("force", false), ding = call.getData().optBoolean("ding", false);
        try {
            getContext().getSharedPreferences(OndaPlaybackService.AUDIO_PREFS, android.content.Context.MODE_PRIVATE).edit().putBoolean("force", force).putBoolean("ding", ding).apply();
        } catch (Throwable ignored) { }
        OndaPlaybackService.applyForceAudio(force);
        OndaPlaybackService.applyDing(ding);
        call.resolve();
    }

    /** { start, end } in ms — loop that part of the current track; end <= 0 clears it. */
    @PluginMethod
    public void setLoop(PluginCall call) {
        OndaPlaybackService.setLoop(call.getData().optLong("start", 0), call.getData().optLong("end", 0));
        call.resolve();
    }

    /** plays the album-finished ding once (used by the "Test" button) */
    @PluginMethod
    public void playDing(PluginCall call) { OndaPlaybackService.playDing(); call.resolve(); }

    /** Adds / replaces the artwork of one queued item without interrupting playback. */
    @PluginMethod
    public void setArtwork(final PluginCall call) {
        final String id = call.getData().optString("id", "");
        final String artUri = call.getData().optString("artUri", "");
        new Thread(new Runnable() {
            @Override
            public void run() {
                final byte[] bytes = readFile(artUri);
                if (id.isEmpty() || bytes == null || bytes.length == 0) { call.resolve(); return; }
                withController(call, new Op() {
                    @Override
                    public void run(MediaController c, PluginCall call) {
                        for (int i = 0; i < c.getMediaItemCount(); i++) {
                            MediaItem item = c.getMediaItemAt(i);
                            if (id.equals(item.mediaId)) {
                                MediaMetadata md = item.mediaMetadata.buildUpon()
                                    .setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                                    .build();
                                c.replaceMediaItem(i, item.buildUpon().setMediaMetadata(md).build());
                                break;
                            }
                        }
                        call.resolve();
                    }
                });
            }
        }).start();
    }

    /* ── notification permission (Android 13+) ────────────────────────────────── */

    private boolean notificationsGranted() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void checkNotifications(PluginCall call) {
        JSObject o = new JSObject();
        o.put("granted", notificationsGranted());
        call.resolve(o);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (notificationsGranted()) {
            JSObject o = new JSObject();
            o.put("granted", true);
            call.resolve(o);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        JSObject o = new JSObject();
        o.put("granted", notificationsGranted());
        call.resolve(o);
    }
}
