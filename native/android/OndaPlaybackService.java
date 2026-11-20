package com.erikasado.onda;

import android.app.PendingIntent;
import android.content.Intent;

import android.content.Context;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import java.nio.ByteBuffer;

/**
 * Foreground media service. The ExoPlayer lives HERE (not in the WebView), so audio keeps playing
 * and the media notification / lock-screen controls stay alive when the app is in the background,
 * the screen is off, or the activity is swiped away.
 *
 * Media3's MediaSessionService builds the notification (play/pause/next/previous + artwork +
 * seek bar) and promotes itself to a foreground service while playing.
 */
public class OndaPlaybackService extends MediaSessionService {

    static final boolean BALANCE_SUPPORTED = true;
    static final boolean EQ_SUPPORTED = true;

    /** Per-ear gain (1.0 = unchanged). Set from JS; read for every audio buffer. */
    private static volatile float gainLeft = 1f;
    private static volatile float gainRight = 1f;

    public static void setBalance(float left, float right) {
        gainLeft = Math.max(0f, Math.min(8f, left));
        gainRight = Math.max(0f, Math.min(8f, right));
    }

    // ── equalizer: 10 band parametric EQ + preamp, set from JS ──
    private static volatile boolean eqEnabled = false;
    private static volatile float[] eqGains = new float[10];
    private static volatile float eqPreamp = 0f;
    private static volatile int eqVersion = 0;

    public static void setEq(boolean enabled, float[] gainsDb, float preampDb) {
        float[] g = new float[10];
        for (int i = 0; i < 10 && gainsDb != null && i < gainsDb.length; i++) g[i] = Math.max(-15f, Math.min(15f, gainsDb[i]));
        eqGains = g;
        eqPreamp = Math.max(-15f, Math.min(15f, preampDb));
        eqEnabled = enabled;
        eqVersion++;
    }

    /** 10 peaking filters (RBJ biquads, one octave apart) on two channels. Plain Java — no Android classes. */
    static final class EqDsp {
        static final double[] FREQ = { 31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 };
        private static final double Q = 1.41;
        final double[] b0 = new double[10], b1 = new double[10], b2 = new double[10], a1 = new double[10], a2 = new double[10];
        final double[][] z1 = new double[2][10], z2 = new double[2][10];
        final int[] on = new int[10];
        int count = 0;
        double pre = 1.0;

        void configure(double sampleRate, float[] gains, float preampDb) {
            count = 0;
            double maxBoost = 0;
            for (int i = 0; i < 10; i++) {
                double g = gains[i];
                if (g > maxBoost) maxBoost = g;
                if (Math.abs(g) < 0.05 || FREQ[i] >= sampleRate * 0.45) continue;
                double A = Math.pow(10.0, g / 40.0);
                double w0 = 2.0 * Math.PI * FREQ[i] / sampleRate;
                double alpha = Math.sin(w0) / (2.0 * Q);
                double cs = Math.cos(w0);
                double a0 = 1.0 + alpha / A;
                int k = count++;
                on[k] = i;
                b0[i] = (1.0 + alpha * A) / a0;
                b1[i] = (-2.0 * cs) / a0;
                b2[i] = (1.0 - alpha * A) / a0;
                a1[i] = (-2.0 * cs) / a0;
                a2[i] = (1.0 - alpha / A) / a0;
            }
            // automatic headroom so boosts do not clip, plus the user's preamp
            pre = Math.pow(10.0, (preampDb - 0.6 * maxBoost) / 20.0);
        }

        /** x in -1..1 → filtered, soft-limited sample */
        float process(int ch, float x) {
            double v = x * pre;
            for (int k = 0; k < count; k++) {
                int i = on[k];
                double y = b0[i] * v + z1[ch][i];
                z1[ch][i] = b1[i] * v - a1[i] * y + z2[ch][i];
                z2[ch][i] = b2[i] * v - a2[i] * y;
                v = y;
            }
            double av = Math.abs(v);
            if (av > 0.92) v = Math.signum(v) * (0.92 + 0.08 * Math.tanh((av - 0.92) / 0.08));
            return (float) v;
        }
    }

    /** Per-ear gain + equalizer on 16-bit stereo PCM. Other formats pass through untouched. */
    static final class BalanceProcessor extends BaseAudioProcessor {
        private final EqDsp eq = new EqDsp();
        private int rate = 44100;
        private int seen = -1;

