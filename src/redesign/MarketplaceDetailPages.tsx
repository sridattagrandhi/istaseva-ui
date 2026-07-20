// Full dedicated detail pages for the redesigned marketplace.
// Three exported route components: StayDetailPage, ServiceDetailPage,
// TransportDetailPage. Each is an Airbnb-style two-column layout — long-form
// content on the left, sticky booking summary on the right at lg+, stacked
// beneath on mobile. The actual booking inputs live in MarketplaceBookingModal
// which is opened from the right summary's "Book Now" CTA. This keeps the
// detail page calm and the commitment surface focused.

import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  Bath,
  BedDouble,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Globe2,
  Heart,
  Home,
  Image as ImageIcon,
  Languages,
  Map as MapIcon,
  MapPin,
  Navigation,
  ShieldCheck,
  Copy,
  Share2,
  Sparkles,
  Star,
  Store,
  Users,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSaved } from "@/contexts/SavedContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getReviewService } from "@/domains";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  useMarketplaceService,
  useMarketplaceStay,
  useMarketplaceTransportListing,
} from "@/hooks/use-marketplace-data";
import type {
  MarketplaceRoomType,
  MarketplaceService,
  MarketplaceStay,
  MarketplaceTransport,
  ServiceMode,
  TransportMode,
} from "@/types/marketplace";
import { MarketplaceBookingModal, type BookingRequest } from "./MarketplaceBookingModal";
// Lazy: maplibre-gl ships as its own chunk, loaded only when a detail page's
// location map renders (see the <Suspense> wrapper at the usage site).
const MapView = lazy(() => import("@/components/MapView"));
import {
  formatDwell,
  formatKmRange,
  summarizeWorkingWindow,
} from "@/lib/tour-package";
import { placeLine } from "@/lib/marketplace-adapters";
import "./client-redesign.css";

function rupee(n: number) { return `₹${n.toLocaleString("en-IN")}`; }

/** Reusable mini-map used on stay/service/transport detail pages. Falls
 *  back to a "no location yet" placeholder when the listing has no lat/lng
 *  so legacy rows render gracefully instead of an empty map tile. */
function DetailMapPreview({
  lat, lng, title, subtitle, address, color = "#8b5e4a", geoExact = true,
}: {
  lat?: number;
  lng?: number;
  title: string;
  subtitle?: string;
  address?: string;
  color?: string;
  /** False when the server sent privacy-approximated coords (unbooked
   *  viewer). Renders an area disc instead of a building-precise pin — the
   *  pin would point at whichever building happens to sit at the ~1km-rounded
   *  coordinate, claiming precision the data doesn't have. */
  geoExact?: boolean;
}) {
  const { t } = useLanguage();
  const hasCoords = typeof lat === "number" && typeof lng === "number"
    && Number.isFinite(lat) && Number.isFinite(lng);
  if (!hasCoords) {
    return (
      <div className="mt-3 flex h-44 items-center justify-center gap-2 rounded-xl border border-border bg-muted/40 text-xs font-semibold text-muted-foreground">
        <MapIcon className="h-4 w-4" /> {t("rd.detail.locationPreviewUnavailable", { defaultValue: "Location preview unavailable" })}
      </div>
    );
  }
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border">
      <Suspense fallback={<div style={{ height: "176px" }} className="w-full animate-pulse bg-gradient-to-br from-black/[0.04] to-black/[0.08]" aria-hidden="true" />}>
        {geoExact ? (
          <MapView
            markers={[{
              id: "detail-pin",
              lat: lat as number,
              lng: lng as number,
              title,
              subtitle,
              address,
              color,
              variant: "pin",
            }]}
            center={[lat as number, lng as number]}
            zoom={14}
            height="176px"
            popupMode="direct"
          />
        ) : (
          <MapView
            markers={[]}
            approxCircle={{ lat: lat as number, lng: lng as number, color }}
            center={[lat as number, lng as number]}
            zoom={13}
            searchCenter={{ lat: lat as number, lng: lng as number, zoom: 13 }}
            height="176px"
            popupMode="direct"
          />
        )}
      </Suspense>
    </div>
  );
}

/** Build a Google Maps URL from a free-text address or lat/lng. Prefers the
 *  address (so the destination card shows the place name); falls back to the
 *  coordinates when no address is available. */
function mapsUrl({ address, lat, lng }: { address?: string; lat?: number; lng?: number }) {
  if (address && address.trim()) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`;
  }
  if (typeof lat === "number" && typeof lng === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  return null;
}

/** Address rendered as an external link to Google Maps. Opens in a new tab
 *  with rel="noopener". Falls back to plain text when neither address nor
 *  coords are present. */
function AddressLink({ address, lat, lng }: { address?: string; lat?: number; lng?: number }) {
  const { t } = useLanguage();
  const href = mapsUrl({ address, lat, lng });
  const label = address && address.trim() ? address : t("rd.detail.viewOnMap", { defaultValue: "View on map" });
  if (!href) return <p className="text-sm text-muted-foreground">{label}</p>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm font-semibold text-foreground underline decoration-dotted underline-offset-4 hover:text-accent"
    >
      <MapPin className="h-3.5 w-3.5" />
      <span>{label}</span>
    </a>
  );
}

/** Map a `metadata.pricingUnit` slug to the "/ unit" suffix shown next to
 *  the headline rate. Falls back to "session" so a listing with no unit
 *  set reads identically to the pre-Phase-3 copy. */
function pricingUnitToLabel(unit: string | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string {
  switch (unit) {
    case "per_hour": return t("rd.detail.unitHour", { defaultValue: "hour" });
    case "per_visit": return t("rd.detail.unitVisit", { defaultValue: "visit" });
    case "per_session": return t("rd.detail.unitSession", { defaultValue: "session" });
    case "per_day": return t("rd.detail.unitDay", { defaultValue: "day" });
    case "fixed": return t("rd.detail.unitPackage", { defaultValue: "package" });
    default: return t("rd.detail.unitSession", { defaultValue: "session" });
  }
}

/** Subcard list of mode-specific delivery info for a service detail page.
 *  Renders one card per supported mode where the provider actually filled
 *  the relevant field — silently returns null when nothing useful exists. */
function ServiceModeDeliveryDetails({ service }: { service: MarketplaceService }) {
  const { t } = useLanguage();
  const cards: React.ReactNode[] = [];
  if (service.mode.includes("at-home") && service.serviceRadiusKm) {
    cards.push(
      <div key="at-home" className="rounded-2xl border border-border bg-white/80 p-3 sm:p-4">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.atYourHome", { defaultValue: "At your home" })}</p>
        <p className="mt-1 text-sm text-foreground">{t("rd.detail.travelsUpToFrom", { defaultValue: "Travels up to {{km}} km from {{location}}.", km: service.serviceRadiusKm, location: service.location })}</p>
      </div>
    );
  }
  if (service.mode.includes("visit-provider") && (service.visitAddress || service.geoExact === false)) {
    cards.push(
      <div key="visit" className="rounded-2xl border border-border bg-white/80 p-3 sm:p-4">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.visitTheProvider", { defaultValue: "Visit the provider" })}</p>
        <p className="mt-1 inline-flex items-start gap-1 text-sm text-foreground">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {/* WS6: the visit address is withheld for unbooked viewers unless
              the host opted in to a public address. Show the area label +
              the same "after booking" promise the stay page makes. */}
          {service.visitAddress
            ? <span>{service.visitAddress}</span>
            : <span>{service.location} · {t("rd.detail.approxLocation", { defaultValue: "This is the approximate area. The exact address is shared once your booking is confirmed." })}</span>}
        </p>
      </div>
    );
  }
  if (service.mode.includes("online") && service.meetingDetails) {
    cards.push(
      <div key="online" className="rounded-2xl border border-border bg-white/80 p-3 sm:p-4">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.onlineDelivery", { defaultValue: "Online delivery" })}</p>
        <p className="mt-1 inline-flex items-start gap-1 text-sm text-foreground">
          <Globe2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>{service.meetingDetails}</span>
        </p>
      </div>
    );
  }
  if (cards.length === 0) return null;
  return <div className="mt-3 grid gap-2">{cards}</div>;
}

// ──────────────────────────────────────────────────────────── Stay detail ──

export function StayDetailPage() {
  const { t } = useLanguage();
  const { id } = useParams<{ id: string }>();
  const { data: stay, isLoading, error, isFetching } = useMarketplaceStay(id);
  useEffect(() => { document.body.classList.add("client-redesign-active"); return () => document.body.classList.remove("client-redesign-active"); }, []);
  useEffect(() => { if (id) getAnalyticsEventsService().track("listing_viewed", { listingId: id, listingType: "stay", source: "stay_detail" }); }, [id]);
  const [booking, setBooking] = useState<BookingRequest | null>(null);
  const backToStays = t("rd.detail.backToStays", { defaultValue: "Back to stays" });
  const location = useLocation();
  const back = ((location.state as { from?: string } | null)?.from === "discovery")
    ? { href: "/", label: t("rd.detail.backToDiscovery", { defaultValue: "Back to discovery" }) }
    : { href: "/explore", label: backToStays };

  if (isLoading || (isFetching && !stay && !error)) {
    return (
      <PageShell back={back}>
        <StayDetailSkeleton />
      </PageShell>
    );
  }
  if (error) {
    return (
      <PageShell back={back}>
        <ContentCard>
          <Section title={t("rd.detail.couldntLoadStay", { defaultValue: "We couldn't load this stay" })}>
            <p className="text-sm text-muted-foreground">{(error as Error)?.message || t("rd.detail.somethingWentWrong", { defaultValue: "Something went wrong." })}</p>
            <Link to={back.href} className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-bold text-foreground shadow-sm transition-colors hover:bg-muted active:bg-muted/70">{back.label}</Link>
          </Section>
        </ContentCard>
      </PageShell>
    );
  }
  if (!stay) return <NotFoundDetail label={t("rd.detail.labelStay", { defaultValue: "stay" })} backHref={back.href} backLabel={back.label} />;
  return (
    <PageShell back={back}>
      <StayHeader stay={stay} />
      <StayGallery stay={stay} />
      <TwoColumn
        left={<StayLeftColumn stay={stay} onBookRoom={(roomId) => setBooking({ kind: "stay", stay, preselectedRoomId: roomId })} />}
        right={<StayBookingSummary stay={stay} onBook={(roomId) => setBooking({ kind: "stay", stay, preselectedRoomId: roomId })} />}
      />
      <MarketplaceBookingModal request={booking} onClose={() => setBooking(null)} />
    </PageShell>
  );
}

function StayHeader({ stay }: { stay: MarketplaceStay }) {
  const { t } = useLanguage();
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-accent">{stay.type}</p>
        <h1 className="font-display text-3xl font-extrabold leading-tight text-foreground sm:text-4xl">{stay.title}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <button type="button" onClick={scrollToReviews} className="inline-flex items-center gap-1 hover:underline"><Star className="h-4 w-4 fill-yellow-500 text-yellow-500" /> <strong className="text-foreground">{stay.rating}</strong> · {t("rd.detail.reviewsCount", { defaultValue: "{{count}} reviews", count: stay.reviews })}</button>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" /> {placeLine(stay.location, stay.district)}</span>
          {stay.verified && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-bold text-success"><BadgeCheck className="h-3 w-3" /> {t("rd.detail.verifiedHost", { defaultValue: "Verified host" })}</span>}
        </div>
      </div>
      <HeaderActions kind="stay" id={String(stay.id)} />
    </header>
  );
}

function StayGallery({ stay }: { stay: MarketplaceStay }) {
  const { t } = useLanguage();
  const images = stay.images && stay.images.length > 0 ? stay.images : Array.from({ length: 5 }, () => stay.image);
  // Show the standard 5-tile mosaic; if the listing has more than 5 photos
  // we surface a "See all" overlay on the bottom-right tile that opens the
  // full gallery modal. Hosts often upload 8–15 photos and the previous
  // layout silently truncated them past the 5th.
  const [galleryOpen, setGalleryOpen] = useState(false);
  const hasMore = images.length > 5;
  const lastTileIdx = 3; // index inside slice(1, 5) — the bottom-right tile
  return (
    <>
      <div className="mb-6 grid gap-2 sm:grid-cols-4">
        <div className="relative h-72 overflow-hidden rounded-2xl sm:col-span-2 sm:h-96">
          <img src={images[0]} alt={stay.title} decoding="async" {...({ fetchpriority: "high" } as Record<string, string>)} className="h-full w-full object-cover" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:col-span-2">
          {images.slice(1, 5).map((src, i) => (
            <div key={i} className="relative h-32 overflow-hidden rounded-2xl sm:h-[188px]">
              <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover opacity-95" />
              {hasMore && i === lastTileIdx && (
                <button
                  type="button"
                  onClick={() => setGalleryOpen(true)}
                  className="absolute bottom-2 right-2 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-[12px] font-bold text-foreground shadow-[0_8px_24px_rgba(34,31,39,0.18)] backdrop-blur transition-all hover:bg-white active:scale-95"
                >
                  <ImageIcon className="h-3.5 w-3.5" /> {t("rd.detail.seeAllPhotos", { defaultValue: "See all {{count}} photos", count: images.length })}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {galleryOpen && (
        <PhotoGalleryModal
          images={images}
          title={stay.title}
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Fullscreen photo grid that overlays the page when the host has more than
 * five gallery images. Closes via the top-right X button, a backdrop click,
 * or the Escape key. We lock body scroll while open so the underlying page
 * doesn't jump around as the user scrolls the gallery.
 */
function PhotoGalleryModal({
  images, title, onClose,
}: {
  images: string[];
  title: string;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // The sticky top-bar/nav sits at z-50 inside the .client-redesign stacking
  // context. Putting the modal at z-50 in the body context turned out to be
  // unreliable on Safari — the nav rendered ON TOP of the modal and stole
  // pointer events from the X button + backdrop. We sit at z-40 so the nav
  // stays interactive (the user explicitly wanted the gallery to "touch"
  // the nav, not cover it) and offset the modal content below the topbar
  // height (~88px on desktop, ~76px on mobile via `top-[var(--nav-h)]`).
  // The whole modal area below the nav is still a backdrop click target —
  // the inner scrollable region stops propagation so a tap on a photo
  // doesn't accidentally close it.
  const NAV_OFFSET = "5.5rem"; // 88px — topbar (14px margin + 10px padding + content)
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col bg-foreground/90 backdrop-blur-sm"
      style={{ top: NAV_OFFSET }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("rd.detail.photosOf", { defaultValue: "Photos of {{title}}", title })}
    >
      <header
        className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-bold text-white">{t("rd.detail.titlePhotosCount", { defaultValue: "{{title}} · {{count}} photos", title, count: images.length })}</p>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label={t("rd.detail.closePhotoGallery", { defaultValue: "Close photo gallery" })}
          className="inline-grid h-9 w-9 place-items-center rounded-full bg-white/90 text-foreground shadow-md transition-all hover:bg-white active:scale-95"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div
        className="flex-1 overflow-y-auto px-4 pb-8 sm:px-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto grid max-w-5xl gap-3 sm:grid-cols-2">
          {images.map((src, i) => (
            <div key={i} className="overflow-hidden rounded-2xl bg-white/10">
              <img
                src={src}
                alt={t("rd.detail.photoAlt", { defaultValue: "{{title}} photo {{num}}", title, num: i + 1 })}
                loading="lazy"
                className="w-full object-cover"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatCheckTime(hhmm?: string, fallback?: string): string {
  const raw = (hhmm && hhmm.trim()) || fallback || "";
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return raw;
  const h = parseInt(m[1], 10);
  const minutes = m[2];
  if (Number.isNaN(h)) return raw;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${minutes} ${period}`;
}

