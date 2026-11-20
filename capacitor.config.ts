import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.erikasado.onda',
  appName: 'Onda',
  webDir: 'www',
  backgroundColor: '#000000',

  server: {
    // Android WebView origin becomes https://localhost (matches the Worker's CORS allow-list)
    androidScheme: 'https',
  },

  ios: {
    // 'never' = WebView runs edge-to-edge; the CSS handles insets with env(safe-area-inset-*)
    contentInset: 'never',
    backgroundColor: '#000000',
  },

  android: {
    backgroundColor: '#000000',
  },

  plugins: {
    StatusBar: {
      style: 'DARK', // light icons on our dark UI
      overlaysWebView: true,
    },
    // Capacitor 8 core SystemBars: exposes --safe-area-inset-* CSS vars on Android
    // (the CSS uses max(env(...), var(--safe-area-inset-*)) so both platforms work)
    SystemBars: {
      insetsHandling: 'css',
    },
  },
};

export default config;
