import { Link } from "react-router-dom";
import { MapPin, Star, Clock, ArrowRight, Navigation } from "lucide-react";
import { useLocation } from "@/contexts/LocationContext";

interface NearbyItem {
  id: string;
  title: string;
  type: "stay" | "service" | "transport";
  subtitle: string;
  price: string;
  rating: number;
  lat: number;
  lng: number;
  availability?: string;
  linkTo: string;
}

interface NearbySectionProps {
  title: string;
  subtitle?: string;
  items: NearbyItem[];
  maxItems?: number;
  viewAllLink?: string;
}

const NearbySection = ({ title, subtitle, items, maxItems = 4, viewAllLink }: NearbySectionProps) => {
  const { getDistanceKm } = useLocation();

  const sorted = [...items].sort((a, b) => getDistanceKm(a.lat, a.lng) - getDistanceKm(b.lat, b.lng)).slice(0, maxItems);

  if (sorted.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-display font-semibold text-lg flex items-center gap-2">
            <Navigation className="w-4 h-4 text-primary" /> {title}
          </h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {viewAllLink && (
          <Link to={viewAllLink} className="text-xs text-primary font-medium hover:underline flex items-center gap-1">
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {sorted.map(item => {
          const dist = getDistanceKm(item.lat, item.lng);
          return (
            <Link key={item.id} to={item.linkTo} className="flex items-center gap-3 p-3 bg-card rounded-xl border border-border hover:shadow-md hover:border-primary/20 transition-all group">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold shrink-0 ${
                item.type === "stay" ? "bg-primary/10 text-primary" : item.type === "transport" ? "bg-accent/10 text-accent" : "bg-secondary/10 text-secondary"
              }`}>
                {item.type === "stay" ? "🏨" : item.type === "transport" ? "🚗" : "🔧"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate group-hover:text-primary transition-colors">{item.title}</p>
                <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5"><MapPin className="w-2.5 h-2.5" />{dist} km</span>
                  <span className="text-[10px] flex items-center gap-0.5"><Star className="w-2.5 h-2.5 fill-secondary text-secondary" />{item.rating}</span>
                  {item.availability && <span className="text-[10px] text-success font-medium">{item.availability}</span>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="font-bold text-sm">{item.price}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
};

export default NearbySection;
