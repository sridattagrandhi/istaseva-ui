// Render smoke tests for the partner Insights tab pieces — the repo has no
// react-testing-library, so mount with react-dom directly. Catches runtime
// render errors (bad imports, chart misuse) that tsc can't see.
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Deterministic chart mounting: jsdom has no layout, so the real
// ResponsiveContainer measures 0×0 and re-renders on a ResizeObserver tick
// whose timing shifts under full-suite load (the source of this file's
// flakiness). Pin it to fixed dimensions so charts render identically on
// every run and machine.
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("recharts")>();
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div style={{ width: 800, height: 300 }}>
        {React.cloneElement(children, { width: 800, height: 300 } as Partial<unknown>)}
      </div>
    ),
  };
});

vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}));

const apiRequest = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  getJsonHeaders: () => ({}),
}));

// jsdom has no layout engine — stub ResizeObserver so Recharts'
// ResponsiveContainer can mount (it renders a 0×0 chart, which is fine here).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const INSIGHTS = {
  from: "2026-06-08",
  to: "2026-07-08",
  series: [
    { day: "2026-06-10", bookings: 3, cancelled: 1 },
    { day: "2026-06-12", bookings: 5, cancelled: 0 },
  ],
  statusMix: [{ status: "confirmed", count: 7 }],
  cancelReasons: [{ reason: "plans_changed", count: 2 }],
  paymentFailures: [{ reason: "card_declined", count: 1 }],
  repeat: { bookers: 4, repeatBookers: 1, repeatRate: 25, medianDaysToSecond: 9 },
  leadTime: { medianDays: 3, avgDays: 4.2 },
  searchDemand: [{ term: "goa villa", count: 12 }],
  funnel: {
    totals: { views: 40, cardClicks: 12, modalOpens: 6, paymentStarts: 3, bookings: 2 },
    byListing: [
      { listingId: "l1", name: "Sea View", views: 30, cardClicks: 9, modalOpens: 4, paymentStarts: 2, bookings: 1 },
      { listingId: "l2", name: "Hill View", views: 10, cardClicks: 3, modalOpens: 2, paymentStarts: 1, bookings: 1 },
    ],
  },
};

async function renderInDom(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(ui); });
  return { container, cleanup: () => { act(() => root.unmount()); container.remove(); } };
}

// Poll (inside act) until the rendered text satisfies `ready`. A fixed number
// of setTimeout(0) ticks was enough on an idle machine but not under
// full-suite load, where react-query's settle can land a few macrotasks
// later — that made this file flaky. On timeout we return normally and let
// the caller's assertion produce the real failure message.
async function settle(container: HTMLElement, ready: (text: string) => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (!ready(container.textContent ?? "")) {
    if (Date.now() - start > timeoutMs) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
}

describe("InsightsPanel", () => {
  it("renders KPIs and panels from the insights payload", async () => {
    apiRequest.mockResolvedValue({ success: true, data: { data: INSIGHTS } });
    const { InsightsPanel } = await import("./InsightsPanel");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container, cleanup } = await renderInDom(
      <QueryClientProvider client={qc}>
        <InsightsPanel category="stay" />
      </QueryClientProvider>,
    );
    await settle(container, (t) => t.includes("Bookings received") && t.includes("Sea View"));

    const text = container.textContent ?? "";
    expect(apiRequest).toHaveBeenCalledWith(expect.stringContaining("category=stay"), expect.anything());
    expect(text).toContain("Bookings received");
    expect(text).toContain("25%"); // repeat rate
    expect(text).toContain("plans changed"); // cancel reason, de-snake-cased
    expect(text).toContain("card declined"); // payment failure
    expect(text).toContain("goa villa"); // search demand
    expect(text).toContain("Sea View"); // per-listing funnel table
    cleanup();
  });

  it("shows the funnel empty state when totals are all zero", async () => {
    apiRequest.mockResolvedValue({
      success: true,
      data: { data: { ...INSIGHTS, funnel: { totals: { views: 0, cardClicks: 0, modalOpens: 0, paymentStarts: 0, bookings: 0 }, byListing: [] } } },
    });
    const { InsightsPanel } = await import("./InsightsPanel");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container, cleanup } = await renderInDom(
      <QueryClientProvider client={qc}>
        <InsightsPanel category="transport" />
      </QueryClientProvider>,
    );
    await settle(container, (t) => t.includes("No funnel data"));
    expect(container.textContent).toContain("No funnel data");
    cleanup();
  });
});

describe("MetricRangePicker", () => {
  it("renders quick buttons and fires onChange for a trailing window", async () => {
    const { MetricRangePicker } = await import("./MetricRangePicker");
    const onChange = vi.fn();
    const { container, cleanup } = await renderInDom(<MetricRangePicker value={{ days: 30 }} onChange={onChange} />);
    await settle(container, (t) => t.includes("7d"));
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "7d");
    expect(btn).toBeTruthy();
    await act(async () => { btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    // Radix Popover schedules a few async updates on mount/interaction — let
    // them flush inside act so no update lands after the test environment
    // tears down (the "not configured to support act" warnings under load).
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(onChange).toHaveBeenCalledWith({ days: 7 });
    cleanup();
  });
});
