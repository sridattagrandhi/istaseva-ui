import { CalendarDays, TrendingUp, Wallet } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export interface BookingInsights {
  totalSpent: string;
  totalSpentPaise?: number;
  counts: { upcoming: number; past: number; cancelled: number; total: number };
  nextTrip?: {
    id: string;
    listing?: string;
    provider?: string;
    date?: string;
    status: string;
  };
  empty?: boolean;
}

interface Props {
  insights: BookingInsights;
  /** Tap "View all" → routes to the guest dashboard bookings. */
  onViewAll: () => void;
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/**
 * Compact dashboard-insights strip rendered inside the chat bubble.
 *
 * The agent emits `show_insights` (promoted from a get_booking_insights tool
 * result); AssistantWidget attaches it to the assistant message and we render
 * total spend, upcoming/past counts, and the next trip as scannable stats
 * instead of a prose sentence.
 */
export function InsightsStripInline({ insights, onViewAll }: Props) {
  const { t } = useLanguage();
  const nextDate = formatDate(insights.nextTrip?.date);
  // Show the cancelled bucket only when there are any — keeps the common case
  // a clean 3-up, but makes the visible counts reconcile with the "total" the
  // agent quotes (upcoming + past + cancelled) when some were cancelled.
  const showCancelled = insights.counts.cancelled > 0;
  return (
    <div className="mt-2 rounded-xl border border-border/60 bg-card p-3 shadow-sm space-y-2.5">
      <div className={`grid ${showCancelled ? "grid-cols-4" : "grid-cols-3"} gap-2 text-center`}>
        <div>
          <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <Wallet className="w-3 h-3" /> {t("assistant.insights.spent", { defaultValue: "Spent" })}
          </div>
          <div className="text-sm font-semibold mt-0.5">{insights.totalSpent}</div>
        </div>
        <div>
          <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <TrendingUp className="w-3 h-3" /> {t("assistant.insights.upcoming", { defaultValue: "Upcoming" })}
          </div>
          <div className="text-sm font-semibold mt-0.5">{insights.counts.upcoming}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("assistant.insights.past", { defaultValue: "Past" })}</div>
          <div className="text-sm font-semibold mt-0.5">{insights.counts.past}</div>
        </div>
        {showCancelled && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("assistant.insights.cancelled", { defaultValue: "Cancelled" })}</div>
            <div className="text-sm font-semibold mt-0.5 text-rose-600">{insights.counts.cancelled}</div>
          </div>
        )}
      </div>

      {insights.nextTrip && (
        <div className="rounded-lg bg-muted/60 px-2.5 py-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("assistant.insights.nextTrip", { defaultValue: "Next trip" })}</div>
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className="text-xs font-medium line-clamp-1">{insights.nextTrip.listing ?? t("assistant.insights.booking", { defaultValue: "Booking" })}</span>
            {nextDate && (
              <span className="shrink-0 flex items-center gap-1 text-[11px] text-muted-foreground">
                <CalendarDays className="w-3 h-3" /> {nextDate}
              </span>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onViewAll}
        className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground transition"
      >
        {t("assistant.insights.viewAll", { defaultValue: "View all bookings" })}
      </button>
    </div>
  );
}
