// Remembers the provider-side dashboard the user last visited so the
// "Switch to provider" toggle can return them there. Previously lived in
// DashboardRoleSwitcher (deleted when the in-dashboard role pills moved to
// the global navbar). Consumed by Navbar and the post-login redirect.
export const LAST_DASHBOARD_KEY = "istasewa_last_dashboard";

const PROVIDER_DASHBOARD_PATHS = new Set([
  "/dashboard/provider",
  "/dashboard/transport",
  "/dashboard/host",
]);

export function recordDashboardVisit(pathname: string) {
  if (!PROVIDER_DASHBOARD_PATHS.has(pathname)) return;
  try {
    localStorage.setItem(LAST_DASHBOARD_KEY, pathname);
  } catch { /* quota / private mode — ignore */ }
}

export function lastDashboardPath(): string {
  try {
    const last = localStorage.getItem(LAST_DASHBOARD_KEY);
    // Older builds could have persisted /dashboard/guest here; that page no
    // longer exists, so fall through to the provider dashboard.
    if (last && PROVIDER_DASHBOARD_PATHS.has(last)) return last;
  } catch { /* ignore */ }
  return "/dashboard/provider";
}
