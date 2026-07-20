import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { setAnalyticsOrigin } from "@/domains/analytics/events.service";

interface LocationState {
  lat: number;
  lng: number;
  name: string;
  district: string;
  state: string;
  isDefault: boolean;
}

interface LocationContextType {
  location: LocationState;
  setLocation: (loc: LocationState) => void;
  requestLocation: () => void;
  isLocating: boolean;
  getDistanceKm: (lat: number, lng: number) => number;
}

const DEFAULT_LOCATION: LocationState = {
  lat: 15.335,
  lng: 76.462,
  name: "Hampi",
  district: "Bellary",
  state: "Karnataka",
  isDefault: true,
};

const LocationContext = createContext<LocationContextType | undefined>(undefined);

// Haversine formula
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Best-effort reverse geocode via OpenStreetMap Nominatim. No API key needed
// and works globally — so a user in San Ramon, CA gets "San Ramon, California"
// instead of being forced into the closest Indian city. Times out fast and
// falls back to a generic "Your location" label so this never blocks the UI.
async function reverseGeocodeRemote(lat: number, lng: number): Promise<{ name: string; district: string; state: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { address?: Record<string, string> };
    const a = data.address || {};
    const name = a.city || a.town || a.village || a.suburb || a.county || a.state || "";
    // Use the state (or country, as a last resort) for the secondary label so
    // the UI reads "San Ramon, California" rather than the noisy county name.
    const state = a.state || a.region || a.country || "";
    if (!name) return null;
    return { name, district: state, state };
  } catch {
    return null;
  }
}

export const LocationProvider = ({ children }: { children: ReactNode }) => {
  const [location, setLocation] = useState<LocationState>(DEFAULT_LOCATION);
  const [isLocating, setIsLocating] = useState(false);

  const requestLocation = useCallback(() => {
    setIsLocating(true);
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          // Set the coords immediately so distance calcs are accurate; the
          // human-readable label fills in once Nominatim responds.
          setLocation({ lat, lng, name: "Your location", district: "", state: "", isDefault: false });
          setIsLocating(false);
          const geo = await reverseGeocodeRemote(lat, lng);
          if (geo) {
            setLocation({ lat, lng, name: geo.name, district: geo.district, state: geo.state, isDefault: false });
            // Only a real granted+resolved location feeds analytics — the
            // fallback branches below reuse DEFAULT_LOCATION coords and must
            // never be reported as the customer's origin.
            setAnalyticsOrigin(geo.name, geo.state);
          }
        },
        () => {
          // Fallback to default
          setLocation({ ...DEFAULT_LOCATION, isDefault: false });
          setIsLocating(false);
        },
        { timeout: 5000 }
      );
    } else {
      setLocation({ ...DEFAULT_LOCATION, isDefault: false });
      setIsLocating(false);
    }
  }, []);

  const getDistanceKm = useCallback((lat: number, lng: number) => {
    return Math.round(haversine(location.lat, location.lng, lat, lng) * 10) / 10;
  }, [location]);

  return (
    <LocationContext.Provider value={{ location, setLocation, requestLocation, isLocating, getDistanceKm }}>
      {children}
    </LocationContext.Provider>
  );
};

export const useLocation = () => {
  const context = useContext(LocationContext);
  if (!context) throw new Error("useLocation must be used within LocationProvider");
  return context;
};
