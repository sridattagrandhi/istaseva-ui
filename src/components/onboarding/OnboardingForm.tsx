import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Bed, Bot, Building2, ChefHat, ImagePlus, Loader2, MapPin, Plus,
  Trash2, X, Wifi, Wind, ParkingCircle, Coffee, Tv, Bath, Wrench, Award,
  Hammer, Waves, Dumbbell, Utensils, Shirt, BellRing, Dog, Trees, Home,
  Flame, Accessibility, Sparkles, Wine, ArrowUpDown, Car, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import BackButton from "@/components/BackButton";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useLocation as useGeoLocation } from "@/contexts/LocationContext";
import { getAccessToken, apiRequest } from "@/lib/api-client";
import { buildUploadKey } from "@/lib/storage-key";
import { toast } from "sonner";
import type { OnboardingProfile } from "@/hooks/useConversationEngine";
import AddressAutocompleteInput from "@/components/AddressAutocompleteInput";
import { ChipListInput } from "@/components/ChipListInput";
import { ThemedTimePicker } from "@/components/ui/themed-time-picker";
import {
  loadOnboardingDraft,
  saveOnboardingDraft,
  describeAge,
  migrateLegacyOnboardingDraft,
  type OnboardingDraftType,
} from "@/lib/onboarding-draft";
import {
  getOnboardingMissingFields,
  isOnboardingComplete,
  missingOnboardingLabel,
  parseDurationHours,
} from "@/lib/onboarding-validation";
import {
  PRICING_UNIT_LABEL,
  type PricingUnit,
} from "@/lib/transport-types";
import { totalDwellMinutes, widestWorkingWindowMinutes } from "@/lib/tour-package";

/**
 * Onboarding form — role-aware sectioned layout.
 *
 * Each entry path (host / service / transport) reuses the same shared
 * `OnboardingProfile` shape but renders only the sections that make sense
 * for that role. The previous version was one long form that conditionally
 * grew/shrank — readable to engineers, miserable for a host filling it.
 *
 * Sections always appear in the same vertical order so the visual rhythm
 * is consistent across roles:
 *   1. Basics      — what kind of listing, what it's called
 *   2. Location    — where they are / where they go
 *   3. Specifics   — role-flavored details (rooms vs experience vs vehicle)
 *   4. Pricing     — money + when they're available
 *   5. Story       — description, languages, photos
 *   6. Hotel rooms — only when category=hotel
 *
 * The `Section` component encodes that pattern; new sections should follow
 * its visual style (number badge, title, hint, card body) so the form
 * doesn't drift back into a flat dump of fields.
 */

interface PendingRoom {
  key: string;
  name: string;
  description: string;
  pricePerNight: string;
  maxGuests: number;
  /** How many physical rooms of this type the host has. */
  quantity: number;
  /** Bedrooms inside ONE room of this type. Differs from property-level
   *  bedrooms which only makes sense for whole-property stays. */
  bedrooms: number;
  /** Bathrooms inside ONE room of this type. */
  bathrooms: number;
  /** Optional per-room labels — ["101","102",…] or ["8a","8b","8c"]. Empty
   *  if the host doesn't number rooms; quantity alone is enough then. */
  unitIdentifiers: string[];
  /** Per-room amenities. Each room class can carry its own set ("Deluxe King"
   *  has AC + minibar, "Standard Twin" only AC). The consumer-side stay
   *  filter unions these with the listing-level amenities. */
  amenities: string[];
  photos: string[];
}

/** Property types that have multiple physically-distinct rooms a guest
 *  can book (hotel, lodge, heritage, sathram). For these:
 *   - bedrooms / bathrooms / max guests are per-room-type fields, not
 *     property-level
 *   - the property has no single "price per night" — each room type has
 *     its own price
 *   - Section 6 (Room types) is required
 *
 *  Sathrams (pilgrim rest-houses) are added here because they typically
 *  expose multiple cell / dormitory tiers at different rates, just like
 *  a small lodge.
 *
 *  Keep this set aligned with the agent prompts in
 *  server/src/modules/chat/services/onboarding-agent.service.ts and
 *  voice-live.service.ts so both paths agree on the property model. */
const MULTI_ROOM_PROPERTY_TYPES = new Set(["hotel", "lodge", "heritage", "sathram"]);
const isMultiRoomProperty = (propertyType: string) => MULTI_ROOM_PROPERTY_TYPES.has(propertyType);

type CategoryGroup = "stay" | "transport" | "service";

type Props = {
  profile: OnboardingProfile;
  setProfile: React.Dispatch<React.SetStateAction<OnboardingProfile>>;
  onSubmit: (extra?: { pendingRooms?: PendingRoom[] }) => void;
  onSwitchToAI: () => void;
  isSubmitting?: boolean;
  showMissingOnMount?: boolean;
  /** Restrict which category groups appear. host portal → ['stay'],
   *  provider portal → ['service','transport'], unscoped → all three. */
  allowedGroups?: CategoryGroup[];
  /** Admin ops console (assisted onboarding): the host/provider/driver the
   *  listing is being created FOR. Scopes photo uploads to THEIR storage
   *  path (with the admin cross-user header) and keeps drafts in a separate
   *  admin bucket so they never collide with the admin's own onboarding. */
  targetUserId?: string;
  /** Hide the "switch to AI" buttons — the conversational flow is a
   *  first-person experience that makes no sense when filling the form for
   *  someone else. */
  hideAISwitch?: boolean;
};

// Shared with the AI agent — values must match the agent's `category` enum
// exactly, otherwise listings created by form vs. agent diverge in search
// indexing and analytics.
const CATEGORIES: Array<{ value: string; label: string; tKey: string; group: CategoryGroup; emoji: string }> = [
  { value: "hotel",         label: "Hotel",         tKey: "onboarding.categoryHotel",         group: "stay",      emoji: "🏨" },
  { value: "homestay",      label: "Homestay",      tKey: "onboarding.categoryHomestay",      group: "stay",      emoji: "🏡" },
  { value: "driver-cab",        label: "Cab",          tKey: "onboarding.categoryCab",          group: "transport", emoji: "🚗" },
  { value: "driver-auto",       label: "Auto",         tKey: "onboarding.categoryAuto",         group: "transport", emoji: "🛺" },
  { value: "driver-bus",        label: "Bus",          tKey: "onboarding.categoryBus",          group: "transport", emoji: "🚌" },
  { value: "driver-tempo",      label: "Tempo",        tKey: "onboarding.categoryTempo",        group: "transport", emoji: "🚐" },
  { value: "driver-scooter",    label: "Scooter",      tKey: "onboarding.categoryScooter",      group: "transport", emoji: "🛵" },
  { value: "driver-motorcycle", label: "Motorcycle",   tKey: "onboarding.categoryMotorcycle",   group: "transport", emoji: "🏍️" },
  { value: "cleaning",        label: "Cleaning",            tKey: "onboarding.categoryCleaning",         group: "service",   emoji: "🧹" },
  { value: "deep-cleaning",   label: "Deep cleaning",       tKey: "onboarding.categoryDeepCleaning",     group: "service",   emoji: "🧽" },
  { value: "laundry",         label: "Laundry & ironing",   tKey: "onboarding.categoryLaundry",          group: "service",   emoji: "🧺" },
  { value: "dishwashing",     label: "Dishwashing",         tKey: "onboarding.categoryDishwashing",      group: "service",   emoji: "🍽️" },
  { value: "plumber",         label: "Plumber",             tKey: "onboarding.categoryPlumber",          group: "service",   emoji: "🔧" },
  { value: "electrician",     label: "Electrician",         tKey: "onboarding.categoryElectrician",      group: "service",   emoji: "💡" },
  { value: "appliance-repair",label: "Appliance repair",    tKey: "onboarding.categoryApplianceRepair",  group: "service",   emoji: "🔌" },
  { value: "ac-repair",       label: "AC repair & service", tKey: "onboarding.categoryAcRepair",         group: "service",   emoji: "❄️" },
  { value: "fridge-repair",   label: "Fridge repair",       tKey: "onboarding.categoryFridgeRepair",     group: "service",   emoji: "🧊" },
  { value: "geyser-repair",   label: "Geyser repair",       tKey: "onboarding.categoryGeyserRepair",     group: "service",   emoji: "🚿" },
  { value: "ro-repair",       label: "RO / water purifier", tKey: "onboarding.categoryRoRepair",         group: "service",   emoji: "💧" },
  { value: "cook",            label: "Cook / chef",         tKey: "onboarding.categoryCook",             group: "service",   emoji: "👨‍🍳" },
  { value: "tiffin",          label: "Tiffin / meal prep",  tKey: "onboarding.categoryTiffin",           group: "service",   emoji: "🍱" },
  { value: "carpenter",       label: "Carpenter",           tKey: "onboarding.categoryCarpenter",        group: "service",   emoji: "🪚" },
  { value: "painter",         label: "Painter",             tKey: "onboarding.categoryPainter",          group: "service",   emoji: "🎨" },
  { value: "mason",           label: "Mason",               tKey: "onboarding.categoryMason",            group: "service",   emoji: "🧱" },
  { value: "welder",          label: "Welder",              tKey: "onboarding.categoryWelder",           group: "service",   emoji: "🔥" },
  { value: "mechanic",        label: "Mechanic",            tKey: "onboarding.categoryMechanic",         group: "service",   emoji: "⚙️" },
  { value: "bike-mechanic",   label: "Two-wheeler mechanic",tKey: "onboarding.categoryBikeMechanic",     group: "service",   emoji: "🛠️" },
  { value: "car-wash",        label: "Car / bike wash",     tKey: "onboarding.categoryCarWash",          group: "service",   emoji: "🧼" },
  { value: "pest-control",    label: "Pest control",        tKey: "onboarding.categoryPestControl",      group: "service",   emoji: "🐜" },
  { value: "gardener",        label: "Gardener",            tKey: "onboarding.categoryGardener",         group: "service",   emoji: "🌿" },
  { value: "tour-guide",      label: "Tour guide",          tKey: "onboarding.categoryTourGuide",        group: "service",   emoji: "🗺️" },
  { value: "translator",      label: "Translator",          tKey: "onboarding.categoryTranslator",       group: "service",   emoji: "🗣️" },
  { value: "photographer",    label: "Photographer",        tKey: "onboarding.categoryPhotographer",     group: "service",   emoji: "📷" },
  { value: "videographer",    label: "Videographer",        tKey: "onboarding.categoryVideographer",     group: "service",   emoji: "🎥" },
  { value: "makeup-artist",   label: "Makeup artist",       tKey: "onboarding.categoryMakeupArtist",     group: "service",   emoji: "💄" },
  { value: "salon-at-home",   label: "Salon at home",       tKey: "onboarding.categorySalonAtHome",      group: "service",   emoji: "💇" },
  { value: "mehendi",         label: "Mehendi artist",      tKey: "onboarding.categoryMehendi",          group: "service",   emoji: "🤲" },
  { value: "barber",          label: "Barber",              tKey: "onboarding.categoryBarber",           group: "service",   emoji: "💈" },
  { value: "massage",         label: "Massage / spa",       tKey: "onboarding.categoryMassage",          group: "service",   emoji: "💆" },
  { value: "yoga",            label: "Yoga instructor",     tKey: "onboarding.categoryYoga",             group: "service",   emoji: "🧘" },
  { value: "fitness-trainer", label: "Fitness trainer",     tKey: "onboarding.categoryFitnessTrainer",   group: "service",   emoji: "🏋️" },
  { value: "physiotherapy",   label: "Physiotherapy",       tKey: "onboarding.categoryPhysiotherapy",    group: "service",   emoji: "🦵" },
  { value: "nurse",           label: "Home nurse",          tKey: "onboarding.categoryNurse",            group: "service",   emoji: "🩺" },
  { value: "elder-care",      label: "Elder care",          tKey: "onboarding.categoryElderCare",        group: "service",   emoji: "👵" },
  { value: "babysitter",      label: "Babysitter / nanny",  tKey: "onboarding.categoryBabysitter",       group: "service",   emoji: "👶" },
  { value: "tutor",           label: "Tutor",               tKey: "onboarding.categoryTutor",            group: "service",   emoji: "📚" },
  { value: "music-teacher",   label: "Music teacher",       tKey: "onboarding.categoryMusicTeacher",     group: "service",   emoji: "🎵" },
  { value: "dance-teacher",   label: "Dance teacher",       tKey: "onboarding.categoryDanceTeacher",     group: "service",   emoji: "💃" },
  { value: "language-coach",  label: "Language coach",      tKey: "onboarding.categoryLanguageCoach",    group: "service",   emoji: "🔤" },
  { value: "event-planner",   label: "Event planner",       tKey: "onboarding.categoryEventPlanner",     group: "service",   emoji: "🎉" },
  { value: "decorator",       label: "Decorator",           tKey: "onboarding.categoryDecorator",        group: "service",   emoji: "🎀" },
  { value: "caterer",         label: "Caterer",             tKey: "onboarding.categoryCaterer",          group: "service",   emoji: "🍛" },
  { value: "dj",              label: "DJ / sound",          tKey: "onboarding.categoryDj",               group: "service",   emoji: "🎧" },
  { value: "priest",          label: "Pandit / priest",     tKey: "onboarding.categoryPriest",           group: "service",   emoji: "🕉️" },
  { value: "astrologer",      label: "Astrologer",          tKey: "onboarding.categoryAstrologer",       group: "service",   emoji: "🔮" },
  { value: "tailor",          label: "Tailor",              tKey: "onboarding.categoryTailor",           group: "service",   emoji: "🧵" },
  { value: "cobbler",         label: "Cobbler",             tKey: "onboarding.categoryCobbler",          group: "service",   emoji: "👞" },
  { value: "courier",         label: "Courier / delivery",  tKey: "onboarding.categoryCourier",          group: "service",   emoji: "📦" },
  { value: "packers-movers",  label: "Packers & movers",    tKey: "onboarding.categoryPackersMovers",    group: "service",   emoji: "🚚" },
  { value: "security-guard",  label: "Security guard",      tKey: "onboarding.categorySecurityGuard",    group: "service",   emoji: "🛡️" },
  { value: "dog-walker",      label: "Dog walker",          tKey: "onboarding.categoryDogWalker",        group: "service",   emoji: "🐕" },
  { value: "pet-grooming",    label: "Pet grooming",        tKey: "onboarding.categoryPetGrooming",      group: "service",   emoji: "🐾" },
  { value: "vet",             label: "Veterinarian",        tKey: "onboarding.categoryVet",              group: "service",   emoji: "🐶" },
  { value: "helper",          label: "Local helper",        tKey: "onboarding.categoryHelper",           group: "service",   emoji: "🤝" },
  { value: "freelancer",      label: "Freelancer",          tKey: "onboarding.categoryFreelancer",       group: "service",   emoji: "💼" },
];

/**
 * Stay-type tiles shown in Section 1 of the host portal. Each tile sets
 * BOTH `category` (the agent-side enum bucket — only "hotel" or "homestay"
 * are valid backend values) AND `propertyType` (the user-visible
 * sub-classification). Lodge/Heritage map to category=hotel because
 * they're hotel-class establishments; village/farm map to category=
 * homestay because they're residential. Keep that mapping aligned with
 * the search/filter index in the listings module.
 *
 * The reason this lives here and not as a free `propertyType` field in
 * Part 3: hosts think in stay-types, not in (category × subtype) tuples.
 * Showing "Hotel/Homestay" in Part 1 then "Hotel/Homestay/Lodge/…" in
 * Part 3 was redundant and confusing — the two pickers were modelling
 * the same decision. One picker, six options, done.
 */
const STAY_TYPE_TILES: Array<{
  propertyType: string;
  category: "hotel" | "homestay";
  label: string;
  tKey: string;
  emoji: string;
}> = [
  { propertyType: "hotel",         category: "hotel",    label: "Hotel",        tKey: "onboarding.stayTypeHotel",       emoji: "🏨" },
  { propertyType: "homestay",      category: "homestay", label: "Homestay",     tKey: "onboarding.stayTypeHomestay",    emoji: "🏡" },
  { propertyType: "lodge",         category: "hotel",    label: "Lodge",        tKey: "onboarding.stayTypeLodge",       emoji: "🏚️" },
  { propertyType: "village-stay",  category: "homestay", label: "Village stay", tKey: "onboarding.stayTypeVillage",     emoji: "🏞️" },
  { propertyType: "farm-stay",     category: "homestay", label: "Farm stay",    tKey: "onboarding.stayTypeFarm",        emoji: "🚜" },
  { propertyType: "heritage",      category: "hotel",    label: "Heritage",     tKey: "onboarding.stayTypeHeritage",    emoji: "🏛️" },
  { propertyType: "sathram",       category: "homestay", label: "Sathram",      tKey: "onboarding.stayTypeSathram",     emoji: "🛕" },
];

/**
 * Built-in amenities. Hosts see these as toggle chips; anything they
 * type into the "Add custom" input gets appended to the same array
 * (rendered as removable chips below). The agent's extract_fields tool
 * accepts arbitrary strings here, so custom amenities round-trip fine
 * — they end up in profile.amenities just like the canned ones.
 */
const STAY_AMENITIES: Array<{ value: string; label: string; tKey: string; icon: React.ReactNode }> = [
  { value: "wifi",          label: "Wi-Fi",         tKey: "onboarding.amenityWifi",         icon: <Wifi className="w-3.5 h-3.5" /> },
  { value: "ac",            label: "AC",            tKey: "onboarding.amenityAc",           icon: <Wind className="w-3.5 h-3.5" /> },
  { value: "parking",       label: "Parking",       tKey: "onboarding.amenityParking",      icon: <ParkingCircle className="w-3.5 h-3.5" /> },
  { value: "breakfast",     label: "Breakfast",     tKey: "onboarding.amenityBreakfast",    icon: <Coffee className="w-3.5 h-3.5" /> },
  { value: "tv",            label: "TV",            tKey: "onboarding.amenityTv",           icon: <Tv className="w-3.5 h-3.5" /> },
  { value: "hot-water",     label: "Hot water",     tKey: "onboarding.amenityHotWater",     icon: <Bath className="w-3.5 h-3.5" /> },
  { value: "power-backup",  label: "Power backup",  tKey: "onboarding.amenityPowerBackup",  icon: <Wrench className="w-3.5 h-3.5" /> },
  { value: "kitchen",       label: "Kitchen",       tKey: "onboarding.amenityKitchen",      icon: <ChefHat className="w-3.5 h-3.5" /> },
  { value: "pool",          label: "Pool",          tKey: "onboarding.amenityPool",         icon: <Waves className="w-3.5 h-3.5" /> },
  { value: "gym",           label: "Gym",           tKey: "onboarding.amenityGym",          icon: <Dumbbell className="w-3.5 h-3.5" /> },
  { value: "restaurant",    label: "Restaurant",    tKey: "onboarding.amenityRestaurant",   icon: <Utensils className="w-3.5 h-3.5" /> },
  { value: "laundry",       label: "Laundry",       tKey: "onboarding.amenityLaundry",      icon: <Shirt className="w-3.5 h-3.5" /> },
  { value: "room-service",  label: "Room service",  tKey: "onboarding.amenityRoomService",  icon: <BellRing className="w-3.5 h-3.5" /> },
  { value: "pet-friendly",  label: "Pet friendly",  tKey: "onboarding.amenityPetFriendly",  icon: <Dog className="w-3.5 h-3.5" /> },
  { value: "garden",        label: "Garden",        tKey: "onboarding.amenityGarden",       icon: <Trees className="w-3.5 h-3.5" /> },
  { value: "balcony",       label: "Balcony",       tKey: "onboarding.amenityBalcony",      icon: <Home className="w-3.5 h-3.5" /> },
  { value: "bonfire",       label: "Bonfire",       tKey: "onboarding.amenityBonfire",      icon: <Flame className="w-3.5 h-3.5" /> },
  { value: "accessible",    label: "Wheelchair-friendly", tKey: "onboarding.amenityAccessible", icon: <Accessibility className="w-3.5 h-3.5" /> },
  { value: "housekeeping",  label: "Housekeeping",  tKey: "onboarding.amenityHousekeeping", icon: <Sparkles className="w-3.5 h-3.5" /> },
];