        @Override
        protected AudioFormat onConfigure(AudioFormat inputAudioFormat) throws UnhandledAudioFormatException {
            if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT || inputAudioFormat.channelCount != 2) {
                return AudioFormat.NOT_SET;      // inactive for this stream
            }
            rate = inputAudioFormat.sampleRate;
            seen = -1;                           // recompute filters for the new sample rate
            return inputAudioFormat;
        }

        @Override
        public void queueInput(ByteBuffer inputBuffer) {
            int remaining = inputBuffer.remaining();
            if (remaining == 0) return;
            ByteBuffer out = replaceOutputBuffer(remaining);
            float l = gainLeft, r = gainRight;
            boolean useEq = eqEnabled;
            if (useEq && seen != eqVersion) { eq.configure(rate, eqGains, eqPreamp); seen = eqVersion; }
            if (useEq && eq.count == 0 && eq.pre == 1.0) useEq = false;
            if (!useEq && l == 1f && r == 1f) {
                out.put(inputBuffer);
            } else if (!useEq) {
                while (inputBuffer.remaining() >= 4) {
                    int a = Math.round(inputBuffer.getShort() * l);
                    int b = Math.round(inputBuffer.getShort() * r);
                    out.putShort((short) Math.max(-32768, Math.min(32767, a)));
                    out.putShort((short) Math.max(-32768, Math.min(32767, b)));
                }
                if (inputBuffer.hasRemaining()) out.put(inputBuffer);
            } else {
                while (inputBuffer.remaining() >= 4) {
                    float a = eq.process(0, inputBuffer.getShort() / 32768f) * l;
                    float b = eq.process(1, inputBuffer.getShort() / 32768f) * r;
                    out.putShort((short) Math.max(-32768, Math.min(32767, Math.round(a * 32767f))));
                    out.putShort((short) Math.max(-32768, Math.min(32767, Math.round(b * 32767f))));
                }
                if (inputBuffer.hasRemaining()) out.put(inputBuffer);
            }
            out.flip();
        }
    }

    private ExoPlayer player;
    private MediaSession session;
    private AudioAttributes mediaAttrs;
    private static volatile OndaPlaybackService inst;
    // ── lyrics section loop: seek back to loopStart when playback reaches loopEnd (polls only while a loop is set) ──
    private volatile long loopStart = 0, loopEnd = -1;
    private final Runnable loopTick = new Runnable() {
        @Override public void run() {
            try {
                if (player == null || loopEnd <= 0) return;
                long pos = player.getCurrentPosition();
                if (player.isPlaying() && pos >= loopEnd) { player.seekTo(loopStart); pos = loopStart; }
                long wait = player.isPlaying() ? Math.max(15, Math.min(250, loopEnd - pos - 25)) : 400;
                statsHandler.postDelayed(this, wait);
            } catch (Throwable ignored) { }
        }
    };
    /** startMs / endMs in the current track; endMs <= 0 clears the loop. */
    public static void setLoop(final long startMs, final long endMs) {
        final OndaPlaybackService s = inst;
        if (s == null) return;
        s.statsHandler.post(new Runnable() {
            @Override public void run() {
                s.statsHandler.removeCallbacks(s.loopTick);
                if (endMs > startMs && s.player != null) {
                    long dur = s.player.getDuration();
                    s.loopStart = Math.max(0, startMs);
                    s.loopEnd = dur > 0 ? Math.min(endMs, dur - 300) : endMs;
                    if (s.loopEnd <= s.loopStart) { s.loopEnd = -1; return; }
                    s.statsHandler.post(s.loopTick);
                } else s.loopEnd = -1;
            }
        });
    }
    private final Runnable suppressPause = new Runnable() {
        @Override public void run() {
            try {
                if (player != null && player.getPlayWhenReady() && player.getPlaybackSuppressionReason() != Player.PLAYBACK_SUPPRESSION_REASON_NONE) player.pause();
            } catch (Throwable ignored) { }
        }
    };

    // ── Audio page options (stored natively so they also apply when the service starts without the app) ──
    static final String AUDIO_PREFS = "onda_audio";
    private boolean dingOn = false;
    private int albumRun = 0;
    private String runAlbum = "";

    /** Force audio: never pause / duck when another app asks for audio focus. */
    public static void applyForceAudio(final boolean force) {
        final OndaPlaybackService s = inst;
        if (s == null || s.player == null) return;
        new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() {
                try { if (s.player != null) s.player.setAudioAttributes(s.mediaAttrs, /* handleAudioFocus= */ !force); } catch (Throwable ignored) { }
            }
        });
    }
    public static void applyDing(boolean on) { OndaPlaybackService s = inst; if (s != null) s.dingOn = on; }

    private static short[] dingPcm;
    /** A short bell: three decaying partials, synthesised once. Plays on its own AudioTrack, so it mixes over the music without taking audio focus. */
    static void playDing() {
        try {
            final int sr = 44100, n = (int) (sr * 1.1);
            if (dingPcm == null) {
                short[] d = new short[n];
                double[] f = { 1046.5, 2093.0, 3136.0 }, a = { 1.0, 0.45, 0.22 }, k = { 3.2, 4.6, 6.5 };
                for (int i = 0; i < n; i++) {
                    double t = i / (double) sr, v = 0;
                    for (int j = 0; j < 3; j++) v += a[j] * Math.sin(2 * Math.PI * f[j] * t) * Math.exp(-k[j] * t);
                    double atk = Math.min(1.0, t / 0.004);
                    d[i] = (short) (v * atk * 0.55 * 32767 / 1.67);
                }
                dingPcm = d;
            }
            final android.media.AudioTrack tr = new android.media.AudioTrack.Builder()
                .setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(new android.media.AudioFormat.Builder().setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT).setSampleRate(sr).setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(dingPcm.length * 2).setTransferMode(android.media.AudioTrack.MODE_STATIC).build();
            tr.write(dingPcm, 0, dingPcm.length);
            tr.setNotificationMarkerPosition(dingPcm.length - 64);
            tr.setPlaybackPositionUpdateListener(new android.media.AudioTrack.OnPlaybackPositionUpdateListener() {
                @Override public void onMarkerReached(android.media.AudioTrack t) { try { t.release(); } catch (Throwable ignored) { } }
                @Override public void onPeriodicNotification(android.media.AudioTrack t) { }
            });
            tr.play();
        } catch (Throwable ignored) { }
    }
    private final android.os.Handler statsHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable statsPulse = new Runnable() {
        @Override public void run() {
            try { if (player != null && player.isPlaying()) { OndaStats.tick(OndaPlaybackService.this, true); statsHandler.postDelayed(this, 15000); } } catch (Throwable ignored) { }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();

        // the Onda mark as the notification / status-bar glyph (white-on-transparent vector, looked up by name so a missing file can't break the build)
        try {
            int stat = getResources().getIdentifier("ic_stat_onda", "drawable", getPackageName());
            if (stat != 0) {
                androidx.media3.session.DefaultMediaNotificationProvider np = new androidx.media3.session.DefaultMediaNotificationProvider(this);
                np.setSmallIcon(stat);
                setMediaNotificationProvider(np);
            }
        } catch (Throwable ignored) { /* keep Media3's default icon */ }


        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build();
        mediaAttrs = attrs;
        inst = this;
        boolean force = false;
        try {
            android.content.SharedPreferences ap = getSharedPreferences(AUDIO_PREFS, Context.MODE_PRIVATE);
            force = ap.getBoolean("force", false);
            dingOn = ap.getBoolean("ding", false);
        } catch (Throwable ignored) { }

        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this) {
            @Override
            protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput, boolean enableAudioTrackPlaybackParams) {
                return new DefaultAudioSink.Builder(context)
                    .setAudioProcessors(new AudioProcessor[] { new BalanceProcessor() })
                    .build();
            }
        };

        // MP3 files without a seek table: seek by constant bitrate → instant, no scanning through the file
        DefaultExtractorsFactory extractors = new DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true);

        player = new ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(this, extractors))
            .setAudioAttributes(attrs, /* handleAudioFocus= */ !force)
            .setHandleAudioBecomingNoisy(true)   // pause when headphones are unplugged
            .setWakeMode(C.WAKE_MODE_LOCAL)      // keep the CPU awake while playing local files
            .build();

        OndaStats.active = true;

        // keep the home-screen widget in step (explicit broadcast to our own widget provider; harmless if there is none)
        player.addListener(new Player.Listener() {
            @Override public void onMediaItemTransition(MediaItem item, int reason) {
                try {
                    String alb = item == null || item.mediaMetadata.albumTitle == null ? "" : item.mediaMetadata.albumTitle.toString().trim().toLowerCase();
                    boolean auto = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO;
                    if (auto && !alb.isEmpty() && alb.equals(runAlbum)) albumRun++;
                    else {
                        if (auto && dingOn && albumRun >= 2 && !runAlbum.isEmpty()) playDing();   // an album just played through
                        albumRun = alb.isEmpty() ? 0 : 1; runAlbum = alb;
                    }
                } catch (Throwable ignored) { }
                loopEnd = -1; statsHandler.removeCallbacks(loopTick);   // a lyrics loop belongs to one track
                pushWidget();
                try { OndaStats.track(OndaPlaybackService.this, item == null ? "" : item.mediaId, player.getDuration() > 0 ? player.getDuration() : 0, player.isPlaying()); } catch (Throwable ignored) { }
            }
            @Override public void onPlaybackStateChanged(int st) {
                if (st == Player.STATE_ENDED && dingOn && albumRun >= 2) { playDing(); albumRun = 0; runAlbum = ""; }
                if (st == Player.STATE_READY) { try { OndaStats.duration(player.getDuration()); } catch (Throwable ignored) { } }
            }
            @Override public void onIsPlayingChanged(boolean isPlaying) {
                pushWidget();
                try {
                    MediaItem cur = player.getCurrentMediaItem();
                    if (cur != null && isPlaying) OndaStats.duration(player.getDuration());
                    OndaStats.tick(OndaPlaybackService.this, isPlaying);
                    if (isPlaying) statsHandler.postDelayed(statsPulse, 15000); else statsHandler.removeCallbacks(statsPulse);
                } catch (Throwable ignored) { }
            }
            @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) { pushWidget(); }
            // Another app grabbed audio focus "temporarily" (a video, a call...). ExoPlayer keeps playWhenReady=true and
            // resumes by itself later — but then the notification still looks like it is playing. Short blips (navigation
            // prompts, pings) resume on their own; if the silence lasts, really pause so every control shows ▶.
            @Override public void onPlaybackSuppressionReasonChanged(int reason) {
                statsHandler.removeCallbacks(suppressPause);
                if (reason != Player.PLAYBACK_SUPPRESSION_REASON_NONE) statsHandler.postDelayed(suppressPause, 5000);
                pushWidget();
            }
            @Override public void onMediaMetadataChanged(MediaMetadata metadata) { pushWidget(); }
        });

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        session = new MediaSession.Builder(this, player)
            .setShowPlayButtonIfPlaybackIsSuppressed(true)
            .setSessionActivity(pi)
            .build();
    }

    private void pushWidget() {
        try {
            if (player == null) return;
            MediaMetadata m = player.getMediaMetadata();
            Intent i = new Intent("com.erikasado.onda.WIDGET_UPDATE");
            // explicit component: the widget receiver only declares APPWIDGET_UPDATE in its intent filter, so a
            // package-only broadcast with a custom action would never reach it (that was why the widget stayed idle)
            i.setComponent(new android.content.ComponentName(getPackageName(), "com.erikasado.onda.OndaWidgetProvider"));
            i.putExtra("title", m.title == null ? "" : m.title.toString());
            i.putExtra("artist", m.artist == null ? "" : m.artist.toString());
            i.putExtra("art", m.artworkUri == null ? "" : m.artworkUri.toString());
            i.putExtra("playing", player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED);
            sendBroadcast(i);
        } catch (Throwable ignored) { /* widget is optional */ }
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /** Swiping the app away keeps music playing; if nothing is playing, shut the service down. */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        if (player == null || !player.getPlayWhenReady() || player.getMediaItemCount() == 0) {
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        if (inst == this) inst = null;
        statsHandler.removeCallbacks(statsPulse); statsHandler.removeCallbacks(suppressPause); statsHandler.removeCallbacks(loopTick);
        try { OndaStats.tick(this, false); } catch (Throwable ignored) { }
        try {   // leave the widget showing "paused" instead of a stale "playing" state
            Intent w = new Intent("com.erikasado.onda.WIDGET_UPDATE");
            w.setComponent(new android.content.ComponentName(getPackageName(), "com.erikasado.onda.OndaWidgetProvider"));
            if (player != null) {
                MediaMetadata m = player.getMediaMetadata();
                w.putExtra("title", m.title == null ? "" : m.title.toString());
                w.putExtra("artist", m.artist == null ? "" : m.artist.toString());
                w.putExtra("art", m.artworkUri == null ? "" : m.artworkUri.toString());
            }
            w.putExtra("playing", false);
            sendBroadcast(w);
        } catch (Throwable ignored) { }
        if (session != null) {
            session.release();
            session = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
