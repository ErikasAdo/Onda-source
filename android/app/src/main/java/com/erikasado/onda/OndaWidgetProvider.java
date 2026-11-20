package com.erikasado.onda;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.widget.RemoteViews;

import androidx.core.content.ContextCompat;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.google.common.util.concurrent.ListenableFuture;

/**
 * Home-screen widget: cover, title, artist and previous / play-pause / next.
 * The playback service pushes its state here with an explicit broadcast (ACTION_UPDATE);
 * the buttons talk to the service through a short-lived MediaController.
 * Tapping the cover or the text opens the app.
 */
public class OndaWidgetProvider extends AppWidgetProvider {

    static final String ACTION_UPDATE = "com.erikasado.onda.WIDGET_UPDATE";
    static final String ACTION_PLAY = "com.erikasado.onda.WIDGET_PLAY";
    static final String ACTION_NEXT = "com.erikasado.onda.WIDGET_NEXT";
    static final String ACTION_PREV = "com.erikasado.onda.WIDGET_PREV";
    private static final String PREFS = "onda_widget";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(ctx));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (ACTION_UPDATE.equals(a)) {
            SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
            e.putString("title", intent.getStringExtra("title"));
            e.putString("artist", intent.getStringExtra("artist"));
            e.putString("art", intent.getStringExtra("art"));
            e.putBoolean("playing", intent.getBooleanExtra("playing", false));
            e.apply();
            refresh(ctx);
            return;
        }
        if (ACTION_PLAY.equals(a) || ACTION_NEXT.equals(a) || ACTION_PREV.equals(a)) {
            control(ctx, a);
            return;
        }
        super.onReceive(ctx, intent);
    }

    private static void refresh(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, OndaWidgetProvider.class));
        if (ids != null && ids.length > 0) mgr.updateAppWidget(ids, build(ctx));
    }

    private static PendingIntent action(Context ctx, String action, int code) {
        Intent i = new Intent(ctx, OndaWidgetProvider.class);
        i.setAction(action);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static Bitmap cover(String art) {
        if (art == null || art.isEmpty()) return null;
        try {
            String path = Uri.parse(art).getPath();
            if (path == null) return null;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, o);
            int s = 1;
            while (o.outWidth / (s * 2) >= 256 && o.outHeight / (s * 2) >= 256) s *= 2;
            BitmapFactory.Options d = new BitmapFactory.Options();
            d.inSampleSize = s;
            return BitmapFactory.decodeFile(path, d);
        } catch (Throwable t) {
            return null;
        }
    }

    static RemoteViews build(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String title = p.getString("title", null), artist = p.getString("artist", null);
        boolean playing = p.getBoolean("playing", false);
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.onda_widget);
        rv.setTextViewText(R.id.w_title, title == null || title.isEmpty() ? "Onda" : title);
        rv.setTextViewText(R.id.w_artist, title == null || title.isEmpty() ? "Tap to open your music" : (artist == null ? "" : artist));
        Bitmap bmp = cover(p.getString("art", null));
        if (bmp != null) rv.setImageViewBitmap(R.id.w_art, bmp); else rv.setImageViewResource(R.id.w_art, R.drawable.onda_widget_noart);
        rv.setImageViewResource(R.id.w_play, playing ? R.drawable.ic_w_pause : R.drawable.ic_w_play);
        rv.setOnClickPendingIntent(R.id.w_play, action(ctx, ACTION_PLAY, 1));
        rv.setOnClickPendingIntent(R.id.w_next, action(ctx, ACTION_NEXT, 2));
        rv.setOnClickPendingIntent(R.id.w_prev, action(ctx, ACTION_PREV, 3));
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        rv.setOnClickPendingIntent(R.id.w_art, pi);
        rv.setOnClickPendingIntent(R.id.w_text, pi);
        return rv;
    }

    private void control(final Context ctx, final String action) {
        final BroadcastReceiver.PendingResult pr = goAsync();
        try {
            SessionToken token = new SessionToken(ctx, new ComponentName(ctx, OndaPlaybackService.class));
            final ListenableFuture<MediaController> f = new MediaController.Builder(ctx, token).buildAsync();
            f.addListener(new Runnable() {
                @Override
                public void run() {
                    try {
                        MediaController c = f.get();
                        if (ACTION_PLAY.equals(action)) {
                            if (c.getPlayWhenReady()) c.pause(); else c.play();
                        } else if (ACTION_NEXT.equals(action)) {
                            if (c.hasNextMediaItem()) c.seekToNextMediaItem();
                        } else if (c.hasPreviousMediaItem()) {
                            c.seekToPreviousMediaItem();
                        }
                    } catch (Throwable ignored) {
                        /* service not running / nothing queued */
                    } finally {
                        MediaController.releaseFuture(f);
                        pr.finish();
                    }
                }
            }, ContextCompat.getMainExecutor(ctx));
        } catch (Throwable t) {
            pr.finish();
        }
    }
}
