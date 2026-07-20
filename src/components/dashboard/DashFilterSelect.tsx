import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Clean shadcn/Radix dropdown for dashboard filter bars (Reviews, etc.).
 * Replaces the bare native <select> pills so dashboard filters match the
 * app-wide Select aesthetic (proper trigger, chevron, popover menu with
 * checkmarks) used across booking modals and the admin ops screens.
 */
export function DashFilterSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={`h-9 w-auto min-w-[8rem] max-w-[14rem] gap-1.5 rounded-full border-border bg-card px-3.5 text-xs font-medium shadow-sm hover:bg-muted/40 focus:ring-2 focus:ring-primary/30 [&>span]:truncate ${className ?? ""}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="rounded-xl">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-sm">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
