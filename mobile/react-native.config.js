// Native autolinking overrides.
//
// The map surface is platform-split (src/design/screens/MapCanvas.ios.tsx uses
// react-native-maps for Apple Maps; MapCanvas.android.tsx uses MapLibre). We
// exclude react-native-maps from the Android build entirely so its Google Maps
// SDK — and the com.google.android.geo.API_KEY it requires — never ship in the
// Android app. iOS keeps react-native-maps (Apple Maps, no key needed).
//
// The MIRROR exclusion matters just as much: without it, iOS autolinks the
// MapLibre pod, whose core `MapLibre` framework we never configure (iOS
// doesn't use it), and `expo run:ios` dies with "Module 'MapLibre' not
// found". Android keeps MapLibre; iOS never compiles it.
module.exports = {
  dependencies: {
    "react-native-maps": {
      platforms: { android: null },
    },
    "@maplibre/maplibre-react-native": {
      platforms: { ios: null },
    },
  },
};
