import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Heart, X as XIcon } from "lucide-react";
import { apiRequest } from "@/lib/api-client";
import {
  Map as MapGL,
  MapMarker as MarkerLayer,
  MarkerContent,
  MapControls,
  useMap,
} from "@/components/ui/map";

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  title: string;
  subtitle?: string;
  price?: string;
  color?: string;
  label?: string;
  address?: string;
  image?: string;
  beds?: number;
  baths?: number;
  onClick?: () => void;
  /** Whether the listing is in the user's saved/wishlist set. */
  liked?: boolean;
  /** Toggle the saved state. Caller is responsible for auth gating. */
  onToggleLike?: () => void;
  /** "pill" (default) shows the price/label inside a rounded pill — the
   *  marketplace browse map look. "pin" renders a teardrop pin glyph for
   *  single-location detail maps where there's no price to display. */
  variant?: "pill" | "pin";
}

interface MapViewProps {
  markers: MapMarker[];
  center?: [number, number];
  zoom?: number;
  height?: string;
  className?: string;
  onMarkerClick?: (id: string) => void;
  showUserLocation?: boolean;
  userLat?: number;
  userLng?: number;
  /** External highlight (e.g. when hovering a listing card in a split view). */
  highlightId?: string | null;
  /** Where the map should center when there are 0 markers. Lets the page hold
      the user's last search ("Hyderabad", state X) instead of snapping back to
      the user's geolocation. */
  searchCenter?: { lat: number; lng: number; zoom?: number } | null;
  /** A free-text place (city/state) to geocode and use as `searchCenter`. The
      caller can pass the search query / selected location filter directly and
      the map will fly there even when no listings match. */
  searchAddress?: string | null;
  /** "card" (default) opens a rich popup card on click. "direct" skips the
      card entirely and invokes the marker's onClick — appropriate when the
      map container is too small to host the card (e.g. the homepage rail). */
  popupMode?: "card" | "direct";
  /** When true (and popupMode is "card"), the popup card auto-opens on
      hover — for both an internal marker hover and the external highlightId.
      Off by default so existing consumers (homepage rail, etc.) behave the
      same. The redesigned /explore split view opts in to mirror its card
      hover state into the map. */
  openOnHover?: boolean;
  /** Called whenever the currently hovered marker changes (id or null).
      Lets a parent mirror the map's hover into a side list. */
  onHoverChange?: (id: string | null) => void;
  /** Called on every pan/zoom settle (moveend) + once on load, with the map's
      current visible bounds. Powers "search as I move the map" — the parent can
      filter its list to what's on screen. Fired for programmatic recenters too;
      the consumer decides whether to act on it. */
  onBoundsChange?: (bounds: MapBounds) => void;
  /** Privacy-honest "approximate area" disc for detail maps whose coords are
      server-fuzzed (geo_exact:false). A pin at a ~1km-rounded coordinate
      claims building-level precision the data doesn't have — and points at
      whoever actually lives there. The disc renders as a geographic circle
      (scales with zoom). radiusMeters must AT LEAST cover the worst-case
      rounding error (~770m for 2-decimal rounding), or the true location can
      sit outside the circle — default 850. */
  approxCircle?: { lat: number; lng: number; radiusMeters?: number; color?: string } | null;
}

/** Visible map rectangle in WGS84 degrees. */
export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const key = address.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;
  try {
    const res = await apiRequest<{ result: { lat: number; lng: number } | null }>(
      "/api/geocode",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      }
    );
    const result = res.success && res.data ? res.data.result ?? null : null;
    geocodeCache.set(key, result);
    return result;
  } catch {
    geocodeCache.set(key, null);
    return null;
  }
}

const isValidCoord = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);

/**
 * Smart popup card for the open marker. Rendered once as an overlay inside the
 * map container and positioned via `map.project()` (real screen pixels), so it
 * never has to fight other markers for z-index. Picks above / below /
 * left-anchored / right-anchored relative to the marker so the card never
 * spills outside the map, re-evaluating on every pan / zoom.
 */
