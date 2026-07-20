import { AlertCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ListingNotReadyItem {
  code: string;
  label: string;
  message: string;
}

interface Props {
  /**
   * Items returned by the server's `LISTING_NOT_READY` error.
   * When null/empty the dialog stays closed.
   */
  missing: ListingNotReadyItem[] | null;
  onClose: () => void;
  /**
   * Optional primary action — e.g. "Add photos" that opens the edit modal
   * straight to the photo-upload step. When omitted, the dialog shows
   * only a "Got it" button.
   */
  primaryAction?: { label: string; onClick: () => void };
}

/**
 * Shared modal used by every activation/publish surface when the
 * server's centralized readiness validator rejects a flip to active.
 *
 * Replaces the previous `toast.error("This listing can't go live yet…")`
 * pattern, which buried the missing fields in a bottom-of-screen banner
 * the host could easily miss. The dialog lists each blocker as its own
 * line item and offers a clear next action.
 */
export function ListingNotReadyDialog({ missing, onClose, primaryAction }: Props) {
  const { t } = useLanguage();
  const open = Boolean(missing && missing.length > 0);
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-yellow-600" aria-hidden />
            {t("notReady.title", { defaultValue: "This listing can't go live yet" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("notReady.description", { defaultValue: "Fix the items below to publish your listing. Guests won't see it until everything is in order." })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-2 text-sm">
          {(missing ?? []).map((m) => (
            <li key={m.code} className="flex items-start gap-2 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-yellow-900">
              <span className="mt-0.5 inline-block h-1.5 w-1.5 rounded-full bg-yellow-600 shrink-0" />
              <span>
                <strong className="block text-xs uppercase tracking-wide text-yellow-700">{m.label}</strong>
                {m.message}
              </span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t("notReady.gotIt", { defaultValue: "Got it" })}</AlertDialogCancel>
          {primaryAction && (
            <AlertDialogAction onClick={() => { primaryAction.onClick(); onClose(); }}>
              {primaryAction.label}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
