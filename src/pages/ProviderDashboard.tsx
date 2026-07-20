import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Wrench, Calendar, Star, TrendingUp, Clock, CheckCircle, BarChart3, MapPin, User,
  Phone, Shield, Package, MessageCircle, Plus, IndianRupee, Ticket, QrCode, Banknote, X,
} from "lucide-react";
import { DashFilterSelect } from "@/components/dashboard/DashFilterSelect";
import { formatLanguageList } from "@/lib/format-languages";
import { UserAvatar } from "@/components/UserAvatar";
import { DashboardProfilePanel } from "@/components/dashboard/DashboardProfilePanel";
import { InsightsPanel } from "@/components/dashboard/InsightsPanel";
import { EarningsStatement } from "@/components/dashboard/EarningsStatement";
import { AwaitingPayoutTile, PayoutAccountCard, PayoutHistoryCard, PayoutNudgeBanner, PayoutStatusTiles } from "@/components/dashboard/PayoutsSection";
import PartnerCouponsTab from "@/components/PartnerCouponsTab";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EarningsTrendCard } from "@/components/dashboard/EarningsTrendCard";
import { EarningsRangePill, customRangeLabel, type CustomEarningsRange } from "@/components/dashboard/EarningsRangePill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import MyListings from "@/components/MyListings";
import { ProviderOnBehalfBookingModal } from "@/redesign/ProviderOnBehalfBookingModal";
import { AddListingChooserDialog } from "@/components/AddListingChooserDialog";
import { getBookingService, getListingService, getProviderService, getReviewService } from "@/domains";
import type { Booking, Listing, Review } from "@/types/domain";
import { effectiveBookingStatus } from "@/lib/booking-status";
import { bookingKindOf } from "@/lib/booking-kind";
import { downloadBookingTaxInvoice } from "@/lib/booking-invoice";
import {
  getServiceBookingDetails,
  getTransportBookingDetails,
  serviceModeLabel,
  transportModeLabel,
} from "@/lib/booking-notes";

// Kept in sync with MyListings — a service/partner should never surface stays,
// and transport gets its own dashboard section so auto/cab jobs don't blur
// together with plumber/electrician ones.
const stayCategories = new Set(["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram"]);
const transportCategories = new Set(["driver-auto", "driver-cab", "auto", "cab", "van", "bike", "tempo"]);
const isStayCategory = (c: string) => stayCategories.has(c);
const isTransportCategory = (c: string) => transportCategories.has(c);
// listing_type is the typed column (DB-enforced via CHECK). We still consult
// metadata.listingType + category as fallbacks for any rows that pre-date the
// backfill or come from endpoints that don't project the column.
const isTransportListing = (l: Listing & { listing_type?: string }) =>
  l?.listing_type === "transport"
  || l?.metadata?.listingType === "transport"
  || isTransportCategory(l?.category);
const isStayListing = (l: Listing & { listing_type?: string }) =>
  l?.listing_type === "stay"
  || l?.metadata?.listingType === "stay"
  || isStayCategory(l?.category);

