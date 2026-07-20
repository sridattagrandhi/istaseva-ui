import { getApp } from "@react-native-firebase/app";
import { getAuth } from "@react-native-firebase/auth";

// Native Firebase (RNFirebase). The native layer auto-initializes from the
// google-services files wired in app.config.ts (GoogleService-Info.plist /
// google-services.json) and persists the session natively — there is no
// initializeApp / AsyncStorage persistence to configure here (that was the JS
// SDK's job). We moved off the `firebase` JS SDK so that native phone-OTP
// (@react-native-firebase/auth) links onto the SAME user that holds
// email/password; two SDKs would be two separate session stores.
//
// `auth` keeps the same shape the rest of the app relies on: `auth.currentUser`
// and `user.getIdToken(forceRefresh?)` (see lib/api.ts, design/api/voiceLive.ts).
export const firebaseApp = getApp();
export const auth = getAuth();
