import React, { Suspense, lazy, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { SavedProvider } from "@/contexts/SavedContext";
import { LocationProvider } from "@/contexts/LocationContext";
import { LocationScopeProvider } from "@/contexts/LocationScopeContext";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import CookieConsentBanner from "@/components/consent/CookieConsentBanner";
import TermsReconsentDialog from "@/components/legal/TermsReconsentDialog";
import ReviewPromptGate from "@/components/ReviewPromptGate";
import ScrollToTop from "@/components/ScrollToTop";

// Route-level code splitting: every page is loaded on demand via React.lazy so
// the initial download is just the shell (providers + router + navbar). This
// keeps heavy, rarely-first-visited areas — the admin portal, dashboards,
// recharts, the redesign's maps — out of the entry chunk. See the <Suspense>
// boundary around <Routes> below.
const BecomeHost = lazy(() => import("./pages/BecomeHost"));
const BecomeProvider = lazy(() => import("./pages/BecomeProvider"));
const About = lazy(() => import("./pages/About"));
const Contact = lazy(() => import("./pages/Contact"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));
const Licenses = lazy(() => import("./pages/Licenses"));
const Grievance = lazy(() => import("./pages/Grievance"));
const RefundPolicy = lazy(() => import("./pages/RefundPolicy"));
const DeleteAccount = lazy(() => import("./pages/DeleteAccount"));
const Login = lazy(() => import("./pages/Login"));
const Signup = lazy(() => import("./pages/Signup"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Bookings = lazy(() => import("./pages/Bookings"));
const Wishlist = lazy(() => import("./pages/Wishlist"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Profile = lazy(() => import("./pages/Profile"));
const HostDashboard = lazy(() => import("./pages/HostDashboard"));
const ProviderDashboard = lazy(() => import("./pages/ProviderDashboard"));
const TransportDashboard = lazy(() => import("./pages/TransportDashboard"));
const AIOnboarding = lazy(() => import("./pages/AIOnboarding"));
const ProviderVerification = lazy(() => import("./pages/ProviderVerification"));
const SafetyCenter = lazy(() => import("./pages/SafetyCenter"));
const Messages = lazy(() => import("./pages/Messages"));
const AdminLayout = lazy(() => import("./pages/admin/AdminLayout"));
const AdminOverview = lazy(() => import("./pages/admin/AdminOverview"));
const AdminRevenue = lazy(() => import("./pages/admin/AdminRevenue"));
const AdminDiscovery = lazy(() => import("./pages/admin/AdminDiscovery"));
const AdminConversion = lazy(() => import("./pages/admin/AdminConversion"));
const AdminEngagement = lazy(() => import("./pages/admin/AdminEngagement"));
const AdminProviders = lazy(() => import("./pages/admin/AdminProviders"));
const AdminGeographic = lazy(() => import("./pages/admin/AdminGeographic"));
const AdminCustomers = lazy(() => import("./pages/admin/AdminCustomers"));
const AdminAudit = lazy(() => import("./pages/admin/AdminAudit"));
const AdminListings = lazy(() => import("./pages/admin/AdminListings"));
const AdminBookings = lazy(() => import("./pages/admin/AdminBookings"));
const AdminFraud = lazy(() => import("./pages/admin/AdminFraud"));
const AdminCoupons = lazy(() => import("./pages/admin/AdminCoupons"));
const AdminFees = lazy(() => import("./pages/admin/AdminFees"));
const AdminPayouts = lazy(() => import("./pages/admin/AdminPayouts"));
const AdminListingCreate = lazy(() => import("./pages/admin/AdminListingCreate"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Verify = lazy(() => import("./pages/Verify"));
const ClientRedesign = lazy(() => import("./redesign/ClientRedesign"));
const StayDetailPage = lazy(() => import("./redesign/MarketplaceDetailPages").then((m) => ({ default: m.StayDetailPage })));
const ServiceDetailPage = lazy(() => import("./redesign/MarketplaceDetailPages").then((m) => ({ default: m.ServiceDetailPage })));
const TransportDetailPage = lazy(() => import("./redesign/MarketplaceDetailPages").then((m) => ({ default: m.TransportDetailPage })));

// The Ista AI assistant is always mounted but never part of the first paint —
// lazy-load its chunk (conversation engine + voice hooks) and defer mounting
// until the browser is idle so it stays off the critical path.
const AssistantWidget = lazy(() =>
  import("@/components/assistant/AssistantWidget").then((m) => ({ default: m.AssistantWidget })),
);

const queryClient = new QueryClient();

// Minimal, unobtrusive fallback shown while a lazily-loaded route chunk is
// fetched. Sits below the (eager) navbar so the shell stays stable.
const RouteFallback = () => (
  <div className="min-h-[60vh] flex items-center justify-center bg-background" role="status" aria-live="polite">
    <span className="h-6 w-6 rounded-full border-2 border-muted border-t-primary animate-spin" aria-hidden="true" />
    <span className="sr-only">Loading…</span>
  </div>
);

// Mounts the assistant chunk only after the browser goes idle, so its JS never
// competes with first paint. Behaviour is otherwise identical to rendering the
// widget directly (it manages its own open/auth-gate state).
const DeferredAssistantWidget = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setReady(true), 1500);
    return () => window.clearTimeout(id);
  }, []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <AssistantWidget />
    </Suspense>
  );
};

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; resetKey?: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Component stack included so a report of "Something went wrong" can be
    // traced to the throwing component, not just the error message.
    console.error("App error boundary caught an error", error, info.componentStack);
    // Also persist the last crash so it survives the reload the error screen
    // asks for — "Something went wrong" reports are otherwise stackless.
    try {
      window.localStorage.setItem("istaseva:last-app-error", JSON.stringify({
        at: new Date().toISOString(),
        path: window.location.pathname + window.location.search,
        message: error?.message,
        stack: String(error?.stack || "").slice(0, 4000),
        componentStack: String(info?.componentStack || "").slice(0, 4000),
      }));
    } catch { /* quota / private mode — ignore */ }
  }

  componentDidUpdate(prevProps: { resetKey?: string }) {
    // Un-latch on navigation. The boundary used to hold `hasError` until a
    // full reload, so a single transient render throw (e.g. on a detail
    // page) kept showing this screen after the user pressed Back — the
    // previous, perfectly healthy page never got to re-render. A changed
    // resetKey (the pathname) means new route content: re-attempt the render.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false });
    window.location.assign(window.location.pathname);
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-6">
          <div className="max-w-md text-center space-y-4">
            <h1 className="font-display text-3xl font-extrabold text-foreground">Something went wrong</h1>
            <p className="text-muted-foreground">
              The app hit an unexpected error. Refreshing usually gets us back on track.
            </p>
            <Button onClick={this.handleRetry} className="rounded-xl">
              Reload app
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/** Feeds the current pathname into the boundary as its reset key. Must live
 *  INSIDE BrowserRouter (useLocation), which is also the point: the boundary
 *  needs to see route changes to recover from a latched error. */
const RoutedErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
};

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, loading, verificationStep, user } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Checking your session...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Admins are staff accounts and skip the guest email/phone verification flow.
  if (user?.role !== "admin" && verificationStep !== "complete") {
    return <Navigate to="/verify" replace />;
  }

  return <>{children}</>;
};

