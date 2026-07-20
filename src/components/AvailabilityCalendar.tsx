import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Globe, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getListingService, type AvailabilityOverride } from "@/domains/listings/listing.service";
import { foldAvailabilityOverrides } from "@/lib/stay-pricing";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";

interface Props {
  listingId: string;
  listingName?: string;
  /** Optional: bookable rooms — if provided, host can switch which room they're editing.
      Pass [] for non-hotel stays; the calendar then edits at the listing level. */
  rooms?: Array<{ id: string; name: string }>;
  onClose: () => void;
}

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

const AvailabilityCalendar = ({ listingId, listingName, rooms = [], onClose }: Props) => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(rooms[0]?.id ?? null);
  // Pending edits — keyed by date YYYY-MM-DD. Persisted on Save.
  const [pending, setPending] = useState<Record<string, { blocked: boolean; pricePaise: number | null }>>({});
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState("");

  const monthStart = ymd(startOfMonth(cursor));
  const monthEnd = ymd(endOfMonth(cursor));

  const overridesQuery = useQuery({
    queryKey: ["availability-overrides", listingId, monthStart, monthEnd],
    queryFn: async () => {
      const result = await getListingService().listAvailability(listingId, monthStart, monthEnd);
      if (!result.success || !result.data) throw new Error(result.error || t("availCal.errLoad", { defaultValue: "Failed to load availability" }));
      return result.data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const entries = Object.entries(pending).map(([date, val]) => ({
        date,
        blocked: val.blocked,
        pricePaise: val.pricePaise,
        roomTypeId: selectedRoomId,
      }));
      if (entries.length === 0) return;
      const result = await getListingService().setAvailability(listingId, entries);
      if (!result.success) throw new Error(result.error || t("availCal.errSave", { defaultValue: "Failed to save" }));
    },
    onSuccess: () => {
      toast.success(t("availCal.toastUpdated", { defaultValue: "Calendar updated" }));
      setPending({});
      queryClient.invalidateQueries({ queryKey: ["availability-overrides", listingId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Effective per-date state, computed from the canonical helper that the
  // guest calendar + backend `createHold` already trust. That guarantees:
  //   - a listing-wide block (room_type_id IS NULL) is immutable — a
  //     room tab cannot "unblock" it
  //   - a room-level price shadows the listing-level price only when the
  //     date is not listing-blocked
  //   - a room-level block stacks on top of any listing-level block
  // We additionally track per-date scope so the UI can tag inherited
  // listing-wide rows with a badge and forbid unblock from a room tab.
  const effectiveByDate = useMemo(() => {
    const rows = (overridesQuery.data || []).map((o) => ({
      roomTypeId: o.roomTypeId,
      date: o.date,
      blocked: o.blocked,
      pricePaise: o.pricePaise,
    }));
    const { blockedSet, priceByDate } = foldAvailabilityOverrides(rows, selectedRoomId);
    // Which dates carry a room-specific row (block or price) for the
    // currently selected room? Used to decide whether a date's effective
    // state was inherited from the listing scope or owned by this room.
    const roomDates = new Set<string>();
    if (selectedRoomId !== null) {
      for (const r of rows) {
        if (r.roomTypeId === selectedRoomId) roomDates.add(r.date);
      }
    }
    // Listing-level block dates — useful for showing an "inherited" badge.
    const listingBlockDates = new Set<string>();
    for (const r of rows) {
      if (r.roomTypeId == null && r.blocked) listingBlockDates.add(r.date);
    }
    const map = new Map<string, { blocked: boolean; pricePaise: number | null; persisted: boolean; scope: 'listing' | 'room'; inherited: boolean }>();
    const allDates = new Set<string>([...blockedSet, ...priceByDate.keys()]);
    for (const date of allDates) {
      const isRoomOwned = selectedRoomId !== null && roomDates.has(date);
      const isListingBlocked = listingBlockDates.has(date);
      map.set(date, {
        blocked: blockedSet.has(date),
        pricePaise: priceByDate.get(date) ?? null,
        persisted: true,
        scope: selectedRoomId === null ? 'listing' : (isRoomOwned ? 'room' : 'listing'),
        // "inherited" = displayed on a room tab but the source row lives at
        // the listing scope; the host can stack a room block but can't undo.
        inherited: selectedRoomId !== null && !isRoomOwned && isListingBlocked,
      });
    }
    for (const [date, val] of Object.entries(pending)) {
      map.set(date, {
        ...val,
        persisted: false,
        scope: selectedRoomId === null ? 'listing' : 'room',
        inherited: false,
      });
    }
    return map;
  }, [overridesQuery.data, pending, selectedRoomId]);

  // Build the visible days grid (Sun-anchored). We show a calendar grid that
  // includes leading/trailing days from the adjacent months for layout.
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

  const handleDayClick = (dateStr: string) => {
    if (dateStr < today) return; // Can't edit the past
    setEditingDate(dateStr);
    const eff = effectiveByDate.get(dateStr);
    setPriceInput(eff?.pricePaise != null ? String(eff.pricePaise / 100) : "");
  };

  const applyEdit = (action: "block" | "unblock" | "price" | "clear") => {
    if (!editingDate) return;
    const current = effectiveByDate.get(editingDate);
    let next: { blocked: boolean; pricePaise: number | null };
    if (action === "block") next = { blocked: true, pricePaise: current?.pricePaise ?? null };
    else if (action === "unblock") next = { blocked: false, pricePaise: current?.pricePaise ?? null };
    else if (action === "clear") next = { blocked: false, pricePaise: null };
    else {
      const n = Number(priceInput);
      if (!Number.isFinite(n) || n < 0) { toast.error(t("availCal.errValidPrice", { defaultValue: "Enter a valid price" })); return; }
      next = { blocked: current?.blocked ?? false, pricePaise: Math.round(n * 100) };
    }
    setPending((prev) => ({ ...prev, [editingDate]: next }));
    setEditingDate(null);
  };

  const monthLabel = cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const hasUnsaved = Object.keys(pending).length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display font-bold text-lg flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-primary" /> {t("availCal.title", { defaultValue: "Calendar & pricing" })}
            </h3>
            <p className="text-sm text-muted-foreground">{listingName || t("availCal.subtitle", { defaultValue: "Block dates and override prices per day" })}</p>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {rooms.length > 0 && (
          <div className="flex flex-wrap gap-2 items-center">
            {/*
              Explicit "listing-wide" scope tab. Picking it edits overrides
              that apply to EVERY room — useful for blocking the whole
              property (renovation, maintenance) without touching each
              room individually. Each room tab below edits only that
              room's overrides; listing-wide blocks then show as inherited
              there (read-only badge, can't be unblocked from the room).
            */}
            <button
              onClick={() => setSelectedRoomId(null)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
                selectedRoomId === null ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-primary/10"
              }`}
              title={t("availCal.listingWideTitle", { defaultValue: "Edit overrides that apply to every room" })}
            >
              <Globe className="w-3 h-3" /> {t("availCal.listingWide", { defaultValue: "Listing-wide" })}
            </button>
            {rooms.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedRoomId(r.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  selectedRoomId === r.id ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-primary/10"
                }`}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}

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
              const eff = effectiveByDate.get(dateStr);
              const isPast = dateStr < today;
              const blocked = eff?.blocked;
              const customPrice = eff?.pricePaise;
              const isPending = pending[dateStr] !== undefined;
              return (
                <button
                  key={i}
                  disabled={isPast}
                  onClick={() => handleDayClick(dateStr)}
                  className={`aspect-square flex flex-col items-center justify-center rounded-lg text-xs transition-all ${
                    !inMonth ? "text-muted-foreground/30" : ""
                  } ${
                    isPast ? "cursor-not-allowed opacity-40" :
                    blocked ? "bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive/20" :
                    customPrice != null ? "bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20" :
                    "bg-card border border-border hover:border-primary/50"
                  } ${isPending ? "ring-2 ring-secondary" : ""}`}
                >
                  <span className="font-semibold">{date.getDate()}</span>
                  {customPrice != null && !blocked && (
                    <span className="text-[9px] mt-0.5">₹{(customPrice / 100).toLocaleString()}</span>
                  )}
                  {blocked && (
                    <span className="text-[9px] mt-0.5">
                      {eff?.inherited ? t("availCal.listingWide", { defaultValue: "Listing-wide" }) : t("availCal.blocked", { defaultValue: "Blocked" })}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-card border border-border" /> {t("availCal.legendDefault", { defaultValue: "Default" })}</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-primary/20 border border-primary/40" /> {t("availCal.legendCustomPrice", { defaultValue: "Custom price" })}</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-destructive/20 border border-destructive/40" /> {t("availCal.blocked", { defaultValue: "Blocked" })}</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded ring-2 ring-secondary" /> {t("availCal.legendUnsaved", { defaultValue: "Unsaved" })}</span>
          {selectedRoomId !== null && (
            <span className="flex items-center gap-1" title={t("availCal.legendInheritedTitle", { defaultValue: "Block originates from the Listing-wide tab and applies to every room" })}>
              <Globe className="w-3 h-3" /> {t("availCal.legendListingWideInherited", { defaultValue: "Listing-wide (inherited)" })}
            </span>
          )}
        </div>

        {editingDate && (() => {
          const eff = effectiveByDate.get(editingDate);
          return (
            <div className="bg-muted/50 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-sm">{t("availCal.editDate", { defaultValue: "Edit {{date}}", date: editingDate })}</p>
                <Button variant="ghost" size="icon" className="rounded-full h-7 w-7" onClick={() => setEditingDate(null)}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">{t("availCal.customPriceLabel", { defaultValue: "Custom price (₹/night):" })}</label>
                <input
                  type="number" value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  placeholder={t("availCal.placeholderBlankDefault", { defaultValue: "leave blank for default" })}
                  className="flex-1 px-2 py-1 border border-border rounded-lg text-xs bg-background outline-none focus:ring-2 focus:ring-primary/20"
                />
                <Button size="sm" variant="outline" className="rounded-lg text-xs" onClick={() => applyEdit("price")} disabled={!priceInput}>{t("availCal.setPrice", { defaultValue: "Set price" })}</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {eff?.blocked ? (
                  // A listing-wide block can't be unblocked from a room tab —
                  // the row lives at the listing scope and the canonical
                  // helper would still mark the date blocked even after we
                  // wrote a roomTypeId=…, blocked=false row. Surface that
                  // constraint instead of silently dropping the host's edit.
                  eff?.inherited ? (
                    <Button size="sm" variant="outline" className="rounded-lg text-xs" disabled
                      title={t("availCal.listingWideBlockTitle", { defaultValue: "This date is blocked listing-wide. Switch to the Listing-wide tab to unblock it for every room." })}>
                      {t("availCal.listingWideBlock", { defaultValue: "Listing-wide block" })}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="rounded-lg text-xs" onClick={() => applyEdit("unblock")}>{t("availCal.unblock", { defaultValue: "Unblock" })}</Button>
                  )
                ) : (
                  <Button size="sm" variant="outline" className="rounded-lg text-xs text-destructive" onClick={() => applyEdit("block")}>{t("availCal.blockThisDay", { defaultValue: "Block this day" })}</Button>
                )}
                {(eff?.blocked || eff?.pricePaise != null) && !eff?.inherited && (
                  <Button size="sm" variant="ghost" className="rounded-lg text-xs" onClick={() => applyEdit("clear")}>{t("availCal.resetToDefault", { defaultValue: "Reset to default" })}</Button>
                )}
              </div>
              {eff?.inherited && (
                <p className="text-[11px] text-muted-foreground">
                  {t("availCal.inheritedNote", { defaultValue: "Inherited from listing-wide blocks — applies to every room." })}
                </p>
              )}
            </div>
          );
        })()}

        <div className="flex gap-3 pt-2 border-t border-border">
          <Button variant="outline" className="flex-1 rounded-xl" onClick={onClose} disabled={saveMutation.isPending}>{t("availCal.close", { defaultValue: "Close" })}</Button>
          <Button className="flex-1 rounded-xl" disabled={!hasUnsaved || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? (
              <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {t("availCal.saving", { defaultValue: "Saving…" })}</span>
            ) : hasUnsaved ? t("availCal.saveChanges", { defaultValue: "Save {{count}} change", defaultValue_plural: "Save {{count}} changes", count: Object.keys(pending).length }) : t("availCal.saved", { defaultValue: "Saved" })}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default AvailabilityCalendar;