/**
 * Property-wide facilities for multi-room stays (hotel/lodge/heritage/
 * sathram) — shared spaces like the pool or restaurant, as opposed to
 * in-room amenities which live per room type. Stored in the same
 * `profile.amenities` array (multi-room stays don't use it for in-room
 * amenities), which lands in the listings.amenities column the consumer
 * stay filter already unions with per-room amenities.
 */
const HOTEL_FACILITIES: Array<{ value: string; label: string; tKey: string; icon: React.ReactNode }> = [
  { value: "pool",          label: "Pool",          tKey: "onboarding.facilityPool",        icon: <Waves className="w-3.5 h-3.5" /> },
  { value: "gym",           label: "Gym",           tKey: "onboarding.facilityGym",         icon: <Dumbbell className="w-3.5 h-3.5" /> },
  { value: "restaurant",    label: "Restaurant",    tKey: "onboarding.facilityRestaurant",  icon: <Utensils className="w-3.5 h-3.5" /> },
  { value: "parking",       label: "Parking",       tKey: "onboarding.facilityParking",     icon: <ParkingCircle className="w-3.5 h-3.5" /> },
  { value: "spa",           label: "Spa",           tKey: "onboarding.facilitySpa",         icon: <Sparkles className="w-3.5 h-3.5" /> },
  { value: "bar",           label: "Bar",           tKey: "onboarding.facilityBar",         icon: <Wine className="w-3.5 h-3.5" /> },
  { value: "garden",        label: "Garden",        tKey: "onboarding.facilityGarden",      icon: <Trees className="w-3.5 h-3.5" /> },
  { value: "laundry",       label: "Laundry",       tKey: "onboarding.facilityLaundry",     icon: <Shirt className="w-3.5 h-3.5" /> },
  { value: "power-backup",  label: "Power backup",  tKey: "onboarding.facilityPowerBackup", icon: <Wrench className="w-3.5 h-3.5" /> },
  { value: "lift",          label: "Lift",          tKey: "onboarding.facilityLift",        icon: <ArrowUpDown className="w-3.5 h-3.5" /> },
  { value: "room-service",  label: "Room service",  tKey: "onboarding.facilityRoomService", icon: <BellRing className="w-3.5 h-3.5" /> },
  { value: "banquet-hall",  label: "Banquet hall",  tKey: "onboarding.facilityBanquetHall", icon: <Building2 className="w-3.5 h-3.5" /> },
  { value: "rooftop",       label: "Rooftop",       tKey: "onboarding.facilityRooftop",     icon: <Home className="w-3.5 h-3.5" /> },
  { value: "travel-desk",   label: "Travel desk",   tKey: "onboarding.facilityTravelDesk",  icon: <Car className="w-3.5 h-3.5" /> },
  { value: "ev-charging",   label: "EV charging",   tKey: "onboarding.facilityEvCharging",  icon: <Zap className="w-3.5 h-3.5" /> },
  { value: "accessible",    label: "Wheelchair-friendly", tKey: "onboarding.facilityAccessible", icon: <Accessibility className="w-3.5 h-3.5" /> },
];

const LANGUAGE_OPTIONS = ["English", "Hindi", "Telugu", "Tamil", "Kannada", "Malayalam", "Marathi", "Bengali"];

const isPricingUnit = (value: string): value is PricingUnit =>
  value in PRICING_UNIT_LABEL;

