import { useRef } from "react";
import { MapPin, Upload, Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionType } from "@/hooks/useConversationEngine";
import { useLanguage } from "@/contexts/LanguageContext";

interface ActionOverlayProps {
  action: ActionType;
  onLocationShare: () => void;
  onLocationTyped: () => void;
  onCategorySelect: (category: string, label: string) => void;
  onAvailabilitySelect: (value: string) => void;
  onPhotoFiles?: (files: File[]) => void;
  isLocating?: boolean;
  isUploadingPhotos?: boolean;
}

// Each entry keeps a logic `value`, an emoji, and a translation key for
// the display text. The emoji is rendered alongside the translated label.
const categories = [
  { value: "hotel", emoji: "🏨", tKey: "onboarding.catHotelLodge", en: "Hotel / Lodge" },
  { value: "homestay", emoji: "🏡", tKey: "onboarding.catHomestayRoom", en: "Homestay / Room" },
  { value: "cleaning", emoji: "🧹", tKey: "onboarding.catCleaning", en: "Cleaning" },
  { value: "electrician", emoji: "⚡", tKey: "onboarding.catElectrician", en: "Electrician" },
  { value: "plumber", emoji: "🔧", tKey: "onboarding.catPlumber", en: "Plumber" },
  { value: "driver-auto", emoji: "🛺", tKey: "onboarding.catAutoDriver", en: "Auto Driver" },
  { value: "driver-cab", emoji: "🚗", tKey: "onboarding.catCabDriver", en: "Cab Driver" },
  { value: "cook", emoji: "👨‍🍳", tKey: "onboarding.catCookChef", en: "Cook / Chef" },
  { value: "carpenter", emoji: "🪚", tKey: "onboarding.catCarpenter", en: "Carpenter" },
  { value: "mechanic", emoji: "🔩", tKey: "onboarding.catMechanic", en: "Mechanic" },
  { value: "tour-guide", emoji: "🗺️", tKey: "onboarding.catTourGuide", en: "Tour Guide" },
  { value: "photographer", emoji: "📸", tKey: "onboarding.catPhotographer", en: "Photographer" },
  { value: "helper", emoji: "🤝", tKey: "onboarding.catLocalHelper", en: "Local Helper" },
  { value: "freelancer", emoji: "💻", tKey: "onboarding.catFreelancer", en: "Freelancer" },
];

const availOptions = [
  { value: "Available Now", emoji: "🟢", tKey: "onboarding.availNow", en: "Available Now" },
  { value: "Weekdays Only", emoji: "📅", tKey: "onboarding.availWeekdays", en: "Weekdays Only" },
  { value: "Weekends Only", emoji: "🏖️", tKey: "onboarding.availWeekends", en: "Weekends Only" },
  { value: "24/7 Available", emoji: "⏰", tKey: "onboarding.avail247", en: "24/7 Available" },
  { value: "Book in Advance", emoji: "📞", tKey: "onboarding.availBookAdvance", en: "Book in Advance" },
  { value: "Flexible Hours", emoji: "🔄", tKey: "onboarding.availFlexible", en: "Flexible Hours" },
];

const ActionOverlay = ({
  action,
  onLocationShare,
  onLocationTyped,
  onCategorySelect,
  onAvailabilitySelect,
  onPhotoFiles,
  isLocating,
  isUploadingPhotos,
}: ActionOverlayProps) => {
  const { t } = useLanguage();
  // Hidden inputs back the "Upload Photos" / "Take Photo" chips. The camera
  // input uses `capture="environment"` so mobile browsers open the rear camera
  // directly instead of the chooser, which is what was broken before — the
  // chips were dead JSX with no onClick.
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    // Reset so the same file can be selected again after a failure.
    e.target.value = "";
    if (files.length === 0 || !onPhotoFiles) return;
    onPhotoFiles(files);
  };

  if (action === "none") return null;

  return (
    <div className="px-4 py-3 border-t border-border bg-muted/30 animate-in slide-in-from-bottom-2 duration-300">
      <div className="max-w-2xl mx-auto">
        {action === "category_select" && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("onboarding.quickSelect", { defaultValue: "Quick select" })}</p>
            <div className="flex flex-wrap gap-1.5">
              {categories.map(c => {
                const label = `${c.emoji} ${t(c.tKey, { defaultValue: c.en })}`;
                return (
                <button
                  key={c.value}
                  onClick={() => onCategorySelect(c.value, label)}
                  className="px-3 py-1.5 text-xs font-medium bg-card border border-border rounded-xl hover:border-primary hover:bg-primary/10 hover:text-primary transition-all"
                >
                  {label}
                </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">{t("onboarding.categoryFreeTextHint", { defaultValue: "Or just tell me what you do — I'll figure it out!" })}</p>
          </div>
        )}

        {action === "location_picker" && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl flex-1"
              onClick={onLocationShare}
              disabled={isLocating}
            >
              <MapPin className="w-4 h-4 mr-1.5" />
              {isLocating ? t("onboarding.detecting", { defaultValue: "Detecting..." }) : t("onboarding.shareGpsLocation", { defaultValue: "Share GPS Location" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl flex-1"
              onClick={onLocationTyped}
            >
              {t("onboarding.typeLocation", { defaultValue: "✏️ Type Location" })}
            </Button>
          </div>
        )}

        {action === "photo_upload" && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl flex-1"
              onClick={() => galleryInputRef.current?.click()}
              disabled={isUploadingPhotos}
            >
              {isUploadingPhotos ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-1.5" />
              )}
              {isUploadingPhotos ? t("onboarding.uploadingEllipsis", { defaultValue: "Uploading…" }) : t("onboarding.uploadPhotos", { defaultValue: "Upload Photos" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl flex-1"
              onClick={() => cameraInputRef.current?.click()}
              disabled={isUploadingPhotos}
            >
              <Camera className="w-4 h-4 mr-1.5" /> {t("onboarding.takePhoto", { defaultValue: "Take Photo" })}
            </Button>
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFiles}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFiles}
            />
          </div>
        )}

        {action === "availability_select" && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("onboarding.quickSelect", { defaultValue: "Quick select" })}</p>
            <div className="flex flex-wrap gap-1.5">
              {availOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => onAvailabilitySelect(opt.value)}
                  className="px-3 py-1.5 text-xs font-medium bg-card border border-border rounded-xl hover:border-primary hover:bg-primary/10 hover:text-primary transition-all"
                >
                  {`${opt.emoji} ${t(opt.tKey, { defaultValue: opt.en })}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {action === "price_input" && (
          <p className="text-xs text-muted-foreground">{t("onboarding.priceInputHint", { defaultValue: "💡 Type or say your price — for example \"500 rupees\" or just \"500\"" })}</p>
        )}
      </div>
    </div>
  );
};

export default ActionOverlay;
