// "Custom" range pill for the partner Earnings tabs (host / provider /
// transport share it). Renders alongside the existing Week/Month/… pills and
// opens a two-month calendar; applying an exact [from, to] switches the
// panel's range state to "custom". Historical dates allowed, future blocked.
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Calendar as CalendarIcon, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { AdminRangeCalendar, ymdLocal } from "./metric-ui";

export type CustomEarningsRange = { from: string; to: string };

/** "12 Mar – 4 Apr 2026" (year only on `from` when the ends differ). */
export function customRangeLabel(r: CustomEarningsRange): string {
  const f = new Date(`${r.from}T00:00:00`);
  const t = new Date(`${r.to}T00:00:00`);
  const short: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const fs = f.toLocaleDateString("en-IN", f.getFullYear() === t.getFullYear() ? short : { ...short, year: "numeric" });
  return `${fs} – ${t.toLocaleDateString("en-IN", { ...short, year: "numeric" })}`;
}

export function EarningsRangePill({ active, value, onApply }: {
  /** Whether the panel's range state is currently "custom". */
  active: boolean;
  value: CustomEarningsRange | null;
  onApply: (r: CustomEarningsRange) => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  const label = active && value ? customRangeLabel(value) : t("dash.earn.custom", { defaultValue: "Custom" });

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(undefined); }}>
      <PopoverTrigger asChild>
        <button
          className={`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all inline-flex items-center gap-1 ${
            active ? "bg-primary text-primary-foreground shadow-sm" : "bg-card border border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <CalendarIcon className="h-3 w-3" />{label}<ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-3">
        <AdminRangeCalendar
          selected={draft}
          onSelect={setDraft}
          disabled={{ after: new Date() }}
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="rounded-lg text-xs" onClick={() => setOpen(false)}>
            {t("dash.earn.customCancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            size="sm"
            className="rounded-lg text-xs"
            disabled={!draft?.from}
            onClick={() => {
              if (!draft?.from) return;
              const from = ymdLocal(draft.from);
              const to = ymdLocal(draft.to ?? draft.from);
              onApply(from <= to ? { from, to } : { from: to, to: from });
              setOpen(false);
            }}
          >
            {t("dash.earn.customApply", { defaultValue: "Apply" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
