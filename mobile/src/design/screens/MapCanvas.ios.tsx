// iOS map surface — Apple Maps via react-native-maps (provider left undefined).
// No API key required. This file is iOS-only (Metro resolves it for iOS builds),
// so react-native-maps never enters the Android bundle.
import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { View, StyleSheet } from "react-native";
import RNMapView, { Marker as RNMarker, type Region } from "react-native-maps";
import type { MapCanvasHandle, MapCanvasProps } from "./MapCanvas.types";

export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  { initialRegion, markers = [], onPress, style, interactive = true },
  ref,
) {
  const rnRef = useRef<RNMapView>(null);

  useImperativeHandle(
    ref,
    () => ({
      animateTo: (region, durationMs = 500) => rnRef.current?.animateToRegion(region as Region, durationMs),
    }),
    [],
  );

  return (
    <View style={style} pointerEvents={interactive ? "auto" : "none"}>
      <RNMapView
        ref={rnRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        onPress={onPress ? () => onPress() : undefined}
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={interactive}
        pitchEnabled={interactive}
      >
        {markers.map((m) => (
          <RNMarker key={m.id} coordinate={m.coordinate} onPress={m.onPress} tracksViewChanges={false}>
            {m.render ? m.render() : undefined}
          </RNMarker>
        ))}
      </RNMapView>
    </View>
  );
});
