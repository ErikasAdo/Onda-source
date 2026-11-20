package com.erikasado.onda;

import android.app.PendingIntent;
import android.content.Intent;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/**
 * Foreground media service. The ExoPlayer lives HERE (not in the WebView), so audio keeps playing
 * and the media notification / lock-screen controls stay alive when the app is in the background,
 * the screen is off, or the activity is swiped away.
 *
 * Media3's MediaSessionService builds the notification (play/pause/next/previous + artwork +
 * seek bar) and promotes itself to a foreground service while playing.
 */
public class OndaPlaybackService extends MediaSessionService {

    /** SAFE build: no per-ear balance (used automatically if the full service fails to compile). */
    static final boolean BALANCE_SUPPORTED = false;
    static final boolean EQ_SUPPORTED = false;

    public static void setEq(boolean enabled, float[] gainsDb, float preampDb) { /* not available in the safe build */ }
    public static void setBalance(float left, float right) { /* not supported in this build */ }

    private ExoPlayer player;
    private MediaSession session;

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

        player = new ExoPlayer.Builder(this)
            .setAudioAttributes(attrs, /* handleAudioFocus= */ true)
            .setHandleAudioBecomingNoisy(true)   // pause when headphones are unplugged
            .setWakeMode(C.WAKE_MODE_LOCAL)      // keep the CPU awake while playing local files
            .build();

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        session = new MediaSession.Builder(this, player)
            .setSessionActivity(pi)
            .build();
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
