// Type surface for the platform-split MapCanvas. Metro resolves the real
// implementation from MapCanvas.ios.tsx / MapCanvas.android.tsx; TypeScript
// resolves "./MapCanvas" to this declaration (and re-exports the shared types),
// so callers import { MapCanvas, MapCanvasHandle, ... } from "./MapCanvas".
import type { MapCanvasComponent } from "./MapCanvas.types";

export * from "./MapCanvas.types";
export declare const MapCanvas: MapCanvasComponent;
