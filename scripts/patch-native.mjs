#!/usr/bin/env node
/* Idempotent patch for the generated native projects. Run after `npx cap add ios|android`
 * (setup.sh and the GitHub workflow do this for you).
 *   iOS     → UIBackgroundModes: audio (+ ITSAppUsesNonExemptEncryption=false)
 *   Android → media/notification/foreground-service permissions,
 *             OndaLibrary plugin (MediaStore scan) copied in + registered in MainActivity */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function patchIOS() {
  const p = path.join(root, 'ios/App/App/Info.plist');
  if (!fs.existsSync(p)) return console.log('• iOS project not found — skipped');
  let s = fs.readFileSync(p, 'utf8');
  const add = [];
  if (!s.includes('UIBackgroundModes')) add.push('\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>');
  if (!s.includes('ITSAppUsesNonExemptEncryption')) add.push('\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>');
  if (!add.length) return console.log('• iOS Info.plist already patched');
  const i = s.lastIndexOf('</dict>');
  s = s.slice(0, i) + add.join('\n') + '\n' + s.slice(i);
  fs.writeFileSync(p, s);
  console.log('✓ iOS Info.plist patched (background audio)');
}

function patchAndroid() {
  const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  if (!fs.existsSync(manifest)) return console.log('• Android project not found — skipped');

  // ── permissions ────────────────────────────────────────────────────────────
  let s = fs.readFileSync(manifest, 'utf8');
  const perms = [
    '<uses-permission android:name="android.permission.WAKE_LOCK" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',   // deleting songs on Android 9 and older
  ];
  const missing = perms.filter(line => !s.includes(/android:name="([^"]+)"/.exec(line)[1]));
  if (missing.length) {
    s = s.replace('</manifest>', missing.map(l => '    ' + l).join('\n') + '\n</manifest>');
    fs.writeFileSync(manifest, s);
    console.log('✓ AndroidManifest.xml patched (' + missing.length + ' permissions)');
  } else console.log('• AndroidManifest already has the permissions');

  // ── foreground playback service (Media3) ───────────────────────────────────
  s = fs.readFileSync(manifest, 'utf8');
  if (!s.includes('OndaPlaybackService')) {
    const svc = `
        <service
            android:name=".OndaPlaybackService"
            android:exported="true"
            android:foregroundServiceType="mediaPlayback">
            <intent-filter>
                <action android:name="androidx.media3.session.MediaSessionService" />
            </intent-filter>
        </service>
`;
    if (!s.includes('</application>')) { console.log('! </application> not found in manifest'); process.exit(1); }
    s = s.replace('</application>', svc + '    </application>');
    fs.writeFileSync(manifest, s);
    console.log('✓ AndroidManifest.xml: OndaPlaybackService registered (mediaPlayback foreground service)');
  } else console.log('• AndroidManifest already declares OndaPlaybackService');

  // ── Gradle: Media3 ─────────────────────────────────────────────────────────
  const gradle = path.join(root, 'android/app/build.gradle');
  let g = fs.readFileSync(gradle, 'utf8');
  if (!g.includes('androidx.media3:media3-session')) {
    if (!/^dependencies\s*\{/m.test(g)) { console.log('! dependencies block not found in app/build.gradle'); process.exit(1); }
    g = g.replace(/^dependencies\s*\{/m, 'dependencies {\n    implementation "androidx.media3:media3-exoplayer:1.5.1"\n    implementation "androidx.media3:media3-session:1.5.1"');
    fs.writeFileSync(gradle, g);
    console.log('✓ app/build.gradle: Media3 ExoPlayer + Session added');
  } else console.log('• app/build.gradle already has Media3');

  // ── Java: plugins + service, registered in MainActivity ────────────────────
  const pkgDir = path.join(root, 'android/app/src/main/java/com/erikasado/onda');
  if (!fs.existsSync(pkgDir)) { console.log('! Expected package dir not found: ' + pkgDir); process.exit(1); }
  for (const f of ['OndaLibraryPlugin.java', 'OndaPlayerPlugin.java', 'OndaPlaybackService.java', 'OndaStats.java', 'OndaTagWriter.java']) {
    fs.copyFileSync(path.join(root, 'native/android', f), path.join(pkgDir, f));
  }
  fs.writeFileSync(path.join(pkgDir, 'MainActivity.java'), `package com.erikasado.onda;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OndaLibraryPlugin.class);
        registerPlugin(OndaPlayerPlugin.class);
        super.onCreate(savedInstanceState);
        blackBars();
        // Back: the web layer closes the top-most screen (Now Playing → album → Home …); at the very bottom the app goes to the phone's home screen and keeps playing
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final OnBackPressedCallback self = this;
                try {
                    getBridge().getWebView().evaluateJavascript(
                        "(function(){try{return window.__ondaBack?window.__ondaBack():false}catch(e){return false}})()",
                        new ValueCallback<String>() {
                            @Override public void onReceiveValue(String v) { if (!"true".equals(v)) moveTaskToBack(true); }
                        });
                } catch (Throwable t) { moveTaskToBack(true); }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == OndaLibraryPlugin.REQ_DELETE) OndaLibraryPlugin.onDeleteResult(resultCode);
        if (requestCode == OndaLibraryPlugin.REQ_WRITE) OndaLibraryPlugin.onWriteResult(resultCode);
    }

    @Override
    public void onResume() {
        super.onResume();
        blackBars();
    }

    /** Status + navigation bars are always black with light icons (the app is dark), whatever the phone's day/night theme says. */
    private void blackBars() {
        try {
            Window w = getWindow();
            w.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            w.setStatusBarColor(Color.BLACK);
            w.setNavigationBarColor(Color.BLACK);
            View decor = w.getDecorView();
            decor.setBackgroundColor(Color.BLACK);
            int f = decor.getSystemUiVisibility();
            f &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) f &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(f);
        } catch (Throwable ignored) { }
    }
}
`);

  // ── app icon (Onda wave mark): adaptive + legacy launcher icons copied over the Capacitor defaults ──
  const iconSrc = path.join(root, 'native/android/icons/res'), iconDst = path.join(root, 'android/app/src/main/res');
  if (fs.existsSync(iconSrc)) {
    fs.cpSync(iconSrc, iconDst, { recursive: true, force: true });
    console.log('✓ Onda app icon installed');
  }

  // ── black theme: window / status bar / navigation bar / launch background (a white one = white bars + a white flash) ──
  const stylesP = path.join(root, 'android/app/src/main/res/values/styles.xml');
  const BLACK_ITEMS = [
    '<item name="android:windowBackground">@android:color/black</item>',
    '<item name="android:statusBarColor">@android:color/black</item>',
    '<item name="android:navigationBarColor">@android:color/black</item>',
    '<item name="android:windowLightStatusBar">false</item>',
    '<item name="android:colorBackground">@android:color/black</item>',
  ];
  if (fs.existsSync(stylesP)) {
    let st = fs.readFileSync(stylesP, 'utf8');
    if (!st.includes('onda-black')) {
      st = st.replace(/<item name="android:background">@drawable\/splash<\/item>/g, '<item name="android:background">@android:color/black</item>');
      st = st.replace(/<style\s+name="AppTheme[^"]*"[^>]*>[\s\S]*?<\/style>/g, block => {
        const splash = /parent="[^"]*SplashScreen/.test(block);
        const items = BLACK_ITEMS.concat(splash ? ['<item name="windowSplashScreenBackground">@android:color/black</item>'] : [])
          .filter(i => !block.includes(i.match(/name="([^"]+)"/)[1] + '"'));
        return block.replace(/(<style[^>]*>)/, '$1\n        <!-- onda-black -->\n        ' + items.join('\n        '));
      });
      fs.writeFileSync(stylesP, st);
      console.log('✓ black window / status bar / navigation bar theme');
    }
  } else console.log('• styles.xml not found — bars are set from MainActivity only');
  console.log('✓ OndaLibrary + OndaPlayer plugins and playback service installed');
}

