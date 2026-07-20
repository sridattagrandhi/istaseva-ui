// Android map surface — MapLibre GL with free OpenFreeMap vector tiles. No Google
// Maps SDK, no API key, no billing. This file is Android-only (Metro resolves it
// for Android builds), so MapLibre never enters the iOS bundle and react-native-
// maps never enters the Android bundle.
//
// GUARDED require, not a top-level import: MapLibre's LocationManager runs
// `new NativeEventEmitter(nativeModule)` at import time, which THROWS when the
// native module isn't in the binary (Expo Go, or a dev client built before the
// maps change). MapSearchScreen imports MapCanvas at app startup, so an
// unguarded import turns "old client" into "app won't boot at all". With the
// guard, such clients boot fine and the map area shows a rebuild notice.
import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { View, Pressable, StyleSheet, Text } from "react-native";
import type { MapCanvasHandle, MapCanvasProps } from "./MapCanvas.types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ML: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ML = require("@maplibre/maplibre-react-native");
} catch {
  ML = null; // native module missing — render the fallback below
}

// Free, key-less vector tiles (openfreemap.org). "liberty" is the full-colour
// street style; "bright" / "positron" are also available on the same host.
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// A latitude span (react-native-maps' delta model) → a MapLibre zoom level, so
// one region prop frames roughly the same area as the iOS map.
const zoomForDelta = (latitudeDelta: number) =>
  Math.max(1, Math.min(20, Math.round(Math.log2(360 / Math.max(latitudeDelta, 0.0001)))));

const DefaultDot = () => <View style={styles.dot} />;

export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  { initialRegion, markers = [], onPress, style, interactive = true },
  ref,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cameraRef = useRef<any>(null);

  useImperativeHandle(
    ref,
    () => ({
      animateTo: (region, durationMs = 500) =>
        cameraRef.current?.setCamera({
          centerCoordinate: [region.longitude, region.latitude],
          zoomLevel: zoomForDelta(region.latitudeDelta),
          animationDuration: durationMs,
        }),
    }),
    [],
  );

  if (!ML) {
    return (
      <View style={[style, styles.fallback]} pointerEvents="none">
        <Text style={styles.fallbackTxt}>
          Map unavailable — this build doesn't include the map engine.{"\n"}
          Rebuild the dev client (eas build / expo run:android) to enable it.
        </Text>
      </View>
    );
  }

  const { MapView: MLMapView, Camera: MLCamera, MarkerView: MLMarkerView } = ML;

  return (
    <View style={style} pointerEvents={interactive ? "auto" : "none"}>
      <MLMapView
        style={StyleSheet.absoluteFill}
        mapStyle={OPENFREEMAP_STYLE}
        onPress={onPress ? () => onPress() : undefined}
        logoEnabled={false}
        compassEnabled={false}
        attributionEnabled
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={interactive}
      >
        <MLCamera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: [initialRegion.longitude, initialRegion.latitude],
            zoomLevel: zoomForDelta(initialRegion.latitudeDelta),
          }}
        />
        {markers.map((m) => (
          <MLMarkerView
            key={m.id}
            coordinate={[m.coordinate.longitude, m.coordinate.latitude]}
            anchor={{ x: 0.5, y: 0.5 }}
            allowOverlap
          >
            <Pressable onPress={m.onPress} disabled={!m.onPress}>
              {m.render ? m.render() : <DefaultDot />}
            </Pressable>
          </MLMarkerView>
        ))}
      </MLMapView>
    </View>
  );
});

const styles = StyleSheet.create({
  dot: { width: 16, height: 16, borderRadius: 8, backgroundColor: "#c0392b", borderWidth: 2, borderColor: "#fff" },
  fallback: { alignItems: "center", justifyContent: "center", backgroundColor: "#eceae6", padding: 24 },
  fallbackTxt: { textAlign: "center", fontSize: 12.5, color: "#68707a", lineHeight: 18 },
});