const ProviderDashboard = () => {
  const { t } = useLanguage();
  // Tab state lives in the URL (?tab=…) so refresh and deep links keep their
  // place. `replace` keeps back-navigation pointed at the previous page, not
  // a trail of tab switches.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || "overview";
  const setActiveTab = (id: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id === "overview") next.delete("tab"); else next.set("tab", id);
      return next;
    }, { replace: true });
  };
  const [bookingDetailsTarget, setBookingDetailsTarget] = useState<Booking | null>(null);
  const [onBehalfOpen, setOnBehalfOpen] = useState(false);
  const [addChooserOpen, setAddChooserOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: allProviderBookings = [] } = useQuery({
    queryKey: ["partner-bookings"],
    enabled: Boolean(user?.id),
    staleTime: 15 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 30 * 1000,
    queryFn: async () => {
      const result = await getBookingService().getProviderBookings(String(user?.id));
      if (!result.success || !result.data) throw new Error(result.error || t("partner.dash.loadFail"));
      return result.data;
    },
  });
  // Partner dashboard shows services-only — transport now has its own page
  // at /dashboard/transport so driver jobs don't intermix with plumber/
  // electrician/cleaner ones. Stays are handled by HostDashboard. Uses the
  // shared bookingKindOf: the old startsWith("stay") check missed mobile-
  // created stays (bare "hotel"/"homestay" categories), which then leaked
  // into this dashboard as phantom "service" jobs.
  const providerBookings = useMemo(
    () => allProviderBookings.filter((b) => bookingKindOf(b.serviceCategory) === "service"),
    [allProviderBookings]
  );

  const { data: liveListings = [] } = useQuery({
    queryKey: ["my-listings", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getListingService().getByUserId(String(user?.id));
      if (!result.success || !result.data) throw new Error(result.error || t("partner.dash.loadListingsFail"));
      return result.data;
    },
  });
  const serviceListings = useMemo(
    () => liveListings.filter((l) => !isStayListing(l) && !isTransportListing(l)),
    [liveListings]
  );
  const transportListings = useMemo(
    () => liveListings.filter((l) => isTransportListing(l)),
    [liveListings]
  );

  const { data: providerProfile } = useQuery({
    queryKey: ["provider-profile", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getProviderService().getProfileByUserId(String(user?.id));
      return result.success ? result.data : null;
    },
  });
  const kycStatus = user?.verificationStatus || "pending";

  // Reviews — the reviews endpoint is keyed by "stay_id" but the column accepts
  // any listing UUID (no FK), so we can fetch per-service reviews the same way.
  // If the schema grows a dedicated service-review table later, swap this out.
  // Reviews are scoped to service listings only. Transport reviews must never
  // appear in the provider dashboard reviews section.
  const reviewListings = useMemo(() => serviceListings, [serviceListings]);
  const { data: partnerReviews = [] } = useQuery({
    queryKey: ["partner-reviews", reviewListings.map((l) => l.id).join(",")],
    enabled: reviewListings.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        reviewListings.map(async (listing) => {
          const response = await getReviewService().getByStayId(listing.id);
          return response.success && response.data
            ? response.data.map((r) => ({ ...r, service: listing.name, listingId: listing.id }))
            : [];
        })
      );
      return results.flat();
    },
  });

  // Client-derived status — no background worker flips bookings to completed on
  // its own, so we compute on the fly from scheduledDate/startTime/endTime.
  const statusMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of providerBookings) m[b.id] = effectiveBookingStatus(b);
    return m;
  }, [providerBookings]);

  // Convenience slices used in multiple places. Only real bookings arrive on
  // the provider scope — the backend filters unpaid ('pending') and lapsed
  // ('expired') holds, so every row here is paid, completed, or cancelled.
  const upcomingBookings = useMemo(
    () => providerBookings
      .filter((b) => ["confirmed", "in_progress"].includes(statusMap[b.id] || ""))
      .sort((a, b) => `${a.scheduledDate}T${a.startTime}`.localeCompare(`${b.scheduledDate}T${b.startTime}`)),
    [providerBookings, statusMap]
  );
  const completedBookings = useMemo(
    () => providerBookings.filter((b) => statusMap[b.id] === "completed"),
    [providerBookings, statusMap]
  );

  // Display the true total the customer paid (base + platform + GST + insurance
  // − discount), surfaced via the LATERAL-joined payment breakdown on the
  // booking row. Falls back to agreedPricePaise for legacy / unpaid rows so
  // the cell never goes blank. Same fallback drives `amountFor` so the
  // earnings calculations stay consistent with what's shown on the card.
  const formatPrice = (b: Booking) => {
    const paise = (typeof b?.totalPaidPaise === "number" && b.totalPaidPaise > 0)
      ? b.totalPaidPaise
      : b?.agreedPricePaise;
    return paise ? `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "";
  };
  const amountFor = (b: Booking) => {
    const paise = (typeof b?.totalPaidPaise === "number" && b.totalPaidPaise > 0)
      ? b.totalPaidPaise
      : b?.agreedPricePaise;
    return paise ? paise / 100 : 0;
  };

  const formatTime = (time: string) => {
    if (!time) return "";
    const [h, m] = time.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${(m || 0).toString().padStart(2, "0")} ${ampm}`;
  };
  const normalizeDate = (s: string) => (s?.includes("T") ? s.split("T")[0] : s);
  const formatDate = (s: string) => {
    if (!s) return "";
    const d = new Date(`${normalizeDate(s)}T00:00:00`);
    return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  };
  const isToday = (s: string) => normalizeDate(s) === new Date().toISOString().slice(0, 10);

  // Stats tiles — all derived, no mocks. Shows "—" instead of NaN when empty.
  const totalEarnings = completedBookings.reduce((a, b) => a + amountFor(b), 0);
  const avgRating = partnerReviews.length > 0
    ? (partnerReviews.reduce((sum, r) => sum + r.rating, 0) / partnerReviews.length).toFixed(1)
    : "—";
  const activeCount = providerBookings.filter((b) => ["confirmed", "in_progress"].includes(statusMap[b.id] || "")).length;
  // Repeat rate = % of completed jobs whose customer has ≥ 2 total completed
  // jobs with this partner. Honest real-data metric we can compute right now.
  const repeatRate = (() => {
    if (completedBookings.length === 0) return "—";
    const byCustomer = new Map<string, number>();
    for (const b of completedBookings) byCustomer.set(b.userId, (byCustomer.get(b.userId) || 0) + 1);
    const repeats = [...byCustomer.values()].filter((n) => n >= 2).reduce((a, n) => a + n, 0);
    return completedBookings.length > 0 ? `${Math.round((repeats / completedBookings.length) * 100)}%` : "—";
  })();

  const stats = [
    { label: t("partner.dash.stats.earnings"),    value: totalEarnings > 0 ? `₹${(totalEarnings / 1000).toFixed(1)}K` : "₹0", icon: IndianRupee, desc: t("partner.dash.stats.completedJobs") },
    { label: t("partner.dash.stats.jobsDone"),    value: completedBookings.length.toString(),                                   icon: CheckCircle, desc: t("partner.dash.stats.completedJobs") },
    { label: t("partner.dash.stats.rating"),      value: avgRating,                                                              icon: Star,        desc: partnerReviews.length > 0 ? t("partner.dash.stats.reviewCount", { count: partnerReviews.length }) : t("partner.dash.stats.noReviews") },
    { label: t("partner.dash.stats.repeatRate"),  value: repeatRate,                                                             icon: TrendingUp,  desc: t("partner.dash.stats.returningClients") },
  ];
  // Overview stat tiles deep-link to their detail tab on click.
  const statTabs = ["earnings", "requests", "reviews", "insights"];

  const bookingStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "confirmed" | "cancelled" }) => {
      const result = await getBookingService().updateBookingStatus(id, status, "provider");
      if (!result.success) throw new Error(result.error || t("partner.dash.updateFail"));
      return status;
    },
    onSuccess: async (status) => {
      await queryClient.invalidateQueries({ queryKey: ["partner-bookings"] });
      toast.success(status === "confirmed" ? t("partner.dash.jobAccepted") : t("partner.dash.requestCancelled"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const handleLogout = () => { logout(); navigate("/"); toast.success(t("partner.dash.loggedOut")); };

  // Post-onboarding deep-link → land on the Listings tab so the user
  // sees the one they just created. The provider dashboard lists all
  // listings flat (no per-listing selection state today), so we can't
  // "preselect" beyond switching to the right tab. Strip the param
  // either way to keep the URL clean.
  // TODO: when per-listing detail UX lands, scroll-to-card the
  // matching id here.
  useEffect(() => {
    const targetId = searchParams.get("listing");
    if (!targetId) return;
    setActiveTab("listings");
    const next = new URLSearchParams(searchParams);
    next.delete("listing");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Notification deep-link → open booking details modal.
  useEffect(() => {
    const targetId = searchParams.get("booking");
    if (!targetId || !providerBookings?.length) return;
    const match = providerBookings.find((b) => b.id === targetId);
    if (!match) return;
    setActiveTab("requests");
    setBookingDetailsTarget(match);
    const next = new URLSearchParams(searchParams);
    next.delete("booking");
    setSearchParams(next, { replace: true });
  }, [searchParams, providerBookings]);

  // Canonical partner tab order (mirrors Host/Transport + mobile):
  // Overview · Analytics · My Services · My Bookings · My Reviews ·
  // Earnings · Payment settings · Coupons · Profile.
  // Coupons are scoped to this provider's service listings only — a
  // transport coupon (created from the driver dashboard) won't show up
  // here, and a coupon created here can't be redeemed against a stay or
  // transport booking (server enforces the category gate).
  const tabs = [
    { id: "overview",       label: t("partner.dash.tabs.overview"),       icon: BarChart3 },
    { id: "insights",       label: t("partner.dash.tabs.insights", { defaultValue: "Analytics" }), icon: Activity },
    { id: "listings",       label: t("partner.dash.tabs.listings"),       icon: Package },
    { id: "requests",       label: t("partner.dash.tabs.requests", { defaultValue: "My Bookings" }), icon: Clock },
    { id: "reviews",        label: t("partner.dash.tabs.reviews", { defaultValue: "My Reviews" }), icon: Star },
    { id: "earnings",       label: t("partner.dash.tabs.earnings"),       icon: TrendingUp },
    { id: "payouts",        label: t("partner.dash.tabs.payouts", { defaultValue: "Payment settings" }), icon: Banknote },
    { id: "coupons",        label: t("host.dash.tabs.coupons", { defaultValue: "Coupons" }), icon: Ticket },
    { id: "profile",        label: t("partner.dash.tabs.profile"),        icon: User },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Header — no more top-level Available/Unavailable toggle. Availability
            is now per-service/per-transport, controlled via MyListings' Active
            toggle on each card (same pattern Hosts use per-property). */}
        <div className="mb-6 rounded-[18px] border border-white/70 bg-white/64 p-5 sm:p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <UserAvatar
                className="h-14 w-14 rounded-2xl text-white text-lg font-extrabold shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_26px_rgba(58,50,71,0.18)]"
                style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #c08a5a 100%)" }}
                initials={user?.avatar || (user?.name || "P").slice(0, 2).toUpperCase()}
              />
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight">{t("partner.dash.title")}</h1>
                <p className="text-muted-foreground text-sm">
                  {t("partner.dash.welcome", { name: user?.name || t("partner.dash.partnerFallback") })} {t("partner.dash.services", { count: serviceListings.length })}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" asChild><Link to="/messages">{t("partner.dash.messages")}</Link></Button>
              <Button variant="outline" onClick={() => setOnBehalfOpen(true)}>
                <QrCode className="w-4 h-4 mr-1" />{t("partner.dash.bookForCustomer", { defaultValue: "Book for a customer" })}
              </Button>
              {/* One Add entry point — the chooser dialog asks AI vs form,
                  replacing the old Onboarding + Add toolbar pair. */}
              <Button onClick={() => setAddChooserOpen(true)}>
                <Plus className="w-4 h-4 mr-1" />Add
              </Button>
            </div>
          </div>
        </div>

        {/* KYC banner */}
        {kycStatus !== "verified" && (
          <Link to="/provider/verification"
            className={`flex items-center gap-3 rounded-2xl border p-4 mb-6 transition-all hover:shadow-md ${
              kycStatus === "rejected" ? "bg-destructive/5 border-destructive/20" :
              kycStatus === "submitted" ? "bg-yellow-50 border-yellow-200" :
              "bg-primary/5 border-primary/20"
            }`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              kycStatus === "rejected" ? "bg-destructive/10 text-destructive" :
              kycStatus === "submitted" ? "bg-yellow-100 text-yellow-700" :
              "bg-primary/10 text-primary"
            }`}>
              <Shield className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">
                {kycStatus === "rejected" ? t("partner.dash.kyc.rejectedTitle") :
                 kycStatus === "submitted" ? t("partner.dash.kyc.submittedTitle") :
                 t("partner.dash.kyc.verifyTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {kycStatus === "rejected" ? t("partner.dash.kyc.rejectedDesc") :
                 kycStatus === "submitted" ? t("partner.dash.kyc.submittedDesc") :
                 t("partner.dash.kyc.verifyDesc")}
              </p>
            </div>
            <span className="text-xs text-primary font-semibold shrink-0">{t("partner.dash.kyc.verifyBtn")}</span>
          </Link>
        )}

        {/* Tabs — redesign pill nav */}
        <div className="mb-6 flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide rounded-full border border-border bg-muted/40 p-1.5 w-fit max-w-full">
          {tabs.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-bold transition-all ${
                activeTab === tab.id
                  ? "text-white shadow-[0_10px_24px_rgba(58,50,71,0.18)] bg-[linear-gradient(135deg,#2b2436_0%,#7b5244_60%,#8b5e4a_100%)]"
                  : "text-foreground/70 hover:bg-background hover:text-foreground active:bg-background/80"
              }`}>
              <tab.icon className="w-4 h-4" />{tab.label}
            </button>
          ))}
        </div>

        {/* Overview */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            <PayoutNudgeBanner onOpen={() => setActiveTab("payouts")} />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {stats.map((s, i) => (
                <div key={i} onClick={() => setActiveTab(statTabs[i])} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTab(statTabs[i]); } }} role="button" tabIndex={0} className="cursor-pointer bg-card rounded-2xl border border-border p-5 hover:shadow-md hover:border-primary/30 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                  <div className="flex items-center justify-between mb-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center"><s.icon className="w-5 h-5" /></div>
                  </div>
                  <p className="text-2xl font-extrabold tracking-tight">{s.value}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
                  <p className="text-[10px] text-muted-foreground">{s.desc}</p>
                </div>
              ))}
            </div>

            {/* Earnings trend — same completed set + amount rule as the tile
                above, so the "All" range lands exactly on Total Earnings. */}
            <EarningsTrendCard
              completed={completedBookings}
              amountFor={amountFor}
              accrualDate={(b) => new Date(`${normalizeDate(b.scheduledDate)}T00:00:00`)}
            />

            {/* Today's schedule */}
            {(() => {
              const todays = upcomingBookings.filter((b) => isToday(b.scheduledDate));
              return todays.length > 0 ? (
                <div>
                  <h3 className="font-display font-semibold mb-3 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary" /> {t("partner.dash.overview.todaySchedule")}
                    <span className="text-xs text-muted-foreground font-normal">({t("partner.dash.overview.jobs", { count: todays.length })})</span>
                  </h3>
                  <div className="space-y-2">
                    {todays.map((b) => (
                      <div
                        key={b.id}
                        onClick={() => setBookingDetailsTarget(b)}
                        className={`bg-card rounded-2xl border p-4 flex items-center gap-3 hover:shadow-md transition-all cursor-pointer ${statusMap[b.id] === "in_progress" ? "border-warning/30" : "border-primary/20"}`}
                      >
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${statusMap[b.id] === "in_progress" ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary"}`}>
                          {statusMap[b.id] === "in_progress" ? "🔨" : "📅"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm capitalize truncate">{b.serviceCategory?.replace(/-/g, " ")}</h4>
                          <p className="text-xs text-muted-foreground">{formatTime(b.startTime)} – {formatTime(b.endTime)} {b.address ? `• ${b.address}` : ""}</p>
                        </div>
                        {formatPrice(b) && <span className="font-bold text-sm shrink-0">{formatPrice(b)}</span>}
                        {statusMap[b.id] === "in_progress" && <span className="px-2 py-0.5 bg-warning/10 text-warning text-[10px] rounded-full font-semibold shrink-0">{t("partner.dash.overview.inProgress")}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ) : upcomingBookings.length > 0 ? (
                <div className="bg-primary/5 border border-primary/10 rounded-2xl p-4 flex items-center gap-3">
                  <Calendar className="w-8 h-8 text-primary/40" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{t("partner.dash.overview.noToday")}</p>
                    <p className="text-xs text-muted-foreground">{t("partner.dash.overview.nextJob", { date: formatDate(upcomingBookings[0].scheduledDate), time: formatTime(upcomingBookings[0].startTime) })}</p>
                  </div>
                  <Button size="sm" variant="outline" className="rounded-full text-xs" onClick={() => setActiveTab("schedule")}>{t("partner.dash.overview.viewSchedule")}</Button>
                </div>
              ) : null;
            })()}

          </div>
        )}

        {/* My Services (InstaHelp only) */}
        {activeTab === "listings" && <MyListings filter="service" />}

        {/* Requests — sub-tabs: upcoming/completed/cancelled */}
        {activeTab === "requests" && (
          <RequestsPanel
            providerBookings={providerBookings}
            statusMap={statusMap}
            formatDate={formatDate}
            formatTime={formatTime}
            formatPrice={formatPrice}
            isToday={isToday}
            onCancel={(id) => bookingStatusMutation.mutate({ id, status: "cancelled" })}
            onViewDetails={(b) => setBookingDetailsTarget(b)}
            mutationPending={bookingStatusMutation.isPending}
          />
        )}

        {/* Earnings — same UX as Host, but for services/transport */}
        {activeTab === "earnings" && (
          <EarningsPanel completedBookings={completedBookings} amountFor={amountFor} onOpenPayouts={() => setActiveTab("payouts")} />
        )}

        {/* Payment settings — payout account first, then status tiles, period statement, history */}
        {activeTab === "payouts" && (
          <div className="space-y-5">
            <PayoutAccountCard />
            <PayoutStatusTiles />
            <EarningsStatement type="service" />
            <PayoutHistoryCard />
          </div>
        )}

        {/* Insights — partner-scoped analytics (bookings, cancellations,
            funnel, search demand) from /api/providers/me/insights. */}
        {activeTab === "insights" && <InsightsPanel category="service" />}

        {/* Coupons — service-scoped. Only the provider's service listings
            are offered in the Applies-to picker, and the server stamps
            `category='service'` so the discount can't be redeemed on a
            stay or transport booking. */}
        {activeTab === "coupons" && (
          <PartnerCouponsTab listings={serviceListings} kind="service" />
        )}

        {/* Reviews */}
        {activeTab === "reviews" && (
          <ReviewsPanel
            reviews={partnerReviews}
            listings={reviewListings}
            avgRating={avgRating}
          />
        )}

        {/* Profile — service-shaped, no hotel/address/service-area leftovers */}
        <AddListingChooserDialog open={addChooserOpen} onOpenChange={setAddChooserOpen} type="service" />
        <ProviderOnBehalfBookingModal
          open={onBehalfOpen}
          onOpenChange={setOnBehalfOpen}
          serviceListings={serviceListings}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ["partner-bookings"] });
            queryClient.invalidateQueries({ queryKey: ["bookings"] });
          }}
        />
        {bookingDetailsTarget && (
          <ProviderBookingDetailsDialog target={bookingDetailsTarget} formatDate={formatDate} formatTime={formatTime} formatPrice={formatPrice} onClose={() => setBookingDetailsTarget(null)} />
        )}

        {activeTab === "profile" && (
          <DashboardProfilePanel
            roleNoun={t("partner.dash.profile.defaultName", { defaultValue: "Partner" })}
            verified={kycStatus === "verified"}
            verifiedLabel={t("partner.dash.profile.verifiedPartner")}
            rating={avgRating}
            reviewCount={partnerReviews.length}
            stats={[
              { label: t("partner.dash.profile.completedJobs"), value: `${completedBookings.length}` },
              { label: t("partner.dash.profile.rating"), value: partnerReviews.length > 0 ? `${avgRating}` : "—", sub: partnerReviews.length > 0 ? t("partner.dash.profile.ratingCount", { defaultValue: "{{count}} reviews", count: partnerReviews.length }) : t("partner.dash.profile.noRatings") },
              { label: t("partner.dash.profile.memberSince"), value: user?.memberSince || "—" },
              { label: t("partner.dash.profile.verification"), value: kycStatus === "verified" ? t("partner.dash.profile.verified") : kycStatus === "submitted" ? t("partner.dash.profile.underReview") : kycStatus === "rejected" ? t("partner.dash.profile.needsAttention") : t("partner.dash.profile.notSubmitted") },
            ]}
            details={[
              { label: t("partner.dash.profile.servicesOffered"), value: serviceListings.length > 0 ? serviceListings.map((l) => l.name).join(", ") : t("partner.dash.profile.noServices") },
              { label: t("partner.dash.profile.transportOffered"), value: transportListings.length > 0 ? transportListings.map((l) => l.name).join(", ") : t("partner.dash.profile.none") },
              { label: t("partner.dash.profile.languages"), value: formatLanguageList(liveListings[0]?.metadata?.languages) || "—" },
            ]}
            onLogout={handleLogout}
          />
        )}
      </div>
    </div>
  );
};

