import { MapPin, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { OnboardingProfile } from "@/hooks/useConversationEngine";
import { isMultiRoomStay } from "@/lib/onboarding/field-registry.shared";
import { useLanguage } from "@/contexts/LanguageContext";

interface PreviewRoom {
  key: string;
  name: string;
  pricePerNight: string;
  maxGuests: number;
  quantity: number;
  /** Per-room amenities carried over from the AI agent's extraction so
   *  they survive the quick-confirm path (the preview UI doesn't edit
   *  them — the Form toggle does). Undefined for rooms added inline here. */
  amenities?: string[];
}

/** Map the agent's extracted roomTypes onto the preview's lighter room
 *  shape so a multi-room stay lands on a populated editor. */
function seedPreviewRooms(profile: OnboardingProfile): PreviewRoom[] {
  const incoming = profile.roomTypes;
  if (!Array.isArray(incoming) || incoming.length === 0) return [];
  return incoming.map((r, i) => ({
    key: `room-seed-${i}-${(r.name || "room").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16)}`,
    name: r.name ?? "",
    pricePerNight: r.pricePerNight != null ? String(r.pricePerNight) : "",
    maxGuests: r.maxGuests ?? 2,
    quantity: r.quantity ?? 1,
    amenities: Array.isArray(r.amenities) ? r.amenities : undefined,
  }));
}

interface OnboardingPreviewProps {
  profile: OnboardingProfile;
  isHost: boolean;
  isTransport: boolean;
  onConfirm: (rooms?: PreviewRoom[]) => Promise<unknown>;
  onEdit: () => void;
  lang?: string;
  /** Review-only mode: used by the MANUAL form path, where the form has
   *  already collected room photos + everything else. The preview is then a
   *  pure final review — Confirm submits directly (no "add room photos"
   *  detour), and the caller supplies its own already-collected room data,
   *  so onConfirm is called with no rooms. Defaults to false, preserving the
   *  AI path's behavior (where the preview seeds + routes room photos). */
  reviewOnly?: boolean;
}

const OnboardingPreview = ({ profile, isHost, isTransport, onConfirm, onEdit, lang = "en", reviewOnly = false }: OnboardingPreviewProps) => {
  const { t } = useLanguage();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rooms] = useState<PreviewRoom[]>(() => seedPreviewRooms(profile));
  // Multi-room stays (hotel / lodge / heritage / sathram) book individual
  // rooms, so the preview shows the room editor for all of them — not just
  // literal "hotel". Matches the form + backend multi-room gate.
  const isHotel = isMultiRoomStay(profile);
  const emoji = isHost ? "🏨" : isTransport ? "🚗" : "🔧";

  const handleConfirm = async () => {
    try {
      setIsSubmitting(true);
      // In review-only mode the caller owns the room data already, so don't
      // pass the preview's seeded rooms back.
      await onConfirm(reviewOnly ? undefined : (isHotel ? rooms : undefined));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in zoom-in-95 duration-500 overflow-y-auto">
      <div className="max-w-lg w-full my-auto">
        <div className="text-center mb-5">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center mx-auto mb-3 shadow-lg shadow-primary/20">
            <span className="text-2xl">{emoji}</span>
          </div>
          <h2 className="font-display text-xl font-bold text-foreground">
            {t("onboarding.profilePreviewTitle", { defaultValue: "Your Profile Preview" })}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{t("onboarding.profilePreviewSubtitle", { defaultValue: "Review and submit your listing" })}</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-5 shadow-lg space-y-5">
          <div className="flex items-start gap-3">
            <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary/15 to-accent/15 flex items-center justify-center text-2xl shrink-0">
              {emoji}
            </div>
            <div>
              <h3 className="font-display text-lg font-bold text-foreground">{profile.name}</h3>
              <p className="text-sm text-muted-foreground flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" />{profile.location}
              </p>
              {isTransport && profile.vehicleName && (
                <p className="text-xs text-muted-foreground mt-0.5">🚗 {profile.vehicleName}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <DetailBlock label={t("onboarding.detailCategory", { defaultValue: "Category" })} value={profile.category} />
            <DetailBlock label={t("onboarding.detailServiceArea", { defaultValue: "Service Area" })} value={profile.serviceArea} />
            <DetailBlock label={isHost ? t("onboarding.detailPriceNight", { defaultValue: "Price/Night" }) : t("onboarding.detailStartingPrice", { defaultValue: "Starting Price" })} value={`₹${profile.price}`} />
            <DetailBlock label={t("onboarding.detailAvailability", { defaultValue: "Availability" })} value={profile.availability} />
          </div>

          {/* Services catalog — service listings only. Falls back to the
              legacy flat add-ons block when the catalog is empty (covers
              in-flight drafts still on the old shape). */}
          {!isHost && !isTransport && profile.servicesCatalog && profile.servicesCatalog.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("onboarding.servicesCatalogLabel", { defaultValue: "Services catalog" })}</p>
              <div className="space-y-2">
                {profile.servicesCatalog.map((group) => (
                  <div key={group.id} className="bg-muted/40 rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-foreground">{group.name || t("onboarding.untitledService", { defaultValue: "Untitled service" })}</p>
                      <p className="text-sm font-medium text-foreground tabular-nums">₹{group.basePrice || 0}</p>
                    </div>
                    {group.addOns && group.addOns.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {group.addOns.map((a) => (
                          <li key={a.id} className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>+ {a.label}</span>
                            <span className="tabular-nums">₹{a.price}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {!isHost && !isTransport && (!profile.servicesCatalog || profile.servicesCatalog.length === 0) && profile.addOns && profile.addOns.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("onboarding.addOnsLabel", { defaultValue: "Add-ons" })}</p>
              <ul className="space-y-1">
                {profile.addOns.map((a) => (
                  <li key={a.id} className="flex items-center justify-between text-xs text-foreground">
                    <span>+ {a.label}</span>
                    <span className="tabular-nums">₹{a.price}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {profile.description && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">{t("onboarding.aboutLabel", { defaultValue: "About" })}</p>
              <p className="text-sm text-foreground leading-relaxed">{profile.description}</p>
            </div>
          )}

          {/* Room types — multi-room stays (hotel/lodge/heritage/sathram).
              Read-only summary of what the agent captured. Per-room photos
              (and any tweaks) are added on the next screen — the room
              editor — which is where the photo requirement is enforced, so
              "Continue" funnels there rather than publishing from here. */}
          {isHotel && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("onboarding.roomTypesLabel", { defaultValue: "Room types" })}</p>
              <div className="space-y-2">
                {rooms.length === 0 ? (
                  <div className="text-center py-3 border-2 border-dashed border-border rounded-xl text-xs text-muted-foreground">
                    {t("onboarding.roomTypesNextScreen", { defaultValue: "You'll add your room types on the next screen." })}
                  </div>
                ) : (
                  rooms.map((room) => (
                    <div key={room.key} className="bg-muted/40 rounded-xl p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{room.name || t("onboarding.roomTypeFallback", { defaultValue: "Room type" })}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {room.pricePerNight
                            ? t("onboarding.roomPricePerNight", { defaultValue: "₹{{price}}/night", price: room.pricePerNight })
                            : t("onboarding.roomPriceUnset", { defaultValue: "price —" })}
                          {` · ${t("onboarding.roomSummaryMeta", { defaultValue: "sleeps {{guests}} · {{count}} room(s)", guests: room.maxGuests || 2, count: room.quantity || 1 })}`}
                          {room.amenities?.length ? ` · ${t("onboarding.roomAmenitiesCount", { defaultValue: "{{count}} amenities", count: room.amenities.length })}` : ""}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 p-2.5 bg-primary/10 rounded-xl">
            <Check className="w-4 h-4 text-primary shrink-0" />
            <p className="text-xs text-primary font-medium">
              {isHotel && !reviewOnly
                ? t("onboarding.previewHotelNext", { defaultValue: "Next: add a photo to each room (required) and confirm to publish." })
                : t("onboarding.previewRequiredComplete", { defaultValue: "Required details are complete." })}
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1 rounded-xl" onClick={onEdit}>
              {t("onboarding.editButton", { defaultValue: "Edit" })}
            </Button>
            <Button size="sm" className="flex-1 rounded-xl font-semibold" onClick={() => void handleConfirm()} disabled={isSubmitting}>
              <Check className="w-4 h-4 mr-1" /> {reviewOnly
                ? t("onboarding.confirmAndSubmit", { defaultValue: "Confirm & Submit" })
                : (isHotel ? t("onboarding.addRoomPhotos", { defaultValue: "Add room photos" }) : t("onboarding.confirmAndCreate", { defaultValue: "Confirm & Create" }))}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

const DetailBlock = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{label}</p>
    <p className="text-sm font-medium text-foreground">{value || "—"}</p>
  </div>
);

export default OnboardingPreview;
