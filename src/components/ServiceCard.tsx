import { Link } from "react-router-dom";
import { Star, Clock, MapPin, Sparkles, Zap, Wrench, Fan, Bath, Home, Hammer, Building, Siren, BadgeCheck, ShieldCheck, Globe, ShieldAlert, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useSaved } from "@/contexts/SavedContext";
import type { Service } from "@/types/listings";
import { getServiceGuarantee } from "@/utils/serviceGuarantee";
import { toast } from "sonner";
import { useNavigate, useLocation } from "react-router-dom";

const iconMap: Record<string, React.ReactNode> = {
  sparkles: <Sparkles className="w-5 h-5" />, zap: <Zap className="w-5 h-5" />, wrench: <Wrench className="w-5 h-5" />,
  fan: <Fan className="w-5 h-5" />, bath: <Bath className="w-5 h-5" />, home: <Home className="w-5 h-5" />,
  hammer: <Hammer className="w-5 h-5" />, building: <Building className="w-5 h-5" />, siren: <Siren className="w-5 h-5" />,
};

const ServiceCard = ({ service }: { service: Service }) => {
  const { t } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { isServiceSaved, toggleSaveService } = useSaved();
  const navigate = useNavigate();
  const location = useLocation();
  const saved = isServiceSaved(service.id);
  const isTopRated = service.rating >= 4.6;
  const guarantee = getServiceGuarantee(service.category, service.subcategory);

  return (
    <div className="group block relative">
      <button
        onClick={(e) => {
          e.preventDefault();
          if (!isAuthenticated) {
            toast.error(t("card.signInToSave"));
            navigate(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`);
            return;
          }
          toggleSaveService(service.id);
        }}
        className="absolute top-3 right-3 z-10 p-2 bg-card/80 backdrop-blur-sm rounded-full hover:bg-card transition-all shadow-sm"
      >
        <Heart className={`w-4 h-4 transition-colors ${saved ? "fill-destructive text-destructive" : "text-muted-foreground"}`} />
      </button>
      <Link to={`/service/${service.id}`} className="group block">
      <div className="bg-card rounded-2xl border border-border/60 premium-shadow hover:premium-shadow-hover transition-all duration-500 hover:-translate-y-1.5 p-5 sm:p-6 space-y-4 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-primary/5 to-transparent rounded-bl-full" />
        <div className="flex items-start justify-between relative">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 text-primary flex items-center justify-center border border-primary/10 group-hover:from-primary group-hover:to-primary/80 group-hover:text-primary-foreground transition-all duration-300">
            {iconMap[service.icon] || <Sparkles className="w-5 h-5" />}
          </div>
          <div className="flex flex-col items-end gap-1.5 mr-10">
            <div className="flex items-center gap-1">
              <Star className="w-3.5 h-3.5 fill-secondary text-secondary" />
              <span className="text-sm font-bold">{service.rating}</span>
              <span className="text-xs text-muted-foreground">({service.reviews})</span>
            </div>
            {isTopRated && (
              <span className="text-[10px] font-semibold text-secondary bg-secondary/10 px-2 py-0.5 rounded-full flex items-center gap-0.5">
                <BadgeCheck className="w-3 h-3" /> {t("card.topRated")}
              </span>
            )}
          </div>
        </div>

        <div>
          <h3 className="font-display font-bold text-foreground group-hover:text-primary transition-colors text-[15px]">{service.title}</h3>
          <p className="text-sm text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">{service.description}</p>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground min-w-0">
          <span className="flex items-center gap-1 whitespace-nowrap shrink-0"><Clock className="w-3.5 h-3.5 text-primary/50 shrink-0" />{service.duration}</span>
          <span className="flex items-center gap-1 min-w-0"><MapPin className="w-3.5 h-3.5 text-primary/50 shrink-0" /><span className="truncate">{service.area}</span></span>
        </div>

        <div className="flex items-center gap-2 text-xs flex-wrap">
          {service.provider.verified && (
            <span className="flex items-center gap-1 text-success font-medium bg-success/5 px-2 py-1 rounded-full border border-success/10">
              <ShieldCheck className="w-3 h-3" /> {t("card.verified")}
            </span>
          )}
          <span className={`font-medium px-2 py-1 rounded-full ${
            service.availability === "Available Today" || service.availability === "24/7 Available"
              ? "text-success bg-success/5 border border-success/10" : "text-muted-foreground bg-muted"
          }`}>{service.availability}</span>
          {service.provider.languages && service.provider.languages.length > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground bg-muted px-2 py-1 rounded-full">
              <Globe className="w-3 h-3" />{service.provider.languages[0]}
            </span>
          )}
          {guarantee && (
            <span className="flex items-center gap-1 text-primary font-medium bg-primary/5 px-2 py-1 rounded-full border border-primary/10">
              <ShieldAlert className="w-3 h-3" />{guarantee.label}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-border/50">
          <div>
            <span className="text-xs text-muted-foreground block">{t("startingFrom")}</span>
            <span className="text-xl font-extrabold text-foreground">₹{service.price}</span>
          </div>
          <Button
            size="sm"
            className="rounded-full text-xs font-semibold px-5 shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 transition-all"
            onClick={(event) => {
              if (isAuthenticated) return;
              event.preventDefault();
              toast.error(t("card.signInToBook"));
              navigate(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`);
            }}
          >
            {t("bookNow")}
          </Button>
        </div>
      </div>
    </Link>
    </div>
  );
};

export default ServiceCard;
