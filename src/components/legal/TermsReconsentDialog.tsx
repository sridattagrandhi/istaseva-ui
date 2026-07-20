import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getLegalService } from "@/domains/legal/legal.service";
import { LEGAL_DOCS_VERSION } from "@/lib/legal";

/**
 * Blocking Terms re-consent (LEG-003, general mechanism).
 *
 * Shown when a signed-in user's latest recorded 'terms' acceptance predates
 * the current LEGAL_DOCS_VERSION — which, before this shipped, was every
 * Terms change: the version was stamped onto consent rows but never compared,
 * so updated Terms bound only new signups. Accepting records BOTH a fresh
 * versioned terms row and the 18+ attestation (age_confirmation), so this
 * dialog doubles as the age backfill for accounts that predate the age gate.
 *
 * Deliberately NOT shown on the auth routes: during signup the consent write
 * is still in flight there, and prompting would be a false positive (the
 * pending-flag check in needsTermsReconsent covers the retry path).
 */
const AUTH_ROUTES = new Set(["/signup", "/login", "/verify-email", "/reset-password", "/forgot-password"]);

const TermsReconsentDialog = () => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  // One server check per signed-in user per session — not one per navigation.
  const checkedForUser = useRef<string | null>(null);

  const onAuthRoute = AUTH_ROUTES.has(location.pathname);

  // Key the effect to the user ID, not the user object: AuthContext re-emits
  // the user several times during session hydration (restore → profile
  // enrichment), and cancelling the in-flight check on each re-emit while the
  // checkedForUser guard blocks the re-run meant the dialog never opened.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      checkedForUser.current = null;
      setOpen(false);
      setAgeConfirmed(false);
      return;
    }
    if (onAuthRoute || checkedForUser.current === userId) return;
    checkedForUser.current = userId;
    void getLegalService()
      .needsTermsReconsent()
      .then((needs) => {
        // Only act if the same user is still signed in by the time we know.
        if (needs && checkedForUser.current === userId) setOpen(true);
      })
      .catch(() => undefined);
  }, [userId, onAuthRoute]);

  const accept = async () => {
    setSaving(true);
    const ok = await getLegalService().acceptCurrentTerms();
    setSaving(false);
    if (ok) {
      setOpen(false);
    } else {
      toast.error(
        t("reconsent.saveFailed", {
          defaultValue: "Couldn't save your acceptance. Check your connection and try again.",
        }),
      );
    }
  };

  if (!user || onAuthRoute) return null;

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="max-w-md rounded-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-xl">
            {t("reconsent.title", { defaultValue: "We've updated our Terms" })}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                {t("reconsent.body", {
                  defaultValue:
                    "IstaSeva is now for adults only — account holders must be 18 or older. Please review and accept the updated Terms of Service and Privacy Policy to keep using your account.",
                })}
              </p>
              <p>
                <Link to="/terms" target="_blank" className="text-primary underline font-medium">
                  {t("reconsent.termsLink", { defaultValue: "Terms of Service" })}
                </Link>
                {" · "}
                <Link to="/privacy" target="_blank" className="text-primary underline font-medium">
                  {t("reconsent.privacyLink", { defaultValue: "Privacy Policy" })}
                </Link>
                <span className="text-xs text-muted-foreground/70"> — {t("reconsent.version", { defaultValue: "version" })} {LEGAL_DOCS_VERSION}</span>
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 p-3">
          <Checkbox
            id="reconsent-age"
            checked={ageConfirmed}
            onCheckedChange={(v) => setAgeConfirmed(v === true)}
            className="mt-0.5"
          />
          <label htmlFor="reconsent-age" className="text-sm cursor-pointer select-none">
            {t("reconsent.ageAttest", { defaultValue: "I confirm that I am 18 years of age or older" })}
          </label>
        </div>

        <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            className="w-full h-11 rounded-xl font-semibold"
            disabled={!ageConfirmed || saving}
            onClick={accept}
          >
            {saving
              ? t("reconsent.saving", { defaultValue: "Saving…" })
              : t("reconsent.accept", { defaultValue: "Agree and continue" })}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t("reconsent.altLead", { defaultValue: "Don't agree?" })}{" "}
            <Link to="/delete-account" className="underline">
              {t("reconsent.altLink", { defaultValue: "You can close your account instead." })}
            </Link>
          </p>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default TermsReconsentDialog;
