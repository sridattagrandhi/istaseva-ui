import type { ExpoConfig, ConfigContext } from "expo/config";

// One env var, APP_ENV, drives the variant. EAS sets it per build profile
// (see eas.json); locally it defaults to "development". Each variant gets its
// own name + bundle id so dev / staging / prod install side-by-side on one
// phone, and its own API base URL.
//
// Firebase is intentionally the SAME project across all envs — mobile mirrors
// the web app's auth/data, so there is nothing to separate.
type AppEnv = "development" | "staging" | "production";
const APP_ENV = (process.env.APP_ENV ?? "development") as AppEnv;

// apiBaseUrl can always be overridden by EXPO_PUBLIC_API_URL — needed because
// a physical device / Android emulator can't reach the dev machine via
// "localhost" (use your Mac's LAN IP, or 10.0.2.2 on the Android emulator).
// webUrl is the customer web app's origin. It's used for password-reset deep
// links: the emailed reset link points here, and — via the App/Universal Link
// association below — opens the app's ResetPassword screen when installed,
// falling back to the web page otherwise. It MUST match the Firebase Auth
// custom action URL host and the domain that serves the AASA / assetlinks.json
// association files. Override per-build with EXPO_PUBLIC_WEB_URL.
const ENV = {
  development: {
    name: "IstaSeva (Dev)",
    bundleId: "com.istaseva.app.dev",
    apiBaseUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001",
    webUrl: process.env.EXPO_PUBLIC_WEB_URL ?? "http://localhost:8080",
  },
  staging: {
    name: "IstaSeva (Staging)",
    bundleId: "com.istaseva.app.staging",
    // The API is served from the web origin via CloudFront (/api/* behavior)
    // — there is no separate api. subdomain. The old *.instaserve.app
    // defaults never resolved in DNS; istaseva.com is the live domain.
    apiBaseUrl: process.env.EXPO_PUBLIC_API_URL ?? "https://staging.istaseva.com",
    webUrl: process.env.EXPO_PUBLIC_WEB_URL ?? "https://staging.istaseva.com",
  },
  production: {
    name: "IstaSeva",
    bundleId: "com.istaseva.app",
    apiBaseUrl: process.env.EXPO_PUBLIC_API_URL ?? "https://istaseva.com",
    webUrl: process.env.EXPO_PUBLIC_WEB_URL ?? "https://istaseva.com",
  },
}[APP_ENV];

// Host (no scheme) for the App/Universal Link association. Empty for localhost
// (no HTTPS deep link in dev — the custom `istaseva://` scheme is used there).
const WEB_HOST = (() => {
  try {
    const u = new URL(ENV.webUrl);
    return u.protocol === "https:" ? u.host : "";
  } catch {
    return "";
  }
})();

// Same Firebase project everywhere (mobile mirrors web). Overridable via env
// if that ever needs to change, but the defaults are the source of truth.
//
// NOTE: with @react-native-firebase (native), these `extra` values are no
// longer read for auth — the native SDK initializes from the google-services
// files below. They're kept for reference / any non-auth consumer.
const FIREBASE = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? "AIzaSyAxrANmpZ3Z2Tx0Q4Qu25PWCH4C7UDlFoQ",
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "istasewa-93903.firebaseapp.com",
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? "istasewa-93903",
};

// Native Firebase (RNFirebase) reads these files at build time, NOT the `extra`
// config above. They must be downloaded from the Firebase console (project
// istasewa-93903) and committed under mobile/firebase/ — see
// mobile/FIREBASE_PHONE_AUTH_SETUP.md. Android: one google-services.json can
// hold all three package client entries, so it's shared across envs. iOS:
// GoogleService-Info.plist is per-app and can't be merged, so there's one per
// bundle id, selected by APP_ENV. Paths are overridable per-build via env.
const GOOGLE_SERVICES = {
  android:
    process.env.EXPO_PUBLIC_GOOGLE_SERVICES_ANDROID ?? "./firebase/google-services.json",
  ios:
    process.env.EXPO_PUBLIC_GOOGLE_SERVICES_IOS ??
    {
      development: "./firebase/dev/GoogleService-Info.plist",
      staging: "./firebase/staging/GoogleService-Info.plist",
      production: "./firebase/prod/GoogleService-Info.plist",
    }[APP_ENV],
};