/** Narrow an `unknown` thrown value to a useful display string. Covers
 *  the three shapes we see in practice — Error instances, plain strings,
 *  and the `{ message }` envelopes some fetch wrappers throw. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}

const isHostCat = (cat: string) => ["hotel", "homestay"].includes(cat);
const TRANSPORT_CATEGORY_VALUES = [
  "driver-auto", "driver-cab", "driver-bus", "driver-tempo",
  "driver-scooter", "driver-motorcycle",
];
const isTransportCat = (cat: string) => TRANSPORT_CATEGORY_VALUES.includes(cat);

const OnboardingForm = ({
  profile, setProfile, onSubmit, onSwitchToAI, isSubmitting, showMissingOnMount, allowedGroups,
  targetUserId, hideAISwitch,
}: Props) => {
  const visibleGroups = useMemo<CategoryGroup[]>(
    () => allowedGroups && allowedGroups.length > 0
      ? allowedGroups
      : ["stay", "transport", "service"],
    [allowedGroups],
  );
  const { t } = useLanguage();
  const { user } = useAuth();
  const { location: geoLoc, requestLocation, isLocating } = useGeoLocation();
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  // Rejected-photo modal. Populated with a human-readable reason per file so
  // the host understands *why* a photo was refused (explicit content vs wrong
  // file type vs too large) instead of a raw fetch/HTTP string.
  const [photoRejections, setPhotoRejections] = useState<{ file: string; reason: string }[] | null>(null);
  const [pendingRooms, setPendingRooms] = useState<PendingRoom[]>([]);
  const [uploadingRoomPhotoFor, setUploadingRoomPhotoFor] = useState<string | null>(null);

  // Draft scope is decided by the entry portal — a property draft must
  // never appear in transport onboarding and vice versa. When the form
  // is opened on the unscoped /onboarding URL we keep a generic "any"
  // bucket so it still resumes.
  const draftType: OnboardingDraftType =
    allowedGroups && allowedGroups.length === 1
      ? (allowedGroups[0] === "stay" ? "stay"
        : allowedGroups[0] === "transport" ? "transport" : "service")
      : "any";

  // ---- "Save and continue later" ----
  //
  // Drafts are saved ONLY when the user clicks the Save and continue
  // later button (handler below). On mount we hydrate the draft for
  // THIS draftType so an in-progress property doesn't bleed into a
  // transport flow. We retry once when auth resolves so a draft saved
  // post-login is picked up after the auth flip.
  // Assisted onboarding drafts live in their own per-target bucket so an
  // admin filling forms for two hosts (or their own listing) never collide.
  const draftOwner = targetUserId ? `admin:${user?.id ?? "anon"}:for:${targetUserId}` : user?.id;

  const hydratedForKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${draftOwner ?? "__anon__"}:${draftType}`;
    if (hydratedForKeyRef.current === key) return;
    migrateLegacyOnboardingDraft(draftOwner);
    // `name` is intentionally excluded: it's pre-seeded from the account, so
    // a seeded-name-only profile must still count as "empty" here or a saved
    // draft would never load. Category + location are the real "has started"
    // signals.
    const isEmpty = !profile.category && !profile.location;
    if (!isEmpty) {
      hydratedForKeyRef.current = key;
      return;
    }
    const { profile: savedProfile, savedAt, pendingRooms: savedPendingRooms } =
      loadOnboardingDraft<OnboardingProfile>(draftOwner, draftType);
    if (savedProfile) {
      setProfile(savedProfile);
      if (Array.isArray(savedPendingRooms)) setPendingRooms(savedPendingRooms as PendingRoom[]);
      if (savedAt) {
        toast.message(t("onboarding.draftResumed", { defaultValue: "Resumed your saved draft (saved {{age}}).", age: describeAge(savedAt) }));
      }
    }
    hydratedForKeyRef.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftOwner, draftType]);

  // Pre-fill the room-types editor from the AI agent's extracted
  // `roomTypes`. The conversational onboarding now captures the room
  // catalog (names, ₹/night, per-room amenities) so the host lands on a
  // populated editor instead of a blank one. Runs once; the functional
  // update keeps any draft-loaded rooms above (draft wins — those are the
  // host's own saved edits). Price is ₹/night on the profile; the editor
  // also stores it as a ₹ string. Photos / unit numbers aren't carried by
  // the agent — the host fills those here.
  const seededRoomsRef = useRef(false);
  useEffect(() => {
    if (seededRoomsRef.current) return;
    const incoming = profile.roomTypes;
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    seededRoomsRef.current = true;
    setPendingRooms((prev) => {
      if (prev.length > 0) return prev;
      return incoming.map((r, i) => ({
        key: `room-seed-${i}-${(r.name || "room").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16)}`,
        name: r.name ?? "",
        description: "",
        pricePerNight: r.pricePerNight != null ? String(r.pricePerNight) : "",
        maxGuests: r.maxGuests ?? 2,
        quantity: r.quantity ?? 1,
        bedrooms: r.bedrooms ?? 1,
        bathrooms: r.bathrooms ?? 1,
        unitIdentifiers: [],
        amenities: Array.isArray(r.amenities) ? r.amenities : [],
        photos: [],
      }));
    });
  }, [profile.roomTypes]);

  // Categories the user can pick from, scoped by entry portal.
  const visibleCategories = useMemo(
    () => CATEGORIES.filter((c) => visibleGroups.includes(c.group)),
    [visibleGroups],
  );

  // Page chrome — title + accent — adapts to the entry portal so a host
  // doesn't see "Add a service" copy. Falls back to a neutral tone when
  // the user is on the unscoped /onboarding URL.
  const portal: "host" | "provider" | "transport" | "any" =
    visibleGroups.length === 1 && visibleGroups[0] === "stay" ? "host"
      : visibleGroups.length === 1 && visibleGroups[0] === "transport" ? "transport"
        : visibleGroups.length === 1 && visibleGroups[0] === "service" ? "provider"
          : visibleGroups.includes("service") && !visibleGroups.includes("stay") ? "provider"
            : "any";

  const headerCopy = portal === "host"
    ? { icon: <Building2 className="w-5 h-5" />, title: t("onboarding.headerHostTitle", { defaultValue: "List your property" }), subtitle: t("onboarding.headerHostSubtitle", { defaultValue: "Add the required details, then activate when everything is ready." }) }
    : portal === "transport"
      ? { icon: <Hammer className="w-5 h-5" />, title: t("onboarding.headerTransportTitle", { defaultValue: "List your transport" }), subtitle: t("onboarding.headerTransportSubtitle", { defaultValue: "Tell us what you drive or offer — we'll match you to nearby riders and travellers." }) }
      : portal === "provider"
        ? { icon: <Hammer className="w-5 h-5" />, title: t("onboarding.headerProviderTitle", { defaultValue: "List your service" }), subtitle: t("onboarding.headerProviderSubtitle", { defaultValue: "Tell us what you do — we'll match you to nearby customers." }) }
        : { icon: <Award className="w-5 h-5" />, title: t("onboarding.headerDefaultTitle", { defaultValue: "Create a listing" }), subtitle: t("onboarding.headerDefaultSubtitle", { defaultValue: "Pick a category to get started." }) };

  const update = <K extends keyof OnboardingProfile>(key: K, value: OnboardingProfile[K]) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
  };

  // Opt-in "enhance with AI" for the description. Mirrors the AI chat path's
  // offer to polish a thin blurb — the server returns the original text
  // unchanged if it can't improve it, so this never wipes the user's words.
  const [enhancingDescription, setEnhancingDescription] = useState(false);
  const enhanceDescription = async () => {
    const current = (profile.description ?? "").trim();
    if (enhancingDescription || !current) return;
    setEnhancingDescription(true);
    try {
      const res = await apiRequest<{ description: string }>("/api/onboarding-chat/enhance-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: current, profile }),
      });
      if (res.success && res.data?.description && res.data.description.trim() !== current) {
        update("description", res.data.description.trim() as OnboardingProfile["description"]);
        toast.success(t("onboarding.descEnhanced", { defaultValue: "Description polished — edit it however you like." }));
      } else if (res.success) {
        toast.message(t("onboarding.descEnhanceNoChange", { defaultValue: "That already reads well — no changes made." }));
      } else {
        toast.error(res.error || t("onboarding.descEnhanceFailed", { defaultValue: "Couldn't enhance just now. Please try again." }));
      }
    } finally {
      setEnhancingDescription(false);
    }
  };

  const [isLocatingDirect, setIsLocatingDirect] = useState(false);
  const useCurrentLocation = async () => {
    if (isLocatingDirect) return;
    setIsLocatingDirect(true);
    // Direct geolocation API + Nominatim reverse-geocode (same path the
    // booking modal uses). Replaces the older LocationContext call that
    // polled with a fixed 1.5s setTimeout — that race lost on slow GPS
    // fixes and emitted misleading "Could not detect" toasts.
    try {
      const { getCurrentPosition, reverseGeocode } = await import("@/lib/geo");
      const pos = await getCurrentPosition({ enableHighAccuracy: true });
      const text = await reverseGeocode(pos.lat, pos.lng);
      setProfile((prev) => ({
        ...prev,
        lat: pos.lat,
        lng: pos.lng,
        location: text ?? `Lat ${pos.lat.toFixed(5)}, Lng ${pos.lng.toFixed(5)}`,
      }));
      if (text) {
        toast.success(t("onboarding.addressFilled", { defaultValue: "Address filled from your device location." }));
      } else {
        toast.message(t("onboarding.coordsOnly", { defaultValue: "Used your coordinates — couldn't fetch a street address right now." }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("onboarding.locationFailed", { defaultValue: "Couldn't get your location." });
      toast.error(message);
    } finally {
      setIsLocatingDirect(false);
    }
  };

  const uploadPhotoToStorage = async (file: File): Promise<string> => {
    // Assisted onboarding: photos live under the TARGET user's path (with
    // the role-gated cross-user header) so downstream surfaces treat them
    // exactly like the host's own uploads.
    const uploadOwner = targetUserId ?? user?.id;
    const key = buildUploadKey(`properties/${uploadOwner}`, file.name);
    const token = await getAccessToken();
    const response = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/storage/upload`, {
      method: "POST",
      headers: {
        "Content-Type": file.type,
        "x-upload-bucket": "listing-images",
        "x-upload-key": key,
        ...(targetUserId ? { "x-upload-target-user": targetUserId } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const uploadError = new Error(
        typeof err.error === "string" ? err.error : err.error?.message || "Upload failed",
      ) as Error & { code?: string };
      uploadError.code = typeof err.error === "object" ? err.error?.code : undefined;
      throw uploadError;
    }
    const result = await response.json();
    return result.publicUrl;
  };

  // Translate a raw upload failure into a specific, human reason. Categorizes
  // NSFW rejections, unsupported file types, and oversize files so the modal
  // can say exactly what went wrong instead of surfacing a fetch/HTTP string.
  const describePhotoReason = (err: unknown): string => {
    const code = (err as { code?: string })?.code;
    const raw = errorMessage(err, "");
    if (code === "IMAGE_CONTENT_REJECTED") {
      // Server message is already user-facing ("explicit content" / "too revealing").
      return raw || t("onboarding.photoRejectedContent", { defaultValue: "This photo looks inappropriate for a listing. Please choose a different one." });
    }
    if (/unsupported file type|allowed types|iso-8859-1|code point/i.test(raw)) {
      return t("onboarding.photoRejectedFormat", { defaultValue: "This file isn't a supported image. Please upload a JPEG, PNG, or WEBP." });
    }
    if (/file size|10\s*mb|too large|payload too large/i.test(raw)) {
      return t("onboarding.photoRejectedSize", { defaultValue: "This file is too large. Please upload an image under 10MB." });
    }
    return raw || t("onboarding.photoUploadFailed", { defaultValue: "Photo upload failed. Please try again." });
  };

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadingPhotos(true);
    // Per-file settle so one rejected photo (e.g. the server's NSFW moderation
    // gate, IMAGE_CONTENT_REJECTED) doesn't discard the rest of the batch.
    const results = await Promise.allSettled(files.map(uploadPhotoToStorage));
    const urls = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
    if (urls.length > 0) {
      setProfile((prev) => ({ ...prev, photos: [...prev.photos, ...urls] }));
      toast.success(t("onboarding.photosAdded", { defaultValue: "{{count}} photo(s) added", count: urls.length }));
    }
    const rejections = results.flatMap((r, i) =>
      r.status === "rejected" ? [{ file: files[i].name, reason: describePhotoReason(r.reason) }] : [],
    );
    if (rejections.length > 0) setPhotoRejections(rejections);
    setUploadingPhotos(false);
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const removePhoto = (idx: number) => {
    setProfile((prev) => ({ ...prev, photos: prev.photos.filter((_, i) => i !== idx) }));
  };

  const toggleArrayValue = (key: "languages" | "amenities", value: string) => {
    setProfile((prev) => ({
      ...prev,
      [key]: prev[key].includes(value) ? prev[key].filter((v) => v !== value) : [...prev[key], value],
    }));
  };

  // Treat "host portal" entry as host even before a category is picked.
  // Otherwise the empty-category branch falls through to service copy
  // (e.g. "e.g. CoolFix Plumbing" placeholder on a host's name field).
  // Once they pick a stay tile, profile.category is already 'hotel' or
  // 'homestay' so isHostCat agrees — both signals match.
  const host = isHostCat(profile.category) || portal === "host";
  const transport = isTransportCat(profile.category);
  const service = !!profile.category && !host && !transport;
  // Multi-room hosts (hotel/lodge/heritage) collect layout per room type
  // in Section 6, not at the property level. For them, Section 3's
  // bedrooms/bathrooms/maxGuests are hidden and Section 4's price field
  // is hidden — those numbers come from the room rows instead.
  const multiRoom = host && isMultiRoomProperty(profile.propertyType);

  // Required-field gate. The shape differs across roles AND across the
  // multi-room split — what's required at the property level vs. delegated
  // to room types is part of the same business rule. Hotel/lodge/heritage
  // need at least one valid room type, not property-level layout/price.
  // Compute the missing-field set + the "is form complete" boolean in
  // one pass so the disabled-submit gate and the per-Field highlighting
  // can't drift apart. Keys mirror the `missingKey` strings on each
  // <Field>; the toast on submit renders the same keys as a comma list.
  const missingFields = getOnboardingMissingFields(profile, { pendingRooms, allowedGroups });
  const [triedSubmit, setTriedSubmit] = useState(Boolean(showMissingOnMount));
  useEffect(() => {
    if (showMissingOnMount) setTriedSubmit(true);
  }, [showMissingOnMount]);

  const requiredOk = isOnboardingComplete(profile, { pendingRooms, allowedGroups });

  return (
    <MissingFieldsContext.Provider value={{ triedSubmit, missing: missingFields }}>
    <div className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-background">
      <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
        <BackButton className="mb-3" />

        {/* Header */}
        <div className="flex items-start justify-between mb-6 gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              {headerCopy.icon}
            </div>
            <div>
              <h1 className="font-display text-xl sm:text-2xl font-bold leading-tight">{headerCopy.title}</h1>
              <p className="text-sm text-muted-foreground">{headerCopy.subtitle}</p>
            </div>
          </div>
          {!hideAISwitch && (
            <Button variant="outline" size="sm" className="rounded-xl shrink-0" onClick={onSwitchToAI}>
              <Bot className="w-4 h-4 mr-1" /> {t("onboarding.aiAssistant", { defaultValue: "AI assistant" })}
            </Button>
          )}
        </div>

        <div className="space-y-5">
          {/* SECTION 1 — Basics */}
          <Section
            number={1}
            title={t("onboarding.section1Title", { defaultValue: "The basics" })}
            hint={t("onboarding.section1Hint", { defaultValue: "Pick a category and give your listing a name." })}
          >
            {/* Host portal collapses category + property-type into ONE picker
                here. Picking "Lodge" sets category=hotel + propertyType=lodge
                so backend search/filter still works, but the host only had
                to make one decision. Provider portal (services + transport)
                keeps the original flat category picker since those don't
                have a sub-type concept. */}
            {portal === "host" ? (
              <Field label={t("onboarding.fieldStayType", { defaultValue: "Stay type" })} required missingKey="category">
                <StayTypePicker
                  value={profile.propertyType}
                  onChange={(category, propertyType) =>
                    setProfile((prev) => ({ ...prev, category, propertyType }))
                  }
                />
              </Field>
            ) : (
              <Field label={t("onboarding.fieldCategory", { defaultValue: "Category" })} required missingKey="category">
                <CategoryPicker
                  categories={visibleCategories}
                  value={profile.category}
                  onChange={(v) => update("category", v)}
                  kind={portal === "transport" ? "transport" : "service"}
                />
              </Field>
            )}

            <Field
              label={host ? t("onboarding.fieldPropertyName", { defaultValue: "Property name" }) : transport ? t("onboarding.fieldDriverName", { defaultValue: "Your name (driver or business)" }) : t("onboarding.fieldServiceName", { defaultValue: "Service or business name" })}
              required
              missingKey="name"
              hint={host ? t("onboarding.hintPropertyName", { defaultValue: "What guests will see when they search." }) : t("onboarding.hintBusinessName", { defaultValue: "How customers will recognise you." })}
            >
              <Text
                value={profile.name}
                onChange={(v) => update("name", v)}
                placeholder={
                  host
                    ? (profile.propertyType === "homestay" || profile.propertyType === "village-stay" || profile.propertyType === "farm-stay")
                        ? t("onboarding.phHomestayName", { defaultValue: "e.g. Sunshine Homestay" })
                        : profile.propertyType === "heritage"
                            ? t("onboarding.phHeritageName", { defaultValue: "e.g. The Old Haveli" })
                            : t("onboarding.phHotelName", { defaultValue: "e.g. Lakeview Inn" })
                    : transport ? t("onboarding.phDriverName", { defaultValue: "e.g. Ravi — Old City Auto" }) : t("onboarding.phServiceName", { defaultValue: "e.g. CoolFix Plumbing" })
                }
              />
            </Field>
          </Section>

          {/*
            Section 2 / 3 ordering swaps for SERVICE entry:
            For services, "About your work" reads more naturally BEFORE
            "Where you are" — providers identify themselves first, then
            tell us where they work. Hosts / transport keep the original
            order (location first, then property/vehicle specifics).
          */}
          {service && profile.category && (
            <Section number={2} title={t("onboarding.sectionAboutWorkTitle", { defaultValue: "About your work" })} hint={t("onboarding.sectionAboutWorkHint", { defaultValue: "What makes you stand out." })}>
              <ServiceSpecifics profile={profile} update={update} />
            </Section>
          )}

          {/* "Where you are" only matters for services that TRAVEL to the
              customer (at-home mode). When the provider only does
              visit-provider (customer comes to their shop/clinic) or online
              sessions, the address + service radius is meaningless — the
              shop/studio address is already collected in step 2 and there's
              no travel radius to capture. Skip the whole section in those
              cases so onboarding stops asking the question.
              If at-home is mixed with other modes (e.g. at-home +
              visit-provider), we still show it because radius matters for
              the at-home jobs. Empty serviceModes (not yet picked) falls
              through to "shown" so the user isn't blocked. */}
          {(() => {
            const serviceWithoutAtHome =
              service &&
              Array.isArray(profile.serviceModes) &&
              profile.serviceModes.length > 0 &&
              !profile.serviceModes.includes("at-home");
            if (serviceWithoutAtHome) return null;
            return (
          /* Location section — number depends on whether we already
              rendered specifics above. */
          <Section
            number={service && profile.category ? 3 : 2}
            title={t("onboarding.sectionLocationTitle", { defaultValue: "Where you are" })}
            hint={host ? t("onboarding.sectionLocationHintHost", { defaultValue: "Include the full street address — guests browsing only ever see the area and city; the exact address is shared after a confirmed booking." }) : t("onboarding.sectionLocationHintProvider", { defaultValue: "Your base — we'll match you to nearby jobs." })}
          >
            <Field label={t("onboarding.fieldAddressArea", { defaultValue: "Address or area" })} required missingKey="location">
              <div className="flex gap-2">
                <AddressAutocompleteInput
                  value={profile.location}
                  onChange={(value) => update("location", value)}
                  placeholder={t("onboarding.phCityAreaLandmark", { defaultValue: "City, area, landmark" })}
                  wrapperClassName="relative flex-1"
                  className="flex-1 px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
                />
                <Button type="button" variant="outline" size="sm" className="rounded-xl shrink-0" onClick={useCurrentLocation} disabled={isLocatingDirect || isLocating}>
                  <MapPin className="w-4 h-4 mr-1" />
                  {isLocatingDirect || isLocating ? t("onboarding.locating", { defaultValue: "Locating…" }) : t("onboarding.useCurrent", { defaultValue: "Use current" })}
                </Button>
              </div>
              {profile.lat !== 0 && profile.lng !== 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">📍 {profile.lat.toFixed(4)}, {profile.lng.toFixed(4)}</p>
              )}
            </Field>

            {/* Service area only matters for service + transport. Hosts have a
                fixed location, not a service radius. */}
            {(service || transport) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={t("onboarding.fieldServiceRadius", { defaultValue: "Service radius" })}
                  required={service || transport}
                  missingKey="serviceRadius"
                  hint={t("onboarding.hintServiceRadius", { defaultValue: "How far you'll travel for jobs." })}
                >
                  <NumberWithSuffix
                    value={profile.serviceRadius}
                    onChange={(v) => update("serviceRadius", v)}
                    suffix="km"
                    min={1}
                    max={500}
                  />
                </Field>
                <Field label={t("onboarding.fieldAreasCovered", { defaultValue: "Areas you cover" })} hint={t("onboarding.hintAreasCovered", { defaultValue: "Optional — neighbourhoods or routes." })}>
                  <Text
                    value={profile.serviceArea}
                    onChange={(v) => update("serviceArea", v)}
                    placeholder={transport ? t("onboarding.phAreasTransport", { defaultValue: "e.g. Hyderabad airport routes" }) : t("onboarding.phAreasService", { defaultValue: "e.g. Indiranagar, Koramangala" })}
                  />
                </Field>
              </div>
            )}
          </Section>
            );
          })()}

          {/* Host + transport keep specifics AFTER location — the swap
              only applies to services. Section number 3 is the original
              for host/transport; for service we've already rendered
              specifics above. */}
          {!service && profile.category && (
            <Section
              number={3}
              title={host ? t("onboarding.sectionAboutPropertyTitle", { defaultValue: "About the property" }) : t("onboarding.sectionVehicleTitle", { defaultValue: "Your vehicle" })}
              hint={host ? t("onboarding.sectionAboutPropertyHint", { defaultValue: "What guests need to know about the space." }) : t("onboarding.sectionVehicleHint", { defaultValue: "Helps riders pick the right driver." })}
            >
              {host && <HostSpecifics profile={profile} update={update} toggleArrayValue={toggleArrayValue} setProfile={setProfile} multiRoom={multiRoom} />}
              {transport && <TransportSpecifics profile={profile} update={update} />}
            </Section>
          )}

          {/* SECTION 4 — Pricing & Schedule
              For multi-room hosts, "price per night" is not a property-level
              field — each room type has its own ₹/night in Section 6. We
              hide the price input here and just collect availability.
              Services now collect prices per-row inside the services
              catalog (Section 3 / ServiceCoreFields), so the property-
              level Pricing section is hidden entirely for them. Transport
              skips it too — pricing is mode-aware and lives inside
              TransportSpecifics (per-hour / per-day / per-package). */}
          {profile.category && !service && !transport && (
            <Section
              number={4}
              title={multiRoom ? t("onboarding.sectionAvailabilityTitle", { defaultValue: "Availability" }) : t("onboarding.sectionPricingTitle", { defaultValue: "Pricing" })}
              hint={
                multiRoom
                  ? t("onboarding.sectionPricingHintMultiRoom", { defaultValue: "Per-room prices live in Section 6." })
                  : host
                    ? t("onboarding.sectionPricingHintHost", { defaultValue: "Set your starting price." })
                    : t("onboarding.sectionPricingHintProvider", { defaultValue: "Your visit rate." })
              }
            >
              <div className={multiRoom ? "" : ""}>
                {!multiRoom && !transport && !service && (() => {
                  // Service price label / placeholder tracks the selected
                  // pricing unit so the input reads correctly when the
                  // provider picks "Per hour" / "Per session" / etc.
                  // Stays use a fixed "per night" label.
                  const unitMap: Record<string, { suffix: string; ph: string }> = {
                    per_hour:    { suffix: t("onboarding.unitSuffixPerHour", { defaultValue: "per hour" }),    ph: t("onboarding.phPerHour", { defaultValue: "e.g. ₹350/hour" }) },
                    per_visit:   { suffix: t("onboarding.unitSuffixPerVisit", { defaultValue: "per visit" }),   ph: t("onboarding.phPerVisit", { defaultValue: "e.g. ₹500/visit" }) },
                    per_session: { suffix: t("onboarding.unitSuffixPerSession", { defaultValue: "per session" }), ph: t("onboarding.phPerSession", { defaultValue: "e.g. ₹800/session" }) },
                    per_day:     { suffix: t("onboarding.unitSuffixPerDay", { defaultValue: "per day" }),     ph: t("onboarding.phPerDay", { defaultValue: "e.g. ₹2500/day" }) },
                    fixed:       { suffix: t("onboarding.unitSuffixFixed", { defaultValue: "(fixed)" }),     ph: t("onboarding.phFixed", { defaultValue: "e.g. ₹1500 fixed" }) },
                  };
                  const unitMeta = (service && profile.pricingUnit)
                    ? unitMap[profile.pricingUnit]
                    : undefined;
                  const label = host
                    ? t("onboarding.fieldPricePerNight", { defaultValue: "Price per night" })
                    : unitMeta ? t("onboarding.fieldPriceWithSuffix", { defaultValue: "Price {{suffix}}", suffix: unitMeta.suffix }) : t("onboarding.fieldPricePerVisit", { defaultValue: "Price per visit" });
                  const placeholder = host
                    ? t("onboarding.phPricePerNight", { defaultValue: "₹2500/night" })
                    : unitMeta ? unitMeta.ph : t("onboarding.phPricePerVisit", { defaultValue: "₹500/visit" });
                  return (
                    <Field
                      label={label}
                      required
                      missingKey="price"
                      hint={t("onboarding.hintPriceUnit", { defaultValue: "₹ amount. The displayed unit follows your Pricing unit selection above." })}
                    >
                      <NumericText
                        value={profile.price}
                        onChange={(v) => update("price", v)}
                        placeholder={placeholder}
                        allowDecimal
                      />
                    </Field>
                  );
                })()}
              </div>

              {/* Stay-only: check-in / check-out times. */}
              {host && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label={t("onboarding.fieldCheckIn", { defaultValue: "Check-in time" })} required missingKey="checkInTime" hint={t("onboarding.hintCheckIn", { defaultValue: "When guests can arrive each day." })}>
                    <ThemedTimePicker
                      value={profile.checkInTime}
                      onChange={(v) => update("checkInTime", v)}
                      ariaLabel={t("onboarding.fieldCheckIn", { defaultValue: "Check-in time" })}
                    />
                  </Field>
                  <Field label={t("onboarding.fieldCheckOut", { defaultValue: "Check-out time" })} required missingKey="checkOutTime" hint={t("onboarding.hintCheckOut", { defaultValue: "When guests must vacate." })}>
                    <ThemedTimePicker
                      value={profile.checkOutTime}
                      onChange={(v) => update("checkOutTime", v)}
                      ariaLabel={t("onboarding.fieldCheckOut", { defaultValue: "Check-out time" })}
                    />
                  </Field>
                </div>
              )}
              {/* Removed: "When are you available?" free-text field, vehicle
                  class picker, max-jobs-per-day input, per-weekday working
                  hours grid. Per-hour rate input is also gone from
                  TransportSpecifics. Providers manage all of this from the
                  dashboard once their first listing is live — keeps the
                  onboarding form to the minimum the agent needs to publish. */}
            </Section>
          )}

          {/* SECTION 4.5 — Availability & time slots (services only).
              Time slots are auto-generated from working hours + duration and
              are editable. The provider can publish with the auto set or
              tweak / add bespoke slots. Transport gets working hours but no
              slot picker (its bookings are mode-based, not slot-based). */}
          {profile.category && (service || transport) && (
            <Section
              number={5}
              title={service ? t("onboarding.sectionAvailSlotsTitle", { defaultValue: "Availability & time slots" }) : t("onboarding.sectionWorkingHoursTitle", { defaultValue: "Working hours" })}
              hint={
                service
                  ? t("onboarding.sectionAvailSlotsHint", { defaultValue: "When you take bookings, and which start times customers can pick." })
                  : t("onboarding.sectionWorkingHoursHint", { defaultValue: "When you take bookings." })
              }
            >
              <SchedulingFields profile={profile} setProfile={setProfile} mode={service ? "service" : "transport"} />
              {service && <ServiceTimeSlotsEditor profile={profile} setProfile={setProfile} />}
            </Section>
          )}

          {/* SECTION 6 (or 5 for stays) — Story (description, languages, photos) */}
          {profile.category && (
            <Section
              number={(service || transport) ? 6 : 5}
              title={t("onboarding.sectionStoryTitle", { defaultValue: "Tell your story" })}
              hint={t("onboarding.sectionStoryHint", { defaultValue: "What makes your listing worth booking. Photos move the needle." })}
            >
              <Field label={t("onboarding.fieldDescription", { defaultValue: "Description" })} required missingKey="description" hint={t("onboarding.hintDescription", { defaultValue: "A short blurb so customers know what makes you worth booking." })}>
                <textarea
                  value={profile.description}
                  onChange={(e) => update("description", e.target.value)}
                  placeholder={
                    host ? t("onboarding.phDescriptionHost", { defaultValue: "Two-bedroom homestay near the lake. Quiet street, breakfast included, walking distance to…" })
                      : transport ? t("onboarding.phDescriptionTransport", { defaultValue: "10 years driving in Hyderabad, AC car, English/Hindi/Telugu, airport runs welcome…" })
                        : t("onboarding.phDescriptionService", { defaultValue: "5 years fixing leaks across the old city. Same-day fixes, original parts, transparent pricing…" })
                  }
                  rows={4}
                  className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background resize-none outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={enhanceDescription}
                  disabled={enhancingDescription || !(profile.description ?? "").trim()}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary disabled:opacity-40 disabled:cursor-not-allowed hover:underline"
                >
                  {enhancingDescription
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Sparkles className="w-3.5 h-3.5" />}
                  {t("onboarding.enhanceDescription", { defaultValue: "Enhance with AI" })}
                </button>
              </Field>

              <Field label={t("onboarding.fieldLanguages", { defaultValue: "Languages you speak" })} required={service || transport} missingKey="languages">
                <ChipPicker
                  options={LANGUAGE_OPTIONS}
                  values={profile.languages}
                  onToggle={(v) => toggleArrayValue("languages", v)}
                />
              </Field>

              <Field
                label={t("onboarding.fieldPhotos", { defaultValue: "Photos" })}
                hint={`${t("onboarding.photosMinimum", { defaultValue: "Minimum 5 photos." })} ${
                  host
                    ? t("onboarding.photosHintHost", { defaultValue: "Show the space, the bedrooms, the view." })
                    : transport
                      ? t("onboarding.photosHintTransport", { defaultValue: "Photos of your vehicle build trust fast." })
                      : t("onboarding.photosHintService", { defaultValue: "Photos of your service and work build trust fast." })
                } ${t("onboarding.photosAcceptedFormats", { defaultValue: "Accepted formats: JPEG, PNG, or WEBP, up to 10MB each." })}`}
              >
                <div data-photos-section="true">
                <PhotoGallery
                  photos={profile.photos}
                  uploading={uploadingPhotos}
                  onAddClick={() => photoInputRef.current?.click()}
                  onRemove={removePhoto}
                />
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={handlePhotoSelect}
                  className="hidden"
                />
                {triedSubmit && (profile.photos?.length || 0) < 5 && (
                  <p className="text-xs text-destructive mt-2">
                    {t("onboarding.photosAtLeast5", { defaultValue: "Add at least 5 photos to submit ({{count}}/5).", count: profile.photos?.length || 0 })}
                  </p>
                )}
                </div>
              </Field>
            </Section>
          )}

          {/* SECTION 6 — Room types (for hotel/lodge/heritage)
              Multi-room properties carry their layout per room type, not at
              the property level. Each row is one room TYPE (e.g. "Deluxe
              King"); within a type the host says how many physical rooms
              they have and optionally lists the room numbers. */}
          {multiRoom && (
            <Section
              number={6}
              title={t("onboarding.sectionRoomTypesTitle", { defaultValue: "Room types" })}
              hint={t("onboarding.sectionRoomTypesHint", { defaultValue: "Add the rooms guests can book — Deluxe King, Family Suite, etc. Each row covers one TYPE; you'll say how many rooms of that type you have, and can list the room numbers." })}
            >
              <RoomTypesEditor
                pendingRooms={pendingRooms}
                setPendingRooms={setPendingRooms}
                uploadPhotoToStorage={uploadPhotoToStorage}
                uploadingRoomPhotoFor={uploadingRoomPhotoFor}
                setUploadingRoomPhotoFor={setUploadingRoomPhotoFor}
              />
            </Section>
          )}
        </div>

        {/* Submit bar */}
        <div className="sticky bottom-0 -mx-4 px-4 py-4 bg-gradient-to-t from-background via-background to-background/90 backdrop-blur-sm mt-8 border-t border-border/50">
          <div className="flex flex-wrap gap-2 max-w-2xl mx-auto">
            <Button
              variant="outline"
              className="rounded-xl"
              type="button"
              disabled={isSubmitting}
              onClick={() => {
                // Force-save the current snapshot (in case the debounce
                // hasn't fired yet) and confirm to the user that they
                // can close the tab safely.
                const ok = saveOnboardingDraft(draftOwner, draftType, profile, pendingRooms);
                if (ok) {
                  toast.success(t("onboarding.draftSaved", { defaultValue: "Draft saved. You can resume later from this same browser." }));
                } else {
                  toast.error(t("onboarding.draftSaveFailed", { defaultValue: "Couldn't save draft locally — your browser may be blocking storage." }));
                }
              }}
            >
              {t("onboarding.saveAndContinueLater", { defaultValue: "Save and continue later" })}
            </Button>
            {!hideAISwitch && (
              <Button variant="outline" className="flex-1 rounded-xl" onClick={onSwitchToAI} disabled={isSubmitting}>
                <Bot className="w-4 h-4 mr-1" /> {t("onboarding.continueWithAI", { defaultValue: "Continue with AI" })}
              </Button>
            )}
            <Button
              className="flex-1 rounded-xl font-semibold"
              onClick={() => {
                // The submit button stays enabled even when fields are
                // missing — clicking it surfaces the missing-fields
                // highlight + a toast so the user can see WHAT to fix
                // instead of staring at a greyed-out button.
                // Minimum 5 photos — enforced uniformly across all
                // listing types. Surfaced before the broader required-
                // field check so the user sees a specific, actionable
                // message instead of a generic missing-fields toast.
                if ((profile.photos?.length || 0) < 5) {
                  setTriedSubmit(true);
                  toast.error(
                    t("onboarding.pleaseAdd5Photos", { defaultValue: "Please add at least 5 photos (you've added {{count}}).", count: profile.photos?.length || 0 }),
                  );
                  requestAnimationFrame(() => {
                    const el = document.querySelector<HTMLElement>("[data-photos-section='true']");
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                  });
                  return;
                }
                if (!requiredOk) {
                  setTriedSubmit(true);
                  const names = Array.from(missingFields).map(missingOnboardingLabel).join(", ");
                  toast.error(
                    names
                      ? t("onboarding.completeRequiredFields", { defaultValue: "Please complete these required fields: {{names}}.", names })
                      : t("onboarding.fewFieldsMissing", { defaultValue: "A few required fields are still missing — they're highlighted in red below." })
                  );
                  // Scroll the first highlighted field into view so the
                  // user doesn't have to hunt for it on long forms.
                  requestAnimationFrame(() => {
                    const el = document.querySelector<HTMLElement>("[data-missing-field='true']");
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                  });
                  return;
                }
                // Multi-room hosts must declare at least one valid room
                // type — the listing's bookable inventory IS those rows.
                // We also enforce that every row added is fully filled
                // (no half-typed rooms slipping through).
                if (multiRoom) {
                  const valid = pendingRooms.filter((r) => r.name.trim() && Number(r.pricePerNight) > 0);
                  if (pendingRooms.length === 0) {
                    toast.error(t("onboarding.addOneRoomType", { defaultValue: "Add at least one room type — that's what guests will book." }));
                    return;
                  }
                  if (valid.length !== pendingRooms.length) {
                    toast.error(t("onboarding.roomNeedsNamePrice", { defaultValue: "Every room type needs a name and a ₹/night price." }));
                    return;
                  }
                  // Per-room amenities replace the property-level amenity
                  // minimum for multi-room stays. Require at least 3 per
                  // room so search filters surface meaningful matches —
                  // a room with only "AC" hits too many queries to be
                  // useful. Surface which rooms are short so the host
                  // doesn't have to hunt through the editor.
                  const ROOM_AMENITY_MIN = 3;
                  const shortRooms = valid.filter((r) => (r.amenities?.length || 0) < ROOM_AMENITY_MIN);
                  if (shortRooms.length > 0) {
                    const names = shortRooms.map((r) => `"${r.name.trim()}"`).join(", ");
                    toast.error(t("onboarding.roomAmenitiesShort", { defaultValue: "Add at least {{min}} amenities to each room. Still short: {{names}}.", min: ROOM_AMENITY_MIN, names }));
                    return;
                  }
                  // Max guests + room count + at least one photo per room —
                  // same bar as the edit-mode room manager.
                  const noGuests = valid.filter((r) => Number(r.maxGuests) < 1);
                  if (noGuests.length > 0) {
                    toast.error(t("onboarding.roomMaxGuestsMissing", { defaultValue: "Set max guests for each room. Still missing: {{names}}.", names: noGuests.map((r) => `"${r.name.trim()}"`).join(", ") }));
                    return;
                  }
                  const noQuantity = valid.filter((r) => Number(r.quantity) < 1);
                  if (noQuantity.length > 0) {
                    toast.error(t("onboarding.roomQuantityMissing", { defaultValue: "Set how many rooms of each type. Still missing: {{names}}.", names: noQuantity.map((r) => `"${r.name.trim()}"`).join(", ") }));
                    return;
                  }
                  const noPhotos = valid.filter((r) => !(r.photos?.length));
                  if (noPhotos.length > 0) {
                    toast.error(t("onboarding.roomPhotosMissing", { defaultValue: "Add at least one photo to each room. Still missing: {{names}}.", names: noPhotos.map((r) => `"${r.name.trim()}"`).join(", ") }));
                    return;
                  }
                  onSubmit({ pendingRooms: valid });
                  return;
                }
                // Draft clearing happens in the parent's onSubmit handler
                // ONLY after the publish call resolves successfully — if
                // the API fails the draft stays put so the user can fix
                // + retry (or close the tab and resume) without losing
                // the work they already filled.
                onSubmit();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {t("onboarding.submitting", { defaultValue: "Submitting…" })}</span>
              ) : (
                t("onboarding.reviewAndSubmit", { defaultValue: "Review & submit" })
              )}
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={!!photoRejections} onOpenChange={(open) => { if (!open) setPhotoRejections(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {photoRejections && photoRejections.length === 1
                ? t("onboarding.photoRejectedTitleOne", { defaultValue: "This photo couldn't be added" })
                : t("onboarding.photoRejectedTitleMany", { defaultValue: "Some photos couldn't be added" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("onboarding.photoRejectedIntro", { defaultValue: "Please replace the photo(s) below and try again." })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-2 text-sm max-h-60 overflow-y-auto">
            {(photoRejections || []).map((r, i) => (
              <li key={i} className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <span className="block font-medium break-all">{r.file}</span>
                <span className="block text-muted-foreground">{r.reason}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setPhotoRejections(null)}>
              {t("onboarding.photoRejectedGotIt", { defaultValue: "Got it" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </MissingFieldsContext.Provider>
  );
};

// ---------- Section primitives ----------

const Section = ({ number, title, hint, children }: { number: number; title: string; hint?: string; children: React.ReactNode }) => (
  <section className="bg-card rounded-2xl border border-border p-5 sm:p-6 space-y-4">
    <header className="flex items-start gap-3">
      <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
        {number}
      </span>
      <div>
        <h2 className="font-display font-semibold text-base sm:text-lg leading-tight">{title}</h2>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
    </header>
    <div className="space-y-4 pl-0 sm:pl-10">{children}</div>
  </section>
);

/**
 * Tracks which required fields are still empty AFTER the user has tried
 * to submit at least once. The form root computes the set; <Field>
 * subscribes via context so a missing field gets a destructive label
 * colour + a one-line "Required" hint without each call-site having to
 * pass error props. Pre-submit nothing is highlighted — the asterisks
 * alone signal what's required.
 */
const MissingFieldsContext = createContext<{ triedSubmit: boolean; missing: Set<string> }>({
  triedSubmit: false,
  missing: new Set(),
});

const Field = ({ label, hint, required, missingKey, children }: {
  label: string;
  hint?: string;
  required?: boolean;
  /** Key in the form's `missing` set. When provided AND the user has
   *  tried to submit AND the key is missing, the label turns red. */
  missingKey?: string;
  children: React.ReactNode;
}) => {
  const { t } = useLanguage();
  const { triedSubmit, missing } = useContext(MissingFieldsContext);
  const isMissing = required && triedSubmit && (missingKey != null) && missing.has(missingKey);
  return (
    <div data-missing-field={isMissing ? "true" : undefined}>
      <label className={`text-sm font-medium block mb-1.5 ${isMissing ? "text-destructive" : ""}`}>
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
        {hint && <span className={`text-xs font-normal block ${isMissing ? "text-destructive/80" : "text-muted-foreground"}`}>{hint}</span>}
        {isMissing && (
          <span className="block text-[11px] font-bold text-destructive mt-0.5">{t("onboarding.fieldRequiredHint", { defaultValue: "Required — please fill this before submitting." })}</span>
        )}
      </label>
      {/* When the field is missing after a submit attempt, paint the actual
          input controls red (border + faint fill) so the empty box itself is
          obviously flagged — not just the label. Targets nested
          input/textarea/select so it works regardless of which input
          primitive the field renders. The red clears automatically once the
          value parses (the `missing` set recomputes on every keystroke). */}
      <div className={isMissing
        ? "[&_input]:border-destructive [&_input]:bg-destructive/5 [&_textarea]:border-destructive [&_textarea]:bg-destructive/5 [&_select]:border-destructive [&_select]:bg-destructive/5"
        : undefined}>
        {children}
      </div>
    </div>
  );
};

const Text = ({ value, onChange, placeholder, type = "text" }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
  />
);

/** Numeric-only text input. Strips anything that isn't a digit or a
 *  single decimal point so price/seating fields can't accept "₹500/visit"
 *  or "abc". Keeps the value as a string so an empty field stays empty
 *  (unlike type=number which fights the user mid-typing). */
const NumericText = ({
  value, onChange, placeholder, allowDecimal = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  allowDecimal?: boolean;
}) => (
  <input
    type="text"
    inputMode={allowDecimal ? "decimal" : "numeric"}
    value={value}
    onChange={(e) => {
      const raw = e.target.value;
      let cleaned = raw.replace(allowDecimal ? /[^0-9.]/g : /[^0-9]/g, "");
      if (allowDecimal) {
        // Keep only the first decimal point.
        const firstDot = cleaned.indexOf(".");
        if (firstDot !== -1) {
          cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
        }
      }
      onChange(cleaned);
    }}
    placeholder={placeholder}
    className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
  />
);

/**
 * Numeric input with a separate string buffer so the user can naturally
 * clear / replace the value. The previous controlled-`value={value || ""}`
 * pattern re-rendered to "" whenever onChange parsed to 0, which collided
 * with the user's keystrokes (e.g. clearing "1" → empty re-rendered
 * mid-keystroke and stole the cursor). Sync flows:
 *   - typing: buffer follows the input verbatim; if it parses to a finite
 *     number we emit it to the parent so downstream validation stays live
 *   - blur: if the buffer is empty/invalid, snap the buffer back to the
 *     current parent value (or empty if the parent stores 0)
 *   - external resets: when the parent value changes from a source other
 *     than this input, mirror it into the buffer
 */
const NumberField = ({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) => {
  const [text, setText] = useState<string>(value > 0 ? String(value) : "");
  const lastEmittedRef = useRef<number>(value);
  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      setText(value > 0 ? String(value) : "");
      lastEmittedRef.current = value;
    }
  }, [value]);
  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === "") {
          // Empty buffer => 0 in state (lets requiredOk fire). Don't snap
          // back to a placeholder digit while the user is mid-typing.
          lastEmittedRef.current = 0;
          onChange(0);
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) {
          lastEmittedRef.current = n;
          onChange(n);
        }
      }}
      onBlur={() => {
        const n = Number(text);
        if (!Number.isFinite(n) || text === "") {
          // Normalize on blur: if the user left it blank, show the
          // current parent value (or "" when it's 0) so the field
          // reflects what's actually persisted.
          setText(value > 0 ? String(value) : "");
        }
      }}
      className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
    />
  );
};

const NumberWithSuffix = ({ value, onChange, suffix, min, max }: { value: number; onChange: (v: number) => void; suffix: string; min?: number; max?: number }) => (
  <div className="relative">
    <input
      type="number"
      value={value || ""}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      className="w-full px-3 py-2.5 pr-10 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
    />
    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>
  </div>
);

// ---------- Domain-specific pickers ----------

const CategoryPicker = ({
  categories, value, onChange, kind = "service",
}: {
  categories: Array<{ value: string; label: string; tKey: string; emoji: string; group: CategoryGroup }>;
  value: string;
  onChange: (v: string) => void;
  kind?: "service" | "transport";
}) => {
  const { t } = useLanguage();
  const isPresetSelected = categories.some((c) => c.value === value);
  // Services use a typeahead combobox — there are ~50 of them and a flat
  // tile grid forces the provider to scroll. Transport stays as a tiled
  // picker because the list is short and the choice is visual.
  if (kind === "service") {
    return (
      <ServiceCategoryCombobox
        categories={categories}
        value={value}
        isPresetSelected={isPresetSelected}
        onChange={onChange}
      />
    );
  }
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {categories.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            className={`px-3 py-2.5 rounded-xl border text-xs font-medium transition-all flex items-center gap-2 ${
              value === c.value
                ? "bg-primary text-primary-foreground border-primary shadow-sm"
                : "bg-background border-border hover:border-primary/40"
            }`}
          >
            <span className="text-base">{c.emoji}</span>
            <span className="truncate">{t(c.tKey, { defaultValue: c.label })}</span>
          </button>
        ))}
      </div>
      <details className="rounded-xl border border-dashed border-border/70 px-3 py-2" open={!isPresetSelected && !!value}>
        <summary className="cursor-pointer text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
          {t("onboarding.customVehiclePrompt", { defaultValue: "Don't see your transportation? Add a custom vehicle" })}
        </summary>
        <input
          type="text"
          value={isPresetSelected ? "" : value}
          placeholder={t("onboarding.phCustomVehicle", { defaultValue: "e.g. minibus, van, ferry, e-rickshaw" })}
          onChange={(e) => {
            const slug = e.target.value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
            onChange(slug);
          }}
          className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/20"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("onboarding.storedAsPrefix", { defaultValue: "Stored as" })} <code>{(isPresetSelected ? "" : value) || "—"}</code>. {t("onboarding.useSpecialtyHint", { defaultValue: "Use the Specialty field below for finer detail." })}
        </p>
      </details>
    </div>
  );
};

