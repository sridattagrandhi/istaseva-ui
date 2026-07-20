// Defensive parser for the structured JSON we stash in `bookings.notes`
// from the marketplace booking modals. The backend treats `notes` as an
// opaque string column — old bookings may hold free-text, malformed JSON,
// or nothing at all. Every helper here returns `null` / empty rather than
// throwing so dashboards can render unconditionally.

export type ServiceMode = "at-home" | "visit-provider" | "online";
export type TransportMode = "hourly" | "day" | "package" | "point";

export interface ServiceAddOn {
  id?: string;
  label?: string;
  price?: number;
}

export interface ServiceBookingDetails {
  serviceMode?: ServiceMode;
  serviceTitle?: string;
  slot?: string;
  contact?: { name?: string; phone?: string };
  customerAddress?: string;
  visitAddress?: string;
  meetingDetails?: string;
  addOns?: ServiceAddOn[];
  protection?: boolean;
  guestName?: string;
  /** Selected services-catalog group name (e.g. "Women's Haircut") set by
   *  the booking modal when the listing has multiple bookable services and
   *  the customer picked one. Empty for legacy listings without a catalog;
   *  consumers should fall back to the listing title in that case. */
  selectedServiceName?: string;
  /** Id of the selected services-catalog group, used by the server to
   *  re-validate add-ons + base price. Surfaced here so host dashboards can
   *  cross-reference per-group reporting later. */
  selectedServiceCatalogId?: string;
}

export interface TransportBookingDetails {
  isTransport: boolean;
  mode?: TransportMode;
  pickup?: string;
  durationHours?: number;
  days?: number;
  packageId?: string;
  packageLabel?: string;
  packagePrice?: number;
  packageHours?: number;
  passengers?: number;
  scheduledDate?: string;
  scheduledTime?: string;
  contact?: { name?: string; phone?: string };
  vehicleType?: string;
  protection?: boolean;
  guestName?: string;
}

export function parseBookingNotes(notes: string | null | undefined): Record<string, unknown> | null {
  if (!notes || typeof notes !== "string") return null;
  const trimmed = notes.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export function getServiceBookingDetails(notes: string | null | undefined): ServiceBookingDetails | null {
  const p = parseBookingNotes(notes);
  if (!p) return null;
  // Anything that looks like a transport notes blob is not a service.
  if (p.transport === true) return null;

  const serviceModeRaw = asString(p.serviceMode);
  const serviceMode: ServiceMode | undefined =
    serviceModeRaw === "at-home" || serviceModeRaw === "visit-provider" || serviceModeRaw === "online"
      ? serviceModeRaw
      : undefined;

  const contactObj = (p.contact && typeof p.contact === "object" && !Array.isArray(p.contact))
    ? p.contact as Record<string, unknown>
    : null;
  const contact = contactObj
    ? { name: asString(contactObj.name), phone: asString(contactObj.phone) }
    : undefined;

  const addOnsRaw = Array.isArray(p.addOns) ? p.addOns : null;
  const addOns: ServiceAddOn[] | undefined = addOnsRaw
    ? addOnsRaw
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && !Array.isArray(a))
        .map((a) => ({
          id: asString(a.id),
          label: asString(a.label),
          price: asNumber(a.price),
        }))
    : undefined;

  // Treat as a "service" notes blob if it has at least one service-shaped
  // field. Otherwise return null so callers don't render an empty section.
  // The selected services-catalog group also counts as service signal so a
  // booking whose only structured field is the chosen group still parses.
  const selectedServiceName = asString(p.selectedServiceName);
  const selectedServiceCatalogId = asString(p.selectedServiceCatalogId);
  const hasShape =
    !!serviceMode ||
    !!asString(p.serviceTitle) ||
    !!asString(p.slot) ||
    !!asString(p.customerAddress) ||
    !!asString(p.visitAddress) ||
    !!asString(p.meetingDetails) ||
    !!selectedServiceName ||
    (addOns && addOns.length > 0);
  if (!hasShape) return null;

  return {
    serviceMode,
    serviceTitle: asString(p.serviceTitle),
    slot: asString(p.slot),
    contact,
    customerAddress: asString(p.customerAddress),
    visitAddress: asString(p.visitAddress),
    meetingDetails: asString(p.meetingDetails),
    addOns: addOns && addOns.length > 0 ? addOns : undefined,
    protection: asBool(p.protection),
    guestName: asString(p.guestName),
    selectedServiceName,
    selectedServiceCatalogId,
  };
}

export function getTransportBookingDetails(notes: string | null | undefined): TransportBookingDetails | null {
  const p = parseBookingNotes(notes);
  if (!p) return null;
  if (p.transport !== true) return null;

  const modeRaw = asString(p.mode);
  const mode: TransportMode | undefined =
    modeRaw === "hourly" || modeRaw === "day" || modeRaw === "package" || modeRaw === "point"
      ? modeRaw
      : undefined;

  const contactObj = (p.contact && typeof p.contact === "object" && !Array.isArray(p.contact))
    ? p.contact as Record<string, unknown>
    : null;
  const contact = contactObj
    ? { name: asString(contactObj.name), phone: asString(contactObj.phone) }
    : undefined;

  return {
    isTransport: true,
    mode,
    pickup: asString(p.pickup),
    durationHours: asNumber(p.durationHours),
    days: asNumber(p.days),
    packageId: asString(p.packageId),
    packageLabel: asString(p.packageLabel),
    packagePrice: asNumber(p.packagePrice),
    packageHours: asNumber(p.packageHours),
    passengers: asNumber(p.passengers),
    scheduledDate: asString(p.scheduledDate),
    scheduledTime: asString(p.scheduledTime),
    contact,
    vehicleType: asString(p.vehicleType),
    protection: asBool(p.protection),
    guestName: asString(p.guestName),
  };
}

export function serviceModeLabel(mode: ServiceMode | undefined): string | null {
  switch (mode) {
    case "at-home": return "At home";
    case "visit-provider": return "Visit provider";
    case "online": return "Online";
    default: return null;
  }
}

export function transportModeLabel(mode: TransportMode | undefined): string | null {
  switch (mode) {
    case "hourly": return "Hourly";
    case "day": return "Day rental";
    case "package": return "Package";
    case "point": return "Point-to-point";
    default: return null;
  }
}
