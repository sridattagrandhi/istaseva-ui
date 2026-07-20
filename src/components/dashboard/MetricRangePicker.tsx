// Analytics period picker — quick trailing-day buttons plus a popover with
// named periods (this/last month, calendar year, India Apr–Mar financial
// years), a month grid, and an exact-dates calendar. Extracted from
// AdminLayout so the partner dashboards' Insights tab shares the identical
// control (and label semantics) with the admin analytics pages.
import { useMemo, useState } from "react";
import { Calendar as CalendarRange, Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AdminRangeCalendar, ymdLocal } from "./metric-ui";

/** Trailing-days window or inclusive YYYY-MM-DD calendar range. */
export type MetricRange = { days: number } | { from: string; to: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const QUICK = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

// ── Calendar-range helpers (India financial year = Apr 1 → Mar 31) ──
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m 1-based
function todayStr() { return new Date().toISOString().slice(0, 10); }

/** "12 Mar – 4 Apr 2026" (year only on `from` when the ends differ). */
function rangeLabel(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  const short: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const fs = f.toLocaleDateString("en-IN", f.getFullYear() === t.getFullYear() ? short : { ...short, year: "numeric" });
  return `${fs} – ${t.toLocaleDateString("en-IN", { ...short, year: "numeric" })}`;
}

type NamedPeriod = { key: string; label: string; range: MetricRange };
function buildNamedPeriods(): NamedPeriod[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-based
  const today = todayStr();
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const fyStart = m >= 4 ? y : y - 1; // India FY starts in April
  return [
    { key: "this-month", label: "This month", range: { from: ymd(y, m, 1), to: today } },
    { key: "last-month", label: "Last month", range: { from: ymd(py, pm, 1), to: ymd(py, pm, lastDay(py, pm)) } },
    { key: "this-year", label: "This year", range: { from: ymd(y, 1, 1), to: today } },
    { key: "this-fy", label: `FY ${fyStart}-${String(fyStart + 1).slice(2)}`, range: { from: ymd(fyStart, 4, 1), to: today } },
    { key: "last-fy", label: `FY ${fyStart - 1}-${String(fyStart).slice(2)}`, range: { from: ymd(fyStart - 1, 4, 1), to: ymd(fyStart, 3, 31) } },
  ];
}

export function MetricRangePicker({ value, onChange }: { value: MetricRange; onChange: (range: MetricRange) => void }) {
  const named = useMemo(buildNamedPeriods, []);
  const [customLabel, setCustomLabel] = useState<string | null>(null); // active named/month label
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
  const [pickerOpen, setPickerOpen] = useState(false);
  // In-progress calendar selection; only a COMPLETE from→to pair is applied.
  const [draftRange, setDraftRange] = useState<DateRange | undefined>();
  const [calendarOpen, setCalendarOpen] = useState(false);

  const isQuick = (d: number) => "days" in value && value.days === d;
  const selectQuick = (d: number) => { onChange({ days: d }); setCustomLabel(null); setDraftRange(undefined); };
  const selectNamed = (p: NamedPeriod) => { onChange(p.range); setCustomLabel(p.label); setDraftRange(undefined); setPickerOpen(false); };
  const selectMonth = (m: number) => {
    const label = `${MONTHS[m - 1]} ${pickerYear}`;
    onChange({ from: ymd(pickerYear, m, 1), to: ymd(pickerYear, m, lastDay(pickerYear, m)) });
    setCustomLabel(label);
    setDraftRange(undefined);
    setPickerOpen(false);
  };
  const selectCalendarRange = (r: DateRange | undefined) => {
    setDraftRange(r);
    if (!r?.from || !r?.to) return; // wait for both ends before firing queries
    const from = ymdLocal(r.from);
    const to = ymdLocal(r.to);
    onChange({ from, to });
    setCustomLabel(rangeLabel(from, to));
    setPickerOpen(false);
    setCalendarOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-xl border border-border bg-card p-0.5 shadow-sm">
        {QUICK.map((q) => (
          <button key={q.days} onClick={() => selectQuick(q.days)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              isQuick(q.days) ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}>
            {q.label}
          </button>
        ))}
      </div>

      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-sm transition-colors ${
              customLabel ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:bg-muted/60"
            }`}
          >
            <CalendarRange className="h-3.5 w-3.5" />
            {customLabel ?? "Custom range"}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 rounded-2xl p-0">
          <div className="p-2">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Periods</p>
            {named.map((n) => {
              const active = customLabel === n.label;
              return (
                <button key={n.key} onClick={() => selectNamed(n)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                    active ? "bg-primary/10 font-semibold text-primary" : "text-foreground hover:bg-muted/60"
                  }`}>
                  {n.label}
                  {active && <Check className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-border/60 p-2">
            <div className="flex items-center justify-between px-1 pb-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pick a month</p>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPickerYear((y) => y - 1)} className="rounded-md p-1 hover:bg-muted/60" aria-label="Previous year">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="w-10 text-center text-xs font-semibold tabular-nums">{pickerYear}</span>
                <button onClick={() => setPickerYear((y) => y + 1)} className="rounded-md p-1 hover:bg-muted/60" aria-label="Next year">
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {MONTHS.map((m, i) => {
                const active = customLabel === `${m} ${pickerYear}`;
                return (
                  <button key={m} onClick={() => selectMonth(i + 1)}
                    className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${
                      active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted/60"
                    }`}>
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="border-t border-border/60 p-2">
            <button
              onClick={() => setCalendarOpen((o) => !o)}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/60"
            >
              <span className="inline-flex items-center gap-2">
                <CalendarRange className="h-3.5 w-3.5 opacity-60" />
                Pick exact dates
              </span>
              <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform ${calendarOpen ? "rotate-180" : ""}`} />
            </button>
            {calendarOpen && (
              <div className="mt-1 flex justify-center">
                <AdminRangeCalendar
                  selected={draftRange}
                  onSelect={selectCalendarRange}
                  // Analytics are historical — a future end date would
                  // just render empty days, so keep it unselectable.
                  disabled={{ after: new Date() }}
                />
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
