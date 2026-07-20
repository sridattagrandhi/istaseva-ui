/**
 * MessageHostCard — inline confirmation for sending a DM to a listing's
 * host. Rendered when the agent emits `confirm_message_host`.
 *
 * Phase 2: agent calls `message_host_preview` (read-only), surfaces the
 * draft, emits this action. The card lets the user tweak the message
 * before sending — it's their voice going to the host, not the agent's.
 *
 * Send fires the existing POST /api/chat/messages endpoint with a
 * receiver_id resolved server-side from listingId. (Phase 1 of this card
 * keeps it simple by just sending the agent's draft as the message body
 * to the listing's owner; the resolve step is server-side.)
 */
import { useState } from "react";
import { Loader2, CheckCircle2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";

type State = "idle" | "sending" | "done" | "failed";

interface Props {
  listingId: string;
  /** Resolved server-side from the listing during preview; the receiver
   *  on POST /api/chat/messages. The agent passes this through from the
   *  message_host_preview tool result. */
  hostUserId: string;
  /** Initial draft from the agent. User can tweak before sending. */
  initialMessage: string;
  /** Optional host display name from the preview tool. */
  hostName?: string;
  onResolved: (note: string) => void;
}

export function MessageHostCard({ listingId, hostUserId, initialMessage, hostName, onResolved }: Props) {
  const { t } = useLanguage();
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(initialMessage);

  const send = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setState("sending");
    setError(null);
    // The server endpoint takes receiver_id, not listingId — the host's
    // user_id was resolved server-side during message_host_preview and
    // forwarded through the action params. The listingId is kept around
    // for telemetry / future server-side metadata writes.
    void listingId;
    const res = await apiRequest<{ success: boolean; error?: string }>(
      "/api/chat/messages",
      {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify({ receiver_id: hostUserId, content: trimmed }),
      },
    );
    if (!res.success) {
      setState("failed");
      const msg = res.error || t("messageHostCard.fallbackError");
      setError(msg);
      onResolved(`${t("messageHostCard.failedPrefix")}${msg}`);
      return;
    }
    setState("done");
    onResolved(t("messageHostCard.successNote"));
  };

  // Prefer the named title when we have a host display name; otherwise
  // fall back to the generic "the host" copy. We keep two keys instead
  // of one with optional interpolation because some target languages
  // (e.g. Marathi case marker "ला") don't gracefully attach to "the host".
  const headline = hostName
    ? t("messageHostCard.titleNamed", { hostName })
    : t("messageHostCard.titleDefault");

  return (
    <div className="mt-2 rounded-xl border bg-background p-3 text-sm shadow-sm">
      <div className="flex items-start gap-2">
        <Send className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium">{headline}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t("messageHostCard.editHint")}
          </div>
        </div>
      </div>

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={state === "sending" || state === "done"}
        rows={3}
        className="mt-2 text-sm"
      />

      {state === "failed" && error && (
        <div className="mt-2 text-xs text-red-600">{error}</div>
      )}

      {state !== "done" ? (
        <div className="mt-3 flex gap-2">
          <Button
            onClick={send}
            disabled={state === "sending" || !body.trim()}
            size="sm"
            className="flex-1"
          >
            {state === "sending" ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> {t("messageHostCard.sending")}</> : t("messageHostCard.send")}
          </Button>
          <Button
            onClick={() => onResolved(t("messageHostCard.skipNote"))}
            disabled={state === "sending"}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            {t("messageHostCard.cancel")}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" /> {t("messageHostCard.sent")}
        </div>
      )}
    </div>
  );
}
