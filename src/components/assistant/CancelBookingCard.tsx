/**
 * CancelBookingCard — inline confirmation rendered when the agent emits
 * the `confirm_cancel_booking` action.
 *
 * Phase 2 of the agent overhaul: the agent calls the read-only
 * `cancel_booking_preview` tool, surfaces the preview in chat, and emits
 * this action. This card is the explicit user gate — the actual cancel
 * fires only on Confirm tap, via the existing PATCH /api/bookings/:id/status
 * endpoint (no new backend work).
 */
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

type State = "idle" | "cancelling" | "done" | "failed";

interface CancelPreview {
  cancellable: boolean;
  refundPaise: number;
  platformKeepsPaise: number;
  policy: "flexible" | "moderate" | "strict";
  insuranceVoided: boolean;
  reason: string;
  chargedPaise?: number;
}

interface Props {
  bookingId: string;
  /** Short human description from the agent's preview, e.g. "Taj Goa Nov 22-24". */
  summary?: string;
  onResolved: (note: string) => void;
}

export function CancelBookingCard({ bookingId, summary, onResolved }: Props) {
  const { t } = useLanguage();
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  // Pull the projected refund as soon as the card mounts. We don't block
  // the cancel button on this — if the preview fails, the user can still
  // cancel and the server will compute the refund — but if it succeeds we
  // surface the exact amount they'll get back.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiRequest<{ data: CancelPreview }>(
        `/api/bookings/${encodeURIComponent(bookingId)}/cancel-preview`,
        { method: "GET" },
      );
      if (cancelled) return;
      if (res.success && res.data?.data) setPreview(res.data.data);
      setPreviewLoading(false);
    })();
    return () => { cancelled = true; };
  }, [bookingId]);

  const fmt = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

  const cancel = async () => {
    setState("cancelling");
    setError(null);
    // Backend's per-role transition matrix lets the guest go pending|confirmed → cancelled;
    // any rejection comes back as a 4xx with a message we surface verbatim.
    const res = await apiRequest<{ success: boolean; error?: string }>(
      `/api/bookings/${encodeURIComponent(bookingId)}/status`,
      {
        method: "PATCH",
        headers: getJsonHeaders(),
        body: JSON.stringify({ status: "cancelled" }),
      },
    );
    if (!res.success) {
      setState("failed");
      const msg = res.error || t("cancelCard.fallbackError");
      setError(msg);
      onResolved(`${t("cancelCard.failedPrefix")}${msg}`);
      return;
    }
    setState("done");
    onResolved(t("cancelCard.successNote"));
  };

  return (
    <div className="mt-2 rounded-xl border bg-background p-3 text-sm shadow-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium">{t("cancelCard.title")}</div>
          {summary && <div className="text-xs text-muted-foreground mt-0.5">{summary}</div>}
          {previewLoading ? (
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("assistant.cancel.calculatingRefund", { defaultValue: "Calculating refund…" })}
            </div>
          ) : preview ? (
            <div className="text-xs mt-1 space-y-0.5">
              {preview.refundPaise > 0 ? (
                <div className="text-foreground">
                  {t("assistant.cancel.youllGetBack", { defaultValue: "You'll get back" })} <span className="font-semibold">{fmt(preview.refundPaise)}</span>
                  {preview.platformKeepsPaise > 0 ? (
                    <span className="text-muted-foreground"> {t("assistant.cancel.retained", { amount: fmt(preview.platformKeepsPaise), defaultValue: "({{amount}} retained)" })}</span>
                  ) : null}
                </div>
              ) : (
                <div className="text-foreground">{t("assistant.cancel.noRefund", { defaultValue: "No refund applies." })}</div>
              )}
              <div className="text-muted-foreground">{preview.reason}</div>
              {preview.insuranceVoided && (
                <div className="text-muted-foreground">{t("assistant.cancel.insuranceVoided", { defaultValue: "Insurance coverage will be voided." })}</div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground mt-1">
              {t("cancelCard.policyHint")}
            </div>
          )}
        </div>
      </div>

      {state === "failed" && error && (
        <div className="mt-2 text-xs text-red-600">{error}</div>
      )}

      {state !== "done" ? (
        <div className="mt-3 flex gap-2">
          <Button
            onClick={cancel}
            disabled={state === "cancelling"}
            variant="destructive"
            size="sm"
            className="flex-1"
          >
            {state === "cancelling" ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> {t("cancelCard.cancelling")}</> : t("cancelCard.confirm")}
          </Button>
          <Button
            onClick={() => onResolved(t("cancelCard.keptNote"))}
            disabled={state === "cancelling"}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            {t("cancelCard.keep")}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" /> {t("cancelCard.done")}
        </div>
      )}
    </div>
  );
}
