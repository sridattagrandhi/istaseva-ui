import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getListingService } from "@/domains";
import type { Listing } from "@/types/domain";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

/**
 * Service-provider schedule view. Deliberately SEPARATE from the transport
 * `TransportScheduleDialog` (hourly timeline strips) and the stays
 * `AvailabilityCalendar` (per-night pricing + room tabs): a service only needs
 * whole-day blocking, so this is a clean month grid where each tap toggles a
 * day on/off.
 *
 * Blocked days are persisted to `listing_availability_overrides` at the
 * listing level (`roomTypeId: null`) — the same store the customer booking
 * modal reads and the backend's `createHold` enforces. Days that already carry
 * a confirmed/pending booking are flagged so the provider doesn't accidentally
 * block a day they're committed to.
 */

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export default function ServiceScheduleDialog({
  listing, onClose,
}: {
  listing: Listing;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  // Dates currently in-flight to the server — disables the cell so a double
  // tap can't race two PUTs for the same day.
  const [pendingDates, setPendingDates] = useState<Set<string>>(new Set());

  const monthStart = ymd(startOfMonth(cursor));
  const monthEnd = ymd(endOfMonth(cursor));

  // Listing-level blocked days for the visible month.
  const overridesQuery = useQuery({
    queryKey: ["service-availability", listing.id, monthStart, monthEnd],
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await getListingService().getAvailability(listing.id, { from: monthStart, to: monthEnd });
      return res.success && res.data ? res.data : [];
    },
  });

  // Existing service bookings in the month — surfaced as a "Booked" hint so the
  // provider sees commitments before blocking. Read-only here.
  const { data: serviceBookings = [] } = useQuery({
    queryKey: ["service-schedule-bookings", listing.id, monthStart, monthEnd],
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const res = await getListingService().getServiceBookings(listing.id, { from: monthStart, to: monthEnd });
      return res.success && res.data ? res.data : [];
    },
  });

  const blockedSet = useMemo(() => {
    const s = new Set<string>();
    for (const o of overridesQuery.data || []) {
      if (o.blocked && o.roomTypeId == null) s.add(String(o.date).slice(0, 10));
    }
    return s;
  }, [overridesQuery.data]);

  const bookedSet = useMemo(() => {
    const s = new Set<string>();
    for (const b of serviceBookings) {
      if (["pending", "confirmed", "in_progress"].includes(String(b.status).toLowerCase())) {
        s.add(b.scheduledDate);
      }
    }
    return s;
  }, [serviceBookings]);

  const toggleBlocked = useMutation({
    mutationFn: async ({ date, blocked }: { date: string; blocked: boolean }) => {
      const res = await getListingService().setAvailability(listing.id, [
        { date, blocked, pricePaise: null, roomTypeId: null },
      ]);
      if (!res.success) throw new Error(res.error || t("serviceSched.errUpdate", { defaultValue: "Couldn't update blocked dates" }));
      return { date };
    },
    onMutate: ({ date }) => {
      setPendingDates((prev) => new Set(prev).add(date));
    },
    onSuccess: () => {
      // Refresh this dialog's grid and the customer-facing modal's source.
      queryClient.invalidateQueries({ queryKey: ["service-availability", listing.id] });
    },
    onError: (err: Error) => {
      toast.error(err.message || t("serviceSched.errUpdate", { defaultValue: "Couldn't update blocked dates" }));
    },
    onSettled: (_data, _err, { date }) => {
      setPendingDates((prev) => {
        const next = new Set(prev);
        next.delete(date);
        return next;
      });
    },
  });

  // Sun-anchored calendar grid with leading/trailing filler days for layout.
  const grid = useMemo(() => {
    const first = startOfMonth(cursor);
    const last = endOfMonth(cursor);
    const leading = first.getDay();
    const days: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < leading; i++) {
      const d = new Date(first);
      d.setDate(d.getDate() - (leading - i));
      days.push({ date: d, inMonth: false });
    }
    for (let i = 1; i <= last.getDate(); i++) {
      days.push({ date: new Date(cursor.getFullYear(), cursor.getMonth(), i), inMonth: true });
    }
    while (days.length % 7 !== 0) {
      const d = new Date(days[days.length - 1].date);
      d.setDate(d.getDate() + 1);
      days.push({ date: d, inMonth: false });
    }
    return days;
  }, [cursor]);

  const today = ymd(new Date());
  const monthLabel = cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const handleDayClick = (dateStr: string) => {
    if (dateStr < today) return;
    if (pendingDates.has(dateStr)) return;
    toggleBlocked.mutate({ date: dateStr, blocked: !blockedSet.has(dateStr) });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4 animate-scale-in">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display font-bold text-lg flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-primary" /> {t("serviceSched.title", { defaultValue: "Schedule" })}
            </h3>
            <p className="text-sm text-muted-foreground">
              {listing.name}
              {" — "}
              {t("serviceSched.subtitle", { defaultValue: "Tap a day to block it. Customers can't book days you've blocked." })}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" className="rounded-full"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="font-semibold">{monthLabel}</span>
          <Button variant="outline" size="sm" className="rounded-full"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-[10px] text-muted-foreground font-semibold uppercase">
          {[
            t("availCal.dowSun", { defaultValue: "Sun" }),
            t("availCal.dowMon", { defaultValue: "Mon" }),
            t("availCal.dowTue", { defaultValue: "Tue" }),
            t("availCal.dowWed", { defaultValue: "Wed" }),
            t("availCal.dowThu", { defaultValue: "Thu" }),
            t("availCal.dowFri", { defaultValue: "Fri" }),
            t("availCal.dowSat", { defaultValue: "Sat" }),
          ].map((d) => (
            <div key={d} className="text-center py-1">{d}</div>
          ))}
        </div>

        {overridesQuery.isLoading ? (
          <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {grid.map(({ date, inMonth }, i) => {
              const dateStr = ymd(date);
              const isPast = dateStr < today;
              const blocked = blockedSet.has(dateStr);
              const booked = bookedSet.has(dateStr);
              const isPending = pendingDates.has(dateStr);
              return (
                <button
                  key={i}
                  disabled={isPast || isPending}
                  onClick={() => handleDayClick(dateStr)}
                  className={`aspect-square flex flex-col items-center justify-center rounded-lg text-xs transition-all relative ${
                    !inMonth ? "text-muted-foreground/30" : ""
                  } ${
                    isPast ? "cursor-not-allowed opacity-40" :
                    blocked ? "bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive/20" :
                    "bg-card border border-border hover:border-primary/50"
                  } ${isPending ? "opacity-60" : ""}`}
                >
                  <span className="font-semibold">{date.getDate()}</span>
                  {blocked && (
                    <span className="text-[9px] mt-0.5">{t("serviceSched.blocked", { defaultValue: "Blocked" })}</span>
                  )}
                  {!blocked && booked && (
                    <span className="text-[9px] mt-0.5 text-secondary-foreground/70">{t("serviceSched.booked", { defaultValue: "Booked" })}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-card border border-border" /> {t("serviceSched.legendOpen", { defaultValue: "Open" })}</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-destructive/20 border border-destructive/40" /> {t("serviceSched.blocked", { defaultValue: "Blocked" })}</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-card border border-border" />{t("serviceSched.bookedHint", { defaultValue: "“Booked” = already has a booking" })}</span>
        </div>

        <div className="flex pt-2 border-t border-border">
          <Button variant="outline" className="flex-1 rounded-xl" onClick={onClose}>
            {t("serviceSched.done", { defaultValue: "Done" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
