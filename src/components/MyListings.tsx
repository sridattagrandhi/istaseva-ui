import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bed, Building, CalendarDays, Car, Eye, Zap, Sparkles, Wrench, MapPin, Plus, Pencil, Trash2, ToggleLeft, ToggleRight, Package, AlertCircle, Shield, Clock } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getListingService, getProviderService } from "@/domains";
import { getVerificationService } from "@/domains/verification/verification.service";
import type { Listing } from "@/types/domain";
import { toast } from "sonner";
import EditListingModal from "./EditListingModal";
import ListingDetailsModal from "./ListingDetailsModal";
import RoomTypesManager from "./RoomTypesManager";
import AvailabilityCalendar from "./AvailabilityCalendar";
import TransportScheduleDialog from "./TransportScheduleDialog";
import ServiceScheduleDialog from "./ServiceScheduleDialog";
import { ListingNotReadyDialog, type ListingNotReadyItem } from "./ListingNotReadyDialog";
import { AddListingChooserDialog } from "./AddListingChooserDialog";
import {
  listOnboardingDrafts,
  clearOnboardingDraft,
  describeAge,
  type OnboardingDraftSummary,
} from "@/lib/onboarding-draft";

const stayCategories = new Set(["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram"]);
const transportCategories = new Set([
  "driver-auto", "driver-cab", "driver-bus", "driver-tempo",
  "driver-scooter", "driver-motorcycle",
]);

function isStayCategory(cat: string) { return stayCategories.has(cat); }
function isTransportCategory(cat: string) { return transportCategories.has(cat); }

/** Returns the list of document types required for a listing to go public */
function getRequiredDocs(category: string): { type: string; label: string }[] {
  const docs: { type: string; label: string }[] = [{ type: "aadhaar", label: "Aadhaar Card" }];
  if (isTransportCategory(category)) {
    docs.push({ type: "driving_license", label: "Driving License" });
  }
  return docs;
}

const categoryIcons: Record<string, React.ElementType> = {
  hotel: Building,
  homestay: Building,
  "driver-auto": Car,
  "driver-cab": Car,
  "driver-bus": Car,
  "driver-tempo": Car,
  "driver-scooter": Car,
  "driver-motorcycle": Car,
  electrician: Zap,
  cleaner: Sparkles,
  plumber: Wrench,
};

const categoryColors: Record<string, string> = {
  hotel: "bg-primary/10 text-primary",
  homestay: "bg-primary/10 text-primary",
  "driver-auto": "bg-accent/10 text-accent",
  "driver-cab": "bg-accent/10 text-accent",
  "driver-bus": "bg-accent/10 text-accent",
  "driver-tempo": "bg-accent/10 text-accent",
  "driver-scooter": "bg-accent/10 text-accent",
  "driver-motorcycle": "bg-accent/10 text-accent",
  electrician: "bg-secondary/10 text-secondary",
  cleaner: "bg-secondary/10 text-secondary",
  plumber: "bg-secondary/10 text-secondary",
};

interface MyListingsProps {
  /**
   * Filter to only show listings of this type.
   *   "stay"      → properties (hotels/homestays/etc.)
   *   "service"   → InstaHelp-style services only (electricians, cleaners, …)
   *   "transport" → drivers / autos / cabs
   *   undefined   → all of the above
   *
   * Services and transport are separate dashboard sections per the product
   * split: a plumber and an auto-driver are different businesses with
   * different booking UX, and we don't want them stacked in one list.
   */
  filter?: "stay" | "service" | "transport";
}

