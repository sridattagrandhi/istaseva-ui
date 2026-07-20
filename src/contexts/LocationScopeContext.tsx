import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  type LocationScope,
  readStoredLocationScope,
  writeStoredLocationScope,
} from "@/lib/location-scope";

/**
 * Holds the global location scope picked from the navbar search palette.
 * Device-level browse context (like recent searches): persisted to
 * localStorage so it survives reloads, cleared only from the pill's ✕ or by
 * picking a new place.
 */
interface LocationScopeContextValue {
  scope: LocationScope | null;
  setScope: (scope: LocationScope | null) => void;
}

const LocationScopeContext = createContext<LocationScopeContextValue>({
  scope: null,
  setScope: () => {},
});

export const LocationScopeProvider = ({ children }: { children: ReactNode }) => {
  const [scope, setScopeState] = useState<LocationScope | null>(() => readStoredLocationScope());

  const setScope = useCallback((next: LocationScope | null) => {
    setScopeState(next);
    writeStoredLocationScope(next);
  }, []);

  const value = useMemo(() => ({ scope, setScope }), [scope, setScope]);
  return <LocationScopeContext.Provider value={value}>{children}</LocationScopeContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useLocationScope = () => useContext(LocationScopeContext);
