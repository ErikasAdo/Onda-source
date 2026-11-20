package com.erikasado.onda;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.Charset;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Minimal ID3v2 writer for MP3 files (no libraries).
 *
 * Reads the file's current tag, keeps every frame we are not replacing (cover art, lyrics, comments…),
 * writes title / artist / album / album artist / track / disc / year / genre, and copies the audio bytes
 * untouched. A stale ID3v1 block at the end is dropped. Streams in 64 KB pieces, so big files are fine.
 */
final class OndaTagWriter {

    static final class Tags {
        String title, artist, album, albumArtist, genre;
        int track, trackTotal, disc, discTotal, year;
    }

    private static final Set<String> REPLACED = new HashSet<String>(Arrays.asList(
        "TIT2", "TPE1", "TALB", "TPE2", "TRCK", "TPOS", "TYER", "TDRC", "TORY", "TDOR", "TCON", "TDAT", "TIME", "TRDA"));

    /** Writes the retagged file (new tag + original audio) from {@code src} into {@code out}. Returns the new length. */
    static long rewrite(File src, OutputStream out, Tags t) throws IOException {
        RandomAccessFile raf = new RandomAccessFile(src, "r");
        try {
            long len = raf.length();
            byte[] hdr = new byte[10];
            int version = 0;
            long audioStart = 0;
            ByteArrayOutputStream kept = new ByteArrayOutputStream();

            if (len >= 10) {
                raf.readFully(hdr);
                if (hdr[0] == 'I' && hdr[1] == 'D' && hdr[2] == '3') {
                    int ver = hdr[3] & 0xFF, flags = hdr[5] & 0xFF;
                    long size = syncsafe(hdr, 6);
                    audioStart = 10 + size + ((ver == 4 && (flags & 0x10) != 0) ? 10 : 0);
                    if (audioStart > len) audioStart = Math.min(len, 10 + size);
                    boolean plain = (ver == 3 || ver == 4) && (flags & 0x80) == 0 && (flags & 0x40) == 0;   // not unsynchronised, no extended header
                    if (plain) {
                        version = ver;
                        long pos = 10, end = 10 + size;
                        byte[] fh = new byte[10];
                        while (pos + 10 <= end) {
                            raf.seek(pos);
                            raf.readFully(fh);
                            if (fh[0] == 0) break;                                   // padding
                            String id = new String(fh, 0, 4, Charset.forName("ISO-8859-1"));
                            long fs = ver == 4 ? syncsafe(fh, 4) : be32(fh, 4);
                            if (fs < 0 || pos + 10 + fs > end) break;               // damaged → keep what we have
                            if (!REPLACED.contains(id)) {
                                byte[] body = new byte[(int) fs];
                                raf.readFully(body);
                                kept.write(fh, 0, 10);
                                kept.write(body, 0, body.length);
                            }
                            pos += 10 + fs;
                        }
                    }
                } else {
                    audioStart = 0;
                }
            }
            boolean v4 = version == 4;

            ByteArrayOutputStream tag = new ByteArrayOutputStream();
            put(tag, text("TIT2", t.title, v4));
            put(tag, text("TPE1", t.artist, v4));
            put(tag, text("TALB", t.album, v4));
            put(tag, text("TPE2", t.albumArtist, v4));
            if (t.track > 0) put(tag, text("TRCK", t.trackTotal > 0 ? t.track + "/" + t.trackTotal : String.valueOf(t.track), v4));
            if (t.disc > 0) put(tag, text("TPOS", t.discTotal > 0 ? t.disc + "/" + t.discTotal : String.valueOf(t.disc), v4));
            if (t.year > 0) put(tag, text(v4 ? "TDRC" : "TYER", String.valueOf(t.year), v4));
            put(tag, text("TCON", t.genre, v4));
            byte[] k = kept.toByteArray();
            tag.write(k, 0, k.length);
            byte[] pad = new byte[512];
            tag.write(pad, 0, pad.length);
            byte[] frames = tag.toByteArray();

            byte[] head = new byte[10];
            head[0] = 'I'; head[1] = 'D'; head[2] = '3';
            head[3] = (byte) (v4 ? 4 : 3); head[4] = 0; head[5] = 0;
            writeSyncsafe(head, 6, frames.length);
            out.write(head);
            out.write(frames);

            long audioEnd = len;
            if (audioEnd - audioStart >= 128) {                                     // stale ID3v1 block
                byte[] v1 = new byte[3];
                raf.seek(audioEnd - 128);
                raf.readFully(v1);
                if (v1[0] == 'T' && v1[1] == 'A' && v1[2] == 'G') audioEnd -= 128;
            }
            raf.seek(audioStart);
            byte[] buf = new byte[65536];
            long left = audioEnd - audioStart;
            while (left > 0) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (n <= 0) throw new IOException("unexpected end of file");
                out.write(buf, 0, n);
                left -= n;
            }
            out.flush();
            return head.length + frames.length + (audioEnd - audioStart);
        } finally {
            raf.close();
        }
    }

    private static void put(ByteArrayOutputStream o, byte[] b) { if (b != null) o.write(b, 0, b.length); }

    /** one text frame; empty text → no frame */
    private static byte[] text(String id, String s, boolean v4) throws IOException {
        if (s == null) return null;
        s = s.trim();
        if (s.isEmpty()) return null;
        byte[] data;
        int enc;
        Charset latin = Charset.forName("ISO-8859-1");
        if (latin.newEncoder().canEncode(s)) { enc = 0; data = s.getBytes(latin); }
        else {
            enc = 1;
            byte[] u = s.getBytes(Charset.forName("UTF-16LE"));
            data = new byte[u.length + 2];
            data[0] = (byte) 0xFF; data[1] = (byte) 0xFE;
            System.arraycopy(u, 0, data, 2, u.length);
        }
        int size = 1 + data.length;
        ByteArrayOutputStream f = new ByteArrayOutputStream();
        f.write(id.getBytes(latin), 0, 4);
        byte[] sz = new byte[4];
        if (v4) writeSyncsafe(sz, 0, size); else { sz[0] = (byte) (size >>> 24); sz[1] = (byte) (size >>> 16); sz[2] = (byte) (size >>> 8); sz[3] = (byte) size; }
        f.write(sz, 0, 4);
        f.write(0); f.write(0);
        f.write(enc);
        f.write(data, 0, data.length);
        return f.toByteArray();
    }

    private static long syncsafe(byte[] b, int o) { return ((b[o] & 0x7FL) << 21) | ((b[o + 1] & 0x7FL) << 14) | ((b[o + 2] & 0x7FL) << 7) | (b[o + 3] & 0x7FL); }
    private static long be32(byte[] b, int o) { return ((b[o] & 0xFFL) << 24) | ((b[o + 1] & 0xFFL) << 16) | ((b[o + 2] & 0xFFL) << 8) | (b[o + 3] & 0xFFL); }
    private static void writeSyncsafe(byte[] b, int o, int v) { b[o] = (byte) ((v >> 21) & 0x7F); b[o + 1] = (byte) ((v >> 14) & 0x7F); b[o + 2] = (byte) ((v >> 7) & 0x7F); b[o + 3] = (byte) (v & 0x7F); }
}
