import { type ReactNode, type TransitionEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import "./client-redesign.css";
import {
  ArrowRight,
  BadgeCheck,
  BedDouble,
  Building2,
  CalendarDays,
  Car,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Compass,
  CreditCard,
  Filter,
  Globe2,
  Heart,
  Home,
  Hotel,
  Languages,
  Landmark,
  LayoutGrid,
  LocateFixed,
  Map,
  MapPin,
  Navigation,
  Route,
  Scissors,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Store,
  TicketPercent,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  useListingTaxonomy,
  useMarketplaceServices,
  useMarketplaceStays,
  useMarketplaceTransport,
  useInfiniteMarketplaceServices,
  useInfiniteMarketplaceStays,
  useInfiniteMarketplaceTransport,
} from "@/hooks/use-marketplace-data";
import type {
  MarketplaceBookingDraft,
  MarketplaceService as Service,
  MarketplaceStay as Stay,
  MarketplaceTransport as Transport,
  ServiceMode,
  TransportMode,
} from "@/types/marketplace";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { marketplaceAgentBus } from "@/lib/marketplace-agent-bus";
import { placeLine, placeParts } from "@/lib/marketplace-adapters";
import { toast } from "sonner";
import { useSaved } from "@/contexts/SavedContext";
import { useLocationScope } from "@/contexts/LocationScopeContext";
import { matchesLocationScope } from "@/lib/location-scope";
import { distanceKm, getCurrentPosition, type LatLng } from "@/lib/geo";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { getSearchEventsService } from "@/domains/analytics/search-events.service";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";
import { PLATFORM_FEE_RUPEES } from "@/lib/pricing";
import { useLanguage } from "@/contexts/LanguageContext";

/** Resolved Google Place — used to scope the stays-marketplace search by
 *  distance + admin hierarchy when the user picks a suggestion instead
 *  of just typing free text. */
type PickedPlace = {
  lat: number;
  lng: number;
  locality: string | null;
  district: string | null;
  state: string | null;
};

/** When the user picks a suggestion, surface stays within this radius
 *  OR whose city/district matches the picked admin hierarchy. 50 km is
 *  generous enough to keep "Tirumala → Tirupati (~22 km)" working while
 *  still narrowing the list meaningfully vs. country-wide. */
const STAY_SEARCH_RADIUS_KM = 50;

/** Case-insensitive bidirectional "either contains the other" — handles
 *  "Tirupati" matching "Tirupati district" or vice versa without picking
 *  up unrelated cities that share a prefix. */
function adminMatches(stayValue: string | null | undefined, pickedValue: string | null | undefined): boolean {
  if (!stayValue || !pickedValue) return false;
  const s = stayValue.trim().toLowerCase();
  const p = pickedValue.trim().toLowerCase();
  if (!s || !p) return false;
  return s.includes(p) || p.includes(s);
}
import { MarketplaceBookingDialog } from "./MarketplaceBookingDialog";
import { type MapMarker, type MapBounds } from "@/components/MapView";
// Lazy so maplibre-gl (~800 KB) is a separate chunk that only downloads when a
// map actually renders — keeping it out of the marketplace entry chunk.
const MapView = lazy(() => import("@/components/MapView"));
import AddressAutocompleteInput from "@/components/AddressAutocompleteInput";
import { AddListingChooserDialog } from "@/components/AddListingChooserDialog";
import {
  DateRangePopover,
  GuestsPopover,
  FiltersButton,
  FiltersDialog,
  SortPopover,
  type SortValue,
  type StayFilters,
  type ServiceFilters,
  type TransportFilters,
  STAY_FILTER_DEFAULT,
  SERVICE_FILTER_DEFAULT,
  TRANSPORT_FILTER_DEFAULT,
  localDateFromIso,
  addDaysIso,
} from "./MarketplaceControls";
import { useAuth } from "@/contexts/AuthContext";
import { useRecentSearches, type RecentSearch } from "@/hooks/use-recent-searches";
import { TRANSPORT_TYPES, getTransportTypeLabel, legacyToTypeId } from "@/lib/transport-types";

/** Onboarding's 6 transport categories — keep the filter chips aligned with
 *  what hosts can actually pick when creating a listing. Each row maps the
 *  onboarding label to the catalog id it folds into via legacy aliases. Any
 *  additional types discovered on live listings (e.g. when a host adds a
 *  custom vehicle through "Add a custom vehicle") get appended at runtime. */
const ONBOARDING_TRANSPORT_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "sedan_cab",       label: "Cab" },
  { id: "auto_rickshaw",   label: "Auto" },
  { id: "bus",             label: "Bus" },
  { id: "tempo_traveller", label: "Tempo" },
  { id: "scooter_taxi",    label: "Scooter" },
  { id: "bike_taxi",       label: "Motorcycle" },
];

type Page = "discovery" | "stays" | "services" | "transport";
type SearchMode = "stays" | "services" | "transport";


const modeLabels: Record<SearchMode, string> = {
  stays: "Stays",
  services: "Services",
  transport: "Transport",
};

const navItems: Array<{ page: Page; label: string; icon: typeof Compass }> = [
  { page: "discovery", label: "Discovery", icon: Compass },
  { page: "stays", label: "Stays", icon: BedDouble },
  { page: "services", label: "Services", icon: Sparkles },
  { page: "transport", label: "Transport", icon: Car },
];

function LogoMark() {
  const { t } = useLanguage();
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label={t("rd.client.logoAlt", { defaultValue: "IstaSeva logo" })} className="logo-mark-svg">
      <defs>
        <linearGradient id="istaLogoFill" x1="12" y1="8" x2="52" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3a3247" />
          <stop offset="0.58" stopColor="#7b5244" />
          <stop offset="1" stopColor="#c08a5a" />
        </linearGradient>
      </defs>
      <path
        d="M32 5c-10.5 0-19 8.1-19 18.1 0 13.4 15.1 29.6 18.2 32.7a1.1 1.1 0 0 0 1.6 0C35.9 52.7 51 36.5 51 23.1 51 13.1 42.5 5 32 5Z"
        fill="url(#istaLogoFill)"
      />
      <path
        d="M21.5 27.8 32 18.9l10.5 8.9v12.4a2.2 2.2 0 0 1-2.2 2.2H23.7a2.2 2.2 0 0 1-2.2-2.2V27.8Z"
        fill="rgba(255,255,255,0.92)"
      />
      <path
        d="M28.3 42.4V32.1a3.7 3.7 0 0 1 7.4 0v10.3"
        fill="none"
        stroke="#3a3247"
        strokeWidth="3.1"
        strokeLinecap="round"
      />
      <path
        d="M42.5 16.4h4.8m-2.4-2.4v4.8M17 19.5h3.8m-1.9-1.9v3.8"
        stroke="#f7e8d7"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

type ClientRedesignProps = {
  initialPage?: Page;
  onRouteChange?: (page: Page) => void;
  onLogin?: () => void;
  onSignup?: () => void;
};

function ClientRedesign({
  initialPage = "discovery",
  onRouteChange,
  onLogin,
  onSignup,
}: ClientRedesignProps) {
  const [page, setPage] = useState<Page>(initialPage);
  const [serviceMode, setServiceMode] = useState<ServiceMode>("at-home");
  const [transportMode, setTransportMode] = useState<TransportMode>("package");
  // `selectedStay` is purely a tracking handoff — the real navigation uses
  // /stay/:id. We no longer pre-pick a stay since the list is async-loaded.
  const [, setSelectedStay] = useState<Stay | null>(null);
  // Same pattern as `selectedStay` — purely a tracking handoff; real
  // navigation flows through /service/:id and /transport/:id.
  const [, setSelectedService] = useState<Service | null>(null);
  const [, setSelectedTransport] = useState<Transport | null>(null);
  const [bookingDraft, setBookingDraft] = useState<MarketplaceBookingDraft | null>(null);
  const openBooking = (draft: MarketplaceBookingDraft) => setBookingDraft(draft);
  const navigate = useNavigate();

  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);

  useEffect(() => {
    document.body.classList.add("client-redesign-active");
    return () => document.body.classList.remove("client-redesign-active");
  }, []);

  const handleNavigate = (nextPage: Page) => {
    setPage(nextPage);
    onRouteChange?.(nextPage);
  };

  // The global <Navbar /> from src/components/Navbar.tsx is rendered by
  // <AppChrome>. We intentionally do NOT render the redesign's internal
  // NavigationBar here to avoid a duplicate header. The original component
  // is kept below for reference but unused.
  return (
    <div className="client-redesign app-shell">
      <main>
        {page === "discovery" && (
          <DiscoveryPage
            onNavigate={handleNavigate}
            onOpenStay={(s) => { getAnalyticsEventsService().track("card_clicked", { listingId: String(s.id), listingType: "stay", source: "discovery" }); setSelectedStay(s); navigate(`/stay/${s.id}`, { state: { from: "discovery" } }); }}
            onOpenService={(s) => { getAnalyticsEventsService().track("card_clicked", { listingId: String(s.id), listingType: "service", source: "discovery" }); setSelectedService(s); navigate(`/service/${s.id}`, { state: { from: "discovery" } }); }}
            onOpenTransport={(t) => { getAnalyticsEventsService().track("card_clicked", { listingId: String(t.id), listingType: "transport", source: "discovery" }); setSelectedTransport(t); navigate(`/transport/${t.id}`, { state: { from: "discovery" } }); }}
          />
        )}
        {page === "stays" && (
          <StaysPage
            onNavigate={handleNavigate}
            onOpenStay={(stay) => { getAnalyticsEventsService().track("card_clicked", { listingId: String(stay.id), listingType: "stay", source: "explore_stays" }); setSelectedStay(stay); navigate(`/stay/${stay.id}`); }}
          />
        )}
        {page === "services" && (
          <ServicesPage
            serviceMode={serviceMode}
            setServiceMode={setServiceMode}
            onOpenService={(service) => { getAnalyticsEventsService().track("card_clicked", { listingId: String(service.id), listingType: "service", source: "explore_services" }); setSelectedService(service); navigate(`/service/${service.id}`); }}
          />
        )}
        {page === "transport" && (
          <TransportPage
            transportMode={transportMode}
            setTransportMode={setTransportMode}
            onOpenTransport={(item) => { getAnalyticsEventsService().track("card_clicked", { listingId: String(item.id), listingType: "transport", source: "explore_transport" }); setSelectedTransport(item); navigate(`/transport/${item.id}`); }}
          />
        )}
      </main>

      {/* Slim legal footer: the redesign chrome suppresses the global
          <Footer /> (App.tsx), so the legally required links (LEG-001/017)
          must render here or the main surfaces have no path to them. */}
      <LegalFooter />

      {/* AiConcierge removed — the canonical AssistantWidget mounted in App.tsx
          handles the floating Ista AI button across redesign pages too. */}
      <MarketplaceBookingDialog draft={bookingDraft} onClose={() => setBookingDraft(null)} />
    </div>
  );
}

/** Legal links row for the redesign pages (which hide the global Footer). */
function LegalFooter() {
  const { t } = useLanguage();
  const links: [string, string][] = [
    ["/about", t("about", { defaultValue: "About" })],
    ["/contact", t("contact", { defaultValue: "Contact" })],
    ["/privacy", t("footer.links.privacy", { defaultValue: "Privacy Policy" })],
    ["/terms", t("footer.links.terms", { defaultValue: "Terms of Service" })],
    ["/refunds", t("footer.links.refunds", { defaultValue: "Cancellation & Refunds" })],
    ["/grievance", t("footer.links.grievance", { defaultValue: "Grievance Redressal" })],
    ["/delete-account", t("footer.links.deleteAccount", { defaultValue: "Delete Account" })],
  ];
  return (
    <footer className="legal-footer">
      <nav className="legal-footer-links">
        {links.map(([to, label]) => (
          <Link key={to} to={to}>{label}</Link>
        ))}
      </nav>
      <p className="legal-footer-copy">{t("footer.copyright", { defaultValue: "© 2026 IstaSeva. All rights reserved." })}</p>
    </footer>
  );
}

function NavigationBar({
  activePage,
  onNavigate,
  onLogin,
  onSignup,
}: {
  activePage: Page;
  onNavigate: (page: Page) => void;
  onLogin?: () => void;
  onSignup?: () => void;
}) {
  const { t } = useLanguage();
  const navLabels: Record<Page, string> = {
    discovery: t("rd.client.navDiscovery", { defaultValue: "Discovery" }),
    stays: t("rd.client.navStays", { defaultValue: "Stays" }),
    services: t("rd.client.navServices", { defaultValue: "Services" }),
    transport: t("rd.client.navTransport", { defaultValue: "Transport" }),
  };
  return (
    <header className="topbar">
      <button className="brand" onClick={() => onNavigate("discovery")} aria-label={t("rd.client.goToDiscovery", { defaultValue: "Go to discovery" })}>
        <span className="brand-mark"><LogoMark /></span>
        <span>
          <strong>IstaSeva</strong>
          <small>{t("rd.client.servingCommunities", { defaultValue: "Serving communities" })}</small>
        </span>
      </button>

      <nav className="nav-pills" aria-label={t("rd.client.mainNavigation", { defaultValue: "Main navigation" })}>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.page}
              className={activePage === item.page ? "active" : ""}
              onClick={() => onNavigate(item.page)}
            >
              <Icon size={17} />
              <span>{navLabels[item.page]}</span>
            </button>
          );
        })}
      </nav>

      <div className="topbar-actions">
        <button className="language-button">
          <Languages size={17} />
          {t("rd.client.languageEnglish", { defaultValue: "English" })}
        </button>
        <button className="ghost-button" onClick={onLogin}>{t("rd.client.login", { defaultValue: "Login" })}</button>
        <button className="solid-button" onClick={onSignup}>{t("rd.client.createAccount", { defaultValue: "Create account" })}</button>
      </div>
    </header>
  );
}

// Damp low-review counts so a 4.9 with 4 reviews doesn't outrank a 4.8 with 126.
const REVIEW_DAMP = 25;
const weightedScore = (s: { rating: number; reviews: number }) =>
  s.rating * (s.reviews / (s.reviews + REVIEW_DAMP));

// Featured pick derives everything from the listings themselves — no header/city
// defaults. A real location / recently-searched-city signal can later replace the
// "popular city" step. Uses a plain object (not Map — that name is a lucide icon here).
function pickFeatured(list: Stay[]): { featured: Stay | null; rest: Stay[] } {
  if (list.length === 0) return { featured: null, rest: [] };
  const byCity: Record<string, { count: number; reviews: number }> = {};
  for (const s of list) {
    const agg = byCity[s.district] ?? { count: 0, reviews: 0 };
    agg.count += 1;
    agg.reviews += s.reviews;
    byCity[s.district] = agg;
  }
  let popularCity = list[0].district;
  let best = { count: -1, reviews: -1 };
  for (const city of Object.keys(byCity)) {
    const agg = byCity[city];
    if (agg.count > best.count || (agg.count === best.count && agg.reviews > best.reviews)) {
      best = agg;
      popularCity = city;
    }
  }
  const featured = list
    .filter((s) => s.district === popularCity)
    .reduce((a, b) => (weightedScore(b) > weightedScore(a) ? b : a));
  return { featured, rest: list.filter((s) => s.id !== featured.id) };
}

// Top pick by count-weighted rating — used for the "of the week" hero slots for
// services and transport (which aren't city-scoped like stays). `countOf`
// supplies the review/trip count that damps low-sample ratings.
function pickTop<T extends { rating: number }>(list: T[], countOf: (x: T) => number): T | null {
  if (list.length === 0) return null;
  return list.reduce((a, b) => {
    const sa = a.rating * (countOf(a) / (countOf(a) + REVIEW_DAMP));
    const sb = b.rating * (countOf(b) / (countOf(b) + REVIEW_DAMP));
    return sb > sa ? b : a;
  });
}

