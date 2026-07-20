# Mobile — React Native Guide

Expo 51 + React Native 0.74 + TypeScript. The mobile app talks to the same Express backend as the web app, but it does not share source files or generated types with the web app.

## IMPORTANT: the app lives in `src/design/`

`App.tsx` renders `DesignNavigator` from `@/design/Navigator`. **Everything the user sees is in `mobile/src/design/`.** The older `src/screens/`, `src/navigation/`, `src/components/`, `src/theme/`, and `src/data/mock.ts` trees were a separate, unrendered prototype and have been deleted. Do not recreate that structure.

Only these top-level `src/` dirs remain and are shared by the live app:

- `src/contexts/` — `AuthContext` (Firebase auth state).
- `src/lib/` — `api.ts` (Axios client, injects Firebase ID token), `config.ts`, `firebase.ts`, toast utils.
- `src/design/` — the entire app (UI + navigation + data layer).

## `src/design/` layout

```text
src/design/
  Navigator.tsx       # root native-stack + floating 5-tab bar (Explore/Wishlist/Bookings/Messages/Profile) + AI FAB
  DesignContext.tsx   # cross-screen UI state (active role, etc.)
  theme.ts            # T (tokens), font, Tone — the live design system
  primitives.tsx      # SearchBar, Segmented, SectionHead, IconBtn, buttons, inputs
  Background.tsx, Icon.tsx, LogoMark.tsx, fonts.ts
  data.ts             # bundled mock catalog (DATA.stays/services/transport/packages) — DEV FALLBACK ONLY (see below)
  api/                # backend read/write helpers + react-query hooks
    hooks.ts          # useCatalog, useListingDetail, useGuestBookings, useProviderBookings, useMyListings, useCoupons, useEarnings, useListingReviews
    listings.ts       # fetchCatalog, fetchListing, isApiId, httpPhotos (S3→CDN url filter)
    bookings.ts       # createBooking (prepare→verify), fetchBookings, mappers, cancelBookingStatus
    dash.ts, verification.ts (KYC upload), wishlist.ts, notifications.ts, reviews.ts, assistant.ts
  screens/            # all screens (Explore, StayDetail, BookingScreen, Dashboard, Kyc, AiChat, ...)
    dash/             # host/provider dashboard panels (ListingOnboarding, DashCalendar, CreateCoupon, dashData.ts)
    cards.tsx, detailParts.tsx, FilterSheet.tsx
```

The tab set is intentionally **Explore / Wishlist / Bookings / Messages / Profile** — there is no separate Stays/Services/Transport split at the tab level; those are segments inside Explore. Do not add an extra discovery tab.

### Explore search behavior (per-segment, gotchas)