// No Google Maps key ships in the app. The map UI uses no Google service on the
// client: iOS renders Apple Maps (react-native-maps, no key) and Android renders
// MapLibre + free OpenFreeMap tiles (see design/screens/MapCanvas.*.tsx).
// react-native-maps is excluded from the Android build (react-native.config.js),
// so nothing on Android needs a com.google.android.geo.API_KEY. Geocoding / place
// search route through the backend /api/geocode (separate server-side key).
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: ENV.name,
  slug: "istaseva",
  version: "0.1.0",
  orientation: "portrait",
  // No source icon/splash assets exist in the repo yet, so we let Expo use its
  // built-in defaults (prebuild requires real files when these are set). Add
  // `icon`, `splash`, and `android.adaptiveIcon` back once branded assets land
  // under mobile/assets/.
  scheme: "istaseva",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: true,
    bundleIdentifier: ENV.bundleId,
    // RNFirebase native init (Auth phone OTP). Per-env plist, see GOOGLE_SERVICES.
    googleServicesFile: GOOGLE_SERVICES.ios,
    // Universal Links: lets the emailed reset link open the app directly.
    // Requires the web host to serve /.well-known/apple-app-site-association.
    ...(WEB_HOST ? { associatedDomains: [`applinks:${WEB_HOST}`] } : {}),
    infoPlist: {
      NSMicrophoneUsageDescription:
        "Allow IstaSeva to use the microphone so you can talk to the Ista AI assistant.",
      NSSpeechRecognitionUsageDescription:
        "Allow IstaSeva to recognize your speech so you can dictate to the Ista AI assistant.",
    },
  },
  android: {
    package: ENV.bundleId,
    // RNFirebase native init (Auth phone OTP). Shared file holds all three
    // package client entries, see GOOGLE_SERVICES.
    googleServicesFile: GOOGLE_SERVICES.android,
    // SEC-011: Firebase auth state persists in AsyncStorage (app-private SQLite),
    // which Android Auto Backup would otherwise ship to Google Drive / D2D
    // transfers — an offline session-extraction path. Nothing in local storage
    // needs backup (auth re-establishes on sign-in; drafts/searches are
    // disposable), so disable backups outright. Keep in sync with the tracked
    // android/app/src/main/AndroidManifest.xml.
    allowBackup: false,
    // App Links: the autoVerify intent filter opens the reset deep link in the
    // app. Requires the web host to serve /.well-known/assetlinks.json.
    ...(WEB_HOST
      ? {
          intentFilters: [
            {
              action: "VIEW",
              autoVerify: true,
              data: [{ scheme: "https", host: WEB_HOST, pathPrefix: "/reset-password" }],
              category: ["BROWSABLE", "DEFAULT"],
            },
          ],
        }
      : {}),
  },
  plugins: [
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "Allow IstaSeva to use your location to find services near you.",
      },
    ],
    "expo-font",
    [
      "@react-native-voice/voice",
      {
        microphonePermission:
          "Allow IstaSeva to access the microphone to talk to the Ista AI assistant.",
        speechRecognitionPermission:
          "Allow IstaSeva to recognize your speech to dictate to the Ista AI assistant.",
      },
    ],
    "expo-dev-client",
    // Android map renderer — MapLibre GL (free OpenFreeMap tiles, no Google key).
    // iOS uses Apple Maps via react-native-maps, so this only affects Android.
    "@maplibre/maplibre-react-native",
    // MUST come right after the maplibre plugin: guards its generated Podfile
    // post_install line, which crashes pod install because MapLibre is
    // unlinked on iOS (see plugins/withMapLibreIosGuard.js).
    "./plugins/withMapLibreIosGuard",
    // Native Firebase (Auth phone OTP). The app plugin wires the google-services
    // files + iOS URL scheme; the auth plugin sets up the phone-auth / reCAPTCHA
    // fallback. RNFirebase needs a dev/prebuild build — it is NOT in Expo Go.
    "@react-native-firebase/app",
    "@react-native-firebase/auth",
    // RNFirebase iOS pods require static frameworks under Expo prebuild.
    ["expo-build-properties", { ios: { useFrameworks: "static" } }],
  ],
  extra: {
    appEnv: APP_ENV,
    apiBaseUrl: ENV.apiBaseUrl,
    webUrl: ENV.webUrl,
    firebaseApiKey: FIREBASE.apiKey,
    firebaseAuthDomain: FIREBASE.authDomain,
    firebaseProjectId: FIREBASE.projectId,
    // Populated by `eas init`. Leave as-is until then.
    eas: { projectId: "" },
  },
});