function DiscoveryPage({
  onNavigate,
  onOpenStay,
  onOpenService,
  onOpenTransport,
}: {
  onNavigate: (page: Page) => void;
  onOpenStay: (stay: Stay) => void;
  onOpenService: (service: Service) => void;
  onOpenTransport: (item: Transport) => void;
}) {
  // All three rails are real-data backed. We deliberately do NOT swap in
  // marketplace-mock content when the backend returns empty — masking an
  // empty DB with stock listings hides real onboarding problems and lets
  // testers click into demo IDs that don't exist. Empty rails render a
  // proper "no listings yet" message instead.
  const { t } = useLanguage();
  // Global location scope over the rails. When a scope is active we fetch a
  // deeper pool (the first 8 newest rows may all sit in other cities) and
  // trim back to rail size after filtering; the unscoped default path is
  // unchanged.
  const { scope: locationScope } = useLocationScope();
  const railLimit = locationScope ? 60 : 8;
  const RAIL_SIZE = 8;
  const { data: staysRaw, isLoading: staysLoading, error: staysError } = useMarketplaceStays({ limit: railLimit });
  const { data: servicesRaw, isLoading: servicesLoading, error: servicesError } = useMarketplaceServices({ limit: railLimit });
  const { data: transportRaw, isLoading: transportLoading, error: transportError } = useMarketplaceTransport({ limit: railLimit });
  const stays = useMemo(() => staysRaw
    .filter((stay) => matchesLocationScope(locationScope, { lat: stay.lat, lng: stay.lng, adminTexts: [stay.district, stay.city, stay.location] }))
    .slice(0, RAIL_SIZE), [staysRaw, locationScope]);
  const services = useMemo(() => servicesRaw
    .filter((service) => matchesLocationScope(locationScope, { lat: service.lat, lng: service.lng, adminTexts: [service.city, service.location] }))
    .slice(0, RAIL_SIZE), [servicesRaw, locationScope]);
  const transport = useMemo(() => transportRaw
    .filter((item) => matchesLocationScope(locationScope, { lat: item.lat, lng: item.lng, adminTexts: [item.area, item.city] }))
    .slice(0, RAIL_SIZE), [transportRaw, locationScope]);
  // Empty rails read differently while narrowed: "nothing published yet"
  // would be a lie when the DB has rows outside the scope.
  const narrowed = !!locationScope;
  const narrowedEmpty = (
    <RailMessage>
      {t("rd.client.railEmptyScoped", { place: locationScope?.label, defaultValue: "Nothing here near {{place}} yet — clear the location to see everything." })}
    </RailMessage>
  );
  const { featured } = useMemo(() => pickFeatured(stays), [stays]);
  const featuredService = useMemo(() => pickTop(services, (s) => s.reviews), [services]);
  const featuredTransport = useMemo(() => pickTop(transport, (item) => item.trips), [transport]);
  return (
    <>
      <section className="discovery-feed">
        <div className="feed-header">
          <div>
            <p className="eyebrow"><Compass size={16} /> {t("rd.client.discoveryEyebrow", { defaultValue: "Discovery" })}</p>
            <h1>{t("rd.client.discoveryHeading", { defaultValue: "Nearby, trending, and ready to book." })}</h1>
          </div>
          {/* Discovery is a multi-rail overview — Near-me belongs on the
              focused list pages (stays / services / transport) where there's
              a single grid to sort. Filters live there too. */}
        </div>

        {/* No search bar here — Discovery is a curated multi-rail overview;
            keyword search lives on the vertical pages and the navbar's
            Search-everything palette. Only the location-scope chip renders,
            confirming why the rails are narrowed. */}
        <div className="context-strip">
          <LocationScopeChip />
        </div>

        {(featured || featuredService || featuredTransport) && (
          <FeaturedCarousel
            stay={featured}
            service={featuredService}
            transport={featuredTransport}
            onOpenStay={onOpenStay}
            onOpenService={onOpenService}
            onOpenTransport={onOpenTransport}
          />
        )}

        {servicesLoading && services.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railServicesEyebrow", { defaultValue: "Services" })}
            title={t("rd.client.railServicesTitle", { defaultValue: "Appointments available nearby" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("services")}
          >
            <RailSkeleton count={3} />
          </HorizontalRail>
        ) : servicesError && services.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railServicesEyebrow", { defaultValue: "Services" })}
            title={t("rd.client.railServicesTitle", { defaultValue: "Appointments available nearby" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("services")}
          >
            <RailMessage>{t("rd.client.railServicesError", { defaultValue: "Couldn't load services right now." })}</RailMessage>
          </HorizontalRail>
        ) : services.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railServicesEyebrow", { defaultValue: "Services" })}
            title={t("rd.client.railServicesTitle", { defaultValue: "Appointments available nearby" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("services")}
          >
            {narrowed ? narrowedEmpty : <RailMessage>{t("rd.client.railServicesEmpty", { defaultValue: "No services published yet. Be the first to list one." })}</RailMessage>}
          </HorizontalRail>
        ) : (
          <Carousel
            eyebrow={t("rd.client.railServicesEyebrow", { defaultValue: "Services" })}
            title={t("rd.client.railServicesTitle", { defaultValue: "Appointments available nearby" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("services")}
            perView={3}
            staggerMs={0}
            items={services.map((service) => (
              <DiscoveryServiceTile
                key={service.id}
                service={service}
                onClick={() => onOpenService(service)}
              />
            ))}
          />
        )}

        {transportLoading && transport.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railTransportEyebrow", { defaultValue: "Local transport" })}
            title={t("rd.client.railTransportTitle", { defaultValue: "Drivers, rentals, and temple packages" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("transport")}
          >
            <RailSkeleton count={3} />
          </HorizontalRail>
        ) : transportError && transport.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railTransportEyebrow", { defaultValue: "Local transport" })}
            title={t("rd.client.railTransportTitle", { defaultValue: "Drivers, rentals, and temple packages" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("transport")}
          >
            <RailMessage>{t("rd.client.railTransportError", { defaultValue: "Couldn't load transport right now." })}</RailMessage>
          </HorizontalRail>
        ) : transport.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railTransportEyebrow", { defaultValue: "Local transport" })}
            title={t("rd.client.railTransportTitle", { defaultValue: "Drivers, rentals, and temple packages" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("transport")}
          >
            {narrowed ? narrowedEmpty : <RailMessage>{t("rd.client.railTransportEmpty", { defaultValue: "No transport options published yet." })}</RailMessage>}
          </HorizontalRail>
        ) : (
          <Carousel
            eyebrow={t("rd.client.railTransportEyebrow", { defaultValue: "Local transport" })}
            title={t("rd.client.railTransportTitle", { defaultValue: "Drivers, rentals, and temple packages" })}
            action={t("rd.client.viewAll", { defaultValue: "View all" })}
            onAction={() => onNavigate("transport")}
            perView={3}
            staggerMs={3000}
            items={transport.map((item) => (
              <DiscoveryTransportTile
                key={item.id}
                item={item}
                onClick={() => onOpenTransport(item)}
              />
            ))}
          />
        )}

        {staysLoading && stays.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railStaysEyebrow", { defaultValue: "Stays near you" })}
            title={t("rd.client.carouselStaysTitle", { defaultValue: "More booming properties" })}
            action={t("rd.client.railStaysAction", { defaultValue: "View all stays" })}
            onAction={() => onNavigate("stays")}
          >
            <RailSkeleton count={3} />
          </HorizontalRail>
        ) : staysError ? (
          <HorizontalRail
            eyebrow={t("rd.client.railStaysEyebrow", { defaultValue: "Stays near you" })}
            title={t("rd.client.carouselStaysTitle", { defaultValue: "More booming properties" })}
            action={t("rd.client.railStaysAction", { defaultValue: "View all stays" })}
            onAction={() => onNavigate("stays")}
          >
            <RailMessage>{t("rd.client.railStaysError", { defaultValue: "Couldn't load stays right now." })}</RailMessage>
          </HorizontalRail>
        ) : stays.length === 0 ? (
          <HorizontalRail
            eyebrow={t("rd.client.railStaysEyebrow", { defaultValue: "Stays near you" })}
            title={t("rd.client.carouselStaysTitle", { defaultValue: "More booming properties" })}
            action={t("rd.client.railStaysAction", { defaultValue: "View all stays" })}
            onAction={() => onNavigate("stays")}
          >
            {narrowed ? narrowedEmpty : <RailMessage>{t("rd.client.railStaysEmpty", { defaultValue: "No stays published yet. Be the first to host." })}</RailMessage>}
          </HorizontalRail>
        ) : (
          <>
            {stays.length > 0 && (
              <Carousel
                eyebrow={t("rd.client.railStaysEyebrow", { defaultValue: "Stays near you" })}
                title={t("rd.client.carouselStaysTitle", { defaultValue: "More booming properties" })}
                action={t("rd.client.viewAll", { defaultValue: "View all" })}
                onAction={() => onNavigate("stays")}
                perView={4}
                staggerMs={6000}
                items={stays.map((stay, index) => (
                  <DiscoveryStayTile
                    key={stay.id}
                    stay={stay}
                    rank={index + 1}
                    onClick={() => onOpenStay(stay)}
                  />
                ))}
              />
            )}
          </>
        )}
      </section>

      <PartnerBand />
    </>
  );
}

type FeaturedSlide = {
  key: string;
  image: string;
  alt: string;
  badge: ReactNode;
  eyebrow: string;
  rating: ReactNode;
  title: string;
  sub: ReactNode;
  tags: string[];
  price: ReactNode;
  cta: string;
  onOpen: () => void;
};

// Rotating "… of the week" hero: cycles Stay / Service / Transport picks, each
// rendered in the same featured layout. Auto-advances (paused on hover) with
// prev/next arrows and dots.
function FeaturedCarousel({
  stay,
  service,
  transport,
  onOpenStay,
  onOpenService,
  onOpenTransport,
}: {
  stay: Stay | null;
  service: Service | null;
  transport: Transport | null;
  onOpenStay: (stay: Stay) => void;
  onOpenService: (service: Service) => void;
  onOpenTransport: (item: Transport) => void;
}) {
  const { t } = useLanguage();
  const slides: FeaturedSlide[] = [];
  if (service) {
    slides.push({
      key: "service",
      image: service.image,
      alt: service.title,
      badge: <><Star size={13} fill="#f5b301" color="#f5b301" /> {t("rd.client.featuredBadge", { defaultValue: "#1 booming this week" })}</>,
      eyebrow: t("rd.client.serviceOfTheWeek", { defaultValue: "Service of the week" }),
      rating: (
        <>
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {service.rating}</strong>
          <span>{t("rd.client.reviewsCount", { defaultValue: "{{count}} reviews", count: service.reviews })}</span>
          <span>{serviceModeLabel(service, t)}</span>
        </>
      ),
      title: service.title,
      sub: <><MapPin size={15} /> {service.location} · {service.duration}</>,
      tags: [],
      price: <>Rs. {service.price.toLocaleString()}</>,
      cta: t("rd.client.bookThisService", { defaultValue: "Book this service" }),
      onOpen: () => onOpenService(service),
    });
  }
  if (transport) {
    slides.push({
      key: "transport",
      image: transport.image,
      alt: transport.vehicle,
      badge: <><Star size={13} fill="#f5b301" color="#f5b301" /> {t("rd.client.featuredBadge", { defaultValue: "#1 booming this week" })}</>,
      eyebrow: t("rd.client.transportOfTheWeek", { defaultValue: "Transport of the week" }),
      rating: (
        <>
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {transport.rating}</strong>
          <span>{t("rd.client.tripsCount", { defaultValue: "{{count}} trips", count: transport.trips.toLocaleString() })}</span>
        </>
      ),
      title: transport.driver,
      sub: transport.vehicle,
      tags: transportModeTags(transport, t).slice(0, 3),
      price: headlineTransportRate(transport, t),
      cta: t("rd.client.bookThisTransport", { defaultValue: "Book this ride" }),
      onOpen: () => onOpenTransport(transport),
    });
  }
  if (stay) {
    slides.push({
      key: "stay",
      image: stay.image,
      alt: stay.title,
      badge: <><Star size={13} fill="#f5b301" color="#f5b301" /> {t("rd.client.featuredBadge", { defaultValue: "#1 booming this week" })}</>,
      eyebrow: t("rd.client.stayOfTheWeek", { defaultValue: "Stay of the week" }),
      rating: (
        <>
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {stay.rating}</strong>
          <span>{t("rd.client.reviewsCount", { defaultValue: "{{count}} reviews", count: stay.reviews })}</span>
          {stay.verified && <span className="verified"><BadgeCheck size={14} /> {t("rd.client.verified", { defaultValue: "Verified" })}</span>}
        </>
      ),
      title: stay.title,
      sub: <><MapPin size={15} /> {t("rd.client.featuredHostLine", { defaultValue: "{{location}}, {{district}} · {{owner}} hosts", ...placeParts(stay.location, stay.district), owner: stay.owner })}</>,
      tags: stay.tags,
      price: <>Rs. {stay.price.toLocaleString()}<small>{t("rd.client.perNight", { defaultValue: "/night" })}</small></>,
      cta: t("rd.client.bookThisStay", { defaultValue: "Book this stay" }),
      onOpen: () => onOpenStay(stay),
    });
  }

  const n = slides.length;
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (n <= 1 || paused) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % n), 6000);
    return () => clearInterval(id);
  }, [n, paused]);
  if (n === 0) return null;
  const safeIdx = idx % n;
  const slide = slides[safeIdx];
  const go = (delta: number) => setIdx((i) => (i + delta + n) % n);

  return (
    <section
      className="featured-stay"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <button className="featured-media" onClick={slide.onOpen} aria-label={slide.alt}>
        {/* Blurred copy fills the letterbox bands so a "contain" (uncropped)
            foreground image never floats in empty space. */}
        <img className="featured-media-bg" src={slide.image} alt="" aria-hidden="true" decoding="async" />
        <img
          className="featured-media-fg"
          src={slide.image}
          alt={slide.alt}
          decoding="async"
          /* Hint the browser to prioritise the LCP hero. react-dom 18.3 doesn't
             map the camelCase `fetchPriority` prop, so emit the real lowercase
             HTML attribute (no console warning; ignored where unsupported). */
          {...({ fetchpriority: "high" } as Record<string, string>)}
        />
        <span className="featured-badge">{slide.badge}</span>
      </button>
      <div className="featured-panel">
        <div className="featured-eyebrow-row">
          <p className="rail-eyebrow">{slide.eyebrow}</p>
          {n > 1 && (
            <div className="featured-nav">
              <button onClick={() => go(-1)} aria-label={t("rd.client.carouselPrev", { defaultValue: "Previous" })}><ChevronLeft size={16} /></button>
              <div className="featured-dots">
                {slides.map((s, i) => (
                  <button
                    key={s.key}
                    className={i === safeIdx ? "active" : ""}
                    onClick={() => setIdx(i)}
                    aria-label={s.eyebrow}
                  />
                ))}
              </div>
              <button onClick={() => go(1)} aria-label={t("rd.client.carouselNext", { defaultValue: "Next" })}><ChevronRight size={16} /></button>
            </div>
          )}
        </div>
        <div className="rating-line">{slide.rating}</div>
        <h2>{slide.title}</h2>
        <p className="featured-loc">{slide.sub}</p>
        {slide.tags.length > 0 && (
          <div className="tag-row">
            {slide.tags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        )}
        <div className="featured-footer">
          <strong className="featured-price">{slide.price}</strong>
          <button className="book-button" onClick={slide.onOpen}>
            {slide.cta} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

/** How many cards fit per carousel page at the current window width. Caps the
 *  row's designed perView (3 for services/transport, 4 for stays) so cards
 *  keep a sane width when the window shrinks instead of cramming N abreast.
 *  On wide monitors (≥1440px, where the 1500px feed shell is fully open) each
 *  rail gains one extra card so the row uses the width instead of inflating
 *  the same three cards. */
function useResponsivePerView(base: number) {
  const forWidth = (w: number) => {
    if (w < 560) return 1;
    if (w < 900) return Math.min(base, 2);
    if (w < 1200) return Math.min(base, 3);
    if (w >= 1440) return base + 1;
    return base;
  };
  const [perView, setPerView] = useState(() =>
    typeof window === "undefined" ? base : forWidth(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setPerView(forWidth(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  return perView;
}

function Carousel({
  eyebrow,
  title,
  action,
  onAction,
  perView: basePerView = 3,
  items,
  staggerMs = 0,
}: {
  eyebrow: string;
  title: string;
  action?: string;
  onAction?: () => void;
  perView?: number;
  items: ReactNode[];
  /** Phase offset for auto-advance so sibling carousels never slide in
   *  unison — the discovery page passes 0 / 3000 / 6000 to its three rails. */
  staggerMs?: number;
}) {
  const { t } = useLanguage();
  const perView = useResponsivePerView(basePerView);
  // Arrows/dots/autoplay appear once there are more cards than fit in one
  // view — stays (perView 4) at 5+, services/transport (perView 3) at 4+.
  // A single-page row uses the same markup, just without controls.
  const n = items.length;
  const pages = Math.max(1, Math.ceil(n / perView));
  const showControls = pages > 1;

  // Circular carousel. The track is translated by a CELL offset (not a page
  // index): real cells sit at offsets 0..n-1 and the first perView items are
  // cloned after them, so the last page wrap-fills with the first listings
  // instead of showing blank space (8 items / 3 per view → last page is
  // [7, 8, 1]). Offset n is the cloned copy of page one; sliding there and
  // then snapping (transition disabled) back to 0 makes next() loop
  // seamlessly. prev() from 0 does the same jump in reverse.
  const [offset, setOffset] = useState(0);
  const [animate, setAnimate] = useState(true);
  const [paused, setPaused] = useState(false);
  const lastStart = (pages - 1) * perView;
  const activeDot = offset >= n ? 0 : Math.min(pages - 1, Math.floor(offset / perView));

  // Two frames so the transition-less position commits to the DOM before
  // transitions come back on — one rAF can land in the same paint.
  const enableAnimateSoon = () =>
    requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)));

  const next = () => {
    setAnimate(true);
    setOffset((o) => (o >= n ? o : o >= lastStart ? n : Math.min(o + perView, lastStart)));
  };
  const prev = () => {
    if (offset === 0) {
      setAnimate(false);
      setOffset(n);
      enableAnimateSoon();
      requestAnimationFrame(() => requestAnimationFrame(() => setOffset(lastStart)));
    } else {
      setAnimate(true);
      setOffset((o) => Math.max(0, Math.min(o, lastStart) - perView));
    }
  };
  const goToPage = (p: number) => {
    setAnimate(true);
    setOffset(Math.min(p * perView, lastStart));
  };

  // Landed on the cloned first page — swap to the real one while nothing is
  // moving. Guard on target/property so bubbling tile hover transitions and
  // mid-flight offsets don't trigger the snap.
  const snapToStart = () => {
    setAnimate(false);
    setOffset(0);
    enableAnimateSoon();
  };
  const onTrackTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
    if (offset >= n) snapToStart();
  };
  // Fallback for the snap: transitionend can be missed (backgrounded tab
  // freezes the animation clock, or the transition gets interrupted), which
  // would wedge the track on the clone page. The timer is cleared as soon as
  // offset leaves the clone position, so the two mechanisms can't double-fire.
  // 460ms ≈ the .carousel-track transition (420ms) plus a frame of slack.
  useEffect(() => {
    if (offset < n) return;
    const id = setTimeout(snapToStart, 460);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, n]);

  // Resize (perView change) or a data refetch invalidates the offset — reset
  // to the start without animating the track across the whole row.
  useEffect(() => {
    setAnimate(false);
    setOffset(0);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)));
    return () => cancelAnimationFrame(id);
  }, [perView, n]);

  // Auto-advance: pause while hovered, skip entirely for reduced-motion
  // users. A 9s period + per-carousel `staggerMs` phase keeps the three
  // discovery rails from all sliding at the same instant (which read as
  // "too much" motion) — at any moment at most one section is moving.
  useEffect(() => {
    if (!showControls || paused) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const PERIOD_MS = 9000;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const advance = () => {
      setAnimate(true);
      setOffset((o) => (o >= n ? o : o >= lastStart ? n : Math.min(o + perView, lastStart)));
    };
    const timeoutId = setTimeout(() => {
      advance();
      intervalId = setInterval(advance, PERIOD_MS);
    }, PERIOD_MS + staggerMs);
    return () => { clearTimeout(timeoutId); if (intervalId) clearInterval(intervalId); };
  }, [showControls, paused, n, perView, lastStart, staggerMs]);

  return (
    <section
      className="carousel-section"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="rail-heading">
        <div>
          <p>{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <div className="rail-heading-actions">
          {action && (
            <button className="rail-action" onClick={onAction}>
              {action}
              <ArrowRight size={16} />
            </button>
          )}
          {showControls && (
            <div className="carousel-arrows">
              <button onClick={prev} aria-label={t("rd.client.carouselPrev", { defaultValue: "Previous" })}><ChevronLeft size={18} /></button>
              <button onClick={next} aria-label={t("rd.client.carouselNext", { defaultValue: "Next" })}><ChevronRight size={18} /></button>
            </div>
          )}
        </div>
      </div>
      {/* Single layout path regardless of item count. There used to be a
          separate static-grid branch for rows that fit in one view; the
          carousel branch then only ever ran once the DB had enough listings,
          so its layout bugs shipped unnoticed. A one-page carousel renders
          identically to the old grid (track doesn't translate, controls
          hidden), so the fork bought nothing but divergence. */}
      <div className="carousel-viewport">
        <div
          className="carousel-track"
          style={{
            transform: `translateX(-${(offset * 100) / perView}%)`,
            transition: animate ? undefined : "none",
          }}
          onTransitionEnd={onTrackTransitionEnd}
        >
          {items.map((item, index) => (
            <div className="carousel-cell" style={{ flex: `0 0 ${100 / perView}%` }} key={index}>
              {item}
            </div>
          ))}
          {/* Clones of the leading items so the loop can wrap without blank
              cells. Fully interactive on purpose — the cloned card carries the
              original onClick, so tapping it during the wrap still opens the
              right listing. Only rendered when the row actually pages. */}
          {showControls &&
            items.slice(0, perView).map((item, index) => (
              <div className="carousel-cell" style={{ flex: `0 0 ${100 / perView}%` }} key={`clone-${index}`}>
                {item}
              </div>
            ))}
        </div>
      </div>
      {showControls && (
        <div className="carousel-dots">
          {Array.from({ length: pages }).map((_, index) => (
            <button
              key={index}
              className={index === activeDot ? "active" : ""}
              onClick={() => goToPage(index)}
              aria-label={t("rd.client.carouselGoToSlide", { defaultValue: "Go to slide {{n}}", n: index + 1 })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function HorizontalRail({
  eyebrow,
  title,
  action,
  onAction,
  children,
}: {
  eyebrow: string;
  title: string;
  action: string;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <section className="horizontal-rail">
      <div className="rail-heading">
        <div>
          <p>{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <button className="rail-action" onClick={onAction}>
          {action}
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="rail-scroller">{children}</div>
    </section>
  );
}

function DiscoveryStayTile({ stay, rank, onClick }: { stay: Stay; rank: number; onClick: () => void }) {
  const { t } = useLanguage();
  return (
    <button className="discovery-tile stay-tile" onClick={onClick}>
      <img src={stay.image} alt={stay.title} loading="lazy" decoding="async" />
      <span className="rank-badge">{t("rd.client.rankBooming", { defaultValue: "#{{rank}} booming", rank })}</span>
      <div className="tile-content">
        <div className="rating-line">
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {stay.rating}</strong>
          <span>{t("rd.client.reviewsCount", { defaultValue: "{{count}} reviews", count: stay.reviews })}</span>
        </div>
        <h3 className="one-line">{stay.title}</h3>
        <p><MapPin size={14} /> <span className="one-line">{placeLine(stay.location, stay.district)}</span></p>
        <div className="tile-footer">
          <span>{stay.type}</span>
          <strong>Rs. {stay.price.toLocaleString()}<small>{t("rd.client.perNight", { defaultValue: "/night" })}</small></strong>
        </div>
      </div>
    </button>
  );
}

function serviceModeLabel(service: Service, t: TFunc): string {
  const primary = service.mode && service.mode.length > 0 ? service.mode[0] : "at-home";
  if (primary === "online") return t("rd.client.modeOnline", { defaultValue: "Online" });
  if (primary === "visit-provider") return t("rd.client.modeVisit", { defaultValue: "Visit" });
  return t("rd.client.modeAtHome", { defaultValue: "At home" });
}

function DiscoveryServiceTile({ service, onClick }: { service: Service; onClick: () => void }) {
  const { t } = useLanguage();
  const Icon = service.icon;
  return (
    <button className="discovery-tile service-tile" onClick={onClick}>
      <img src={service.image} alt={service.title} loading="lazy" decoding="async" />
      <span className="rank-badge"><Icon size={13} /> {service.category}</span>
      <div className="tile-content">
        <div className="rating-line">
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {service.rating}</strong>
          <span>{t("rd.client.reviewsCount", { defaultValue: "{{count}} reviews", count: service.reviews })}</span>
          <span>{serviceModeLabel(service, t)}</span>
        </div>
        <h3 className="one-line">{service.title}</h3>
        <p><MapPin size={14} /> <span className="one-line">{service.location} · {service.duration}</span></p>
        <div className="tile-footer">
          <span>{t("rd.client.fromLabel", { defaultValue: "from" })}</span>
          <strong>Rs. {service.price.toLocaleString()}</strong>
        </div>
      </div>
    </button>
  );
}

/** One-line transport rate label that adapts to whatever the operator has
 *  actually priced. Prefers the listing's primary transportMode, then any
 *  populated rate, then falls back to "Pricing on request". Avoids ever
 *  rendering "Rs. 0/km". */
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

function headlineTransportRate(item: Transport, t: TFunc): string {
  if (item.transportMode === "hourly" && item.hourly > 0) return t("rd.client.ratePerHour", { defaultValue: "Rs. {{amount}}/hr", amount: item.hourly });
  if (item.transportMode === "day" && item.day > 0) return t("rd.client.ratePerDay", { defaultValue: "Rs. {{amount}}/day", amount: item.day.toLocaleString() });
  if (item.transportMode === "package" && item.packageOptions.length > 0) {
    const cheapest = Math.min(...item.packageOptions.map((p) => p.price).filter((p) => p > 0));
    if (Number.isFinite(cheapest)) return t("rd.client.rateFrom", { defaultValue: "from Rs. {{amount}}", amount: cheapest.toLocaleString() });
  }
  if (item.hourly > 0) return t("rd.client.ratePerHour", { defaultValue: "Rs. {{amount}}/hr", amount: item.hourly });
  if (item.day > 0) return t("rd.client.ratePerDay", { defaultValue: "Rs. {{amount}}/day", amount: item.day.toLocaleString() });
  if (item.packageOptions.length > 0) {
    const cheapest = Math.min(...item.packageOptions.map((p) => p.price).filter((p) => p > 0));
    if (Number.isFinite(cheapest)) return t("rd.client.rateFrom", { defaultValue: "from Rs. {{amount}}", amount: cheapest.toLocaleString() });
  }
  if (item.perKm > 0) return t("rd.client.ratePerKm", { defaultValue: "Rs. {{amount}}/km", amount: item.perKm });
  return t("rd.client.rateOnRequest", { defaultValue: "On request" });
}

/** Tags describing how a transport listing can be booked. Package/tour
 *  listings keep their real tour names (e.g. "Hyderabad Tour"); hourly and
 *  day-rental modes get a generic mode label so every card surfaces at least
 *  one tag — previously only tour listings did. "point" is beta/gated in the
 *  booking UI and intentionally omitted. Mode set comes from the driver's
 *  multi-select (`transportModes`); legacy single-mode rows fall back to
 *  inferring from which prices/packages are populated. */
function transportModeTags(item: Transport, t: TFunc): string[] {
  const modes: TransportMode[] = item.transportModes && item.transportModes.length > 0
    ? item.transportModes
    : ([
        item.packageOptions.length > 0 ? "package" : null,
        item.hourly > 0 ? "hourly" : null,
        item.day > 0 ? "day" : null,
      ].filter(Boolean) as TransportMode[]);
  const tags: string[] = [];
  if (modes.includes("package")) {
    const tourNames = item.packages.length > 0
      ? item.packages
      : item.packageOptions.map((p) => p.label).filter(Boolean);
    tags.push(...(tourNames.length > 0 ? tourNames : [t("rd.client.tagTour", { defaultValue: "Tour" })]));
  }
  if (modes.includes("hourly")) tags.push(t("rd.client.tagHourly", { defaultValue: "Hourly" }));
  if (modes.includes("day")) tags.push(t("rd.client.tagDayRental", { defaultValue: "Day rental" }));
  return tags;
}

function DiscoveryTransportTile({ item, onClick }: { item: Transport; onClick: () => void }) {
  const { t } = useLanguage();
  // Footer shows the available rates; the last one is emphasised on the right
  // (matching the km · day … / hr layout) and the rest sit on the left.
  const rateStrings = [
    item.perKm > 0 ? t("rd.client.ratePerKm", { defaultValue: "Rs. {{amount}}/km", amount: item.perKm }) : null,
    item.day > 0 ? t("rd.client.ratePerDay", { defaultValue: "Rs. {{amount}}/day", amount: item.day.toLocaleString() }) : null,
    item.hourly > 0 ? t("rd.client.ratePerHour", { defaultValue: "Rs. {{amount}}/hr", amount: item.hourly }) : null,
  ].filter(Boolean) as string[];
  const rightRate = rateStrings.length > 0 ? rateStrings[rateStrings.length - 1] : headlineTransportRate(item, t);
  const leftRate = rateStrings.slice(0, -1).join(" · ");
  return (
    <button className="discovery-tile transport-tile" onClick={onClick}>
      <img src={item.image} alt={item.vehicle} loading="lazy" decoding="async" />
      <span className="rank-badge"><Car size={13} /> {item.type}</span>
      <div className="tile-content">
        <div className="rating-line">
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {item.rating}</strong>
          <span>{t("rd.client.tripsCount", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString() })}</span>
        </div>
        <h3 className="one-line">{item.driver}</h3>
        <p><span className="one-line">{item.vehicle}</span></p>
        <div className="tag-row compact">
          {transportModeTags(item, t).slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
        </div>
        <div className="tile-footer">
          {leftRate && <span>{leftRate}</span>}
          <strong>{rightRate}</strong>
        </div>
      </div>
    </button>
  );
}

/**
 * Apply marketplace filter params from the URL onto a page's local filter
 * state. Used by Stays/Services/Transport so the assistant's `search` /
 * `apply_filters` actions (and any shared deep-link) actually filter the
 * grid instead of landing on an unfiltered feed — previously these pages
 * read no URL params at all, so those navigations were silently dead.
 *
 * Only PRESENT params are applied, so navigating to a bare `/explore` never
 * destructively resets filters the user set by hand. Re-runs whenever the
 * URL params change, so the assistant can re-filter a page the user is
 * already viewing without a remount.
 */
function useUrlFilterSync<F extends { priceMax: number; ratingMin: number }>(
  setSearch: (v: string) => void,
  setFilters: (updater: (prev: F) => F) => void,
): void {
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const q = searchParams.get("q") ?? searchParams.get("location") ?? searchParams.get("city");
    if (q != null && q !== "") setSearch(q);
    const num = (raw: string | null): number | null => {
      if (raw == null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const priceMax = num(searchParams.get("maxPrice"));
    const ratingMin = num(searchParams.get("minRating"));
    if (priceMax != null || ratingMin != null) {
      setFilters((prev) => ({
        ...prev,
        ...(priceMax != null ? { priceMax } : {}),
        ...(ratingMin != null ? { ratingMin } : {}),
      }));
    }
    // Intentionally keyed only on the URL params — the setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
}

/**
 * Subscribe the active marketplace sub-page to the assistant bus so Ista AI
 * can filter the page IN PLACE (chips move, grid updates) while the chat
 * panel stays open — instead of navigating away. Mirrors useUrlFilterSync's
 * field mapping; only applies intents for THIS page's category (or
 * category-less intents) and reports back whether it acted, so the widget can
 * fall back to navigation when the targeted page isn't the one on screen.
 */
function useMarketplaceAgentFilters<F extends { priceMax: number; ratingMin: number; types?: string[]; categories?: string[] }>(
  category: "stay" | "service" | "transport",
  setSearch: (v: string) => void,
  setFilters: (updater: (prev: F) => F) => void,
  extras?: {
    /** Services: drive the top-level At home / Visit / Online tab. */
    onServiceMode?: (m: ServiceMode) => void;
    /** Transport: drive the top-level Hourly / Day / Package tab. */
    onTransportMode?: (m: TransportMode) => void;
  },
): void {
  useEffect(() => {
    const unsubscribe = marketplaceAgentBus.subscribe((intent) => {
      if (intent.type !== "apply_filters") return false;
      if (intent.category && intent.category !== category) return false;
      let applied = false;
      if (typeof intent.q === "string" && intent.q !== "") {
        setSearch(intent.q);
        applied = true;
      }
      // Top-level mode tabs — the big toggle the user actually sees move.
      if (category === "service" && intent.serviceMode && extras?.onServiceMode) {
        extras.onServiceMode(intent.serviceMode);
        applied = true;
      }
      if (category === "transport" && intent.transportMode && extras?.onTransportMode) {
        extras.onTransportMode(intent.transportMode);
        applied = true;
      }
      const wantsFilterChange =
        typeof intent.maxPrice === "number" ||
        typeof intent.minRating === "number" ||
        (category === "stay" && !!intent.types?.length) ||
        (category === "service" && !!intent.subcategories?.length);
      if (wantsFilterChange) {
        setFilters((prev) => ({
          ...prev,
          ...(typeof intent.maxPrice === "number" ? { priceMax: intent.maxPrice } : {}),
          ...(typeof intent.minRating === "number" ? { ratingMin: intent.minRating } : {}),
          ...(category === "stay" && intent.types?.length ? { types: intent.types } : {}),
          ...(category === "service" && intent.subcategories?.length ? { categories: intent.subcategories } : {}),
        }));
        applied = true;
      }
      return applied;
    });
    return unsubscribe;
    // Subscription identity only depends on the page category; the setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);
}

/** Confirmatory chip shown on each marketplace page while the global
 *  location scope (picked in the navbar's Search-everything palette) is
 *  active — makes it obvious WHY the grid is narrowed and offers an inline
 *  clear without reaching back up to the navbar pill. Styled as an ACTIVE
 *  pill (same dark gradient as the selected mode chips) so it reads as the
 *  one filter currently applied — in contrast to the faded recent-search
 *  recall chips it shares the context strip with. */
function LocationScopeChip() {
  const { scope, setScope } = useLocationScope();
  const { t } = useLanguage();
  if (!scope) return null;
  return (
    <span className="scope-chip">
      <MapPin size={14} />
      {t("rd.client.scopedTo", { place: scope.label, defaultValue: "Near {{place}}" })}
      <button
        type="button"
        aria-label={t("globalSearch.clearScope", { defaultValue: "Clear location" })}
        onClick={() => setScope(null)}
        className="scope-chip-clear"
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** Recall chips shared by the three marketplace pages — rendered under the
 *  toolbar when the category has recents. `label` lets stays compose its
 *  richer "place · dates · guests" text while services/transport show the
 *  plain query text. */
/** Chip-sized label for a recent search's single-day availability filter
 *  (services/transport) — "Sat, 19 Jul". */
function recentDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

/** Range-aware variant — "Sat, 19 Jul" for a single day, "19–22 Jul" for a
 *  same-month range, "29 Jul – 2 Aug" across months. Null when no start. */
function recentRangeLabel(dr: { start: string | null; end: string | null }): string | null {
  if (!dr.start) return null;
  if (!dr.end || dr.end === dr.start) return recentDayLabel(dr.start);
  const a = new Date(`${dr.start}T00:00:00`);
  const b = new Date(`${dr.end}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return recentDayLabel(dr.start);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const mon = (d: Date) => d.toLocaleDateString("en-IN", { month: "short" });
  return sameMonth
    ? `${a.getDate()}–${b.getDate()} ${mon(b)}`
    : `${a.getDate()} ${mon(a)} – ${b.getDate()} ${mon(b)}`;
}

function RecentSearchChips({
  recents,
  label,
  onApply,
  onRemove,
  onClear,
}: {
  recents: RecentSearch[];
  label: (r: RecentSearch) => string;
  onApply: (r: RecentSearch) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useLanguage();
  if (recents.length === 0) return null;
  return (
    <div className="recent-searches">
      <span className="recent-searches-label">{t("rd.client.recentSearches", { defaultValue: "Recent searches" })}</span>
      {recents.map((r) => (
        <span key={r.id} className="recent-chip">
          <button type="button" className="recent-chip-main" onClick={() => onApply(r)}>
            <Clock3 size={13} /> {label(r)}
          </button>
          <button
            type="button"
            className="recent-chip-remove"
            aria-label={t("rd.client.removeRecent", { defaultValue: "Remove recent search" })}
            onClick={() => onRemove(r.id)}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="recent-clear" onClick={onClear}>
        {t("rd.client.clearRecents", { defaultValue: "Clear" })}
      </button>
    </div>
  );
}

function StaysPage({
  onNavigate,
  onOpenStay,
}: {
  onNavigate: (page: Page) => void;
  onOpenStay: (stay: Stay) => void;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  void onNavigate;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortValue>("recommended");
  const [filters, setFilters] = useState<StayFilters>(STAY_FILTER_DEFAULT);
  useUrlFilterSync<StayFilters>(setSearch, setFilters);
  useMarketplaceAgentFilters<StayFilters>("stay", setSearch, setFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Bidirectional hover — the same id powers the card highlight ring and
  // the map popup card. Hovering the card pushes into the map via
  // `highlightId`; hovering a marker pushes back via `onHoverChange`.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Mobile-only List/Map toggle (<lg). Desktop always shows the split, so this
  // is ignored there. "list" is the default so the first thing a phone user
  // sees is the results, not a full-bleed map.
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  // "Search as I move the map" — when on, the card list narrows to the stays
  // inside the current map viewport. Off by default so the map's initial
  // auto-fit / recenter never surprise-filters the list. `mapBounds` is kept
  // current from every settle so flipping the toggle on applies immediately.
  const [searchAsMove, setSearchAsMove] = useState(false);
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
  const [nearMe, setNearMe] = useState<LatLng | null>(null);
  const [nearMeLoading, setNearMeLoading] = useState(false);
  const [nearMeError, setNearMeError] = useState<string | null>(null);
  // Global location scope (navbar Search-everything palette) — narrows the
  // grid on top of everything else; the page's own picked place refines it.
  const { scope: locationScope } = useLocationScope();
  // Picked autocomplete suggestion (resolved to lat/lng + admin). Drives
  // the location filter below — when set we use distance + district
  // matching instead of the substring search needle, which fails as
  // soon as the input contains a comma-formatted "City, State, India".
  // `description` is stored alongside so we can detect when the user
  // edits the input away from the picked text (and invalidate the geo).
  const [pickedPlace, setPickedPlace] = useState<(PickedPlace & { description: string }) | null>(null);

  // Check-in → check-out date range. Log-only: it does NOT filter the stays
  // list — once the user completes a range we record it to the backend
  // (search_events / DynamoDB) and leave the results untouched.
  const [dateRange, setDateRange] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });
  const handleDateRangeChange = (next: { start: string | null; end: string | null }) => {
    setDateRange(next);
    if (next.start && next.end) {
      void getSearchEventsService().logDateRange({
        listingType: "stay",
        fromDate: next.start,
        toDate: next.end,
        context: {
          q: search || undefined,
          place: pickedPlace?.description || undefined,
          nearMe: nearMe ? true : undefined,
        },
      });
    }
  };

  const handlePickSuggestion = async (suggestion: { id: string; description: string }) => {
    if (!suggestion.id) return;
    const res = await apiRequest<{ result: PickedPlace | null }>("/api/geocode/place-details", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({ placeId: suggestion.id }),
    });
    if (res.success && res.data?.result) {
      setPickedPlace({ ...res.data.result, description: suggestion.description });
    }
  };

  // Drop the picked geo as soon as the search text no longer matches the
  // suggestion the user picked — typing or backspacing should revert the
  // search to plain substring matching against the new text.
  useEffect(() => {
    if (pickedPlace && pickedPlace.description !== search) setPickedPlace(null);
  }, [search, pickedPlace]);

  // Recent searches (place + dates + guests), persisted per-user to
  // localStorage. Auto-captured below; rendered as recall chips under the
  // toolbar. Separate from the search_events analytics logging.
  const { user } = useAuth();
  const { recents, record: recordRecent, remove: removeRecent, clear: clearRecents } = useRecentSearches("stays", user?.id);

  // Visible-result count for search_performed, snapshotted when the debounce
  // fires. A ref (assigned where `filtered` is computed below) rather than an
  // effect dep: the count must not reschedule the debounce, and by fire time
  // the first page has normally settled. Count-at-debounce-time semantics —
  // late-arriving pages are not re-reported.
  const resultCountRef = useRef(0);

  // Debounced auto-capture: once the user stops changing the search for a
  // moment, snapshot it into recents — but only when it's "meaningful" (a
  // picked place, a complete date range, or 3+ typed chars). The debounce is
  // what coalesces "Hyderabad" → "+ dates" → "+ guests" into one entry instead
  // of saving every intermediate keystroke. Dedup/cap live in the hook.
  useEffect(() => {
    const hasPlace = !!pickedPlace;
    const hasDates = !!(dateRange.start && dateRange.end);
    const hasText = search.trim().length >= 3;
    if (!hasPlace && !hasDates && !hasText) return;
    const timer = window.setTimeout(() => {
      recordRecent({
        search: hasPlace ? pickedPlace!.description : search.trim(),
        place: pickedPlace ? { ...pickedPlace } : null,
        dateRange: { start: dateRange.start, end: dateRange.end },
        minGuests: filters.minGuests,
      });
      getAnalyticsEventsService().track("search_performed", {
        listingType: "stay",
        source: "explore_stays",
        props: {
          hasPlace,
          hasDates,
          queryLength: search.trim().length,
          resultCount: resultCountRef.current,
          // Free-text term only (place-picked stay searches carry no keyword).
          ...(!hasPlace && search.trim().length >= 3 ? { q: search.trim().toLowerCase().slice(0, 60) } : {}),
          // Picked place at city/state granularity only (never coordinates) —
          // feeds the partner dashboards' "where customers search" panel.
          ...(hasPlace && (pickedPlace!.locality || pickedPlace!.district)
            ? { city: (pickedPlace!.locality || pickedPlace!.district)! }
            : {}),
          ...(hasPlace && pickedPlace!.state ? { state: pickedPlace!.state } : {}),
        },
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [pickedPlace, search, dateRange.start, dateRange.end, filters.minGuests, recordRecent]);

  // One-tap recall: restore every search input from the snapshot. The list +
  // the date-availability API call re-run off this state, so there's no
  // separate "execute" step. `search` is set alongside `place` so the
  // picked-place invalidation effect above doesn't drop the geo.
  const applyRecent = (r: RecentSearch) => {
    setSearch(r.search);
    setPickedPlace(r.place);
    setDateRange(r.dateRange);
    setFilters((f) => ({ ...f, minGuests: r.minGuests }));
  };

  const recentLabel = (r: RecentSearch): string => {
    const parts: string[] = [];
    const where = r.place?.locality || r.place?.district || r.place?.state || r.search.trim();
    if (where) parts.push(where);
    if (r.dateRange.start && r.dateRange.end) {
      const a = localDateFromIso(r.dateRange.start);
      const b = localDateFromIso(r.dateRange.end);
      const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
      parts.push(
        sameMonth
          ? `${a.getDate()}–${b.getDate()} ${b.toLocaleString("en-IN", { month: "short" })}`
          : `${a.getDate()} ${a.toLocaleString("en-IN", { month: "short" })} – ${b.getDate()} ${b.toLocaleString("en-IN", { month: "short" })}`,
      );
    }
    if (r.minGuests > 1) parts.push(t("rd.client.recentGuests", { defaultValue: "{{count}} guests", count: r.minGuests }));
    return parts.join(" · ");
  };

  const {
    data: stays,
    isLoading: staysLoading,
    error: staysError,
    refetch,
    fetchNextPage: fetchNextStays,
    hasNextPage: hasNextStays,
    isFetchingNextPage: isFetchingNextStays,
  } = useInfiniteMarketplaceStays({
    pageSize: 24,
    // A complete range narrows the list server-side (availability filter); a
    // lone check-in is ignored by the hook until check-out is also picked.
    from: dateRange.start ?? undefined,
    to: dateRange.end ?? undefined,
  });
  // Explore shows every result at once — no "Load more"/pagination. Keep
  // pulling pages from the cursor API until exhausted as soon as each lands.
  useEffect(() => {
    if (hasNextStays && !isFetchingNextStays) void fetchNextStays();
  }, [hasNextStays, isFetchingNextStays, fetchNextStays]);

  const handleNearMe = async () => {
    if (nearMe) { setNearMe(null); setNearMeError(null); return; }
    setNearMeLoading(true);
    setNearMeError(null);
    try {
      const pos = await getCurrentPosition();
      setNearMe(pos);
      const withCoords = stays.filter((s) => typeof s.lat === "number" && typeof s.lng === "number").length;
      if (withCoords === 0) {
        toast.info(t("rd.client.noPreciseLocation", { defaultValue: "No stays in this view have a precise location yet." }));
      } else {
        toast.success(t("rd.client.sortedByDistance", { defaultValue: "Sorted by distance from you." }));
      }
    } catch (err: any) {
      const message = err?.message || t("rd.client.locationError", { defaultValue: "Couldn't get your location." });
      setNearMeError(message);
      toast.error(message);
    } finally {
      setNearMeLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    // Normalize "Hotel" / "Village stay" / etc. (the chip labels) to the
    // hyphenated-lowercase form the backend stores in `property_type`
    // ("hotel", "village-stay"). Without this the chip filter never
    // matched anything — "Hotel" === "hotel" was false and the hotel
    // listings vanished from the grid.
    const normalizeType = (t: string) => t.trim().toLowerCase().replace(/\s+/g, "-");
    // For multi-room stays (hotel/lodge/heritage/sathram) the listing-level
    // `price` / `guests` / `rooms` describe the cheapest or aggregate room,
    // which makes single-value sliders too aggressive — picking "≥3 guests"
    // would drop a hotel whose cheapest room sleeps 2 even if it offers a
    // family suite that sleeps 4. The helpers below ask: "does ANY room
    // satisfy this bar?" and fall back to the listing-level field when the
    // stay has no room types (single-unit homestay).
    const anyRoomPriceAtMost = (stay: typeof stays[number], priceMax: number) => {
      const rooms = stay.roomTypes ?? [];
      if (rooms.length === 0) return stay.price <= priceMax;
      return rooms.some((r) => (r.price ?? 0) <= priceMax);
    };
    const anyRoomSleepsAtLeast = (stay: typeof stays[number], min: number) => {
      const rooms = stay.roomTypes ?? [];
      if (rooms.length === 0) return stay.guests >= min;
      return rooms.some((r) => (r.sleeps ?? 0) >= min);
    };
    const anyRoomBedroomsAtLeast = (stay: typeof stays[number], min: number) => {
      const rooms = stay.roomTypes ?? [];
      if (rooms.length === 0) return (stay.bedrooms ?? stay.rooms) >= min;
      return rooms.some((r) => (r.bedrooms ?? 0) >= min);
    };
    const anyRoomBathroomsAtLeast = (stay: typeof stays[number], min: number) => {
      const rooms = stay.roomTypes ?? [];
      if (rooms.length === 0) return (stay.bathrooms ?? 0) >= min;
      return rooms.some((r) => (r.bathrooms ?? 0) >= min);
    };

    const rows = stays
      // Global location scope first — everything below refines within it.
      .filter((stay) => matchesLocationScope(locationScope, {
        lat: stay.lat,
        lng: stay.lng,
        adminTexts: [stay.district, stay.city, stay.location],
      }))
      .filter((stay) => {
        // Empty selection (default) matches every type. Otherwise the stay's
        // property_type must match one of the picked chips. We normalize
        // both sides so chip labels ("Village stay") line up with backend
        // values ("village-stay").
        if (filters.types.length === 0) return true;
        const stayType = normalizeType(stay.type);
        return filters.types.some((t) => normalizeType(t) === stayType);
      })
      .filter((stay) => anyRoomPriceAtMost(stay, filters.priceMax))
      .filter((stay) => stay.rating >= filters.ratingMin)
      .filter((stay) => (filters.verifiedOnly ? stay.verified : true))
      .filter((stay) => anyRoomSleepsAtLeast(stay, filters.minGuests))
      .filter((stay) => (filters.minRooms === 0 ? true : anyRoomBedroomsAtLeast(stay, filters.minRooms)))
      .filter((stay) => (filters.minBaths === 0 ? true : anyRoomBathroomsAtLeast(stay, filters.minBaths)))
      .filter((stay) => {
        if (!filters.amenities.length) return true;
        // Union listing-level amenities with every room's amenities — multi-
        // room stays (hotel/lodge/heritage/sathram) author amenities per
        // room class, so a chip query like "AC" should match the property
        // if ANY room (or the listing fallback) advertises it. Lowercased
        // for case-insensitive matching, consistent with the existing
        // substring compare.
        const rooms = stay.roomTypes ?? [];
        const merged: string[] = [];
        (stay.amenities || []).forEach((a) => merged.push(a.toLowerCase()));
        rooms.forEach((r) => (r.amenities || []).forEach((a) => merged.push(a.toLowerCase())));
        if (merged.length === 0) return false;
        return filters.amenities.every((needle) => {
          const n = needle.toLowerCase();
          return merged.some((h) => h.includes(n));
        });
      })
      .filter((stay) => {
        // Picked-place filter wins over the substring search needle.
        // The substring approach fails as soon as the input becomes a
        // fully-qualified "City, State, India" string — no stay's
        // location text is going to contain that verbatim. Instead we
        // match by either physical distance (≤ 50 km — generous enough
        // to keep Tirumala→Tirupati ~22 km bookings visible) OR by
        // admin equivalence on the stay's `district` field.
        if (pickedPlace) {
          const hasCoords = typeof stay.lat === "number" && typeof stay.lng === "number";
          const within = hasCoords
            && distanceKm({ lat: pickedPlace.lat, lng: pickedPlace.lng }, { lat: stay.lat as number, lng: stay.lng as number })
              <= STAY_SEARCH_RADIUS_KM;
          const adminHit = adminMatches(stay.district, pickedPlace.locality)
            || adminMatches(stay.district, pickedPlace.district)
            || adminMatches(stay.location, pickedPlace.locality)
            || adminMatches(stay.location, pickedPlace.district);
          return within || adminHit;
        }
        if (!needle) return true;
        return [stay.title, stay.location, stay.district, stay.owner, ...stay.tags]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
    const sorted = [...rows];
    if (pickedPlace) {
      // Closest-to-picked-place first — same intent as Near me, just
      // anchored on the search target instead of the device location.
      const anchor = { lat: pickedPlace.lat, lng: pickedPlace.lng };
      sorted.sort((a, b) => distanceKm(anchor, { lat: a.lat, lng: a.lng }) - distanceKm(anchor, { lat: b.lat, lng: b.lng }));
    } else if (nearMe) {
      // Distance sort wins over the popover when Near me is active — missing
      // coords sink to the bottom via Infinity from distanceKm().
      sorted.sort((a, b) => distanceKm(nearMe, { lat: a.lat, lng: a.lng }) - distanceKm(nearMe, { lat: b.lat, lng: b.lng }));
    } else if (sort === "price-asc") sorted.sort((a, b) => a.price - b.price);
    else if (sort === "price-desc") sorted.sort((a, b) => b.price - a.price);
    else if (sort === "rating") sorted.sort((a, b) => b.rating - a.rating);
    return sorted;
  }, [filters, search, sort, stays, nearMe, pickedPlace, locationScope]);
  resultCountRef.current = filtered.length;

  // Build map markers for stays that ship with coordinates. Mock data has
  // these; real data adapters can populate `lat`/`lng` on MarketplaceStay
  // when the redesign moves off mocks. The `color` prop drives the warm-tan
  // accent for the price pills + popup highlight.
  const mapMarkers: MapMarker[] = useMemo(
    () => filtered
      .filter((stay) => typeof stay.lat === "number" && typeof stay.lng === "number")
      .map((stay) => ({
        id: String(stay.id),
        lat: stay.lat as number,
        lng: stay.lng as number,
        title: stay.title,
        subtitle: stay.type,
        price: `₹${stay.price.toLocaleString("en-IN")}`,
        image: stay.image,
        beds: stay.rooms,
        address: placeLine(stay.location, stay.district),
        color: "#8b5e4a",
        onClick: () => onOpenStay(stay),
      })),
    [filtered, onOpenStay],
  );

  // The card list narrows to the current map viewport when "search as I move
  // the map" is on. The MAP markers stay driven by `filtered` (the full result
  // set) so panning never re-fits the map to a shrinking marker set — that
  // decoupling is what keeps this loop-free. Stays without coords drop out of
  // the in-bounds view (they can't be placed on the map anyway).
  const visibleStays = useMemo(() => {
    if (!searchAsMove || !mapBounds) return filtered;
    const { west, south, east, north } = mapBounds;
    return filtered.filter(
      (s) =>
        typeof s.lat === "number" && typeof s.lng === "number" &&
        s.lat >= south && s.lat <= north && s.lng >= west && s.lng <= east,
    );
  }, [filtered, searchAsMove, mapBounds]);

  return (
    <section className="page-layout">
      <div className="page-head">
        <div>
          <p className="eyebrow"><BedDouble size={16} /> {t("rd.client.staysEyebrow", { defaultValue: "Stays marketplace" })}</p>
          <h1>{t("rd.client.staysHeading", { defaultValue: "Hotels, homestays, village rooms, and private rentals." })}</h1>
          <p>{t("rd.client.staysSubheading", { defaultValue: "Browse, compare, and tap any stay to open its booking details." })}</p>
        </div>
        <button className="partner-cta" onClick={() => navigate("/dashboard/host")}>
          <Home size={18} />
          {t("rd.client.listYourProperty", { defaultValue: "List your property" })}
        </button>
      </div>

      <div className="toolbar-card">
        <div className="field wide">
          <Search size={18} />
          <AddressAutocompleteInput
            value={search}
            onChange={setSearch}
            onSelectSuggestion={(s) => {
              // selectSuggestion already pushed the description into the
              // input via onChange. Now resolve the place_id → lat/lng
              // + admin so the filter below can narrow by geography.
              void handlePickSuggestion(s);
            }}
            placeholder={t("rd.client.staysSearchPlaceholder", { defaultValue: "Search city, temple, station, host, or property" })}
            wrapperClassName="relative min-w-0 flex-1"
          />
          {search && (
            <button
              type="button"
              aria-label={t("rd.client.clearSearch", { defaultValue: "Clear search" })}
              onClick={() => { setSearch(""); setPickedPlace(null); }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <DateRangePopover start={dateRange.start} end={dateRange.end} onChange={handleDateRangeChange} />
        <GuestsPopover value={filters.minGuests} onChange={(minGuests) => setFilters({ ...filters, minGuests })} />
        <button
          className={`filter-button ${nearMe ? "active" : ""}`}
          onClick={handleNearMe}
          disabled={nearMeLoading}
          aria-pressed={!!nearMe}
        >
          <LocateFixed size={17} /> {nearMe ? t("rd.client.nearMeOn", { defaultValue: "Near me · on" }) : nearMeLoading ? t("rd.client.locating", { defaultValue: "Locating…" }) : t("rd.client.nearMe", { defaultValue: "Near me" })}
        </button>
        <SortPopover value={sort} onChange={setSort} />
        <FiltersButton onOpen={() => setFiltersOpen(true)} />
      </div>

      <div className="context-strip">
        <LocationScopeChip />
        <RecentSearchChips recents={recents} label={recentLabel} onApply={applyRecent} onRemove={removeRecent} onClear={clearRecents} />
      </div>

      {/* Mobile-only List/Map toggle (<lg). Desktop shows both columns side by
          side, so this control is hidden there. Full-bleed map on tap keeps
          small screens to one thing at a time. */}
      <div className="mb-3 flex justify-center lg:hidden">
        <div className="inline-flex items-center rounded-full border border-white/70 bg-white/70 p-1 shadow-sm backdrop-blur-xl" role="tablist" aria-label={t("rd.client.viewToggle", { defaultValue: "List or map view" })}>
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "list"}
            onClick={() => setMobileView("list")}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] font-bold transition-colors ${mobileView === "list" ? "bg-foreground text-white shadow-sm" : "text-muted-foreground"}`}
          >
            <LayoutGrid size={15} /> {t("rd.client.viewList", { defaultValue: "List" })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === "map"}
            onClick={() => setMobileView("map")}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] font-bold transition-colors ${mobileView === "map" ? "bg-foreground text-white shadow-sm" : "text-muted-foreground"}`}
          >
            <Map size={15} /> {t("rd.client.viewMap", { defaultValue: "Map" })}
          </button>
        </div>
      </div>

      {/* Split layout — cards on the left, map on the right at lg+.
          The map column is sticky so it stays visible while the list scrolls,
          and grows tall enough to show neighbouring listings simultaneously.
          On mobile only one side shows at a time, driven by `mobileView`. */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className={`min-w-0 ${mobileView === "map" ? "hidden lg:block" : ""}`}>
          {staysLoading && stays.length === 0 ? (
            <StayCardsSkeleton />
          ) : staysError ? (
            <StaysLoadError onRetry={() => refetch()} />
          ) : stays.length === 0 ? (
            <EmptyResults kind="stays" onReset={() => { setSearch(""); setPickedPlace(null); setFilters(STAY_FILTER_DEFAULT); setSort("recommended"); }} />
          ) : filtered.length === 0 ? (
            <EmptyResults
              kind="stays"
              // Prefer the smallest settlement name ("Tirumala") over the
              // district ("Tirupati") when both are available — that's the
              // word the user actually typed/picked, so it reads back as
              // "No stays near Tirumala" instead of the broader district.
              pickedPlaceLabel={pickedPlace ? (pickedPlace.locality || pickedPlace.district) : null}
              onClearLocation={() => { setPickedPlace(null); setSearch(""); }}
              onReset={() => { setSearch(""); setPickedPlace(null); setFilters(STAY_FILTER_DEFAULT); setSort("recommended"); }}
            />
          ) : visibleStays.length === 0 ? (
            // filtered has results but none fall inside the current map view
            // (only reachable while "search as I move the map" is on).
            <div className="rounded-[18px] border border-white/70 bg-white/64 px-5 py-10 text-center shadow-sm backdrop-blur-xl">
              <Map size={22} className="mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm font-bold text-foreground">{t("rd.client.noStaysInArea", { defaultValue: "No stays in this part of the map" })}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{t("rd.client.noStaysInAreaHint", { defaultValue: "Zoom out or drag the map to see more." })}</p>
              <button
                type="button"
                onClick={() => setSearchAsMove(false)}
                className="mt-3 inline-flex items-center rounded-full border border-foreground/20 px-4 py-1.5 text-[13px] font-bold text-foreground transition-colors hover:bg-foreground/5"
              >
                {t("rd.client.showAllResults", { defaultValue: "Show all results" })}
              </button>
            </div>
          ) : (
            <>
              {searchAsMove && (
                <p className="mb-3 text-[13px] font-semibold text-muted-foreground">
                  {t("rd.client.staysInArea", { defaultValue: "{{count}} in this area", count: visibleStays.length })}
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {visibleStays.map((stay) => {
                  const distance = nearMe ? distanceKm(nearMe, { lat: stay.lat, lng: stay.lng }) : Infinity;
                  return (
                    <div
                      key={stay.id}
                      id={`mp-card-${stay.id}`}
                      onMouseEnter={() => setHoveredId(String(stay.id))}
                      onMouseLeave={() => setHoveredId((cur) => (cur === String(stay.id) ? null : cur))}
                    >
                      <StayCard
                        stay={stay}
                        selected={hoveredId === String(stay.id)}
                        onSelect={onOpenStay}
                        distanceKm={nearMe ? distance : null}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <aside className={`lg:sticky lg:top-24 lg:h-[calc(100vh-110px)] ${mobileView === "list" ? "hidden lg:block" : ""}`}>
          {nearMeError && (
            <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50/90 px-3 py-2 text-[12px] font-semibold text-rose-800">
              {nearMeError}
            </div>
          )}
          <div className={`relative ${mobileView === "map" ? "h-[calc(100vh-220px)]" : "h-[480px]"} overflow-hidden rounded-[18px] border border-white/70 bg-white/64 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl lg:h-full`}>
            {/* "Search as I move the map" — floats over the map top. The wrapper
                is click-through so only the pill itself intercepts taps. */}
            <div className="pointer-events-none absolute inset-x-0 top-3 z-[5] flex justify-center px-3">
              <label className="pointer-events-auto inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/70 bg-white/90 px-3.5 py-1.5 text-[12.5px] font-bold text-foreground shadow-md backdrop-blur">
                <input
                  type="checkbox"
                  checked={searchAsMove}
                  onChange={(e) => setSearchAsMove(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[#8b5e4a]"
                />
                {t("rd.client.searchAsMove", { defaultValue: "Search as I move the map" })}
              </label>
            </div>
            <Suspense fallback={<div className="h-full w-full animate-pulse bg-gradient-to-br from-black/[0.04] to-black/[0.08]" aria-hidden="true" />}>
            <MapView
              markers={mapMarkers}
              height="100%"
              center={[16.99, 82.12]}
              zoom={9}
              popupMode="card"
              openOnHover
              highlightId={hoveredId}
              onHoverChange={setHoveredId}
              onBoundsChange={setMapBounds}
              showUserLocation={!!nearMe}
              userLat={nearMe?.lat}
              userLng={nearMe?.lng}
              // Anchor the map on the picked location so it stays on
              // Tirumala/Tirupati instead of fitting bounds to all-of-
              // India when the filter happens to return zero stays.
              searchCenter={pickedPlace ? { lat: pickedPlace.lat, lng: pickedPlace.lng, zoom: 11 } : null}
            />
            </Suspense>
          </div>
        </aside>
      </div>

      <FiltersDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        config={{
          kind: "stays",
          value: filters,
          onApply: setFilters,
          typeOptions: ["All", "Hotel", "Homestay", "Lodge", "Village stay", "Farm stay", "Heritage", "Sathram"],
        }}
      />
    </section>
  );
}

function ServicesPage({
  serviceMode,
  setServiceMode,
  onOpenService,
}: {
  serviceMode: ServiceMode;
  setServiceMode: (mode: ServiceMode) => void;
  onOpenService: (service: Service) => void;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortValue>("recommended");
  const [filters, setFilters] = useState<ServiceFilters>(SERVICE_FILTER_DEFAULT);
  useUrlFilterSync<ServiceFilters>(setSearch, setFilters);
  useMarketplaceAgentFilters<ServiceFilters>("service", setSearch, setFilters, { onServiceMode: setServiceMode });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [nearMe, setNearMe] = useState<LatLng | null>(null);
  // Chosen date window → hide services with no free slot on ANY day in it
  // (server-side ANY-day availability filter; a single day is a degenerate range).
  const [dayRange, setDayRange] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });
  // Global location scope (navbar Search-everything palette).
  const { scope: locationScope } = useLocationScope();
  const [nearMeLoading, setNearMeLoading] = useState(false);
  const [nearMeError, setNearMeError] = useState<string | null>(null);

  // Recent searches (query text only — the services search bar has no
  // place/date/guest pickers), persisted per-user to localStorage under the
  // services key. Same debounced auto-capture as stays: snapshot once the
  // user stops typing for a moment, with 3+ chars. Dedup/cap live in the hook.
  const { user } = useAuth();
  const { recents, record: recordRecent, remove: removeRecent, clear: clearRecents } = useRecentSearches("services", user?.id);
  // Count-at-debounce-time snapshot of the visible list (ref assigned below
  // where visibleServices is computed) — see the stays section for semantics.
  const resultCountRef = useRef(0);
  useEffect(() => {
    const text = search.trim();
    if (text.length < 3) return;
    const timer = window.setTimeout(() => {
      // Snapshot the availability-day filter with the query so the recent
      // chip can show + restore it (single day → dateRange.start).
      recordRecent({ search: text, place: null, dateRange: { start: dayRange.start, end: dayRange.end }, minGuests: 1 });
      getAnalyticsEventsService().track("search_performed", { listingType: "service", source: "explore_services", props: { queryLength: text.length, resultCount: resultCountRef.current, q: text.toLowerCase().slice(0, 60) } });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [search, dayRange.start, dayRange.end, recordRecent]);

  const {
    data: services,
    isLoading: servicesLoading,
    error: servicesError,
    fetchNextPage: fetchNextServices,
    hasNextPage: hasNextServices,
    isFetchingNextPage: isFetchingNextServices,
  } = useInfiniteMarketplaceServices({ pageSize: 24, from: dayRange.start ?? undefined, to: dayRange.start ? addDaysIso(dayRange.end ?? dayRange.start, 1) : undefined });
  // Explore shows every result at once — no "Load more"/pagination. Keep
  // pulling pages from the cursor API until exhausted as soon as each lands.
  useEffect(() => {
    if (hasNextServices && !isFetchingNextServices) void fetchNextServices();
  }, [hasNextServices, isFetchingNextServices, fetchNextServices]);
  // Pull the live category/subcategory chips from published listings so a
  // custom service like "drone-pilot" shows up in the filter sheet without
  // editing this file. We merge three sources so the chip list reflects
  // real published data even when one source is sparse:
  //   1. backend taxonomy (DISTINCT categories + subcategories on active rows)
  //   2. categories on services already loaded into the page
  //   3. starter preset, only used while the page is still empty (so the
  //      filter dialog doesn't show "All" alone for a tick on first paint)
  const { data: taxonomy } = useListingTaxonomy("service");
  const categoryChips = useMemo(() => {
    const merged = new Set<string>();
    (taxonomy?.categories ?? []).forEach((c: string) => { if (c) merged.add(c); });
    (taxonomy?.subcategories ?? []).forEach((c: string) => { if (c) merged.add(c); });
    services.forEach((s) => { if (s.category) merged.add(s.category); });
    const list = Array.from(merged).sort((a, b) => a.localeCompare(b));
    return ["All", ...list];
  }, [taxonomy, services]);

  const handleNearMe = async () => {
    if (nearMe) { setNearMe(null); setNearMeError(null); return; }
    setNearMeLoading(true);
    setNearMeError(null);
    try {
      const pos = await getCurrentPosition();
      setNearMe(pos);
      toast.success(t("rd.client.sortedByDistance", { defaultValue: "Sorted by distance from you." }));
    } catch (err: any) {
      const message = err?.message || t("rd.client.locationError", { defaultValue: "Couldn't get your location." });
      setNearMeError(message);
      toast.error(message);
    } finally {
      setNearMeLoading(false);
    }
  };
  const visibleServices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = services
      // Global location scope first — everything below refines within it.
      .filter((service) => matchesLocationScope(locationScope, {
        lat: service.lat,
        lng: service.lng,
        adminTexts: [service.city, service.location],
      }))
      .filter((service) => service.mode.includes(serviceMode))
      .filter((service) => {
        // Multi-select chip strip. Empty array ≡ "any category" — match
        // everything. Otherwise pass when at least one selected chip is a
        // case-insensitive substring match (in either direction) against
        // the listing's subcategory. Substring-in-either-direction fixes
        // the bug where a parent-bucket chip like "cleaning" wouldn't
        // catch listings whose category is "Deep Cleaning"; chips like
        // "math-tutor" still match themselves cleanly.
        if (filters.categories.length === 0) return true;
        // Match against EVERY subcategory the listing publishes (new
        // multi-value source), plus the legacy primary `category` for
        // back-compat with listings that haven't been re-saved through the
        // chip input yet. A chip passes when it's a case-insensitive
        // substring match (either direction) against any of those values —
        // same loose rule as before, just applied to the full list so a
        // salon with ["Beard trim","Haircut","Nails"] gets caught by the
        // "Beard trim" chip even though only "Haircut" is the primary.
        const haystack = [service.category, ...(service.subcategories ?? [])]
          .map((v) => (v || "").trim().toLowerCase())
          .filter((v) => v.length > 0);
        if (haystack.length === 0) return false;
        return filters.categories.some((raw) => {
          const chip = raw.trim().toLowerCase();
          if (!chip) return false;
          return haystack.some((v) => v === chip || v.includes(chip) || chip.includes(v));
        });
      })
      .filter((service) => (filters.modes.length === 0 ? true : filters.modes.some((m) => service.mode.includes(m))))
      .filter((service) => service.price <= filters.priceMax)
      .filter((service) => service.rating >= filters.ratingMin)
      .filter((service) => (filters.verifiedOnly ? service.verified === true : true))
      .filter((service) => {
        if (!filters.languages?.length) return true;
        const have = (service.languages || []).map((l) => l.toLowerCase());
        return filters.languages.some((l) => have.some((h) => h.includes(l.toLowerCase())));
      })
      .filter((service) => {
        if (!needle) return true;
        return [service.title, service.provider, service.category, ...(service.subcategories ?? []), service.location]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
    const sorted = [...rows];
    if (nearMe) {
      sorted.sort((a, b) => distanceKm(nearMe, { lat: a.lat, lng: a.lng }) - distanceKm(nearMe, { lat: b.lat, lng: b.lng }));
    } else if (sort === "price-asc") sorted.sort((a, b) => a.price - b.price);
    else if (sort === "price-desc") sorted.sort((a, b) => b.price - a.price);
    else if (sort === "rating") sorted.sort((a, b) => b.rating - a.rating);
    return sorted;
  }, [search, serviceMode, sort, filters, services, nearMe, locationScope]);
  resultCountRef.current = visibleServices.length;

  return (
    <section className="page-layout">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Sparkles size={16} /> {t("rd.client.servicesEyebrow", { defaultValue: "Services" })}</p>
          <h1>{t("rd.client.servicesHeading", { defaultValue: "Appointments for skilled, trusted local providers." })}</h1>
          <p>{t("rd.client.servicesSubheading", { defaultValue: "Filter by service mode and tap a card to see provider details and book." })}</p>
        </div>
        <button className="partner-cta" onClick={() => navigate("/dashboard/provider")}>
          <Store size={18} />
          {t("rd.client.offerYourService", { defaultValue: "Offer your service" })}
        </button>
      </div>

      <div className="mode-switch">
        {([
          ["at-home", Home, t("rd.client.modeAtHome", { defaultValue: "At home" })],
          ["visit-provider", Store, t("rd.client.modeVisitProvider", { defaultValue: "Visit provider" })],
          ["online", Globe2, t("rd.client.modeOnline", { defaultValue: "Online" })],
        ] as Array<[ServiceMode, typeof Home, string]>).map(([mode, Icon, label]) => (
          <button key={mode} className={serviceMode === mode ? "active" : ""} onClick={() => setServiceMode(mode)}>
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="toolbar-card">
        <div className="field wide">
          <Search size={18} />
          {/* Keyword search over the loaded service listings (name / category /
              provider) — NOT a location autocomplete. Location is handled by the
              "Near me" button + Filters. */}
          <input
            className="min-w-0 flex-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("rd.client.servicesSearchPlaceholder", { defaultValue: "Salon, Ayurveda, tutor, music, photographer, tour guide" })}
          />
          {search && (
            <button
              type="button"
              aria-label={t("rd.client.clearSearch", { defaultValue: "Clear search" })}
              onClick={() => setSearch("")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <DateRangePopover start={dayRange.start} end={dayRange.end} onChange={setDayRange} />
        <button
          className={`filter-button ${nearMe ? "active" : ""}`}
          onClick={handleNearMe}
          disabled={nearMeLoading}
          aria-pressed={!!nearMe}
        >
          <LocateFixed size={17} /> {nearMe ? t("rd.client.nearMeOn", { defaultValue: "Near me · on" }) : nearMeLoading ? t("rd.client.locating", { defaultValue: "Locating…" }) : t("rd.client.nearMe", { defaultValue: "Near me" })}
        </button>
        <SortPopover value={sort} onChange={setSort} />
        <FiltersButton onOpen={() => setFiltersOpen(true)} />
      </div>

      <div className="context-strip">
        <LocationScopeChip />
        <RecentSearchChips
          recents={recents}
          label={(r) => { const dl = recentRangeLabel(r.dateRange); return dl ? `${r.search} · ${dl}` : r.search; }}
          onApply={(r) => { setSearch(r.search); setDayRange({ start: r.dateRange.start ?? null, end: r.dateRange.end ?? null }); }}
          onRemove={removeRecent}
          onClear={clearRecents}
        />
      </div>

      {nearMeError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/90 px-3 py-2 text-[12px] font-semibold text-rose-800">
          {nearMeError}
        </div>
      )}
      {/* No map for services per the marketplace flow spec. */}
      {servicesLoading && services.length === 0 ? (
        <ServicesGridSkeleton />
      ) : servicesError && services.length === 0 ? (
        <EmptyResults kind="services" onReset={() => { setSearch(""); setFilters(SERVICE_FILTER_DEFAULT); }} />
      ) : visibleServices.length === 0 ? (
        <EmptyResults
          kind="services"
          onReset={() => { setSearch(""); setFilters(SERVICE_FILTER_DEFAULT); }}
          pickedDayLabel={dayRange.start ? localDateFromIso(dayRange.start).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : null}
          onClearDay={dayRange.start ? () => setDayRange({ start: null, end: null }) : undefined}
        />
      ) : (
        <>
          <div className="service-grid">
            {visibleServices.map((service) => (
              <ServiceCard
                key={service.id}
                domId={`mp-card-${service.id}`}
                service={service}
                selected={false}
                onSelect={onOpenService}
              />
            ))}
          </div>
        </>
      )}

      <FiltersDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        config={{
          kind: "services",
          value: filters,
          onApply: setFilters,
          categoryOptions: categoryChips,
        }}
      />
    </section>
  );
}

function TransportPage({
  transportMode,
  setTransportMode,
  onOpenTransport,
}: {
  transportMode: TransportMode;
  setTransportMode: (mode: TransportMode) => void;
  onOpenTransport: (item: Transport) => void;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortValue>("recommended");
  const [filters, setFilters] = useState<TransportFilters>(TRANSPORT_FILTER_DEFAULT);
  useUrlFilterSync<TransportFilters>(setSearch, setFilters);
  useMarketplaceAgentFilters<TransportFilters>("transport", setSearch, setFilters, { onTransportMode: setTransportMode });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [nearMe, setNearMe] = useState<LatLng | null>(null);
  // Global location scope (navbar Search-everything palette).
  const { scope: locationScope } = useLocationScope();
  const [nearMeLoading, setNearMeLoading] = useState(false);
  const [nearMeError, setNearMeError] = useState<string | null>(null);
  // Chosen date window → hide drivers with no free time on ANY day in it
  // (server-side ANY-day availability filter; a single day is a degenerate range).
  const [dayRange, setDayRange] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });

  // Recent searches (query text + passenger count), persisted per-user to
  // localStorage under the transport key. Same debounced auto-capture as
  // stays: snapshot once the user stops typing for a moment, with 3+ chars.
  // `minGuests` carries the passenger count (the toolbar stepper's minSeats).
  // Dedup/cap live in the hook.
  const { user } = useAuth();
  const { recents, record: recordRecent, remove: removeRecent, clear: clearRecents } = useRecentSearches("transport", user?.id);
  // Count-at-debounce-time snapshot of the visible list (ref assigned below
  // where visibleTransport is computed) — see the stays section for semantics.
  const resultCountRef = useRef(0);
  useEffect(() => {
    const text = search.trim();
    if (text.length < 3) return;
    const timer = window.setTimeout(() => {
      // Snapshot the availability-day filter with the query so the recent
      // chip can show + restore it (single day → dateRange.start).
      recordRecent({ search: text, place: null, dateRange: { start: dayRange.start, end: dayRange.end }, minGuests: filters.minSeats });
      getAnalyticsEventsService().track("search_performed", { listingType: "transport", source: "explore_transport", props: { queryLength: text.length, resultCount: resultCountRef.current, q: text.toLowerCase().slice(0, 60) } });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [search, filters.minSeats, dayRange.start, dayRange.end, recordRecent]);

  // One-tap recall: restore the query, passenger count, and day together.
  const applyRecent = (r: RecentSearch) => {
    setSearch(r.search);
    setFilters((f) => ({ ...f, minSeats: r.minGuests }));
    setDayRange({ start: r.dateRange.start ?? null, end: r.dateRange.end ?? null });
  };

  const recentLabel = (r: RecentSearch): string => {
    const parts = [r.search];
    { const dl = recentRangeLabel(r.dateRange); if (dl) parts.push(dl); }
    if (r.minGuests > 1) parts.push(t("rd.client.recentPassengers", { defaultValue: "{{count}} passengers", count: r.minGuests }));
    return parts.join(" · ");
  };

  const {
    data: transport,
    isLoading: transportLoading,
    error: transportError,
    fetchNextPage: fetchNextTransport,
    hasNextPage: hasNextTransport,
    isFetchingNextPage: isFetchingNextTransport,
  } = useInfiniteMarketplaceTransport({ pageSize: 24, from: dayRange.start ?? undefined, to: dayRange.start ? addDaysIso(dayRange.end ?? dayRange.start, 1) : undefined });
  // Explore shows every result at once — no "Load more"/pagination. Keep
  // pulling pages from the cursor API until exhausted as soon as each lands.
  useEffect(() => {
    if (hasNextTransport && !isFetchingNextTransport) void fetchNextTransport();
  }, [hasNextTransport, isFetchingNextTransport, fetchNextTransport]);

  const handleNearMe = async () => {
    if (nearMe) { setNearMe(null); setNearMeError(null); return; }
    setNearMeLoading(true);
    setNearMeError(null);
    try {
      const pos = await getCurrentPosition();
      setNearMe(pos);
      toast.success(t("rd.client.sortedByDistance", { defaultValue: "Sorted by distance from you." }));
    } catch (err: any) {
      const message = err?.message || t("rd.client.locationError", { defaultValue: "Couldn't get your location." });
      setNearMeError(message);
      toast.error(message);
    } finally {
      setNearMeLoading(false);
    }
  };
  const visibleTransport = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = transport
      // Global location scope first — everything below refines within it.
      .filter((item) => matchesLocationScope(locationScope, {
        lat: item.lat,
        lng: item.lng,
        adminTexts: [item.area, item.city],
      }))
      // Mode pills scope the marketplace tab; the filter dialog can refine
      // further via `bookingModes` (treat empty as "any of the mode pill set").
      .filter((item) => {
        if (transportMode === "point") return true; // gated separately above
        // The visible mode pill already scopes to a specific mode; only show
        // listings that actually price/offer that mode.
        if (transportMode === "hourly") return item.hourly > 0;
        if (transportMode === "day") return item.day > 0;
        if (transportMode === "package") return item.packageOptions.length > 0;
        return true;
      })
      .filter((item) => {
        if (!filters.bookingModes.length) return true;
        return filters.bookingModes.some((m) => {
          if (m === "hourly") return item.hourly > 0;
          if (m === "day") return item.day > 0;
          if (m === "package") return item.packageOptions.length > 0;
          if (m === "point") return item.perKm > 0;
          return false;
        });
      })
      .filter((item) => {
        // Multi-select chip strip. Empty array ≡ "any type" — match
        // everything. Otherwise pass when at least one selected chip
        // matches via the same multi-shape comparison the original
        // single-select used:
        //   - multi-type catalog: any `transportationTypes[].type` === chip
        //   - legacy single-type: chip id ↔ display label ↔ raw `item.type`
        if (filters.vehicleTypes.length === 0) return true;
        const types = item.transportationTypes ?? [];
        const itemAsId = legacyToTypeId(item.type);
        return filters.vehicleTypes.some((chip) => {
          if (types.length > 0 && types.some((t) => t.type === chip)) return true;
          const chipLabel = getTransportTypeLabel(chip, chip);
          return (
            itemAsId === chip ||
            item.type === chipLabel ||
            item.type === chip
          );
        });
      })
      // Per-km price slider was removed from the filter UI; the field stays
      // on TransportFilters for backwards-compat but is no longer applied
      // here. Most listings rate by hour / day / package anyway.
      .filter((item) => (filters.pricePerHourMax === 0 ? true : item.hourly > 0 && item.hourly <= filters.pricePerHourMax))
      .filter((item) => (filters.pricePerDayMax === 0 ? true : item.day > 0 && item.day <= filters.pricePerDayMax))
      .filter((item) => item.rating >= filters.ratingMin)
      .filter((item) => item.capacity >= filters.minSeats)
      .filter((item) => (filters.verifiedOnly ? item.verified === true : true))
      .filter((item) => {
        if (!filters.languages.length) return true;
        const have = (item.languages || []).map((l) => l.toLowerCase());
        return filters.languages.some((l) => have.some((h) => h.includes(l.toLowerCase())));
      })
      .filter((item) => {
        if (!needle) return true;
        return [item.driver, item.vehicle, item.type, item.area, ...item.packages]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
    const sorted = [...rows];
    if (nearMe) {
      sorted.sort((a, b) => distanceKm(nearMe, { lat: a.lat, lng: a.lng }) - distanceKm(nearMe, { lat: b.lat, lng: b.lng }));
    } else if (sort === "price-asc") sorted.sort((a, b) => a.perKm - b.perKm);
    else if (sort === "price-desc") sorted.sort((a, b) => b.perKm - a.perKm);
    else if (sort === "rating") sorted.sort((a, b) => b.rating - a.rating);
    return sorted;
  }, [search, sort, filters, transport, nearMe, transportMode, locationScope]);
  resultCountRef.current = visibleTransport.length;

  return (
    <section className="page-layout">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Car size={16} /> {t("rd.client.transportEyebrow", { defaultValue: "Transport marketplace" })}</p>
          <h1>{t("rd.client.transportHeading", { defaultValue: "Local rides, rentals, and driver-led travel packages." })}</h1>
          <p>{t("rd.client.transportSubheading", { defaultValue: "Pick a booking type, browse drivers and vehicles, then tap any card to open booking details." })}</p>
        </div>
        <button className="partner-cta" onClick={() => navigate("/dashboard/transport")}>
          <Car size={18} />
          {t("rd.client.registerVehicle", { defaultValue: "Register vehicle" })}
        </button>
      </div>

      {/* Transport mode pills act as a discovery filter — the detail sheet
          re-shows the full mode picker so users can change their mind.
          PointRide is gated as "Coming soon": no transport entries are linked
          to it yet, so selecting the pill shows a coming-soon callout instead
          of the grid. */}
      <div className="mode-switch transport">
        {([
          ["package", Landmark, t("rd.client.modeTourPackage", { defaultValue: "Tour package" }), false],
          ["hourly", Clock3, t("rd.client.modeHourly", { defaultValue: "Hourly" }), false],
          ["day", CalendarDays, t("rd.client.modeDayRental", { defaultValue: "Day rental" }), false],
          ["point", Navigation, t("rd.client.modePointRide", { defaultValue: "Point ride" }), true],
        ] as Array<[TransportMode, typeof Navigation, string, boolean]>).map(([mode, Icon, label, comingSoon]) => (
          <button key={mode} className={transportMode === mode ? "active" : ""} onClick={() => setTransportMode(mode)}>
            <Icon size={18} />
            <span>{label}</span>
            {comingSoon && <span className="coming-soon-pill">{t("rd.client.comingSoon", { defaultValue: "Coming soon" })}</span>}
          </button>
        ))}
      </div>

      <div className="toolbar-card">
        <div className="field wide">
          <Search size={18} />
          {/* Keyword search over the loaded transport listings (driver / vehicle /
              area / package) — NOT a location autocomplete. Location is handled by
              the "Near me" button + Filters. */}
          <input
            className="min-w-0 flex-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("rd.client.transportSearchPlaceholder", { defaultValue: "Driver, vehicle, area, package" })}
          />
          {search && (
            <button
              type="button"
              aria-label={t("rd.client.clearSearch", { defaultValue: "Clear search" })}
              onClick={() => setSearch("")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {/* Passenger stepper — surfaces the Filters dialog's minSeats in the
            toolbar. Same live filter (vehicle capacity ≥ passengers), and the
            count rides along in recent-search snapshots. Max mirrors the
            dialog's seats slider. */}
        <GuestsPopover variant="passengers" max={12} value={filters.minSeats} onChange={(minSeats) => setFilters({ ...filters, minSeats })} />
        <DateRangePopover start={dayRange.start} end={dayRange.end} onChange={setDayRange} />
        <button
          className={`filter-button ${nearMe ? "active" : ""}`}
          onClick={handleNearMe}
          disabled={nearMeLoading}
          aria-pressed={!!nearMe}
        >
          <LocateFixed size={17} /> {nearMe ? t("rd.client.nearMeOn", { defaultValue: "Near me · on" }) : nearMeLoading ? t("rd.client.locating", { defaultValue: "Locating…" }) : t("rd.client.nearMe", { defaultValue: "Near me" })}
        </button>
        <SortPopover value={sort} onChange={setSort} />
        <FiltersButton onOpen={() => setFiltersOpen(true)} />
      </div>

      <div className="context-strip">
        <LocationScopeChip />
        <RecentSearchChips recents={recents} label={recentLabel} onApply={applyRecent} onRemove={removeRecent} onClear={clearRecents} />
      </div>

      {nearMeError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/90 px-3 py-2 text-[12px] font-semibold text-rose-800">
          {nearMeError}
        </div>
      )}
      {/* No map for transport per the marketplace flow spec. */}
      {transportMode === "point" ? (
        <div className="empty-results coming-soon-callout">
          <Navigation size={28} />
          <h3>{t("rd.client.pointRideComingSoonTitle", { defaultValue: "Point ride is coming soon" })}</h3>
          <p>
            {t("rd.client.pointRideComingSoonBody", { defaultValue: "We're still onboarding drivers for instant point-to-point rides. Until then, try Tour packages, Hourly, or Day rentals — all are live with vetted local drivers." })}
          </p>
        </div>
      ) : transportLoading && transport.length === 0 ? (
        <ServicesGridSkeleton />
      ) : transportError && transport.length === 0 ? (
        <EmptyResults kind="transport" onReset={() => { setSearch(""); setSort("recommended"); setFilters(TRANSPORT_FILTER_DEFAULT); }} />
      ) : visibleTransport.length === 0 ? (
        <EmptyResults
          kind="transport"
          onReset={() => { setSearch(""); setSort("recommended"); setFilters(TRANSPORT_FILTER_DEFAULT); }}
          pickedDayLabel={dayRange.start ? localDateFromIso(dayRange.start).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : null}
          onClearDay={dayRange.start ? () => setDayRange({ start: null, end: null }) : undefined}
        />
      ) : (
        <>
          <div className="transport-grid">
            {visibleTransport.map((item) => (
              <TransportCard key={item.id} domId={`mp-card-${item.id}`} item={item} selected={false} onSelect={onOpenTransport} />
            ))}
          </div>
        </>
      )}

      <FiltersDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        config={(() => {
          // Start with the 6 onboarding categories so the filter always
          // mirrors what hosts can pick during signup. Then union in any
          // *extra* type ids actually present on live listings — that's
          // how custom/"Add a custom vehicle" entries surface here without
          // hard-coding the full catalog.
          const baseIds = new Set(ONBOARDING_TRANSPORT_CATEGORIES.map((c) => c.id));
          const extraIds: string[] = [];
          const extraLabels: Record<string, string> = {};
          for (const item of transport) {
            const entries = item.transportationTypes ?? [];
            if (entries.length > 0) {
              for (const e of entries) {
                if (!e?.type || baseIds.has(e.type)) continue;
                if (!extraIds.includes(e.type)) {
                  extraIds.push(e.type);
                  extraLabels[e.type] = e.displayName || getTransportTypeLabel(e.type, e.type);
                }
              }
            } else if (item.type) {
              // Legacy single-string row — fold via alias map; if it maps
              // to a base id we skip, otherwise expose the label as-is.
              const mapped = legacyToTypeId(item.type);
              if (mapped && !baseIds.has(mapped) && !extraIds.includes(mapped)) {
                extraIds.push(mapped);
                extraLabels[mapped] = getTransportTypeLabel(mapped, item.type);
              }
            }
          }
          const typeOptions = [
            "All",
            ...ONBOARDING_TRANSPORT_CATEGORIES.map((c) => c.id),
            ...extraIds,
          ];
          const typeLabels: Record<string, string> = {
            All: t("rd.client.filterAll", { defaultValue: "All" }),
            ...Object.fromEntries(ONBOARDING_TRANSPORT_CATEGORIES.map((c) => [
              c.id,
              t(`rd.client.vehicleType.${c.id}`, { defaultValue: c.label }),
            ])),
            ...extraLabels,
          };
          return {
            kind: "transport" as const,
            value: filters,
            onApply: setFilters,
            typeOptions,
            typeLabels,
          };
        })()}
      />
    </section>
  );
}

function ServicesGridSkeleton() {
  return (
    <div className="service-grid">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-[18px] border border-white/70 bg-white/50 p-3">
          <div className="h-36 animate-pulse rounded-xl bg-muted/70" />
          <div className="mt-3 h-3 w-2/3 animate-pulse rounded bg-muted/70" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-muted/70" />
          <div className="mt-3 h-4 w-1/3 animate-pulse rounded bg-muted/70" />
        </div>
      ))}
    </div>
  );
}

function StayCardsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-[18px] border border-white/70 bg-white/50 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]"
        >
          <div className="h-40 animate-pulse rounded-xl bg-muted/70" />
          <div className="mt-3 h-3 w-2/3 animate-pulse rounded bg-muted/70" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-muted/70" />
          <div className="mt-3 h-4 w-1/3 animate-pulse rounded bg-muted/70" />
        </div>
      ))}
    </div>
  );
}

function StaysLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useLanguage();
  return (
    <div
      className="rounded-[18px] border border-destructive/30 bg-destructive/5 p-8 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]"
      style={{ minHeight: 200 }}
    >
      <p className="font-display text-lg font-bold text-foreground">{t("rd.client.staysLoadErrorTitle", { defaultValue: "We couldn't load stays" })}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t("rd.client.staysLoadErrorBody", { defaultValue: "Check your connection or try again in a moment." })}</p>
      <button
        onClick={onRetry}
        className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-border bg-white px-4 text-sm font-bold text-foreground hover:bg-muted"
      >
        {t("rd.client.retry", { defaultValue: "Retry" })}
      </button>
    </div>
  );
}

function RailSkeleton({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="min-w-[260px] rounded-2xl border border-white/70 bg-white/50 p-3"
        >
          <div className="h-36 animate-pulse rounded-xl bg-muted/70" />
          <div className="mt-3 h-3 w-2/3 animate-pulse rounded bg-muted/70" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-muted/70" />
        </div>
      ))}
    </>
  );
}

function RailMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-[280px] items-center justify-center rounded-2xl border border-white/70 bg-white/55 px-4 py-6 text-center text-xs font-semibold text-muted-foreground">
      {children}
    </div>
  );
}

function EmptyResults({
  kind,
  onReset,
  pickedPlaceLabel,
  onClearLocation,
  pickedDayLabel,
  onClearDay,
}: {
  kind: "stays" | "services" | "transport";
  onReset: () => void;
  /** When the user has picked a specific place from the autocomplete,
   *  the empty state should name it ("No stays near Tirumala") and
   *  offer to drop just the location pin first — usually a far less
   *  destructive fix than "reset every filter". */
  pickedPlaceLabel?: string | null;
  onClearLocation?: () => void;
  /** When a service/transport day is picked and everything is booked/closed
   *  that day, name the day and offer to clear just the day — the likeliest
   *  reason the grid is empty. Takes priority over the location message. */
  pickedDayLabel?: string | null;
  onClearDay?: () => void;
}) {
  const { t } = useLanguage();
  const copy: Record<typeof kind, { title: string; body: string }> = {
    stays: {
      title: t("rd.client.emptyStaysTitle", { defaultValue: "No stays match your filters" }),
      body: t("rd.client.emptyStaysBody", { defaultValue: "Try clearing the property type or searching a nearby town." }),
    },
    services: {
      title: t("rd.client.emptyServicesTitle", { defaultValue: "No services here yet" }),
      body: t("rd.client.emptyServicesBody", { defaultValue: "Switch service mode or clear your search to see more providers." }),
    },
    transport: {
      title: t("rd.client.emptyTransportTitle", { defaultValue: "No drivers match this route" }),
      body: t("rd.client.emptyTransportBody", { defaultValue: "Try a broader pickup/drop, or pick a different ride mode." }),
    },
  };
  const { title: defaultTitle, body: defaultBody } = copy[kind];
  // When a location was picked, swap to location-aware copy + a primary
  // "Clear location" action. Reset becomes a secondary fallback.
  const isLocationScoped = !!pickedPlaceLabel && !!onClearLocation;
  const isDayScoped = !!pickedDayLabel && !!onClearDay;
  const noun = kind === "stays"
    ? t("rd.client.nounStays", { defaultValue: "stays" })
    : kind === "services"
      ? t("rd.client.nounServices", { defaultValue: "services" })
      : t("rd.client.nounDrivers", { defaultValue: "drivers" });
  const title = isDayScoped
    ? t("rd.client.emptyOnDay", { defaultValue: "Nothing available on {{day}}", day: pickedDayLabel })
    : isLocationScoped
      ? t("rd.client.emptyNearPlace", { defaultValue: "No {{noun}} near {{place}}", noun, place: pickedPlaceLabel })
      : defaultTitle;
  const body = isDayScoped
    ? t("rd.client.emptyOnDayBody", { defaultValue: "Everything is booked or closed that day. Try another day." })
    : isLocationScoped
      ? t("rd.client.emptyLocationBody", { defaultValue: "Try a wider area or clear the location to see everything that matches your other filters." })
      : defaultBody;
  return (
    <div
      className="rounded-[18px] border border-white/70 bg-white/64 p-8 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl"
      style={{ minHeight: 200 }}
    >
      <p className="font-display text-lg font-bold text-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {isDayScoped && (
          <button
            onClick={onClearDay}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-foreground bg-foreground px-4 text-sm font-bold text-white shadow-sm transition-all hover:shadow active:scale-95"
          >
            {t("rd.client.clearDay", { defaultValue: "Clear day" })}
          </button>
        )}
        {isLocationScoped && (
          <button
            onClick={onClearLocation}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-foreground bg-foreground px-4 text-sm font-bold text-white shadow-sm transition-all hover:shadow active:scale-95"
          >
            {t("rd.client.clearLocation", { defaultValue: "Clear location" })}
          </button>
        )}
        <button
          onClick={onReset}
          className="inline-flex h-10 items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 text-sm font-bold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:border-foreground hover:bg-foreground hover:text-white active:scale-95"
        >
          {t("rd.client.resetFilters", { defaultValue: "Reset filters" })}
        </button>
      </div>
    </div>
  );
}

// --- Booking draft builders ------------------------------------------------
// Each panel hands a fully-formed MarketplaceBookingDraft to onBook() so the
// dialog stays purely presentational. Math here is illustrative only — real
// pricing will come from the backend once those models stabilise.

function buildStayDraft(stay: Stay, t: TFunc): MarketplaceBookingDraft {
  const nights = 2;
  const base = stay.price * nights;
  const serviceFee = 420;
  const taxes = 350;
  return {
    kind: "stay",
    itemId: stay.id,
    title: stay.title,
    subtitle: `${stay.owner} · ${placeLine(stay.location, stay.district)}`,
    image: stay.image,
    date: t("rd.client.sampleStayDates", { defaultValue: "May 18 – May 20" }),
    guests: stay.guests,
    price: {
      base,
      baseLabel: t("rd.client.nightsTimesPrice", { defaultValue: "{{nights}} nights × ₹{{price}}", nights, price: stay.price.toLocaleString() }),
      addOns: [{ label: t("rd.client.serviceFee", { defaultValue: "Service fee" }), amount: serviceFee }],
      taxes,
      total: base + serviceFee + taxes,
    },
  };
}

function buildServiceDraft(service: Service, mode: ServiceMode, slot: string, t: TFunc): MarketplaceBookingDraft {
  const fee = PLATFORM_FEE_RUPEES;
  const gst = Math.round((service.price + fee) * 0.18);
  return {
    kind: "service",
    itemId: service.id,
    title: service.title,
    subtitle: `${service.provider} · ${service.duration}`,
    image: service.image,
    slot,
    mode,
    options: [{ label: mode === "at-home" ? t("rd.client.modeAtHome", { defaultValue: "At home" }) : mode === "online" ? t("rd.client.modeOnline", { defaultValue: "Online" }) : t("rd.client.modeVisitProvider", { defaultValue: "Visit provider" }), value: mode }],
    price: {
      base: service.price,
      baseLabel: t("rd.client.serviceCharge", { defaultValue: "Service charge" }),
      addOns: [{ label: t("rd.client.platformFee", { defaultValue: "Platform fee" }), amount: fee }],
      taxes: gst,
      total: service.price + fee + gst,
    },
  };
}

function buildTransportDraft(
  item: Transport,
  mode: TransportMode,
  t: TFunc,
  ctx: { pickup?: string; drop?: string } = {},
): MarketplaceBookingDraft {
  const amount =
    mode === "hourly" ? item.hourly * 4 :
    mode === "day" ? item.day :
    mode === "package" ? item.packageOptions[0]?.price ?? item.day + 800 :
    18 * item.perKm + 80;
  const subtitle = ctx.pickup || ctx.drop
    ? `${ctx.pickup || t("rd.client.pickup", { defaultValue: "Pickup" })} → ${ctx.drop || t("rd.client.drop", { defaultValue: "Drop" })}`
    : `${item.vehicle} · ${item.area}`;
  return {
    kind: "transport",
    itemId: item.id,
    title: item.driver,
    subtitle,
    image: item.image,
    mode,
    options: [{ label: mode === "point" ? t("rd.client.modePointRide", { defaultValue: "Point ride" }) : mode === "hourly" ? t("rd.client.modeHourly", { defaultValue: "Hourly" }) : mode === "day" ? t("rd.client.modeFullDay", { defaultValue: "Full day" }) : t("rd.client.modeTourPackage", { defaultValue: "Tour package" }), value: mode }],
    price: {
      base: amount,
      baseLabel: mode === "point" ? t("rd.client.rideEstimate", { defaultValue: "Ride estimate" }) : mode === "hourly" ? t("rd.client.fourHourRental", { defaultValue: "4-hour rental" }) : mode === "day" ? t("rd.client.fullDayRental", { defaultValue: "Full-day rental" }) : t("rd.client.packageFare", { defaultValue: "Package fare" }),
      addOns: [],
      taxes: 0,
      total: amount,
    },
  };
}

function SectionHeading({
  eyebrow,
  title,
  actionLabel,
  onAction,
}: {
  eyebrow: string;
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-heading">
      <div>
        <p>{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {actionLabel && (
        <button onClick={onAction}>
          {actionLabel}
          <ChevronRight size={17} />
        </button>
      )}
    </div>
  );
}

function LanePanel({
  icon: Icon,
  title,
  subtitle,
  cta,
  onClick,
}: {
  icon: typeof Compass;
  title: string;
  subtitle: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button className="lane-panel" onClick={onClick}>
      <span className="lane-icon"><Icon size={24} /></span>
      <h3>{title}</h3>
      <p>{subtitle}</p>
      <span>{cta}<ArrowRight size={16} /></span>
    </button>
  );
}

function formatDistance(km: number | null | undefined, t: TFunc): string | null {
  if (km == null || !Number.isFinite(km)) return null;
  if (km < 1) return t("rd.client.distanceMeters", { defaultValue: "{{m}} m away", m: Math.round(km * 1000) });
  if (km < 10) return t("rd.client.distanceKm", { defaultValue: "{{km}} km away", km: km.toFixed(1) });
  return t("rd.client.distanceKm", { defaultValue: "{{km}} km away", km: Math.round(km) });
}

function StayCard({ stay, selected, onSelect, distanceKm: distance }: { stay: Stay; selected: boolean; onSelect: (stay: Stay) => void; distanceKm?: number | null }) {
  const { t } = useLanguage();
  const distanceLabel = formatDistance(distance ?? null, t);
  const { isStaySaved, toggleSaveStay } = useSaved();
  const saved = isStaySaved(String(stay.id));
  return (
    <div
      className={`stay-card ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={stay.title}
      onClick={() => onSelect(stay)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(stay); }
      }}
    >
      <div className="stay-image-wrap">
        <img src={stay.image} alt={stay.title} loading="lazy" decoding="async" />
        <span>{stay.type}</span>
        <button
          type="button"
          aria-label={saved ? t("rd.client.unsaveStay", { defaultValue: "Unsave stay" }) : t("rd.client.saveStay", { defaultValue: "Save stay" })}
          aria-pressed={saved}
          className={saved ? "saved" : ""}
          onClick={(e) => { e.stopPropagation(); toggleSaveStay(String(stay.id)); }}
        >
          {/* Filled red when the listing is saved so the state is obvious
              against the white pill background. The old `fill-current`
              picked up the surrounding muted text color and looked black,
              which made saved vs. unsaved visually indistinguishable at
              a glance. */}
          <Heart
            size={16}
            className={saved ? "fill-destructive text-destructive" : ""}
          />
        </button>
      </div>
      <div className="card-body">
        <div className="rating-line">
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {stay.rating}</strong>
          <span>{t("rd.client.reviewsCount", { defaultValue: "{{count}} reviews", count: stay.reviews })}</span>
          {stay.verified && <span className="verified"><BadgeCheck size={13} /> {t("rd.client.verified", { defaultValue: "Verified" })}</span>}
        </div>
        <h3 className="one-line">{stay.title}</h3>
        <p><MapPin size={14} /> <span className="one-line">{placeLine(stay.location, stay.district)}{distanceLabel ? ` · ${distanceLabel}` : (distance === Infinity && distance != null ? ` · ${t("rd.client.distanceUnknown", { defaultValue: "distance unknown" })}` : "")}</span></p>
        <div className="tag-row">
          {stay.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
        </div>
        <div className="price-row">
          <span><Users size={15} /> {t("rd.client.guestsCount", { defaultValue: "{{count}} guests", count: stay.guests })}</span>
          <strong>Rs. {stay.price.toLocaleString()}<small>{t("rd.client.perNight", { defaultValue: "/night" })}</small></strong>
        </div>
      </div>
    </div>
  );
}

function BookingPanel({ stay, onBook }: { stay: Stay; onBook: (draft: MarketplaceBookingDraft) => void }) {
  const { t } = useLanguage();
  const total = stay.price * 2 + 420 + 350;
  return (
    <aside className="booking-panel">
      <div className="panel-image">
        <img src={stay.image} alt={stay.title} loading="lazy" decoding="async" />
        <span>{t("rd.client.selectedStay", { defaultValue: "Selected stay" })}</span>
      </div>
      <h2>{stay.title}</h2>
      <p>{t("rd.client.hostsIn", { defaultValue: "{{owner}} hosts in {{location}}", owner: stay.owner, location: stay.location })}</p>
      <div className="booking-steps">
        <div><CalendarDays size={17} /><span>{t("rd.client.sampleStayDatesHyphen", { defaultValue: "May 18 - May 20" })}</span></div>
        <div><Users size={17} /><span>{t("rd.client.guestsCount", { defaultValue: "{{count}} guests", count: stay.guests })}</span></div>
        <div><BedDouble size={17} /><span>{t("rd.client.roomOptionSelected", { defaultValue: "{{count}} room option selected", count: stay.rooms })}</span></div>
      </div>
      <div className="bill-box">
        <div><span>{t("rd.client.twoNights", { defaultValue: "2 nights" })}</span><strong>Rs. {(stay.price * 2).toLocaleString()}</strong></div>
        <div><span>{t("rd.client.serviceFee", { defaultValue: "Service fee" })}</span><strong>Rs. 420</strong></div>
        <div><span>{t("rd.client.taxes", { defaultValue: "Taxes" })}</span><strong>Rs. 350</strong></div>
        <div className="total"><span>{t("rd.client.total", { defaultValue: "Total" })}</span><strong>Rs. {total.toLocaleString()}</strong></div>
      </div>
      <button className="pay-button" onClick={() => onBook(buildStayDraft(stay, t))}>
        <CreditCard size={18} /> {t("rd.client.continueToCheckout", { defaultValue: "Continue to checkout" })}
      </button>
      <small>{t("rd.client.mockCheckout", { defaultValue: "Mock checkout — no payment is taken in this preview." })}</small>
    </aside>
  );
}

function ServiceMiniCard({ service, onClick }: { service: Service; onClick: () => void }) {
  const Icon = service.icon;
  return (
    <button className="service-mini" onClick={onClick}>
      <img src={service.image} alt={service.title} loading="lazy" decoding="async" />
      <span><Icon size={17} /> {service.category}</span>
      <h3>{service.title}</h3>
      <p>{service.provider} - {service.nextSlot}</p>
      <strong>Rs. {service.price.toLocaleString()}</strong>
    </button>
  );
}

function ServiceCard({
  service,
  selected,
  onSelect,
  domId,
}: {
  service: Service;
  selected: boolean;
  onSelect: (service: Service) => void;
  domId?: string;
}) {
  const { t } = useLanguage();
  const { isServiceSaved, toggleSaveService } = useSaved();
  const saved = isServiceSaved(String(service.id));
  // Online-only services have no meaningful physical location, so the address
  // line is hidden for them — a provider home address would only mislead.
  // Mixed-mode (online + at-home / visit) still shows it since an in-person
  // mode makes the location relevant.
  const onlineOnly =
    Array.isArray(service.mode) && service.mode.length > 0 && service.mode.every((m) => m === "online");
  return (
    <button id={domId} className={`service-card ${selected ? "selected" : ""}`} onClick={() => onSelect(service)}>
      <div className="stay-image-wrap">
        <img src={service.image} alt={service.title} loading="lazy" decoding="async" />
        <span>{service.mainCategory || service.category}</span>
        {/* The card root is a real <button>, so the save control can't be a
            nested <button> (invalid HTML) — a keyboard-operable span mirrors
            the stay card's heart instead (see .save-heart in the CSS). */}
        <span
          role="button"
          tabIndex={0}
          className="save-heart"
          aria-label={saved ? t("rd.client.unsaveService", { defaultValue: "Unsave service" }) : t("rd.client.saveService", { defaultValue: "Save service" })}
          aria-pressed={saved}
          onClick={(e) => { e.stopPropagation(); toggleSaveService(String(service.id)); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleSaveService(String(service.id)); }
          }}
        >
          <Heart size={16} className={saved ? "fill-destructive text-destructive" : ""} />
        </span>
      </div>
      <div className="card-body">
        <div className="rating-line">
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {service.rating}</strong>
          <span>{t("rd.client.reviewsCount", { defaultValue: "{{count}} reviews", count: service.reviews })}</span>
        </div>
        <h3 className="one-line">{service.title}</h3>
        <p><Store size={14} /> <span className="one-line">{service.provider}</span></p>
        {!onlineOnly && (
          <p><MapPin size={14} /> <span className="one-line">{service.location}</span></p>
        )}
        <div className="price-row">
          <span><Clock3 size={15} /> {service.duration}</span>
          <strong>{servicePriceFromHint(service) ? `${t("rd.client.fromPrefix", { defaultValue: "from" })} ` : ""}Rs. {service.price.toLocaleString()}</strong>
        </div>
      </div>
    </button>
  );
}

/** Returns true when the headline `service.price` is a floor rather than
 *  the final amount — i.e. the catalog has multiple bases (different
 *  prices to pick from) OR any group has add-ons that stack on top. Drives
 *  the "from Rs. X" prefix on cards + booking summary so users don't
 *  expect the smallest number to be what they actually pay. Single-group,
 *  no-add-on listings render the flat price without the hint. */
function servicePriceFromHint(service: Service): boolean {
  const catalog = service.servicesCatalog;
  if (!Array.isArray(catalog) || catalog.length === 0) {
    // Pre-catalog fallback: treat the presence of any legacy add-on as
    // a stack-on-top signal, matching the prior detail-page rule.
    return Array.isArray(service.addOns) && service.addOns.length > 0;
  }
  if (catalog.length > 1) return true;
  return catalog.some((g) => g.addOns.length > 0);
}

function ServiceBookingPanel({
  service,
  mode,
  modeCopy,
  onBook,
}: {
  service: Service;
  mode: ServiceMode;
  modeCopy: string;
  onBook: (draft: MarketplaceBookingDraft) => void;
}) {
  const { t } = useLanguage();
  const fee = PLATFORM_FEE_RUPEES;
  const gst = Math.round((service.price + fee) * 0.18);
  const [slot, setSlot] = useState(service.nextSlot);

  // Reset selected slot when the service changes.
  useEffect(() => {
    setSlot(service.nextSlot);
  }, [service]);

  return (
    <aside className="booking-panel">
      <div className="panel-title-icon">
        <service.icon size={22} />
      </div>
      <h2>{service.title}</h2>
      <p>{service.provider} - {modeCopy}</p>
      <div className="booking-steps">
        <div><Clock3 size={17} /><span>{service.duration}</span></div>
        <div><MapPin size={17} /><span>{mode === "at-home" ? t("rd.client.customerAddressRequired", { defaultValue: "Customer address required" }) : service.location}</span></div>
      </div>
      <div className="grid gap-1.5 mt-3">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.client.pickASlot", { defaultValue: "Pick a slot" })}</p>
        <div className="flex flex-wrap gap-1.5">
          {service.slots.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSlot(option)}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
                slot === option
                  ? "bg-foreground text-white"
                  : "border border-border bg-white/80 text-foreground hover:bg-white"
              }`}
            >
              <CalendarDays size={12} /> {option}
            </button>
          ))}
        </div>
      </div>
      <div className="bill-box">
        <div><span>{t("rd.client.serviceCharge", { defaultValue: "Service charge" })}</span><strong>Rs. {service.price.toLocaleString()}</strong></div>
        <div><span>{t("rd.client.platformFee", { defaultValue: "Platform fee" })}</span><strong>Rs. {fee.toLocaleString()}</strong></div>
        <div><span>{t("rd.client.gst", { defaultValue: "GST" })}</span><strong>Rs. {gst.toLocaleString()}</strong></div>
        <div className="total"><span>{t("rd.client.total", { defaultValue: "Total" })}</span><strong>Rs. {(service.price + fee + gst).toLocaleString()}</strong></div>
      </div>
      <button className="pay-button" onClick={() => onBook(buildServiceDraft(service, mode, slot, t))}>
        <CalendarDays size={18} /> {t("rd.client.bookAppointment", { defaultValue: "Book appointment" })}
      </button>
      <small>{t("rd.client.slotHeld", { defaultValue: "Provider slot is held before payment." })}</small>
    </aside>
  );
}

function TransportMiniCard({ item, onClick }: { item: Transport; onClick: () => void }) {
  const { t } = useLanguage();
  return (
    <button className="transport-mini" onClick={onClick}>
      <img src={item.image} alt={item.vehicle} loading="lazy" decoding="async" />
      <div>
        <span>{item.type}</span>
        <h3>{item.driver}</h3>
        <p>{item.packages[0]}</p>
      </div>
      <strong>{headlineTransportRate(item, t)}</strong>
    </button>
  );
}

function TransportCard({
  item,
  selected,
  onSelect,
  domId,
}: {
  item: Transport;
  selected: boolean;
  onSelect: (item: Transport) => void;
  domId?: string;
}) {
  const { t } = useLanguage();
  const { isTransportSaved, toggleSaveTransport } = useSaved();
  const saved = isTransportSaved(String(item.id));
  return (
    <button id={domId} className={`transport-card ${selected ? "selected" : ""}`} onClick={() => onSelect(item)}>
      <div className="stay-image-wrap">
        <img src={item.image} alt={item.vehicle} loading="lazy" decoding="async" />
        <span>{item.type}</span>
        {/* Non-<button> save control — the card root is already a <button>
            (see the matching note in ServiceCard). */}
        <span
          role="button"
          tabIndex={0}
          className="save-heart"
          aria-label={saved ? t("rd.client.unsaveTransport", { defaultValue: "Unsave transport" }) : t("rd.client.saveTransport", { defaultValue: "Save transport" })}
          aria-pressed={saved}
          onClick={(e) => { e.stopPropagation(); toggleSaveTransport(String(item.id)); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleSaveTransport(String(item.id)); }
          }}
        >
          <Heart size={16} className={saved ? "fill-destructive text-destructive" : ""} />
        </span>
      </div>
      <div className="card-body">
        <div className="rating-line">
          <strong><Star size={14} fill="#f5b301" color="#f5b301" /> {item.rating}</strong>
          <span>{t("rd.client.tripsCount", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString() })}</span>
          <span className="verified"><BadgeCheck size={13} /> {t("rd.client.verified", { defaultValue: "Verified" })}</span>
        </div>
        <h3 className="one-line">{item.driver}</h3>
        <p><Car size={14} /> <span className="one-line">{item.vehicle}</span></p>
        <p><MapPin size={14} /> <span className="one-line">{item.area}</span></p>
        <div className="price-row">
          <span><Users size={15} /> {t("rd.client.seatsCount", { defaultValue: "Seats {{count}}", count: item.capacity })}</span>
          <strong>{headlineTransportRate(item, t)}</strong>
        </div>
      </div>
    </button>
  );
}

function TransportBookingPanel({
  item,
  mode,
  onBook,
}: {
  item: Transport;
  mode: TransportMode;
  onBook: (draft: MarketplaceBookingDraft) => void;
}) {
  const { t } = useLanguage();
  const amount =
    mode === "hourly" ? item.hourly * 4 :
    mode === "day" ? item.day :
    mode === "package" ? item.packageOptions[0]?.price ?? item.day + 800 :
    18 * item.perKm + 80;

  return (
    <aside className="booking-panel">
      <div className="panel-image">
        <img src={item.image} alt={item.vehicle} loading="lazy" decoding="async" />
        <span>{item.type}</span>
      </div>
      <h2>{item.driver}</h2>
      <p>{item.vehicle} - {item.area}</p>
      <div className="booking-steps">
        <div><Navigation size={17} /><span>{mode === "point" ? t("rd.client.kmEstimate18", { defaultValue: "18 km estimate" }) : mode === "package" ? item.packageOptions[0]?.label || t("rd.client.modeTourPackage", { defaultValue: "Tour package" }) : t("rd.client.rentalBooking", { defaultValue: "Rental booking" })}</span></div>
        <div><Clock3 size={17} /><span>{mode === "day" ? t("rd.client.modeFullDay", { defaultValue: "Full day" }) : mode === "hourly" ? t("rd.client.fourHours", { defaultValue: "4 hours" }) : mode === "package" ? t("rd.client.hoursCount", { defaultValue: "{{count}} hours", count: item.packageOptions[0]?.hours ?? 4 }) : t("rd.client.driverConfirmsTime", { defaultValue: "Driver confirms time" })}</span></div>
        <div><Languages size={17} /><span>{item.languages.join(", ")}</span></div>
        <div><Users size={17} /><span>{t("rd.client.seatsCount", { defaultValue: "Seats {{count}}", count: item.capacity })}</span></div>
      </div>
      <div className="bill-box">
        <div><span>{mode === "point" ? t("rd.client.rideEstimate", { defaultValue: "Ride estimate" }) : t("rd.client.packageEstimate", { defaultValue: "Package estimate" })}</span><strong>Rs. {amount.toLocaleString()}</strong></div>
        <div><span>{t("rd.client.driverConfirmation", { defaultValue: "Driver confirmation" })}</span><strong>{t("rd.client.included", { defaultValue: "Included" })}</strong></div>
        <div><span>{t("rd.client.support", { defaultValue: "Support" })}</span><strong>{t("rd.client.included", { defaultValue: "Included" })}</strong></div>
        <div className="total"><span>{t("rd.client.payNow", { defaultValue: "Pay now" })}</span><strong>Rs. {amount.toLocaleString()}</strong></div>
      </div>
      <button className="pay-button" onClick={() => onBook(buildTransportDraft(item, mode, t))}>
        <CreditCard size={18} /> {t("rd.client.requestAndPay", { defaultValue: "Request and pay" })}
      </button>
      <small>{t("rd.client.extraKmSettled", { defaultValue: "Final extra kilometers can be settled after driver confirmation." })}</small>
    </aside>
  );
}

function MapShowcase({ compact = false }: { compact?: boolean }) {
  const { t } = useLanguage();
  return (
    <div className={`map-showcase ${compact ? "compact" : ""}`}>
      <div className="map-topbar">
        <span><Map size={16} /> {t("rd.client.liveMap", { defaultValue: "IstaSeva live map" })}</span>
      </div>
      <div className="map-canvas" aria-label={t("rd.client.illustrativeMap", { defaultValue: "Illustrative local marketplace map" })}>
        <span className="road road-a" />
        <span className="road road-b" />
        <span className="road road-c" />
        <span className="pin stay"><Hotel size={17} /></span>
        <span className="pin service"><Scissors size={17} /></span>
        <span className="pin transport"><Car size={17} /></span>
        <span className="pin landmark"><Landmark size={17} /></span>
        <div className="map-card stay-card-map">
          <strong>{t("rd.client.mapHomestay", { defaultValue: "Homestay" })}</strong>
          <span>Rs. 1,450</span>
        </div>
        <div className="map-card route-card-map">
          <strong>{t("rd.client.mapTempleLoop", { defaultValue: "Temple loop" })}</strong>
          <span>{t("rd.client.mapStops", { defaultValue: "4 stops" })}</span>
        </div>
      </div>
    </div>
  );
}

function PartnerBand() {
  const { t } = useLanguage();
  // Each pill opens the AI-vs-form onboarding chooser for its vertical (the
  // same dialog the dashboards' "+ Add New" uses) instead of dropping the
  // visitor on an empty dashboard. Button order mirrors the heading:
  // service providers → drivers → hosts.
  const [chooserType, setChooserType] = useState<"host" | "service" | "transport" | null>(null);
  return (
    <section className="partner-band">
      <div>
        <p className="eyebrow"><Building2 size={16} /> {t("rd.client.partnerEyebrow", { defaultValue: "Partner operating system" })}</p>
        <h2>{t("rd.client.partnerHeading", { defaultValue: "One platform for Users, Service Providers, Drivers, and Hosts." })}</h2>
        <p>
          {t("rd.client.partnerBody", { defaultValue: "After the customer side is approved, the partner side can become a simple business dashboard with listings, calendar, payments, reviews, coupons, and AI help for pricing and response messages." })}
        </p>
      </div>
      <div className="partner-actions">
        <button onClick={() => setChooserType("service")}><Store size={18} /> {t("rd.client.addService", { defaultValue: "Add service" })}</button>
        <button onClick={() => setChooserType("transport")}><Car size={18} /> {t("rd.client.registerVehicle", { defaultValue: "Register vehicle" })}</button>
        <button onClick={() => setChooserType("host")}><Home size={18} /> {t("rd.client.listProperty", { defaultValue: "List property" })}</button>
      </div>
      <AddListingChooserDialog
        open={chooserType !== null}
        onOpenChange={(open) => { if (!open) setChooserType(null); }}
        type={chooserType ?? undefined}
      />
    </section>
  );
}

export default ClientRedesign;
