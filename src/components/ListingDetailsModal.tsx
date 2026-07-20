// Owner-facing read-only "everything about this listing" view, opened from
// the My Listings card's View button. Unlike the public detail page this is
// the OWNER looking at their own row, so nothing is masked — the private
// visit address, exact location and schedule all show. Mutations stay on the
// card's existing buttons (Edit / Rooms / Calendar / Schedule); this modal is
// deliberately action-free.
import { useQuery } from "@tanstack/react-query";
import { Bed, Clock, MapPin, Package } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { getListingService } from "@/domains";
import type { Listing } from "@/types/domain";

const DAY_LABELS: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun",
};
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function Field({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === "") return null;
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-words text-sm">{String(value)}</p>
    </div>
  );
}

export default function ListingDetailsModal({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const { t } = useLanguage();
  const meta = (listing.metadata || {}) as Record<string, any>;
  const propertyType = ((listing as any).propertyType || meta.propertyType || null) as string | null;
  const isMultiRoom = listing.category === "hotel" || propertyType === "sathram";

  // Room tiers only exist for multi-room stays; fetched lazily so a plain
  // service/vehicle view costs no extra request.
  const roomsQuery = useQuery({
    queryKey: ["listing-room-types", listing.id],
    enabled: isMultiRoom,
    queryFn: async () => {
      const r = await getListingService().listRoomTypes(listing.id);
      return r.success && r.data ? r.data : [];
    },
  });
  const rooms = (roomsQuery.data ?? []) as Array<{ id: string; name: string; base_price_paise?: number; quantity?: number; max_guests?: number | null }>;

  // Show every stored photo ref — on staging these are CDN https URLs, and
  // relative paths resolve against the origin. Anything that genuinely fails
  // to load hides itself via onError instead of rendering a broken box.
  const photos = (listing.photos || []).filter((p) => typeof p === "string" && p.length > 0);
  const amenities = Array.isArray(listing.amenities) ? listing.amenities : [];

  // Weekly hours ({ mon: ["09:00","18:00"], … }) — closed days are simply absent.
  const workingHours = meta.workingHours && typeof meta.workingHours === "object" ? (meta.workingHours as Record<string, unknown>) : null;
  const hourRows = workingHours
    ? DAY_ORDER.filter((d) => Array.isArray(workingHours[d]) && (workingHours[d] as unknown[]).length === 2)
        .map((d) => ({ day: DAY_LABELS[d] ?? d, hours: (workingHours[d] as [string, string]).join(" – ") }))
    : [];

  const serviceModes: string[] = Array.isArray(meta.serviceModes) ? meta.serviceModes : [];
  const modeLabels: Record<string, string> = {
    "at-home": t("myListings.modeAtHome", { defaultValue: "At customer's home" }),
    "visit-provider": t("myListings.modeAtYourLocation", { defaultValue: "At your location" }),
    "online": t("myListings.modeOnline", { defaultValue: "Online" }),
  };
  const transportPackages: Array<{ name?: string; label?: string; price?: number | string; hours?: number | string }> =
    Array.isArray(meta.packageOptions) ? meta.packageOptions : [];

  const dt = (v: string) => new Date(v).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* overflow-x-hidden + min-w-0 on the body: DialogContent is a CSS grid,
          and without them a wide child (the photo strip) sets the track's
          min-content width and forces the whole dialog to scroll sideways. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">{listing.name}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {/* category is typed string but null at runtime for drafts —
                guard so opening details on one never crashes the modal. */}
            <span className="capitalize">{(propertyType || listing.category)?.replace(/[-_]/g, " ") ?? ""}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${listing.isActive ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
              {listing.isActive ? t("myListings.statusActive", { defaultValue: "Active" }) : t("myListings.statusInactive", { defaultValue: "Inactive" })}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-5 text-sm">
          {photos.length > 0 && (
            <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
              {photos.slice(0, 10).map((src, i) => (
                <img key={i} src={src} alt=""
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                  className="h-28 w-40 shrink-0 rounded-xl border border-border/60 object-cover" />
              ))}
            </div>
          )}

          {listing.description && <p className="text-muted-foreground leading-relaxed">{listing.description}</p>}

          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Field label={t("myListings.viewLocation", { defaultValue: "Location" })} value={listing.location} />
            <Field label={t("myListings.viewServiceArea", { defaultValue: "Service area" })} value={listing.serviceArea} />
            <Field label={t("myListings.viewPrice", { defaultValue: "Price" })}
              value={listing.price ? `₹${String(listing.price).replace(/^\s*(?:₹|Rs\.?|INR)\s*/i, "")}` : null} />
            <Field label={t("myListings.viewAvailability", { defaultValue: "Availability" })} value={listing.availability} />
            <Field label={t("myListings.viewMaxGuests", { defaultValue: "Max guests" })} value={listing.maxGuests} />
            <Field label={t("myListings.viewBedrooms", { defaultValue: "Bedrooms" })} value={listing.bedrooms} />
            <Field label={t("myListings.viewBathrooms", { defaultValue: "Bathrooms" })} value={listing.bathrooms} />
            <Field label={t("myListings.viewVehicle", { defaultValue: "Vehicle" })}
              value={listing.vehicleName ? `${listing.vehicleName}${listing.vehicleYear ? ` (${listing.vehicleYear})` : ""}` : null} />
            <Field label={t("myListings.viewDiscount", { defaultValue: "Discount" })}
              value={listing.discountPercent ? `${listing.discountPercent}%` : null} />
            <Field label={t("myListings.viewCreated", { defaultValue: "Created" })} value={listing.createdAt ? dt(listing.createdAt) : null} />
            <Field label={t("myListings.viewUpdated", { defaultValue: "Last updated" })} value={listing.updatedAt ? dt(listing.updatedAt) : null} />
          </div>

          {/* Owner-only private details — never on the public page. */}
          {(meta.visitAddress || meta.meetingDetails) && (
            <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("myListings.viewPrivate", { defaultValue: "Private details (only you see these)" })}
              </p>
              {meta.visitAddress && (
                <p className="flex items-start gap-1.5"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 break-words">{String(meta.visitAddress)}</span></p>
              )}
              {meta.meetingDetails && <p className="break-words text-muted-foreground">{t("myListings.onlineLabel", { defaultValue: "Online" })}: {String(meta.meetingDetails)}</p>}
            </div>
          )}

          {serviceModes.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("myListings.viewServiceModes", { defaultValue: "Service modes" })}</p>
              <div className="flex flex-wrap gap-1.5">
                {serviceModes.map((m) => (
                  <span key={m} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary border border-primary/20">{modeLabels[m] ?? m}</span>
                ))}
                {meta.pricingUnit && (
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground border border-border">{String(meta.pricingUnit).replace(/^per_/, "per ").replace(/_/g, " ")}</span>
                )}
              </div>
            </div>
          )}

          {(meta.transportMode || Number(meta.pricePerHour) > 0 || Number(meta.pricePerDay) > 0 || transportPackages.length > 0) && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("myListings.viewTransport", { defaultValue: "Trip options" })}</p>
              <div className="flex flex-wrap gap-1.5">
                {meta.transportMode && <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary border border-primary/20 capitalize">{String(meta.transportMode)}</span>}
                {Number(meta.pricePerHour) > 0 && <span className="rounded-full bg-muted px-2.5 py-1 text-xs border border-border">₹{Number(meta.pricePerHour)}/hr</span>}
                {Number(meta.pricePerDay) > 0 && <span className="rounded-full bg-muted px-2.5 py-1 text-xs border border-border">₹{Number(meta.pricePerDay)}/day</span>}
              </div>
              {transportPackages.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {transportPackages.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                      <Package className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{p.name || p.label || t("myListings.viewPackage", { defaultValue: "Package" })}</span>
                      {p.price != null && <span className="ml-auto text-muted-foreground">₹{p.price}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {hourRows.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Clock className="mr-1 inline h-3 w-3" />{t("myListings.viewWorkingHours", { defaultValue: "Working hours" })}
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                {hourRows.map((r) => (
                  <p key={r.day} className="text-xs"><span className="inline-block w-9 font-medium">{r.day}</span><span className="tabular-nums text-muted-foreground">{r.hours}</span></p>
                ))}
              </div>
            </div>
          )}

          {amenities.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("myListings.viewAmenities", { defaultValue: "Amenities" })}</p>
              <div className="flex flex-wrap gap-1.5">
                {amenities.map((a) => <span key={a} className="rounded-full bg-muted px-2.5 py-0.5 text-xs">{a}</span>)}
              </div>
            </div>
          )}

          {isMultiRoom && rooms.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Bed className="mr-1 inline h-3 w-3" />{t("myListings.viewRoomTypes", { defaultValue: "Room types" })}
              </p>
              <div className="space-y-1.5">
                {rooms.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                    <span className="font-medium">{r.name}</span>
                    <span className="text-muted-foreground">
                      ₹{(Number(r.base_price_paise ?? 0) / 100).toLocaleString("en-IN")}/night · ×{r.quantity ?? 1}
                      {r.max_guests ? ` · ${t("myListings.viewSleeps", { defaultValue: "sleeps {{n}}", n: r.max_guests })}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t("myListings.viewFootnote", { defaultValue: "Read-only view — use Edit on the listing card to make changes." })}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
