import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Search, MapPin, BedDouble, Sparkles, Car, Clock, Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useLanguage } from "@/contexts/LanguageContext";
import { useLocationScope } from "@/contexts/LocationScopeContext";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";
import { useGlobalSearch, type GlobalSearchListing, type GlobalSearchPlace } from "@/hooks/use-global-search";

// Global "Search everything" palette (⌘K). Additive: the per-vertical search
// bars on Stays / Services / Transport are untouched — this is the one-tap
// cross-category entry point in the navbar, present on every page.
//  - Listing result → its detail page (/stay|/service|/transport/:id).
//  - Place result → sets the GLOBAL LOCATION SCOPE (LocationScopeContext):
//    all four marketplace surfaces narrow to it until it's cleared from the
//    pill's ✕. The pill itself shows the active place ("📍 Hyderabad ✕")
//    instead of "Search everything" while a scope is set. Picking a place
//    keeps the user on their current marketplace tab (immediate visual
//    effect); from any other page it lands on Discovery.

const RECENTS_KEY = "istaseva:global-search-recents:v1";
const MAX_RECENTS = 5;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function writeRecent(query: string) {
  const q = query.trim();
  if (q.length < 2) return;
  try {
    const next = [q, ...readRecents().filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* quota / private mode — ignore */ }
}

const typeIcon = {
  stay: BedDouble,
  service: Sparkles,
  transport: Car,
} as const;

const detailPath = {
  stay: "/stay",
  service: "/service",
  transport: "/transport",
} as const;

// Marketplace routes that visibly react to the location scope — picking a
// place from one of these stays put; anywhere else lands on Discovery.
const MARKETPLACE_PATHS = new Set(["/", "/explore", "/services", "/transport"]);

export const GlobalSearch = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { scope, setScope } = useLocationScope();
  const { debouncedQuery, active, listings, places, loading } = useGlobalSearch(query, open);

  // ⌘K / Ctrl+K opens the palette from anywhere (⌘B is taken by the sidebar).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Refresh recents each open; reset the query so a stale search never
  // flashes when the palette reopens.
  useEffect(() => {
    if (open) {
      setRecents(readRecents());
      setQuery("");
    }
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const handlePickListing = (listing: GlobalSearchListing) => {
    writeRecent(debouncedQuery);
    getAnalyticsEventsService().track("search_performed", {
      listingType: listing.listingType,
      source: "global_search",
      props: { picked: "listing" },
    });
    close();
    navigate(`${detailPath[listing.listingType]}/${listing.id}`);
  };

  const handlePickPlace = async (place: GlobalSearchPlace) => {
    writeRecent(place.mainText || debouncedQuery);
    getAnalyticsEventsService().track("search_performed", {
      listingType: "stay",
      source: "global_search",
      props: { picked: "place" },
    });
    close();
    const label = place.mainText || place.description;
    // Resolve the pick to lat/lng + admin hierarchy — the scope matcher needs
    // coordinates for distance matching. Nominatim-fallback suggestions carry
    // no place_id; those (and resolution failures) fall back to the old
    // behavior of seeding the stays page's text search.
    if (place.id) {
      const res = await apiRequest<{ result: { lat: number; lng: number; locality: string | null; district: string | null; state: string | null } | null }>(
        "/api/geocode/place-details",
        { method: "POST", headers: getJsonHeaders(), body: JSON.stringify({ placeId: place.id }) },
      );
      if (res.success && res.data?.result) {
        setScope({ ...res.data.result, label });
        // Stay on the marketplace tab the user is browsing — the grid
        // narrows in place. From any other page, land on Discovery.
        if (!MARKETPLACE_PATHS.has(location.pathname)) navigate("/");
        return;
      }
    }
    navigate(`/explore?q=${encodeURIComponent(label)}`);
  };

  const clearScope = (e: React.MouseEvent) => {
    // The ✕ lives inside the pill button — don't let the click also open
    // the palette.
    e.stopPropagation();
    setScope(null);
  };

  const showRecents = !active && recents.length > 0;
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  return (
    <>
      {/* Trigger pill — full "Search everything ⌘K" on md+, icon-only below.
          While a location scope is active the pill becomes "📍 <place> ✕":
          the body still opens the palette (pick a new place), the ✕ clears
          the scope. The ✕ is a span[role=button] — a nested <button> would
          be invalid HTML. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`hidden md:inline-flex items-center gap-2 min-h-[40px] rounded-full border py-2 text-[13px] font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all ${
          scope
            ? "border-primary/30 bg-primary/10 pl-3 pr-1.5 text-foreground hover:bg-primary/15"
            : "border-white/70 bg-white/55 pl-3 pr-2 text-muted-foreground hover:bg-white/75 hover:text-foreground"
        }`}
        aria-label={t("globalSearch.trigger", { defaultValue: "Search everything" })}
      >
        {scope ? (
          <>
            <MapPin className="h-[15px] w-[15px] text-primary" />
            <span className="max-w-[140px] truncate">{scope.label}</span>
            <span
              role="button"
              tabIndex={0}
              onClick={clearScope}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setScope(null); } }}
              aria-label={t("globalSearch.clearScope", { defaultValue: "Clear location" })}
              className="inline-grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          </>
        ) : (
          <>
            <Search className="h-[15px] w-[15px]" />
            <span className="hidden xl:inline">{t("globalSearch.trigger", { defaultValue: "Search everything" })}</span>
            <kbd className="ml-1 hidden lg:inline-flex items-center rounded-full border border-border bg-white/80 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
              {isMac ? "⌘K" : "Ctrl K"}
            </kbd>
          </>
        )}
      </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`md:hidden relative inline-grid h-10 w-10 place-items-center rounded-full border transition-all ${
          scope
            ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
            : "border-white/70 bg-white/55 text-foreground hover:bg-white/75"
        }`}
        aria-label={scope ? scope.label : t("globalSearch.trigger", { defaultValue: "Search everything" })}
      >
        {scope ? <MapPin className="h-[17px] w-[17px]" /> : <Search className="h-[17px] w-[17px]" />}
      </button>

      <Dialog open={open} onOpenChange={(v) => { if (!v) close(); else setOpen(true); }}>
        <DialogContent className="overflow-hidden p-0 shadow-lg top-[20%] translate-y-0 sm:max-w-xl rounded-2xl" aria-describedby={undefined}>
          {/* Screen-reader-only title — the palette has no visible header. */}
          <DialogTitle className="sr-only">{t("globalSearch.trigger", { defaultValue: "Search everything" })}</DialogTitle>
          {/* Results come from the server — cmdk must not re-filter them. */}
          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("globalSearch.placeholder", { defaultValue: "Search listings, city, state, area…" })}
            />
            <CommandList className="max-h-[360px]">
              {!active && scope && (
                <CommandGroup heading={t("globalSearch.activeLocation", { defaultValue: "Active location" })}>
                  <CommandItem value="clear-location-scope" onSelect={() => { setScope(null); close(); }} className="gap-2.5">
                    <span className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <MapPin className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-foreground">{scope.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t("globalSearch.clearScope", { defaultValue: "Clear location" })}
                      </span>
                    </span>
                    <X className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </CommandItem>
                </CommandGroup>
              )}
              {showRecents && (
                <CommandGroup heading={t("globalSearch.recent", { defaultValue: "Recent searches" })}>
                  {recents.map((r) => (
                    <CommandItem key={r} value={`recent-${r}`} onSelect={() => setQuery(r)} className="gap-2.5">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{r}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {!active && !showRecents && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("globalSearch.hint", { defaultValue: "Search across stays, services, and transport" })}
                </p>
              )}
              {active && loading && listings.length === 0 && places.length === 0 && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {active && !loading && listings.length === 0 && places.length === 0 && (
                <CommandEmpty>
                  {t("globalSearch.noResults", { defaultValue: "No results for “{{query}}”", query: debouncedQuery })}
                </CommandEmpty>
              )}
              {active && places.length > 0 && (
                <CommandGroup heading={t("globalSearch.places", { defaultValue: "Places" })}>
                  {places.map((place, i) => (
                    <CommandItem
                      key={place.id || `${place.description}-${i}`}
                      value={`place-${place.id || place.description}`}
                      onSelect={() => handlePickPlace(place)}
                      className="gap-2.5"
                    >
                      <span className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                        <MapPin className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">{place.mainText || place.description}</span>
                        {place.secondaryText && (
                          <span className="block truncate text-xs text-muted-foreground">{place.secondaryText}</span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {active && listings.length > 0 && (
                <CommandGroup heading={t("globalSearch.listings", { defaultValue: "Listings" })}>
                  {listings.map((listing) => {
                    const Icon = typeIcon[listing.listingType];
                    const where = [listing.area, listing.city, listing.state].filter(Boolean).join(", ");
                    const sub = [listing.category?.replace(/-/g, " "), where].filter(Boolean).join(" · ");
                    return (
                      <CommandItem
                        key={listing.id}
                        value={`listing-${listing.id}`}
                        onSelect={() => handlePickListing(listing)}
                        className="gap-2.5"
                      >
                        <span className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-foreground">{listing.name}</span>
                          {sub && <span className="block truncate text-xs capitalize text-muted-foreground">{sub}</span>}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default GlobalSearch;
