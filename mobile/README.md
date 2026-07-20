# IstaSeva Mobile

React Native + Expo client for the IstaSeva marketplace.

## Setup

```bash
cd mobile
npm install
npx expo start
```

Scan the QR code with Expo Go (iOS/Android) or press `i` / `a` to launch simulators.

## Configuration

Copy your Firebase web config + API base URL into `app.json` under `expo.extra`:

```json
"extra": {
  "apiBaseUrl": "https://api.istaseva.com",
  "firebaseApiKey": "...",
  "firebaseAuthDomain": "...",
  "firebaseProjectId": "..."
}
```

For local dev against the server in `/server`, set `apiBaseUrl` to your LAN IP (e.g. `http://192.168.1.10:3000`) — `localhost` won't resolve on a physical device.

## Structure

```
mobile/
├── src/
│   ├── theme/          Design tokens (colors, typography, spacing)
│   ├── components/     Reusable UI primitives
│   ├── lib/            Firebase, API client, utils
│   ├── contexts/       AuthContext, LocationContext
│   ├── navigation/     Stacks and tab navigators
│   └── screens/        Feature screens grouped by domain
└── assets/             Icons, splash, fonts
```

Shared types are imported from the parent web repo's `src/types/` via `@shared/*`.
