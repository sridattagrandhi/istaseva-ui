import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Navigate, Outlet, useLocation, useOutletContext } from "react-router-dom";
import { BarChart3, Compass, TrendingUp, MessagesSquare, ShieldAlert, IndianRupee, Store, MapPin, ScrollText, ListChecks, CalendarClock, TicketPercent, Users, Percent, Banknote } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { adminMetrics, EMPTY_ADMIN_FILTER, type AdminMetricFilter, type AdminRange } from "@/domains/analytics/admin-metrics.service";
import { MetricRangePicker } from "@/components/dashboard/MetricRangePicker";
import { AdminFilterBar } from "./adminUi";

// Analytics tabs that expose the listing filter bar (tiles backed by
// bookings/listings/payments). Others (Revenue/Discovery/…) ignore it.
const FILTERABLE_PATHS = new Set(["/admin", "/admin/providers", "/admin/geographic", "/admin/customers"]);

// Sidebar sections: read-only analytics vs. operational tooling. Ops pages
// ignore the time-range picker and carry their own filters.
const NAV_SECTIONS = [
  {
    title: "Analytics",
    items: [
      { to: "/admin", end: true, label: "Overview", icon: BarChart3 },
      { to: "/admin/revenue", end: false, label: "Revenue", icon: IndianRupee },
      { to: "/admin/discovery", end: false, label: "Discovery", icon: Compass },
      { to: "/admin/conversion", end: false, label: "Conversion", icon: TrendingUp },
      { to: "/admin/engagement", end: false, label: "Engagement", icon: MessagesSquare },
      { to: "/admin/providers", end: false, label: "Providers", icon: Store },
      { to: "/admin/geographic", end: false, label: "Geographic", icon: MapPin },
      { to: "/admin/customers", end: false, label: "Customers", icon: Users },
    ],
  },
  {
    title: "Operations",
    items: [
      { to: "/admin/bookings", end: false, label: "Bookings", icon: CalendarClock },
      { to: "/admin/fraud", end: false, label: "Fraud", icon: ShieldAlert },
      { to: "/admin/listings", end: false, label: "Listings", icon: ListChecks },
      { to: "/admin/coupons", end: false, label: "Coupons", icon: TicketPercent },
      { to: "/admin/fees", end: false, label: "Fees", icon: Percent },
      { to: "/admin/payouts", end: false, label: "Payouts", icon: Banknote },
      { to: "/admin/audit", end: false, label: "Audit", icon: ScrollText },
    ],
  },
];

const NAV = NAV_SECTIONS.flatMap((s) => s.items); // mobile nav stays flat

type AdminContext = { range: AdminRange; filter: AdminMetricFilter };

/** Pages read the selected window (trailing days OR calendar range) from here. */
export function useAdminRange() {
  return useOutletContext<AdminContext>().range;
}

/** Analytics filter (vertical/category/geo/listing) — empty on tabs that hide the bar. */
export function useAdminFilter() {
  return useOutletContext<AdminContext>().filter;
}

export default function AdminLayout() {
  const { user, isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const [range, setRange] = useState<AdminRange>({ days: 30 });
  const [filter, setFilter] = useState<AdminMetricFilter>(EMPTY_ADMIN_FILTER);
  const showFilterBar = FILTERABLE_PATHS.has(location.pathname);
  // Rollups are written nightly — surface how fresh the analytics actually
  // are so "today looks empty" reads as staleness, not a drop.
  const freshQ = useQuery({
    queryKey: ["admin-freshness"],
    queryFn: adminMetrics.freshness,
    enabled: isAuthenticated && user?.role === "admin",
    staleTime: 5 * 60_000,
  });

  if (loading) return null;
  if (!isAuthenticated || user?.role !== "admin") {
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground/40" />
        <h1 className="font-display text-xl font-bold">Admins only</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This area requires the <code className="rounded bg-muted px-1">admin</code> role. Ask an administrator to grant it to your account.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-[1500px] gap-6 px-4 py-6">
      <aside className="hidden w-52 shrink-0 md:block">
        <div className="mb-4 px-2">
          <p className="font-display text-lg font-bold">Admin</p>
          <p className="text-xs text-muted-foreground">Analytics & operations</p>
        </div>
        <nav className="space-y-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{section.title}</p>
              <div className="space-y-1">
                {section.items.map(({ to, end, label, icon: Icon }) => (
                  <NavLink key={to} to={to} end={end}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                        isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60"
                      }`}>
                    <Icon className="h-4 w-4" />
                    {label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <nav className="flex gap-1 md:hidden">
            {NAV.map(({ to, end, label }) => (
              <NavLink key={to} to={to} end={end}
                className={({ isActive }) =>
                  `rounded-lg px-2 py-1.5 text-xs font-medium ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}>
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {freshQ.data?.latestDay && (
              <p className="text-xs text-muted-foreground" title="Analytics rollups run nightly; later activity isn't counted yet.">
                Data through {freshQ.data.latestDay}
              </p>
            )}
            <MetricRangePicker value={range} onChange={setRange} />
          </div>
        </div>

        {showFilterBar && (
          <div className="mb-5">
            <AdminFilterBar filter={filter} onChange={setFilter} />
          </div>
        )}

        <Outlet context={{ range, filter: showFilterBar ? filter : EMPTY_ADMIN_FILTER } satisfies AdminContext} />
      </main>
    </div>
  );
}