const MyListings = ({ filter }: MyListingsProps) => {
  const { user } = useAuth();
  const { t } = useLanguage();
  // When opened from the "not ready" activation flow we also carry the
  // structured `missing[]` so the edit modal can pre-highlight + scroll to
  // the offending field. A plain edit (pencil button) leaves `missing`
  // undefined so the modal behaves as before.
  const [editListing, setEditListing] = useState<{ listing: Listing; missing?: ListingNotReadyItem[] } | null>(null);
  const [viewListing, setViewListing] = useState<Listing | null>(null);
  const [roomManagerListing, setRoomManagerListing] = useState<Listing | null>(null);
  const [calendarListing, setCalendarListing] = useState<Listing | null>(null);
  const [transportScheduleListing, setTransportScheduleListing] = useState<Listing | null>(null);
  const [serviceScheduleListing, setServiceScheduleListing] = useState<Listing | null>(null);
  const [calendarRooms, setCalendarRooms] = useState<Array<{ id: string; name: string }>>([]);
  // Surfaces the structured "missing requirements" returned by the server
  // when an activation attempt is blocked. We pair it with the listing that
  // was being activated so the "Add photos" primary action can jump
  // straight into that listing's edit modal.
  const [notReady, setNotReady] = useState<{ listing: Listing; missing: ListingNotReadyItem[] } | null>(null);
  // All "Add new" affordances open the AI-vs-form chooser (same dialog as the
  // dashboard toolbar "+ Add") instead of hard-jumping into the AI flow.
  const [addChooserOpen, setAddChooserOpen] = useState(false);
  const addChooserType = filter === "stay" ? "host" : filter === "service" ? "service" : filter === "transport" ? "transport" : undefined;
  const queryClient = useQueryClient();
  const listingsQuery = useQuery({
    queryKey: ["my-listings", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getListingService().getByUserId(String(user?.id));
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load listings");
      return result.data;
    },
  });

  const allListings = listingsQuery.data || [];
  const listings = filter
    ? allListings.filter(l => {
        if (filter === "stay") return isStayCategory(l.category);
        if (filter === "transport") return isTransportCategory(l.category);
        // "service" — InstaHelp only, excluding stays and transport.
        return !isStayCategory(l.category) && !isTransportCategory(l.category);
      })
    : allListings;

  // Saved-but-not-yet-submitted drafts surface as resumable rows above the
  // published listings. Filtered to the dashboard section the user is on
  // (a host shouldn't see a transport draft sitting under "My properties").
  const [draftRev, setDraftRev] = useState(0);
  const drafts = useMemo<OnboardingDraftSummary[]>(
    () => listOnboardingDrafts(user?.id).filter((d) => {
      if (!filter) return true;
      if (filter === "stay") return d.type === "stay";
      if (filter === "transport") return d.type === "transport";
      return d.type === "service";
    }),
    // draftRev is a manual nudge to recompute after a delete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, filter, draftRev],
  );

  // Fetch provider profile + verification documents to check KYC gating
  const { data: providerProfile } = useQuery({
    queryKey: ["provider-profile", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getProviderService().getProfileByUserId(String(user?.id));
      return result.success ? result.data : null;
    },
  });
  const { data: verificationDocs = [] } = useQuery({
    queryKey: ["verification-documents", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getVerificationService().getDocuments();
      return result.success && result.data ? result.data : [];
    },
  });
  const approvedDocTypes = new Set(verificationDocs.filter((d: any) => d.status === "approved").map((d: any) => d.documentType));

  function getMissingDocs(category: string) {
    return getRequiredDocs(category).filter(d => !approvedDocTypes.has(d.type));
  }
  // Doc labels are user-visible; translate by type at the render site.
  const docLabel = (type: string, fallback: string) => {
    if (type === "aadhaar") return t("myListings.docAadhaar", { defaultValue: "Aadhaar Card" });
    if (type === "driving_license") return t("myListings.docDrivingLicense", { defaultValue: "Driving License" });
    return fallback;
  };

  // Both the host dashboard list AND every marketplace surface (rails, list
  // pages, detail pages) read from React Query. After any mutation we
  // invalidate the host-side key explicitly and every marketplace-* key via
  // predicate so the discovery feed reflects the change without a manual
  // reload. Predicates are O(n) over cached query keys, but the cache is
  // tiny here so it's fine.
  const invalidateListingViews = () => {
    void queryClient.invalidateQueries({ queryKey: ["my-listings", user?.id] });
    void queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("marketplace-"),
    });
  };

  const toggleMutation = useMutation({
    mutationFn: async (listing: Listing) => {
      const result = await getListingService().update(listing.id, { isActive: !listing.isActive });
      if (!result.success) {
        // Surface the backend's structured `missing` list in a modal so the
        // host actually sees what's blocking activation. The previous toast
        // version got dismissed before hosts had time to read it.
        const details = result.errorDetails as { missing?: ListingNotReadyItem[] } | undefined;
        if (result.code === "LISTING_NOT_READY" && details?.missing?.length) {
          setNotReady({ listing, missing: details.missing });
          throw new Error("listing_not_ready");
        }
        throw new Error(result.error || "Failed to update listing");
      }
      return result.data;
    },
    onSuccess: (updated) => {
      invalidateListingViews();
      toast.success(updated?.isActive ? t("myListings.listingActivated", { defaultValue: "Listing activated" }) : t("myListings.listingDeactivated", { defaultValue: "Listing deactivated" }));
    },
    onError: (error: Error) => {
      if (error.message !== "listing_not_ready") toast.error(error.message);
    },
  });

  // Listing deletion is admin-only (soft archive via the ops console) — hosts
  // deactivate instead, so booking/invoice history is never orphaned.
  const loadingItemId = useMemo(() => {
    return (toggleMutation.variables as Listing | undefined)?.id || null;
  }, [toggleMutation.variables]);

  const handleSave = async () => {
    invalidateListingViews();
  };

  if (listingsQuery.isLoading) {
    return <div className="bg-card rounded-2xl border border-border p-12 text-center text-sm text-muted-foreground">{t("myListings.loading", { defaultValue: "Loading your listings..." })}</div>;
  }

  if (listingsQuery.error) {
    return <div className="bg-card rounded-2xl border border-border p-12 text-center text-sm text-muted-foreground">{t("myListings.loadError", { defaultValue: "Unable to load your listings right now." })}</div>;
  }

  const onDeleteDraft = (type: OnboardingDraftSummary["type"]) => {
    clearOnboardingDraft(user?.id, type);
    setDraftRev((n) => n + 1);
  };

  if (listings.length === 0) {
    return (
      <div className="space-y-4">
        {drafts.length > 0 && (
          <DraftsSection drafts={drafts} onDelete={onDeleteDraft} />
        )}
        <div className="bg-card rounded-2xl border border-border p-12 text-center">
          <Package className="w-14 h-14 text-muted-foreground/30 mx-auto mb-4" />
          <h3 className="font-display font-semibold text-lg mb-2">{t("myListings.noListings", { defaultValue: "No listings yet" })}</h3>
          <p className="text-sm text-muted-foreground mb-6">
            {t("myListings.noListingsDesc", { defaultValue: "Create your first listing — property, service, or transport. Set it up with the AI assistant or fill the form yourself." })}
          </p>
          <Button className="rounded-xl" onClick={() => setAddChooserOpen(true)}>
            <Plus className="w-4 h-4 mr-1.5" />{
              // Name the section's listing type in the CTA. The unfiltered
              // guest Listings tab keeps the generic label — it spans all
              // three types.
              filter === "stay" ? t("myListings.addFirstStay", { defaultValue: "Add your first property" })
              : filter === "service" ? t("myListings.addFirstService", { defaultValue: "Add your first service" })
              : filter === "transport" ? t("myListings.addFirstTransport", { defaultValue: "Add your first vehicle" })
              : t("myListings.addFirstListing", { defaultValue: "Add your first listing" })
            }
          </Button>
        </div>
        <AddListingChooserDialog open={addChooserOpen} onOpenChange={setAddChooserOpen} type={addChooserType} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-display font-semibold text-lg">{t("myListings.heading", { defaultValue: "My Listings" })}</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{listings.length !== 1 ? t("myListings.listingCountOther", { defaultValue: "{{count}} listings", count: listings.length }) : t("myListings.listingCountOne", { defaultValue: "{{count}} listing", count: listings.length })}</span>
          <Button size="sm" className="rounded-full" onClick={() => setAddChooserOpen(true)}>
            <Plus className="w-3.5 h-3.5 mr-1" />{t("myListings.addNew", { defaultValue: "Add New" })}
          </Button>
        </div>
      </div>

      {drafts.length > 0 && (
        <DraftsSection drafts={drafts} onDelete={onDeleteDraft} />
      )}

      {listings.map(listing => {
        const Icon = categoryIcons[listing.category] || Wrench;
        const colorClass = categoryColors[listing.category] || "bg-muted text-muted-foreground";
        const missing = getMissingDocs(listing.category);
        const canGoPublic = missing.length === 0;

        return (
          <div key={listing.id} className={`bg-card rounded-2xl border border-border p-4 sm:p-5 flex flex-col sm:flex-row gap-4 hover:shadow-md transition-all ${!listing.isActive ? "opacity-60" : ""}`}>
            <div className={`w-14 h-14 rounded-xl ${colorClass} flex items-center justify-center shrink-0`}>
              <Icon className="w-6 h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-display font-semibold">{listing.name}</h3>
                  {/* Show the user-facing property type (Sathram / Lodge /
                      Heritage / Village stay / Farm stay) when the host
                      onboarded one. Falls back to the row's category for
                      services / transport / single-bucket stays. Without
                      this, a sathram listing — stored as category=homestay
                      + metadata.propertyType=sathram — wrongly read as
                      "Homestay" on the host dashboard. */}
                  <p className="text-xs text-muted-foreground capitalize">
                    {/* category is typed string but is null at runtime for
                        drafts — guard so a null-category row never crashes the
                        whole dashboard (app error boundary). */}
                    {(((listing as any).propertyType
                      || (listing as any).metadata?.propertyType
                      || listing.category) as string | null | undefined)?.replace(/[-_]/g, " ") ?? ""}
                  </p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                  listing.isActive && canGoPublic ? "bg-success/10 text-success border border-success/20" :
                  listing.isActive && !canGoPublic ? "bg-yellow-50 text-yellow-700 border border-yellow-200" :
                  "bg-muted text-muted-foreground border border-border"
                }`}>
                  {listing.isActive && !canGoPublic ? t("myListings.statusHidden", { defaultValue: "Hidden" }) : listing.isActive ? t("myListings.statusActive", { defaultValue: "Active" }) : t("myListings.statusInactive", { defaultValue: "Inactive" })}
                </span>
              </div>

              {/* Verification warning — shown when docs are missing */}
              {missing.length > 0 && (
                <Link to="/provider/verification"
                  className="mt-2 flex items-start gap-2 p-2.5 rounded-xl bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs hover:bg-yellow-100 transition-colors">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">{t("myListings.cantGoPublic", { defaultValue: "This listing can't go public yet" })}</p>
                    <p className="text-yellow-700 mt-0.5">
                      {t("myListings.missing", { defaultValue: "Missing" })}: {missing.map(d => docLabel(d.type, d.label)).join(", ")}. <span className="underline">{t("myListings.uploadNow", { defaultValue: "Upload now →" })}</span>
                    </p>
                  </div>
                </Link>
              )}

              {/* Scheduling warning — services that don't have any working hours set
                  can't surface bookable times in the customer modal. Surface a
                  friendly prompt so providers know to add availability. */}
              {!isStayCategory(listing.category) && !isTransportCategory(listing.category) && (() => {
                const wh = listing.metadata?.workingHours;
                const hasHours = wh && typeof wh === "object" && Object.values(wh).some(
                  (v) => Array.isArray(v) && v.length === 2,
                );
                const hasSlots = Array.isArray(listing.metadata?.serviceTimeSlots) && listing.metadata.serviceTimeSlots.length > 0;
                if (hasHours || hasSlots) return null;
                return (
                  <div className="mt-2 flex items-start gap-2 p-2.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-800 text-xs">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">{t("myListings.addAvailability", { defaultValue: "Add availability so customers can book times" })}</p>
                      <p className="text-blue-700 mt-0.5">
                        {t("myListings.addAvailabilityDesc", { defaultValue: "Open “Edit” and set your weekly hours + appointment duration. Customers will see bookable slots immediately." })}
                      </p>
                    </div>
                  </div>
                );
              })()}

              {/* Address = compact bold meta line with the pin; description =
                  regular reading text in a stronger ink. Distinct size/weight/
                  color so the two fields never read as one blob. */}
              {listing.location && (
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1 mt-1.5 uppercase tracking-wide">
                  <MapPin className="w-3.5 h-3.5 shrink-0" />{listing.location}
                  {listing.serviceArea && ` • ${listing.serviceArea}`}
                </p>
              )}

              {listing.description && (
                <p className="text-sm text-foreground/75 leading-relaxed mt-1.5 line-clamp-2">{listing.description}</p>
              )}

              <div className="flex items-center gap-4 mt-3 text-sm">
                {listing.price && (
                  // The price field is free text — the onboarding chat may
                  // extract it with a "₹" already prefixed (e.g. "₹5/km"),
                  // or as a bare number ("500/visit"). Strip a leading ₹ /
                  // Rs / INR + optional whitespace before re-prefixing so
                  // we never render "₹₹5/km".
                  <span className="font-bold">₹{String(listing.price).replace(/^\s*(?:₹|Rs\.?|INR)\s*/i, "")}</span>
                )}
                {listing.availability && <span className="text-muted-foreground">{listing.availability}</span>}
              </div>

              {/* Passive mode/pricing summary for service + transport. Edit
                  routes through the existing Edit button below — these chips
                  are read-only. Hidden for stays (their summary is the room/
                  calendar managers). Renders nothing when a listing predates
                  the mode-aware metadata, so legacy rows stay clean. */}
              <ListingModeSummary listing={listing} />

              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50 flex-wrap">
                <Button size="sm" variant="outline" className="rounded-full text-xs" onClick={() => setViewListing(listing)}>
                  <Eye className="w-3 h-3 mr-1" />{t("myListings.view", { defaultValue: "View" })}
                </Button>
                <Button size="sm" variant="outline" className="rounded-full text-xs" onClick={() => setEditListing({ listing })}>
                  <Pencil className="w-3 h-3 mr-1" />{t("myListings.edit", { defaultValue: "Edit" })}
                </Button>
                {/* Multi-room stays use the dedicated rooms manager —
                    `category === "hotel"` covers hotel/lodge/heritage (they
                    all share that category bucket). Sathrams sit under the
                    `homestay` category but expose multiple cell/dorm tiers,
                    so we surface the button via `propertyType` (top-level
                    `listings.property_type` column). Single-unit homestays /
                    village-stay / farm-stay still have one nightly price
                    and never need the rooms UI. */}
                {(listing.category === "hotel"
                  || (listing as any).propertyType === "sathram"
                  || (listing as any).metadata?.propertyType === "sathram") && (
                  <Button size="sm" variant="outline" className="rounded-full text-xs" onClick={() => setRoomManagerListing(listing)}>
                    <Bed className="w-3 h-3 mr-1" />{t("myListings.rooms", { defaultValue: "Rooms" })}
                  </Button>
                )}
                {isStayCategory(listing.category) && (
                  <Button size="sm" variant="outline" className="rounded-full text-xs"
                    onClick={async () => {
                      // Fetch rooms once so the calendar can offer per-room
                      // editing for any multi-room stay. Hotel covers
                      // hotel/lodge/heritage (shared category); sathrams
                      // sit under the homestay category but expose room
                      // tiers via property_type. Check both the top-level
                      // column AND the metadata fallback so legacy rows
                      // that only stamped it on metadata still light up.
                      let rooms: Array<{ id: string; name: string }> = [];
                      const isMultiRoomStay =
                        listing.category === "hotel"
                        || (listing as any).propertyType === "sathram"
                        || (listing as any).metadata?.propertyType === "sathram";
                      if (isMultiRoomStay) {
                        const r = await getListingService().listRoomTypes(listing.id);
                        if (r.success && r.data) rooms = r.data.map((rr: any) => ({ id: rr.id, name: rr.name }));
                      }
                      setCalendarRooms(rooms);
                      setCalendarListing(listing);
                    }}>
                    <CalendarDays className="w-3 h-3 mr-1" />{t("myListings.calendar", { defaultValue: "Calendar" })}
                  </Button>
                )}
                {isTransportCategory(listing.category) && (
                  <Button size="sm" variant="outline" className="rounded-full text-xs"
                    onClick={() => setTransportScheduleListing(listing)}>
                    <Clock className="w-3 h-3 mr-1" />{t("myListings.schedule", { defaultValue: "Schedule" })}
                  </Button>
                )}
                {/* Services get day-level blocking too. Stays use the Calendar
                    (pricing + rooms); transport uses its hourly schedule; a
                    plain service only needs whole-day blocks. */}
                {!isStayCategory(listing.category) && !isTransportCategory(listing.category) && (
                  <Button size="sm" variant="outline" className="rounded-full text-xs"
                    onClick={() => setServiceScheduleListing(listing)}>
                    <Clock className="w-3 h-3 mr-1" />{t("myListings.schedule", { defaultValue: "Schedule" })}
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="rounded-full text-xs"
                  onClick={() => {
                    if (!listing.isActive && !canGoPublic) {
                      toast.error(t("myListings.uploadBeforeActivate", { defaultValue: "Upload {{docs}} before activating this listing.", docs: missing.map(d => docLabel(d.type, d.label)).join(" and ") }));
                      return;
                    }
                    toggleMutation.mutate(listing);
                  }}
                  disabled={toggleMutation.isPending && loadingItemId === listing.id}
                >
                  {listing.isActive ? <ToggleRight className="w-4 h-4 mr-1 text-success" /> : <ToggleLeft className="w-4 h-4 mr-1" />}
                  {listing.isActive ? t("myListings.deactivate", { defaultValue: "Deactivate" }) : t("myListings.activate", { defaultValue: "Activate" })}
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => setAddChooserOpen(true)}
        className="w-full rounded-2xl h-20 border-2 border-dashed border-border text-muted-foreground hover:text-primary hover:border-primary/30 transition-all flex items-center justify-center gap-2 bg-card/50"
      >
        <Plus className="w-5 h-5" />{t("myListings.addNewListing", { defaultValue: "Add New Listing" })}
      </button>

      <AddListingChooserDialog open={addChooserOpen} onOpenChange={setAddChooserOpen} type={addChooserType} />

      {viewListing && (
        <ListingDetailsModal listing={viewListing} onClose={() => setViewListing(null)} />
      )}

      {editListing && (
        <EditListingModal
          listing={editListing.listing}
          initialMissing={editListing.missing}
          onClose={() => setEditListing(null)}
          onSave={handleSave}
        />
      )}

      {roomManagerListing && (
        <RoomTypesManager
          listingId={roomManagerListing.id}
          listingName={roomManagerListing.name}
          onClose={() => setRoomManagerListing(null)}
        />
      )}

      {calendarListing && (
        <AvailabilityCalendar
          listingId={calendarListing.id}
          listingName={calendarListing.name}
          rooms={calendarRooms}
          onClose={() => { setCalendarListing(null); setCalendarRooms([]); }}
        />
      )}

      {transportScheduleListing && (
        <TransportScheduleDialog
          listing={transportScheduleListing}
          onClose={() => setTransportScheduleListing(null)}
        />
      )}

      {serviceScheduleListing && (
        <ServiceScheduleDialog
          listing={serviceScheduleListing}
          onClose={() => setServiceScheduleListing(null)}
        />
      )}

      <ListingNotReadyDialog
        missing={notReady?.missing ?? null}
        onClose={() => setNotReady(null)}
        primaryAction={notReady ? {
          label: t("myListings.editListing", { defaultValue: "Edit listing" }),
          onClick: () => {
            // Carry the missing[] through so the modal opens with red
            // borders on the exact fields the readiness validator flagged
            // and auto-scrolls to the first one.
            setEditListing({ listing: notReady.listing, missing: notReady.missing });
            setNotReady(null);
          },
        } : undefined}
      />
    </div>
  );
};

/**
 * Read-only summary chips for a service or transport listing. Surfaces the
 * mode-aware metadata (service modes / pricing unit / visit address /
 * online delivery; or transport mode + per-mode prices + package count) so
 * a provider can see at a glance what their listing actually offers without
 * opening the edit modal.
 *
 * Renders nothing for stays (their summary is the room/calendar managers)
 * and nothing for service/transport rows that predate the mode-aware
 * onboarding — those listings show only the existing price/availability
 * line until the provider opens Edit and fills the new fields.
 */
function ListingModeSummary({ listing }: { listing: Listing }) {
  const { t } = useLanguage();
  const metadata = (listing.metadata || {}) as Record<string, any>;
  if (isStayCategory(listing.category)) return null;

  if (isTransportCategory(listing.category)) {
    const mode = typeof metadata.transportMode === "string" ? metadata.transportMode : "";
    const hourly = Number(metadata.pricePerHour) || 0;
    const day = Number(metadata.pricePerDay) || 0;
    const packages = Array.isArray(metadata.packageOptions) ? metadata.packageOptions : [];
    // Legacy row — no mode-aware metadata, nothing to summarize.
    if (!mode && hourly === 0 && day === 0 && packages.length === 0) return null;
    const modeLabel = mode
      ? mode === "point" ? t("myListings.pointRideBeta", { defaultValue: "Point ride · beta" }) : mode.charAt(0).toUpperCase() + mode.slice(1)
      : t("myListings.modeNotSet", { defaultValue: "Mode not set" });
    return (
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary border border-primary/20 px-2.5 py-1 font-semibold">
          {modeLabel}
        </span>
        {hourly > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground border border-border px-2.5 py-1">
            ₹{hourly}/hr
          </span>
        )}
        {day > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground border border-border px-2.5 py-1">
            ₹{day}/day
          </span>
        )}
        {packages.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 text-accent border border-accent/20 px-2.5 py-1 font-semibold">
            <Package className="w-3 h-3" /> {packages.length === 1 ? t("myListings.packageCountOne", { defaultValue: "{{count}} package", count: packages.length }) : t("myListings.packageCountOther", { defaultValue: "{{count}} packages", count: packages.length })}
          </span>
        )}
      </div>
    );
  }

  // Service.
  const modes: string[] = Array.isArray(metadata.serviceModes) ? metadata.serviceModes : [];
  const pricingUnit = typeof metadata.pricingUnit === "string" ? metadata.pricingUnit : "";
  const visitAddress = typeof metadata.visitAddress === "string" ? metadata.visitAddress : "";
  const meetingDetails = typeof metadata.meetingDetails === "string" ? metadata.meetingDetails : "";
  if (modes.length === 0 && !pricingUnit && !visitAddress && !meetingDetails) return null;

  const modeLabels: Record<string, string> = {
    "at-home": t("myListings.modeAtHome", { defaultValue: "At customer's home" }),
    "visit-provider": t("myListings.modeAtYourLocation", { defaultValue: "At your location" }),
    "online": t("myListings.modeOnline", { defaultValue: "Online" }),
  };
  const unitLabel = pricingUnit ? pricingUnit.replace(/^per_/, t("myListings.perPrefix", { defaultValue: "per " })).replace(/_/g, " ") : "";

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {modes.length > 0 ? (
          modes.map((m) => (
            <span key={m} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary border border-primary/20 px-2.5 py-1 font-semibold">
              {modeLabels[m] ?? m}
            </span>
          ))
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground border border-border px-2.5 py-1">
            {t("myListings.modeNotSet", { defaultValue: "Mode not set" })}
          </span>
        )}
        {unitLabel && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground border border-border px-2.5 py-1">
            {unitLabel}
          </span>
        )}
      </div>
      {modes.includes("visit-provider") && visitAddress && (
        <p className="text-[11px] text-muted-foreground flex items-start gap-1">
          <MapPin className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="truncate">{t("myListings.visitAt", { defaultValue: "Visit at" })}: {visitAddress}</span>
        </p>
      )}
      {modes.includes("online") && meetingDetails && (
        <p className="text-[11px] text-muted-foreground line-clamp-1">{t("myListings.onlineLabel", { defaultValue: "Online" })}: {meetingDetails}</p>
      )}
    </div>
  );
}

/** Renders the saved-but-unpublished drafts as resumable rows. Each row
 *  links back to the onboarding doorway that matches the draft's type so
 *  the user lands in the same flow they left, and offers a Delete to
 *  drop the draft entirely. */
function DraftsSection({
  drafts,
  onDelete,
}: {
  drafts: OnboardingDraftSummary[];
  onDelete: (type: OnboardingDraftSummary["type"]) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-3">
      {drafts.map((d) => {
        const continueHref =
          d.type === "stay" ? "/onboarding?type=host&mode=form"
            : d.type === "transport" ? "/onboarding?type=transport&mode=form"
              : d.type === "service" ? "/onboarding?type=service&mode=form"
                : "/onboarding?mode=form";
        const typeLabel =
          d.type === "stay" ? t("myListings.typeProperty", { defaultValue: "Property" }) :
          d.type === "transport" ? t("myListings.typeTransport", { defaultValue: "Transport" }) :
          d.type === "service" ? t("myListings.typeService", { defaultValue: "Service" }) : t("myListings.typeListing", { defaultValue: "Listing" });
        return (
          <div key={d.type} className="bg-yellow-50/60 border border-yellow-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row gap-4">
            <div className="w-14 h-14 rounded-xl bg-yellow-100 text-yellow-700 flex items-center justify-center shrink-0">
              <Pencil className="w-6 h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-display font-semibold">
                    {d.name || t("myListings.untitledDraft", { defaultValue: "Untitled {{type}} draft", type: typeLabel.toLowerCase() })}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {typeLabel}{d.category ? ` · ${d.category.replace("-", " ")}` : ""} · {t("myListings.savedAge", { defaultValue: "saved {{age}}", age: describeAge(d.savedAt) })}
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 bg-yellow-100 text-yellow-800 border border-yellow-300">
                  {t("myListings.draftBadge", { defaultValue: "Draft" })}
                </span>
              </div>
              {d.location && (
                <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1.5">
                  <MapPin className="w-3.5 h-3.5" />{d.location}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {d.photoCount === 1 ? t("myListings.photoSavedOne", { defaultValue: "{{count}} photo saved", count: d.photoCount }) : t("myListings.photoSavedOther", { defaultValue: "{{count}} photos saved", count: d.photoCount })}
              </p>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-yellow-200/60 flex-wrap">
                <Button size="sm" className="rounded-full text-xs" asChild>
                  <Link to={continueHref}>{t("myListings.continueDraft", { defaultValue: "Continue draft" })}</Link>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full text-xs text-destructive hover:text-destructive"
                  onClick={() => {
                    onDelete(d.type);
                    toast.success(t("myListings.draftDeleted", { defaultValue: "Draft deleted." }));
                  }}
                >
                  <Trash2 className="w-3 h-3 mr-1" />{t("myListings.deleteDraft", { defaultValue: "Delete draft" })}
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default MyListings;
