package com.erikasado.onda;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;

/**
 * Listening-time accounting that lives next to the player, so it keeps counting with the screen off,
 * while the WebView is frozen, or after the app was swiped away. The web layer drains it on demand.
 *
 * Stored as SharedPreferences longs:  "t|YYYY-MM-DD|trackId" = ms listened,  "p|YYYY-MM-DD|trackId" = plays.
 * A "play" = 30 s listened (or half of a shorter song), counted once per time a track starts.
 */
final class OndaStats {
    private static final String FILE = "onda_stats";
    private static final Object LOCK = new Object();

    /** set by the full playback service; false in the safe fallback build (then the web layer counts instead) */
    static volatile boolean active = false;

    private static SharedPreferences prefs;
    private static String curId = "";
    private static long curDurMs = 0;
    private static long acc = 0;          // ms heard of the current track (since it started)
    private static boolean counted = false;
    private static long since = 0;        // elapsedRealtime when playback last (re)started, 0 = not playing
    private static long lastFlush = 0;

    private OndaStats() {}

    private static SharedPreferences p(Context c) {
        if (prefs == null) prefs = c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
        return prefs;
    }

    private static String day() {
        Calendar c = Calendar.getInstance();
        int m = c.get(Calendar.MONTH) + 1, d = c.get(Calendar.DAY_OF_MONTH);
        return c.get(Calendar.YEAR) + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
    }

    private static void add(Context c, String kind, String id, long v) {
        if (id == null || id.isEmpty() || v <= 0) return;
        String k = kind + "|" + day() + "|" + id;
        SharedPreferences sp = p(c);
        sp.edit().putLong(k, sp.getLong(k, 0) + v).apply();
    }

    /** Bank the time heard since the last call. Cheap — call on every state change and about every 15 s while playing. */
    static void tick(Context c, boolean playing) {
        synchronized (LOCK) {
            long now = SystemClock.elapsedRealtime();
            if (since != 0) {
                long dt = Math.min(now - since, 10 * 60000L);
                if (dt > 0 && !curId.isEmpty()) {
                    add(c, "t", curId, dt);
                    acc += dt;
                    if (!counted) {
                        long need = curDurMs > 0 ? Math.min(30000L, curDurMs / 2) : 30000L;
                        if (acc >= need) { counted = true; add(c, "p", curId, 1); }
                    }
                }
            }
            since = playing ? now : 0;
            lastFlush = now;
        }
    }

    /** A different track (or a repeat of the same one) started. Banks what was heard of the previous one first. */
    static void track(Context c, String id, long durMs, boolean playing) {
        synchronized (LOCK) {
            tick(c, false);
            curId = id == null ? "" : id;
            curDurMs = durMs;
            acc = 0; counted = false;
            since = playing ? SystemClock.elapsedRealtime() : 0;
        }
    }

    static void duration(long durMs) { synchronized (LOCK) { if (durMs > 0) curDurMs = durMs; } }

    static boolean due() { synchronized (LOCK) { return since != 0 && SystemClock.elapsedRealtime() - lastFlush > 15000; } }

    /** Everything counted so far as day|id → [ms, plays]; clears it. */
    static Map<String, long[]> drain(Context c) {
        synchronized (LOCK) {
            tick(c, since != 0);   // include what is being heard right now
            SharedPreferences sp = p(c);
            Map<String, ?> all = sp.getAll();
            Map<String, long[]> out = new HashMap<String, long[]>();
            SharedPreferences.Editor ed = sp.edit();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                String k = e.getKey();
                if (!(e.getValue() instanceof Long) || k.length() < 14) continue;
                char kind = k.charAt(0);
                if ((kind != 't' && kind != 'p') || k.charAt(1) != '|') continue;
                String rest = k.substring(2);
                long[] a = out.get(rest);
                if (a == null) { a = new long[2]; out.put(rest, a); }
                a[kind == 't' ? 0 : 1] += (Long) e.getValue();
                ed.remove(k);
            }
            ed.apply();
            return out;
        }
    }
}
