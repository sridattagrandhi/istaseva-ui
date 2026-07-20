import { Link } from "react-router-dom";
import { Star, MapPin, Shield, BadgeCheck, Heart, Globe, Users } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useSaved } from "@/contexts/SavedContext";
import { useAuth } from "@/contexts/AuthContext";
import type { Stay } from "@/types/listings";
import { applyHostDiscount } from "@/utils/listingPricing";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";

const ListingCard = ({ stay }: { stay: Stay }) => {
  const { t } = useLanguage();
  const { isStaySaved, toggleSaveStay } = useSaved();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const saved = isStaySaved(stay.id);
  const pricing = applyHostDiscount(stay);

  const typeLabel = (type: string) => t(`listing.type.${type}`);

  return (
    <div className="group block relative">
      <button onClick={(e) => {
        e.preventDefault();
        if (!isAuthenticated) {
          toast.error(t("card.signInToSave"));
          navigate(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`);
          return;
        }
        toggleSaveStay(stay.id);
      }}
        className="absolute top-3 right-3 z-10 p-2 bg-card/80 backdrop-blur-sm rounded-full hover:bg-card transition-all shadow-sm">
        <Heart className={`w-4 h-4 transition-colors ${saved ? "fill-destructive text-destructive" : "text-muted-foreground"}`} />
      </button>
      <Link to={`/stay/${stay.id}`}>
        <div className="bg-card rounded-2xl overflow-hidden border border-border/60 premium-shadow hover:premium-shadow-hover transition-all duration-500 hover:-translate-y-1.5">
          <div className="relative h-52 sm:h-56 overflow-hidden">
            {stay.image ? (
              <img src={stay.image} alt={stay.title} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ease-out" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/10 to-primary/5 text-5xl">🏨</div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-foreground/30 via-transparent to-transparent" />
            <div className="absolute top-3 left-3 flex items-center gap-2">
              <span className="px-3 py-1 bg-primary/90 backdrop-blur-sm text-primary-foreground text-xs font-semibold rounded-full">{typeLabel(stay.type)}</span>
              {stay.verified && (
                <span className="px-2 py-1 bg-success/90 backdrop-blur-sm text-success-foreground text-xs font-medium rounded-full flex items-center gap-1">
                  <BadgeCheck className="w-3 h-3" /> {t("card.verified")}
                </span>
              )}
            </div>
            <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between">
              <div className="flex items-center gap-1 bg-card/95 backdrop-blur-sm px-2.5 py-1.5 rounded-lg">
                <Star className="w-3.5 h-3.5 fill-secondary text-secondary" />
                <span className="text-xs font-bold">{stay.rating}</span>
                <span className="text-xs text-muted-foreground">({stay.reviews})</span>
              </div>
              {stay.languages && stay.languages.length > 0 && (
                <div className="flex items-center gap-1 bg-card/95 backdrop-blur-sm px-2 py-1.5 rounded-lg">
                  <Globe className="w-3 h-3 text-primary/60" />
                  <span className="text-[10px] text-muted-foreground">{stay.languages.slice(0, 2).join(", ")}</span>
                </div>
              )}
            </div>
          </div>
          <div className="p-4 sm:p-5 space-y-2.5">
            <h3 className="font-display font-bold text-foreground group-hover:text-primary transition-colors line-clamp-1 text-[15px]">{stay.title}</h3>
            {(stay.guests > 0 || stay.rooms > 0) && (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground/80">
                <Users className="w-3 h-3" />
                <span>
                  {stay.rooms > 0
                    ? `${stay.guests} guests · ${stay.rooms} BR`
                    : `Sleeps ${stay.guests}`}
                </span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
              <MapPin className="w-3.5 h-3.5 text-primary/60" /><span>{stay.location}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {stay.tags.slice(0, 2).map(tag => (
                <span key={tag} className="px-2.5 py-0.5 bg-primary/5 text-primary/80 text-xs font-medium rounded-full border border-primary/10">{tag}</span>
              ))}
              {stay.verified && (
                <span className="px-2 py-0.5 bg-success/5 text-success text-xs font-medium rounded-full flex items-center gap-1 border border-success/10">
                  <Shield className="w-3 h-3" /> {t("card.trusted")}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between pt-3 border-t border-border/50">
              <div>
                {/* For hotels with multiple rooms show "From ₹X" using the cheapest room.
                    Single-price stays render the listing-level dynamic price as before. */}
                {(() => {
                  const fromRoomPaise = stay.roomTypes && stay.roomTypes.length > 0
                    ? Math.min(...stay.roomTypes.map((r) => r.basePricePaise))
                    : null;
                  const showFrom = fromRoomPaise != null;
                  const displayPrice = showFrom ? fromRoomPaise! / 100 : pricing.adjustedPrice;
                  return (
                    <>
                      <div className="flex items-baseline gap-1.5">
                        {showFrom && <span className="text-[10px] font-medium text-muted-foreground">{t("card.from", { defaultValue: "From" })}</span>}
                        <span className="text-xl font-extrabold text-foreground">₹{displayPrice.toLocaleString()}</span>
                        {!showFrom && pricing.savingsPercent && (
                          <span className="text-xs text-muted-foreground line-through">₹{pricing.originalPrice.toLocaleString()}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm text-muted-foreground">{t("perNight")}</span>
                        {!showFrom && pricing.savingsPercent && (
                          <span className="text-[10px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-full">{t("card.percentOff", { percent: pricing.savingsPercent })}</span>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
              <span className="text-xs font-semibold text-primary bg-primary/5 px-3 py-1.5 rounded-full group-hover:bg-primary group-hover:text-primary-foreground transition-all duration-300">
                {t("bookNow")} →
              </span>
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
};

export default ListingCard;
