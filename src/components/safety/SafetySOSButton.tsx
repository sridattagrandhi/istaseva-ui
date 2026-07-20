import { useState } from "react";
import { Phone, X, Shield, MapPin, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { getSafetyService } from "@/domains";
import { useLanguage } from "@/contexts/LanguageContext";

interface SafetySOSButtonProps {
  bookingId?: string;
}

const SafetySOSButton = ({ bookingId }: SafetySOSButtonProps) => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [triggered, setTriggered] = useState(false);
  const [holdTimer, setHoldTimer] = useState<NodeJS.Timeout | null>(null);
  const [holding, setHolding] = useState(false);

  const triggerSOS = async (alertType: string, description?: string) => {
    if (!user) {
      toast.error(t("safety.loginRequired", { defaultValue: "Please log in to use safety features" }));
      return;
    }

    let lat: number | undefined;
    let lng: number | undefined;

    // Try to get current location
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
      );
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    } catch {
      // Location not available — proceed without it
    }

    try {
      const result = await getSafetyService().createAlert({
        userId: user.id,
        bookingId,
        alertType,
        description,
        locationLat: lat,
        locationLng: lng,
      });

      if (!result.success) {
        throw new Error(result.error || t("safety.failedSendAlert", { defaultValue: "Failed to send alert" }));
      }

      setTriggered(true);
      toast.success(t("safety.alertSentToast", { defaultValue: "Emergency alert sent! Your emergency contacts have been notified." }), { duration: 8000 });
    } catch (err) {
      console.error("SOS error:", err);
      toast.error(t("safety.failedSendAlertCall", { defaultValue: "Failed to send alert. Please call emergency services directly." }));
    }
  };

  const handleHoldStart = () => {
    setHolding(true);
    const timer = setTimeout(() => {
      triggerSOS("sos", "SOS triggered via hold button");
      setHolding(false);
    }, 2000);
    setHoldTimer(timer);
  };

  const handleHoldEnd = () => {
    setHolding(false);
    if (holdTimer) {
      clearTimeout(holdTimer);
      setHoldTimer(null);
    }
  };

  if (triggered) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <div className="bg-destructive text-destructive-foreground rounded-2xl p-4 shadow-2xl max-w-xs animate-scale-in">
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-5 h-5" />
            <span className="font-display font-bold text-sm">{t("safety.alertSent", { defaultValue: "Alert Sent" })}</span>
          </div>
          <p className="text-xs opacity-90">{t("safety.alertSentDesc", { defaultValue: "Your emergency contacts have been notified with your location. Stay in a safe place." })}</p>
          <div className="mt-3 flex gap-2">
            <a href="tel:112" className="flex-1">
              <Button size="sm" variant="secondary" className="w-full rounded-xl text-xs">
                <Phone className="w-3 h-3 mr-1" /> {t("safety.call112", { defaultValue: "Call 112" })}
              </Button>
            </a>
            <Button size="sm" variant="secondary" className="rounded-xl text-xs" onClick={() => { setTriggered(false); setExpanded(false); }}>
              {t("safety.dismiss", { defaultValue: "Dismiss" })}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {expanded && (
        <div className="mb-3 bg-card border border-border rounded-2xl shadow-2xl p-4 w-64 animate-scale-in">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-display font-bold text-sm flex items-center gap-1.5">
              <Shield className="w-4 h-4 text-destructive" /> {t("safety.safetyOptions", { defaultValue: "Safety Options" })}
            </h4>
            <button onClick={() => setExpanded(false)} className="p-1 hover:bg-muted rounded-lg">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-2">
            <button
              className="w-full text-left p-3 rounded-xl border border-destructive/20 bg-destructive/5 hover:bg-destructive/10 transition-colors"
              onMouseDown={handleHoldStart}
              onMouseUp={handleHoldEnd}
              onMouseLeave={handleHoldEnd}
              onTouchStart={handleHoldStart}
              onTouchEnd={handleHoldEnd}
            >
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-destructive" />
                <div>
                  <p className="text-xs font-semibold text-destructive">{t("safety.emergencySos", { defaultValue: "Emergency SOS" })}</p>
                  <p className="text-[10px] text-muted-foreground">{holding ? t("safety.keepHolding", { defaultValue: "Keep holding..." }) : t("safety.holdForSeconds", { defaultValue: "Hold for 2 seconds" })}</p>
                </div>
              </div>
              {holding && (
                <div className="mt-2 h-1 bg-destructive/20 rounded-full overflow-hidden">
                  <div className="h-full bg-destructive rounded-full animate-[fillBar_2s_linear]" />
                </div>
              )}
            </button>

            <button
              className="w-full text-left p-3 rounded-xl border border-border hover:bg-muted/50 transition-colors"
              onClick={() => triggerSOS("unsafe_feeling", "User reported feeling unsafe")}
            >
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-yellow-600" />
                <div>
                  <p className="text-xs font-semibold">{t("safety.feelUnsafe", { defaultValue: "I feel unsafe" })}</p>
                  <p className="text-[10px] text-muted-foreground">{t("safety.alertSafetyTeam", { defaultValue: "Alert our safety team" })}</p>
                </div>
              </div>
            </button>

            <button
              className="w-full text-left p-3 rounded-xl border border-border hover:bg-muted/50 transition-colors"
              onClick={() => triggerSOS("harassment", "Harassment reported")}
            >
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-orange-600" />
                <div>
                  <p className="text-xs font-semibold">{t("safety.reportHarassment", { defaultValue: "Report harassment" })}</p>
                  <p className="text-[10px] text-muted-foreground">{t("safety.investigateImmediately", { defaultValue: "We'll investigate immediately" })}</p>
                </div>
              </div>
            </button>

            <a href="tel:112" className="block w-full text-left p-3 rounded-xl border border-border hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-primary" />
                <div>
                  <p className="text-xs font-semibold">{t("safety.callEmergency112", { defaultValue: "Call Emergency (112)" })}</p>
                  <p className="text-[10px] text-muted-foreground">{t("safety.directDialPolice", { defaultValue: "Direct dial to police" })}</p>
                </div>
              </div>
            </a>
          </div>

          <p className="text-[9px] text-muted-foreground mt-3 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> {t("safety.locationShared", { defaultValue: "Your location will be shared with emergency contacts" })}
          </p>
        </div>
      )}

      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200 ${
          expanded
            ? "bg-muted text-foreground scale-90"
            : "bg-destructive text-destructive-foreground hover:scale-110 animate-pulse"
        }`}
        aria-label={t("safety.safetySosAria", { defaultValue: "Safety SOS" })}
      >
        {expanded ? <X className="w-6 h-6" /> : <Shield className="w-6 h-6" />}
      </button>
    </div>
  );
};

export default SafetySOSButton;