function MarkerPopup({
  marker,
  accent,
  liked,
  onClose,
  onCardClick,
  onToggleLike,
  onMouseEnter,
  onMouseLeave,
}: {
  marker: MapMarker;
  accent: string;
  liked: boolean;
  onClose: () => void;
  onCardClick: () => void;
  onToggleLike: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { map } = useMap();
  const CARD_WIDTH = 280;
  const CARD_HEIGHT = 330;
  // Clearance above the marker's anchor point: the price pill rises ~30px above
  // the lat/lng anchor, plus a small gap.
  const PILL_CLEAR_ABOVE = 44;
  const BELOW_OFFSET = 14;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [vertical, setVertical] = useState<"above" | "below">("above");
  const [horizontal, setHorizontal] = useState<"center" | "left" | "right">("center");

  useEffect(() => {
    if (!map) return;
    const compute = () => {
      const div = map.getContainer();
      if (!div) return;
      const p = map.project([marker.lng, marker.lat]);
      const w = div.clientWidth;
      setPos({ x: p.x, y: p.y });

      // Vertical: prefer above when there's room, otherwise below.
      setVertical(p.y - PILL_CLEAR_ABOVE >= CARD_HEIGHT + 12 ? "above" : "below");

      // Horizontal: keep card on-screen. Default centered; shift so neither
      // edge is clipped.
      const half = CARD_WIDTH / 2;
      if (p.x - half < 8) setHorizontal("right");
      else if (p.x + half > w - 8) setHorizontal("left");
      else setHorizontal("center");
    };
    compute();
    map.on("move", compute);
    map.on("zoom", compute);
    return () => {
      map.off("move", compute);
      map.off("zoom", compute);
    };
  }, [map, marker.lat, marker.lng]);

  if (!pos) return null;

  const verticalStyle: React.CSSProperties =
    vertical === "above" ? { bottom: PILL_CLEAR_ABOVE } : { top: BELOW_OFFSET };
  const horizontalStyle: React.CSSProperties =
    horizontal === "center"
      ? { left: 0, transform: "translateX(-50%)" }
      : horizontal === "left"
      ? { right: -24 }
      : { left: -24 };

  return (
    <div style={{ position: "absolute", left: pos.x, top: pos.y, width: 0, height: 0, zIndex: 1000 }}>
      <div
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          ...verticalStyle,
          ...horizontalStyle,
          width: CARD_WIDTH,
          background: "white",
          borderRadius: 16,
          boxShadow: "0 12px 32px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)",
          overflow: "hidden",
        }}
      >
        <div style={{ position: "relative" }} onClick={onCardClick}>
          {marker.image ? (
            <img
              src={marker.image}
              alt={marker.title}
              style={{ width: "100%", height: 168, objectFit: "cover", display: "block", background: "#f3f4f6" }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div style={{ width: "100%", height: 168, background: `linear-gradient(135deg, ${accent}22, ${accent}55)` }} />
          )}
          <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleLike(); }}
              aria-label={liked ? "Unsave" : "Save"}
              style={{
                width: 32, height: 32, borderRadius: "9999px", border: "none",
                background: "rgba(255,255,255,0.92)", backdropFilter: "blur(4px)",
                display: "grid", placeItems: "center",
                cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
              }}
            >
              <Heart
                size={16}
                strokeWidth={2}
                style={{ color: liked ? "hsl(0, 84%, 60%)" : "rgba(107,114,128,1)", fill: liked ? "hsl(0, 84%, 60%)" : "transparent" }}
              />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              aria-label="Close"
              style={{
                width: 32, height: 32, borderRadius: "9999px", border: "none",
                background: "rgba(255,255,255,0.92)", backdropFilter: "blur(4px)",
                display: "grid", placeItems: "center",
                cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
              }}
            >
              <XIcon size={16} strokeWidth={2} style={{ color: "rgba(75,85,99,1)" }} />
            </button>
          </div>
        </div>
        <div style={{ padding: "12px 14px 14px", cursor: marker.onClick ? "pointer" : "default" }} onClick={onCardClick}>
          <p style={{ fontWeight: 700, fontSize: 15, margin: 0, color: "#111827", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {marker.title}
          </p>
          {marker.subtitle && (
            <p style={{ fontSize: 12, color: "#6b7280", margin: "3px 0 0", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {marker.subtitle}
            </p>
          )}
          {(marker.beds != null || marker.baths != null) && (
            <div style={{ display: "flex", gap: 10, marginTop: 8, fontSize: 12, color: "#374151" }}>
              {marker.beds != null && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span aria-hidden style={{ fontSize: 13 }}>🛏</span>
                  {marker.beds} {marker.beds === 1 ? "bed" : "beds"}
                </span>
              )}
              {marker.baths != null && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span aria-hidden style={{ fontSize: 13 }}>🛁</span>
                  {marker.baths} {marker.baths === 1 ? "bath" : "baths"}
                </span>
              )}
            </div>
          )}
          {marker.price && (
            <p style={{ fontWeight: 800, fontSize: 15, margin: "10px 0 0", color: "#111827" }}>
              <span style={{ color: accent }}>{marker.price}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AutoRecenter({
  markers,
  fallbackCenter,
  fallbackZoom,
  singleMarkerZoom = 13,
  anchor,
  anchorMaxKm = 50,
}: {
  markers: MapMarker[];
  fallbackCenter: { lat: number; lng: number };
  fallbackZoom: number;
  singleMarkerZoom?: number;
  /** Optional fixed point that should stay visible — used for the "Near me"
   *  user pin so the map shows BOTH the user and the closest markers, not
   *  just the marker cloud. */
  anchor?: { lat: number; lng: number } | null;
  /** When `anchor` is set, only include the N nearest markers (within this
   *  many km) in the fit so a single far-away outlier can't zoom the map
   *  out to the country level. Markers further than this still render —
   *  the cap is purely for choosing the viewport. */
  anchorMaxKm?: number;
}) {
  const { map, isLoaded } = useMap();
  const key =
    markers.map((m) => `${m.id}:${m.lat.toFixed(4)},${m.lng.toFixed(4)}`).join("|") +
    `|fb:${fallbackCenter.lat.toFixed(4)},${fallbackCenter.lng.toFixed(4)}@${fallbackZoom}` +
    (anchor ? `|a:${anchor.lat.toFixed(4)},${anchor.lng.toFixed(4)}@${anchorMaxKm}` : "");
  useEffect(() => {
    if (!map || !isLoaded) return;
    // With a "near me" anchor, build bounds around the anchor + nearby
    // markers so the user pin is always on-screen and the map zooms to the
    // local neighbourhood instead of the marker cloud.
    if (anchor) {
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([anchor.lng, anchor.lat]);
      const distKm = (m: MapMarker) => {
        const R = 6371;
        const toRad = (d: number) => (d * Math.PI) / 180;
        const dLat = toRad(m.lat - anchor.lat);
        const dLng = toRad(m.lng - anchor.lng);
        const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(anchor.lat)) * Math.cos(toRad(m.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
      };
      const nearby = markers
        .map((m) => ({ m, d: distKm(m) }))
        .sort((a, b) => a.d - b.d)
        .filter((x, i) => x.d <= anchorMaxKm || i < 1) // always include the single nearest, even if far
        .slice(0, 12)
        .map((x) => x.m);
      nearby.forEach((m) => bounds.extend([m.lng, m.lat]));
      if (nearby.length === 0) {
        map.flyTo({ center: [anchor.lng, anchor.lat], zoom: 12 });
      } else {
        map.fitBounds(bounds, { padding: 80, maxZoom: 16 });
      }
      return;
    }
    if (markers.length === 0) {
      map.flyTo({ center: [fallbackCenter.lng, fallbackCenter.lat], zoom: fallbackZoom });
      return;
    }
    if (markers.length === 1) {
      map.flyTo({ center: [markers[0].lng, markers[0].lat], zoom: singleMarkerZoom });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    markers.forEach((m) => bounds.extend([m.lng, m.lat]));
    map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, key]);
  return null;
}

/** Collapses the (legally required) CARTO / OpenStreetMap attribution to its
 *  minimal compact form — a small "ⓘ" button that expands the credits only on
 *  click. ODbL (OSM) + CARTO's free-tier terms require the attribution to stay
 *  reachable, so we minimise it rather than remove it. */
function CompactAttribution() {
  const { map, isLoaded } = useMap();
  useEffect(() => {
    if (!map) return;
    const el = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
    el?.classList.remove("maplibregl-compact-show");
  }, [map, isLoaded]);
  return null;
}

/** 64-point polygon approximating a geographic circle, in GeoJSON order
 *  ([lng, lat]). Good to well under 1% radius error — plenty for a privacy
 *  disc that is itself deliberately imprecise. */
function circleFeature(lat: number, lng: number, radiusMeters: number) {
  const points = 64;
  const degLat = radiusMeters / 111_320;
  const degLng = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    ring.push([lng + degLng * Math.cos(theta), lat + degLat * Math.sin(theta)]);
  }
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [ring] },
  };
}

/** Renders the approx-area disc as a real map layer (fill + outline) so it
 *  scales with zoom — a DOM overlay would keep its pixel size and lie about
 *  the area as the user zooms. */
function AreaCircleLayer({ lat, lng, radiusMeters, color }: {
  lat: number;
  lng: number;
  radiusMeters: number;
  color: string;
}) {
  const { map, isLoaded } = useMap();
  useEffect(() => {
    if (!map || !isLoaded) return;
    const id = "approx-area-circle";
    if (map.getSource(id)) return;
    map.addSource(id, { type: "geojson", data: circleFeature(lat, lng, radiusMeters) });
    map.addLayer({
      id: `${id}-fill`,
      type: "fill",
      source: id,
      paint: { "fill-color": color, "fill-opacity": 0.16 },
    });
    map.addLayer({
      id: `${id}-line`,
      type: "line",
      source: id,
      paint: { "line-color": color, "line-opacity": 0.5, "line-width": 1.5 },
    });
    return () => {
      // When the whole map unmounts (navigating away from a detail page),
      // React runs the parent Map component's cleanup — map.remove(), which
      // nulls map.style — BEFORE this deleted-subtree cleanup, so even
      // getLayer() throws. Same try/catch idiom as the layer components in
      // ui/map.tsx; the layers died with the map, nothing to detach.
      try {
        if (map.getLayer(`${id}-line`)) map.removeLayer(`${id}-line`);
        if (map.getLayer(`${id}-fill`)) map.removeLayer(`${id}-fill`);
        if (map.getSource(id)) map.removeSource(id);
      } catch {
        // ignore — map already destroyed
      }
    };
  }, [map, isLoaded, lat, lng, radiusMeters, color]);
  return null;
}

/** Closes any open popup when the user clicks the empty map (parity with the
 *  old GoogleMap `onClick`). Marker clicks don't trigger this — they're DOM
 *  clicks on the marker element, not map canvas events. */
function MapClickClose({ onClose }: { onClose: () => void }) {
  const { map } = useMap();
  useEffect(() => {
    if (!map) return;
    const handler = () => onClose();
    map.on("click", handler);
    return () => { map.off("click", handler); };
  }, [map, onClose]);
  return null;
}

/** Reports the map's visible bounds to the parent on every settle (moveend) and
 *  once the map first loads. Uses moveend (not the continuous "move") so the
 *  parent only re-filters when the user finishes panning/zooming. */
function BoundsReporter({ onBoundsChange }: { onBoundsChange: (b: MapBounds) => void }) {
  const { map, isLoaded } = useMap();
  useEffect(() => {
    if (!map) return;
    const report = () => {
      const b = map.getBounds();
      onBoundsChange({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
    };
    // Emit the initial viewport once loaded, then on every settle.
    if (isLoaded) report();
    map.on("moveend", report);
    return () => { map.off("moveend", report); };
  }, [map, isLoaded, onBoundsChange]);
  return null;
}

const MapView = ({
  markers,
  center,
  zoom = 12,
  height = "400px",
  className = "",
  onMarkerClick,
  showUserLocation,
  userLat,
  userLng,
  highlightId,
  searchCenter,
  searchAddress,
  popupMode = "card",
  openOnHover = false,
  onHoverChange,
  onBoundsChange,
  approxCircle,
}: MapViewProps) => {
  const [geocoded, setGeocoded] = useState<Record<string, { lat: number; lng: number }>>({});
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Notify the parent whenever the internal hover marker changes. We
  // intentionally do NOT fire this for the external highlightId — that
  // would create a feedback loop with parents that mirror their list
  // hover into this prop.
  useEffect(() => { onHoverChange?.(hoverId); }, [hoverId, onHoverChange]);
  const [searchGeo, setSearchGeo] = useState<{ lat: number; lng: number } | null>(null);
  const closeTimer = useRef<number | null>(null);

  // Geocode the page-level search/location string so the map can pan there
  // even when 0 listings match. Cached via the shared geocodeCache.
  useEffect(() => {
    let cancelled = false;
    const trimmed = (searchAddress || "").trim();
    if (!trimmed) {
      setSearchGeo(null);
      return;
    }
    (async () => {
      const coords = await geocodeAddress(trimmed);
      if (!cancelled) setSearchGeo(coords);
    })();
    return () => { cancelled = true; };
  }, [searchAddress]);

  const openHover = (id: string) => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHoverId(id);
  };
  const scheduleClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHoverId(null), 120);
  };

  // Geocode markers that are missing coords but have an address
  useEffect(() => {
    let cancelled = false;
    const toGeocode = markers.filter(
      (m) => !isValidCoord(m.lat, m.lng) && m.address && !geocoded[m.id]
    );
    (async () => {
      for (const m of toGeocode) {
        const coords = await geocodeAddress(m.address!);
        if (cancelled) return;
        if (coords) setGeocoded((prev) => ({ ...prev, [m.id]: coords }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers.map((m) => `${m.id}:${m.lat}:${m.lng}:${m.address || ""}`).join("|")]);

  const validMarkers = useMemo(
    () =>
      markers
        .map((m) => {
          if (isValidCoord(m.lat, m.lng)) return m;
          const fb = geocoded[m.id];
          return fb ? { ...m, lat: fb.lat, lng: fb.lng } : null;
        })
        .filter((m): m is MapMarker => m !== null),
    [markers, geocoded]
  );

  const indiaCenter = { lat: 22.9734, lng: 78.6569 };
  const defaultCenter =
    (center && { lat: center[0], lng: center[1] }) ||
    (showUserLocation && userLat && userLng ? { lat: userLat, lng: userLng } : null) ||
    (validMarkers[0] ? { lat: validMarkers[0].lat, lng: validMarkers[0].lng } : indiaCenter);
  // An approx-area disc is map content too — don't fall back to the
  // country-level zoom just because there are no point markers.
  const effectiveZoom = validMarkers.length > 0 || approxCircle ? zoom : 5;

  const closePopups = useCallback(() => {
    setOpenId(null);
    setHoverId(null);
  }, []);

  // Which marker (if any) should show its rich popup card. Only one card is
  // ever shown at a time: in hover mode the hovered / externally-highlighted
  // marker wins, otherwise the explicitly-opened (clicked) marker.
  const cardMarker = useMemo(() => {
    if (popupMode !== "card") return null;
    const id = openOnHover ? (hoverId ?? highlightId ?? openId) : openId;
    return id ? validMarkers.find((m) => m.id === id) ?? null : null;
  }, [popupMode, openOnHover, hoverId, highlightId, openId, validMarkers]);

  return (
    <div
      className={`rounded-2xl overflow-hidden border border-border relative z-0 ${className}`}
      style={{ height }}
    >
      <MapGL
        theme="light"
        viewport={{ center: [defaultCenter.lng, defaultCenter.lat], zoom: effectiveZoom }}
      >
        <MapControls showZoom />
        <CompactAttribution />
        {approxCircle && (
          <AreaCircleLayer
            lat={approxCircle.lat}
            lng={approxCircle.lng}
            radiusMeters={approxCircle.radiusMeters ?? 850}
            color={approxCircle.color ?? "hsl(239, 84%, 67%)"}
          />
        )}
        <MapClickClose onClose={closePopups} />
        {onBoundsChange && <BoundsReporter onBoundsChange={onBoundsChange} />}
        <AutoRecenter
          markers={validMarkers}
          anchor={showUserLocation && userLat != null && userLng != null ? { lat: userLat, lng: userLng } : null}
          fallbackCenter={
            searchCenter
              ? { lat: searchCenter.lat, lng: searchCenter.lng }
              : searchGeo
              ? { lat: searchGeo.lat, lng: searchGeo.lng }
              : showUserLocation && userLat != null && userLng != null
              ? { lat: userLat, lng: userLng }
              : indiaCenter
          }
          fallbackZoom={
            searchCenter?.zoom != null
              ? searchCenter.zoom
              : searchCenter || searchGeo
              ? 10
              : showUserLocation && userLat != null && userLng != null
              ? 11
              : 5
          }
        />
        {validMarkers.map((m) => {
          const isHover = hoverId === m.id || highlightId === m.id;
          // openOnHover lifts the popup card automatically while a marker
          // (or its mirrored side card) is hovered — matching the user's
          // mental model that "hover anywhere = preview the listing".
          const isOpen = cardMarker?.id === m.id;
          const isActive = isOpen || isHover;
          const accent = m.color || "hsl(239, 84%, 67%)";
          return (
            <MarkerLayer
              key={m.id}
              longitude={m.lng}
              latitude={m.lat}
              anchor="bottom"
              onClick={(e) => {
                e.stopPropagation();
                if (popupMode === "direct") {
                  m.onClick?.();
                  onMarkerClick?.(m.id);
                  return;
                }
                setOpenId((prev) => (prev === m.id ? null : m.id));
              }}
              onMouseEnter={() => openHover(m.id)}
              onMouseLeave={scheduleClose}
            >
              <MarkerContent>
                {m.variant === "pin" ? (
                  // Teardrop pin used on single-listing detail maps where
                  // there's no price to display. The SVG is sized so its
                  // bottom tip sits on the marker anchor.
                  <svg
                    width={isActive ? 40 : 34}
                    height={isActive ? 52 : 44}
                    viewBox="0 0 32 42"
                    style={{
                      display: "block",
                      cursor: "pointer",
                      filter: isActive
                        ? "drop-shadow(0 8px 18px rgba(0,0,0,0.32))"
                        : "drop-shadow(0 4px 10px rgba(0,0,0,0.22))",
                      transform: "translateY(-2px)",
                      transition: "width 140ms, height 140ms, filter 140ms",
                    }}
                  >
                    <path
                      d="M16 1c-7.18 0-13 5.6-13 12.5 0 9.7 11.2 25.2 12.2 26.5a1 1 0 0 0 1.6 0C17.8 38.7 29 23.2 29 13.5 29 6.6 23.18 1 16 1z"
                      fill={accent}
                      stroke="white"
                      strokeWidth="2"
                    />
                    <circle cx="16" cy="14" r="5" fill="white" />
                  </svg>
                ) : (
                  /* Price pill — always visible. The marker anchors its
                     bottom-center on the lat/lng. */
                  <div
                    style={{
                      background: isActive ? accent : "white",
                      color: isActive ? "white" : "#111827",
                      border: `1.5px solid ${accent}`,
                      padding: isActive ? "7px 14px" : "5px 11px",
                      borderRadius: 999,
                      fontWeight: 700,
                      fontSize: isActive ? 14 : 13,
                      boxShadow: isActive ? "0 8px 20px rgba(0,0,0,0.25)" : "0 2px 6px rgba(0,0,0,0.18)",
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      transform: `scale(${isActive ? 1.1 : 1})`,
                      transformOrigin: "bottom center",
                      transition: "transform 140ms, padding 140ms, font-size 140ms, background 140ms, color 140ms, box-shadow 140ms",
                    }}
                  >
                    {m.label || m.price || "•"}
                  </div>
                )}
              </MarkerContent>
            </MarkerLayer>
          );
        })}
        {cardMarker && (
          <MarkerPopup
            marker={cardMarker}
            accent={cardMarker.color || "hsl(239, 84%, 67%)"}
            liked={!!cardMarker.liked}
            onClose={closePopups}
            onCardClick={() => { cardMarker.onClick?.(); onMarkerClick?.(cardMarker.id); }}
            onToggleLike={() => cardMarker.onToggleLike?.()}
            onMouseEnter={() => openHover(cardMarker.id)}
            onMouseLeave={scheduleClose}
          />
        )}
        {showUserLocation && userLat && userLng && (
          <MarkerLayer longitude={userLng} latitude={userLat} anchor="center">
            <MarkerContent>
              <div
                style={{
                  background: "#10b981",
                  color: "white",
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  border: "2px solid white",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                }}
              >
                📍
              </div>
            </MarkerContent>
          </MarkerLayer>
        )}
      </MapGL>
    </div>
  );
};

export default MapView;
