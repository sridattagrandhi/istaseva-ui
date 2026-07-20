export interface RoomType {
  id: string;
  listingId: string;
  name: string;
  description?: string | null;
  basePricePaise: number;
  maxGuests: number;
  /** Number of physical rooms of this type. The booking flow lets up to
      `quantity` concurrent bookings happen on any given night. */
  quantity: number;
  /** Bedrooms inside ONE room of this type (e.g. 1 for "Deluxe King", 2 for a suite). */
  bedrooms?: number;
  /** Bathrooms inside ONE room of this type. */
  bathrooms?: number;
  /** Optional room numbers/labels — ["101","102",…] or ["8a","8b","8c"]. Empty when host doesn't number rooms. */
  unitIdentifiers?: string[];
  photos: string[];
  sortOrder: number;
}

export interface Stay {
  id: string;
  userId?: string;
  providerProfileId?: string;
  title: string;
  location: string;
  state: string;
  district: string;
  price: number;
  /** Host-set flat percent discount (0–90). 0 = no discount. */
  discountPercent?: number;
  rating: number;
  reviews: number;
  image: string;
  photos?: string[];
  type: "hotel" | "homestay" | "lodge" | "village-stay" | "farm-stay" | "heritage";
  tags: string[];
  amenities: string[];
  host: { name: string; image: string; since: string; responseRate: string; id?: string };
  description: string;
  rooms: number;
  guests: number;
  languages: string[];
  verified: boolean;
  houseRules?: string[];
  lat?: number;
  lng?: number;
  locality: string;
  nearbyTags: string[];
  metadata?: Record<string, any>;
  /** Bookable rooms attached to a hotel-style stay. Empty/undefined for single-price stays. */
  roomTypes?: RoomType[];
}

/** Where the service is delivered. A single listing may offer more than one mode
 *  (e.g. a tutor who teaches both at-home and online), so the persisted shape
 *  is an array. Stored in `listings.metadata.serviceModes` for now — no
 *  dedicated column. */
export type ServiceMode = "at-home" | "visit-provider" | "online";

export interface Service {
  id: string;
  userId?: string;
  providerProfileId?: string;
  title: string;
  category: string;
  subcategory: string;
  icon: string;
  /** Delivery modes offered. Empty when the listing predates the
   *  mode-aware onboarding flow — adapters fall back to inferring "at-home"
   *  so old listings still render. */
  serviceModes: ServiceMode[];
  price: number;
  rating: number;
  reviews: number;
  provider: {
    id?: string;
    name: string;
    image: string;
    experience: string;
    jobs: number;
    languages: string[];
    verified: boolean;
    responseTime: string;
  };
  description: string;
  availability: string;
  area: string;
  duration: string;
  lat?: number;
  lng?: number;
  locality: string;
  serviceRadius: number;
  metadata?: Record<string, any>;
}

/** Top-level shape of a transport listing's offering.
 *  - "point"    — A→B fixed-route ride (kept in beta/disabled in onboarding).
 *  - "hourly"   — driver-plus-vehicle rented by the hour.
 *  - "day"      — driver-plus-vehicle for a full day, customer drives the itinerary.
 *  - "package"  — predefined tour packages defined by the operator.
 *  Stored in `listings.metadata.transportMode`. */
export type TransportMode = "point" | "hourly" | "day" | "package";

/** One stop on a tour package. `place` is required; `dwellMinutes` is
 *  optional — surface it ("Golconda Fort · ~45 min") only when the host set it. */
export interface TourPackageStop {
  place: string;
  dwellMinutes?: number;
}

/** One predefined tour/package row offered by a "package"-mode transport
 *  listing. Persisted as `listings.metadata.packageOptions[]`.
 *
 *  Fields like `stops`, `distanceKmMin/Max`, and `languages` are required on
 *  NEW/edited rows (validated in the onboarding + edit forms and the AI
 *  tool), but kept optional in the type so older rows authored before this
 *  shape existed continue to render — they'll surface a "host hasn't filled
 *  this in yet" affordance instead of crashing the page. */
export interface TransportPackageOption {
  id: string;
  label: string;
  /** Total package price in rupees. */
  price: number;
  /** Approximate total duration in hours; used as the headline time + to
   *  validate the tour fits inside the listing's working-hours window. */
  hours: number;
  description?: string;
  /** Ordered itinerary. Old rows authored as `string[]` are migrated to
   *  `{ place }[]` by the marketplace adapter — readers should treat this
   *  as the canonical shape. */
  stops?: TourPackageStop[];
  /** Approximate distance covered over the full tour, as a min–max range
   *  in km. Both ends required when set. */
  distanceKmMin?: number;
  distanceKmMax?: number;
  /** Languages the driver/guide can run this specific tour in. Overrides
   *  the listing-level languages when set; falls back to listing when blank. */
  languages?: string[];
  includes?: string[];
}

export interface TransportProvider {
  id: string;
  userId?: string;
  providerProfileId?: string;
  name: string;
  type: "auto" | "cab" | "van" | "bike" | "tempo";
  vehicleName: string;
  photo: string;
  rating: number;
  reviews: number;
  trips: number;
  pricePerKm: number;
  /** Optional hourly rate, used for time-based driver rentals. 0 when unset. */
  pricePerHour: number;
  /** Optional flat day rate. 0 when unset. */
  pricePerDay: number;
  /** Primary offering shape. Old listings default to "point" inference in the
   *  adapter; new listings carry this explicitly. */
  transportMode: TransportMode;
  /** Only populated when transportMode === "package". */
  packageOptions: TransportPackageOption[];
  languages: string[];
  verified: boolean;
  available: boolean;
  responseTime: string;
  serviceArea: string;
  specialties: string[];
  lat?: number;
  lng?: number;
  locality: string;
  district: string;
  state: string;
  metadata?: Record<string, any>;
}
