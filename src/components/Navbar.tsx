import { useState, useEffect, useRef } from "react";
import { Link, useLocation as useRouterLocation, useNavigate } from "react-router-dom";
import {
  Menu,
  X,
  Languages,
  ChevronDown,
  LogOut,
  LayoutDashboard,
  MessageCircle,
  ShieldCheck,
  Compass,
  BedDouble,
  Sparkles,
  Car,
  BarChart3,
  Smartphone,
  Lock,
  FileText,
  Calendar,
  Heart,
  Bell,
  Store,
  Home,
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage, languages } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { lastDashboardPath, recordDashboardVisit } from "@/lib/last-dashboard";
import { UserAvatar } from "@/components/UserAvatar";
import { NotificationsBell } from "@/components/NotificationsBell";
import { GlobalSearch } from "@/components/search/GlobalSearch";

// Match the 1500px content shell (redesign .section-block/.discovery-feed and
// the dashboards' max-w-[1500px]) so the nav pill spans the same width as the
// page below it instead of floating narrower on wide monitors.
const NAV_MAX_WIDTH = 1500;

const navItems = [
  { path: "/", labelKey: "nav.discovery", fallback: "Discovery", icon: Compass },
  { path: "/services", labelKey: "nav.services", fallback: "Services", icon: Sparkles },
  { path: "/transport", labelKey: "nav.transport", fallback: "Transport", icon: Car },
  { path: "/explore", labelKey: "nav.stays", fallback: "Stays", icon: BedDouble },
];

