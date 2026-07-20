/**
 * ToolCallChip — inline pill that surfaces "Sathi is doing work" in the
 * chat panel. Phase 5 of the agent overhaul.
 *
 * Two states:
 *   - pending  → 🔍 Searching stays in Coorg…  (subtle pulse)
 *   - done     → ✓ Found 12 stays              (collapsed, gray)
 *   - error    → ⚠️ Couldn't search            (subtle red)
 *
 * Tool-name → emoji mapping is intentionally conservative; new tools
 * fall back to a generic ⚙️.
 */
import { Loader2, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChipStatus = "pending" | "done" | "error";

export interface Chip {
  /** Stable id matching the server's call.id; used to update on tool_done. */
  id: string;
  toolName: string;
  status: ChipStatus;
  /** Pending text — what the tool is doing right now. */
  pendingLabel: string;
  /** Done text — the tool's summary. */
  doneLabel?: string;
  errorMessage?: string;
}

const TOOL_EMOJI: Record<string, string> = {
  search_listings: "🔍",
  get_listing_details: "📋",
  check_availability: "📅",
  get_user_bookings: "🧾",
  cancel_booking_preview: "↩️",
  message_host_preview: "💬",
  prepare_booking: "🔒",
  escalate_to_human: "🙋",
};

function emojiFor(name: string): string {
  return TOOL_EMOJI[name] ?? "⚙️";
}

export function ToolCallChip({ chip }: { chip: Chip }) {
  if (chip.status === "pending") {
    return (
      <div className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-muted/60 px-2 py-0.5 text-xs",
        "text-muted-foreground animate-pulse",
      )}>
        <span aria-hidden>{emojiFor(chip.toolName)}</span>
        <span>{chip.pendingLabel}</span>
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      </div>
    );
  }
  if (chip.status === "error") {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs text-red-700">
        <AlertTriangle className="h-3 w-3" aria-hidden />
        <span>{chip.errorMessage || "Tool failed"}</span>
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
      <Check className="h-3 w-3 text-green-600" aria-hidden />
      <span aria-hidden>{emojiFor(chip.toolName)}</span>
      <span>{chip.doneLabel || chip.toolName}</span>
    </div>
  );
}
