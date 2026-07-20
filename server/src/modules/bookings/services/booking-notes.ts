/**
 * Unified booking `notes` builder + the structured input that drives it.
 *
 * Phase 2 of unifying the two booking paths. Today the marketplace modal
 * assembles booking `notes` client-side and the chat assistant assembles them
 * server-side — and the two shapes have drifted, which downstream consumers
 * (notably invoice.service.ts) silently depend on. Concrete drift this builder
 * fixes by producing ONE superset shape with consumer-correct key names:
 *
 *   - At-home service ADDRESS: the modal wrote `customerAddress`, but
 *     invoice.service reads `location || address || serviceAddress` — so the
 *     modal's key was never read. Canonical key here is `serviceAddress`
 *     (what the invoice reads); we also emit `customerAddress` as an alias so
 *     any host-UI that read the modal's key keeps working.
 *   - Transport `vehicleType` / `selectedSlots` / `guestName` / `contact`: the
 *     assistant omitted these, so assistant-created invoices lost vehicle +
 *     slot detail. This builder always includes them when known.
 *
 * The builder is pure (no DB, no listing fetch): the caller resolves display
 * fields (titles, room name, package label, …) and passes them in. That keeps
 * it trivially testable and lets both the modal-backed endpoint and the chat
 * assistant share one notes contract.
 */

export interface BookingContact {
  name?: string;
  phone?: string;
}

export interface ServiceAddOnSnapshot {
  id?: string;
  label: string;
  price: number;
}

/**
 * The superset of every field either booking path collects. Optional
 * throughout — the builder emits only what's present and gates the
 * mode-specific groups. Phase 3's prepare endpoint validates a Zod schema
 * shaped like this; Phase 4 points the modal at it.
 */
export interface PrepareBookingIntentInput {
  listingType: 'stay' | 'service' | 'transport';
  listingId: string;

  // --- Scheduling + hold params (consumed by BookingIntentService.prepare;
  //     ignored by the notes builder) ---
  /** Backend pricing-branch selector, e.g. "stay:hotel", "driver-cab", a
   *  service category. The caller resolves it from the listing. */
  serviceCategory?: string;
  startTime?: string;          // HH:MM — hold start
  endTime?: string;            // HH:MM — hold end
  /** Multi-night / multi-day end date for the hold's conflict check. */
  endDate?: string;
  numberOfRooms?: number;
  couponCode?: string;
  /** Booking address persisted on the hold (stay location, geocoded service
   *  address, or transport pickup). */
  address?: string;
  /** Optional caller-supplied hold idempotency key; generated when absent. */
  idempotencyKey?: string;

  // --- Result-decoration display fields (for the PrepareBookingResult the
  //     client renders; not persisted in notes) ---
  listingName?: string;
  listingImage?: string;
  listingLocation?: string;
  /** Selected room nightly price in RUPEES — shown on the Confirm & Pay card. */
  roomPricePerNight?: number;

  // Shared / display + audit
  listingTitle?: string;
  /** Free-text rider the customer added ("call on arrival"). */
  note?: string;
  contact?: BookingContact;
  /** Canonical top-level guest name — invoice.service reads `notes.guestName`. */
  guestName?: string;
  /** Trip protection — surfaced to the host; the premium itself is applied in createOrder. */
  insuranceOptIn?: boolean;

  // --- Stay ---
  checkOutDate?: string;
  guestCount?: number;
  roomTypeId?: string;
  roomName?: string;
  roomCount?: number;

  // --- Service ---
  serviceMode?: 'at-home' | 'visit-provider' | 'online';
  /** At-home customer address. Canonical key the invoice reads. */
  serviceAddress?: string;
  /** Geocoded snapshot of serviceAddress (assistant's at-home verification) —
   *  gives the provider a mappable pin instead of a string to re-interpret. */
  serviceAddressGeo?: { lat: number; lng: number };
  /** Visit-provider listing address (display); online meeting details. */
  visitAddress?: string;
  meetingDetails?: string;
  serviceHours?: number;
  /** Human slot label the customer picked ("Mon 9:00 AM"). */
  slot?: string;
  serviceAddOns?: ServiceAddOnSnapshot[];
  /** Add-on ids only (the chat assistant collects ids, not snapshots).
   *  createHold resolves these server-side and rewrites notes to the
   *  canonical {id,label,price} snapshot — so pricing works either way. */
  serviceAddOnIds?: string[];
  serviceCatalogId?: string;
  serviceCatalogName?: string;
  serviceCatalogBasePrice?: number;

  // --- Transport ---
  transportMode?: 'hourly' | 'day' | 'package';
  pickupLocation?: string;
  passengerCount?: number;
  scheduledDate?: string;
  scheduledTime?: string;
  vehicleType?: string;
  transportationType?: string;
  transportationLabel?: string;
  // hourly
  transportHours?: number;
  transportStartTime?: string;
  transportEndTime?: string;
  transportSelectedSlots?: string[];
  // day
  transportDays?: number;
  transportEndDate?: string;
  // package
  transportPackageId?: string;
  transportPackageLabel?: string;
  transportPackagePrice?: number;
  transportPackageHours?: number;
}