/**
 * Requests, sliced every way the partner cares about: upcoming (confirmed,
 * future), completed, cancelled. Only real bookings arrive on the provider
 * scope — the backend filters unpaid ('pending') and lapsed ('expired') holds.
 */
export function RequestsPanel({
  providerBookings, statusMap, formatDate, formatTime, formatPrice, isToday,
  onCancel, onViewDetails, mutationPending,
}: {
  providerBookings: Booking[];
  statusMap: Record<string, string>;
  formatDate: (s: string) => string;
  formatTime: (s: string) => string;
  formatPrice: (b: Booking) => string;
  isToday: (s: string) => boolean;
  onCancel: (id: string) => void;
  onViewDetails: (b: Booking) => void;
  mutationPending: boolean;
}) {
  const { t } = useLanguage();
  // "Today" was a separate filter that confused providers — a confirmed
  // booking today is still upcoming until it actually starts. Folded into
  // Upcoming; the Overview tab still surfaces today's schedule prominently.
  const [sub, setSub] = useState<"upcoming" | "completed" | "cancelled">("upcoming");

  const slices = useMemo(() => ({
    upcoming:  providerBookings.filter((b) => statusMap[b.id] === "confirmed" || statusMap[b.id] === "in_progress"),
    completed: providerBookings.filter((b) => statusMap[b.id] === "completed"),
    cancelled: providerBookings.filter((b) => statusMap[b.id] === "cancelled"),
  }), [providerBookings, statusMap]);

  // isToday isn't read in this panel anymore but the parent still passes it.
  void isToday;

  const subTabs: Array<{ id: typeof sub; label: string; count: number }> = [
    { id: "upcoming",  label: t("partner.dash.req.subUpcoming"),  count: slices.upcoming.length },
    { id: "completed", label: t("partner.dash.req.subCompleted"), count: slices.completed.length },
    { id: "cancelled", label: t("partner.dash.req.subCancelled"), count: slices.cancelled.length },
  ];

  const current = slices[sub];
  const subLabelMap: Record<typeof sub, string> = {
    upcoming: t("partner.dash.req.subUpcoming"),
    completed: t("partner.dash.req.subCompleted"),
    cancelled: t("partner.dash.req.subCancelled"),
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="font-display font-semibold text-lg">{t("partner.dash.req.title")}</h2>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {subTabs.map((st) => (
          <button key={st.id} onClick={() => setSub(st.id)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
              sub === st.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-card border border-border text-muted-foreground hover:text-foreground"
            }`}>
            {st.label}
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${sub === st.id ? "bg-primary-foreground/20" : "bg-muted"}`}>{st.count}</span>
          </button>
        ))}
      </div>

      {current.length === 0 && (
        <div className="bg-card rounded-2xl border border-border p-10 text-center text-sm text-muted-foreground">
          {t("partner.dash.req.empty", { status: subLabelMap[sub].toLowerCase() })}
        </div>
      )}

      {current.map((b) => {
        const s = statusMap[b.id] || "confirmed";
        const statusKey = s === "confirmed" ? "Upcoming" : s === "in_progress" ? "InProgress" : s.charAt(0).toUpperCase() + s.slice(1);
        const statusLabel = t(`partner.dash.req.status${statusKey}`, { defaultValue: statusKey });
        const statusClass =
          s === "confirmed" ? "bg-success/10 text-success border border-success/20" :
          s === "in_progress" ? "bg-warning/10 text-warning border border-warning/20" :
          s === "completed" ? "bg-muted text-foreground border border-border" :
          // cancelled: a clear red, not the muted destructive rose.
          "bg-red-600/10 text-red-700 border border-red-600/30";
        return (
          <div
            key={b.id}
            onClick={() => onViewDetails(b)}
            className="bg-card rounded-2xl border border-border p-4 sm:p-5 hover:shadow-md transition-all cursor-pointer"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold shrink-0">
                  {((b.guestName && b.guestName !== "User" ? b.guestName : (() => { try { const p = b.notes ? JSON.parse(b.notes) : null; return (p?.guestName && p.guestName !== "User") ? p.guestName : null; } catch { return null; } })()) || b.userId).slice(0, 2).toUpperCase()}
                </div>
                {(() => {
                  const svc = getServiceBookingDetails(b.notes);
                  const trn = getTransportBookingDetails(b.notes);
                  const modeLabel = svc?.serviceMode ? serviceModeLabel(svc.serviceMode) : trn?.mode ? transportModeLabel(trn.mode) : null;
                  const extra = trn?.pickup
                    ? `Pickup: ${trn.pickup}`
                    : svc?.serviceMode === "at-home" && svc.customerAddress
                      ? svc.customerAddress
                      : svc?.serviceMode === "visit-provider" && svc.visitAddress
                        ? svc.visitAddress
                        : svc?.serviceMode === "online" && svc.meetingDetails
                          ? svc.meetingDetails
                          : null;
                  return (
                    <div className="min-w-0">
                      <p className="font-medium text-sm capitalize flex items-center gap-2 flex-wrap">
                        <span>{b.serviceCategory?.replace(/-/g, " ") || t("partner.dash.req.serviceFallback")}</span>
                        {/* When the listing has a services catalog, surface
                            WHICH service was booked as a chip next to the
                            category — a salon host with men's/women's/kids
                            haircuts otherwise has to open every card to
                            know what to prep for. Empty for legacy listings. */}
                        {svc?.selectedServiceName && (
                          <span className="px-2 py-0.5 rounded-full bg-foreground text-background text-[10px] font-semibold normal-case tracking-tight">
                            {svc.selectedServiceName}
                          </span>
                        )}
                        {modeLabel && (
                          <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-wider">
                            {modeLabel}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(b.guestName && b.guestName !== "User" ? b.guestName : (() => { try { const p = b.notes ? JSON.parse(b.notes) : null; return (p?.guestName && p.guestName !== "User") ? p.guestName : null; } catch { return null; } })()) || t("partner.dash.req.customerPrefix", { id: b.userId.slice(0, 6) })} • {formatDate(b.scheduledDate)} {formatTime(b.startTime)}
                      </p>
                      {(extra || b.address) && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1 truncate">
                          <MapPin className="w-3 h-3 shrink-0" />{extra || b.address}
                        </p>
                      )}
                      {svc?.addOns && svc.addOns.length > 0 && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                          Add-ons: {svc.addOns.map((a) => a.label || a.id).filter(Boolean).join(", ")}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                {formatPrice(b) && <span className="font-bold text-lg">{formatPrice(b)}</span>}
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${statusClass}`}>{statusLabel}</span>
                {(s === "confirmed" || s === "in_progress") && (
                  <Button size="sm" variant="outline"
                    className="rounded-full text-xs text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); if (window.confirm(t("partner.dash.req.cancelConfirm"))) onCancel(b.id); }}
                    disabled={mutationPending}>
                    {t("partner.dash.req.cancel")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Earnings — mirrors Host's EarningsPanel conceptually, but without a
 * per-property aggregation (services don't have the "property" dimension —
 * they aggregate by listing/service name instead).
 */
export function EarningsPanel({
  completedBookings, amountFor, onOpenPayouts,
}: {
  completedBookings: Booking[];
  amountFor: (b: Booking) => number;
  /** Jump to the dashboard's Payouts tab (awaiting-payout tile). */
  onOpenPayouts?: () => void;
}) {
  const { t } = useLanguage();
  const [range, setRange] = useState<"week" | "month" | "year" | "all" | "fy" | "custom">("month");
  const now = new Date();
  const currentFyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const [fyYear, setFyYear] = useState(currentFyYear);
  // Exact [from, to] window for the Custom pill (inclusive, YYYY-MM-DD).
  const [customRange, setCustomRange] = useState<CustomEarningsRange | null>(null);

  // normalize Postgres TIME "HH:MM:SS" so the ISO string always parses.
  const normTime = (time: string) => {
    const parts = time.split(":");
    return `${(parts[0] || "00").padStart(2, "0")}:${(parts[1] || "00").padStart(2, "0")}:${(parts[2] || "00").padStart(2, "0")}`;
  };
  const endDateOf = (b: Booking): Date => {
    const dateStr = b.scheduledDate?.includes("T") ? b.scheduledDate.split("T")[0] : b.scheduledDate;
    return new Date(`${dateStr}T${normTime(b.endTime || "18:00")}`);
  };
  const startOfRange = useMemo(() => {
    const d = new Date(now);
    if (range === "week") d.setDate(d.getDate() - 7);
    else if (range === "month") d.setMonth(d.getMonth() - 1);
    else if (range === "year") d.setFullYear(d.getFullYear() - 1);
    else if (range === "fy") return new Date(fyYear, 3, 1); // April 1
    else if (range === "custom" && customRange) return new Date(`${customRange.from}T00:00:00`);
    else d.setFullYear(d.getFullYear() - 100);
    return d;
  }, [range, fyYear, customRange]);

  const endOfRange = useMemo(() => {
    if (range === "fy") return new Date(fyYear + 1, 2, 31, 23, 59, 59); // March 31 next year
    if (range === "custom" && customRange) return new Date(`${customRange.to}T23:59:59`);
    return null;
  }, [range, fyYear, customRange]);

  const inRange = useMemo(
    () => completedBookings.filter((b) => {
      const d = endDateOf(b);
      if (endOfRange) return d >= startOfRange && d <= endOfRange;
      return d >= startOfRange;
    }),
    [completedBookings, startOfRange, endOfRange]
  );

  const total = inRange.reduce((sum, b) => sum + amountFor(b), 0);
  const allTimeTotal = completedBookings.reduce((sum, b) => sum + amountFor(b), 0);
  const avgPerJob = inRange.length > 0 ? total / inRange.length : 0;

  // Custom windows bucket daily up to ~4 months, monthly beyond (same rule
  // as the backend earnings series).
  const customSpanDays = customRange
    ? Math.round((Date.parse(customRange.to) - Date.parse(customRange.from)) / 86400000) + 1
    : 0;
  const monthlyBuckets = range === "year" || range === "all" || range === "fy" || (range === "custom" && customSpanDays > 120);
  const buckets = useMemo(() => {
    const granularity: "day" | "month" = monthlyBuckets ? "month" : "day";
    const map = new Map<string, number>();
    for (const b of inRange) {
      const d = endDateOf(b);
      const key = granularity === "day" ? d.toISOString().slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      map.set(key, (map.get(key) || 0) + amountFor(b));
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [inRange, monthlyBuckets]);
  const maxBucket = buckets.reduce((m, [, v]) => Math.max(m, v), 0);

  const byService = useMemo(() => {
    const map = new Map<string, { name: string; total: number; count: number }>();
    for (const b of inRange) {
      const key = b.serviceCategory || "other";
      const entry = map.get(key) || { name: (b.serviceCategory || "other").replace(/-/g, " "), total: 0, count: 0 };
      entry.total += amountFor(b);
      entry.count += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [inRange]);

  const fyLabel = `FY ${String(fyYear).slice(2)}-${String(fyYear + 1).slice(2)}`;

  const rangeTabs: Array<{ id: typeof range; label: string }> = [
    { id: "week", label: t("partner.dash.earn.week") },
    { id: "month", label: t("partner.dash.earn.month") },
    { id: "year", label: t("partner.dash.earn.year") },
    { id: "fy", label: "Fin. Year" },
    { id: "all", label: t("partner.dash.earn.all") },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-display font-semibold text-lg">{t("partner.dash.earn.title")}</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-2 overflow-x-auto scrollbar-hide">
            {rangeTabs.map((r) => (
              <button key={r.id} onClick={() => setRange(r.id)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                  range === r.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-card border border-border text-muted-foreground hover:text-foreground"
                }`}>
                {r.label}
              </button>
            ))}
            <EarningsRangePill
              active={range === "custom"}
              value={customRange}
              onApply={(r) => { setCustomRange(r); setRange("custom"); }}
            />
          </div>
          {range === "fy" && (
            <div className="flex items-center gap-1 bg-card border border-border rounded-full px-2 py-1">
              <button
                onClick={() => setFyYear(y => y - 1)}
                className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              >‹</button>
              <span className="text-xs font-semibold px-1 whitespace-nowrap">{fyLabel}</span>
              <button
                onClick={() => setFyYear(y => Math.min(y + 1, currentFyYear))}
                disabled={fyYear >= currentFyYear}
                className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
              >›</button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="w-10 h-10 rounded-xl bg-success/10 text-success flex items-center justify-center mb-3"><IndianRupee className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">₹{total.toLocaleString("en-IN")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{range === "custom" && customRange ? customRangeLabel(customRange) : rangeTabs.find((r) => r.id === range)?.label}</p>
        </div>
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-3"><Calendar className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">{inRange.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t("partner.dash.earn.completedJobs")}</p>
        </div>
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="w-10 h-10 rounded-xl bg-secondary/10 text-secondary flex items-center justify-center mb-3"><TrendingUp className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">₹{Math.round(avgPerJob).toLocaleString("en-IN")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t("partner.dash.earn.avgPerJob")}</p>
        </div>
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="w-10 h-10 rounded-xl bg-muted text-foreground flex items-center justify-center mb-3"><BarChart3 className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">₹{allTimeTotal.toLocaleString("en-IN")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t("partner.dash.earn.allTime")}</p>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border p-5 sm:p-6">
        <h3 className="font-display font-semibold mb-4">{range === "fy" ? `${fyLabel} Breakdown` : monthlyBuckets ? t("partner.dash.earn.monthlyBreakdown") : t("partner.dash.earn.dailyBreakdown")}</h3>
        {buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t("partner.dash.earn.emptyRange")}</p>
        ) : (
          <div className="space-y-2">
            {buckets.map(([key, value]) => (
              <div key={key} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-20 shrink-0">{key}</span>
                <div className="flex-1 h-6 bg-muted/50 rounded-md overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-primary/70 rounded-md flex items-center justify-end pr-2"
                    style={{ width: `${maxBucket > 0 ? (value / maxBucket) * 100 : 0}%` }}
                  >
                    <span className="text-[10px] font-bold text-primary-foreground whitespace-nowrap">₹{value.toLocaleString("en-IN")}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-card rounded-2xl border border-border p-5 sm:p-6">
        <h3 className="font-display font-semibold mb-4">{t("partner.dash.earn.byService")}</h3>
        {byService.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t("partner.dash.earn.emptyService")}</p>
        ) : (
          <div className="space-y-2">
            {byService.map((s, i) => (
              <div key={i} className="flex items-center justify-between bg-muted/30 rounded-xl px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium capitalize">{s.name}</p>
                  <p className="text-[10px] text-muted-foreground">{t("partner.dash.earn.jobs", { count: s.count })}</p>
                </div>
                <span className="font-bold text-success">₹{s.total.toLocaleString("en-IN")}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* The payouts management surface lives in its own tab; Earnings keeps
          just the balance tile so the number is findable where people look. */}
      {onOpenPayouts && <AwaitingPayoutTile onOpen={onOpenPayouts} />}
    </div>
  );
}

/**
 * Reviews panel — same shape as Host's, but filters by service instead of
 * property. Uses IntersectionObserver to page in 10 at a time from the
 * already-fetched review list.
 */
export function ReviewsPanel({
  reviews, listings, avgRating,
}: {
  reviews: Array<Review & { service: string; listingId: string }>;
  listings: Listing[];
  avgRating: string;
}) {
  const { t } = useLanguage();
  const [listingFilter, setListingFilter] = useState<string>("all");
  const [ratingFilter, setRatingFilter] = useState<number | "all">("all");
  const [sort, setSort] = useState<"newest" | "oldest" | "highest" | "lowest">("newest");
  const [visible, setVisible] = useState(10);

  const histogram = useMemo(() => {
    const counts = [0, 0, 0, 0, 0];
    for (const r of reviews) {
      const idx = Math.min(5, Math.max(1, Math.round(r.rating))) - 1;
      counts[idx] += 1;
    }
    return counts;
  }, [reviews]);

  const filtered = useMemo(() => {
    let list = reviews;
    if (listingFilter !== "all") list = list.filter((r) => r.listingId === listingFilter);
    if (ratingFilter !== "all") list = list.filter((r) => Math.round(r.rating) === ratingFilter);
    return [...list].sort((a, b) => {
      if (sort === "highest") return b.rating - a.rating;
      if (sort === "lowest") return a.rating - b.rating;
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sort === "oldest" ? ta - tb : tb - ta;
    });
  }, [reviews, listingFilter, ratingFilter, sort]);

  useEffect(() => { setVisible(10); }, [listingFilter, ratingFilter, sort]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisible((v) => Math.min(v + 10, filtered.length));
    }, { rootMargin: "200px" });
    io.observe(node);
    return () => io.disconnect();
  }, [filtered.length]);

  const numericAvg = reviews.length > 0 ? Number(avgRating) : 0;

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-2xl border border-border p-6">
        <div className="grid md:grid-cols-2 gap-6 items-center">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 mb-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} className={`w-6 h-6 ${n <= Math.round(numericAvg) ? "fill-secondary text-secondary" : "fill-secondary/20 text-secondary/20"}`} />
              ))}
            </div>
            <p className="text-4xl font-bold">{avgRating}</p>
            <p className="text-sm text-muted-foreground">{reviews.length === 1 ? t("partner.dash.rev.avgAllOne") : t("partner.dash.rev.avgAll", { count: reviews.length })}</p>
          </div>
          <div className="space-y-1.5">
            {[5, 4, 3, 2, 1].map((star) => {
              const count = histogram[star - 1];
              const pct = reviews.length > 0 ? (count / reviews.length) * 100 : 0;
              return (
                <button key={star} onClick={() => setRatingFilter(ratingFilter === star ? "all" : star)}
                  className={`w-full flex items-center gap-2 hover:bg-muted/50 rounded px-2 py-1 transition-colors ${ratingFilter === star ? "bg-muted/70" : ""}`}>
                  <span className="text-xs w-6 flex items-center gap-0.5">{star}<Star className="w-3 h-3 fill-secondary text-secondary" /></span>
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-secondary rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] text-muted-foreground w-8 text-right">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {reviews.length > 0 && (
        <div className="bg-card rounded-2xl border border-border p-3 flex flex-wrap gap-2 items-center justify-between">
          <div className="flex flex-wrap gap-2 items-center">
            <DashFilterSelect
              value={listingFilter}
              onChange={setListingFilter}
              ariaLabel={t("partner.dash.rev.allServices")}
              options={[
                { value: "all", label: t("partner.dash.rev.allServices") },
                ...listings.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
            {ratingFilter !== "all" && (
              <button onClick={() => setRatingFilter("all")}
                className="inline-flex h-9 items-center gap-1 rounded-full border border-border bg-muted/40 px-3.5 text-xs font-medium hover:bg-muted transition-colors">
                {t("partner.dash.rev.onlyStars", { count: ratingFilter })}
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <DashFilterSelect
            value={sort}
            onChange={(v) => setSort(v as typeof sort)}
            ariaLabel={t("partner.dash.rev.newest")}
            options={[
              { value: "newest", label: t("partner.dash.rev.newest") },
              { value: "oldest", label: t("partner.dash.rev.oldest") },
              { value: "highest", label: t("partner.dash.rev.highest") },
              { value: "lowest", label: t("partner.dash.rev.lowest") },
            ]}
          />
        </div>
      )}

      {filtered.slice(0, visible).map((r) => (
        <div key={r.id} className="bg-card rounded-2xl border border-border p-5">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">
                {(r.displayName || "G").slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium">{r.displayName || t("partner.dash.rev.customerFallback")}</p>
                <p className="text-[10px] text-muted-foreground">{r.service || t("partner.dash.rev.serviceFallback")} • {new Date(r.createdAt).toLocaleDateString("en-IN")}</p>
              </div>
            </div>
            <div className="flex gap-0.5 shrink-0">
              {Array.from({ length: 5 }).map((_, j) => (
                <Star key={j} className={`w-4 h-4 ${j < Math.round(r.rating) ? "fill-secondary text-secondary" : "fill-muted text-muted"}`} />
              ))}
            </div>
          </div>
          <p className="text-sm text-foreground/90 leading-relaxed">{r.reviewText}</p>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="bg-card rounded-2xl border border-border p-10 text-center text-sm text-muted-foreground">
          {reviews.length === 0 ? t("partner.dash.rev.empty") : t("partner.dash.rev.noMatch")}
        </div>
      )}

      {visible < filtered.length && (
        <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">{t("partner.dash.rev.loadingMore")}</div>
      )}
    </div>
  );
}

export function ProviderBookingDetailsDialog({
  target, formatDate, formatTime, formatPrice, onClose,
}: {
  target: Booking;
  formatDate: (s: string) => string;
  formatTime: (s: string) => string;
  formatPrice: (b: Booking) => string;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const eff = effectiveBookingStatus(target);
  const guestName = target.guestName && target.guestName !== "User"
    ? target.guestName
    : t("partner.dash.req.customerPrefix", { id: target.userId?.slice(0, 6), defaultValue: `Customer ${target.userId?.slice(0, 6) || ""}` });
  const svc = getServiceBookingDetails(target.notes);
  const trn = getTransportBookingDetails(target.notes);
  const rows: Array<[string, string | null]> = [
    [t("host.dash.bk.dlg.bookingId", { defaultValue: "Booking" }), target.id?.slice(0, 8) || null],
    [t("host.dash.bk.dlg.guest", { defaultValue: "Customer" }), guestName],
    [t("host.dash.bk.dlg.status", { defaultValue: "Status" }), eff],
    [t("host.dash.bk.dlg.date", { defaultValue: "Date" }), formatDate(target.scheduledDate)],
    [t("host.dash.bk.dlg.time", { defaultValue: "Time" }), target.startTime && target.endTime ? `${formatTime(target.startTime)} – ${formatTime(target.endTime)}` : null],
    [t("host.dash.bk.dlg.amount", { defaultValue: "Amount" }), formatPrice(target) || null],
    // Surface the selected services-catalog group name FIRST among the
    // service-specific rows so multi-service listings (salons, tutors, etc.)
    // make it obvious which offering was booked. Sits above mode/address so
    // the host reads "Service: Women's Haircut" before the logistics rows.
    ...(svc?.selectedServiceName ? [["Service", svc.selectedServiceName] as [string, string]] : []),
    ...(svc?.serviceMode ? [["Service mode", serviceModeLabel(svc.serviceMode)] as [string, string | null]] : []),
    ...(svc?.customerAddress ? [["Customer address", svc.customerAddress] as [string, string]] : []),
    ...(svc?.visitAddress ? [["Visit address", svc.visitAddress] as [string, string]] : []),
    ...(svc?.meetingDetails ? [["Meeting details", svc.meetingDetails] as [string, string]] : []),
    ...(trn?.mode ? [["Transport mode", transportModeLabel(trn.mode)] as [string, string | null]] : []),
    ...(trn?.pickup ? [["Pickup", trn.pickup] as [string, string]] : []),
    ...(trn?.mode === "hourly" && typeof trn.durationHours === "number" ? [["Duration", `${trn.durationHours} hr`] as [string, string]] : []),
    ...(trn?.mode === "day" && typeof trn.days === "number" ? [["Days", String(trn.days)] as [string, string]] : []),
    ...(trn?.mode === "package" && trn.packageLabel
      ? [["Package", typeof trn.packageHours === "number" ? `${trn.packageLabel} · ${trn.packageHours} hr` : trn.packageLabel] as [string, string]]
      : []),
    ...(typeof trn?.passengers === "number" ? [["Passengers", String(trn.passengers)] as [string, string]] : []),
    // Booked vehicle identity. Prefer the booking-time snapshot (the exact car)
    // over the looser notes-based vehicleType. Driver phone is the host's own
    // number here, so it's intentionally omitted from the host-facing dialog.
    ...(target.vehicleModel
      ? [["Vehicle", target.vehicleModel] as [string, string]]
      : trn?.vehicleType ? [["Vehicle", trn.vehicleType] as [string, string]] : []),
    ...(target.vehicleColor ? [["Colour", target.vehicleColor] as [string, string]] : []),
    ...(target.vehiclePlate ? [["Number plate", target.vehiclePlate] as [string, string]] : []),
  ];
  // Customer's reachable number: the guest's profile phone (or the walk-up
  // guest's contact on host-on-behalf bookings) surfaced by the backend join;
  // legacy rows fall back to the phone stashed in the notes JSON at booking
  // time. Rendered as a tel: link below so one tap dials — replaces the old
  // plain-text "Contact" rows.
  const customerPhone: string | null =
    target.guestPhone || svc?.contact?.phone || trn?.contact?.phone || null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="capitalize truncate">
            {target.serviceCategory?.replace(/-/g, " ") || t("partner.dash.req.serviceFallback", { defaultValue: "Service" })}
          </DialogTitle>
          <DialogDescription>{target.listingName || ""}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5 mt-2">
          {rows.map(([label, value]) => value ? (
            <div key={label} className="flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground shrink-0">{label}</span>
              <span className="font-medium text-right break-words capitalize">{value}</span>
            </div>
          ) : null)}
          {customerPhone && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground shrink-0">{t("partner.dash.req.customerPhone", { defaultValue: "Customer phone" })}</span>
              <a
                href={`tel:${customerPhone}`}
                className="font-medium text-right break-words text-primary hover:underline flex items-center gap-1 justify-end"
              >
                <Phone className="w-3 h-3 shrink-0" />{customerPhone}
              </a>
            </div>
          )}
          {target.address && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground shrink-0">{t("guest.bookings.addressLabel", { defaultValue: "Address" })}</span>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(target.address)}`}
                target="_blank" rel="noopener noreferrer"
                className="font-medium text-right break-words text-primary hover:underline flex items-center gap-1 justify-end"
              >
                <MapPin className="w-3 h-3 shrink-0" />{target.address}
              </a>
            </div>
          )}
          {svc?.addOns && svc.addOns.length > 0 && (
            <div className="pt-2 border-t border-border/60">
              <p className="text-xs text-muted-foreground mb-1">Add-ons</p>
              <ul className="text-sm space-y-0.5">
                {svc.addOns.map((a, i) => (
                  <li key={a.id || `${a.label}-${i}`} className="flex items-center justify-between gap-2">
                    <span>+ {a.label || a.id || "Add-on"}</span>
                    {typeof a.price === "number" && <span className="text-muted-foreground tabular-nums">+₹{a.price}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(svc?.protection || trn?.protection) && (
            <p className="text-xs text-muted-foreground">{t("partner.dash.req.protectionAdded", { defaultValue: "Protection plan added" })}</p>
          )}
          {target.notes && !target.notes.trim().startsWith("{") && (
            <div className="pt-2 border-t border-border/60">
              <p className="text-xs text-muted-foreground mb-1">{t("guest.bookings.notesLabel", { defaultValue: "Notes" })}</p>
              <p className="text-sm">{target.notes}</p>
            </div>
          )}
          {/* Invoice exists only for paid bookings — hidden for cancelled /
              expired / pending (guest Bookings page behaves the same). */}
          {(eff === "confirmed" || eff === "completed") && (
          <div className="pt-3 border-t border-border/60">
            <Button
              variant="outline"
              className="w-full rounded-xl"
              onClick={async () => {
                try {
                  await downloadBookingTaxInvoice(target.id);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to download invoice");
                }
              }}
            >
              {t("partner.dash.req.downloadInvoice", { defaultValue: "Download invoice" })}
            </Button>
          </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ProviderDashboard;
