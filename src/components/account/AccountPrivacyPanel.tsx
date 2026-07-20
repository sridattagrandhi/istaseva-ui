import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Trash2, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { getTrackingConsent, setTrackingConsent } from "@/lib/tracking-consent";
import { getLegalService } from "@/domains/legal/legal.service";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

/**
 * "Privacy & data" panel (PRIV-002 / LEG-017): DSAR export + account
 * deletion, rendered on the dashboard Profile tab next to the consent
 * toggle. Deletion needs a recent sign-in — a REAUTH_REQUIRED response asks
 * the user to sign in again and retry. Erasure runs after a 48h grace
 * window; while it's pending the panel shows the scheduled date and a
 * cancel button, and the account stays fully usable.
 */

interface AccountRequestState {
  id: string;
  type: "export" | "deletion";
  status: "requested" | "processing" | "completed" | "failed" | "cancelled";
  requestedAt: string;
  completedAt: string | null;
  scheduledFor?: string | null;
  cancellable?: boolean;
  error: string | null;
  downloadUrl?: string | null;
  downloadExpiresAt?: string | null;
}

const formatScheduledFor = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

const AccountPrivacyPanel = () => {
  const { t } = useLanguage();
  const [exportState, setExportState] = useState<AccountRequestState | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [deletionState, setDeletionState] = useState<AccountRequestState | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  // Per-device analytics consent (LEG-014) — same state the cookie banner sets.
  const [analyticsOn, setAnalyticsOn] = useState(() => getTrackingConsent() === "granted");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshExport = useCallback(async () => {
    const result = await apiRequest<{ data: AccountRequestState | null }>("/api/users/me/export", {
      headers: getJsonHeaders(false),
    });
    if (result.success && result.data) {
      setExportState(result.data.data);
      return result.data.data;
    }
    return null;
  }, []);

  // Load the current deletion request once, so a pending grace-window
  // deletion survives reloads and other devices.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await apiRequest<{ data: AccountRequestState | null }>("/api/users/me/deletion-request", {
        headers: getJsonHeaders(false),
      });
      if (!cancelled && result.success && result.data) setDeletionState(result.data.data);
    })();
    return () => { cancelled = true; };
  }, []);

  // Load current export state once; poll while one is in flight.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const state = await refreshExport();
      if (cancelled) return;
      if (state && (state.status === "requested" || state.status === "processing")) {
        pollTimer.current = setTimeout(tick, 4000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [refreshExport]);

  const requestExport = async () => {
    setExportBusy(true);
    const result = await apiRequest<{ data: AccountRequestState }>("/api/users/me/export", {
      method: "POST",
      headers: getJsonHeaders(false),
    });
    setExportBusy(false);
    if (!result.success) {
      toast.error(t("privacyPanel.exportFailed", { defaultValue: "Could not start the export. Please try again." }));
      return;
    }
    toast.success(t("privacyPanel.exportStarted", { defaultValue: "Preparing your data — this usually takes under a minute." }));
    setExportState(result.data?.data ?? null);
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async function poll() {
      const state = await refreshExport();
      if (state && (state.status === "requested" || state.status === "processing")) {
        pollTimer.current = setTimeout(poll, 4000);
      }
    }, 4000);
  };

  const requestDeletion = async () => {
    setDeleteBusy(true);
    const result = await apiRequest<{ data: AccountRequestState }>("/api/users/me/deletion-request", {
      method: "POST",
      headers: getJsonHeaders(false),
    });
    setDeleteBusy(false);
    setDeleteOpen(false);
    if (!result.success) {
      // Stale sign-in → the server asks for a fresh login before deleting.
      if ((result.error || "").toLowerCase().includes("sign in")) {
        toast.error(t("privacyPanel.reauthRequired", { defaultValue: "For security, please log out, sign in again, and retry deleting your account." }));
      } else {
        toast.error(t("privacyPanel.deleteFailed", { defaultValue: "Could not delete your account. Please try again or contact support." }));
      }
      return;
    }
    setDeletionState(result.data?.data ?? null);
    toast.success(t("privacyPanel.deleteScheduled", { defaultValue: "Deletion scheduled. You have 48 hours to change your mind." }));
  };

  const cancelDeletion = async () => {
    setCancelBusy(true);
    const result = await apiRequest<{ data: AccountRequestState }>("/api/users/me/deletion-request/cancel", {
      method: "POST",
      headers: getJsonHeaders(false),
    });
    setCancelBusy(false);
    if (!result.success) {
      toast.error(t("privacyPanel.cancelFailed", { defaultValue: "Could not cancel — deletion may already be underway. Contact support." }));
      return;
    }
    setDeletionState(result.data?.data ?? null);
    toast.success(t("privacyPanel.cancelDone", { defaultValue: "Deletion cancelled. Your account stays active." }));
  };

  const exportInFlight = exportState?.status === "requested" || exportState?.status === "processing";
  const deletionPending = deletionState?.status === "requested" && deletionState.cancellable !== false;

  return (
    <div className="bg-card rounded-2xl border border-border p-6 sm:p-8 space-y-6">
      <h4 className="text-sm font-semibold">{t("privacyPanel.title", { defaultValue: "Privacy & data" })}</h4>

      {/* Analytics consent (LEG-014) — withdrawable any time, per device */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t("privacyPanel.analyticsTitle", { defaultValue: "Usage analytics" })}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {t("privacyPanel.analyticsHint", { defaultValue: "Share anonymous usage data (a device identifier, pages and searches) to help improve IstaSeva. Applies to this device." })}
          </p>
        </div>
        <Switch
          checked={analyticsOn}
          onCheckedChange={(granted) => {
            setAnalyticsOn(granted);
            setTrackingConsent(granted); // device gate (suppresses analytics now)
            void getLegalService().recordAnalyticsConsent(granted); // + audit trail (LEG-014)
          }}
          aria-label={t("privacyPanel.analyticsTitle", { defaultValue: "Usage analytics" })}
          className="shrink-0 mt-0.5"
        />
      </div>

      <div className="border-t border-border" />

      {/* Export */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t("privacyPanel.exportTitle", { defaultValue: "Download my data" })}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {t("privacyPanel.exportHint", { defaultValue: "Get a copy of your profile, bookings, messages and activity as a JSON file." })}
          </p>
          {exportState?.status === "completed" && exportState.downloadUrl && (
            <a
              href={exportState.downloadUrl}
              download
              className="inline-flex items-center gap-1.5 text-sm text-primary underline mt-2"
            >
              <Download className="w-3.5 h-3.5" />
              {t("privacyPanel.downloadReady", { defaultValue: "Your export is ready — download it" })}
            </a>
          )}
          {exportState?.status === "failed" && (
            <p className="text-sm text-destructive mt-2">
              {t("privacyPanel.exportError", { defaultValue: "The last export failed — you can request a new one." })}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={requestExport} disabled={exportBusy || exportInFlight} className="shrink-0">
          {exportBusy || exportInFlight ? (
            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />{t("privacyPanel.preparing", { defaultValue: "Preparing…" })}</>
          ) : (
            <><Download className="w-3.5 h-3.5 mr-1.5" />{t("privacyPanel.exportCta", { defaultValue: "Request export" })}</>
          )}
        </Button>
      </div>

      <div className="border-t border-border" />

      {/* Delete */}
      {deletionPending ? (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/50 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <Clock className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t("privacyPanel.scheduledTitle", { defaultValue: "Account deletion scheduled" })}
              </p>
              <p className="text-sm text-amber-800/90 dark:text-amber-300/90 mt-1">
                {deletionState?.scheduledFor
                  ? t("privacyPanel.scheduledBody", {
                      defaultValue: "Your account and personal data will be permanently erased after {{date}}. Until then everything keeps working, and you can cancel below.",
                      date: formatScheduledFor(deletionState.scheduledFor),
                    })
                  : t("privacyPanel.scheduledBodyNoDate", { defaultValue: "Your account is scheduled for permanent deletion. You can still cancel below." })}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void cancelDeletion()} disabled={cancelBusy}>
            {cancelBusy ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />{t("privacyPanel.cancelling", { defaultValue: "Cancelling…" })}</>
            ) : (
              t("privacyPanel.cancelCta", { defaultValue: "Cancel deletion" })
            )}
          </Button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t("privacyPanel.deleteTitle", { defaultValue: "Delete account" })}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("privacyPanel.deleteHint", { defaultValue: "Permanently delete your account and personal data after a 48-hour grace period." })}{" "}
              <Link to="/delete-account" target="_blank" className="text-primary underline">
                {t("privacyPanel.deleteLearnMore", { defaultValue: "What gets deleted?" })}
              </Link>
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} className="shrink-0">
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            {t("privacyPanel.deleteCta", { defaultValue: "Delete account" })}
          </Button>
        </div>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!deleteBusy) setDeleteOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("privacyPanel.confirmTitle", { defaultValue: "Delete your account permanently?" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("privacyPanel.confirmBody", {
                defaultValue:
                  "Deletion runs after a 48-hour grace period — until then your account keeps working and you can cancel from this page. Afterwards your profile, listings, messages and personal data are permanently removed and you are signed out everywhere. Records required by tax law (completed bookings and payments) are kept with your personal details removed. Upcoming bookings are NOT cancelled automatically — cancel them first for a refund.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>{t("privacyPanel.confirmCancel", { defaultValue: "Keep my account" })}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void requestDeletion(); }}
              disabled={deleteBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy ? (
                <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />{t("privacyPanel.deleting", { defaultValue: "Deleting…" })}</>
              ) : (
                t("privacyPanel.confirmDelete", { defaultValue: "Delete permanently" })
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AccountPrivacyPanel;
