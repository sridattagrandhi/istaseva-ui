import { Button } from "@/components/ui/button";
import { Heart, MapPin, Star } from "lucide-react";
import { useSaved } from "@/contexts/SavedContext";

/** Normalise a hit's `type` into one of the three wishlist buckets. Stay
 *  listings carry many property types (hotel/homestay/lodge/…), so stay is the
 *  default once transport and service are ruled out. */
function savedBucket(type: string): "stay" | "service" | "transport" {
  const t = (type || "").toLowerCase();
  if (/transport|driver|cab|auto|taxi|vehicle|tempo|bike/.test(t)) return "transport";
  if (t === "service") return "service";
  if (/stay|hotel|homestay|lodge|villa|resort|guesthouse|guest house|heritage|sathram|farm|hostel|apartment|room|cottage|bungalow|village/.test(t)) return "stay";
  return "service";
}

export interface InlineListingHit {
  id: string;
  title: string;
  /** stay | service | transport — drives which detail route to open. */
  type: string;
  location?: string;
  /** Pre-formatted (e.g. "₹2,500/night"). The server-side tool already
   *  formatted it for the model, so we reuse the same string. */
  price?: string;
  rating?: number;
  image?: string;
}

interface Props {
  hits: InlineListingHit[];
  /** Fired when the user taps "Open" on a card. */
  onOpen: (hit: InlineListingHit) => void;
  /** Fired when the user taps "Book" — the AssistantWidget routes this to
   *  prepare_booking (stays) or the listing detail page (services/transport). */
  onBook: (hit: InlineListingHit) => void;
}

/**
 * Inline listing cards rendered inside the chat bubble.
 *
 * The agent emits `show_listing_cards` action; AssistantWidget attaches
 * the hits to the current assistant message and we render this strip.
 * Mobile-first horizontal scroll keeps the chat compact — the user can
 * still tap "Open" to see the full detail page.
 */
export function ListingCardsInline({ hits, onOpen, onBook }: Props) {
  const {
    isStaySaved, isServiceSaved, isTransportSaved,
    toggleSaveStay, toggleSaveService, toggleSaveTransport,
  } = useSaved();
  if (!hits.length) return null;
  const isSaved = (bucket: "stay" | "service" | "transport", id: string) =>
    bucket === "stay" ? isStaySaved(id) : bucket === "transport" ? isTransportSaved(id) : isServiceSaved(id);
  const toggleSaved = (bucket: "stay" | "service" | "transport", id: string) =>
    bucket === "stay" ? toggleSaveStay(id) : bucket === "transport" ? toggleSaveTransport(id) : toggleSaveService(id);
  return (
    <div className="mt-2 -mx-1 flex gap-2 overflow-x-auto pb-1 snap-x">
      {hits.map((hit) => {
        const bucket = savedBucket(hit.type);
        const saved = isSaved(bucket, hit.id);
        return (
        <div
          key={hit.id}
          className="relative snap-start shrink-0 w-56 rounded-xl border border-border/60 bg-card overflow-hidden shadow-sm"
        >
          <button
            type="button"
            aria-label={saved ? "Remove from saved" : "Save listing"}
            aria-pressed={saved}
            onClick={(e) => { e.stopPropagation(); toggleSaved(bucket, hit.id); }}
            className="absolute top-1.5 right-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-background/80 backdrop-blur shadow-sm transition hover:bg-background"
          >
            <Heart className={`w-3.5 h-3.5 ${saved ? "fill-rose-500 text-rose-500" : "text-muted-foreground"}`} />
          </button>
          <div className="h-24 w-full bg-muted overflow-hidden">
            {hit.image ? (
              <img
                src={hit.image}
                alt={hit.title}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-3xl text-muted-foreground">
                {hit.type === "stay" ? "🏨" : hit.type === "transport" ? "🚗" : "🛠️"}
              </div>
            )}
          </div>
          <div className="p-3 space-y-1.5">
            <h4 className="text-sm font-semibold line-clamp-1">{hit.title}</h4>
            {hit.location && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1 line-clamp-1">
                <MapPin className="w-3 h-3" />
                <span className="truncate">{hit.location}</span>
              </p>
            )}
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{hit.price ?? ""}</span>
              {typeof hit.rating === "number" && hit.rating > 0 && (
                <span className="flex items-center gap-0.5 text-amber-600">
                  <Star className="w-3 h-3 fill-current" /> {hit.rating.toFixed(1)}
                </span>
              )}
            </div>
            <div className="flex gap-1.5 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="flex-1 h-7 text-[11px]"
                onClick={() => onOpen(hit)}
              >
                Open
              </Button>
              <Button
                size="sm"
                className="flex-1 h-7 text-[11px]"
                onClick={() => onBook(hit)}
              >
                Book
              </Button>
            </div>
          </div>
        </div>
        );
      })}
    </div>
  );
}
