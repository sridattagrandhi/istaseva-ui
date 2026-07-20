// Themed time picker — drop-in replacement for `<input type="time">` in the
// onboarding form. The native control renders an OS-default 3-column wheel
// that clashes with the rest of the warm-neutral redesign (blue Apple
// highlight, scrollable wheel, sans-default chrome). This component:
//
//   • Displays the picked time as a friendly "11:38 AM" pill that matches
//     the rounded glass-tile aesthetic used by the rest of onboarding.
//   • Opens a popover with three columns — hour (1–12), minute (step 5),
//     and AM/PM — rendered as clickable buttons. The selected value glows
//     with the same dark foreground that the day/slot pills use elsewhere.
//   • Stores and emits values in 24-hour "HH:MM" so the OnboardingProfile
//     and downstream backend keep their existing contract; only the
//     display layer is 12-hour.
//
// `compact` shrinks the trigger for inline use inside the working-hours
// per-weekday strip where horizontal space is at a premium.

import { useEffect, useMemo, useRef, useState } from "react";
import { Clock } from "lucide-react";

interface ThemedTimePickerProps {
  /** 24-hour "HH:MM" string. Empty string = unset. */
  value: string;
  onChange: (next: string) => void;
  /** Compact trigger used inside the working-hours weekly strip. */
  compact?: boolean;
  /** Optional aria-label so the trigger reads sensibly for screen readers. */
  ariaLabel?: string;
}

function parseHHMM(value: string): { h24: number; m: number } | null {
  const match = (value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h24: h, m };
}

function formatHHMM(h24: number, m: number): string {
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function display12h(value: string): string {
  const parsed = parseHHMM(value);
  if (!parsed) return "";
  const period = parsed.h24 >= 12 ? "PM" : "AM";
  const h12 = ((parsed.h24 + 11) % 12) + 1;
  return `${h12}:${String(parsed.m).padStart(2, "0")} ${period}`;
}

const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1);
// Step-5 minutes keep the column scannable without losing precision —
// most check-in / check-out / working-hour times land on a 5-minute grid.
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

export function ThemedTimePicker({ value, onChange, compact, ariaLabel }: ThemedTimePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Derive the active hour / minute / period from the current "HH:MM"
  // string. When the field is empty we default the popover state to 9:00 AM
  // so the user sees something selected rather than an empty grid.
  const parsed = useMemo(() => parseHHMM(value) ?? { h24: 9, m: 0 }, [value]);
  const period: "AM" | "PM" = parsed.h24 >= 12 ? "PM" : "AM";
  const h12 = ((parsed.h24 + 11) % 12) + 1;

  const commit = (next: { h12?: number; m?: number; period?: "AM" | "PM" }) => {
    const newH12 = next.h12 ?? h12;
    const newM = next.m ?? parsed.m;
    const newPeriod = next.period ?? period;
    // Convert back to 24-hour for the stored value.
    let h24 = newH12 % 12;
    if (newPeriod === "PM") h24 += 12;
    onChange(formatHHMM(h24, newM));
  };

  const triggerClass = compact
    ? "inline-flex items-center gap-1.5 rounded-md border border-border bg-white/85 px-2 py-1 text-xs font-semibold text-foreground hover:bg-white"
    : "flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-semibold text-foreground hover:bg-white outline-none focus:ring-2 focus:ring-primary/20";

  const label = display12h(value);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-label={ariaLabel || "Pick time"}
        className={triggerClass}
      >
        <span className={label ? "" : "text-muted-foreground"}>{label || "--:-- --"}</span>
        <Clock className={compact ? "h-3 w-3 text-muted-foreground" : "h-4 w-4 text-muted-foreground"} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[260px] rounded-2xl border border-border bg-white p-3 shadow-[0_22px_60px_rgba(34,31,39,0.18)]">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            {/* Hours column */}
            <div>
              <p className="mb-1 text-center text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">Hr</p>
              <div className="grid max-h-48 grid-cols-3 gap-1 overflow-y-auto pr-0.5">
                {HOURS_12.map((hr) => {
                  const active = hr === h12;
                  return (
                    <button
                      key={hr}
                      type="button"
                      onClick={() => commit({ h12: hr })}
                      className={`h-8 rounded-lg text-xs font-bold transition-colors ${
                        active
                          ? "bg-foreground text-white shadow-sm"
                          : "text-foreground hover:bg-muted"
                      }`}
                    >
                      {hr}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Minutes column */}
            <div>
              <p className="mb-1 text-center text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">Min</p>
              <div className="grid max-h-48 grid-cols-3 gap-1 overflow-y-auto pr-0.5">
                {MINUTES.map((min) => {
                  const active = min === parsed.m;
                  return (
                    <button
                      key={min}
                      type="button"
                      onClick={() => commit({ m: min })}
                      className={`h-8 rounded-lg text-xs font-bold transition-colors ${
                        active
                          ? "bg-foreground text-white shadow-sm"
                          : "text-foreground hover:bg-muted"
                      }`}
                    >
                      {String(min).padStart(2, "0")}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* AM/PM toggle */}
            <div>
              <p className="mb-1 text-center text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">&nbsp;</p>
              <div className="grid gap-1">
                {(["AM", "PM"] as const).map((p) => {
                  const active = p === period;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => commit({ period: p })}
                      className={`h-8 w-12 rounded-lg text-xs font-bold transition-colors ${
                        active
                          ? "bg-foreground text-white shadow-sm"
                          : "border border-border text-foreground hover:bg-muted"
                      }`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <footer className="mt-2 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] font-semibold text-foreground hover:underline"
            >
              Done
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
