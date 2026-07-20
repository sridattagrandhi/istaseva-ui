// Shared contract for the platform-split map surface. No native imports here, so
// it's safe to pull into either the iOS (react-native-maps) or Android (MapLibre)
// implementation — and into the .d.ts that lets TypeScript resolve "./MapCanvas".
import type { ReactElement, ForwardRefExoticComponent, RefAttributes } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export type LatLng = { latitude: number; longitude: number };
export type MapRegion = LatLng & { latitudeDelta: number; longitudeDelta: number };

export type MapMarker = {
  id: string;
  coordinate: LatLng;
  onPress?: () => void;
  /** Custom pin content (a single element). When omitted a default dot renders. */
  render?: () => ReactElement;
};

export interface MapCanvasHandle {
  /** Recenter/zoom to a region. Mirrors react-native-maps' animateToRegion. */
  animateTo: (region: MapRegion, durationMs?: number) => void;
}

export interface MapCanvasProps {
  initialRegion: MapRegion;
  markers?: MapMarker[];
  /** Tap on empty map. */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  /** false disables gestures + touches (static preview). Default true. */
  interactive?: boolean;
}

export type MapCanvasComponent = ForwardRefExoticComponent<
  MapCanvasProps & RefAttributes<MapCanvasHandle>
>;
