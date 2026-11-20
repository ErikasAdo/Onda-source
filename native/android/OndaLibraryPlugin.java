package com.erikasado.onda;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import android.content.ContentUris;
import android.database.ContentObserver;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * OndaLibrary — reads the phone's music library from MediaStore.
 *
 *   checkPermission()   → { granted }
 *   requestPermission() → { granted }          (READ_MEDIA_AUDIO on Android 13+, READ_EXTERNAL_STORAGE before)
 *   scan()              → { tracks: [...] }    id, uri, path, title, artist, album, albumArtist, track, year, genre,
 *                                              duration (s), size, name, dateAdded, dateModified
 *   getArt({ uri })     → { data }             base64 of the embedded cover (empty object if none)
 *   deleteTracks({ uris }) → { deleted, cancelled }   removes the files from the phone (system confirmation on Android 10+)
 *   event libraryChanged                       fired (debounced) when MediaStore's audio table changes
 *
 * Copied into the generated Android project by scripts/patch-native.mjs.
 */
@CapacitorPlugin(
    name = "OndaLibrary",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "audioLegacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "writeLegacy", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class OndaLibraryPlugin extends Plugin {

    // ── auto-scan: tell the UI whenever the phone's audio library changes (song added / deleted / re-tagged) ──
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ContentObserver observer;
    private final Runnable fire = new Runnable() {
        @Override
        public void run() {
            notifyListeners("libraryChanged", new JSObject());
        }
    };

    @Override
    public void load() {
        observer = new ContentObserver(handler) {
            @Override
            public void onChange(boolean selfChange) {
                handler.removeCallbacks(fire);
                handler.postDelayed(fire, 1500);       // bursts (copying a whole album) become one event
            }
        };
        try {
            getContext().getContentResolver().registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, observer);
        } catch (Exception ignored) {
            // no observer → the app still re-syncs every time it is opened
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (observer != null) getContext().getContentResolver().unregisterContentObserver(observer);
        } catch (Exception ignored) { }
        handler.removeCallbacks(fire);
    }

    private String permissionAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "audioLegacy";
    }

    private boolean isGranted() {
        return getPermissionState(permissionAlias()) == PermissionState.GRANTED;
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", isGranted());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (isGranted()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias(permissionAlias(), call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", isGranted());
        call.resolve(ret);
    }

    @PluginMethod
    public void scan(final PluginCall call) {
        if (!isGranted()) {
            call.reject("Audio permission not granted");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    JSArray tracks = queryTracks();
                    JSObject ret = new JSObject();
                    ret.put("tracks", tracks);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("Scan failed: " + e.getMessage());
                }
            }
        }).start();
    }

    private JSArray queryTracks() {
        Uri collection = Build.VERSION.SDK_INT >= 29
            ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;

        List<String> cols = new ArrayList<>();
        cols.add(MediaStore.Audio.Media._ID);
        cols.add(MediaStore.Audio.Media.TITLE);
        cols.add(MediaStore.Audio.Media.ARTIST);
        cols.add(MediaStore.Audio.Media.ALBUM);
        cols.add(MediaStore.Audio.Media.TRACK);
        cols.add(MediaStore.Audio.Media.YEAR);
        cols.add(MediaStore.Audio.Media.DURATION);
        cols.add(MediaStore.Audio.Media.SIZE);
        cols.add(MediaStore.Audio.Media.DISPLAY_NAME);
        cols.add(MediaStore.Audio.Media.DATA);
        cols.add(MediaStore.Audio.Media.DATE_ADDED);
        cols.add(MediaStore.Audio.Media.DATE_MODIFIED);
        if (Build.VERSION.SDK_INT >= 30) {
            cols.add("album_artist");
            cols.add("genre");
        }

        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0 AND " + MediaStore.Audio.Media.DURATION + " >= 20000";
        String order = MediaStore.Audio.Media.ARTIST + " COLLATE NOCASE ASC, " + MediaStore.Audio.Media.ALBUM + " COLLATE NOCASE ASC, " + MediaStore.Audio.Media.TRACK + " ASC";

        JSArray out = new JSArray();
        Cursor c = getContext().getContentResolver().query(collection, cols.toArray(new String[0]), selection, null, order);
        if (c == null) return out;
        try {
            int iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
            int iTitle = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
            int iArtist = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
            int iAlbum = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
            int iTrack = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK);
            int iYear = c.getColumnIndexOrThrow(MediaStore.Audio.Media.YEAR);
            int iDur = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
            int iSize = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
            int iName = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
            int iData = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
            int iAdded = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED);
            int iMod = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED);
            int iAlbumArtist = c.getColumnIndex("album_artist");
            int iGenre = c.getColumnIndex("genre");

            while (c.moveToNext()) {
                long id = c.getLong(iId);
                JSObject o = new JSObject();
                o.put("id", String.valueOf(id));
                o.put("uri", ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id).toString());
                o.put("path", clean(c.getString(iData)));
                o.put("title", clean(c.getString(iTitle)));
                o.put("artist", clean(c.getString(iArtist)));
                o.put("album", clean(c.getString(iAlbum)));
                o.put("albumArtist", iAlbumArtist >= 0 ? clean(c.getString(iAlbumArtist)) : "");
                o.put("genre", iGenre >= 0 ? clean(c.getString(iGenre)) : "");
                int track = c.getInt(iTrack);
                o.put("track", track > 1000 ? track % 1000 : track); // 1003 = disc 1, track 3
                o.put("year", c.getInt(iYear));
                o.put("duration", c.getLong(iDur) / 1000.0);
                o.put("size", c.getLong(iSize));
                o.put("name", clean(c.getString(iName)));
                o.put("dateAdded", c.getLong(iAdded));
                o.put("dateModified", c.getLong(iMod));
                out.put(o);
            }
        } finally {
            c.close();
        }
        return out;
    }

    /** MediaStore uses "<unknown>" for missing tags. */
    private String clean(String s) {
        if (s == null) return "";
        String t = s.trim();
        return "<unknown>".equals(t) ? "" : t;
    }

    // ── delete songs from the device ───────────────────────────────────────────
    static final int REQ_DELETE = 7461;
    private static OndaLibraryPlugin current;
    private static PluginCall pendingDelete;
    private static List<Uri> pendingUris;
    private static int pendingDone, pendingMode;

    @PluginMethod
    public void deleteTracks(final PluginCall call) {
        current = this;
        JSArray arr = call.getArray("uris");
        if (arr == null || arr.length() == 0) { call.reject("nothing to delete"); return; }
        if (Build.VERSION.SDK_INT <= 28 && getPermissionState("writeLegacy") != PermissionState.GRANTED) {
            requestPermissionForAlias("writeLegacy", call, "deletePermissionCallback");
            return;
        }
        runDelete(call);
    }

    @PermissionCallback
    private void deletePermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT <= 28 && getPermissionState("writeLegacy") != PermissionState.GRANTED) { call.reject("Allow storage access to delete songs"); return; }
        runDelete(call);
    }

    private void runDelete(PluginCall call) {
        try {
            JSArray arr = call.getArray("uris");
            List<Uri> uris = new ArrayList<Uri>();
            for (int i = 0; i < arr.length(); i++) { String u = arr.getString(i); if (u != null && u.startsWith("content://")) uris.add(Uri.parse(u)); }
            if (uris.isEmpty()) { call.reject("nothing to delete"); return; }
            android.content.ContentResolver cr = getContext().getContentResolver();
            if (Build.VERSION.SDK_INT >= 30) {
                // Android 11+: one system dialog, then the files are gone
                pendingDelete = call; pendingUris = uris; pendingMode = 30; pendingDone = 0;
                getActivity().startIntentSenderForResult(MediaStore.createDeleteRequest(cr, uris).getIntentSender(), REQ_DELETE, null, 0, 0, 0);
                return;
            }
            deleteBatch(call, uris, 0);
        } catch (Throwable t) {
            call.reject("Couldn’t delete: " + t.getMessage());
        }
    }

    /** Android 9 and older delete directly; Android 10 asks per file (RecoverableSecurityException) and we retry after the user agrees. */
    private void deleteBatch(PluginCall call, List<Uri> uris, int done) {
        android.content.ContentResolver cr = getContext().getContentResolver();
        List<Uri> left = new ArrayList<Uri>(uris);
        while (!left.isEmpty()) {
            Uri u = left.get(0);
            try {
                done += cr.delete(u, null, null) > 0 ? 1 : 0;
                left.remove(0);
            } catch (SecurityException se) {
                if (Build.VERSION.SDK_INT >= 29 && se instanceof android.app.RecoverableSecurityException) {
                    try {
                        pendingDelete = call; pendingUris = left; pendingMode = 29; pendingDone = done;
                        getActivity().startIntentSenderForResult(((android.app.RecoverableSecurityException) se).getUserAction().getActionIntent().getIntentSender(), REQ_DELETE, null, 0, 0, 0);
                        return;
                    } catch (Throwable t) { call.reject("Couldn’t ask for permission"); return; }
                }
                call.reject("Not allowed to delete this file");
                return;
            }
        }
        JSObject r = new JSObject(); r.put("deleted", done); call.resolve(r);
    }

    static void onDeleteResult(int resultCode) {
        final PluginCall call = pendingDelete; pendingDelete = null;
        if (call == null || current == null) return;
        boolean ok = resultCode == android.app.Activity.RESULT_OK;
        if (pendingMode == 30) {
            JSObject r = new JSObject(); r.put("deleted", ok ? pendingUris.size() : 0); r.put("cancelled", !ok); call.resolve(r);
        } else if (ok) {
            current.deleteBatch(call, pendingUris, pendingDone);
        } else {
            JSObject r = new JSObject(); r.put("deleted", pendingDone); r.put("cancelled", true); call.resolve(r);
        }
    }

    // ── write tags into the real files ─────────────────────────────────────────
    static final int REQ_WRITE = 7462;
    private static PluginCall pendingTag;
    private static List<org.json.JSONObject> pendingTagItems;
    private static int pendingTagMode, pendingTagDone;
    private static List<String> pendingTagFailed;
    private static List<Uri> pendingTagWritten;

    /** items: [{ uri, title, artist, album, albumArtist, genre, track, trackTotal, disc, discTotal, year }] */
    @PluginMethod
    public void tagTracks(final PluginCall call) {
        current = this;
        JSArray arr = call.getArray("items");
        if (arr == null || arr.length() == 0) { call.reject("nothing to fix"); return; }
        if (Build.VERSION.SDK_INT <= 28 && getPermissionState("writeLegacy") != PermissionState.GRANTED) {
            requestPermissionForAlias("writeLegacy", call, "tagPermissionCallback");
            return;
        }
        runTag(call);
    }

    @PermissionCallback
    private void tagPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT <= 28 && getPermissionState("writeLegacy") != PermissionState.GRANTED) { call.reject("Allow storage access so Onda can edit the files"); return; }
        runTag(call);
    }

    private void runTag(PluginCall call) {
        try {
            JSArray arr = call.getArray("items");
            List<org.json.JSONObject> items = new ArrayList<org.json.JSONObject>();
            List<Uri> uris = new ArrayList<Uri>();
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject o = arr.getJSONObject(i);
                String u = o.optString("uri", "");
                if (u.startsWith("content://")) { items.add(o); uris.add(Uri.parse(u)); }
            }
            if (items.isEmpty()) { call.reject("nothing to fix"); return; }
            pendingTag = call; pendingTagItems = items; pendingTagDone = 0; pendingTagFailed = new ArrayList<String>(); pendingTagWritten = new ArrayList<Uri>();
            if (Build.VERSION.SDK_INT >= 30) {
                // Android 11+: one system dialog for the whole album, then we may write
                pendingTagMode = 30;
                getActivity().startIntentSenderForResult(MediaStore.createWriteRequest(getContext().getContentResolver(), uris).getIntentSender(), REQ_WRITE, null, 0, 0, 0);
                return;
            }
            pendingTagMode = Build.VERSION.SDK_INT >= 29 ? 29 : 28;
            startTagThread();
        } catch (Throwable t) {
            call.reject("Couldn’t edit the files: " + t.getMessage());
        }
    }

    private void startTagThread() {
        new Thread(new Runnable() { @Override public void run() { tagBatch(); } }).start();
    }

    /** writes the pending items one by one; Android 10 may ask the user once per file (RecoverableSecurityException) */
    private void tagBatch() {
        final PluginCall call = pendingTag;
        if (call == null) return;
        android.content.ContentResolver cr = getContext().getContentResolver();
        while (!pendingTagItems.isEmpty()) {
            org.json.JSONObject o = pendingTagItems.get(0);
            Uri u = Uri.parse(o.optString("uri"));
            try {
                writeOneFile(cr, u, o);
                pendingTagDone++;
                pendingTagWritten.add(u);
                pendingTagItems.remove(0);
                updateMediaStore(cr, u, o);
            } catch (SecurityException se) {
                if (Build.VERSION.SDK_INT >= 29 && se instanceof android.app.RecoverableSecurityException) {
                    final android.app.RecoverableSecurityException rse = (android.app.RecoverableSecurityException) se;
                    getActivity().runOnUiThread(new Runnable() {
                        @Override public void run() {
                            try { getActivity().startIntentSenderForResult(rse.getUserAction().getActionIntent().getIntentSender(), REQ_WRITE, null, 0, 0, 0); }
                            catch (Throwable t) { finishTag(true); }
                        }
                    });
                    return;
                }
                pendingTagFailed.add(o.optString("name", o.optString("title", "song")));
                pendingTagItems.remove(0);
            } catch (Throwable t) {
                pendingTagFailed.add(o.optString("name", o.optString("title", "song")));
                pendingTagItems.remove(0);
            }
        }
        finishTag(false);
    }

    private void finishTag(boolean cancelled) {
        PluginCall call = pendingTag; pendingTag = null;
        if (call == null) return;
        List<Uri> done = pendingTagWritten;
        // let the system re-read the tags of everything we changed
        try {
            List<String> paths = new ArrayList<String>();
            for (Uri u : done) {
                Cursor c = getContext().getContentResolver().query(u, new String[] { MediaStore.Audio.Media.DATA }, null, null, null);
                if (c != null) { try { if (c.moveToFirst() && c.getString(0) != null) paths.add(c.getString(0)); } finally { c.close(); } }
            }
            if (!paths.isEmpty()) android.media.MediaScannerConnection.scanFile(getContext(), paths.toArray(new String[0]), null, null);
        } catch (Throwable ignored) { /* the library's auto-scan catches up */ }
        JSObject r = new JSObject();
        r.put("written", pendingTagDone);
        r.put("cancelled", cancelled);
        JSArray failed = new JSArray();
        for (String f : pendingTagFailed) failed.put(f);
        r.put("failed", failed);
        call.resolve(r);
    }

    static void onWriteResult(int resultCode) {
        if (pendingTag == null || current == null) return;
        boolean ok = resultCode == android.app.Activity.RESULT_OK;
        if (!ok) { current.finishTag(true); return; }
        current.startTagThread();     // mode 30: all files may be written now; mode 29: retry the file that asked
    }

    /** backup → new tag + original audio written over the file; if anything goes wrong the backup is put back */
    private void writeOneFile(android.content.ContentResolver cr, Uri uri, org.json.JSONObject o) throws Exception {
        java.io.File bak = java.io.File.createTempFile("onda_tag", ".bak", getContext().getCacheDir());
        try {
            java.io.InputStream in = cr.openInputStream(uri);
            if (in == null) throw new java.io.IOException("can't read");
            java.io.OutputStream bo = new java.io.FileOutputStream(bak);
            try {
                byte[] buf = new byte[65536]; int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            } finally { in.close(); bo.close(); }

            OndaTagWriter.Tags t = new OndaTagWriter.Tags();
            t.title = o.optString("title", ""); t.artist = o.optString("artist", ""); t.album = o.optString("album", "");
            t.albumArtist = o.optString("albumArtist", ""); t.genre = o.optString("genre", "");
            t.track = o.optInt("track", 0); t.trackTotal = o.optInt("trackTotal", 0); t.disc = o.optInt("disc", 0); t.discTotal = o.optInt("discTotal", 0); t.year = o.optInt("year", 0);

            java.io.OutputStream os = cr.openOutputStream(uri, "wt");     // throws (nothing touched yet) when we lack permission
            if (os == null) throw new java.io.IOException("can't write");
            try {
                OndaTagWriter.rewrite(bak, os, t);
            } catch (Throwable fail) {
                try { os.close(); } catch (Throwable ignored) { }
                restoreFile(cr, uri, bak);
                throw new java.io.IOException("write failed: " + fail.getMessage());
            }
            os.close();
        } finally {
            //noinspection ResultOfMethodCallIgnored
            bak.delete();
        }
    }

    private void restoreFile(android.content.ContentResolver cr, Uri uri, java.io.File bak) {
        try {
            java.io.OutputStream os = cr.openOutputStream(uri, "wt");
            java.io.InputStream in = new java.io.FileInputStream(bak);
            byte[] buf = new byte[65536]; int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            in.close(); os.close();
        } catch (Throwable ignored) { /* nothing more we can do */ }
    }

    private void updateMediaStore(android.content.ContentResolver cr, Uri uri, org.json.JSONObject o) {
        try {
            android.content.ContentValues v = new android.content.ContentValues();
            v.put(MediaStore.Audio.Media.TITLE, o.optString("title", ""));
            v.put(MediaStore.Audio.Media.ARTIST, o.optString("artist", ""));
            v.put(MediaStore.Audio.Media.ALBUM, o.optString("album", ""));
            int tr = o.optInt("track", 0), disc = o.optInt("disc", 0);
            if (tr > 0) v.put(MediaStore.Audio.Media.TRACK, disc > 1 ? disc * 1000 + tr : tr);
            if (o.optInt("year", 0) > 0) v.put(MediaStore.Audio.Media.YEAR, o.optInt("year"));
            cr.update(uri, v, null, null);
        } catch (Throwable ignored) { /* the scan below re-reads the file anyway */ }
    }

    @PluginMethod
    public void getArt(final PluginCall call) {
        final String uri = call.getString("uri");
        final int maxPx = call.getInt("max", 0);
        if (uri == null || uri.isEmpty()) {
            call.reject("uri required");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                MediaMetadataRetriever mmr = new MediaMetadataRetriever();
                JSObject ret = new JSObject();
                try {
                    mmr.setDataSource(getContext(), Uri.parse(uri));
                    byte[] pic = mmr.getEmbeddedPicture();
                    if (pic != null && pic.length > 0) {
                        // shrink big covers here: a 3 MB base64 string through the bridge is the slow part of setup
                        if (maxPx > 0 && pic.length > 120 * 1024) {
                            try {
                                android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                                o.inJustDecodeBounds = true;
                                android.graphics.BitmapFactory.decodeByteArray(pic, 0, pic.length, o);
                                int s = 1;
                                while (o.outWidth / (s * 2) >= maxPx && o.outHeight / (s * 2) >= maxPx) s *= 2;
                                android.graphics.BitmapFactory.Options d = new android.graphics.BitmapFactory.Options();
                                d.inSampleSize = s;
                                android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(pic, 0, pic.length, d);
                                if (bmp != null) {
                                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                                    bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 88, bos);
                                    bmp.recycle();
                                    if (bos.size() > 0 && bos.size() < pic.length) pic = bos.toByteArray();
                                }
                            } catch (Throwable ignoredShrink) { /* keep the original bytes */ }
                        }
                        ret.put("data", Base64.encodeToString(pic, Base64.NO_WRAP));
                    }
                } catch (Exception ignored) {
                    // unreadable file / no art → resolve with empty object
                } finally {
                    try { mmr.release(); } catch (Exception ignored) { }
                }
                call.resolve(ret);
            }
        }).start();
    }

    /* ── backup export: lets the person choose where the .json goes (Downloads, Drive, a USB stick …) ── */

    /** { uris: [content://…], title } — opens Android's share sheet with the audio file(s) attached. */
    @PluginMethod
    public void shareFiles(PluginCall call) {
        try {
            org.json.JSONArray arr = call.getData().optJSONArray("uris");
            if (arr == null || arr.length() == 0) { call.reject("no files"); return; }
            java.util.ArrayList<android.net.Uri> uris = new java.util.ArrayList<>();
            for (int i = 0; i < arr.length(); i++) { String u = arr.optString(i, ""); if (!u.isEmpty()) uris.add(android.net.Uri.parse(u)); }
            Intent send;
            if (uris.size() == 1) {
                send = new Intent(Intent.ACTION_SEND);
                send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                send = new Intent(Intent.ACTION_SEND_MULTIPLE);
                send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            send.setType("audio/*");
            String title = call.getData().optString("title", "");
            if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            android.content.ClipData clip = android.content.ClipData.newRawUri("audio", uris.get(0));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new android.content.ClipData.Item(uris.get(i)));
            send.setClipData(clip);
            Intent chooser = Intent.createChooser(send, "Share");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Throwable t) {
            call.reject("share failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void saveText(final PluginCall call) {
        String name = call.getString("name", "onda-backup.json");
        try {
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("application/json");
            i.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(call, i, "saveTextResult");
        } catch (Exception e) {
            call.reject("Couldn't open the save dialog: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void saveTextResult(final PluginCall call, final ActivityResult result) {
        if (call == null) return;
        final JSObject ret = new JSObject();
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            ret.put("saved", false);
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        final Uri uri = result.getData().getData();
        final String text = call.getString("text", "");
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    java.io.OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt");
                    if (os == null) throw new java.io.IOException("no stream");
                    try { os.write(text.getBytes("UTF-8")); os.flush(); } finally { os.close(); }
                    ret.put("saved", true);
                    ret.put("uri", uri.toString());
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("Couldn't write the file: " + e.getMessage());
                }
            }
        }).start();
    }
}
