import { Button } from "@/components/ui/button";
import { CalendarDays, ChevronRight } from "lucide-react";

export interface InlineBooking {
  id: string;
  status: string;
  listing?: string;
  provider?: string;
  /** ISO date (YYYY-MM-DD) of the stay/service start. */
  start?: string;
  /** Pre-formatted amount, e.g. "₹3,500". */
  amount?: string;
}

interface Props {
  bookings: InlineBooking[];
  /** Tap "Manage" on the footer — routes to the guest dashboard bookings tab. */
  onManage: () => void;
}

/** Status → badge color. Mirrors the dashboard's booking status palette. */
function statusClass(status: string): string {
  switch (status) {
    case "confirmed":
    case "completed":
      return "bg-emerald-100 text-emerald-700";
    case "pending":
      return "bg-amber-100 text-amber-700";
    case "cancelled":
    case "refunded":
      return "bg-rose-100 text-rose-700";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  // Render YYYY-MM-DD as a short, locale-stable label without pulling in a
  // date lib. Falls back to the raw string if it isn't the expected shape.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/**
 * Inline bookings list rendered inside the chat bubble.
 *
 * The agent emits `show_bookings` (promoted from a get_user_bookings tool
 * result); AssistantWidget attaches the rows to the assistant message and we
 * render this compact list — so "show my trips" surfaces real bookings in
 * chat instead of a prose summary or a forced jump to the dashboard.
 */
export function BookingsListInline({ bookings, onManage }: Props) {
  if (!bookings.length) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {bookings.map((b) => {
        const date = formatDate(b.start);
        return (
          <div
            key={b.id}
            className="rounded-xl border border-border/60 bg-card p-3 shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="text-sm font-semibold line-clamp-1">{b.listing ?? "Booking"}</h4>
                {b.provider && (
                  <p className="text-[11px] text-muted-foreground line-clamp-1">{b.provider}</p>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${statusClass(b.status)}`}>
                {b.status}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                {date && (
                  <>
                    <CalendarDays className="w-3 h-3" />
                    {date}
                  </>
                )}
              </span>
              {b.amount && <span className="font-medium text-foreground">{b.amount}</span>}
            </div>
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="w-full h-7 text-[11px] justify-center gap-1"
        onClick={onManage}
      >
        Manage in dashboard <ChevronRight className="w-3 h-3" />
      </Button>
    </div>
  );
}
