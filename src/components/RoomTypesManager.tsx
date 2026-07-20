import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bed, ImagePlus, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getListingService } from "@/domains";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getAccessToken } from "@/lib/api-client";
import { buildUploadKey } from "@/lib/storage-key";
import { toast } from "sonner";

interface Props {
  listingId: string;
  listingName?: string;
  onClose: () => void;
}

interface Draft {
  id?: string;
  name: string;
  description: string;
  pricePerNight: string; // ₹ as string for input
  maxGuests: number;
  /** Bedrooms / bathrooms within one room of this type. */
  bedrooms: number;
  bathrooms: number;
  /** How many physical rooms of this type the host has. */
  quantity: number;
  /** Per-room amenities ("AC", "Balcony"…). Different room classes carry
   *  different sets — consumer filter unions across all rooms. */
  amenities: string[];
  photos: string[];
  sortOrder: number;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  description: "",
  pricePerNight: "",
  maxGuests: 2,
  bedrooms: 1,
  bathrooms: 1,
  quantity: 1,
  amenities: [],
  photos: [],
  sortOrder: 0,
};

const RoomTypesManager = ({ listingId, listingName, onClose }: Props) => {
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const roomsQuery = useQuery({
    queryKey: ["room-types", listingId],
    queryFn: async () => {
      const result = await getListingService().listRoomTypes(listingId);
      if (!result.success || !result.data) throw new Error(result.error || t("roomTypes.errLoad", { defaultValue: "Failed to load rooms" }));
      return result.data;
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["room-types", listingId] });

  const saveMutation = useMutation({
    mutationFn: async (d: Draft) => {
      const payload = {
        name: d.name.trim(),
        description: d.description.trim(),
        basePricePaise: Math.round(Number(d.pricePerNight) * 100),
        maxGuests: d.maxGuests,
        bedrooms: d.bedrooms,
        bathrooms: d.bathrooms,
        quantity: d.quantity,
        amenities: d.amenities,
        photos: d.photos,
        sortOrder: d.sortOrder,
      };
      const result = d.id
        ? await getListingService().updateRoomType(listingId, d.id, payload)
        : await getListingService().createRoomType(listingId, payload);
      if (!result.success) throw new Error(result.error || t("roomTypes.errSave", { defaultValue: "Failed to save room" }));
      return result.data;
    },
    onSuccess: () => { toast.success(t("roomTypes.toastSaved", { defaultValue: "Room saved" })); setDraft(null); refresh(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (roomId: string) => {
      const result = await getListingService().deleteRoomType(listingId, roomId);
      if (!result.success) throw new Error(result.error || t("roomTypes.errDelete", { defaultValue: "Failed to delete room" }));
    },
    onSuccess: () => { toast.success(t("roomTypes.toastRemoved", { defaultValue: "Room removed" })); refresh(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const uploadPhoto = async (file: File): Promise<string> => {
    const key = buildUploadKey(`properties/${user?.id}/rooms`, file.name);
    const token = await getAccessToken();
    const response = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/storage/upload`, {
      method: "POST",
      headers: {
        "Content-Type": file.type,
        "x-upload-bucket": "listing-images",
        "x-upload-key": key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(typeof err.error === "string" ? err.error : err.error?.message || t("roomTypes.errUpload", { defaultValue: "Upload failed" }));
    }
    const result = await response.json();
    return result.publicUrl;
  };

  const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!draft || files.length === 0) return;
    setUploadingPhoto(true);
    // Per-file settle so one rejected photo (e.g. the server's NSFW moderation
    // gate, IMAGE_CONTENT_REJECTED) doesn't discard the rest of the batch.
    const results = await Promise.allSettled(files.map(uploadPhoto));
    const urls = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
    if (urls.length > 0) setDraft({ ...draft, photos: [...draft.photos, ...urls] });
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        toast.error(`${files[i].name}: ${(r.reason as Error)?.message || t("roomTypes.errPhotoUpload", { defaultValue: "Photo upload failed" })}`);
      }
    });
    setUploadingPhoto(false);
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const rooms = roomsQuery.data || [];
  const isSubmitting = saveMutation.isPending;

  // Mirror the onboarding form's "tried-to-submit → highlight what's missing"
  // pattern. The backend readiness validator already rejects a save with
  // missing photos/name/price on an *active* multi-room listing, but the
  // host would otherwise see a generic toast instead of being told which
  // field to fix. Each Field below reads `missingFields` and `triedSave` to
  // decide whether to render its red outline / message.
  const [triedSave, setTriedSave] = useState(false);
  const ROOM_AMENITY_MIN = 3;
  const computeMissing = (d: Draft): Set<string> => {
    const m = new Set<string>();
    if (!d.name.trim()) m.add("name");
    if (!d.pricePerNight || Number(d.pricePerNight) <= 0) m.add("price");
    if (!d.maxGuests || d.maxGuests < 1) m.add("maxGuests");
    if (!d.quantity || d.quantity < 1) m.add("quantity");
    if (!d.photos || d.photos.length === 0) m.add("photos");
    if (!d.amenities || d.amenities.length < ROOM_AMENITY_MIN) m.add("amenities");
    return m;
  };
  const missingFields = draft ? computeMissing(draft) : new Set<string>();
  const isMissing = (k: string) => triedSave && missingFields.has(k);
  const errCls = (k: string) =>
    isMissing(k) ? "border-destructive ring-1 ring-destructive/40 focus:ring-destructive/40" : "";
  // Friendly labels for the toast — keep parity with the inline hints so
  // the same wording shows up in both places.
  const MISSING_LABELS: Record<string, string> = {
    name: t("roomTypes.labelRoomName", { defaultValue: "Room name" }),
    price: t("roomTypes.labelPricePerNight", { defaultValue: "Price per night" }),
    maxGuests: t("roomTypes.labelMaxGuests", { defaultValue: "Max guests" }),
    quantity: t("roomTypes.labelRoomsOfType", { defaultValue: "Rooms of this type" }),
    photos: t("roomTypes.labelAtLeastOnePhoto", { defaultValue: "At least one photo" }),
    amenities: t("roomTypes.labelAtLeastAmenities", { defaultValue: "At least {{count}} amenities", count: ROOM_AMENITY_MIN }),
  };

  const attemptSave = () => {
    if (!draft) return;
    const m = computeMissing(draft);
    if (m.size > 0) {
      setTriedSave(true);
      const labels = Array.from(m).map((k) => MISSING_LABELS[k] ?? k).join(", ");
      toast.error(t("roomTypes.toastMissing", { defaultValue: "Missing: {{labels}}", labels }));
      return;
    }
    saveMutation.mutate(draft);
  };

  // Whenever the host opens a different draft (Add new / Edit existing,
  // or closes back to the list), reset the tried-save flag so a
  // previously-flagged form doesn't paint red on entry. We key off a
  // SINGLE derived string — using two deps (`draft?.id` + `draft === null`)
  // produced spurious re-runs because boolean dep recomputations + the
  // `triedSave → setTriedSave(false)` write looked like a render loop to
  // React's strict-mode tracker.
  const draftKey = draft === null ? "__none" : (draft.id ?? "__new");
  useEffect(() => {
    setTriedSave(false);
  }, [draftKey]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display font-bold text-lg flex items-center gap-2">
              <Bed className="w-5 h-5 text-primary" />
              {t("roomTypes.title", { defaultValue: "Room types" })}
            </h3>
            <p className="text-sm text-muted-foreground">{listingName || t("roomTypes.subtitle", { defaultValue: "Manage bookable rooms for this listing" })}</p>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {!draft && (
          <>
            {roomsQuery.isLoading ? (
              <div className="py-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : rooms.length === 0 ? (
              <div className="text-center py-8 border-2 border-dashed border-border rounded-2xl">
                <Bed className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground mb-1">{t("roomTypes.emptyTitle", { defaultValue: "No rooms yet" })}</p>
                <p className="text-xs text-muted-foreground">{t("roomTypes.emptyDesc", { defaultValue: "Add at least one room type so guests can book." })}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {rooms.map((r: any) => (
                  <div key={r.id} className="flex items-center gap-3 p-3 bg-muted/40 rounded-xl">
                    {r.photos?.[0] ? (
                      <img src={r.photos[0]} alt={r.name} className="w-14 h-14 rounded-lg object-cover" />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-primary/10 flex items-center justify-center"><Bed className="w-5 h-5 text-primary" /></div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">{r.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("roomTypes.roomMeta", {
                          defaultValue: "₹{{price}} / night · sleeps {{guests}} · {{count}} room",
                          defaultValue_plural: "₹{{price}} / night · sleeps {{guests}} · {{count}} rooms",
                          count: r.quantity ?? 1,
                          price: (Number(r.base_price_paise) / 100).toLocaleString("en-IN"),
                          guests: r.max_guests,
                        })}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" className="rounded-full"
                      onClick={() => setDraft({
                        id: r.id,
                        name: r.name,
                        description: r.description || "",
                        pricePerNight: String(Number(r.base_price_paise) / 100),
                        maxGuests: r.max_guests,
                        bedrooms: r.bedrooms ?? 1,
                        bathrooms: r.bathrooms ?? 1,
                        quantity: r.quantity ?? 1,
                        amenities: Array.isArray(r.amenities) ? r.amenities : [],
                        photos: r.photos || [],
                        sortOrder: r.sort_order || 0,
                      })}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button size="sm" variant="ghost" className="rounded-full text-destructive hover:text-destructive"
                      onClick={() => { if (confirm(t("roomTypes.confirmRemove", { defaultValue: 'Remove "{{name}}"?', name: r.name }))) deleteMutation.mutate(r.id); }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button className="w-full rounded-xl" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus className="w-4 h-4 mr-1" /> {t("roomTypes.addRoomType", { defaultValue: "Add room type" })}
            </Button>
          </>
        )}

        {draft && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium block mb-1.5">{t("roomTypes.fieldRoomName", { defaultValue: "Room name *" })}</label>
              <input
                type="text" value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("roomTypes.placeholderRoomName", { defaultValue: "e.g. Deluxe King Room" })}
                className={`w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 ${errCls("name")}`}
              />
              {isMissing("name") && <p className="mt-1 text-[11px] font-semibold text-destructive">{t("roomTypes.errRoomNameRequired", { defaultValue: "Room name is required." })}</p>}
            </div>
            <div>
              <label className="text-sm font-medium block mb-1.5">{t("roomTypes.fieldDescription", { defaultValue: "Description" })}</label>
              <textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder={t("roomTypes.placeholderDescription", { defaultValue: "What makes this room special?" })}
                rows={3}
                className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background resize-none outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium block mb-1.5">{t("roomTypes.fieldPricePerNight", { defaultValue: "Price / night (₹) *" })}</label>
                <input
                  type="number" value={draft.pricePerNight}
                  onChange={(e) => setDraft({ ...draft, pricePerNight: e.target.value })}
                  className={`w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 ${errCls("price")}`}
                />
                {isMissing("price") && <p className="mt-1 text-[11px] font-semibold text-destructive">{t("roomTypes.errPricePositive", { defaultValue: "Enter a price > 0." })}</p>}
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5">{t("roomTypes.fieldMaxGuests", { defaultValue: "Max guests" })}</label>
                <input
                  type="number" value={draft.maxGuests} min={1}
                  onChange={(e) => setDraft({ ...draft, maxGuests: Number(e.target.value) || 1 })}
                  className={`w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 ${errCls("maxGuests")}`}
                />
                {isMissing("maxGuests") && <p className="mt-1 text-[11px] font-semibold text-destructive">{t("roomTypes.errAtLeastOne", { defaultValue: "At least 1." })}</p>}
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5" title={t("roomTypes.titleBedrooms", { defaultValue: "Bedrooms in one room of this type" })}>{t("roomTypes.fieldBedrooms", { defaultValue: "Bedrooms" })}</label>
                <input
                  type="number" value={draft.bedrooms} min={1}
                  onChange={(e) => setDraft({ ...draft, bedrooms: Number(e.target.value) || 1 })}
                  className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5" title={t("roomTypes.titleBathrooms", { defaultValue: "Bathrooms in one room of this type" })}>{t("roomTypes.fieldBathrooms", { defaultValue: "Bathrooms" })}</label>
                <input
                  type="number" value={draft.bathrooms} min={1}
                  onChange={(e) => setDraft({ ...draft, bathrooms: Number(e.target.value) || 1 })}
                  className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5" title={t("roomTypes.titleQuantity", { defaultValue: "How many physical rooms of this type" })}>{t("roomTypes.fieldRoomsOfType", { defaultValue: "Rooms of this type" })}</label>
                <input
                  type="number" value={draft.quantity} min={1}
                  onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) || 1 })}
                  className={`w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 ${errCls("quantity")}`}
                />
                {isMissing("quantity") && <p className="mt-1 text-[11px] font-semibold text-destructive">{t("roomTypes.errAtLeastOne", { defaultValue: "At least 1." })}</p>}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1.5">{t("roomTypes.fieldAmenities", { defaultValue: "Amenities (this room) *" })}</label>
              <p className="text-[11px] text-muted-foreground mb-2">
                {t("roomTypes.amenitiesHint", { defaultValue: "What this room type offers. Pick at least {{count}} so search filters surface the room properly.", count: ROOM_AMENITY_MIN })}
              </p>
              <div className={isMissing("amenities") ? "rounded-xl ring-1 ring-destructive/50 p-1" : ""}>
                <RoomAmenityChips
                  value={draft.amenities}
                  onChange={(amenities) => setDraft({ ...draft, amenities })}
                />
              </div>
              {isMissing("amenities") && (
                <p className="mt-1 text-[11px] font-semibold text-destructive">
                  {t("roomTypes.errAmenitiesMin", { defaultValue: "Pick at least {{min}} amenities ({{current}}/{{min}}).", min: ROOM_AMENITY_MIN, current: draft.amenities.length })}
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium block mb-1.5">{t("roomTypes.fieldPhotos", { defaultValue: "Photos *" })}</label>
              <div className={`grid grid-cols-3 sm:grid-cols-5 gap-2 ${isMissing("photos") ? "rounded-xl ring-1 ring-destructive/50 p-1" : ""}`}>
                {draft.photos.map((url, idx) => (
                  <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-border group">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    <button type="button"
                      onClick={() => setDraft({ ...draft, photos: draft.photos.filter((_, i) => i !== idx) })}
                      className="absolute top-1 right-1 p-1 bg-black/60 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <button type="button"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={uploadingPhoto}
                  className="aspect-square rounded-xl border-2 border-dashed border-border hover:border-primary/50 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                >
                  {uploadingPhoto ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
                  <span className="text-[10px]">{uploadingPhoto ? t("roomTypes.uploading", { defaultValue: "Uploading…" }) : t("roomTypes.add", { defaultValue: "Add" })}</span>
                </button>
              </div>
              <input ref={photoInputRef} type="file" accept="image/*" multiple onChange={handlePhoto} className="hidden" />
              {isMissing("photos") && (
                <p className="mt-1 text-[11px] font-semibold text-destructive">{t("roomTypes.errPhotoRequired", { defaultValue: "Add at least one photo of this room." })}</p>
              )}
            </div>
            <div className="flex gap-3 pt-2">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setDraft(null)} disabled={isSubmitting}>{t("roomTypes.cancel", { defaultValue: "Cancel" })}</Button>
              <Button className="flex-1 rounded-xl"
                onClick={attemptSave}
                disabled={isSubmitting}
              >
                {isSubmitting ? <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {t("roomTypes.saving", { defaultValue: "Saving…" })}</span> : (draft.id ? t("roomTypes.saveChanges", { defaultValue: "Save changes" }) : t("roomTypes.addRoom", { defaultValue: "Add room" }))}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/** Compact amenity chip picker for the room editor. Mirrors the manual
 *  onboarding's STAY_AMENITIES preset list (kept inline here as a small set
 *  to avoid importing OnboardingForm internals) and supports a free-text
 *  "Add" so hosts can capture niche per-room things ("rooftop view", "AC
 *  + heater"). Case-insensitive de-dup keeps the union the consumer filter
 *  computes honest. */
const ROOM_AMENITY_PRESETS = [
  "AC", "WiFi", "TV", "Hot Water", "Heater", "Kitchenette", "Refrigerator",
  "Balcony", "Bathtub", "Hair Dryer", "Iron", "Wardrobe", "Workspace",
  "Coffee Maker", "Minibar", "Safe", "Pool Access", "Gym Access",
];

function RoomAmenityChips({
  value, onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState("");
  const toggle = (a: string) => {
    const lower = a.toLowerCase();
    const has = value.some((v) => v.toLowerCase() === lower);
    onChange(has ? value.filter((v) => v.toLowerCase() !== lower) : [...value, a]);
  };
  const addCustom = () => {
    const t = draft.trim();
    if (!t) return;
    if (value.some((v) => v.toLowerCase() === t.toLowerCase())) { setDraft(""); return; }
    onChange([...value, t]);
    setDraft("");
  };
  const presetLower = new Set(ROOM_AMENITY_PRESETS.map((a) => a.toLowerCase()));
  const custom = value.filter((v) => !presetLower.has(v.toLowerCase()));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {ROOM_AMENITY_PRESETS.map((a) => {
          const on = value.some((v) => v.toLowerCase() === a.toLowerCase());
          return (
            <button
              key={a}
              type="button"
              onClick={() => toggle(a)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                on ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-primary/10"
              }`}
            >
              {a}
            </button>
          );
        })}
      </div>
      {custom.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {custom.map((a) => (
            <span
              key={a}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-accent/15 text-accent border border-accent/30 flex items-center gap-1"
            >
              {a}
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== a))}
                className="hover:text-destructive"
                aria-label={t("roomTypes.removeAmenity", { defaultValue: "Remove {{name}}", name: a })}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
          placeholder={t("roomTypes.placeholderAddAmenity", { defaultValue: "Add another (e.g. sea view, minibar)" })}
          className="flex-1 px-2 py-1.5 border border-border rounded-lg text-xs bg-background outline-none focus:ring-2 focus:ring-primary/20"
        />
        <Button type="button" variant="outline" size="sm" className="rounded-lg h-8 px-2 text-xs" onClick={addCustom} disabled={!draft.trim()}>
          <Plus className="w-3 h-3 mr-0.5" /> {t("roomTypes.add", { defaultValue: "Add" })}
        </Button>
      </div>
    </div>
  );
}

export default RoomTypesManager;
