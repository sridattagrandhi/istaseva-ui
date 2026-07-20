import { useState, KeyboardEvent } from "react";
import { X, Plus } from "lucide-react";

/**
 * Text input + Add button that builds up an array of distinct chip values.
 *
 * Used wherever a provider needs to list many short labels of the same kind
 * — service subcategories ("beard trim", "hair cut", "nails"), tutor topics,
 * etc. Replaces the old single free-text field that forced everything into
 * one comma-separated string.
 *
 * Behaviour:
 *   - Enter or the Add button commits the current input as a new chip.
 *   - Trimmed; empty / duplicate (case-insensitive) inputs are ignored so
 *     the array stays clean.
 *   - Each chip has an X to remove individually.
 *   - Order preserved — first chip wins for callers that need a primary
 *     value (legacy `metadata.subcategory` keeps the first entry).
 */
export function ChipListInput({
  value,
  onChange,
  placeholder,
  inputClassName,
  emptyHint,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  inputClassName?: string;
  emptyHint?: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const next = draft.trim();
    if (!next) return;
    // De-duplicate case-insensitively but preserve the user's casing on the
    // first occurrence — "Beard Trim" then "beard trim" stays as "Beard Trim".
    if (value.some((v) => v.toLowerCase() === next.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, next]);
    setDraft("");
  };

  const remove = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={
            inputClassName
            ?? "flex-1 px-3 py-2.5 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
          }
        />
        <button
          type="button"
          onClick={commit}
          disabled={!draft.trim()}
          className="inline-flex items-center gap-1 rounded-xl border border-border bg-background px-3 py-2 text-xs font-bold text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((chip, idx) => (
            <span
              key={`${chip}-${idx}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 pl-2.5 pr-1 py-1 text-[11px] font-semibold text-foreground"
            >
              {chip}
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label={`Remove ${chip}`}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : emptyHint ? (
        <p className="text-[11px] text-muted-foreground">{emptyHint}</p>
      ) : null}
    </div>
  );
}
