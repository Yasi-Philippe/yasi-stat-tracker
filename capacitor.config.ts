/// <reference types="@capacitor/keyboard" />
/// <reference types="@capacitor/local-notifications" />
import type { CapacitorConfig } from '@capacitor/cli';
import type { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'io.github.yasiphilippe.stattracker',
  appName: 'Trazo',
  webDir: 'dist',
  // Same colour as the native window and splash, so nothing white shows before the first paint.
  backgroundColor: '#0A0B0F',
  // Native and console logs only in debug builds.
  loggingBehavior: 'debug',
  server: {
    // Origin is https://localhost. Never change scheme or hostname: IndexedDB and other
    // origin-bound storage would start empty.
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SystemBars: {
      // Edge-to-edge: with `viewport-fit=cover` in index.html the page draws under the
      // system bars and gets the real insets through env(safe-area-inset-*) (WebView 140+)
      // and the injected --safe-area-inset-* variables (every WebView version). Without
      // `cover`, or on older WebViews, the WebView is padded natively and both report 0.
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      // Light status and navigation bar icons, for the dark UI.
      style: 'DARK',
    },
    Keyboard: {
      // iOS option. On Android the WebView is shrunk above the keyboard by SystemBars
      // (IME inset as bottom padding; the activity uses adjustResize), which keeps the
      // focused field visible in long forms.
      resize: 'native' as KeyboardResize,
      // Must stay off: SystemBars already handles the keyboard inset.
      resizeOnFullScreen: false,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_trazo',
      iconColor: '#C6F432',
    },
  },
};

export default config;
