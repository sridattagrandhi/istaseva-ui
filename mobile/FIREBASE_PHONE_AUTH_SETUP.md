# Firebase phone-OTP — native setup (RNFirebase)

The mobile app uses **`@react-native-firebase/auth`** (native) for email/password
**and** phone-OTP. This replaced the Firebase JS SDK so the OTP-verified phone can be
**linked** to the same account that holds email/password (the backend then syncs it from
the ID token's `phone_number` claim — see `server/src/common/auth/require-auth.ts`).

RNFirebase is native code, so it **cannot run in Expo Go**. You need a dev/prebuild build
(`npx expo prebuild --clean` + `npm run ios` / `npm run android`, or an EAS dev build).

## One-time Firebase console setup (project `istasewa-93903`)

1. **Enable the Phone sign-in provider** — Authentication → Sign-in method → Phone.
2. **Add test phone numbers** (Phone provider → "Phone numbers for testing"): a fictional
   number + fixed 6-digit code. Lets you verify on a simulator and in CI without real SMS
   or burning quota.
3. **Register each app in the project** (the client bundle id must match, so every variant
   is its own "app" under the one project):
   - Android packages: `com.istaseva.app.dev`, `com.istaseva.app.staging`, `com.istaseva.app`
   - iOS bundle ids: `com.istaseva.app.dev`, `com.istaseva.app.staging`, `com.istaseva.app`
4. **iOS** — upload an **APNs auth key** (Project settings → Cloud Messaging) so silent-push
   phone verification works; the RNFirebase config plugin adds the `REVERSED_CLIENT_ID` URL
   scheme for the reCAPTCHA fallback.
5. **Android** — add the **SHA-1 and SHA-256** signing fingerprints for each package,
   including the **debug keystore SHA-1** for local `expo run:android`. Enable Play Integrity.

## google-services files (committed under `mobile/firebase/`)

`app.config.ts` wires these per `APP_ENV` (see `GOOGLE_SERVICES`). Download them from the
console after step 3 and place them here:

```
mobile/firebase/google-services.json                 # Android — one file, all 3 package entries
mobile/firebase/dev/GoogleService-Info.plist         # iOS — com.istaseva.app.dev
mobile/firebase/staging/GoogleService-Info.plist     # iOS — com.istaseva.app.staging
mobile/firebase/prod/GoogleService-Info.plist        # iOS — com.istaseva.app
```

- **Android:** a single `google-services.json` can hold all three package `client` entries,
  so it is shared across envs.
- **iOS:** `GoogleService-Info.plist` is per-app and cannot be merged, so there is one per
  bundle id, selected by `APP_ENV`.
- Paths are overridable per-build via `EXPO_PUBLIC_GOOGLE_SERVICES_ANDROID` /
  `EXPO_PUBLIC_GOOGLE_SERVICES_IOS`.

`npx expo prebuild` will fail with a clear "file not found" until these are in place — that
is intentional (don't stub them; native Firebase won't initialize without real files).

## Build & test

```bash
cd mobile
npx expo prebuild --clean     # applies the RNFirebase + static-frameworks native config
npm run ios                   # or: npm run android
npm run typecheck
```

Tip: build a clean iOS prebuild **early** (before deep testing) to catch any
`useFrameworks: "static"` CocoaPods linkage issues.

## What to verify on device

- **Regression:** email/password login, signup, forgot-password (backend SES + Firebase
  fallback), email-verify resend; admin `role` custom claim still applies.
- **Signup phone link:** create account → 6-digit OTP → confirm, then check
  `user_profiles.phone` is populated on the next authenticated request.
- **Phone login** ("Continue with phone"): send → verify → lands on the tab bar.
- **Errors:** wrong code, expired code, already-linked number all surface friendly copy.
