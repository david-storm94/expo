const path = require('node:path');
/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  name: 'Router E2E',
  slug: 'expo-router-e2e',

  sdkVersion: 'UNVERSIONED',
  icon: './assets/icon.png',
  scheme: 'router-e2e',

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'dev.expo.routere2e',
  },
  android: {
    package: 'dev.expo.routere2e',
  },
  runtimeVersion: 'nativeVersion',
  // For testing the output bundle
  jsEngine: 'hermes', // process.env.E2E_ROUTER_SRC ? 'jsc' : 'hermes',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  experiments: {
    baseUrl: process.env.EXPO_E2E_BASE_PATH || undefined,
    tsconfigPaths: process.env.EXPO_USE_PATH_ALIASES,
    typedRoutes: true,
    serverComponents: true,
  },
  web: {
    output: 'single',
    bundler: 'metro',
    favicon: './assets/icon.png',
  },
  plugins: [
    [
      'expo-build-properties',
      {
        ios: {
          newArchEnabled: true,
        },
        android: {
          newArchEnabled: true,
        },
      },
    ],
    [
      'expo-router',
      {
        // asyncRoutes: process.env.E2E_ROUTER_ASYNC,
        // root: path.join('__e2e__', process.env.E2E_ROUTER_SRC ?? 'static-rendering', 'app'),
        root: path.join('src', process.env.RSC_ROOT ?? 'app'),
        origin: 'http://localhost:8081',
      },
    ],
  ],
};
