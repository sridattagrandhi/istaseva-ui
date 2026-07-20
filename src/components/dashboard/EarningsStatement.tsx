// Period earnings statement for the partner dashboards' Payment settings tab:
// how the period's gross became net (gross − refunds − commission), from
// /api/providers/me/earnings. The authoritative "owed right now" number stays
// with PayoutsSection (/me/payouts) — this is the period reconciliation next
// to it, in the same spirit as the admin Revenue breakdown ledger.
//
// The filter row mirrors the Earnings tab's set (Week/Month/Year/FY/All +
// custom calendar + FY stepper + optional listing filter) so both surfaces
// slice earnings the same way. The server resolves explicit from/to dates
// ahead of the legacy `range` param, so every mode maps onto from/to except
// "all" (range=all → all-time).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { Panel, StateNote, fmt, ymdLocal } from "./metric-ui";
import { EarningsRangePill, customRangeLabel, type CustomEarningsRange } from "./EarningsRangePill";
import { DashFilterSelect } from "./DashFilterSelect";

interface EarningsData {
  from: string | null;
  to: string | null;
  totals: {
    earnings: number;   // rupees (not paise) — /me/earnings returns rupees
    bookings: number;
    commission: number;
    net: number;
    refunds?: number;   // absent on older servers
    discounts?: number;
  };
}

type RangeKey = "week" | "month" | "year" | "fy" | "all" | "custom";

const inr = (r: number) => `${r < 0 ? "−" : ""}₹${fmt(Math.abs(Math.round(r)))}`;

