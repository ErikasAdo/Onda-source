package com.erikasado.onda;

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
