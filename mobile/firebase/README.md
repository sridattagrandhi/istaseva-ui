# Firebase native config files

Downloaded from the Firebase console (project `istasewa-93903`) — see
`../FIREBASE_PHONE_AUTH_SETUP.md` for the registration steps. Wired into the
build by `app.config.ts` (`GOOGLE_SERVICES`, selected by `APP_ENV`).

Expected layout:

```
firebase/google-services.json              # Android — one file, holds all 3 package client entries
firebase/dev/GoogleService-Info.plist      # iOS — com.istaseva.app.dev
firebase/staging/GoogleService-Info.plist  # iOS — com.istaseva.app.staging
firebase/prod/GoogleService-Info.plist     # iOS — com.istaseva.app
```

These files are safe to commit: they contain public client identifiers (API key,
app id, sender id) — the same values the web app ships in its JS bundle — not
secrets. Access control lives in Firebase security rules / backend auth.