/** Type-to-search service picker. Renders an input + dropdown of matching
 *  presets, plus a fallback "use my custom category" row that kebab-cases
 *  whatever the provider typed. Closes on outside click or selection. */
const ServiceCategoryCombobox = ({
  categories, value, isPresetSelected, onChange,
}: {
  categories: Array<{ value: string; label: string; tKey: string; emoji: string; group: CategoryGroup }>;
  value: string;
  isPresetSelected: boolean;
  onChange: (v: string) => void;
}) => {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selected = categories.find((c) => c.value === value);
  const labelFor = (c: { tKey: string; label: string }) => t(c.tKey, { defaultValue: c.label });
  const displayValue = open
    ? query
    : selected
      ? labelFor(selected)
      : (value && !isPresetSelected ? value : "");

  const q = query.trim().toLowerCase();
  const matches = q
    ? categories.filter((c) =>
        labelFor(c).toLowerCase().includes(q) || c.label.toLowerCase().includes(q) || c.value.toLowerCase().includes(q),
      )
    : categories;

  const slugify = (v: string) =>
    v.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  const customSlug = slugify(query);
  const showCustomRow = q.length > 0 && !matches.some((c) => c.value === customSlug);

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={displayValue}
        placeholder={t("onboarding.phSearchServices", { defaultValue: "Type to search services — e.g. plumber, cook, tutor" })}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-xl border border-border bg-popover shadow-lg">
          {matches.length === 0 && !showCustomRow && (
            <div className="px-3 py-2 text-xs text-muted-foreground">{t("onboarding.noServiceMatches", { defaultValue: "No matches — keep typing to add a custom service." })}</div>
          )}
          {matches.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => {
                onChange(c.value);
                setQuery("");
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted ${
                value === c.value ? "bg-primary/10 text-primary" : ""
              }`}
            >
              <span className="text-base">{c.emoji}</span>
              <span className="flex-1 truncate">{labelFor(c)}</span>
            </button>
          ))}
          {showCustomRow && (
            <button
              type="button"
              onClick={() => {
                onChange(customSlug);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm border-t border-border hover:bg-muted"
            >
              <span className="text-muted-foreground">{t("onboarding.useCustomService", { defaultValue: "Use custom service:" })}</span>{" "}
              <code className="text-primary">{customSlug}</code>
            </button>
          )}
        </div>
      )}
      {selected && !open && (
        <p className="mt-1 text-[11px] text-muted-foreground">{t("onboarding.selectedLabel", { defaultValue: "Selected: {{label}}", label: labelFor(selected) })}</p>
      )}
      {!selected && value && !isPresetSelected && !open && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("onboarding.storedAsPrefix", { defaultValue: "Stored as" })} <code>{value}</code>.
        </p>
      )}
    </div>
  );
};

const ChipPicker = ({
  options, values, onToggle, renderIcon,
}: {
  options: string[];
  values: string[];
  onToggle: (v: string) => void;
  renderIcon?: (v: string) => React.ReactNode;
}) => (
  <div className="flex flex-wrap gap-2">
    {options.map((opt) => {
      const on = values.includes(opt);
      return (
        <button
          key={opt}
          type="button"
          onClick={() => onToggle(opt)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
            on ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-primary/10"
          }`}
        >
          {renderIcon?.(opt)}
          {opt}
        </button>
      );
    })}
  </div>
);

