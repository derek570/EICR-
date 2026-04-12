import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.certomatic3000.app',
  appName: 'CertMate',
  webDir: 'public',
  server: {
    url: 'https://certmate.uk',
    cleartext: false,
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'CertMate',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      showSpinner: false,
      backgroundColor: '#1a1a2e',
    },
    StatusBar: {
      style: 'light',
      backgroundColor: '#1a1a2e',
    },
  },
};

export default config;