// Global guard: any authenticated user with incomplete verification gets
// pushed to /verify, regardless of which public route they tried to load.
// Public marketing routes are still browsable when logged out — this only
// kicks in once a user has signed in but hasn't finished email + phone.
const VERIFICATION_EXEMPT_PATHS = new Set([
  "/verify",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
]);

const VerificationGuard = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, loading, verificationStep, user } = useAuth();
  const location = useLocation();

  if (loading) return <>{children}</>;
  // Admins are staff accounts — they don't go through the guest email/phone
  // verification flow, so they never get bounced to /verify.
  if (
    isAuthenticated &&
    user?.role !== "admin" &&
    verificationStep !== "complete" &&
    !VERIFICATION_EXEMPT_PATHS.has(location.pathname)
  ) {
    return <Navigate to="/verify" replace />;
  }
  return <>{children}</>;
};

const REDESIGNED_MARKETPLACE_PATHS = new Set(["/", "/explore", "/services", "/transport"]);

const redesignedRoutes = {
  discovery: "/",
  stays: "/explore",
  services: "/services",
  transport: "/transport",
} as const;

const MarketplaceRedesignRoute = ({
  initialPage,
}: {
  initialPage: "discovery" | "stays" | "services" | "transport";
}) => {
  const navigate = useNavigate();

  return (
    <ClientRedesign
      initialPage={initialPage}
      onRouteChange={(page) => navigate(redesignedRoutes[page])}
      onLogin={() => navigate("/login")}
      onSignup={() => navigate("/signup")}
    />
  );
};

const ChatRedirect = () => {
  const { userId } = useParams();
  return (
    <Navigate
      to={userId ? `/messages?user=${encodeURIComponent(userId)}` : "/messages"}
      replace
    />
  );
};

// Legacy guest-dashboard deep-links (notification emails, bookmarks). The
// guest dashboard was dissolved into standalone pages — forward its
// `?booking=<id>` links to /bookings (which understands the same param) and
// its saved tab to /wishlist.
const GuestDashboardRedirect = () => {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (params.get("tab") === "saved") return <Navigate to="/wishlist" replace />;
  params.delete("tab");
  const qs = params.toString();
  return <Navigate to={`/bookings${qs ? `?${qs}` : ""}`} replace />;
};

