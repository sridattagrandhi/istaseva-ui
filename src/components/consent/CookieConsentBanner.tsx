import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { getTrackingConsent, setTrackingConsent } from "@/lib/tracking-consent";

/**
 * Cookie / device-tracking consent banner (LEG-014).
 *
 * Shown once per device until the user makes a choice. Analytics (first-party
 * events + Mixpanel) stays OFF until "Allow analytics" is clicked — declining
 * (or ignoring) the banner keeps only essential storage. Copy deliberately
 * plain: what we'd store, why, and where to read more.
 */
const CookieConsentBanner = () => {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(getTrackingConsent() === "unset");
  }, []);

  if (!visible) return null;

  const choose = (granted: boolean) => {
    setTrackingConsent(granted);
    setVisible(false);
  };

  return (
    <div
      // A persistent, non-modal notice — a labelled landmark region, NOT a
      // role="dialog" (that implies a focus-trapping modal, and it also
      // collided with the app's real Filters dialog in the a11y tests).
      role="region"
      aria-label={t("cookieConsent.ariaLabel", { defaultValue: "Cookie and analytics preferences" })}
      className="fixed bottom-0 inset-x-0 z-50 p-3 sm:p-4"
    >
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-card shadow-lg p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
          <p className="text-sm text-muted-foreground flex-1">
            {t("cookieConsent.body", {
              defaultValue:
                "We use a device identifier to understand how IstaSeva is used and improve it. Nothing is tracked until you allow it; essential features work either way.",
            })}{" "}
            <Link to="/privacy" className="text-primary underline whitespace-nowrap">
              {t("cookieConsent.learnMore", { defaultValue: "Privacy Policy" })}
            </Link>
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => choose(false)}>
              {t("cookieConsent.decline", { defaultValue: "Only essentials" })}
            </Button>
            <Button size="sm" onClick={() => choose(true)}>
              {t("cookieConsent.accept", { defaultValue: "Allow analytics" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CookieConsentBanner;