const PhotoGallery = ({
  photos, uploading, onAddClick, onRemove,
}: {
  photos: string[];
  uploading: boolean;
  onAddClick: () => void;
  onRemove: (idx: number) => void;
}) => {
  const { t } = useLanguage();
  return (
  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
    {photos.map((url, idx) => (
      <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-border group">
        <img src={url} alt={t("onboarding.photoAlt", { defaultValue: "Photo {{n}}", n: idx + 1 })} className="w-full h-full object-cover" />
        <button
          type="button"
          onClick={() => onRemove(idx)}
          className="absolute top-1 right-1 p-1 bg-black/60 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    ))}
    <button
      type="button"
      onClick={onAddClick}
      disabled={uploading}
      className="aspect-square rounded-xl border-2 border-dashed border-border hover:border-primary/50 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
    >
      {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
      <span className="text-[10px]">{uploading ? t("onboarding.uploadingEllipsis", { defaultValue: "Uploading…" }) : t("onboarding.addPhoto", { defaultValue: "Add photo" })}</span>
    </button>
  </div>
  );
};

// ---------- Role-specific section bodies ----------

const HostSpecifics = ({
  profile, update, toggleArrayValue, setProfile, multiRoom,
}: {
  profile: OnboardingProfile;
  update: <K extends keyof OnboardingProfile>(key: K, value: OnboardingProfile[K]) => void;
  toggleArrayValue: (key: "languages" | "amenities", value: string) => void;
  setProfile: React.Dispatch<React.SetStateAction<OnboardingProfile>>;
  /** Multi-room property — bedrooms/bathrooms/maxGuests are collected
   *  per room type in Section 6, not at the property level. */
  multiRoom: boolean;
}) => {
  const { t } = useLanguage();
  // Property type was moved into Section 1 (StayTypePicker) — hosts only
  // make that decision once. This section's contents differ by stay type:
  //   - whole-property stays (homestay/village-stay/farm-stay) need
  //     property-wide bedrooms/bathrooms/max-guests
  //   - multi-room stays (hotel/lodge/heritage) skip those because the
  //     numbers describe individual rooms and live in Section 6; their
  //     profile.amenities instead carries hotel-wide FACILITIES (pool/gym)
  //     while in-room amenities live per room type.
  return (
    <>
      {!multiRoom && (
        <div className="grid grid-cols-3 gap-3">
          <Field label={t("onboarding.fieldBedrooms", { defaultValue: "Bedrooms" })} required missingKey="bedrooms">
            <NumberField value={profile.bedrooms} onChange={(v) => update("bedrooms", v)} min={1} max={50} />
          </Field>
          <Field label={t("onboarding.fieldBathrooms", { defaultValue: "Bathrooms" })}>
            <NumberField value={profile.bathrooms} onChange={(v) => update("bathrooms", v)} min={1} max={50} />
          </Field>
          <Field label={t("onboarding.fieldMaxGuests", { defaultValue: "Max guests" })} required missingKey="maxGuests">
            <NumberField value={profile.maxGuests} onChange={(v) => update("maxGuests", v)} min={1} max={100} />
          </Field>
        </div>
      )}

      {/* Property-level amenities only make sense for single-unit stays
          (homestay / village-stay / farm-stay) where every guest shares the
          same space. Multi-room properties (hotel / lodge / heritage /
          sathram) collect amenities PER ROOM in the room-types editor
          instead — a Deluxe King's AC + balcony isn't the same as a
          Standard Twin's. */}
      {!multiRoom && (
        <Field
          label={t("onboarding.fieldAmenities", { defaultValue: "Amenities" })}
          required
          missingKey="amenities"
          hint={t("onboarding.hintAmenities", { defaultValue: "Pick what your place actually has — guests filter on these. Minimum 5 ({{count}}/5).", count: profile.amenities.length })}
        >
          <AmenitiesPicker profile={profile} toggleArrayValue={toggleArrayValue} setProfile={setProfile} />
        </Field>
      )}

      {/* Multi-room stays repurpose profile.amenities for property-WIDE
          facilities — the pool/gym/restaurant the whole hotel shares.
          In-room amenities live on each room type in the rooms editor. */}
      {multiRoom && (
        <Field
          label={t("onboarding.fieldHotelFacilities", { defaultValue: "Hotel facilities" })}
          hint={t("onboarding.hintHotelFacilities", { defaultValue: "Shared facilities guests can use — pool, gym, restaurant. In-room amenities go on each room type instead." })}
        >
          <RoomAmenitiesPicker
            amenities={profile.amenities}
            onChange={(next) => update("amenities", next)}
            presets={HOTEL_FACILITIES}
            placeholder={t("onboarding.phAddFacility", { defaultValue: "Add another (e.g. conference hall)" })}
          />
        </Field>
      )}
    </>
  );
};

/**
 * Stay-type tiles for Section 1. Renders the 6 sub-types as visual
 * cards; clicking one sets BOTH `category` (hotel|homestay backend
 * bucket) and `propertyType` (the user-visible sub-type) atomically so
 * the two never drift out of sync.
 */
const StayTypePicker = ({
  value, onChange,
}: {
  value: string;
  onChange: (category: "hotel" | "homestay", propertyType: string) => void;
}) => {
  const { t } = useLanguage();
  return (
  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
    {STAY_TYPE_TILES.map((tile) => (
      <button
        key={tile.propertyType}
        type="button"
        onClick={() => onChange(tile.category, tile.propertyType)}
        className={`px-3 py-3 rounded-xl border text-xs font-medium transition-all flex flex-col items-center gap-1 ${
          value === tile.propertyType
            ? "bg-primary text-primary-foreground border-primary shadow-sm"
            : "bg-background border-border hover:border-primary/40"
        }`}
      >
        <span className="text-xl">{tile.emoji}</span>
        <span>{t(tile.tKey, { defaultValue: tile.label })}</span>
      </button>
    ))}
  </div>
  );
};

/**
 * Compact per-room amenity picker used inside the multi-room editor. Keeps
 * the same chip-style as `AmenitiesPicker` so the host learns the pattern
 * once, but operates on a passed-in `amenities` array instead of mutating
 * `profile.amenities` directly. Custom values (free-text "rooftop terrace")
 * join the same array, de-duped case-insensitively to keep the union the
 * filter computes from double-counting "AC" + "ac".
 */
const RoomAmenitiesPicker = ({
  amenities, onChange, presets = STAY_AMENITIES, placeholder,
}: {
  amenities: string[];
  onChange: (next: string[]) => void;
  /** Chip presets — defaults to in-room amenities; the hotel-facilities
   *  field passes HOTEL_FACILITIES instead. */
  presets?: Array<{ value: string; label: string; tKey?: string; icon: React.ReactNode }>;
  placeholder?: string;
}) => {
  const { t } = useLanguage();
  const resolvedPlaceholder = placeholder ?? t("onboarding.phAddAmenityRoom", { defaultValue: "Add another (e.g. minibar, sea view)" });
  const [draft, setDraft] = useState("");
  const builtIn = new Set(presets.map((a) => a.value.toLowerCase()));
  const customAmenities = amenities.filter((a) => !builtIn.has(a.toLowerCase()));

  const toggle = (value: string) => {
    const lower = value.toLowerCase();
    const has = amenities.some((a) => a.toLowerCase() === lower);
    onChange(has ? amenities.filter((a) => a.toLowerCase() !== lower) : [...amenities, value]);
  };

  const addCustom = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (amenities.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...amenities, trimmed]);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((a) => {
          const on = amenities.some((x) => x.toLowerCase() === a.value.toLowerCase());
          return (
            <button
              key={a.value}
              type="button"
              onClick={() => toggle(a.value)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors flex items-center gap-1 ${
                on ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-primary/10"
              }`}
            >
              {a.icon}
              {a.tKey ? t(a.tKey, { defaultValue: a.label }) : a.label}
            </button>
          );
        })}
      </div>
      {customAmenities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {customAmenities.map((a) => (
            <span
              key={a}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-accent/15 text-accent border border-accent/30 flex items-center gap-1"
            >
              {a}
              <button
                type="button"
                onClick={() => onChange(amenities.filter((x) => x !== a))}
                className="hover:text-destructive"
                aria-label={t("onboarding.removeItem", { defaultValue: "Remove {{item}}", item: a })}
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
          placeholder={resolvedPlaceholder}
          className="flex-1 px-2 py-1.5 border border-border rounded-lg text-xs bg-background outline-none focus:ring-2 focus:ring-primary/20"
        />
        <Button type="button" variant="outline" size="sm" className="rounded-lg h-8 px-2 text-xs" onClick={addCustom} disabled={!draft.trim()}>
          <Plus className="w-3 h-3 mr-0.5" /> {t("onboarding.add", { defaultValue: "Add" })}
        </Button>
      </div>
    </div>
  );
};

/**
 * Amenity picker — built-in chips from STAY_AMENITIES plus a free-form
 * "Add custom" input. Custom amenities go into the same `profile.amenities`
 * array (so the agent's extract_fields tool sees one consistent shape) and
 * render below the canned set as removable chips. The X handler removes
 * by exact string match — fine because we de-dup on add.
 */
const AmenitiesPicker = ({
  profile, toggleArrayValue, setProfile,
}: {
  profile: OnboardingProfile;
  toggleArrayValue: (key: "languages" | "amenities", value: string) => void;
  setProfile: React.Dispatch<React.SetStateAction<OnboardingProfile>>;
}) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState("");
  const builtIn = new Set(STAY_AMENITIES.map((a) => a.value));
  const customAmenities = profile.amenities.filter((a) => !builtIn.has(a));

  const addCustom = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (profile.amenities.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
      // Already added (built-in OR custom) — surface a tiny hint instead
      // of silently swallowing. We don't toast here because amenity edits
      // happen frequently and a toast per dupe would be noisy.
      setDraft("");
      return;
    }
    setProfile((prev) => ({ ...prev, amenities: [...prev.amenities, trimmed] }));
    setDraft("");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {STAY_AMENITIES.map((a) => {
          const on = profile.amenities.includes(a.value);
          return (
            <button
              key={a.value}
              type="button"
              onClick={() => toggleArrayValue("amenities", a.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                on ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-primary/10"
              }`}
            >
              {a.icon}
              {t(a.tKey, { defaultValue: a.label })}
            </button>
          );
        })}
      </div>

      {/* Custom amenities — rendered as their own row so users see what
          they've added separately from the canned options. */}
      {customAmenities.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {customAmenities.map((a) => (
            <span
              key={a}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent/15 text-accent border border-accent/30 flex items-center gap-1.5"
            >
              {a}
              <button
                type="button"
                onClick={() =>
                  setProfile((prev) => ({ ...prev, amenities: prev.amenities.filter((x) => x !== a) }))
                }
                className="hover:text-destructive"
                aria-label={t("onboarding.removeItem", { defaultValue: "Remove {{item}}", item: a })}
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
          placeholder={t("onboarding.phAddAmenity", { defaultValue: "Add another amenity (e.g. rooftop terrace, library)" })}
          className="flex-1 px-3 py-2 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
        />
        <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={addCustom} disabled={!draft.trim()}>
          <Plus className="w-4 h-4 mr-1" /> {t("onboarding.add", { defaultValue: "Add" })}
        </Button>
      </div>
    </div>
  );
};

// Transport mode picker. "point" is intentionally disabled in Phase 1 — full
// routing/pricing logic for A→B rides isn't built yet. Keeping the option
// visible (with a "Beta — coming soon" badge) makes the staged rollout
// explicit instead of hiding the choice entirely.
const TRANSPORT_MODE_OPTIONS: Array<{
  value: import("@/hooks/useConversationEngine").TransportMode;
  label: string;
  labelKey: string;
  emoji: string;
  hint: string;
  hintKey: string;
  disabled?: boolean;
  badge?: string;
  badgeKey?: string;
}> = [
  { value: "hourly",  label: "Hourly rental", labelKey: "onboarding.transportModeHourly", emoji: "⏰", hint: "Book by the hour", hintKey: "onboarding.transportModeHourlyHint" },
  { value: "day",     label: "Day rental",    labelKey: "onboarding.transportModeDay",    emoji: "📅", hint: "Full-day with driver", hintKey: "onboarding.transportModeDayHint" },
  { value: "package", label: "Tour package",  labelKey: "onboarding.transportModePackage",emoji: "🗺️", hint: "Predefined itineraries", hintKey: "onboarding.transportModePackageHint" },
  { value: "point",   label: "Point ride",    labelKey: "onboarding.transportModePoint",  emoji: "📍", hint: "A → B fixed trip", hintKey: "onboarding.transportModePointHint", disabled: true, badge: "Coming soon", badgeKey: "onboarding.comingSoon" },
];

const TransportSpecifics = ({
  profile, update,
}: {
  profile: OnboardingProfile;
  update: <K extends keyof OnboardingProfile>(key: K, value: OnboardingProfile[K]) => void;
}) => {
  const { t } = useLanguage();
  type Mode = import("@/hooks/useConversationEngine").TransportMode;
  // Drivers can offer more than one booking style (a tour-package vendor
  // who also rents hourly is common). The picker is multi-select; clicking
  // a selected tile deselects it. The legacy `transportMode` stays in
  // sync as the FIRST selected mode so adapters / agents that only know
  // the single-mode field round-trip cleanly.
  const selectedModes: Mode[] = profile.transportModes && profile.transportModes.length > 0
    ? profile.transportModes
    : (profile.transportMode ? [profile.transportMode] : []);
  const toggleMode = (mode: Mode) => {
    if (mode === "point") return; // gated
    const isOn = selectedModes.includes(mode);
    const next = isOn ? selectedModes.filter((m) => m !== mode) : [...selectedModes, mode];
    update("transportModes", next);
    // Keep the single-mode field in sync for adapter/agent compatibility.
    update("transportMode", (next[0] || "hourly") as Mode);
  };
  const hasMode = (mode: Mode) => selectedModes.includes(mode);

  return (
    <>
      {/* Manual transport onboarding: three free-text fields instead of the
          catalog picker. Keep it minimal — the driver tells us what they
          drive in plain words. The fallback synthesizer in the submit path
          turns these into a single transportationTypes entry. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label={t("onboarding.fieldVehicleType", { defaultValue: "Vehicle type" })} required missingKey="vehicleType" hint={t("onboarding.hintVehicleType", { defaultValue: "e.g. Sedan, SUV, Tempo" })}>
          <Text value={profile.vehicleType} onChange={(v) => update("vehicleType", v)} placeholder={t("onboarding.phVehicleType", { defaultValue: "e.g. Sedan" })} />
        </Field>
        <Field label={t("onboarding.fieldModel", { defaultValue: "Model" })} required missingKey="vehicleName" hint={t("onboarding.hintModel", { defaultValue: "Make and model." })}>
          <Text value={profile.vehicleName} onChange={(v) => update("vehicleName", v)} placeholder={t("onboarding.phModel", { defaultValue: "e.g. Maruti Dzire" })} />
        </Field>
        <Field label={t("onboarding.fieldSeatingCapacity", { defaultValue: "Seating capacity" })} required missingKey="seatingCapacity" hint={t("onboarding.hintSeatingCapacity", { defaultValue: "Passengers it can carry." })}>
          <NumericText value={profile.seatingCapacity} onChange={(v) => update("seatingCapacity", v)} placeholder={t("onboarding.phSeating", { defaultValue: "e.g. 4" })} />
        </Field>
      </div>

      {/* Vehicle colour + number plate — riders see these in the booking
          summary to spot the exact car, so both are required. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t("onboarding.fieldVehicleColor", { defaultValue: "Vehicle colour" })} required missingKey="vehicleColor" hint={t("onboarding.hintVehicleColor", { defaultValue: "Helps riders spot the car." })}>
          <Text value={profile.vehicleColor} onChange={(v) => update("vehicleColor", v)} placeholder={t("onboarding.phVehicleColor", { defaultValue: "e.g. White" })} />
        </Field>
        <Field label={t("onboarding.fieldLicensePlate", { defaultValue: "Number plate" })} required missingKey="licensePlate" hint={t("onboarding.hintLicensePlate", { defaultValue: "The registration number." })}>
          <Text value={profile.licensePlate} onChange={(v) => update("licensePlate", v)} placeholder={t("onboarding.phLicensePlate", { defaultValue: "e.g. KA 01 AB 1234" })} />
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t("onboarding.fieldYearsDriving", { defaultValue: "Years driving" })} required missingKey="experience">
          <Text value={profile.experience} onChange={(v) => update("experience", v)} placeholder={t("onboarding.phYears", { defaultValue: "e.g. 8 years" })} />
        </Field>
        <Field label={t("onboarding.fieldSubcategories", { defaultValue: "Subcategories" })} hint={t("onboarding.hintSubcategoriesTransport", { defaultValue: "Optional — add each one you offer. e.g. airport runs, pilgrimage routes, intercity." })}>
          <ChipListInput
            value={profile.subcategories}
            onChange={(next) => update("subcategories", next)}
            placeholder={t("onboarding.phSubcategory", { defaultValue: "Type a subcategory and press Add" })}
            emptyHint={t("onboarding.emptyHintSubcategoriesTransport", { defaultValue: "Customers will see and be able to filter by these." })}
          />
        </Field>
      </div>

      <Field
        label={t("onboarding.fieldTransportBooking", { defaultValue: "How do customers book your transportation?" })}
        required
        missingKey="transportMode"
        hint={t("onboarding.hintTransportBooking", { defaultValue: "Pick every booking style you offer — tap again to deselect. We'll ask for pricing for each one you turn on." })}
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {TRANSPORT_MODE_OPTIONS.map((opt) => {
            const on = hasMode(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleMode(opt.value)}
                disabled={opt.disabled}
                aria-pressed={on}
                className={`px-3 py-2.5 rounded-xl border text-xs font-medium transition-all text-left ${
                  opt.disabled
                    ? "bg-muted text-muted-foreground border-border opacity-60 cursor-not-allowed"
                    : on
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-background border-border hover:border-primary/40"
                }`}
              >
                <div className="text-base">{opt.emoji}</div>
                <div className="font-semibold">{t(opt.labelKey, { defaultValue: opt.label })}</div>
                <div className="text-[10px] opacity-70">{t(opt.hintKey, { defaultValue: opt.hint })}</div>
                {opt.badge && (
                  <div className="mt-1 inline-block px-1.5 py-0.5 rounded text-[9px] bg-warning/10 text-warning border border-warning/30">
                    {opt.badgeKey ? t(opt.badgeKey, { defaultValue: opt.badge }) : opt.badge}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </Field>

      {/* Per-mode pricing. Per-km / quotes were removed as part of the Phase
          6C transport scope — the only bookable modes today are hourly, day,
          and package. Drivers without a per-mode rate are not bookable.
          These coexist with the per-type prices in TransportationTypesPicker:
          the per-mode rate is what the booking modal uses as the listing-
          level fare; per-type values are the catalog detail for each
          vehicle/service. */}
      {hasMode("hourly") && (
        <Field label={t("onboarding.fieldHourlyRate", { defaultValue: "Listing-level hourly rate" })} required missingKey="pricePerHour" hint={t("onboarding.hintHourlyRate", { defaultValue: "₹ per hour shown on this listing." })}>
          <NumericText value={profile.pricePerHour} onChange={(v) => update("pricePerHour", v)} placeholder={t("onboarding.phHourlyRate", { defaultValue: "e.g. 350" })} allowDecimal />
        </Field>
      )}

      {hasMode("day") && (
        <Field label={t("onboarding.fieldDayRate", { defaultValue: "Listing-level day rate" })} required missingKey="pricePerDay" hint={t("onboarding.hintDayRate", { defaultValue: "₹ for a full-day rental." })}>
          <NumericText value={profile.pricePerDay} onChange={(v) => update("pricePerDay", v)} placeholder={t("onboarding.phDayRate", { defaultValue: "e.g. 4500" })} allowDecimal />
        </Field>
      )}

      {hasMode("package") && (
        <PackageOptionsEditor profile={profile} update={update} />
      )}
    </>
  );
};

/**
 * Package-mode tour editor. Each row is one predefined itinerary
 * (label + price + hours + optional blurb) and persists as
 * `listings.metadata.packageOptions[]`. Rows with no label or price are
 * dropped before the create payload is built, so the host can leave a half-
 * typed row sitting in the UI without it polluting the listing.
 */
const PackageOptionsEditor = ({
  profile, update,
}: {
  profile: OnboardingProfile;
  update: <K extends keyof OnboardingProfile>(key: K, value: OnboardingProfile[K]) => void;
}) => {
  const { t } = useLanguage();
  const rows = profile.packageOptions;
  const setRows = (next: typeof rows) => update("packageOptions", next);
  const patch = (id: string, partial: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r) => (r.id === id ? { ...r, ...partial } : r)));
  const addRow = () =>
    setRows([
      ...rows,
      {
        id: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: "",
        price: "",
        hours: "",
        description: "",
        stops: [{ place: "", dwellMinutes: "" }],
        distanceKmMin: "",
        distanceKmMax: "",
        languages: [],
      },
    ]);
  const removeRow = (id: string) => setRows(rows.filter((r) => r.id !== id));

  // Stop sub-editor helpers — packages live in an array, stops live inside
  // each package, so patching by index is enough.
  const patchStop = (
    pkgId: string,
    stopIdx: number,
    partial: Partial<(typeof rows)[number]["stops"][number]>,
  ) => {
    setRows(rows.map((r) => {
      if (r.id !== pkgId) return r;
      const stops = r.stops.map((s, i) => (i === stopIdx ? { ...s, ...partial } : s));
      return { ...r, stops };
    }));
  };
  const addStop = (pkgId: string) => {
    setRows(rows.map((r) => r.id === pkgId
      ? { ...r, stops: [...r.stops, { place: "", dwellMinutes: "" }] }
      : r));
  };
  const removeStop = (pkgId: string, stopIdx: number) => {
    setRows(rows.map((r) => r.id === pkgId
      ? { ...r, stops: r.stops.filter((_, i) => i !== stopIdx) }
      : r));
  };

  // Working-hours fit check — the package's `hours` must fit inside at
  // least one of the listing's open-day windows. If the widest open day
  // is 6 hours, a 10-hour tour is unbookable and the host should know
  // before they hit publish.
  const widestWindowMin = widestWorkingWindowMinutes(
    profile.workingHours as Parameters<typeof widestWorkingWindowMinutes>[0],
  );
  const widestWindowHours = widestWindowMin / 60;

  // Subscribe to validation context so this nested editor participates
  // in the form-level "missing required fields" treatment exactly like
  // the flat <Field> wrappers do.
  const { triedSubmit, missing } = useContext(MissingFieldsContext);
  const isMissingPackages = triedSubmit && missing.has("packageOptions");
  return (
    <div
      data-missing-field={isMissingPackages ? "true" : undefined}
      className={`rounded-xl border p-4 space-y-3 ${
        isMissingPackages ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/30"
      }`}
    >
      <div>
        <label className={`text-sm font-medium block ${isMissingPackages ? "text-destructive" : ""}`}>
          {t("onboarding.tourPackages", { defaultValue: "Tour packages" })}<span className="text-destructive ml-0.5">*</span>
          <span className={`text-xs font-normal block ${isMissingPackages ? "text-destructive/80" : "text-muted-foreground"}`}>
            {t("onboarding.tourPackagesHint", { defaultValue: "Predefined itineraries customers can pick from. Add at least one with a name and a price." })}
          </span>
          {isMissingPackages && (
            <span className="block text-[11px] font-bold text-destructive mt-0.5">{t("onboarding.tourPackagesRequired", { defaultValue: "Required — add at least one package row with a label and a price before submitting." })}</span>
          )}
        </label>
      </div>

      {rows.length === 0 && (
        <div className={`text-center py-4 border-2 border-dashed rounded-lg text-xs ${
          isMissingPackages ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground"
        }`}>
          {t("onboarding.noPackagesYet", { defaultValue: "No packages yet — add one to publish." })}
        </div>
      )}

      {rows.map((row, idx) => {
        const hoursNum = Number(row.hours);
        const overflowsWindow = widestWindowMin > 0
          && Number.isFinite(hoursNum)
          && hoursNum > 0
          && hoursNum * 60 > widestWindowMin;
        const minKm = Number(row.distanceKmMin);
        const maxKm = Number(row.distanceKmMax);
        const kmRangeBackwards = Number.isFinite(minKm) && Number.isFinite(maxKm)
          && minKm > 0 && maxKm > 0 && maxKm < minKm;
        // Sum of per-stop dwell minutes shouldn't exceed the tour's total
        // hours — driving time accounts for the rest, but if dwell alone
        // already overshoots, the numbers don't add up.
        const dwellSumMin = totalDwellMinutes(row.stops);
        const dwellOverflowsHours = hoursNum > 0
          && dwellSumMin > 0
          && dwellSumMin > hoursNum * 60;
        return (
        <div key={row.id} className="bg-background rounded-xl border border-border p-3 space-y-3">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-[11px] font-bold flex items-center justify-center shrink-0">
              {idx + 1}
            </span>
            <input
              value={row.label}
              onChange={(e) => patch(row.id, { label: e.target.value })}
              placeholder={t("onboarding.phPackageName", { defaultValue: "Package name (e.g. North Goa Day Tour)" })}
              className="flex-1 px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Button type="button" size="icon" variant="ghost"
              className="rounded-full h-8 w-8 text-destructive hover:text-destructive shrink-0"
              onClick={() => removeRow(row.id)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>

          {/* Price / Hours */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground block mb-1">{t("onboarding.packagePriceLabel", { defaultValue: "Price (₹)" })}</label>
              <input
                type="number"
                value={row.price}
                onChange={(e) => patch(row.id, { price: e.target.value })}
                placeholder="3500"
                className="w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground block mb-1">{t("onboarding.packageHoursLabel", { defaultValue: "Hours" })}</label>
              <input
                type="number"
                value={row.hours}
                onChange={(e) => patch(row.id, { hours: e.target.value })}
                placeholder="8"
                className={`w-full px-2 py-1.5 border rounded-lg text-sm bg-background outline-none focus:ring-2 ${
                  overflowsWindow ? "border-destructive/60 focus:ring-destructive/20" : "border-border focus:ring-primary/20"
                }`}
              />
              {overflowsWindow && widestWindowHours > 0 && (
                <p className="mt-1 text-[11px] font-semibold text-destructive">
                  {t("onboarding.tourLongerThanDay", { defaultValue: "This tour ({{hours}}h) is longer than your widest open day ({{window}}h). Extend working hours or shorten the tour.", hours: hoursNum, window: widestWindowHours.toFixed(widestWindowHours % 1 === 0 ? 0 : 1) })}
                </p>
              )}
            </div>
          </div>

          {/* Distance range */}
          <div>
            <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground block mb-1">{t("onboarding.distanceCovered", { defaultValue: "Distance covered (km)" })}</label>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <input
                type="number"
                value={row.distanceKmMin}
                onChange={(e) => patch(row.id, { distanceKmMin: e.target.value })}
                placeholder={t("onboarding.phDistanceMin", { defaultValue: "Min · e.g. 70" })}
                className={`w-full px-2 py-1.5 border rounded-lg text-sm bg-background outline-none focus:ring-2 ${
                  kmRangeBackwards ? "border-destructive/60 focus:ring-destructive/20" : "border-border focus:ring-primary/20"
                }`}
              />
              <span className="text-xs font-bold text-muted-foreground">{t("onboarding.rangeTo", { defaultValue: "to" })}</span>
              <input
                type="number"
                value={row.distanceKmMax}
                onChange={(e) => patch(row.id, { distanceKmMax: e.target.value })}
                placeholder={t("onboarding.phDistanceMax", { defaultValue: "Max · e.g. 90" })}
                className={`w-full px-2 py-1.5 border rounded-lg text-sm bg-background outline-none focus:ring-2 ${
                  kmRangeBackwards ? "border-destructive/60 focus:ring-destructive/20" : "border-border focus:ring-primary/20"
                }`}
              />
            </div>
            {kmRangeBackwards && (
              <p className="mt-1 text-[11px] font-semibold text-destructive">{t("onboarding.maxKmAtLeastMin", { defaultValue: "Max km should be at least the min." })}</p>
            )}
          </div>

          {/* Itinerary stops */}
          <div>
            <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground block mb-1">
              {t("onboarding.placesVisited", { defaultValue: "Places visited" })} <span className="text-destructive">*</span>
              <span className="block text-[10px] font-normal text-muted-foreground/80 normal-case tracking-normal">{t("onboarding.placesVisitedHint", { defaultValue: "Add each stop in order. Dwell time is optional." })}</span>
            </label>
            <div className="grid gap-1.5">
              {row.stops.map((stop, sIdx) => (
                <div key={sIdx} className="grid grid-cols-[20px_1fr_92px_28px] items-center gap-1.5">
                  <span className="text-[11px] font-bold text-muted-foreground text-center">{sIdx + 1}.</span>
                  <input
                    value={stop.place}
                    onChange={(e) => patchStop(row.id, sIdx, { place: e.target.value })}
                    placeholder={t("onboarding.phStopPlace", { defaultValue: "e.g. Golconda Fort" })}
                    className="px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <input
                    type="number"
                    value={stop.dwellMinutes}
                    onChange={(e) => patchStop(row.id, sIdx, { dwellMinutes: e.target.value })}
                    placeholder={t("onboarding.phMin", { defaultValue: "min" })}
                    className="px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
                    aria-label={t("onboarding.ariaDwellMinutes", { defaultValue: "Approx minutes at this stop (optional)" })}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 rounded-full text-muted-foreground hover:text-destructive disabled:opacity-30"
                    onClick={() => removeStop(row.id, sIdx)}
                    disabled={row.stops.length <= 1}
                    aria-label={t("onboarding.removeStop", { defaultValue: "Remove stop" })}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs"
              onClick={() => addStop(row.id)}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> {t("onboarding.addStop", { defaultValue: "Add stop" })}
            </Button>
            {dwellOverflowsHours && (
              <p className="mt-1 text-[11px] font-semibold text-destructive">
                {t("onboarding.dwellOverflow", { defaultValue: "Your per-stop minutes add up to {{dwell}} min, but the tour is only {{total}} min ({{hours}}h). Trim a stop or extend the duration.", dwell: dwellSumMin, total: hoursNum * 60, hours: hoursNum })}
              </p>
            )}
          </div>

          {/* Per-package languages — optional, falls back to listing langs */}
          <div>
            <label className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground block mb-1">
              {t("onboarding.languagesOnTour", { defaultValue: "Languages on this tour" })} <span className="font-normal normal-case tracking-normal text-muted-foreground/70">{t("onboarding.languagesOnTourHint", { defaultValue: "(optional — defaults to listing)" })}</span>
            </label>
            <ChipListInput
              value={row.languages}
              onChange={(next) => patch(row.id, { languages: next })}
              placeholder={t("onboarding.phLanguagesExample", { defaultValue: "e.g. English, Hindi, Telugu" })}
            />
          </div>

          {/* Description */}
          <textarea
            value={row.description}
            onChange={(e) => patch(row.id, { description: e.target.value })}
            placeholder={t("onboarding.phPackageDescription", { defaultValue: "Anything else? Meals, entry fees, what makes this tour special." })}
            rows={2}
            className="w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-background resize-none outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      );
      })}

      <Button type="button" variant="outline" className="w-full rounded-lg" onClick={addRow}>
        <Plus className="w-4 h-4 mr-1" /> {t("onboarding.addPackage", { defaultValue: "Add package" })}
      </Button>
    </div>
  );
};

// Service modes shown as a multi-select. A listing can support more than one
// mode (e.g. a tutor who teaches both at home and online), so we persist them
// as an array in `listings.metadata.serviceModes`. Mode-specific follow-up
// fields appear conditionally to keep the form short for single-mode services.
const SERVICE_MODE_OPTIONS: Array<{
  value: import("@/hooks/useConversationEngine").ServiceMode;
  label: string;
  labelKey: string;
  emoji: string;
  hint: string;
  hintKey: string;
}> = [
  { value: "at-home",        label: "At customer's home", labelKey: "onboarding.serviceModeAtHome",   emoji: "🏠", hint: "You travel to them", hintKey: "onboarding.serviceModeAtHomeHint" },
  { value: "visit-provider", label: "At your location",   labelKey: "onboarding.serviceModeVisit",    emoji: "🏪", hint: "Customer visits you", hintKey: "onboarding.serviceModeVisitHint" },
  { value: "online",         label: "Online / remote",    labelKey: "onboarding.serviceModeOnline",   emoji: "💻", hint: "Video / phone session", hintKey: "onboarding.serviceModeOnlineHint" },
];

const PRICING_UNIT_OPTIONS: Array<{ value: string; label: string; labelKey: string }> = [
  { value: "",            label: "Auto / blank",  labelKey: "onboarding.pricingUnitAuto" },
  { value: "per_hour",    label: "Per hour",      labelKey: "onboarding.pricingUnitPerHour" },
  { value: "per_visit",   label: "Per visit",     labelKey: "onboarding.pricingUnitPerVisit" },
  { value: "per_session", label: "Per session",   labelKey: "onboarding.pricingUnitPerSession" },
  { value: "per_day",     label: "Per day",       labelKey: "onboarding.pricingUnitPerDay" },
  { value: "fixed",       label: "Fixed price",   labelKey: "onboarding.pricingUnitFixed" },
];

const ServiceSpecifics = ({
  profile, update,
}: {
  profile: OnboardingProfile;
  update: <K extends keyof OnboardingProfile>(key: K, value: OnboardingProfile[K]) => void;
}) => {
  const { t } = useLanguage();
  const toggleMode = (mode: import("@/hooks/useConversationEngine").ServiceMode) => {
    const next = profile.serviceModes.includes(mode)
      ? profile.serviceModes.filter((m) => m !== mode)
      : [...profile.serviceModes, mode];
    update("serviceModes", next);
  };

  const showVisit = profile.serviceModes.includes("visit-provider");

  // Keep `location` in sync with `visitAddress` whenever the host is on a
  // visit-provider-only-ish path. The "Where you are" section is hidden in
  // that path, so location has no UI of its own — without this mirror the
  // submit validator (and the server's location-required gate) trip on a
  // field the host never sees. Runs as an effect so it covers profiles
  // loaded from a draft / agent extract where visitAddress was set before
  // the host opened the form.
  useEffect(() => {
    const modes = profile.serviceModes;
    const visitProviderOnlyish =
      Array.isArray(modes) && modes.length > 0 && !modes.includes("at-home");
    if (visitProviderOnlyish && profile.visitAddress && profile.visitAddress !== profile.location) {
      update("location", profile.visitAddress);
    }
  }, [profile.serviceModes, profile.visitAddress, profile.location, update]);
  const showOnline = profile.serviceModes.includes("online");

  return (
    <>
      <Field
        label={t("onboarding.fieldServiceDelivery", { defaultValue: "How do you deliver this service?" })}
        required
        missingKey="serviceModes"
        hint={t("onboarding.hintServiceDelivery", { defaultValue: "Pick all that apply — you can offer more than one." })}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {SERVICE_MODE_OPTIONS.map((opt) => {
            const on = profile.serviceModes.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleMode(opt.value)}
                className={`px-3 py-2.5 rounded-xl border text-xs font-medium transition-all text-left ${
                  on
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-background border-border hover:border-primary/40"
                }`}
              >
                <div className="text-base">{opt.emoji}</div>
                <div className="font-semibold">{t(opt.labelKey, { defaultValue: opt.label })}</div>
                <div className="text-[10px] opacity-70">{t(opt.hintKey, { defaultValue: opt.hint })}</div>
              </button>
            );
          })}
        </div>
      </Field>

      {showVisit && (
        <Field
          label={t("onboarding.fieldShopAddress", { defaultValue: "Your shop / studio / clinic address" })}
          required
          missingKey="visitAddress"
          hint={t("onboarding.hintShopAddress", { defaultValue: "Shown to customers when they pick the 'visit you' option." })}
        >
          <AddressAutocompleteInput
            value={profile.visitAddress}
            onChange={(v) => {
              update("visitAddress", v);
              // The "Where you are" section is hidden whenever serviceModes
              // excludes "at-home" (the shop address covers it), so the
              // host never sees a separate location input. Mirror the
              // visit address into `location` so the validator + server's
              // location requirement are satisfied without exposing two
              // address fields that mean the same thing.
              const modes = profile.serviceModes;
              const visitProviderOnlyish =
                Array.isArray(modes) && modes.length > 0 && !modes.includes("at-home");
              if (visitProviderOnlyish) {
                update("location", v);
              }
            }}
            placeholder={t("onboarding.phShopAddress", { defaultValue: "e.g. Shop 4, 2nd Cross, Indiranagar" })}
            wrapperClassName="relative"
            className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
          />
          {/* WS6 host consent: OFF (default) = customers get this address
              only after a confirmed booking; ON = it shows on the public
              listing (walk-in premises). Mirrors EditListingModal's switch. */}
          <div className="mt-2 flex items-start gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{t("editListing.showAddressPubliclyLabel", { defaultValue: "Show this address publicly" })}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                {t("editListing.showAddressPubliclyHint", { defaultValue: "For a shop, salon, or clinic customers walk into. When off, the address is shared only after a confirmed booking." })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => update("showAddressPublicly", !profile.showAddressPublicly)}
              role="switch"
              aria-checked={profile.showAddressPublicly === true}
              aria-label={t("editListing.showAddressPubliclyLabel", { defaultValue: "Show this address publicly" })}
              className={`relative mt-0.5 inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                profile.showAddressPublicly ? "bg-success" : "bg-muted"
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${profile.showAddressPublicly ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
          </div>
        </Field>
      )}

      {showOnline && (
        <Field
          label={t("onboarding.fieldOnlineDelivery", { defaultValue: "Online delivery details" })}
          required
          missingKey="meetingDetails"
          hint={t("onboarding.hintOnlineDelivery", { defaultValue: "How the customer reaches you for the session. Sent in the booking confirmation." })}
        >
          <textarea
            value={profile.meetingDetails}
            onChange={(e) => update("meetingDetails", e.target.value)}
            placeholder={t("onboarding.phOnlineDelivery", { defaultValue: "e.g. I'll WhatsApp the Zoom link 30 min before your slot." })}
            rows={2}
            className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background resize-none outline-none focus:ring-2 focus:ring-primary/20"
          />
        </Field>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t("onboarding.fieldYearsExperience", { defaultValue: "Years of experience" })} required missingKey="experience">
          <Text value={profile.experience} onChange={(v) => update("experience", v)} placeholder={t("onboarding.phYears", { defaultValue: "e.g. 8 years" })} />
        </Field>
        <Field label={t("onboarding.fieldJobDuration", { defaultValue: "Typical job duration" })} required missingKey="duration" hint={t("onboarding.hintJobDuration", { defaultValue: "How long one job takes — used to derive bookable time slots. Max 24 hours." })}>
          <Text value={profile.duration} onChange={(v) => update("duration", v)} placeholder={t("onboarding.phJobDuration", { defaultValue: "e.g. 1 hour" })} />
          {(() => {
            const dh = parseDurationHours(profile.duration);
            if (dh != null && dh > 24) {
              return <p className="text-[11px] text-destructive mt-1 font-semibold">{t("onboarding.durationMax24", { defaultValue: "Duration can't exceed 24 hours for a single job." })}</p>;
            }
            return null;
          })()}
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t("onboarding.fieldSubcategories", { defaultValue: "Subcategories" })} hint={t("onboarding.hintSubcategoriesService", { defaultValue: "Everything you offer — add one at a time so customers can search and filter by each." })}>
          <ChipListInput
            value={profile.subcategories}
            onChange={(next) => update("subcategories", next)}
            placeholder={t("onboarding.phSubcategoryService", { defaultValue: "e.g. Beard trim, Deep cleaning, Math tutoring" })}
            emptyHint={t("onboarding.emptyHintSubcategoriesService", { defaultValue: "A salon might add Hair, Beard, Nails. A tutor might add Math, Physics." })}
          />
        </Field>
        <Field label={t("onboarding.fieldPricingUnit", { defaultValue: "Pricing unit" })} required missingKey="pricingUnit" hint={t("onboarding.hintPricingUnit", { defaultValue: "How customers see the rate." })}>
          <select
            value={profile.pricingUnit}
            onChange={(e) => update("pricingUnit", e.target.value)}
            className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
          >
            {PRICING_UNIT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{t(opt.labelKey, { defaultValue: opt.label })}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label={t("onboarding.fieldServicesCatalog", { defaultValue: "Services catalog" })}
        required
        missingKey="servicesCatalog"
        hint={t("onboarding.hintServicesCatalog", { defaultValue: "Each service has a base price. Add optional add-ons (extras priced on top) under each service." })}
      >
        <ServicesCatalogRepeater
          value={profile.servicesCatalog}
          onChange={(next) => update("servicesCatalog", next)}
        />
      </Field>
    </>
  );
};

// Repeater for the service catalog. Each row is a bookable service group
// with its own basePrice + nested add-on list. Writes through to
// profile.servicesCatalog: [{ id, name, basePrice, addOns: [...] }].
// Service-only; rendered inside ServiceCoreFields so it only shows when a
// service category is picked. Each row gets a stable id at insert time so
// the booking modal + backend re-validator can match selections by id.
const ServicesCatalogRepeater = ({
  value,
  onChange,
}: {
  value: OnboardingProfile["servicesCatalog"];
  onChange: (next: OnboardingProfile["servicesCatalog"]) => void;
}) => {
  const { t } = useLanguage();
  // When value is empty we render a "ghost" row — looks like an editable
  // group but isn't actually in profile state. The first edit (name,
  // basePrice, or add-on) materializes it via onChange. Avoids the form
  // claiming to have a service the host never authored.
  const isGhost = !value || value.length === 0;
  const GHOST_ID = "svc-ghost";
  const rows = isGhost
    ? [{ id: GHOST_ID, name: "", basePrice: 0, addOns: [] }]
    : value;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    // First row auto-expanded; the rest collapsed. Keyed by group id so
    // adding a new row doesn't accidentally collapse one the user opened.
    const out: Record<string, boolean> = {};
    rows.forEach((g, i) => { out[g.id] = i === 0; });
    return out;
  });

  const materializeGhost = (patch: Partial<{ name: string; basePrice: number; addOns: OnboardingProfile["servicesCatalog"][number]["addOns"] }>) => {
    const realized = {
      id: `svc-${Date.now().toString(36)}-0`,
      name: "",
      basePrice: 0,
      addOns: [] as OnboardingProfile["servicesCatalog"][number]["addOns"],
      ...patch,
    };
    onChange([realized]);
  };

  const updateGroup = (i: number, patch: Partial<{ name: string; basePrice: number; addOns: OnboardingProfile["servicesCatalog"][number]["addOns"] }>) => {
    if (isGhost) {
      materializeGhost(patch);
      return;
    }
    const next = rows.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const removeGroup = (i: number) => {
    if (isGhost || rows.length <= 1) return;
    onChange(rows.filter((_, idx) => idx !== i));
  };
  const addGroup = () => {
    // If the host clicks "Add another service" while the ghost is still
    // showing, materialize the ghost as group 0 so both rows persist.
    const base = isGhost
      ? [{ id: `svc-${Date.now().toString(36)}-0`, name: "", basePrice: 0, addOns: [] }]
      : rows;
    const id = `svc-${Date.now().toString(36)}-${base.length}`;
    onChange([...base, { id, name: "", basePrice: 0, addOns: [] }]);
    setExpanded((prev) => ({ ...prev, [id]: true }));
  };

  return (
    <div className="space-y-2.5">
      {rows.map((group, i) => {
        const isOpen = expanded[group.id] ?? (i === 0);
        return (
          <div key={group.id} className="rounded-xl border border-border bg-background/40 p-3 space-y-2.5">
            {!isOpen ? (
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [group.id]: true }))}
                className="w-full flex items-center justify-between text-left"
              >
                <span className="text-sm font-semibold text-foreground truncate">
                  {group.name || t("onboarding.untitledService", { defaultValue: "Untitled service" })}
                  <span className="text-muted-foreground font-normal"> · ₹{group.basePrice || 0} · {t("onboarding.addOnCount", { defaultValue: "{{count}} add-on(s)", count: group.addOns.length })}</span>
                </span>
                <span className="text-xs font-semibold text-primary shrink-0 ml-2">{t("onboarding.edit", { defaultValue: "Edit" })}</span>
              </button>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_140px_36px] items-center gap-2">
                  <input
                    type="text"
                    value={group.name}
                    onChange={(e) => updateGroup(i, { name: e.target.value })}
                    placeholder={t("onboarding.phServiceGroupName", { defaultValue: "Service name (e.g. Men's haircut)" })}
                    className="w-full px-3 py-2 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">₹</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={Number.isFinite(group.basePrice) && group.basePrice > 0 ? String(group.basePrice) : ""}
                      onChange={(e) => updateGroup(i, { basePrice: Math.max(0, Number(e.target.value) || 0) })}
                      placeholder={t("onboarding.phBasePrice", { defaultValue: "Base price" })}
                      className="w-full pl-7 pr-2 py-2 border border-border rounded-xl text-sm bg-background tabular-nums outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeGroup(i)}
                    disabled={rows.length <= 1}
                    aria-label={t("onboarding.removeService", { defaultValue: "Remove service" })}
                    className="grid place-items-center h-9 w-9 rounded-xl border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:border-border disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <CatalogAddOnsRepeater
                  value={group.addOns}
                  onChange={(next) => updateGroup(i, { addOns: next })}
                />
              </>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={addGroup}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
      >
        <Plus className="w-3.5 h-3.5" /> {t("onboarding.addAnotherService", { defaultValue: "Add another service" })}
      </button>
    </div>
  );
};

// Nested add-on editor used by each services-catalog group. Mirrors the
// previous standalone AddOnsRepeater styling so the visual language stays
// the same — only the data path changes (now scoped under a group instead
// of profile.addOns).
const CatalogAddOnsRepeater = ({
  value,
  onChange,
}: {
  value: OnboardingProfile["servicesCatalog"][number]["addOns"];
  onChange: (next: OnboardingProfile["servicesCatalog"][number]["addOns"]) => void;
}) => {
  const { t } = useLanguage();
  const rows = value ?? [];
  const updateRow = (i: number, patch: Partial<{ label: string; price: number }>) => {
    const next = rows.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const addRow = () => onChange([
    ...rows,
    { id: `addon-${Date.now().toString(36)}-${rows.length}`, label: "", price: 0 },
  ]);

  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-background/30 p-2.5 space-y-2">
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1 py-1">
          <Sparkles className="w-3 h-3 text-primary/60 shrink-0" />
          <span>{t("onboarding.noAddOns", { defaultValue: "No add-ons for this service. Use “Add an add-on” for extras priced on top." })}</span>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div
              key={row.id || `addon-${i}`}
              className="grid grid-cols-[1fr_120px_32px] items-center gap-2"
            >
              <input
                type="text"
                value={row.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
                placeholder={t("onboarding.phAddOnName", { defaultValue: "Add-on name (e.g. Beard trim)" })}
                className="w-full px-3 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
              />
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">₹</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={Number.isFinite(row.price) && row.price > 0 ? String(row.price) : ""}
                  onChange={(e) => updateRow(i, { price: Math.max(0, Number(e.target.value) || 0) })}
                  placeholder="0"
                  className="w-full pl-6 pr-2 py-1.5 border border-border rounded-lg text-sm bg-background tabular-nums outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label={t("onboarding.removeAddOn", { defaultValue: "Remove add-on" })}
                className="grid place-items-center h-8 w-8 rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline"
      >
        <Plus className="w-3 h-3" /> {t("onboarding.addAnAddOn", { defaultValue: "Add an add-on" })}
      </button>
    </div>
  );
};

// ---------- Scheduling (service + transport) ----------

const DAY_LABELS: Array<{ key: keyof import("@/hooks/useConversationEngine").WorkingHours; label: string; tKey: string }> = [
  { key: "mon", label: "Mon", tKey: "onboarding.dayMon" }, { key: "tue", label: "Tue", tKey: "onboarding.dayTue" }, { key: "wed", label: "Wed", tKey: "onboarding.dayWed" },
  { key: "thu", label: "Thu", tKey: "onboarding.dayThu" }, { key: "fri", label: "Fri", tKey: "onboarding.dayFri" }, { key: "sat", label: "Sat", tKey: "onboarding.daySat" }, { key: "sun", label: "Sun", tKey: "onboarding.daySun" },
];

const SchedulingFields = ({
  profile, setProfile, mode,
}: {
  profile: OnboardingProfile;
  setProfile: React.Dispatch<React.SetStateAction<OnboardingProfile>>;
  mode: "service" | "transport";
}) => {
  const { t } = useLanguage();
  const setDay = (
    day: keyof import("@/hooks/useConversationEngine").WorkingHours,
    next: import("@/hooks/useConversationEngine").DayWindow,
  ) => {
    setProfile((p) => ({ ...p, workingHours: { ...p.workingHours, [day]: next } }));
  };

  const applyMonToWeekdays = () => {
    const mon = profile.workingHours.mon;
    if (!mon) return;
    setProfile((p) => ({
      ...p,
      workingHours: {
        ...p.workingHours,
        tue: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        wed: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        thu: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        fri: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
      },
    }));
  };
  const applyMonToAll = () => {
    const mon = profile.workingHours.mon;
    if (!mon) return;
    setProfile((p) => ({
      ...p,
      workingHours: {
        mon: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        tue: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        wed: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        thu: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        fri: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        sat: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
        sun: [...mon] as import("@/hooks/useConversationEngine").DayWindow,
      },
    }));
  };

  return (
    <div className="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-sm font-semibold text-foreground">{t("onboarding.weeklyAvailability", { defaultValue: "Weekly availability" })}</p>
            <p className="text-[11px] text-muted-foreground">{t("onboarding.weeklyAvailabilityHint", { defaultValue: "Toggle each day on/off and pick start/end times." })}</p>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={applyMonToWeekdays}
              disabled={!profile.workingHours.mon}
              className="text-[10px] font-semibold px-2 py-1 rounded-md border border-border bg-background hover:bg-muted disabled:opacity-40"
            >
              {t("onboarding.monToWeekdays", { defaultValue: "Mon → Weekdays" })}
            </button>
            <button
              type="button"
              onClick={applyMonToAll}
              disabled={!profile.workingHours.mon}
              className="text-[10px] font-semibold px-2 py-1 rounded-md border border-border bg-background hover:bg-muted disabled:opacity-40"
            >
              {t("onboarding.monToAll", { defaultValue: "Mon → All" })}
            </button>
          </div>
        </div>
        <div className="space-y-1">
          {DAY_LABELS.map(({ key, label, tKey }) => {
            const window = profile.workingHours[key];
            const off = window === null;
            const dayLabel = t(tKey, { defaultValue: label });
            return (
              <div key={key} className="flex items-center gap-2 rounded-lg bg-background border border-border px-2.5 py-1.5">
                <span className="w-9 text-xs font-semibold text-foreground shrink-0">{dayLabel}</span>
                <button
                  type="button"
                  onClick={() => setDay(key, off ? ["09:00", "19:00"] : null)}
                  role="switch"
                  aria-checked={!off}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    off ? "bg-muted" : "bg-success"
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${off ? "translate-x-0.5" : "translate-x-4"}`} />
                </button>
                {!off && window ? (
                  <div className="flex items-center gap-1.5 ml-auto">
                    <ThemedTimePicker
                      value={window[0]}
                      onChange={(v) => setDay(key, [v, window[1]])}
                      compact
                      ariaLabel={t("onboarding.dayOpensAt", { defaultValue: "{{day}} opens at", day: dayLabel })}
                    />
                    <span className="text-xs text-muted-foreground">–</span>
                    <ThemedTimePicker
                      value={window[1]}
                      onChange={(v) => setDay(key, [window[0], v])}
                      compact
                      ariaLabel={t("onboarding.dayClosesAt", { defaultValue: "{{day}} closes at", day: dayLabel })}
                    />
                  </div>
                ) : (
                  <span className="ml-auto text-[11px] text-muted-foreground">{t("onboarding.closed", { defaultValue: "Closed" })}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {mode === "service" && (
        <>
          <Field label={t("onboarding.fieldAppointmentDuration", { defaultValue: "Appointment duration" })} hint={t("onboarding.hintAppointmentDuration", { defaultValue: "How long one job typically takes. We'll use this with your hours to generate bookable slots." })}>
            <input
              type="text"
              value={profile.duration || ""}
              onChange={(e) => setProfile((p) => ({ ...p, duration: e.target.value }))}
              placeholder={t("onboarding.phAppointmentDuration", { defaultValue: "e.g. 1 hour, 30 min" })}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
            />
          </Field>
          <Field label={t("onboarding.fieldBufferJobs", { defaultValue: "Buffer between jobs (optional)" })} hint={t("onboarding.hintBufferJobs", { defaultValue: "Extra minutes between back-to-back bookings (travel, prep). Default 15." })}>
            <NumberField
              value={profile.bufferMinutes}
              onChange={(v) => setProfile((p) => ({ ...p, bufferMinutes: Math.max(0, Math.min(240, v)) }))}
              min={0}
              max={240}
            />
          </Field>
        </>
      )}

      {/* Transport drivers also need a buffer — the booking modal greys
          out cells within `bufferMinutes` of an existing booking so the
          driver isn't crowded back-to-back. Same numeric range/UI as
          services so the dashboard editor and onboarding agree. */}
      {mode === "transport" && (
        <Field label={t("onboarding.fieldBufferTrips", { defaultValue: "Buffer between trips (optional)" })} hint={t("onboarding.hintBufferTrips", { defaultValue: "Extra minutes between back-to-back trips for travel/rest. Default 15." })}>
          <NumberField
            value={profile.bufferMinutes}
            onChange={(v) => setProfile((p) => ({ ...p, bufferMinutes: Math.max(0, Math.min(240, v)) }))}
            min={0}
            max={240}
          />
        </Field>
      )}

      {/* Flexible-hours flag — informational only. It does NOT change the
          schedule above (slots still follow workingHours); it adds a
          "Flexible hours" tag to your listing so riders know they can
          message you to arrange times outside these hours. */}
      {mode === "transport" && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{t("onboarding.flexibleHours", { defaultValue: "Flexible with hours" })}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {t("onboarding.flexibleHoursHint", { defaultValue: "Shows a “Flexible hours” tag on your listing. Your weekly hours above stay the same — this just lets riders know they can message you to work out timing outside them after booking." })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setProfile((p) => ({ ...p, flexibleHours: !p.flexibleHours }))}
            role="switch"
            aria-checked={profile.flexibleHours}
            aria-label={t("onboarding.flexibleHours", { defaultValue: "Flexible with hours" })}
            className={`relative mt-0.5 inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
              profile.flexibleHours ? "bg-success" : "bg-muted"
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${profile.flexibleHours ? "translate-x-4" : "translate-x-0.5"}`} />
          </button>
        </div>
      )}
    </div>
  );
};

// ---------- Service time slots ----------

/** Parse a free-text duration string ("1 hour", "30 min", "2 hours", "half day")
 *  into minutes. Defaults to 60. */
function durationToMinutes(value: string): number {
  if (!value) return 60;
  const v = value.toLowerCase().trim();
  if (v.includes("half day")) return 240;
  if (v.includes("full day")) return 480;
  const hours = v.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|h\b)/);
  const mins = v.match(/(\d+)\s*(?:min|m\b)/);
  let total = 0;
  if (hours) total += Math.round(Number(hours[1]) * 60);
  if (mins) total += Number(mins[1]);
  if (!total) {
    const just = v.match(/^(\d+(?:\.\d+)?)/);
    if (just) total = Math.round(Number(just[1]) * 60);
  }
  return total > 0 ? total : 60;
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

const DAY_LABEL_FULL: Record<keyof import("@/hooks/useConversationEngine").WorkingHours, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

/** Generate "Day H:MM AM" slot labels from the working-hours grid + duration.
 *  Next slot starts after duration + buffer minutes, so providers get
 *  realistic spacing for prep/travel between bookings. The buffer affects
 *  spacing only — a slot is still emitted as long as start+duration fits in
 *  the day's window. */
function generateSlots(
  workingHours: import("@/hooks/useConversationEngine").WorkingHours,
  durationMin: number,
  bufferMin: number = 15,
): string[] {
  const slots: string[] = [];
  const days: Array<keyof import("@/hooks/useConversationEngine").WorkingHours> = ["mon","tue","wed","thu","fri","sat","sun"];
  const stride = durationMin + Math.max(0, bufferMin);
  for (const day of days) {
    const window = workingHours[day];
    if (!window) continue;
    const [start, end] = window;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    let cur = sh * 60 + sm;
    const stop = eh * 60 + em;
    while (cur + durationMin <= stop) {
      const h = Math.floor(cur / 60);
      const m = cur % 60;
      slots.push(`${DAY_LABEL_FULL[day]} ${formatTime(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`)}`);
      cur += stride;
    }
  }
  return slots;
}

const ServiceTimeSlotsEditor = ({
  profile, setProfile,
}: {
  profile: OnboardingProfile;
  setProfile: React.Dispatch<React.SetStateAction<OnboardingProfile>>;
}) => {
  const { t } = useLanguage();
  const durationMin = durationToMinutes(profile.duration);
  const bufferMin = typeof profile.bufferMinutes === "number" ? profile.bufferMinutes : 15;
  const generated = useMemo(
    () => generateSlots(profile.workingHours, durationMin, bufferMin),
    [profile.workingHours, durationMin, bufferMin],
  );
  const slots = profile.serviceTimeSlots.length > 0 ? profile.serviceTimeSlots : generated;
  const isCustom = profile.serviceTimeSlots.length > 0;

  const setSlots = (next: string[]) => setProfile((p) => ({ ...p, serviceTimeSlots: next }));
  const removeSlot = (s: string) => setSlots(slots.filter((x) => x !== s));
  const [addInput, setAddInput] = useState("");
  const addSlot = () => {
    const v = addInput.trim();
    if (!v) return;
    if (slots.includes(v)) { setAddInput(""); return; }
    setSlots([...slots, v]);
    setAddInput("");
  };

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const startEdit = (idx: number, current: string) => {
    setEditingIndex(idx);
    setEditingDraft(current);
  };
  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingDraft("");
  };
  const commitEdit = (idx: number) => {
    const v = editingDraft.trim();
    if (!v) { cancelEdit(); return; }
    // Edits always materialize a custom slot set (so changes survive a
    // hours/duration tweak that would otherwise regenerate).
    const base = isCustom ? slots : generated;
    const next = base.map((s, i) => (i === idx ? v : s));
    setSlots(next);
    cancelEdit();
  };
  const preview = slots.slice(0, 6);
  const extra = Math.max(0, slots.length - preview.length);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t("onboarding.bookableTimeSlots", { defaultValue: "Bookable time slots" })}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {isCustom
              ? t("onboarding.customSlotsCount", { defaultValue: "{{count}} custom slot(s).", count: slots.length })
              : t("onboarding.autoGeneratedSlots", { defaultValue: "Auto-generated from your hours and a {{min}}-minute job duration.", min: durationMin })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-[11px] font-bold text-primary hover:underline shrink-0"
        >
          {showAdvanced ? t("onboarding.hide", { defaultValue: "Hide" }) : t("onboarding.customizeSlots", { defaultValue: "Customize slots" })}
        </button>
      </div>

      {slots.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1.5">
          {t("onboarding.noSlotsHint", { defaultValue: "Set working hours and an appointment duration above to generate slots — or add them manually below." })}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {preview.map((s) => (
            <span key={s} className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-foreground">
              {s}
            </span>
          ))}
          {extra > 0 && !showAdvanced && (
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t("onboarding.plusMore", { defaultValue: "+{{count}} more", count: extra })}
            </span>
          )}
        </div>
      )}

      {showAdvanced && (
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold text-foreground">{t("onboarding.customizeSlots", { defaultValue: "Customize slots" })}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSlots(generated)}
                className="text-[10px] font-semibold px-2 py-1 rounded-md border border-border bg-background hover:bg-muted"
              >
                {t("onboarding.regenerateFromHours", { defaultValue: "Regenerate from hours" })}
              </button>
              {isCustom && (
                <button
                  type="button"
                  onClick={() => setSlots([])}
                  className="text-[10px] font-semibold px-2 py-1 rounded-md border border-border bg-background hover:bg-muted"
                >
                  {t("onboarding.resetToAuto", { defaultValue: "Reset to auto" })}
                </button>
              )}
            </div>
          </div>
          {slots.length > 0 && (
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
              {slots.map((s, idx) => {
                const isEditing = editingIndex === idx;
                if (isEditing) {
                  return (
                    <span key={`edit-${idx}`} className="inline-flex items-center gap-1 rounded-full border border-primary bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                      <input
                        autoFocus
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitEdit(idx); }
                          if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                        }}
                        className="w-28 px-1.5 py-0.5 text-[11px] rounded border border-border bg-background outline-none focus:ring-2 focus:ring-primary/20"
                      />
                      <button type="button" onClick={() => commitEdit(idx)} className="text-primary font-bold" aria-label={t("onboarding.saveSlot", { defaultValue: "Save slot" })}>✓</button>
                      <button type="button" onClick={cancelEdit} className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70" aria-label={t("onboarding.cancelEdit", { defaultValue: "Cancel edit" })}>×</button>
                    </span>
                  );
                }
                return (
                  <span key={`${s}-${idx}`} className="group inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-foreground">
                    <button
                      type="button"
                      onClick={() => startEdit(idx, s)}
                      className="hover:underline"
                      title={t("onboarding.clickToEdit", { defaultValue: "Click to edit" })}
                    >
                      {s}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // Removing from auto-generated set materializes it as a custom override
                        // so the user's deletion sticks.
                        setSlots(slots.filter((_, i) => i !== idx));
                      }}
                      className="ml-0.5 text-muted-foreground hover:text-destructive"
                      aria-label={t("onboarding.removeItem", { defaultValue: "Remove {{item}}", item: s })}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSlot(); } }}
              placeholder={t("onboarding.phSlotExample", { defaultValue: "e.g. Sat 11:00 AM" })}
              className="flex-1 px-3 py-1.5 border border-border rounded-md text-xs bg-background outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={addSlot}
              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90"
            >
              {t("onboarding.add", { defaultValue: "Add" })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------- Hotel rooms (hotel/lodge/heritage) ----------

/**
 * Each row is one room TYPE (e.g. "Deluxe King"). The host says how many
 * physical rooms of this type they have, and optionally lists the room
 * numbers/labels for each one. Fields are now properly labelled instead
 * of relying on placeholder text — this was the main UX gripe with the
 * previous editor.
 *
 * Per-type structure:
 *   Identity:  Name + Description
 *   Layout:    Bedrooms / Bathrooms / Sleeps   (per ONE room of this type)
 *   Pricing:   ₹/night
 *   Inventory: # rooms + optional room IDs (chips, with auto-fill helper)
 *   Photos:    horizontal gallery
 */
const RoomTypesEditor = ({
  pendingRooms, setPendingRooms, uploadPhotoToStorage, uploadingRoomPhotoFor, setUploadingRoomPhotoFor,
}: {
  pendingRooms: PendingRoom[];
  setPendingRooms: React.Dispatch<React.SetStateAction<PendingRoom[]>>;
  uploadPhotoToStorage: (file: File) => Promise<string>;
  uploadingRoomPhotoFor: string | null;
  setUploadingRoomPhotoFor: (v: string | null) => void;
}) => {
  const { t } = useLanguage();
  const updateRoom = (key: string, patch: Partial<PendingRoom>) =>
    setPendingRooms((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRoom = (key: string) =>
    setPendingRooms((prev) => prev.filter((r) => r.key !== key));

  return (
    <div className="space-y-4">
      {pendingRooms.length === 0 && (
        <div className="text-center py-6 border-2 border-dashed border-border rounded-xl text-xs text-muted-foreground">
          <Bed className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
          {t("onboarding.addOneRoomTypeShort", { defaultValue: "Add at least one room type so guests can book." })}
        </div>
      )}

      {pendingRooms.map((room, roomIdx) => (
        <div key={room.key} className="bg-muted/30 rounded-2xl border border-border p-4 space-y-4">
          {/* Header: name + delete */}
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0">
              {roomIdx + 1}
            </span>
            <div className="flex-1 min-w-0">
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block">
                {t("onboarding.roomTypeName", { defaultValue: "Room type name" })}
              </label>
              <input
                value={room.name}
                onChange={(e) => updateRoom(room.key, { name: e.target.value })}
                placeholder={t("onboarding.phRoomTypeName", { defaultValue: "e.g. Deluxe King, Family Suite" })}
                className="w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 mt-0.5"
              />
            </div>
            <Button type="button" size="icon" variant="ghost"
              className="rounded-full h-8 w-8 text-destructive hover:text-destructive shrink-0 self-end"
              onClick={() => removeRoom(room.key)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>

          {/* Layout (per-room) — bedrooms, bathrooms, sleeps */}
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block mb-1.5">
              {t("onboarding.layoutPerRoom", { defaultValue: "Layout (per room)" })}
            </label>
            <div className="grid grid-cols-3 gap-2">
              <SmallNumberField
                label={t("onboarding.fieldBedrooms", { defaultValue: "Bedrooms" })}
                value={room.bedrooms}
                onChange={(v) => updateRoom(room.key, { bedrooms: v })}
              />
              <SmallNumberField
                label={t("onboarding.fieldBathrooms", { defaultValue: "Bathrooms" })}
                value={room.bathrooms}
                onChange={(v) => updateRoom(room.key, { bathrooms: v })}
              />
              <SmallNumberField
                label={t("onboarding.sleeps", { defaultValue: "Sleeps" })}
                value={room.maxGuests}
                onChange={(v) => updateRoom(room.key, { maxGuests: v })}
              />
            </div>
          </div>

          {/* Pricing + inventory count */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block mb-1">
                {t("onboarding.pricePerNightLabel", { defaultValue: "Price (₹/night)" })}
              </label>
              <input
                type="number"
                value={room.pricePerNight}
                onChange={(e) => updateRoom(room.key, { pricePerNight: e.target.value })}
                placeholder="5000"
                className="w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block mb-1">
                {t("onboarding.numberOfRooms", { defaultValue: "# of rooms" })}
              </label>
              <RoomQuantityInput
                quantity={room.quantity}
                onQuantityChange={(next) => {
                  // Only trim unit identifiers when the host COMMITS a
                  // smaller positive quantity. Transient empty / zero
                  // edits while typing (e.g. clearing "8" before typing
                  // "12") would otherwise wipe every identifier the host
                  // carefully labelled. The buffered input snaps to 1
                  // on blur, so a real shrink still flows through here
                  // with a positive `next`.
                  const shouldTrim = next > 0 && next < room.unitIdentifiers.length;
                  updateRoom(room.key, {
                    quantity: next,
                    ...(shouldTrim ? { unitIdentifiers: room.unitIdentifiers.slice(0, next) } : {}),
                  });
                }}
              />
            </div>
          </div>

          {/* Optional room identifiers — chips + auto-fill helper */}
          <RoomIdentifiers
            quantity={room.quantity}
            identifiers={room.unitIdentifiers}
            onChange={(ids) => updateRoom(room.key, { unitIdentifiers: ids })}
          />

          {/* Description */}
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block mb-1">
              {t("onboarding.descriptionOptional", { defaultValue: "Description (optional)" })}
            </label>
            <textarea
              value={room.description}
              onChange={(e) => updateRoom(room.key, { description: e.target.value })}
              placeholder={t("onboarding.phRoomDescription", { defaultValue: "What's special about this room? (view, size, balcony, etc.)" })}
              rows={2}
              className="w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-background resize-none outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* Per-room amenities. Each room class can carry its own set — a
              "Deluxe King" might include AC + minibar + balcony while a
              "Standard Twin" only has AC. The consumer filter unions all
              rooms' amenities so chip queries match if ANY room advertises
              the amenity. */}
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block mb-1.5">
              {t("onboarding.amenitiesPerRoom", { defaultValue: "Amenities (per room)" })}
            </label>
            <RoomAmenitiesPicker
              amenities={room.amenities}
              onChange={(amenities) => updateRoom(room.key, { amenities })}
            />
          </div>

          {/* Photos */}
          <div>
            <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block mb-1.5">
              {t("onboarding.fieldPhotos", { defaultValue: "Photos" })}
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {room.photos.map((url, i) => (
                <div key={i} className="relative w-14 h-14 rounded-lg overflow-hidden border border-border group">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => updateRoom(room.key, { photos: room.photos.filter((_, j) => j !== i) })}
                    className="absolute top-0.5 right-0.5 p-0.5 bg-black/60 text-white rounded-full"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
              <label className="w-14 h-14 rounded-lg border-2 border-dashed border-border hover:border-primary/50 flex items-center justify-center text-muted-foreground hover:text-primary cursor-pointer">
                {uploadingRoomPhotoFor === room.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploadingRoomPhotoFor(room.key);
                    try {
                      const url = await uploadPhotoToStorage(file);
                      updateRoom(room.key, { photos: [...room.photos, url] });
                    } catch (err: unknown) {
                      toast.error(errorMessage(err, t("onboarding.photoUploadFailed", { defaultValue: "Photo upload failed" })));
                    } finally {
                      setUploadingRoomPhotoFor(null);
                      e.target.value = "";
                    }
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        className="w-full rounded-xl"
        onClick={() =>
          setPendingRooms((prev) => [
            ...prev,
            {
              key: `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: "",
              description: "",
              pricePerNight: "",
              maxGuests: 2,
              quantity: 1,
              bedrooms: 1,
              bathrooms: 1,
              unitIdentifiers: [],
              amenities: [],
              photos: [],
            },
          ])
        }
      >
        <Plus className="w-4 h-4 mr-1" /> {t("onboarding.addRoomType", { defaultValue: "Add room type" })}
      </Button>
    </div>
  );
};

/** Compact labelled number input for dense per-room layout grids. Keeps
 *  vertical rhythm tight inside the room card without sacrificing the
 *  label-on-top pattern we use everywhere else in the form. */
const SmallNumberField = ({
  label, value, onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) => (
  <div>
    <label className="text-[10px] font-medium text-muted-foreground block mb-1">{label}</label>
    <input
      type="number"
      min={0}
      value={value || ""}
      onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
      className="w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
    />
  </div>
);

/**
 * Optional per-room identifier list. Real hotels use varying schemes:
 * "101..108" floor-numbered, "8a/8b/8c" letter-suffixed, "Tulip/Rose/
 * Jasmine" themed. We support all three by letting hosts add free-form
 * identifier strings as chips.
 *
 * The auto-fill helper handles the most common case (sequential numbers
 * starting from any integer): host enters "101" and clicks "Auto-fill 8"
 * → ["101","102","103","104","105","106","107","108"]. Falls through
 * cleanly if the start is non-numeric — the input just acts as a single
 * manual add.
 *
 * Identifiers are de-duplicated case-insensitively at the server level
 * too, so "8A" and "8a" can't both end up on a listing.
 */
/**
 * Per-room-type quantity input. Mirrors NumberField's buffer pattern so
 * the user can clear / replace the default naturally — the previous
 * `Math.max(1, Number(e.target.value) || 1)` clamp meant typing one
 * digit (e.g. backspace-then-"5") snapped back to 1 mid-keystroke.
 *
 * Snap-to-1 happens on blur only: an empty / zero / invalid quantity
 * normalizes to 1 so the room row stays publishable. The parent gets
 * a number (`0` while typing, the validated value on blur) and decides
 * whether to trim `unitIdentifiers`.
 */
const RoomQuantityInput = ({
  quantity, onQuantityChange,
}: {
  quantity: number;
  onQuantityChange: (next: number) => void;
}) => {
  const [text, setText] = useState<string>(quantity > 0 ? String(quantity) : "");
  const lastEmittedRef = useRef<number>(quantity);
  useEffect(() => {
    if (quantity !== lastEmittedRef.current) {
      setText(quantity > 0 ? String(quantity) : "");
      lastEmittedRef.current = quantity;
    }
  }, [quantity]);
  return (
    <input
      type="number"
      min={1}
      value={text}
      placeholder="8"
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === "") {
          lastEmittedRef.current = 0;
          onQuantityChange(0);
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) {
          lastEmittedRef.current = n;
          onQuantityChange(n);
        }
      }}
      onBlur={() => {
        // Snap empty / zero / non-positive to 1 so the row stays
        // publishable. Mid-typing this never fires.
        const n = Number(text);
        if (!Number.isFinite(n) || n <= 0) {
          setText("1");
          lastEmittedRef.current = 1;
          onQuantityChange(1);
        }
      }}
      className="w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
    />
  );
};

const RoomIdentifiers = ({
  quantity, identifiers, onChange,
}: {
  quantity: number;
  identifiers: string[];
  onChange: (next: string[]) => void;
}) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState("");

  const addOne = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (identifiers.some((x) => x.toLowerCase() === trimmed.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...identifiers, trimmed]);
    setDraft("");
  };

  const autoFillFromDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // Try to parse a leading integer ("101", "8001"). If the whole token
    // is numeric, auto-fill quantity-many sequential numbers starting
    // there. If parsing fails, fall back to single-add so the host can
    // hand-enter "8a" / "Tulip" without a confusing error.
    const asInt = Number(trimmed);
    if (Number.isInteger(asInt) && String(asInt) === trimmed && quantity > 0) {
      const remaining = quantity - identifiers.length;
      if (remaining <= 0) return;
      const generated: string[] = [];
      const have = new Set(identifiers.map((x) => x.toLowerCase()));
      let n = asInt;
      while (generated.length < remaining) {
        const id = String(n);
        if (!have.has(id.toLowerCase())) {
          generated.push(id);
          have.add(id.toLowerCase());
        }
        n += 1;
      }
      onChange([...identifiers, ...generated]);
      setDraft("");
      return;
    }
    addOne();
  };

  const removeAt = (idx: number) => onChange(identifiers.filter((_, i) => i !== idx));

  // Flag count mismatches as a soft warning rather than an error — some
  // hosts genuinely don't number all their rooms, and we shouldn't gate
  // submit on this. Just inform them.
  const mismatch = identifiers.length > 0 && identifiers.length !== quantity;

  return (
    <div>
      <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground block mb-1.5">
        {t("onboarding.roomIds", { defaultValue: "Room IDs" })} <span className="text-[10px] normal-case font-normal text-muted-foreground/80">{t("onboarding.roomIdsHint", { defaultValue: "— optional, e.g. 101–108 or 8a/8b/8c" })}</span>
      </label>

      {identifiers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {identifiers.map((id, i) => (
            <span
              key={`${id}-${i}`}
              className="px-2 py-0.5 rounded-md text-xs font-medium bg-primary/10 text-primary border border-primary/20 flex items-center gap-1"
            >
              {id}
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={t("onboarding.removeRoom", { defaultValue: "Remove room {{id}}", id })}
                className="hover:text-destructive"
              >
                <X className="w-2.5 h-2.5" />
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
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOne(); } }}
          placeholder={t("onboarding.phRoomId", { defaultValue: "e.g. 101, 8a, Tulip" })}
          className="flex-1 px-2 py-1.5 border border-border rounded-lg text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
        />
        <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={addOne} disabled={!draft.trim()}>
          {t("onboarding.add", { defaultValue: "Add" })}
        </Button>
        {/* Auto-fill only makes sense when the draft parses to an integer
            AND there's room left under the quantity cap. Showing the
            button always (with disabled state) keeps the UI predictable. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-lg"
          onClick={autoFillFromDraft}
          disabled={!draft.trim() || identifiers.length >= quantity || !/^\d+$/.test(draft.trim())}
          title={t("onboarding.autoFillTitle", { defaultValue: "If you enter a starting number like 101, fills sequential IDs up to the room count" })}
        >
          {t("onboarding.autoFill", { defaultValue: "Auto-fill {{count}}", count: Math.max(0, quantity - identifiers.length) })}
        </Button>
      </div>

      {mismatch && (
        <p className="text-[11px] text-muted-foreground mt-1.5">
          {t("onboarding.roomIdMismatch", { defaultValue: "{{ids}} ID(s) for {{rooms}} room(s) — that's fine, leave blank for any unnumbered ones.", ids: identifiers.length, rooms: quantity })}
        </p>
      )}
    </div>
  );
};

export default OnboardingForm;
