# Deep-link association files (`.well-known/`)

These two files make **Android App Links** and **iOS Universal Links** verify, so a
tapped `https://istaseva.com/reset-password?...` link opens the app (mobile
`app.config.ts` declares the matching `associatedDomains` + `autoVerify` intent
filter). Without them served over HTTPS at the domain root, both platforms fall
back to the browser and the audit's "AASA absent (403)" reproduces.

Vite copies `public/**` to `dist/` verbatim, so these ship to
`https://<host>/.well-known/...`. The `.well-known` segment contains a dot, so the
CloudFront SPA-fallback function passes it through untouched (it only rewrites
extensionless paths). `scripts/deploy-frontend.sh` re-uploads
`apple-app-site-association` with `Content-Type: application/json` (it has no file
extension, so `s3 sync` would otherwise tag it `application/octet-stream`, which
older iOS rejects).

Both files list all three build variants (`com.istaseva.app`, `.staging`, `.dev`)
so the same deployed file works on `istaseva.com` and `staging.istaseva.com`.

## Before release — replace the placeholders (they are NOT real yet)

1. **`apple-app-site-association` → `REPLACE_WITH_APPLE_TEAM_ID`**
   Apple Developer → Membership → *Team ID* (10 chars, e.g. `A1B2C3D4E5`).
   The `appID` is `<TeamID>.<bundleId>`. Enable the *Associated Domains*
   capability on each app id in the Apple Developer portal.

2. **`assetlinks.json` → `REPLACE_WITH_*_SHA256`**
   The SHA-256 of the **app-signing** certificate (not the upload key). For a
   Play-managed app: Play Console → *Release → Setup → App integrity → App
   signing key certificate → SHA-256*. Locally:
   `keytool -list -v -keystore <keystore> -alias <alias>` → SHA256 line.

## Verify after deploy

- Android: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://istaseva.com&relation=delegate_permission/common.handle_all_urls`
- iOS: `curl -sI https://istaseva.com/.well-known/apple-app-site-association` → expect `content-type: application/json`; validate the body at https://branch.io/resources/aasa-validator/

## Also required (outside this repo)

The Firebase password-reset email currently sends links from
`istasewa-93903.firebaseapp.com`. For the link to open the app, the email's action
URL host must be a domain listed above (`istaseva.com`). Set Firebase Auth →
Templates → *Customize action URL* to `https://istaseva.com/reset-password`.