function StayLeftColumn({ stay, onBookRoom }: { stay: MarketplaceStay; onBookRoom?: (roomId: string) => void }) {
  const { t } = useLanguage();
  // Hotel-style listings keep distinct room types (Deluxe, Suite, ...). For
  // those the listing-level bedrooms/bathrooms/guests numbers don't describe
  // the *property*, they describe one arbitrary room — so we hide them here
  // and let the Room options card carry that detail. Home-style listings
  // (homestay / villa / single rental) get the guests + bedrooms + bathrooms
  // stat row instead.
  const hasMultipleRoomTypes = !!stay.roomTypes && stay.roomTypes.length > 1;
  const isHotelLike = hasMultipleRoomTypes;
  const bedrooms = stay.bedrooms ?? (isHotelLike ? undefined : stay.rooms);
  const bathrooms = stay.bathrooms;
  const checkIn = formatCheckTime(stay.checkInTime, "14:00");
  const checkOut = formatCheckTime(stay.checkOutTime, "11:00");

  return (
    <div className="grid gap-6">
      <ContentCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t("rd.detail.hostedBy", { defaultValue: "Hosted by {{owner}}", owner: stay.owner })}</h2>
            <p className="text-sm text-muted-foreground">
              {isHotelLike ? (
                <>
                  {t("rd.detail.roomTypesUpToGuests", { defaultValue: "{{count}} room types · up to {{guests}} guests", count: stay.roomTypes!.length, guests: stay.guests })}
                </>
              ) : (
                <>
                  {t("rd.detail.upToGuests", { defaultValue: "Up to {{count}} guests", count: stay.guests })}
                  {bedrooms != null && <> · {t("rd.detail.bedroomsCount", { defaultValue: "{{count}} bedrooms", count: bedrooms })}</>}
                  {bathrooms != null && <> · {t("rd.detail.bathroomsCount", { defaultValue: "{{count}} bathrooms", count: bathrooms })}</>}
                </>
              )}
              {stay.hostMeta?.since && <> · {t("rd.detail.hostingSince", { defaultValue: "hosting since {{since}}", since: stay.hostMeta.since })}</>}
            </p>
          </div>
          {isHotelLike ? (
            <StatTile icon={<BedDouble className="h-4 w-4" />} label={t("rd.detail.roomTypes", { defaultValue: "Room types" })} value={String(stay.roomTypes!.length)} />
          ) : (
            <StatTile icon={<BedDouble className="h-4 w-4" />} label={t("rd.detail.bedrooms", { defaultValue: "Bedrooms" })} value={bedrooms != null ? String(bedrooms) : "—"} />
          )}
        </div>
        {(checkIn || checkOut) && (
          <div className="mt-1 grid grid-cols-2 gap-2 rounded-2xl border border-border bg-white/70 p-3 text-sm">
            <div>
              <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.checkIn", { defaultValue: "Check-in" })}</p>
              <p className="mt-0.5 font-bold text-foreground">{t("rd.detail.afterTime", { defaultValue: "After {{time}}", time: checkIn || "—" })}</p>
            </div>
            <div>
              <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.checkOut", { defaultValue: "Check-out" })}</p>
              <p className="mt-0.5 font-bold text-foreground">{t("rd.detail.beforeTime", { defaultValue: "Before {{time}}", time: checkOut || "—" })}</p>
            </div>
          </div>
        )}
        {stay.hostMeta && (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {stay.hostMeta.responsiveness && <Chip><Clock3 className="h-3 w-3" /> {stay.hostMeta.responsiveness}</Chip>}
            {stay.hostMeta.languages?.map((l) => <Chip key={l}><Languages className="h-3 w-3" /> {l}</Chip>)}
          </div>
        )}
        <Section title={t("rd.detail.aboutThisPlace", { defaultValue: "About this place" })}>
          <p className="text-sm leading-relaxed text-muted-foreground">{stay.description}</p>
        </Section>
        {stay.roomTypes && stay.roomTypes.length > 1 && (
          <Section title={t("rd.detail.roomOptions", { defaultValue: "Room options" })}>
            <div className="grid gap-2 sm:grid-cols-2">
              {stay.roomTypes.map((r) => <RoomTypePreview key={r.id} room={r} onBook={onBookRoom ? () => onBookRoom(r.id) : undefined} />)}
            </div>
          </Section>
        )}
        {/* "Highlights" tag pills removed per product feedback — they were
            auto-generated marketing-style labels (e.g. "PILGRIM-FRIENDLY",
            "FAMILIES") that added clutter without telling the guest
            anything actionable. Tags still live on the listing record for
            search/filter purposes; we just don't render them as a section. */}
        {(() => {
          // For multi-room stays each room class authors its own amenities
          // (rendered inside RoomTypePreview above). For multi-room stays
          // we drop the property-level amenity section entirely — the old
          // "Shared amenities" label was misleading because listing-level
          // amenities aren't guaranteed to apply to every room, and there's
          // no signal that they truly are shared. Per-room chips are the
          // single source of truth. Single-unit stays still get the
          // section since their listing-level amenities ARE the room's
          // amenities by definition.
          const rooms = stay.roomTypes ?? [];
          const isMultiRoom = rooms.length > 0;
          if (isMultiRoom) return null;
          return (
            <Section title={t("rd.detail.amenities", { defaultValue: "Amenities" })}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {stay.amenities.map((a) => (
                  <div key={a} className="flex items-center gap-2 rounded-xl border border-border bg-white/70 px-3 py-2 text-xs font-semibold text-foreground">
                    <Check className="h-3.5 w-3.5 text-success" /> {a}
                  </div>
                ))}
              </div>
            </Section>
          );
        })()}
      </ContentCard>
      <ContentCard>
        <Section title={t("rd.detail.whereYoullBe", { defaultValue: "Where you'll be" })}>
          <AddressLink
            address={placeLine(stay.location, stay.district)}
            lat={stay.lat}
            lng={stay.lng}
          />
          <DetailMapPreview
            lat={stay.lat}
            lng={stay.lng}
            title={stay.title}
            subtitle={stay.type}
            address={placeLine(stay.location, stay.district)}
            color="#8b5e4a"
            geoExact={stay.geoExact !== false}
          />
          {stay.geoExact === false && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <MapIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("rd.detail.approxLocation", { defaultValue: "This is the approximate area. The exact address is shared once your booking is confirmed." })}
            </p>
          )}
        </Section>
      </ContentCard>
      <ContentCard>
        <ReviewsSection
          listingId={stay.id}
          fallbackRating={stay.rating}
          fallbackCount={stay.reviews}
          emptyHint={t("rd.detail.stayReviewsEmpty", { defaultValue: "Be the first to share an experience after your stay." })}
        />
      </ContentCard>
      <FreeCancellationNote />
    </div>
  );
}

