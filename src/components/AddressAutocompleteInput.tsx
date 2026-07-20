import { useEffect, useMemo, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";

type AddressSuggestion = {
  id: string;
  description: string;
  mainText: string;
  secondaryText: string;
};

type AddressAutocompleteInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Optional — fires with the FULL picked suggestion (including the
   *  Google `place_id` in `id`). Callers that need to resolve the pick
   *  into lat/lng + admin hierarchy use this; the bare `onChange` only
   *  carries the display text. Free typing (no pick) doesn't fire this. */
  onSelectSuggestion?: (suggestion: AddressSuggestion) => void;
  /** Suggestion scope, forwarded to the backend proxy. "regions" (default)
   *  returns settlements only — right for the stays city/town search.
   *  "address" is unrestricted (includes establishments like hotels) — use
   *  it for street-address fields (at-home service address, pickup point). */
  mode?: "regions" | "address";
  wrapperClassName?: string;
  inputClassName?: string;
};

export default function AddressAutocompleteInput({
  value,
  onChange,
  onSelectSuggestion,
  mode,
  wrapperClassName,
  inputClassName,
  onFocus,
  onBlur,
  ...props
}: AddressAutocompleteInputProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const input = value.trim();
    if (input.length < 3) {
      setSuggestions([]);
      setActive(-1);
      return;
    }

    const requestId = ++requestIdRef.current;
    const handle = window.setTimeout(async () => {
      const res = await apiRequest<{ suggestions: AddressSuggestion[] }>("/api/geocode/autocomplete", {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify({ input, ...(mode ? { mode } : {}) }),
      });
      if (requestId !== requestIdRef.current) return;
      setSuggestions(res.success ? res.data?.suggestions ?? [] : []);
      setActive(-1);
    }, 180);

    return () => window.clearTimeout(handle);
  }, [value, mode]);

  const listId = useMemo(() => `address-suggestions-${Math.random().toString(36).slice(2, 8)}`, []);

  const selectSuggestion = (suggestion: AddressSuggestion) => {
    onChange(suggestion.description);
    onSelectSuggestion?.(suggestion);
    setOpen(false);
    setSuggestions([]);
    setActive(-1);
  };

  return (
    <div className={wrapperClassName ?? "relative"}>
      <input
        {...props}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={(event) => {
          setOpen(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          window.setTimeout(() => setOpen(false), 120);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (!open || suggestions.length === 0) {
            props.onKeyDown?.(event);
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((idx) => Math.min(suggestions.length - 1, idx + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((idx) => Math.max(0, idx - 1));
          } else if (event.key === "Enter" && active >= 0) {
            event.preventDefault();
            selectSuggestion(suggestions[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          } else {
            props.onKeyDown?.(event);
          }
        }}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listId}
        className={inputClassName ?? props.className}
      />
      {open && suggestions.length > 0 && (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-[2000] overflow-hidden rounded-xl border border-border bg-background shadow-xl"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.id || suggestion.description}
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSuggestion(suggestion)}
              className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                index === active ? "bg-muted text-foreground" : "bg-background text-foreground hover:bg-muted"
              }`}
            >
              <span className="block truncate font-semibold">{suggestion.mainText || suggestion.description}</span>
              {suggestion.secondaryText && (
                <span className="block truncate text-[11px] font-medium text-muted-foreground">{suggestion.secondaryText}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