`screens/ExploreScreen.tsx` drives the three marketplace segments off ONE screen, but search state is **per-segment**: `queryBySeg` / `pickedBySeg` keep each of stays/services/transport isolated, so a search in one tab never bleeds into another (parity with web's separate pages). When adding search-adjacent state, key it per segment too.

- **Google Places predictions are gated to the stays segment only.** Services and transport are plain keyword searches over the catalog (`hit(...)` over driver/provider/category/etc.) — do not wire the geocode/autocomplete dropdown into them.
- **Recent-search chips** are hidden while actively searching (`!searching`) and come from `api/recentSearches.ts` (see the recent-searches invariant in root `CLAUDE.md`). Only stays carries place/dates/guests; transport/services recents carry the query plus their single availability day (`dateRange.start`, end null).

## Data layer & the mock "dev bridge"

`src/design/api/hooks.ts` follows a per-segment fallback policy: **use backend data when present, fall back to the bundled `data.ts` mock for any segment with no backend rows (or when offline/errored).** Real backend ids are UUIDs (`isApiId`); mock rows use slugs, so detail lookups skip the network for mock ids.

This fallback is a development scaffold. The direction is to wire every surface to real APIs and then remove `data.ts` entirely, replacing mock rows with proper empty/loading/error states. When you wire a new surface, prefer real data and treat mock as temporary.

### Backend connection

- API base + client: `src/lib/api.ts` / `src/lib/config.ts`. The API is the Express server under `server/`, not Supabase.
- Firebase ID tokens are sent as `Authorization: Bearer <token>` automatically by the Axios client.
- Keep endpoints aligned with `server/src/app/register-routes.ts`. Mobile and web do not share types — update mobile request/response types manually when backend contracts change.
- **Images:** display real S3 photos via backend URLs (already CDN-rewritten server-side); `httpPhotos()` filters out mock/non-http urls. Uploads go to `POST /api/storage/upload` with `x-upload-bucket`/`x-upload-key` headers (see `api/verification.ts` KYC upload for the canonical pattern).
- **Pricing/payments parity:** the booking total is server-authoritative (`/api/bookings/prepare` → `agreed_price_paise`). Do NOT recompute fees on the client to display a breakdown that could drift from the order — render the server breakdown. Platform fee is flat ₹3, trip protection flat ₹2 (added after tax). See root `CLAUDE.md` pricing invariants.

## Auth

`src/contexts/AuthContext.tsx` owns mobile auth state. Screens use the context, not Firebase directly. Firebase setup is in `src/lib/firebase.ts`.

Auth runs on **`@react-native-firebase/auth`** (native), NOT the Firebase JS SDK — this is required for real phone-OTP on Expo 51 (`expo-firebase-recaptcha` was removed in SDK 48) and keeps email/password + phone on ONE session store so the OTP-verified number can be **linked** to the same account. That link is what makes the backend persist the phone (it syncs `user_profiles.phone` from the ID token's `phone_number` claim — `server/src/common/auth/require-auth.ts`). Because it is native code, auth **cannot run in Expo Go** — use a dev/prebuild build. `AuthContext` exposes `sendPhoneOtp(phoneE164)` / `verifyPhoneOtp(code)` (link when a user is signed in, sign-in otherwise); the signup flow in `screens/OnboardingScreen.tsx` links the phone after creating the email/password account. Native config + Firebase-console prerequisites (Phone provider, APNs key, SHA fingerprints, `google-services.json` / `GoogleService-Info.plist`) are documented in `FIREBASE_PHONE_AUTH_SETUP.md`.

## Navigation

Routes are defined in `src/design/Navigator.tsx` (`RootParamList`). Use those typed route names (`StayDetail`, `ServiceDetail`, `TransportDetail`, `Booking`, `Dashboard`, `Kyc`, `AiChat`, `Thread`, `Search`, `MapSearch`, `Notifications`). Prefer `useNavigation()` hooks over deep prop threading.

## UI Conventions

- Reuse `src/design/primitives.tsx` and theme tokens from `src/design/theme.ts` before creating one-off UI.
- Prefer `StyleSheet.create()`. Keep touch targets mobile-friendly; account for safe areas (`useSafeAreaInsets`).
- Avoid web-only assumptions (DOM APIs, browser storage, CSS units).

## Data Fetching

- Use TanStack Query (react-query) for server state; keep query hooks in `src/design/api/hooks.ts`.
- Keep raw Axios calls inside `src/design/api/` helpers, not scattered through screens.
- Always handle loading, empty, and offline/error states — mobile users hit weak networks.

## Running And Checking

```bash
npm install
npm start          # expo start
npm run ios        # expo start --ios
npm run android    # expo start --android
npm run typecheck  # tsc --noEmit  (run after TS changes)
```

Note: `src/lib/firebase.ts` now just re-exports the native `getAuth()` instance from `@react-native-firebase/auth` (native handles session persistence — no AsyncStorage cast). The old Firebase-JS-SDK `getReactNativePersistence` workaround is gone. `@react-native-firebase/app` + `/auth` are pinned to **21.2.0** (the version Expo SDK 51 / RN 0.74 expects — newer majors target newer RN); let `npx expo install` resolve compatible versions and don't hand-bump past what Expo pins.

## Dependency advisories (SEC-012) — read before "fixing" `npm audit`

**`npm audit` totals are not a user-facing risk metric for this app, and the count is not the goal.** Every advisory currently flagged here is build-time or prebuild-time; none of it reaches the app binary. Verify a claim before acting on it, then update this list.

**NEVER run `npm audit fix --force` in `mobile/`.** npm's "fix" for the three biggest clusters is a *downgrade* to an ancient release:

| Package | npm's "fix" | Reality |
|---|---|---|
| `@react-native-voice/voice` 3.2.4 | → 3.1.5 (2021) | Downgrade. Its xmldom **critical** is inside `@expo/config-plugins@2`, reached only via `app.plugin.js` → `plugin/build/withVoice.js` at prebuild. The runtime entry `dist/index.js` never imports config-plugins. |
| `eas-cli` | → 0.24.1 (2021) | Downgrade. The advisory range is `>=0.1.0-alpha.10` — i.e. **every published version** is flagged. We track npm's latest; residual highs are upstream's transitive surface and are not fixable here. |
| `expo-app-loading` | → 1.1.2 | Was a downgrade. Package **removed** 2026-07-14 — it was deprecated, imported nowhere, and only dragged a stale `expo-splash-screen@0.18.2` toolchain into the tree. Do not reinstall. |

Other standing decisions:

- **`undici` (high, via `@react-native-firebase/auth` → `firebase@10.13.2`) does not ship.** `undici` appears only in `@firebase/auth`'s `dist/node/` and `dist/node-esm/` builds; the package's `react-native` export condition resolves to `dist/rn/index.js`, so Metro never bundles it. Bumping RNFirebase for this buys nothing and is blocked by the pin note above.
- **`--omit=dev` is not a useful filter here** (it only drops the total from ~56 to ~54). Expo packages declare config-plugins as *runtime* deps even though they only execute at prebuild, so the dev/prod split doesn't map to ships/doesn't-ship. Judge by reachability, not by dep type.
- **The exit criterion for the remaining highs is Expo SDK 51 → 57**, which is a separate project. Until then these are tracked, not blocking.

Root/server/infrastructure are separate audit surfaces with their own baselines; root's `vite` high is a dev-server issue in a `devDependency` (root's `--omit=dev` audit is 0).