export function EarningsStatement({ type, listings }: {
  /** Scope to one marketplace vertical so the statement matches the rest of
   *  the dashboard it sits on (host = stay, provider = service, transport). */
  type?: "stay" | "service" | "transport";
  /** Optional per-listing filter (host dashboard passes its live properties;
   *  provider/transport aggregate by category and omit it, matching the
   *  Earnings tab). Shown only when there is more than one listing. */
  listings?: Array<{ id: string; name: string }>;
}) {
  const { t } = useLanguage();
  const now = new Date();
  // fyYear = the April-start year of the FY being viewed (e.g. 2025 = FY 25-26)
  const currentFyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const [range, setRange] = useState<RangeKey>("month");
  const [fyYear, setFyYear] = useState(currentFyYear);
  const [customRange, setCustomRange] = useState<CustomEarningsRange | null>(null);
  const [listingFilter, setListingFilter] = useState<string>("all");

  // Resolve the window the same way the Earnings tab does; the server gives
  // explicit from/to precedence over `range`.
  const period = useMemo((): { from?: string; to?: string; all?: boolean } => {
    const today = ymdLocal(now);
    if (range === "all") return { all: true };
    if (range === "custom" && customRange) return { from: customRange.from, to: customRange.to };
    if (range === "fy") {
      const end = `${fyYear + 1}-03-31`;
      return { from: `${fyYear}-04-01`, to: end < today ? end : today };
    }
    const d = new Date(now);
    if (range === "week") d.setDate(d.getDate() - 7);
    else if (range === "month") d.setMonth(d.getMonth() - 1);
    else d.setFullYear(d.getFullYear() - 1); // year
    return { from: ymdLocal(d), to: today };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, fyYear, customRange]);

  const { data, isLoading } = useQuery({
    queryKey: ["earnings-statement", range, fyYear, customRange, listingFilter, type ?? null],
    staleTime: 60_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (period.all) params.set("range", "all");
      else {
        if (period.from) params.set("from", period.from);
        if (period.to) params.set("to", period.to);
      }
      if (type) params.set("type", type);
      if (listingFilter !== "all") params.set("listingId", listingFilter);
      const result = await apiRequest<{ data: EarningsData }>(
        `/api/providers/me/earnings?${params.toString()}`,
        { headers: getJsonHeaders(false) },
      );
      if (!result.success || !result.data) throw new Error(result.error || "Failed to load earnings");
      return result.data.data;
    },
  });

  const totals = data?.totals;
  const refunds = totals?.refunds ?? 0;
  const discounts = totals?.discounts ?? 0;
  const netAfterRefunds = totals ? totals.earnings - refunds - totals.commission : 0;

  const rows = totals
    ? [
        { label: t("partner.statement.gross", { defaultValue: "Gross earnings" }), value: totals.earnings, sub: t("partner.statement.grossSub", { defaultValue: "{{count}} bookings delivered", count: totals.bookings }) },
        { label: t("partner.statement.refunds", { defaultValue: "Refunds issued" }), value: -refunds },
        { label: t("partner.statement.commission", { defaultValue: "Platform commission" }), value: -totals.commission },
        { label: t("partner.statement.net", { defaultValue: "Net earnings" }), value: netAfterRefunds, strong: true },
      ]
    : [];

  const fyLabel = `FY ${String(fyYear).slice(2)}-${String(fyYear + 1).slice(2)}`;
  const rangeTabs: Array<{ id: RangeKey; label: string }> = [
    { id: "week", label: t("dash.earn.week", { defaultValue: "Last 7 days" }) },
    { id: "month", label: t("dash.earn.month", { defaultValue: "Last 30 days" }) },
    { id: "year", label: t("dash.earn.year", { defaultValue: "Last 12 months" }) },
    { id: "fy", label: t("dash.earn.fy", { defaultValue: "Fin. Year" }) },
    { id: "all", label: t("dash.earn.all", { defaultValue: "All time" }) },
  ];

  return (
    <Panel
      title={t("partner.statement.title", { defaultValue: "Earnings statement" })}
      subtitle={t("partner.statement.subtitle", { defaultValue: "How this period's gross becomes your net" })}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(listings?.length ?? 0) > 1 && (
          <DashFilterSelect
            value={listingFilter}
            onChange={setListingFilter}
            ariaLabel={t("dash.earn.allListings", { defaultValue: "All listings" })}
            options={[
              { value: "all", label: t("dash.earn.allListings", { defaultValue: "All listings" }) },
              ...(listings ?? []).map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {rangeTabs.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                range === r.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-card border border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
          <EarningsRangePill
            active={range === "custom"}
            value={customRange}
            onApply={(r) => { setCustomRange(r); setRange("custom"); }}
          />
          {range === "fy" && (
            <div className="flex items-center gap-1 bg-card border border-border rounded-full px-2 py-1">
              <button
                onClick={() => setFyYear((y) => y - 1)}
                className="w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70"
              >‹</button>
              <span className="text-xs font-semibold px-1 whitespace-nowrap">{fyLabel}</span>
              <button
                onClick={() => setFyYear((y) => Math.min(y + 1, currentFyYear))}
                disabled={fyYear >= currentFyYear}
                className="w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70 disabled:opacity-30"
              >›</button>
            </div>
          )}
        </div>
      </div>
      {range === "custom" && customRange && (
        <p className="mb-2 text-xs text-muted-foreground">{customRangeLabel(customRange)}</p>
      )}
      {isLoading ? (
        <StateNote>{t("partner.statement.loading", { defaultValue: "Loading…" })}</StateNote>
      ) : !totals ? (
        <StateNote>{t("partner.statement.error", { defaultValue: "Couldn't load your statement." })}</StateNote>
      ) : (
        <>
          <table className="w-full text-sm">
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-border/60 first:border-t-0">
                  <td className={`py-2.5 ${row.strong ? "font-semibold" : "text-muted-foreground"}`}>
                    {row.label}
                    {row.sub && <span className="ml-2 text-xs font-normal text-muted-foreground">{row.sub}</span>}
                  </td>
                  <td className={`py-2.5 text-right tabular-nums ${row.strong ? "font-semibold" : ""}`}>{inr(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            {discounts > 0 &&
              t("partner.statement.discountsNote", { defaultValue: "Includes ₹{{amount}} in discounts you funded, already reflected in gross. ", amount: fmt(Math.round(discounts)) })}
            {t("partner.statement.payoutNote", { defaultValue: "Amounts owed and paid out are tracked below — this statement covers services delivered in the period." })}
          </p>
        </>
      )}
    </Panel>
  );
}