const AppChrome = () => {
  const location = useLocation();
  const usesRedesignChrome = REDESIGNED_MARKETPLACE_PATHS.has(location.pathname);

  return (
    <>
      <ScrollToTop />
      <Navbar />
      <VerificationGuard>
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<MarketplaceRedesignRoute initialPage="discovery" />} />
          <Route path="/explore" element={<MarketplaceRedesignRoute initialPage="stays" />} />
          <Route path="/services" element={<MarketplaceRedesignRoute initialPage="services" />} />
          <Route path="/transport" element={<MarketplaceRedesignRoute initialPage="transport" />} />
          {/* Redesigned, mock-backed marketplace detail pages. The legacy
              StayDetail / ServiceDetail components (kept in src/pages/) will
              be reintroduced once their backend data models stabilise. */}
          <Route path="/stay/:id" element={<StayDetailPage />} />
          <Route path="/service/:id" element={<ServiceDetailPage />} />
          <Route path="/transport/:id" element={<TransportDetailPage />} />
          <Route path="/become-host" element={<BecomeHost />} />
          <Route path="/become-provider" element={<BecomeProvider />} />
          <Route path="/become-partner" element={<BecomeProvider />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
          {/* Legal & disclosure surfaces (PRIV-001 / LEG-001 / LEG-017).
              /delete-account must stay publicly reachable — Google Play
              requires a no-login deletion URL. */}
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/licenses" element={<Licenses />} />
          <Route path="/grievance" element={<Grievance />} />
          <Route path="/refunds" element={<RefundPolicy />} />
          <Route path="/delete-account" element={<DeleteAccount />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/verify-email" element={<Navigate to="/verify" replace />} />
          <Route path="/verify-phone" element={<Navigate to="/verify" replace />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/bookings" element={<ProtectedRoute><Bookings /></ProtectedRoute>} />
          <Route path="/wishlist" element={<ProtectedRoute><Wishlist /></ProtectedRoute>} />
          <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
          {/* Legacy route — already-sent notification emails link here. */}
          <Route path="/dashboard/guest" element={<GuestDashboardRedirect />} />
          <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="/dashboard/host" element={<ProtectedRoute><HostDashboard /></ProtectedRoute>} />
          <Route path="/dashboard/provider" element={<ProtectedRoute><ProviderDashboard /></ProtectedRoute>} />
          <Route path="/dashboard/transport" element={<ProtectedRoute><TransportDashboard /></ProtectedRoute>} />
          <Route path="/dashboard/partner" element={<ProtectedRoute><ProviderDashboard /></ProtectedRoute>} />
          <Route path="/onboarding" element={<ProtectedRoute><AIOnboarding /></ProtectedRoute>} />
          <Route path="/provider/verification" element={<ProtectedRoute><ProviderVerification /></ProtectedRoute>} />
          <Route path="/safety" element={<ProtectedRoute><SafetyCenter /></ProtectedRoute>} />
          <Route path="/messages" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
          {/* Legacy chat deep-link used by already-persisted notification rows
              (the server now emits /messages?user=… directly). */}
          <Route path="/chat/:userId" element={<ChatRedirect />} />
          <Route path="/chat" element={<Navigate to="/messages" replace />} />
          {/* Admin analytics portal — nested pages under one guarded layout.
              AdminLayout enforces the `admin` role; the API independently
              enforces requireRole('admin'). */}
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminOverview />} />
            <Route path="revenue" element={<AdminRevenue />} />
            <Route path="discovery" element={<AdminDiscovery />} />
            <Route path="conversion" element={<AdminConversion />} />
            <Route path="engagement" element={<AdminEngagement />} />
            <Route path="providers" element={<AdminProviders />} />
            <Route path="geographic" element={<AdminGeographic />} />
            <Route path="customers" element={<AdminCustomers />} />
            <Route path="bookings" element={<AdminBookings />} />
            <Route path="fraud" element={<AdminFraud />} />
            <Route path="listings" element={<AdminListings />} />
            <Route path="listings/new" element={<AdminListingCreate />} />
            <Route path="coupons" element={<AdminCoupons />} />
            <Route path="fees" element={<AdminFees />} />
            <Route path="payouts" element={<AdminPayouts />} />
            <Route path="audit" element={<AdminAudit />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </VerificationGuard>
      {!usesRedesignChrome && <Footer />}
      {/* One Ista AI widget across the whole app — redesign pages used to
          render their own prototype "AiConcierge" surface instead; that was
          removed so users see the canonical assistant everywhere. */}
      <DeferredAssistantWidget />
      {/* Cookie/device-tracking consent (LEG-014): analytics stays off until
          the user allows it here. */}
      <CookieConsentBanner />
      {/* Terms re-consent + 18+ attestation backfill (LEG-003): blocks until
          a signed-in user whose recorded terms version is stale re-accepts. */}
      <TermsReconsentDialog />
      {/* Post-completion review prompt: pops the standard ReviewModal once per
          app open for the newest finished-but-unreviewed booking. */}
      <ReviewPromptGate />
    </>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <LanguageProvider>
      <AuthProvider>
        <SavedProvider>
          <LocationProvider>
            <LocationScopeProvider>
            <TooltipProvider>
              <Toaster />
              <Sonner />
              <BrowserRouter>
                <RoutedErrorBoundary>
                  <AppChrome />
                </RoutedErrorBoundary>
              </BrowserRouter>
            </TooltipProvider>
            </LocationScopeProvider>
          </LocationProvider>
        </SavedProvider>
      </AuthProvider>
    </LanguageProvider>
  </QueryClientProvider>
);

export default App;