// Provider-mode nav pills — shown instead of the marketplace tabs while the
// user is on any /dashboard/* route. Mirrors mobile's Profile→Switch
// dashboard triad (store/car/home). Sub-tabs inside each dashboard are
// unchanged; this only swaps the top-level nav.
const providerNavItems = [
  { path: "/dashboard/provider", labelKey: "nav.role.Provider", fallback: "Provider", icon: Store },
  { path: "/dashboard/transport", labelKey: "nav.role.Transport", fallback: "Transport", icon: Car },
  { path: "/dashboard/host", labelKey: "nav.role.Host", fallback: "Host", icon: Home },
];

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { language, setLanguage, t } = useLanguage();
  const { user, isAuthenticated, logout, logoutAllDevices } = useAuth();
  const location = useRouterLocation();
  const navigate = useNavigate();

  useEffect(() => { setIsOpen(false); setLangOpen(false); setUserMenuOpen(false); }, [location.pathname]);

  // Remember the last provider-side dashboard visited so "Switch to
  // provider" returns the user there (used to live in DashboardRoleSwitcher).
  useEffect(() => { recordDashboardVisit(location.pathname); }, [location.pathname]);

  // Close the profile dropdown on any outside click. The old `fixed inset-0`
  // backdrop didn't work here: the nav shell's backdrop-filter makes it the
  // containing block for fixed descendants, so the "full-screen" backdrop
  // only ever covered the navbar itself — clicks on the page below never hit
  // it. Document-level listener instead (same pattern as PackagePopover).
  const userMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (userMenuRef.current?.contains(e.target as Node)) return;
      setUserMenuOpen(false);
    };
    // Capture phase: page widgets (the discovery hero carousel among them)
    // stopPropagation on mousedown for their own drag handling, which would
    // starve a bubble-phase listener and leave the menu stuck open.
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () => document.removeEventListener("mousedown", onDocMouseDown, true);
  }, [userMenuOpen]);

  const currentLang = languages.find((l) => l.code === language);
  // Provider mode: any /dashboard/* route swaps the marketplace tabs for the
  // Provider / Transport / Host pills.
  const isProviderMode = location.pathname.startsWith("/dashboard");
  const activeNavItems = isProviderMode ? providerNavItems : navItems;
  const handleLogout = () => { logout(); setUserMenuOpen(false); navigate("/"); };
  const handleLogoutAll = async () => {
    setUserMenuOpen(false);
    if (!window.confirm(translate("nav.logoutAllConfirm", "Sign out of all devices? You'll need to sign in again everywhere."))) return;
    const revoked = await logoutAllDevices();
    toast[revoked ? "success" : "error"](
      revoked
        ? translate("nav.logoutAllDone", "Signed out of all devices.")
        : translate("nav.logoutAllFailed", "Signed out here, but other devices may still be active.")
    );
    navigate("/");
  };

  const translate = (key: string, fallback: string) => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  };

  return (
    <header className="sticky top-0 z-50 px-3 sm:px-4 pt-3 sm:pt-3.5">
      <div
        className="mx-auto grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-6 rounded-[22px] border border-white/70 bg-white/60 px-2.5 py-2 shadow-[0_18px_60px_rgba(34,31,39,0.10)] backdrop-blur-2xl backdrop-saturate-150"
        style={{ maxWidth: NAV_MAX_WIDTH }}
      >
        {/* Brand — keeps the original IstaSeva "IS" wordmark, recolored to the new palette */}
        <Link
          to="/"
          className="group inline-flex items-center gap-2.5"
          aria-label="IstaSeva — home"
        >
          <span
            className="inline-grid h-11 w-11 place-items-center rounded-2xl text-white font-extrabold shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_26px_rgba(58,50,71,0.18)] transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:scale-[1.03]"
            style={{
              background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #c08a5a 100%)",
            }}
          >
            <span className="text-[15px] tracking-tight">iS</span>
          </span>
          <span className="hidden sm:block leading-tight">
            <span className="block font-display text-[17px] font-extrabold text-foreground">
              Ista<span className="text-accent">Seva</span>
            </span>
            <span className="block text-[11px] font-semibold text-muted-foreground">
              {translate("nav.tagline", "Serving communities")}
            </span>
          </span>
        </Link>

        {/* Center nav pills — only on lg+ to mirror redesign topbar */}
        <nav className="hidden lg:flex items-center justify-center gap-1" aria-label={translate("nav.mainNav", "Main navigation")}>
          {activeNavItems.map((item) => {
            const Icon = item.icon;
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={[
                  "inline-flex items-center gap-2 min-h-[40px] rounded-full px-3 py-2 text-[13px] font-bold transition-all duration-200",
                  active
                    ? "text-foreground bg-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_8px_20px_rgba(58,50,71,0.10)]"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/55",
                ].join(" ")}
              >
                <Icon className="h-[17px] w-[17px]" />
                <span>{translate(item.labelKey, item.fallback)}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right actions */}
        <div className="flex items-center justify-end gap-2">
          {/* Global search — "Search everything ⌘K", cross-category, on every
              page. Additive: the per-vertical search bars are untouched. */}
          <GlobalSearch />
          {/* Language */}
          <div className="relative hidden md:block">
            <button
              type="button"
              onClick={() => { setLangOpen((v) => !v); setUserMenuOpen(false); }}
              className="inline-flex items-center gap-2 min-h-[40px] rounded-full border border-white/70 bg-white/55 px-3 py-2 text-[13px] font-bold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:bg-white/75"
            >
              <Languages className="h-[17px] w-[17px]" />
              <span className="hidden xl:inline">{currentLang?.nativeName || translate("nav.english", "English")}</span>
              <ChevronDown className={`h-3 w-3 transition-transform ${langOpen ? "rotate-180" : ""}`} />
            </button>
            {langOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setLangOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-white/70 bg-white/95 py-2 shadow-[0_28px_86px_rgba(34,31,39,0.16)] backdrop-blur-xl">
                  {languages.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => { setLanguage(lang.code); setLangOpen(false); }}
                      className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors hover:bg-muted/60 ${
                        language === lang.code ? "font-semibold text-accent" : "text-foreground"
                      }`}
                    >
                      <span>{lang.nativeName}</span>
                      <span className="text-xs text-muted-foreground">{lang.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {isAuthenticated && user ? (
            <>
              {/* Role-side switch: on any dashboard → back to the user-facing
                  marketplace; on marketplace pages → over to the provider
                  side (last-visited provider dashboard, else /dashboard/provider). */}
              <Link
                to={isProviderMode ? "/" : lastDashboardPath()}
                className="hidden md:inline-flex items-center gap-2 min-h-[40px] rounded-full border border-white/70 bg-white/55 px-3 py-2 text-[13px] font-bold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:bg-white/75"
              >
                <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
                {isProviderMode
                  ? translate("nav.switchToUser", "Switch to user")
                  : translate("nav.switchToProvider", "Switch to provider")}
              </Link>
              {/* Global notifications bell — one entry point app-wide,
                  replacing the per-dashboard dropdown bells. */}
              <NotificationsBell />
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => { setUserMenuOpen((v) => !v); setLangOpen(false); }}
                  className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/55 py-1.5 pl-1.5 pr-3 transition-all hover:bg-white/75"
                  aria-label={translate("nav.accountMenu", "Account menu")}
                >
                  <UserAvatar
                    className="h-7 w-7 rounded-full bg-primary text-[11px] font-bold text-primary-foreground"
                    initials={user.avatar || (user.name?.[0] ?? "U").toUpperCase()}
                  />
                  <span className="hidden lg:inline max-w-[110px] truncate text-[13px] font-bold text-foreground">
                    {user.name?.split(" ")[0] || translate("nav.account", "Account")}
                  </span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
                {userMenuOpen && (
                  <>
                    <div className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-2xl border border-white/70 bg-white/95 py-2 shadow-[0_28px_86px_rgba(34,31,39,0.16)] backdrop-blur-xl">
                      <div className="border-b border-border/60 px-4 py-2.5">
                        <p className="text-sm font-semibold text-foreground">{user.name}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </div>
                      {user.role === "admin" && (
                        <Link to="/admin" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-muted/60">
                          <BarChart3 className="h-4 w-4" /> {translate("nav.adminDashboard", "Admin dashboard")}
                        </Link>
                      )}
                      {/* User-side account pages. The four per-role dashboard
                          links moved out of here — the seller side is reached
                          via the "Switch to provider" toggle, and wishlist /
                          bookings / notifications are standalone pages now. */}
                      <Link to="/bookings" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/60">
                        <Calendar className="h-4 w-4" /> {translate("nav.myBookings", "My Bookings")}
                      </Link>
                      <Link to="/wishlist" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/60">
                        <Heart className="h-4 w-4" /> {translate("nav.myWishlist", "My Wishlist")}
                      </Link>
                      <Link to="/notifications" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/60">
                        <Bell className="h-4 w-4" /> {translate("notifDropdown.title", "Notifications")}
                      </Link>
                      <Link to="/messages" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/60">
                        <MessageCircle className="h-4 w-4" /> {translate("nav.messages", "Messages")}
                      </Link>
                      <Link to="/provider/verification" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/60">
                        <ShieldCheck className="h-4 w-4" /> {translate("nav.verification", "Verification")}
                      </Link>
                      {/* Standalone profile page: identity, preferences, and the
                          Privacy & data panel (PRIV-002). */}
                      <Link to="/profile" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/60">
                        <Lock className="h-4 w-4" /> {translate("nav.profile", "Profile & privacy")}
                      </Link>
                      <Link to="/terms" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/60">
                        <FileText className="h-4 w-4" /> {translate("nav.termsPolicies", "Terms & policies")}
                      </Link>
                      <button
                        onClick={handleLogoutAll}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60"
                      >
                        <Smartphone className="h-4 w-4" /> {translate("nav.logoutAll", "Sign out all devices")}
                      </button>
                      <button
                        onClick={handleLogout}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-destructive transition-colors hover:bg-muted/60"
                      >
                        <LogOut className="h-4 w-4" /> {translate("nav.logout", "Log out")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="hidden sm:inline-flex items-center gap-2 min-h-[40px] rounded-full border border-white/70 bg-white/55 px-3 py-2 text-[13px] font-bold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:bg-white/75"
              >
                {translate("login", "Login")}
              </Link>
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 min-h-[40px] rounded-full px-4 py-2 text-[13px] font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)] transition-transform hover:-translate-y-0.5"
                style={{ background: "linear-gradient(135deg, #2b2436, #8b5e4a)" }}
              >
                {translate("nav.createAccount", "Create account")}
              </Link>
            </>
          )}

          {/* Mobile menu trigger */}
          <button
            type="button"
            onClick={() => setIsOpen((v) => !v)}
            className="lg:hidden inline-grid h-10 w-10 place-items-center rounded-full border border-white/70 bg-white/55 text-foreground transition-all hover:bg-white/75"
            aria-label={isOpen ? translate("nav.closeMenu", "Close menu") : translate("nav.openMenu", "Open menu")}
          >
            {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {isOpen && (
        <div
          className="lg:hidden mx-auto mt-2 overflow-hidden rounded-[22px] border border-white/70 bg-white/85 px-3 py-3 shadow-[0_18px_60px_rgba(34,31,39,0.10)] backdrop-blur-2xl"
          style={{ maxWidth: NAV_MAX_WIDTH }}
        >
          <nav className="grid gap-1" aria-label={translate("nav.mobileNav", "Mobile navigation")}>
            {activeNavItems.map((item) => {
              const Icon = item.icon;
              const active = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={[
                    "flex items-center gap-2 rounded-2xl px-3 py-2.5 text-sm font-bold transition-all",
                    active
                      ? "bg-white text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-white/70 hover:text-foreground",
                  ].join(" ")}
                >
                  <Icon className="h-4 w-4" />
                  {translate(item.labelKey, item.fallback)}
                </Link>
              );
            })}
          </nav>

          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/70 pt-3">
            {languages.map((lang) => (
              <button
                key={lang.code}
                onClick={() => setLanguage(lang.code)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${
                  language === lang.code
                    ? "bg-primary text-primary-foreground"
                    : "bg-white/70 text-muted-foreground hover:bg-white"
                }`}
              >
                {lang.nativeName}
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-2 border-t border-white/70 pt-3">
            {isAuthenticated && user ? (
              <>
                <Link to="/bookings" className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-foreground">
                  <Calendar className="h-4 w-4" /> {translate("nav.myBookings", "My Bookings")}
                </Link>
                <Link to="/wishlist" className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-foreground">
                  <Heart className="h-4 w-4" /> {translate("nav.myWishlist", "My Wishlist")}
                </Link>
                <Link to="/notifications" className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-foreground">
                  <Bell className="h-4 w-4" /> {translate("notifDropdown.title", "Notifications")}
                </Link>
                <Link
                  to={isProviderMode ? "/" : lastDashboardPath()}
                  className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-foreground"
                >
                  <LayoutDashboard className="h-4 w-4" />
                  {isProviderMode
                    ? translate("nav.switchToUser", "Switch to user")
                    : translate("nav.switchToProvider", "Switch to provider")}
                </Link>
                <Link to="/messages" className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-foreground">
                  <MessageCircle className="h-4 w-4" /> {translate("nav.messages", "Messages")}
                </Link>
                <Link to="/profile" className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-foreground">
                  <Lock className="h-4 w-4" /> {translate("nav.profile", "Profile & privacy")}
                </Link>
                <button
                  onClick={handleLogout}
                  className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-destructive"
                >
                  <LogOut className="h-4 w-4" /> {translate("nav.logout", "Log out")}
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="flex items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2.5 text-sm font-bold text-foreground">
                  {translate("login", "Login")}
                </Link>
                <Link
                  to="/signup"
                  className="flex items-center justify-center gap-2 rounded-full px-3 py-2.5 text-sm font-extrabold text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)]"
                  style={{ background: "linear-gradient(135deg, #2b2436, #8b5e4a)" }}
                >
                  {translate("nav.createAccount", "Create account")}
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
};

export default Navbar;