// ── Home-screen widget (optional: `--no-widget` removes it again; the CI retries that way if the build fails) ──
const WIDGET_RES = [
  'layout/onda_widget.xml', 'xml/onda_widget_info.xml',
  'drawable/onda_widget_bg.xml', 'drawable/onda_widget_art_bg.xml', 'drawable/onda_widget_noart.xml',
  'drawable/ic_w_play.xml', 'drawable/ic_w_pause.xml', 'drawable/ic_w_next.xml', 'drawable/ic_w_prev.xml',
];
const WIDGET_RECEIVER = `
        <receiver
            android:name=".OndaWidgetProvider"
            android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="android.appwidget.provider"
                android:resource="@xml/onda_widget_info" />
        </receiver>
`;
function patchWidget(enable) {
  const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  if (!fs.existsSync(manifest)) return;
  const javaDst = path.join(root, 'android/app/src/main/java/com/erikasado/onda/OndaWidgetProvider.java');
  const resRoot = path.join(root, 'android/app/src/main/res');
  let m = fs.readFileSync(manifest, 'utf8');
  m = m.replace(/\s*<receiver[^>]*OndaWidgetProvider[\s\S]*?<\/receiver>/, '');     // always start clean
  if (!enable) {
    fs.rmSync(javaDst, { force: true });
    for (const f of WIDGET_RES) fs.rmSync(path.join(resRoot, f), { force: true });
    fs.writeFileSync(manifest, m);
    console.log('• Home-screen widget removed');
    return;
  }
  fs.copyFileSync(path.join(root, 'native/android/widget/OndaWidgetProvider.java'), javaDst);
  for (const f of WIDGET_RES) {
    const dst = path.join(resRoot, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, 'native/android/widget/res', f), dst);
  }
  m = m.replace('</application>', WIDGET_RECEIVER + '    </application>');
  fs.writeFileSync(manifest, m);
  console.log('✓ Home-screen widget installed');
}

patchIOS();
patchAndroid();
patchWidget(!process.argv.includes('--no-widget'));
