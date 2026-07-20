import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Loader2, AlertCircle, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getListingService } from "@/domains";
import type { Listing } from "@/types/domain";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import TransportScheduleStrip, {
  workingHoursForDate,
  type BookingBlock,
} from "@/components/TransportScheduleStrip";

/**
 * Driver-facing schedule view: the next 30 days as a stack of single-day
 * timeline strips. Bookings are fetched once for the whole window and
 * grouped by date for fast lookup; closed weekdays render a "Closed"
 * placeholder so drivers can see at a glance which days are off the
 * working-hours grid.
 *
 * Drivers can now also block individual dates — handy for sick days,
 * personal errands, or vehicle maintenance. Blocked dates land in
 * `metadata.blockedDates` and grey out in the customer date picker so
 * they can't be booked.
 */

const HORIZON_DAYS = 30;

const toISODate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const formatDay = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

export default function TransportScheduleDialog({
  listing, onClose,
}: {
  listing: Listing;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const metadata = (listing.metadata || {}) as Record<string, any>;
  // We deliberately render the driver's CONFIGURED workingHours, even if
  // that means "Closed" on every day — the schedule should mirror what
  // was set in onboarding (or last edit), not invent hours. For legacy
  // listings that have no schedule yet we still render a fallback so
  // customers can book, but we show a banner pointing the driver to
  // Edit so they know it's a placeholder.
  const rawWorkingHours = (metadata.workingHours || {}) as Record<string, [string, string] | null>;
  const hasConfiguredSchedule = Object.values(rawWorkingHours).some(
    (v) => Array.isArray(v) && v.length === 2 && v[0] && v[1],
  );
  const FALLBACK_HOURS: Record<string, [string, string]> = {
    mon: ["09:00", "21:00"], tue: ["09:00", "21:00"], wed: ["09:00", "21:00"],
    thu: ["09:00", "21:00"], fri: ["09:00", "21:00"], sat: ["09:00", "21:00"],
    sun: ["09:00", "21:00"],
  };
  const workingHours: Record<string, [string, string] | null> = hasConfiguredSchedule
    ? rawWorkingHours
    : FALLBACK_HOURS;
  const bufferMinutes = typeof metadata.bufferMinutes === "number" ? metadata.bufferMinutes : 15;

  // Block list — seeded from metadata, mutated by the toggle below, then
  // persisted via the listings update API. Local state so toggles feel
  // instant; mutation rolls back on failure.
  const [blockedDates, setBlockedDates] = useState<Set<string>>(() => {
    const raw = (metadata.blockedDates as unknown);
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((d): d is string => typeof d === "string"));
  });

  const persistBlockedDates = useMutation({
    mutationFn: async (next: Set<string>) => {
      const result = await getListingService().update(listing.id, {
        metadata: { ...metadata, blockedDates: Array.from(next).sort() },
      } as any);
      if (!result.success) throw new Error(result.error || t("transportSched.errUpdateBlocked", { defaultValue: "Couldn't update blocked dates" }));
      return next;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-listings"] });
    },
    onError: (err: Error, _next, ctx) => {
      // Roll back optimistic state.
      if (ctx && ctx instanceof Set) setBlockedDates(ctx);
      toast.error(err.message || t("transportSched.errUpdateBlocked", { defaultValue: "Couldn't update blocked dates" }));
    },
  });

  const toggleBlocked = (iso: string) => {
    setBlockedDates((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      persistBlockedDates.mutate(next);
      return next;
    });
  };

  const { from, to, days } = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + HORIZON_DAYS - 1);
    const arr: Date[] = [];
    for (let i = 0; i < HORIZON_DAYS; i += 1) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      arr.push(d);
    }
    return { from: toISODate(start), to: toISODate(end), days: arr };
  }, []);

  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ["transport-schedule", listing.id, from, to],
    // Always refetch when the dialog mounts + poll while it's open, so a
    // booking placed from the customer side lights up pink without
    // requiring the host to close and reopen the dialog. The booking
    // modal also invalidates this key on success, but bookings arriving
    // from other flows (AI agent, mobile app) still rely on this poll.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30 * 1000,
    queryFn: async () => {
      const res = await getListingService().getTransportBookings(listing.id, { from, to });
      return res.success && res.data ? res.data : [];
    },
  });

  // Group bookings by ISO date for O(1) lookup per row. Each row gets
  // only the bookings whose scheduledDate matches that day.
  const byDate = useMemo(() => {
    const m = new Map<string, BookingBlock[]>();
    for (const b of bookings) {
      const arr = m.get(b.scheduledDate) ?? [];
      arr.push({
        start: b.startTime,
        end: b.endTime,
        label: b.serviceCategory || t("transportSched.booked", { defaultValue: "Booked" }),
      });
      m.set(b.scheduledDate, arr);
    }
    return m;
  }, [bookings]);

  // Keep local state in sync if the parent passes a fresh listing in
  // (e.g. after another save round).
  useEffect(() => {
    const raw = (listing.metadata as any)?.blockedDates;
    if (!Array.isArray(raw)) return;
    setBlockedDates(new Set(raw.filter((d: unknown): d is string => typeof d === "string")));
  }, [listing]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col animate-scale-in">
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div>
            <h3 className="font-display font-bold text-lg">{t("transportSched.title", { defaultValue: "{{name}} — Schedule", name: listing.name })}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("transportSched.intro", { defaultValue: "Next {{days}} days. Booked trips are shaded; free hours are green.", days: HORIZON_DAYS })}
              {bufferMinutes > 0 && ` ${t("transportSched.buffer", { defaultValue: "Buffer between trips: {{minutes}} min.", minutes: bufferMinutes })}`}
              {" "}
              <span dangerouslySetInnerHTML={{ __html: t("transportSched.blockHint", { defaultValue: "Use <strong>Block day</strong> to take a day off — customers won't be able to book it." }) }} />
            </p>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {!hasConfiguredSchedule && !isLoading && (
            <div className="rounded-xl border border-yellow-300 bg-yellow-50 text-yellow-900 px-3 py-2.5 flex items-start gap-2 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">{t("transportSched.noScheduleTitle", { defaultValue: "No weekly schedule set yet" })}</p>
                <p className="mt-0.5 text-yellow-800"
                  dangerouslySetInnerHTML={{ __html: t("transportSched.noScheduleDesc", { defaultValue: "Showing 9 AM – 9 PM every day as a placeholder so customers can still book. Open <strong>Edit</strong> on this listing to set the days and hours you actually drive." }) }}
                />

              </div>
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t("transportSched.loading", { defaultValue: "Loading schedule…" })}
            </div>
          ) : (
            days.map((d) => {
              const iso = toISODate(d);
              const window = workingHoursForDate(workingHours, d);
              const isBlocked = blockedDates.has(iso);
              const dayBookings = byDate.get(iso) ?? [];
              return (
                <div
                  key={iso}
                  className={`rounded-lg ${isBlocked ? "opacity-60" : ""} relative`}
                >
                  <div className="flex items-center justify-end gap-2 mb-1">
                    <button
                      type="button"
                      onClick={() => toggleBlocked(iso)}
                      className={`text-[11px] font-semibold rounded-full px-2.5 py-1 border transition-colors ${
                        isBlocked
                          ? "bg-destructive text-destructive-foreground border-destructive"
                          : "bg-background text-muted-foreground border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40"
                      }`}
                    >
                      <Ban className="w-3 h-3 inline mr-1" />
                      {isBlocked ? t("transportSched.unblockDay", { defaultValue: "Unblock day" }) : t("transportSched.blockDay", { defaultValue: "Block day" })}
                    </button>
                  </div>
                  {isBlocked ? (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-3 text-xs text-destructive flex items-center justify-between">
                      <span className="font-semibold">{formatDay(d)}</span>
                      <span>{t("transportSched.dayBlocked", { defaultValue: "Day blocked — customers can't book." })}</span>
                    </div>
                  ) : (
                    <TransportScheduleStrip
                      caption={formatDay(d)}
                      windowStart={window.start}
                      windowEnd={window.end}
                      bookings={dayBookings}
                      bufferMinutes={bufferMinutes}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