/** Drop undefined values so the emitted JSON stays clean (JSON.stringify
 *  already omits undefined, but this keeps nested objects tidy too). */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

function contactBlock(input: PrepareBookingIntentInput): { contact?: BookingContact } {
  const c = input.contact;
  if (!c || (!c.name && !c.phone)) return {};
  return { contact: compact({ name: c.name, phone: c.phone }) as BookingContact };
}

function buildStayNotes(input: PrepareBookingIntentInput): Record<string, unknown> {
  return compact({
    checkOut: input.checkOutDate,
    guests: input.guestCount ?? 1,
    stayId: input.listingId,
    stayTitle: input.listingTitle,
    roomName: input.roomName,
    roomTypeId: input.roomTypeId,
    roomCount: input.roomCount,
    note: input.note ?? '',
    guestName: input.guestName,
    protection: Boolean(input.insuranceOptIn),
    ...contactBlock(input),
  });
}

function buildServiceNotes(input: PrepareBookingIntentInput): Record<string, unknown> {
  const addrBlock: Record<string, unknown> = {};
  if (input.serviceMode === 'at-home' && input.serviceAddress) {
    // `serviceAddress` is the key invoice.service reads; `customerAddress`
    // mirrors the legacy modal shape for any host-UI that read it.
    addrBlock.serviceAddress = input.serviceAddress;
    addrBlock.customerAddress = input.serviceAddress;
    if (input.serviceAddressGeo) addrBlock.serviceAddressGeo = input.serviceAddressGeo;
  } else if (input.serviceMode === 'visit-provider' && input.visitAddress) {
    addrBlock.visitAddress = input.visitAddress;
  } else if (input.serviceMode === 'online' && input.meetingDetails) {
    addrBlock.meetingDetails = input.meetingDetails;
  }
  return compact({
    serviceMode: input.serviceMode,
    serviceTitle: input.listingTitle,
    slot: input.slot,
    note: input.note ?? '',
    guestName: input.guestName,
    serviceHours: typeof input.serviceHours === 'number' && input.serviceHours > 0
      ? Math.round(input.serviceHours)
      : undefined,
    ...(input.serviceAddOns && input.serviceAddOns.length > 0
      ? { addOns: input.serviceAddOns.map((a) => compact({ id: a.id, label: a.label, price: a.price })) }
      // Fall back to ids-only (assistant path). createHold reads `addOnIds`,
      // prices them, and rewrites notes to the {id,label,price} snapshot.
      : input.serviceAddOnIds && input.serviceAddOnIds.length > 0
        ? { addOnIds: input.serviceAddOnIds }
        : {}),
    ...(input.serviceCatalogId
      ? {
          selectedServiceCatalogId: input.serviceCatalogId,
          selectedServiceName: input.serviceCatalogName,
          selectedServiceBasePrice: input.serviceCatalogBasePrice,
        }
      : {}),
    ...(input.insuranceOptIn ? { protection: true } : {}),
    ...contactBlock(input),
    ...addrBlock,
  });
}

function buildTransportNotes(input: PrepareBookingIntentInput): Record<string, unknown> {
  const mode = input.transportMode;
  return compact({
    transport: true,
    mode,
    // Alias the assistant historically emitted; invoice.service falls back to it.
    transportMode: mode,
    note: input.note ?? '',
    guestName: input.guestName,
    pickup: input.pickupLocation,
    pickupLocation: input.pickupLocation,
    passengers: input.passengerCount,
    scheduledDate: input.scheduledDate,
    scheduledTime: input.scheduledTime,
    vehicleType: input.vehicleType,
    ...(input.transportationType
      ? {
          selectedTransportationType: input.transportationType,
          selectedTransportationLabel: input.transportationLabel,
        }
      : {}),
    ...(input.insuranceOptIn ? { protection: true } : {}),
    ...contactBlock(input),
    ...(mode === 'hourly'
      ? compact({
          durationHours: input.transportHours,
          startTime: input.transportStartTime,
          endTime: input.transportEndTime,
          selectedSlots: input.transportSelectedSlots && input.transportSelectedSlots.length > 0
            ? [...input.transportSelectedSlots].sort()
            : undefined,
        })
      : {}),
    ...(mode === 'day'
      ? compact({
          days: typeof input.transportDays === 'number' ? Math.round(input.transportDays) : 1,
          endDate: input.transportEndDate,
        })
      : {}),
    ...(mode === 'package'
      ? compact({
          packageId: input.transportPackageId,
          packageLabel: input.transportPackageLabel,
          packagePrice: input.transportPackagePrice,
          packageHours: input.transportPackageHours,
        })
      : {}),
  });
}

/**
 * Build the booking `notes` JSON string for any listing type. Superset of
 * what the marketplace modal and the chat assistant each produce today, using
 * the key names downstream consumers (invoice, dashboards) actually read.
 */
export function buildBookingNotes(input: PrepareBookingIntentInput): string {
  const payload = input.listingType === 'stay'
    ? buildStayNotes(input)
    : input.listingType === 'service'
      ? buildServiceNotes(input)
      : buildTransportNotes(input);
  return JSON.stringify(payload);
}
