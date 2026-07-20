import { useState } from "react";
import { X, Shield, Users, Camera, KeyRound, MapPin, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { getSafetyService } from "@/domains";
import { useLanguage } from "@/contexts/LanguageContext";

type TFn = (key: string, opts?: { defaultValue?: string; [k: string]: unknown }) => string;

interface SafetyCheck {
  type: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  severity: string;
  requiresResponse: boolean;
  responseType: "yes_no" | "photo" | "otp" | "confirm";
}

interface SafetyCheckModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
  bookingId?: string;
  serviceCategory: string;
  isProvider: boolean;
  providerGender?: string;
}

const getChecksForContext = (serviceCategory: string, isProvider: boolean, t: TFn): SafetyCheck[] => {
  const checks: SafetyCheck[] = [];

  if (isProvider) {
    // Provider visiting customer's location
    checks.push({
      type: "companion_present",
      label: t("safety.checkCompanionProviderLabel", { defaultValue: "Is someone else present?" }),
      description: t("safety.checkCompanionProviderDesc", { defaultValue: "For your safety, we recommend confirming if another person is present at the service location." }),
      icon: <Users className="w-5 h-5" />,
      severity: "high",
      requiresResponse: true,
      responseType: "yes_no",
    });
    checks.push({
      type: "location_share",
      label: t("safety.checkLocationShareLabel", { defaultValue: "Share live location" }),
      description: t("safety.checkLocationShareDesc", { defaultValue: "Your real-time location will be shared with your emergency contacts during the service." }),
      icon: <MapPin className="w-5 h-5" />,
      severity: "medium",
      requiresResponse: true,
      responseType: "confirm",
    });
  } else {
    // Customer booking a service
    checks.push({
      type: "identity_photo",
      label: t("safety.checkIdentityLabel", { defaultValue: "Verify provider identity" }),
      description: t("safety.checkIdentityDesc", { defaultValue: "Take a photo of the provider's ID badge when they arrive to verify their identity." }),
      icon: <Camera className="w-5 h-5" />,
      severity: "medium",
      requiresResponse: true,
      responseType: "confirm",
    });
    checks.push({
      type: "companion_present",
      label: t("safety.checkCompanionCustomerLabel", { defaultValue: "Will someone else be present?" }),
      description: t("safety.checkCompanionCustomerDesc", { defaultValue: "We recommend having another person present during the service for added safety." }),
      icon: <Users className="w-5 h-5" />,
      severity: "high",
      requiresResponse: true,
      responseType: "yes_no",
    });
  }

  // Common checks
  checks.push({
    type: "otp_verification",
    label: t("safety.checkOtpLabel", { defaultValue: "OTP verification at arrival" }),
    description: t("safety.checkOtpDesc", { defaultValue: "A one-time code will be shared between you and the other party to confirm the right person." }),
    icon: <KeyRound className="w-5 h-5" />,
    severity: "high",
    requiresResponse: true,
    responseType: "confirm",
  });

  return checks;
};

const SafetyCheckModal = ({ isOpen, onClose, onComplete, bookingId, serviceCategory, isProvider }: SafetyCheckModalProps) => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const checks = getChecksForContext(serviceCategory, isProvider, t);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const current = checks[currentIndex];
  const progress = ((currentIndex) / checks.length) * 100;

  const handleResponse = async (response: string) => {
    const newResponses = { ...responses, [current.type]: response };
    setResponses(newResponses);

    // Save to DB if we have a booking
    if (bookingId && user) {
      try {
        await getSafetyService().createCheck({
          bookingId,
          checkType: current.type,
          response,
          severity: current.severity,
        });
      } catch (err) {
        console.error("Failed to save safety check:", err);
      }
    }

    if (currentIndex < checks.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      setSaving(true);
      // Show warning if companion not present for high-severity scenarios
      const companionResponse = newResponses["companion_present"];
      if (companionResponse === "no") {
        toast.warning(t("safety.companionWarning", { defaultValue: "Safety tip: We recommend having someone else present during the service." }), { duration: 5000 });
      }
      toast.success(t("safety.checksCompleted", { defaultValue: "Safety checks completed! Stay safe." }));
      setSaving(false);
      onComplete();
    }
  };

  const handleSkip = () => {
    handleResponse("skipped");
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-md animate-scale-in">
        {/* Header */}
        <div className="p-5 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display font-bold text-sm">{t("safety.verificationTitle", { defaultValue: "Safety Verification" })}</h3>
              <p className="text-[10px] text-muted-foreground">{t("safety.stepOf", { defaultValue: "Step {{current}} of {{total}}", current: currentIndex + 1, total: checks.length })}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded-lg"><X className="w-5 h-5" /></button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-muted">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          <div className="text-center space-y-3">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto">
              {current.icon}
            </div>
            <h4 className="font-display font-bold text-lg">{current.label}</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">{current.description}</p>
          </div>

          {current.severity === "high" && (
            <div className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 rounded-xl text-xs text-yellow-800 dark:text-yellow-200">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{t("safety.recommendedMeasure", { defaultValue: "This is a recommended safety measure for your protection." })}</span>
            </div>
          )}

          {/* Response buttons */}
          <div className="space-y-2.5">
            {current.responseType === "yes_no" ? (
              <div className="flex gap-3">
                <Button
                  className="flex-1 rounded-xl h-12 font-semibold"
                  onClick={() => handleResponse("yes")}
                  disabled={saving}
                >
                  <CheckCircle2 className="w-4 h-4 mr-1.5" /> {t("safety.yes", { defaultValue: "Yes" })}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 rounded-xl h-12 font-semibold"
                  onClick={() => handleResponse("no")}
                  disabled={saving}
                >
                  {t("safety.no", { defaultValue: "No" })}
                </Button>
              </div>
            ) : current.responseType === "confirm" ? (
              <Button
                className="w-full rounded-xl h-12 font-semibold"
                onClick={() => handleResponse("confirmed")}
                disabled={saving}
              >
                <CheckCircle2 className="w-4 h-4 mr-1.5" /> {t("safety.enableContinue", { defaultValue: "Enable & Continue" })}
              </Button>
            ) : null}

            <button
              onClick={handleSkip}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
              disabled={saving}
            >
              {t("safety.skipStep", { defaultValue: "Skip this step" })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SafetyCheckModal;