/** Anchor shared by the header rating pill (click → scroll here) and the
 *  ReviewsSection below it on every detail page. */
const REVIEWS_ANCHOR_ID = "rd-reviews-section";
function scrollToReviews() {
  document.getElementById(REVIEWS_ANCHOR_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** "Jun 2026" — month-level granularity keeps rows tidy and avoids implying
 *  a precision reviewers don't care about. Empty when createdAt is missing
 *  or unparseable (legacy rows). */
function reviewMonthYear(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

/** One review — avatar initial, name + date, rating badge, text. Shared by
 *  the in-page top-3 list and the "all reviews" dialog so both read the same. */
function ReviewRow({ review }: { review: { id: string; displayName: string; rating: number; reviewText?: string | null; createdAt?: string } }) {
  const date = reviewMonthYear(review.createdAt);
  const initial = (review.displayName || "?").trim().charAt(0).toUpperCase();
  return (
    <li className="py-4 first:pt-2 last:pb-2">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] font-display text-sm font-bold text-foreground">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-foreground">{review.displayName}</p>
          {date && <p className="text-[11px] font-medium text-muted-foreground">{date}</p>}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-1 text-xs font-bold text-foreground">
          <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" /> {review.rating.toFixed(1)}
        </span>
      </div>
      {review.reviewText && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{review.reviewText}</p>
      )}
    </li>
  );
}

/** Reusable review block used by stay / service / transport detail pages.
 *  All three call `GET /api/reviews/listing/:id` — the backend resolves to
 *  stay_id reviews for stays and provider_id reviews (via the listing's
 *  provider_profile) for service/transport. */
function ReviewsSection({
  listingId,
  fallbackRating,
  fallbackCount,
  emptyHint,
}: {
  listingId: string | number;
  fallbackRating: number;
  fallbackCount: number;
  emptyHint: string;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  // Dialog filter/sort — mirrors mobile's ReviewsModal (detailParts.tsx):
  // star-tier chips + recent/highest/lowest pills, client-side only.
  const [starFilter, setStarFilter] = useState<"all" | 1 | 2 | 3 | 4 | 5>("all");
  const [sort, setSort] = useState<"recent" | "highest" | "lowest">("recent");
  const idForBackend = typeof listingId === "string" ? listingId : null;
  const { data, isLoading } = useQuery({
    queryKey: ["reviews", "listing", idForBackend],
    enabled: !!idForBackend,
    queryFn: async () => {
      const result = await getReviewService().getByListingId(idForBackend as string);
      return result.success && result.data ? result.data : [];
    },
  });
  const reviews = useMemo(() => data ?? [], [data]);
  const count = reviews.length;
  const avg = count > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / count : 0;
  const top = reviews.slice(0, 3);
  // Star distribution buckets a review's rating into 1..5 by rounding —
  // a 4.5 lands in the "5" bucket, a 4.2 in the "4" bucket. Reviews
  // outside 1..5 are ignored. We show the bars from 5 → 1 so the most
  // common (typically 5★) is visually anchored at the top.
  const buckets: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) {
    const tier = Math.max(1, Math.min(5, Math.round(r.rating))) as 1 | 2 | 3 | 4 | 5;
    buckets[tier] += 1;
  }
  // Same 1..5 rounding as the distribution buckets, so a chip's count always
  // matches its bar in the summary.
  const visibleReviews = useMemo(() => {
    const filtered = starFilter === "all"
      ? reviews
      : reviews.filter((r) => Math.max(1, Math.min(5, Math.round(r.rating))) === starFilter);
    return [...filtered].sort((a, b) =>
      sort === "recent"
        ? +new Date(b.createdAt) - +new Date(a.createdAt)
        : sort === "highest"
          ? b.rating - a.rating
          : a.rating - b.rating,
    );
  }, [reviews, starFilter, sort]);

  return (
    <>
      <Section id={REVIEWS_ANCHOR_ID} title={t("rd.detail.reviews", { defaultValue: "Reviews" })}>
        <div className="flex items-baseline gap-3">
          <span className="font-display text-2xl font-extrabold text-foreground">
            {count > 0 ? avg.toFixed(1) : (fallbackRating > 0 ? fallbackRating.toFixed(1) : "—")}
          </span>
          <span className="text-sm text-muted-foreground">
            {count > 0
              ? t("rd.detail.reviewsCount", { defaultValue: "{{count}} reviews", count })
              : fallbackCount > 0
                ? t("rd.detail.reviewsCount", { defaultValue: "{{count}} reviews", count: fallbackCount })
                : t("rd.detail.noReviewsYet", { defaultValue: "No reviews yet" })}
          </span>
        </div>
        {count > 0 && (
          <div className="mt-3 grid gap-1.5">
            {([5, 4, 3, 2, 1] as const).map((tier) => {
              const n = buckets[tier];
              const pct = count === 0 ? 0 : Math.round((n / count) * 100);
              return (
                <div key={tier} className="flex items-center gap-2">
                  <span className="inline-flex w-6 items-center justify-end gap-0.5 text-[11px] font-bold text-muted-foreground">
                    {tier}
                    <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
                  </span>
                  <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-yellow-400"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="w-8 text-right text-[11px] font-semibold text-muted-foreground">{n}</span>
                </div>
              );
            })}
          </div>
        )}
        {isLoading && (
          <p className="mt-2 text-xs text-muted-foreground">{t("rd.detail.loadingReviews", { defaultValue: "Loading reviews…" })}</p>
        )}
        {!isLoading && top.length > 0 && (
          <ul className="mt-2 divide-y divide-border/60">
            {top.map((r) => (
              <ReviewRow key={r.id} review={r} />
            ))}
          </ul>
        )}
        {!isLoading && count === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">{emptyHint}</p>
        )}
        {count > 3 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-foreground/60 bg-white/80 px-5 py-2.5 text-sm font-bold text-foreground shadow-sm transition-all hover:border-foreground hover:bg-foreground hover:text-white sm:w-auto"
          >
            {t("rd.detail.showAllReviews", { defaultValue: "Show all {{count}} reviews", count })}
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </Section>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setStarFilter("all");
            setSort("recent");
          }
        }}
      >
        <DialogContent className="max-w-lg gap-0 p-0">
          <DialogHeader className="border-b border-border/60 px-6 pb-4 pt-6">
            <DialogTitle className="font-display text-lg font-extrabold text-foreground">
              {t("rd.detail.reviews", { defaultValue: "Reviews" })}
            </DialogTitle>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />
              <strong className="font-bold text-foreground">{avg.toFixed(1)}</strong>
              <span aria-hidden>·</span>
              {t("rd.detail.reviewsCount", { defaultValue: "{{count}} reviews", count })}
            </p>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-6 py-3">
            {(["all", 5, 4, 3, 2, 1] as const).map((f) => (
              <button
                key={String(f)}
                type="button"
                aria-pressed={starFilter === f}
                onClick={() => setStarFilter(f)}
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
                  starFilter === f
                    ? "bg-foreground text-white shadow-sm"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {f === "all"
                  ? t("rd.reviews.filterAll", { defaultValue: "All" })
                  : <>{f} <Star className="h-3 w-3 fill-current" /></>}
              </button>
            ))}
            <span className="mx-1.5 h-4 w-px bg-border" aria-hidden />
            {(["recent", "highest", "lowest"] as const).map((sortKey) => (
              <button
                key={sortKey}
                type="button"
                aria-pressed={sort === sortKey}
                onClick={() => setSort(sortKey)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
                  sort === sortKey
                    ? "bg-foreground text-white shadow-sm"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {sortKey === "recent"
                  ? t("rd.reviews.sortRecent", { defaultValue: "Recent" })
                  : sortKey === "highest"
                    ? t("rd.reviews.sortHighest", { defaultValue: "Highest" })
                    : t("rd.reviews.sortLowest", { defaultValue: "Lowest" })}
              </button>
            ))}
          </div>
          <ul className="max-h-[55vh] divide-y divide-border/60 overflow-y-auto px-6 py-2">
            {visibleReviews.map((r) => (
              <ReviewRow key={r.id} review={r} />
            ))}
            {visibleReviews.length === 0 && starFilter !== "all" && (
              <li className="py-10 text-center">
                <Star className="mx-auto h-6 w-6 text-muted-foreground/40" />
                <p className="mt-2 text-sm font-semibold text-muted-foreground">
                  {t("rd.reviews.noneForStars", { defaultValue: "No {{stars}}★ reviews yet", stars: starFilter })}
                </p>
              </li>
            )}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RoomTypePreview({ room, onBook }: { room: MarketplaceRoomType; onBook?: () => void }) {
  const { t } = useLanguage();
  const body = (
    <>
      {/* Per-room hero image when the host uploaded one. Falls silently to
          the description-only layout otherwise — adapters populate `image`
          from `room_types[].photos[0]`, which legacy rows leave empty. */}
      {room.image && (
        <div className="aspect-[16/9] w-full overflow-hidden bg-muted">
          <img
            src={room.image}
            alt={room.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="p-3">
      <p className="font-display text-base font-bold text-foreground">{room.name}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" /> {t("rd.detail.sleeps", { defaultValue: "Sleeps {{count}}", count: room.sleeps })}</span>
        <span className="inline-flex items-center gap-1"><Home className="h-3 w-3" /> {t("rd.detail.bedroomShort", { defaultValue: "{{count}} bedroom", count: room.bedrooms })}</span>
        <span className="inline-flex items-center gap-1"><Bath className="h-3 w-3" /> {t("rd.detail.bathShort", { defaultValue: "{{count}} bath", count: room.bathrooms })}</span>
      </p>
      {room.description && <p className="mt-1 text-xs text-muted-foreground">{room.description}</p>}
      {room.amenities && room.amenities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {room.amenities.map((a) => (
            <span
              key={a}
              className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
            >
              {a}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-foreground">{rupee(room.price)}<span className="text-xs font-semibold text-muted-foreground">{t("rd.detail.perNight", { defaultValue: "/night" })}</span></p>
        {onBook && (
          <span className="inline-flex items-center gap-0.5 text-xs font-extrabold text-foreground">
            {t("rd.detail.reserve", { defaultValue: "Reserve" })} <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        )}
      </div>
      </div>
    </>
  );
  // When a booking handler is supplied (multi-room stays) the whole card is a
  // button that opens the booking modal preselected to this room. Falls back
  // to a static card when no handler is passed.
  if (onBook) {
    return (
      <button
        type="button"
        onClick={onBook}
        aria-label={t("rd.detail.reserveRoom", { defaultValue: "Reserve {{room}}", room: room.name })}
        className="group block w-full overflow-hidden rounded-2xl border border-border bg-white/80 text-left transition-all hover:border-foreground/40 hover:shadow-[0_12px_30px_rgba(34,31,39,0.10)] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
      >
        {body}
      </button>
    );
  }
  return <div className="overflow-hidden rounded-2xl border border-border bg-white/80">{body}</div>;
}

/**
 * Right-column sticky summary for the stay detail page. Stays compact — the
 * actual reservation form lives in <MarketplaceBookingModal/>. If the listing
 * exposes roomTypes, the summary becomes a room picker; otherwise it's a
 * single price + Book Now CTA.
 */
function StayBookingSummary({
  stay, onBook,
}: { stay: MarketplaceStay; onBook: (roomId?: string) => void }) {
  const { t } = useLanguage();
  const hasRooms = !!stay.roomTypes && stay.roomTypes.length > 0;
  const [roomId, setRoomId] = useState<string>(stay.roomTypes?.[0]?.id ?? "");
  const selectedRoom = stay.roomTypes?.find((r) => r.id === roomId) ?? null;
  const priceNow = selectedRoom?.price ?? stay.price;
  const original = stay.originalPrice;
  return (
    <section className="grid gap-3 rounded-[18px] border border-white/70 bg-white/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_22px_70px_rgba(34,31,39,0.13)] backdrop-blur-xl sm:p-5">
      <header className="flex items-end justify-between gap-2">
        <div>
          <p className="flex items-baseline gap-2">
            {original && original > priceNow && <span className="text-sm text-muted-foreground line-through">{rupee(original)}</span>}
            <span className="font-display text-2xl font-extrabold text-foreground">{rupee(priceNow)}</span>
            <span className="text-sm font-semibold text-muted-foreground">{t("rd.detail.slashNight", { defaultValue: "/ night" })}</span>
          </p>
          {selectedRoom && <p className="text-[11px] font-bold text-muted-foreground">{selectedRoom.name}</p>}
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-bold text-foreground">
          <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" /> {stay.rating}
          <span className="text-muted-foreground"> · {stay.reviews}</span>
        </span>
      </header>

      {hasRooms && (
        <div className="grid gap-2">
          <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.selectARoom", { defaultValue: "Select a room" })}</p>
          <div className="grid gap-1.5">
            {stay.roomTypes!.map((r) => {
              const active = r.id === roomId;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRoomId(r.id)}
                  className={`grid grid-cols-[32px_1fr_auto] items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all ${
                    active ? "border-foreground bg-foreground/[0.04]" : "border-border bg-white/85 hover:bg-white"
                  }`}
                >
                  <span className={`inline-grid h-8 w-8 place-items-center rounded-lg ${active ? "bg-foreground text-white" : "bg-muted text-foreground"}`}><BedDouble className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-foreground">{r.name}</span>
                    <span className="block text-[10px] font-semibold text-muted-foreground">{t("rd.detail.roomSummary", { defaultValue: "Sleeps {{sleeps}} · {{bedrooms}} bed · {{bathrooms}} bath", sleeps: r.sleeps, bedrooms: r.bedrooms, bathrooms: r.bathrooms })}</span>
                  </span>
                  <span className="text-right text-xs font-extrabold text-foreground">{rupee(r.price)}<span className="block text-[9px] font-semibold text-muted-foreground">{t("rd.detail.perNight", { defaultValue: "/night" })}</span></span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <BookButton onClick={() => onBook(hasRooms ? roomId : undefined)}>{t("rd.detail.bookNow", { defaultValue: "Book Now" })}</BookButton>
      <p className="text-center text-[11px] font-semibold text-muted-foreground">{t("rd.detail.notChargedYet", { defaultValue: "You won't be charged yet" })}</p>
    </section>
  );
}

// ───────────────────────────────────────────────────────── Service detail ──

export function ServiceDetailPage() {
  const { t } = useLanguage();
  const { id } = useParams<{ id: string }>();
  // Real backend lookup only. We no longer fall through to the mock catalog
  // when the backend has nothing — a 404 on a real listing id should show the
  // empty/not-found state, not silently render demo data the user can't book.
  const { data: service, isLoading } = useMarketplaceService(id);
  useEffect(() => { document.body.classList.add("client-redesign-active"); return () => document.body.classList.remove("client-redesign-active"); }, []);
  useEffect(() => { if (id) getAnalyticsEventsService().track("listing_viewed", { listingId: id, listingType: "service", source: "service_detail" }); }, [id]);
  const [booking, setBooking] = useState<BookingRequest | null>(null);
  // Catalog configurator state — the user picks a service group and toggles
  // its add-ons on the detail page; the Book CTA carries all of it into the
  // modal. Group + add-ons live here (not in the left column) so the
  // right-column summary can price them live and the Book button can send
  // them. Add-ons reset whenever the group changes (they're per-group).
  const [groupId, setGroupId] = useState<string | null>(null);
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  useEffect(() => { setGroupId(service?.servicesCatalog?.[0]?.id ?? null); setAddOnIds([]); }, [service?.id]);
  const backToServices = t("rd.detail.backToServices", { defaultValue: "Back to services" });
  const location = useLocation();
  const back = ((location.state as { from?: string } | null)?.from === "discovery")
    ? { href: "/", label: t("rd.detail.backToDiscovery", { defaultValue: "Back to discovery" }) }
    : { href: "/services", label: backToServices };

  if (isLoading && !service) {
    return (
      <PageShell back={back}>
        <ContentCard>
          <Section title={t("rd.detail.loadingService", { defaultValue: "Loading service…" })}><p className="text-sm text-muted-foreground">{t("rd.detail.oneMoment", { defaultValue: "One moment." })}</p></Section>
        </ContentCard>
      </PageShell>
    );
  }
  if (!service) return <NotFoundDetail label={t("rd.detail.labelService", { defaultValue: "service" })} backHref={back.href} backLabel={back.label} />;
  const catalog = service.servicesCatalog ?? [];
  const effGroupId = groupId ?? catalog[0]?.id ?? null;
  const toggleAddOn = (aid: string) => setAddOnIds((cur) => cur.includes(aid) ? cur.filter((x) => x !== aid) : [...cur, aid]);
  return (
    <PageShell back={back}>
      <ServiceHeader service={service} />
      <SimpleHero image={service.image} images={service.images} />
      <TwoColumn
        left={<ServiceLeftColumn
          service={service}
          selectedGroupId={effGroupId}
          selectedAddOnIds={addOnIds}
          onSelectGroup={(gid) => { setGroupId(gid); setAddOnIds([]); }}
          onToggleAddOn={toggleAddOn}
        />}
        right={<ServiceBookingSummary
          service={service}
          selectedGroupId={effGroupId}
          selectedAddOnIds={addOnIds}
          onBook={(mode) => setBooking({
            kind: "service",
            service,
            preselectedMode: mode,
            preselectedGroupId: effGroupId ?? undefined,
            preselectedAddOnIds: addOnIds.length ? addOnIds : undefined,
          })}
        />}
      />
      <MarketplaceBookingModal request={booking} onClose={() => setBooking(null)} />
    </PageShell>
  );
}

function ServiceHeader({ service }: { service: MarketplaceService }) {
  const { t } = useLanguage();
  const Icon = service.icon;
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {/* MAIN CATEGORY eyebrow on top, sub-skills row directly under.
            Mirrors the service-card layout so users get the same broad-→-
            specific reading order on the detail page. Subcategory row is
            only shown when the provider has set at least one sub-skill. */}
        <p className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-accent"><Icon className="h-3.5 w-3.5" /> {service.mainCategory || service.category}</p>
        {service.subcategories && service.subcategories.length > 0 && (
          <p className="mt-0.5 text-xs font-semibold text-muted-foreground">{service.subcategories.join(" · ")}</p>
        )}
        <h1 className="font-display text-3xl font-extrabold leading-tight text-foreground sm:text-4xl">{service.title}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <button type="button" onClick={scrollToReviews} className="inline-flex items-center gap-1 hover:underline"><Star className="h-4 w-4 fill-yellow-500 text-yellow-500" /> <strong className="text-foreground">{service.rating}</strong> · {t("rd.detail.reviewsCount", { defaultValue: "{{count}} reviews", count: service.reviews })}</button>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" /> {service.location}</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-bold text-success"><BadgeCheck className="h-3 w-3" /> {t("rd.detail.verifiedProvider", { defaultValue: "Verified provider" })}</span>
        </div>
      </div>
      <HeaderActions kind="service" id={String(service.id)} />
    </header>
  );
}

function ServiceLeftColumn({ service, selectedGroupId, selectedAddOnIds, onSelectGroup, onToggleAddOn }: {
  service: MarketplaceService;
  selectedGroupId: string | null;
  selectedAddOnIds: string[];
  onSelectGroup: (groupId: string) => void;
  onToggleAddOn: (addOnId: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-6">
      <ContentCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t("rd.detail.byProvider", { defaultValue: "By {{provider}}", provider: service.provider })}</h2>
            <p className="text-sm text-muted-foreground">{t("rd.detail.sessionLengthNextSlot", { defaultValue: "Session length · {{duration}} · Next slot {{nextSlot}}", duration: service.duration, nextSlot: service.nextSlot })}</p>
          </div>
          <StatTile icon={<Clock3 className="h-4 w-4" />} label={t("rd.detail.duration", { defaultValue: "Duration" })} value={service.duration} />
        </div>
        <Section title={t("rd.detail.aboutThisService", { defaultValue: "About this service" })}>
          <p className="text-sm leading-relaxed text-muted-foreground">{service.description}</p>
        </Section>
        <ServicesCatalogDisplay
          service={service}
          selectedGroupId={selectedGroupId}
          selectedAddOnIds={selectedAddOnIds}
          onSelectGroup={onSelectGroup}
          onToggleAddOn={onToggleAddOn}
        />
        <Section title={t("rd.detail.serviceModesAvailable", { defaultValue: "Service modes available" })}>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(["at-home", "visit-provider", "online"] as ServiceMode[]).filter((m) => service.mode.includes(m)).map((m) => (
              <span key={m} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white/80 px-2.5 py-1 text-[11px] font-bold text-foreground">
                {serviceModeIcon(m)} {serviceModeLabel(m, t)}
              </span>
            ))}
          </div>
          {/* Mode-specific delivery info from listing metadata. Each subcard
              renders only when the corresponding mode is supported AND the
              provider filled the field — falls silently to nothing when the
              listing predates the mode-aware onboarding, so legacy rows
              don't show empty/placeholder boxes. */}
          <ServiceModeDeliveryDetails service={service} />
        </Section>
        {/* "What's included" and "Preparation notes" were canned boilerplate
            — they applied generically to every listing regardless of category
            and added visual noise without telling the user anything specific.
            Removed per product feedback; if we ever want this back, it should
            be provider-authored copy on the listing, not a static template. */}
        {/* Show a map when the service has a physical location worth
            pinning — either the provider's base (at-home, with travel
            radius) or the shop/clinic address (visit-provider). Online-only
            listings have nothing to pin, so we skip in that case.
            Title + body copy adapt to which mode applies; if both are
            present we keep the at-home framing because the travel radius
            is the more informative piece. */}
        {(service.mode.includes("at-home") || service.mode.includes("visit-provider")) && (() => {
          const isAtHome = service.mode.includes("at-home");
          // For visit-provider-only services the displayed address should be
          // the shop's `visitAddress` (collected in step 2 of onboarding),
          // not the provider's base location — the base may be blank now
          // that we hide "Where you are" for non-at-home services.
          const displayAddress = isAtHome
            ? service.location
            : (service.visitAddress || service.location);
          return (
            <Section title={isAtHome ? t("rd.detail.serviceArea", { defaultValue: "Service area" }) : t("rd.detail.whereToVisit", { defaultValue: "Where to visit" })}>
              <div className="flex flex-wrap items-center gap-2">
                <AddressLink address={displayAddress} lat={service.lat} lng={service.lng} />
                {isAtHome && service.serviceRadiusKm ? (
                  <span className="text-xs font-semibold text-muted-foreground">{t("rd.detail.travelsUpToKm", { defaultValue: "· travels up to {{km}} km", km: service.serviceRadiusKm })}</span>
                ) : null}
              </div>
              <DetailMapPreview
                lat={service.lat}
                lng={service.lng}
                title={service.title}
                subtitle={service.category}
                address={displayAddress}
                geoExact={service.geoExact !== false}
              />
              {/* WS6: mirror the stay page's approximate-area note whenever
                  this viewer got fuzzed geo (and, for visit-provider, a
                  withheld address). */}
              {service.geoExact === false && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <MapIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t("rd.detail.approxLocation", { defaultValue: "This is the approximate area. The exact address is shared once your booking is confirmed." })}
                </p>
              )}
            </Section>
          );
        })()}
      </ContentCard>
      <ContentCard>
        <ReviewsSection
          listingId={service.id}
          fallbackRating={service.rating}
          fallbackCount={service.reviews}
          emptyHint={t("rd.detail.serviceReviewsEmpty", { defaultValue: "No reviews yet — be the first to book and share your experience." })}
        />
      </ContentCard>
      <FreeCancellationNote />
    </div>
  );
}

/**
 * Services-catalog block on the service detail page. Renders one section
 * showing every bookable service the provider offers with its OWN base
 * price and add-ons. When the provider has more than one service
 * ("Men's haircut" + "Women's haircut") a tab selector at the top lets
 * the user switch between them — each tab swaps in that service's base
 * price + its own add-on list so beard trim doesn't show up under
 * Women's haircut.
 *
 * Legacy listings (created before the catalog) flow through here too:
 * the adapter synthesizes a single group from `price` + flat `addOns`,
 * so this component renders one tab with the same look the page had
 * before, just without the hardcoded "Haircut" label.
 */
function ServicesCatalogDisplay({ service, selectedGroupId, selectedAddOnIds, onSelectGroup, onToggleAddOn }: {
  service: MarketplaceService;
  selectedGroupId: string | null;
  selectedAddOnIds: string[];
  onSelectGroup: (groupId: string) => void;
  onToggleAddOn: (addOnId: string) => void;
}) {
  const { t } = useLanguage();
  const catalog = service.servicesCatalog;
  if (!catalog || catalog.length === 0) return null;
  const selected = catalog.find((g) => g.id === selectedGroupId) ?? catalog[0];
  const multiGroup = catalog.length > 1;
  return (
    <Section title={t("rd.detail.servicesCatalog", { defaultValue: "Services catalog" })}>
      {multiGroup && (
        <div role="tablist" className="mt-2 mb-3 flex flex-wrap gap-2">
          {catalog.map((g) => {
            const active = g.id === selected.id;
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectGroup(g.id)}
                className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  active
                    ? "border-foreground bg-foreground text-white"
                    : "border-border bg-white/80 text-foreground hover:border-foreground/40"
                }`}
              >
                {g.name}
                <span className={`tabular-nums ${active ? "text-white/80" : "text-muted-foreground"}`}>{rupee(g.basePrice)}</span>
              </button>
            );
          })}
        </div>
      )}
      <ul className="grid gap-2">
        {/* The base service is always included for the selected group. */}
        <li className="flex items-center justify-between gap-3 rounded-xl border border-foreground bg-foreground px-4 py-2.5 text-sm text-white">
          <span className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full border border-white bg-white text-[10px] font-black leading-none text-foreground">✓</span>
            {selected.name}
          </span>
          <span className="font-bold tabular-nums">{rupee(selected.basePrice)}</span>
        </li>
        {/* Add-ons are toggle chips — tap to include/remove; the selection
            carries into the booking modal when the user hits Book. */}
        {selected.addOns.map((opt) => {
          const checked = selectedAddOnIds.includes(opt.id);
          return (
            <li key={opt.id}>
              <button
                type="button"
                onClick={() => onToggleAddOn(opt.id)}
                aria-pressed={checked}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-left text-sm transition-all ${
                  checked ? "border-foreground bg-foreground text-white" : "border-border bg-white/85 text-foreground hover:bg-white"
                }`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <span
                    aria-hidden
                    className={`grid h-4 w-4 place-items-center rounded-full border text-[10px] font-black leading-none transition-colors ${
                      checked ? "border-white bg-white text-foreground" : "border-foreground/30 text-foreground/60"
                    }`}
                  >
                    {checked ? "✓" : "+"}
                  </span>
                  {opt.label}
                </span>
                <span className="font-bold tabular-nums">+{rupee(opt.price)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected.addOns.length > 0 && (
        <p className="mt-2 text-[11px] font-semibold text-muted-foreground">{t("rd.detail.addOnsHint", { defaultValue: "Tap add-ons to include them — your picks carry into booking." })}</p>
      )}
    </Section>
  );
}

function ServiceBookingSummary({
  service, selectedGroupId, selectedAddOnIds, onBook,
}: { service: MarketplaceService; selectedGroupId: string | null; selectedAddOnIds: string[]; onBook: (mode?: ServiceMode) => void }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<ServiceMode>(service.mode[0]);
  useEffect(() => { if (!service.mode.includes(mode)) setMode(service.mode[0]); }, [service, mode]);
  // Live price mirrors the catalog configurator: selected group's base +
  // any toggled add-ons. Falls back to the flat service.price for legacy
  // rows with no catalog. The booking modal is still the authoritative
  // total (fees/tax) — this is the pre-fee running subtotal.
  const catalog = service.servicesCatalog ?? [];
  const selectedGroup = catalog.find((g) => g.id === selectedGroupId) ?? catalog[0] ?? null;
  const base = selectedGroup?.basePrice ?? service.price;
  const addOns = (selectedGroup?.addOns ?? []).filter((a) => selectedAddOnIds.includes(a.id));
  const runningTotal = base + addOns.reduce((s, a) => s + a.price, 0);
  return (
    <section className="grid gap-3 rounded-[18px] border border-white/70 bg-white/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_22px_70px_rgba(34,31,39,0.13)] backdrop-blur-xl sm:p-5">
      <header className="flex items-end justify-between gap-2">
        <p>
          <span className="font-display text-2xl font-extrabold text-foreground">{rupee(runningTotal)}</span>
          <span className="text-sm font-semibold text-muted-foreground"> / {pricingUnitToLabel(service.pricingUnit, t)}</span>
        </p>
        <span className="inline-flex items-center gap-1 text-xs font-bold text-foreground">
          <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" /> {service.rating}
          <span className="text-muted-foreground"> · {service.reviews}</span>
        </span>
      </header>
      {(selectedGroup || addOns.length > 0) && (
        <p className="-mt-1 text-[11px] font-semibold text-muted-foreground">
          {selectedGroup?.name ?? service.title}
          {addOns.length > 0 && ` · ${t("rd.detail.addOnCount", { defaultValue: "{{count}} add-on", count: addOns.length })}`}
        </p>
      )}
      <div className="grid gap-1.5">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.serviceMode", { defaultValue: "Service mode" })}</p>
        <div className="flex flex-wrap gap-1.5">
          {(["at-home", "visit-provider", "online"] as ServiceMode[]).filter((m) => service.mode.includes(m)).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-bold transition-all ${
                mode === m ? "text-white shadow-[0_10px_24px_rgba(58,50,71,0.18)] bg-[linear-gradient(135deg,#2b2436_0%,#7b5244_60%,#8b5e4a_100%)]" : "border border-border bg-white/85 text-foreground hover:bg-white"
              }`}
            >
              {serviceModeIcon(m)} {serviceModeLabel(m, t)}
            </button>
          ))}
        </div>
      </div>
      <BookButton onClick={() => onBook(mode)}>{t("rd.detail.bookAppointment", { defaultValue: "Book appointment" })}</BookButton>
      <p className="text-center text-[11px] font-semibold text-muted-foreground">{t("rd.detail.notChargedYet", { defaultValue: "You won't be charged yet" })}</p>
    </section>
  );
}

// ─────────────────────────────────────────────────────── Transport detail ──

export function TransportDetailPage() {
  const { t } = useLanguage();
  const { id } = useParams<{ id: string }>();
  // Real backend lookup only — see ServiceDetailPage for rationale.
  const { data: item, isLoading } = useMarketplaceTransportListing(id);
  useEffect(() => { document.body.classList.add("client-redesign-active"); return () => document.body.classList.remove("client-redesign-active"); }, []);
  useEffect(() => { if (id) getAnalyticsEventsService().track("listing_viewed", { listingId: id, listingType: "transport", source: "transport_detail" }); }, [id]);
  const [booking, setBooking] = useState<BookingRequest | null>(null);
  const backToTransport = t("rd.detail.backToTransport", { defaultValue: "Back to transport" });
  const location = useLocation();
  const back = ((location.state as { from?: string } | null)?.from === "discovery")
    ? { href: "/", label: t("rd.detail.backToDiscovery", { defaultValue: "Back to discovery" }) }
    : { href: "/transport", label: backToTransport };

  if (isLoading && !item) {
    return (
      <PageShell back={back}>
        <ContentCard>
          <Section title={t("rd.detail.loadingTransport", { defaultValue: "Loading transport…" })}><p className="text-sm text-muted-foreground">{t("rd.detail.oneMoment", { defaultValue: "One moment." })}</p></Section>
        </ContentCard>
      </PageShell>
    );
  }
  if (!item) return <NotFoundDetail label={t("rd.detail.labelTransport", { defaultValue: "transport" })} backHref={back.href} backLabel={back.label} />;
  return (
    <PageShell back={back}>
      <TransportHeader item={item} />
      <SimpleHero image={item.image} images={item.images} />
      <TwoColumn
        left={<TransportLeftColumn item={item} />}
        right={<TransportBookingSummary item={item} onBook={(mode, packageId) => setBooking({ kind: "transport", transport: item, preselectedMode: mode, preselectedPackageId: packageId })} />}
      />
      <MarketplaceBookingModal request={booking} onClose={() => setBooking(null)} />
    </PageShell>
  );
}

function TransportHeader({ item }: { item: MarketplaceTransport }) {
  const { t } = useLanguage();
  // Phase 3: render every catalog type the operator offers as a badge row.
  // Single-type / legacy listings collapse to the original compact eyebrow.
  const types = item.transportationTypes ?? [];
  const showMulti = types.length > 1;
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {showMulti ? (
          <div className="mb-1 flex flex-wrap gap-1">
            {types.map((t) => (
              <span
                key={t.type}
                className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-accent"
              >
                {t.displayName}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11px] font-extrabold uppercase tracking-wide text-accent">{item.type}</p>
        )}
        <h1 className="font-display text-3xl font-extrabold leading-tight text-foreground sm:text-4xl">{item.driver}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <button type="button" onClick={scrollToReviews} className="inline-flex items-center gap-1 hover:underline"><Star className="h-4 w-4 fill-yellow-500 text-yellow-500" /> <strong className="text-foreground">{item.rating}</strong> · {t("rd.detail.tripsCount", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString() })}</button>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" /> {item.area}</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-bold text-success"><BadgeCheck className="h-3 w-3" /> {t("rd.detail.verifiedDriver", { defaultValue: "Verified driver" })}</span>
          {/* Primary offering badge surfaced from listings.metadata.transportMode.
              Hidden when the listing predates the field so legacy rows
              don't read as "Mode: undefined". */}
          {item.transportMode && (
            <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-bold text-accent">
              {transportModeLabel(item.transportMode, t)}
            </span>
          )}
          {/* Driver opted into flexible hours at onboarding — purely
              informational; tells riders they can message to arrange times
              outside the listed working hours. */}
          {item.flexibleHours && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary"
              title={t("rd.detail.flexibleHoursTooltip", { defaultValue: "This driver is flexible with timing — message them after booking to arrange hours." })}
            >
              <Clock3 className="h-3 w-3" /> {t("rd.detail.flexibleHours", { defaultValue: "Flexible hours" })}
            </span>
          )}
        </div>
      </div>
      <HeaderActions kind="transport" id={String(item.id)} />
    </header>
  );
}

/** Title-cased label for a transport mode, with the beta tag baked in for
 *  point rides so the header reads "Point ride · beta" consistently. */
function transportModeLabel(mode: TransportMode, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (mode === "point") return t("rd.detail.modePointBeta", { defaultValue: "Point ride · beta" });
  if (mode === "hourly") return t("rd.detail.modeHourlyRental", { defaultValue: "Hourly rental" });
  if (mode === "day") return t("rd.detail.modeDayRental", { defaultValue: "Day rental" });
  return t("rd.detail.modeTourPackage", { defaultValue: "Tour package" });
}

function getBookableTransportModes(item: MarketplaceTransport): TransportMode[] {
  // Surface every mode the operator has data for, regardless of the
  // listing's primary transportMode. The booking modal already accepts
  // all three, so the sidebar shouldn't be more restrictive.
  const available: TransportMode[] = [];
  if (item.packageOptions.length > 0) available.push("package");
  if (item.hourly > 0) available.push("hourly");
  if (item.day > 0) available.push("day");

  if (available.length > 0) return available;

  // Fall back to the declared primary mode so the sidebar still renders
  // something sensible for legacy rows with missing rate data.
  const mode = item.transportMode;
  if (mode === "hourly" || mode === "day" || mode === "package") return [mode];
  return [];
}

function TransportLeftColumn({ item }: { item: MarketplaceTransport }) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-6">
      <ContentCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{item.vehicle}</h2>
            <p className="text-sm text-muted-foreground">{t("rd.detail.seatsSpeaks", { defaultValue: "Seats {{capacity}} · Speaks {{languages}}", capacity: item.capacity, languages: item.languages.join(", ") })}</p>
          </div>
          <StatTile icon={<Users className="h-4 w-4" />} label={t("rd.detail.seats", { defaultValue: "Seats" })} value={String(item.capacity)} />
        </div>
        <Section title={t("rd.detail.areaCoverage", { defaultValue: "Area & coverage" })}>
          <AddressLink address={item.area} lat={item.lat} lng={item.lng} />
          <DetailMapPreview
            lat={item.lat}
            lng={item.lng}
            title={item.driver}
            subtitle={item.type}
            address={item.area}
          />
        </Section>
        {/* Pricing breakdown — surfaces whichever rates the operator filled
            in. Renders nothing when nothing is set, so legacy rows with
            only per-km pricing still look clean. */}
        {(item.hourly > 0 || item.day > 0 || item.perKm > 0) && (
          <Section title={t("rd.detail.rates", { defaultValue: "Rates" })}>
            <div className="flex flex-wrap gap-2 text-[12px] font-bold">
              {item.perKm > 0 && (
                <span className="rounded-full border border-border bg-white/85 px-2.5 py-1">{rupee(item.perKm)} {t("rd.detail.slashKm", { defaultValue: "/ km" })}</span>
              )}
              {item.hourly > 0 && (
                <span className="rounded-full border border-border bg-white/85 px-2.5 py-1">{rupee(item.hourly)} {t("rd.detail.slashHour", { defaultValue: "/ hour" })}</span>
              )}
              {item.day > 0 && (
                <span className="rounded-full border border-border bg-white/85 px-2.5 py-1">{rupee(item.day)} {t("rd.detail.slashDay", { defaultValue: "/ day" })}</span>
              )}
            </div>
          </Section>
        )}
        {/* Day rentals: surface the driver's daily availability window so the
            customer knows the start/end times before booking. Hidden when no
            working hours are set (and the driver isn't flexible-hours). */}
        {item.transportMode === "day" && (() => {
          const availWindow = summarizeWorkingWindow(item.workingHours);
          if (!availWindow && !item.flexibleHours) return null;
          return (
            <Section title={t("rd.detail.availability", { defaultValue: "Availability" })}>
              <div className="flex flex-wrap items-center gap-2">
                {availWindow && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white/85 px-3 py-1 text-[12px] font-bold text-foreground">
                    <Clock3 className="h-3.5 w-3.5" /> {t("rd.detail.windowDaily", { defaultValue: "{{window}} daily", window: availWindow })}
                  </span>
                )}
                {item.flexibleHours && (
                  <span className="text-xs text-muted-foreground">{t("rd.detail.flexibleHoursArranged", { defaultValue: "Flexible hours — other times can be arranged with the driver." })}</span>
                )}
              </div>
            </Section>
          );
        })()}
        {/* Only show "Packages on offer" when the operator actually has tour
            packages — day/hourly-only listings shouldn't render an empty or
            apologetic section. */}
        {item.packageOptions.length > 0 && (
        <Section title={t("rd.detail.packagesOnOffer", { defaultValue: "Packages on offer" })}>
          <div className="grid gap-3">
            {item.packageOptions.map((opt) => {
              // Per-package languages override listing-level; fall back to
              // the listing's languages so the user always sees something
              // useful even when the host didn't set tour-specific langs.
              const langs = (opt.languages && opt.languages.length > 0) ? opt.languages : item.languages;
              const kmRange = formatKmRange(opt.distanceKmMin, opt.distanceKmMax);
              const workingWindow = summarizeWorkingWindow(item.workingHours);
              return (
                <div key={opt.id} className="rounded-2xl border border-border bg-white/85 p-4 sm:p-5">
                  {/* Header — title + price */}
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-display text-base font-bold text-foreground sm:text-lg">{opt.label}</p>
                    <span className="shrink-0 rounded-full bg-foreground px-3 py-1 text-xs font-extrabold text-white">{rupee(opt.price)}</span>
                  </div>

                  {/* Big duration + working-hours window */}
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="font-display text-2xl font-extrabold leading-none text-foreground sm:text-[28px]">{opt.hours}</span>
                    <span className="text-sm font-semibold text-muted-foreground">{t("rd.detail.hoursUnit", { defaultValue: "hours", count: opt.hours })}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {workingWindow ? t("rd.detail.driverAvailableWindow", { defaultValue: "Driver available {{window}} · picks exact start with you", window: workingWindow }) : t("rd.detail.driverConfirmsStart", { defaultValue: "Driver confirms exact start with you" })}
                  </p>

                  {/* Meta chips — distance + languages */}
                  {(kmRange || (langs && langs.length > 0)) && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {kmRange && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-bold text-foreground">
                          <Navigation className="h-3 w-3" /> {kmRange}
                        </span>
                      )}
                      {langs && langs.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-foreground">
                          <Languages className="h-3 w-3" /> {langs.join(" · ")}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Itinerary — places visited */}
                  {opt.stops && opt.stops.length > 0 && (
                    <div className="mt-4 grid gap-2">
                      <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.placesYoullVisit", { defaultValue: "Places you'll visit" })}</p>
                      <ol className="grid gap-2">
                        {opt.stops.map((stop, idx) => {
                          const dwell = formatDwell(stop.dwellMinutes);
                          return (
                            <li key={`${stop.place}-${idx}`} className="flex items-start gap-2.5 text-sm">
                              <span className="mt-0.5 inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground text-[10px] font-extrabold text-white">{idx + 1}</span>
                              <span className="min-w-0 leading-snug">
                                <span className="font-semibold text-foreground">{stop.place}</span>
                                {dwell && <span className="text-muted-foreground"> · {dwell}</span>}
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}

                  {/* Description */}
                  {opt.description && (
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{opt.description}</p>
                  )}

                  {/* Optional "includes" — kept for legacy / future use */}
                  {opt.includes && opt.includes.length > 0 && (
                    <div className="mt-3 grid gap-1">
                      <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.includes", { defaultValue: "Includes" })}</p>
                      <ul className="grid gap-1 sm:grid-cols-2">
                        {opt.includes.map((line) => (
                          <li key={line} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> {line}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
        )}
        <Section title={t("rd.detail.languages", { defaultValue: "Languages" })}>
          <div className="flex flex-wrap gap-1.5">
            {item.languages.map((l) => (
              <span key={l} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-foreground"><Languages className="h-3 w-3" /> {l}</span>
            ))}
          </div>
        </Section>
        {/* Show the driver-authored description from onboarding instead of
            the canned "Terms & notes" boilerplate, which often didn't apply
            (e.g. day-rental listings don't have "extra kilometers settled in
            cash"). Hide the section entirely if no description was written —
            we don't want an empty card on the page. */}
        {item.description && item.description.trim() && (
          <Section title={t("rd.detail.aboutThisRide", { defaultValue: "About this ride" })}>
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {item.description.trim()}
            </p>
          </Section>
        )}
      </ContentCard>
      <ContentCard>
        <ReviewsSection
          listingId={item.id}
          fallbackRating={item.rating}
          fallbackCount={0}
          emptyHint={t("rd.detail.transportReviewsEmpty", { defaultValue: "No reviews yet — be the first to ride and share your experience." })}
        />
      </ContentCard>
      <FreeCancellationNote />
    </div>
  );
}

function TransportBookingSummary({
  item, onBook,
}: { item: MarketplaceTransport; onBook: (mode: TransportMode, packageId?: string) => void }) {
  const { t } = useLanguage();
  // Seed the picker from the operator's primary offering when known so the
  // default tab matches what the listing actually advertises. Falls back to
  // "package" for legacy rows so the previous behavior is preserved.
  const bookableModes = useMemo(() => getBookableTransportModes(item), [item]);
  const [mode, setMode] = useState<TransportMode>(bookableModes[0] ?? "hourly");
  const [packageId, setPackageId] = useState<string>(item.packageOptions[0]?.id ?? "");
  const isPoint = mode === "point";
  useEffect(() => {
    if (bookableModes.length > 0 && !bookableModes.includes(mode)) {
      setMode(bookableModes[0]);
    }
  }, [bookableModes, mode]);
  return (
    <section className="grid gap-3 rounded-[18px] border border-white/70 bg-white/90 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_22px_70px_rgba(34,31,39,0.13)] backdrop-blur-xl sm:p-5">
      <header className="flex items-end justify-between gap-2">
        {(() => {
          // Pick the headline rate based on what the operator actually
          // offers. Falls through to perKm only when no per-mode rate
          // exists — avoids showing "₹0 / km" for hourly/day/package-only
          // listings.
          const pkgFrom = item.packageOptions
            .map((p) => p.price)
            .filter((p) => p > 0)
            .sort((a, b) => a - b)[0];
          let value = 0;
          let unit = "";
          if (item.hourly > 0)        { value = item.hourly; unit = "/ hour"; }
          else if (item.day > 0)      { value = item.day;    unit = "/ day"; }
          else if (pkgFrom != null)   { value = pkgFrom;     unit = "from"; }
          else if (item.perKm > 0)    { value = item.perKm;  unit = "/ km"; }
          if (value <= 0) {
            return <p className="text-sm font-semibold text-muted-foreground">{t("rd.detail.pricingOnRequest", { defaultValue: "Pricing on request" })}</p>;
          }
          const unitLabel = (u: string): string => {
            if (u === "/ hour") return t("rd.detail.slashHour", { defaultValue: "/ hour" });
            if (u === "/ day") return t("rd.detail.slashDay", { defaultValue: "/ day" });
            if (u === "/ km") return t("rd.detail.slashKm", { defaultValue: "/ km" });
            return u;
          };
          // Secondary line: when the operator has BOTH an hourly and a day
          // rate, show the one that isn't the headline directly underneath
          // so customers can eyeball the trade-off without flipping booking
          // modes. Only renders when the secondary value is meaningful — we
          // never duplicate the headline or surface a ₹0 fallback.
          const secondary =
            unit === "/ hour" && item.day > 0
              ? { value: item.day, unit: "/ day" }
              : unit === "/ day" && item.hourly > 0
                ? { value: item.hourly, unit: "/ hour" }
                : null;
          return (
            <div>
              <p>
                {unit === "from" && <span className="mr-1 text-sm font-semibold text-muted-foreground">{t("rd.detail.fromLower", { defaultValue: "from" })}</span>}
                <span className="font-display text-2xl font-extrabold text-foreground">{rupee(value)}</span>
                {unit !== "from" && <span className="text-sm font-semibold text-muted-foreground"> {unitLabel(unit)}</span>}
              </p>
              {secondary && (
                <p className="mt-0.5 text-xs font-semibold text-muted-foreground">
                  {rupee(secondary.value)} <span className="text-muted-foreground/80">{unitLabel(secondary.unit)}</span>
                </p>
              )}
            </div>
          );
        })()}
        <span className="inline-flex items-center gap-1 text-xs font-bold text-foreground">
          <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" /> {item.rating}
          <span className="text-muted-foreground"> · {t("rd.detail.tripsCount", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString() })}</span>
        </span>
      </header>
      <div className="grid gap-1.5">
        <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.bookingType", { defaultValue: "Booking type" })}</p>
        <div className="grid grid-cols-2 gap-1.5">
          {([
            ["package", Sparkles, t("rd.detail.modeTourPackage", { defaultValue: "Tour package" })],
            ["hourly", Clock3, t("rd.detail.modeHourly", { defaultValue: "Hourly" })],
            ["day", CalendarDays, t("rd.detail.modeDayRental", { defaultValue: "Day rental" })],
            ["point", Navigation, t("rd.detail.modePointRide", { defaultValue: "Point ride" })],
          ] as Array<[TransportMode, typeof Sparkles, string]>)
            .filter(([m]) => bookableModes.includes(m))
            .map(([m, Icon, label]) => {
            const disabled = m === "point"; // gated/beta — booking not wired
            return (
              <button
                key={m}
                type="button"
                onClick={() => { if (!disabled) setMode(m); }}
                disabled={disabled}
                className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-bold transition-all ${
                  disabled
                    ? "cursor-not-allowed border-border bg-muted/50 text-muted-foreground opacity-70"
                    : mode === m
                      ? "border-foreground bg-foreground text-white"
                      : "border-border bg-white/85 text-foreground hover:bg-white"
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}{m === "point" && <span className="rounded-full bg-foreground/10 px-1 py-0.5 text-[9px] font-extrabold uppercase">β</span>}
              </button>
            );
          })}
        </div>
      </div>
      {mode === "package" && item.packageOptions.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{t("rd.detail.quickPackagePick", { defaultValue: "Quick package pick" })}</p>
          <PackagePopover
            options={item.packageOptions.map((opt) => ({ id: opt.id, label: opt.label, price: opt.price, hours: opt.hours }))}
            value={packageId}
            onChange={setPackageId}
          />
        </div>
      )}
      {isPoint ? (
        <div className="rounded-xl border border-yellow-300/50 bg-yellow-50/80 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-bold text-yellow-900"><AlertCircle className="h-3.5 w-3.5" /> {t("rd.detail.modePointBeta", { defaultValue: "Point ride · beta" })}</p>
          <p className="mt-1 text-yellow-900/80">{t("rd.detail.pointRideComingSoon", { defaultValue: "Available soon. Book a package, hourly, or day rental instead." })}</p>
        </div>
      ) : (
        <BookButton onClick={() => onBook(mode, mode === "package" ? packageId : undefined)}>{t("rd.detail.requestDriver", { defaultValue: "Request driver" })}</BookButton>
      )}
      <p className="text-center text-[11px] font-semibold text-muted-foreground">{t("rd.detail.driverConfirmsBeforeCharging", { defaultValue: "Driver confirms availability before charging" })}</p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────── Shared shell ──

function PageShell({ back, children }: { back: { href: string; label: string }; children: React.ReactNode }) {
  return (
    <div className="client-redesign app-shell">
      <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-6 sm:px-6">
        <Link to={back.href} className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/55 px-3 py-1.5 text-[12px] font-bold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-md hover:bg-white/75">
          <ArrowLeft className="h-3.5 w-3.5" /> {back.label}
        </Link>
        {children}
      </main>
    </div>
  );
}

function TwoColumn({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="min-w-0">{left}</div>
      <aside className="self-start lg:sticky lg:top-24">{right}</aside>
    </div>
  );
}

function ContentCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-5 rounded-[18px] border border-white/70 bg-white/85 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl sm:p-6">
      {children}
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    // scroll-mt keeps an anchored section clear of the sticky page chrome
    // when it's jumped to via scrollIntoView (see scrollToReviews).
    <div id={id} className={id ? "scroll-mt-24" : undefined}>
      <h3 className="mb-2 font-display text-base font-bold text-foreground">{title}</h3>
      {children}
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-white/70 px-3 py-2 text-right">
      <div className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{icon} {label}</div>
      <div className="font-display text-lg font-bold text-foreground">{value}</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white/80 px-2.5 py-1 text-[11px] font-bold text-foreground">{children}</span>;
}

/** WhatsApp brand glyph — lucide dropped brand logos, so this is the standard
 *  single-path WhatsApp mark inlined (filled, inherits currentColor). */
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

function HeaderActions({ kind, id }: { kind: "stay" | "service" | "transport"; id: string }) {
  const { t } = useLanguage();
  const { isStaySaved, isServiceSaved, isTransportSaved, toggleSaveStay, toggleSaveService, toggleSaveTransport } = useSaved();
  const [shareOpen, setShareOpen] = useState(false);
  const saved =
    kind === "stay" ? isStaySaved(id) :
    kind === "service" ? isServiceSaved(id) :
    isTransportSaved(id);
  const toggle = () => {
    if (kind === "stay") toggleSaveStay(id);
    else if (kind === "service") toggleSaveService(id);
    else toggleSaveTransport(id);
  };
  const shareUrl = typeof window !== "undefined"
    ? `${window.location.origin}/${kind === "stay" ? "stay" : kind}/${encodeURIComponent(id)}`
    : "";
  const shareTitle = typeof document !== "undefined" ? document.title : t("rd.detail.shareTitleFallback", { defaultValue: "IstaSeva listing" });
  const copyShareLink = async () => {
    if (!shareUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const input = document.createElement("textarea");
        input.value = shareUrl;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      toast.success(t("rd.detail.linkCopied", { defaultValue: "Link copied" }));
      setShareOpen(false);
    } catch {
      toast.error(t("rd.detail.couldntCopyLink", { defaultValue: "Couldn't copy link" }));
    }
  };
  const openNativeShare = async () => {
    if (!navigator.share || !shareUrl) return;
    try {
      await navigator.share({ url: shareUrl, title: shareTitle });
      setShareOpen(false);
    } catch {
      // User cancelled the sheet; leave the modal open with fallback actions.
    }
  };
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setShareOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/55 px-3 py-1.5 text-[12px] font-bold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-md hover:bg-white/75"
      >
        <Share2 className="h-3.5 w-3.5" /> {t("rd.detail.share", { defaultValue: "Share" })}
      </button>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={saved}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-md transition-colors ${
          saved
            ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
            : "border-white/70 bg-white/55 text-foreground hover:bg-white/75"
        }`}
      >
        <Heart className={`h-3.5 w-3.5 ${saved ? "fill-current" : ""}`} /> {saved ? t("rd.detail.saved", { defaultValue: "Saved" }) : t("rd.detail.save", { defaultValue: "Save" })}
      </button>
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t("rd.detail.shareListing", { defaultValue: "Share listing" })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground break-all">
              {shareUrl}
            </div>
            {/* Share targets as an icon row (icon tile + caption) instead of a
                stacked list of text buttons. */}
            <div className="flex items-start justify-center gap-4 pt-1">
              {navigator.share && (
                <button
                  type="button"
                  onClick={openNativeShare}
                  className="group flex w-20 flex-col items-center gap-1.5 text-center focus:outline-none"
                >
                  <span className="inline-grid h-12 w-12 place-items-center rounded-full border border-border bg-white/85 text-foreground shadow-sm transition-colors group-hover:bg-muted group-focus-visible:ring-2 group-focus-visible:ring-foreground/40">
                    <Share2 className="h-5 w-5" />
                  </span>
                  <span className="text-[11px] font-semibold leading-tight text-muted-foreground">{t("rd.detail.shareMore", { defaultValue: "More" })}</span>
                </button>
              )}
              <button
                type="button"
                onClick={copyShareLink}
                className="group flex w-20 flex-col items-center gap-1.5 text-center focus:outline-none"
              >
                <span className="inline-grid h-12 w-12 place-items-center rounded-full border border-border bg-white/85 text-foreground shadow-sm transition-colors group-hover:bg-muted group-focus-visible:ring-2 group-focus-visible:ring-foreground/40">
                  <Copy className="h-5 w-5" />
                </span>
                <span className="text-[11px] font-semibold leading-tight text-muted-foreground">{t("rd.detail.copyLink", { defaultValue: "Copy link" })}</span>
              </button>
              <button
                type="button"
                onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`${shareTitle} ${shareUrl}`)}`, "_blank", "noopener,noreferrer")}
                className="group flex w-20 flex-col items-center gap-1.5 text-center focus:outline-none"
              >
                <span className="inline-grid h-12 w-12 place-items-center rounded-full border border-[#25D366]/30 bg-[#25D366]/10 text-[#128C7E] shadow-sm transition-colors group-hover:bg-[#25D366]/20 group-focus-visible:ring-2 group-focus-visible:ring-[#25D366]/50">
                  <WhatsAppIcon className="h-5 w-5" />
                </span>
                <span className="text-[11px] font-semibold leading-tight text-muted-foreground">{t("rd.detail.whatsapp", { defaultValue: "WhatsApp" })}</span>
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SimpleHero({ image, images }: { image: string; images?: string[] }) {
  // De-dupe + ensure the hero image is first. Falls back to a single-image
  // hero (the old behavior) when the listing only has one photo.
  const gallery = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const all = [image, ...(images || [])];
    for (const url of all) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  })();
  if (gallery.length <= 1) {
    return (
      <div className="mb-6 h-72 overflow-hidden rounded-2xl sm:h-96">
        <img src={gallery[0] ?? image} alt="" decoding="async" {...({ fetchpriority: "high" } as Record<string, string>)} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="mb-6 grid gap-2 sm:h-96 sm:grid-cols-4 sm:grid-rows-2">
      {/* Hero — spans 2x2 on sm+; full-width on mobile. */}
      <div className="overflow-hidden rounded-2xl sm:col-span-2 sm:row-span-2">
        <img src={gallery[0]} alt="" decoding="async" {...({ fetchpriority: "high" } as Record<string, string>)} className="h-72 w-full object-cover sm:h-full" />
      </div>
      {/* Up to 4 thumbnails on sm+; on mobile we render the rest as a
          horizontal scroll strip below the hero. */}
      <div className="grid grid-cols-3 gap-2 sm:hidden">
        {gallery.slice(1, 4).map((url, i) => (
          <div key={i} className="aspect-square overflow-hidden rounded-xl">
            <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          </div>
        ))}
      </div>
      {gallery.slice(1, 5).map((url, i) => (
        <div key={i} className="hidden overflow-hidden rounded-2xl sm:block">
          <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
      ))}
    </div>
  );
}

function BookButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-12 items-center justify-center gap-2 rounded-full px-5 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)] transition-transform hover:-translate-y-0.5"
      style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #8b5e4a 100%)" }}
    >
      {children} <ChevronRight className="h-4 w-4" />
    </button>
  );
}

/**
 * Generic free-cancellation note shown at the bottom of every listing detail
 * page. Wording must match what the server actually does on cancel: the
 * current product rule is a full refund for any cancellation before the
 * booking starts (server/src/modules/payments/pricing/cancellation.ts). Do
 * NOT promise a stricter cutoff here than the refund logic enforces — the
 * exact refund is shown on the cancel screen from /cancel-preview.
 */
function FreeCancellationNote() {
  const { t } = useLanguage();
  return (
    <p className="flex items-start gap-1.5 px-1 text-[11px] font-semibold leading-relaxed text-muted-foreground">
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      <span>
        {t("rd.detail.freeCancellationNoteV2", { defaultValue: "Free cancellation — cancel before your booking starts for a full refund to your original payment method." })}
      </span>
    </p>
  );
}

function NotFoundDetail({ label, backHref, backLabel }: { label: string; backHref: string; backLabel: string }) {
  const { t } = useLanguage();
  const nav = useNavigate();
  useEffect(() => { document.body.classList.add("client-redesign-active"); return () => document.body.classList.remove("client-redesign-active"); }, []);
  return (
    <PageShell back={{ href: backHref, label: backLabel }}>
      <ContentCard>
        <Section title={t("rd.detail.unavailableTitle", { defaultValue: "This {{label}} is unavailable", label })}>
          <p className="text-sm text-muted-foreground">{t("rd.detail.unavailableBody", { defaultValue: "It may have been removed, or the link is incorrect. Browse current options instead." })}</p>
          <button onClick={() => nav(backHref)} className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 text-sm font-bold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:bg-white">
            {backLabel}
          </button>
        </Section>
      </ContentCard>
    </PageShell>
  );
}

/**
 * Custom themed popover used by the transport "Quick package pick" field.
 * Portalled into document.body so it doesn't get clipped by the sticky
 * booking summary card or stack under other elements.
 */
function PackagePopover({
  options, value, onChange,
}: {
  options: Array<{ id: string; label: string; price: number; hours: number }>;
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left, width: rect.width });
  }, [open]);

  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-white/85 px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] hover:bg-white"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-bold text-foreground">{current?.label}</span>
          <span className="text-[10px] font-semibold text-muted-foreground">{t("rd.detail.hoursAndPrice", { defaultValue: "{{hours}} hours · {{price}}", hours: current?.hours, price: rupee(current?.price ?? 0) })}</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, zIndex: 200 }}
          className="overflow-hidden rounded-2xl border border-border bg-white py-1 shadow-[0_28px_86px_rgba(34,31,39,0.18)]"
        >
          {options.map((o) => {
            const active = o.id === value;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => { onChange(o.id); setOpen(false); }}
                className={`flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 ${
                  active ? "bg-muted/40" : ""
                }`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-bold text-foreground">{o.label}</span>
                  <span className="text-[10px] font-semibold text-muted-foreground">{t("rd.detail.hoursLabel", { defaultValue: "{{hours}} hours", hours: o.hours })}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-extrabold text-foreground">{rupee(o.price)}</span>
                  {active && <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-bold text-accent"><Check className="h-3 w-3" /> {t("rd.detail.selected", { defaultValue: "Selected" })}</span>}
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

function StayDetailSkeleton() {
  return (
    <div className="grid gap-6">
      <div className="h-10 w-2/3 animate-pulse rounded bg-muted/70" />
      <div className="grid gap-2 sm:grid-cols-4">
        <div className="h-72 animate-pulse rounded-2xl bg-muted/70 sm:col-span-2 sm:h-96" />
        <div className="grid grid-cols-2 gap-2 sm:col-span-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-2xl bg-muted/70 sm:h-[188px]" />
          ))}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="h-[480px] animate-pulse rounded-2xl bg-muted/70" />
        <div className="h-[320px] animate-pulse rounded-2xl bg-muted/70" />
      </div>
    </div>
  );
}

function serviceModeLabel(m: ServiceMode, t: (key: string, opts?: Record<string, unknown>) => string) { return m === "at-home" ? t("rd.detail.modeAtHome", { defaultValue: "At home" }) : m === "online" ? t("rd.detail.modeOnline", { defaultValue: "Online" }) : t("rd.detail.modeVisitProvider", { defaultValue: "Visit provider" }); }
function serviceModeIcon(m: ServiceMode) {
  if (m === "at-home") return <Home className="h-3.5 w-3.5" />;
  if (m === "online") return <Globe2 className="h-3.5 w-3.5" />;
  return <Store className="h-3.5 w-3.5" />;
}
