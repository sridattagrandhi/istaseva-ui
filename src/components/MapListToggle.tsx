import { Map, List } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

interface MapListToggleProps {
  view: "list" | "map";
  onToggle: (view: "list" | "map") => void;
}

const MapListToggle = ({ view, onToggle }: MapListToggleProps) => {
  const { t } = useLanguage();
  return (
    <div className="flex items-center bg-card border border-border rounded-xl p-1">
      <button
        onClick={() => onToggle("list")}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
          view === "list" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <List className="w-3.5 h-3.5" /> {t("toggle.list")}
      </button>
      <button
        onClick={() => onToggle("map")}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
          view === "map" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Map className="w-3.5 h-3.5" /> {t("toggle.map")}
      </button>
    </div>
  );
};

export default MapListToggle;
