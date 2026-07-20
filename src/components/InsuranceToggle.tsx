import { Shield } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

interface InsuranceToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  premium: number;
  label?: string;
}

const InsuranceToggle = ({ enabled, onToggle, premium, label }: InsuranceToggleProps) => {
  const { t } = useLanguage();
  return (
    <div
      onClick={() => onToggle(!enabled)}
      className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200 ${
        enabled
          ? "bg-primary/5 border-primary/30"
          : "bg-muted/30 border-border hover:border-primary/20"
      }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
        enabled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
      }`}>
        <Shield className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">{label || t("insuranceToggle.title", { defaultValue: "Add Protection" })}</p>
        <p className="text-xs text-muted-foreground">{t("insuranceToggle.desc", { defaultValue: "Covers damage & service issues" })}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-bold text-primary">+₹{premium}</p>
        <div className={`w-9 h-5 rounded-full transition-colors relative ${enabled ? "bg-primary" : "bg-muted-foreground/30"}`}>
          <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${enabled ? "translate-x-4" : "translate-x-0"}`} />
        </div>
      </div>
    </div>
  );
};

export default InsuranceToggle;
