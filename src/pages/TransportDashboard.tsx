import { useEffect, useMemo, useState } from "react";
import {
  Activity, Calendar, Star, TrendingUp, Clock, CheckCircle, BarChart3, MapPin, User,
  Shield, Package, Plus, IndianRupee, MessageCircle, Ticket, QrCode, Banknote,
} from "lucide-react";
import { InsightsPanel } from "@/components/dashboard/InsightsPanel";
import { EarningsStatement } from "@/components/dashboard/EarningsStatement";
import { EarningsTrendCard } from "@/components/dashboard/EarningsTrendCard";
import { TransportOnBehalfBookingModal } from "@/redesign/TransportOnBehalfBookingModal";
import { AddListingChooserDialog } from "@/components/AddListingChooserDialog";
import PartnerCouponsTab from "@/components/PartnerCouponsTab";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import MyListings from "@/components/MyListings";
import { getBookingService, getListingService, getProviderService, getReviewService } from "@/domains";
import type { Booking, Listing } from "@/types/domain";
import { effectiveBookingStatus } from "@/lib/booking-status";
import { bookingKindOf } from "@/lib/booking-kind";
import { getTransportBookingDetails, transportModeLabel } from "@/lib/booking-notes";
import {
  EarningsPanel, ProviderBookingDetailsDialog,
} from "./ProviderDashboard";
import { PayoutAccountCard, PayoutHistoryCard, PayoutNudgeBanner, PayoutStatusTiles } from "@/components/dashboard/PayoutsSection";
import { DashboardProfilePanel } from "@/components/dashboard/DashboardProfilePanel";
import { formatLanguageList } from "@/lib/format-languages";
import { UserAvatar } from "@/components/UserAvatar";
import {
  RequestsPanel, ReviewsPanel,
} from "./ProviderDashboard";

/**
 * TransportDashboard — driver-side dashboard.
 *
 * Sibling to GuestDashboard / HostDashboard / ProviderDashboard. Lives at
 * /dashboard/transport. Surfaces only transport listings + driver bookings
 * (driver-auto, driver-cab, driver-quote, etc.) so a partner who runs both
 * a cleaning service AND a cab service doesn't see them blended together.
 *
 * Style mirrors ProviderDashboard intentionally — header card, KYC banner,
 * horizontal tabs, identical Overview / Requests / Earnings / Reviews
 * panels (re-exported from ProviderDashboard). The transport-specific tabs
 * are "Quote requests" (incoming custom-trip asks) and "My vehicles"
 * (MyListings filtered to transport).
 */
const transportCategories = new Set(["driver-auto", "driver-cab", "driver-quote", "auto", "cab", "van", "bike", "tempo"]);
const isTransportCategory = (c: string) => transportCategories.has(c);
const isTransportListing = (l: Listing & { listing_type?: string }) =>
  l?.listing_type === "transport"
  || l?.metadata?.listingType === "transport"
  || isTransportCategory(l?.category);

const TransportDashboard = () => {
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
      if (!result.success || !result.data) throw new Error(result.error || "Couldn't load bookings");
      return result.data;
    },
  });

  // Only transport bookings live in this dashboard — the shared bookingKindOf
  // keeps the three dashboards mutually exclusive AND collectively exhaustive
  // (every booking lands in exactly one), covering legacy bare "cab"/"auto"
  // categories the old startsWith("driver-") check missed.
  const providerBookings = useMemo(
    () => allProviderBookings.filter((b) => bookingKindOf(b.serviceCategory) === "transport"),
    [allProviderBookings]
  );

  const { data: liveListings = [] } = useQuery({
    queryKey: ["my-listings", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getListingService().getByUserId(String(user?.id));
      if (!result.success || !result.data) throw new Error(result.error || "Couldn't load listings");
      return result.data;
    },
  });
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

  // Reviews tied to transport listings only.
  const { data: transportReviews = [] } = useQuery({
    queryKey: ["transport-reviews", transportListings.map((l) => l.id).join(",")],
    enabled: transportListings.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        transportListings.map(async (listing) => {
          const response = await getReviewService().getByStayId(listing.id);
          return response.success && response.data
            ? response.data.map((r) => ({ ...r, service: listing.name, listingId: listing.id }))
            : [];
        })
      );
      return results.flat();
    },
  });

  const statusMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of providerBookings) m[b.id] = effectiveBookingStatus(b);
    return m;
  }, [providerBookings]);

  // Only real bookings arrive on the provider scope — the backend filters
  // unpaid ('pending') and lapsed ('expired') holds (mirrors ProviderDashboard).
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

  // Prefer the server-computed true total (base + platform + GST + insurance
  // − discount) over `agreedPricePaise`, which excludes insurance and would
  // show ₹3.40 on a ₹3.47 booking. Falls back to the agreed price only when
  // the payment row hasn't been joined yet (legacy / pending rows).
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
  // Package + day-rental holds span the driver's working window for that
  // date (server-side widening) — show "Full-day tour · 9:00 AM – 5:00 PM".
  // Pre-widening bookings carry a 00:00–23:59 artifact → label only.
  const bookingTimeLabel = (b: { serviceCategory?: string; startTime?: string; endTime?: string }) => {
    const cat = b.serviceCategory?.toLowerCase() ?? "";
    if (cat === "driver-package" || cat === "driver-day") {
      const lbl = cat === "driver-package"
        ? t("transportDash.fullDayTour", { defaultValue: "Full-day tour" })
        : t("transportDash.fullDay", { defaultValue: "Full day" });
      const real = b.startTime && b.endTime && !(b.startTime.startsWith("00:00") && b.endTime.startsWith("23:59"));
      return real ? `${lbl} · ${formatTime(b.startTime!)} – ${formatTime(b.endTime!)}` : lbl;
    }
    if (b.startTime && b.endTime) return `${formatTime(b.startTime)} – ${formatTime(b.endTime)}`;
    return b.startTime ? formatTime(b.startTime) : "";
  };
  const normalizeDate = (s: string) => (s?.includes("T") ? s.split("T")[0] : s);
  const formatDate = (s: string) => {
    if (!s) return "";
    const d = new Date(`${normalizeDate(s)}T00:00:00`);
    return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  };
  const isToday = (s: string) => normalizeDate(s) === new Date().toISOString().slice(0, 10);

  const totalEarnings = completedBookings.reduce((a, b) => a + amountFor(b), 0);
  const avgRating = transportReviews.length > 0
    ? (transportReviews.reduce((sum, r) => sum + r.rating, 0) / transportReviews.length).toFixed(1)
    : "—";

  const stats = [
    { label: t("transportDash.statEarnings", { defaultValue: "Total Earnings" }),   value: totalEarnings > 0 ? `₹${(totalEarnings / 1000).toFixed(1)}K` : "₹0", icon: IndianRupee, desc: t("transportDash.completedTrips", { defaultValue: "Completed trips" }) },
    { label: t("transportDash.statTripsDone", { defaultValue: "Trips done" }), value: completedBookings.length.toString(),                                 icon: CheckCircle, desc: t("transportDash.completedTrips", { defaultValue: "Completed trips" }) },
    { label: t("transportDash.statRating", { defaultValue: "Rating" }),     value: avgRating,                                                            icon: Star,        desc: transportReviews.length > 0 ? (transportReviews.length === 1 ? t("transportDash.reviewCountOne", { defaultValue: "{{count}} review", count: transportReviews.length }) : t("transportDash.reviewCountOther", { defaultValue: "{{count}} reviews", count: transportReviews.length })) : t("transportDash.noReviewsYet", { defaultValue: "No reviews yet" }) },
  ];
  // Overview stat tiles deep-link to their detail tab on click.
  const statTabs = ["earnings", "requests", "reviews"];

  const bookingStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "confirmed" | "cancelled" }) => {
      const result = await getBookingService().updateBookingStatus(id, status, "provider");
      if (!result.success) throw new Error(result.error || "Couldn't update booking");
      return status;
    },
    onSuccess: async (status) => {
      await queryClient.invalidateQueries({ queryKey: ["partner-bookings"] });
      toast.success(status === "confirmed" ? t("transportDash.tripAccepted", { defaultValue: "Trip accepted" }) : t("transportDash.requestCancelled", { defaultValue: "Request cancelled" }));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const handleLogout = () => { logout(); navigate("/"); toast.success(t("transportDash.loggedOut", { defaultValue: "Logged out" })); };

  // Post-onboarding deep-link → land on the Listings tab so the user
  // sees the vehicle/listing they just created. The transport
  // dashboard lists everything flat (no per-listing selection state),
  // so we switch to the right tab and strip the param.
  // TODO: scroll-to-card the matching id when per-listing detail UX
  // lands.
  useEffect(() => {
    const targetId = searchParams.get("listing");
    if (!targetId) return;
    setActiveTab("listings");
    const next = new URLSearchParams(searchParams);
    next.delete("listing");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

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

  // Canonical partner tab order (mirrors Host/Provider + mobile), with the
  // transport-only Schedule calendar kept right after Overview:
  // Overview · Schedule · Analytics · My Vehicles · Trips · My Reviews ·
  // Earnings · Payment settings · Coupons · Profile.
  // Coupons are scoped to transport listings only — the server enforces
  // `category='transport'` on consume so a transport coupon cannot
  // discount a stay or service booking.
  const tabs = [
    { id: "overview",  label: t("transportDash.tabOverview", { defaultValue: "Overview" }),       icon: BarChart3 },
    { id: "schedule",  label: t("transportDash.tabSchedule", { defaultValue: "Schedule" }),       icon: Calendar,      count: upcomingBookings.length },
    { id: "insights",  label: t("transportDash.tabInsights", { defaultValue: "Analytics" }),      icon: Activity },
    { id: "listings",  label: t("transportDash.tabMyVehicles", { defaultValue: "My Vehicles" }),    icon: Package },
    { id: "requests",  label: t("transportDash.tabTrips", { defaultValue: "Trips" }),          icon: Clock },
    { id: "reviews",   label: t("transportDash.tabReviews", { defaultValue: "My Reviews" }),       icon: Star },
    { id: "earnings",  label: t("transportDash.tabEarnings", { defaultValue: "Earnings" }),       icon: TrendingUp },
    { id: "payouts",   label: t("transportDash.tabPayouts", { defaultValue: "Payment settings" }),        icon: Banknote },
    { id: "coupons",   label: t("transportDash.tabCoupons", { defaultValue: "Coupons" }),        icon: Ticket },
    { id: "profile",   label: t("transportDash.tabProfile", { defaultValue: "Profile" }),        icon: User },
  ];

  return (
    <div className="min-h-screen">
      <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Header — glassy redesign tile */}
        <div className="mb-6 rounded-[18px] border border-white/70 bg-white/64 p-5 sm:p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <UserAvatar
                className="h-14 w-14 rounded-2xl text-white text-lg font-extrabold shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_26px_rgba(58,50,71,0.18)]"
                style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #c08a5a 100%)" }}
                initials={user?.avatar || (user?.name || "D").slice(0, 2).toUpperCase()}
              />
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight">{t("transportDash.title", { defaultValue: "Transport Dashboard" })}</h1>
                <p className="text-muted-foreground text-sm">
                  {t("transportDash.welcome", { defaultValue: "Welcome, {{name}}", name: user?.name || t("transportDash.driver", { defaultValue: "Driver" }) })} · {transportListings.length} {transportListings.length === 1 ? t("transportDash.vehicle", { defaultValue: "vehicle" }) : t("transportDash.vehicles", { defaultValue: "vehicles" })}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" asChild>
                <Link to="/messages">{t("transportDash.messages", { defaultValue: "Messages" })}</Link>
              </Button>
              <Button variant="outline" onClick={() => setOnBehalfOpen(true)}>
                <QrCode className="w-4 h-4 mr-1" />{t("transportDash.bookForCustomer", { defaultValue: "Book for a customer" })}
              </Button>
              {/* One Add entry point — the chooser dialog asks AI vs form,
                  replacing the old Onboarding + Add toolbar pair. */}
              <Button onClick={() => setAddChooserOpen(true)}>
                <Plus className="w-4 h-4 mr-1" />{t("transportDash.add", { defaultValue: "Add" })}
              </Button>
            </div>
          </div>
        </div>

        {/* KYC banner — same style as partner dashboard */}
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
                {kycStatus === "rejected" ? t("transportDash.kycRejectedTitle", { defaultValue: "Verification needs attention" }) :
                 kycStatus === "submitted" ? t("transportDash.kycSubmittedTitle", { defaultValue: "Verification under review" }) :
                 t("transportDash.kycPendingTitle", { defaultValue: "Verify your identity to go live" })}
              </p>
              <p className="text-xs text-muted-foreground">
                {kycStatus === "rejected" ? t("transportDash.kycRejectedDesc", { defaultValue: "One or more documents were rejected — please re-upload." }) :
                 kycStatus === "submitted" ? t("transportDash.kycSubmittedDesc", { defaultValue: "We're reviewing your documents. You'll be notified shortly." }) :
                 t("transportDash.kycPendingDesc", { defaultValue: "Drivers need Aadhaar + Driving Licence to take trips." })}
              </p>
            </div>
            <span className="text-xs text-primary font-semibold shrink-0">{t("transportDash.verify", { defaultValue: "Verify →" })}</span>
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
              {tab.count !== undefined && tab.count > 0 && (
                <span className="px-1.5 py-0.5 bg-destructive text-destructive-foreground rounded-full text-[10px] font-bold">{tab.count}</span>
              )}
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
                    <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                      <s.icon className="w-5 h-5" />
                    </div>
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

            {/* Today's trips */}
            {(() => {
              const todays = upcomingBookings.filter((b) => isToday(b.scheduledDate));
              return todays.length > 0 ? (
                <div>
                  <h3 className="font-display font-semibold mb-3 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary" /> {t("transportDash.todaysTrips", { defaultValue: "Today's trips" })}
                    <span className="text-xs text-muted-foreground font-normal">({todays.length})</span>
                  </h3>
                  <div className="space-y-2">
                    {todays.map((b) => (
                      <div key={b.id} onClick={() => setBookingDetailsTarget(b)}
                        className={`bg-card rounded-2xl border p-4 flex items-center gap-3 hover:shadow-md transition-all cursor-pointer ${statusMap[b.id] === "in_progress" ? "border-warning/30" : "border-primary/20"}`}>
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${statusMap[b.id] === "in_progress" ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary"}`}>
                          {statusMap[b.id] === "in_progress" ? "🚗" : "📅"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm capitalize truncate">{b.serviceCategory?.replace(/-/g, " ")}</h4>
                          <p className="text-xs text-muted-foreground">{bookingTimeLabel(b)} {b.address ? `• ${b.address}` : ""}</p>
                        </div>
                        {formatPrice(b) && <span className="font-bold text-sm shrink-0">{formatPrice(b)}</span>}
                        {statusMap[b.id] === "in_progress" && <span className="px-2 py-0.5 bg-warning/10 text-warning text-[10px] rounded-full font-semibold shrink-0">{t("transportDash.inProgress", { defaultValue: "In progress" })}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ) : upcomingBookings.length > 0 ? (
                <div className="bg-primary/5 border border-primary/10 rounded-2xl p-4 flex items-center gap-3">
                  <Calendar className="w-8 h-8 text-primary/40" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{t("transportDash.noTripsToday", { defaultValue: "No trips today" })}</p>
                    <p className="text-xs text-muted-foreground">{t("transportDash.next", { defaultValue: "Next" })}: {formatDate(upcomingBookings[0].scheduledDate)} · {bookingTimeLabel(upcomingBookings[0])}</p>
                  </div>
                  <Button size="sm" variant="outline" className="rounded-full text-xs" onClick={() => setActiveTab("requests")}>{t("transportDash.viewAll", { defaultValue: "View all" })}</Button>
                </div>
              ) : null;
            })()}

          </div>
        )}

        {activeTab === "schedule" && (
          <TransportScheduleView
            upcomingBookings={upcomingBookings}
            formatDate={formatDate}
            formatTime={formatTime}
            formatPrice={formatPrice}
            onSelect={(b) => setBookingDetailsTarget(b)}
          />
        )}

        {activeTab === "listings" && <MyListings filter="transport" />}

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

        {activeTab === "earnings" && (
          <EarningsPanel completedBookings={completedBookings} amountFor={amountFor} onOpenPayouts={() => setActiveTab("payouts")} />
        )}

        {/* Payment settings — payout account first, then status tiles, period statement, history */}
        {activeTab === "payouts" && (
          <div className="space-y-5">
            <PayoutAccountCard />
            <PayoutStatusTiles />
            <EarningsStatement type="transport" />
            <PayoutHistoryCard />
          </div>
        )}

        {/* Insights — partner-scoped analytics (bookings, cancellations,
            funnel, search demand) from /api/providers/me/insights. */}
        {activeTab === "insights" && <InsightsPanel category="transport" />}

        {/* Coupons — transport-scoped. Server stamps `category='transport'`
            so the discount can only be redeemed against a transport
            booking. */}
        {activeTab === "coupons" && (
          <PartnerCouponsTab listings={transportListings} kind="transport" />
        )}

        {activeTab === "reviews" && (
          <ReviewsPanel
            reviews={transportReviews}
            listings={transportListings}
            avgRating={avgRating}
          />
        )}

        <AddListingChooserDialog open={addChooserOpen} onOpenChange={setAddChooserOpen} type="transport" />
        <TransportOnBehalfBookingModal
          open={onBehalfOpen}
          onOpenChange={setOnBehalfOpen}
          transportListings={transportListings}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ["partner-bookings"] });
            queryClient.invalidateQueries({ queryKey: ["bookings"] });
          }}
        />
        {bookingDetailsTarget && (
          <ProviderBookingDetailsDialog
            target={bookingDetailsTarget}
            formatDate={formatDate}
            formatTime={formatTime}
            formatPrice={formatPrice}
            onClose={() => setBookingDetailsTarget(null)}
          />
        )}

        {activeTab === "profile" && (
          <DashboardProfilePanel
            roleNoun={t("transportDash.driver", { defaultValue: "Driver" })}
            verified={kycStatus === "verified"}
            verifiedLabel={t("transportDash.verifiedDriver", { defaultValue: "Verified driver" })}
            rating={avgRating}
            reviewCount={transportReviews.length}
            stats={[
              { label: t("transportDash.fieldCompletedTrips", { defaultValue: "Completed trips" }), value: `${completedBookings.length}` },
              { label: t("transportDash.fieldRating", { defaultValue: "Rating" }), value: transportReviews.length > 0 ? `${avgRating}` : "—", sub: transportReviews.length > 0 ? t("transportDash.reviewCount", { defaultValue: "{{count}} reviews", count: transportReviews.length }) : t("transportDash.noRatingsYet", { defaultValue: "No ratings yet" }) },
              { label: t("transportDash.fieldMemberSince", { defaultValue: "Member since" }), value: user?.memberSince || "—" },
              { label: t("transportDash.fieldVerification", { defaultValue: "Verification" }), value: kycStatus === "verified" ? t("transportDash.statusVerified", { defaultValue: "Verified" }) : kycStatus === "submitted" ? t("transportDash.statusUnderReview", { defaultValue: "Under review" }) : kycStatus === "rejected" ? t("transportDash.statusNeedsAttention", { defaultValue: "Needs attention" }) : t("transportDash.statusNotSubmitted", { defaultValue: "Not submitted" }) },
            ]}
            details={[
              { label: t("transportDash.fieldVehicles", { defaultValue: "Vehicles" }), value: transportListings.length > 0 ? transportListings.map((l) => l.name).join(", ") : t("transportDash.noneYet", { defaultValue: "None yet" }) },
              { label: t("transportDash.fieldLanguages", { defaultValue: "Languages" }), value: formatLanguageList(transportListings[0]?.metadata?.languages) || "—" },
            ]}
            onLogout={handleLogout}
          />
        )}
      </div>
    </div>
  );
};

/**
 * Calendar-style schedule view of the driver's confirmed/in-progress
 * bookings. Groups by date and renders each booking as a time-block card.
 * Intentionally simple — drivers care about "what time, where, who", not
 * monthly grids. Tapping a block opens the same details dialog as the
 * Requests panel for accept/cancel actions.
 */
function TransportScheduleView({
  upcomingBookings,
  formatDate,
  formatTime,
  formatPrice,
  onSelect,
}: {
  upcomingBookings: Booking[];
  formatDate: (s: string) => string;
  formatTime: (s: string) => string;
  formatPrice: (b: Booking) => string;
  onSelect: (b: Booking) => void;
}) {
  const { t } = useLanguage();
  // Group by scheduledDate (normalized to YYYY-MM-DD).
  const grouped = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of upcomingBookings) {
      const day = (b.scheduledDate || "").includes("T")
        ? b.scheduledDate.split("T")[0]
        : b.scheduledDate;
      if (!day) continue;
      const arr = map.get(day) ?? [];
      arr.push(b);
      map.set(day, arr);
    }
    // Sort each day's bookings by start time.
    map.forEach((arr) =>
      arr.sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || ""))),
    );
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [upcomingBookings]);

  if (grouped.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border p-10 text-center">
        <Calendar className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
        <h4 className="font-semibold mb-1">{t("transportDash.nothingScheduled", { defaultValue: "Nothing scheduled yet" })}</h4>
        <p className="text-sm text-muted-foreground">
          {t("transportDash.nothingScheduledDesc", { defaultValue: "Accepted trips and confirmed bookings will appear here as a day-by-day calendar." })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {grouped.map(([day, bookings]) => (
        <div key={day} className="bg-card rounded-2xl border border-border overflow-hidden">
          <div className="border-b border-border bg-muted/30 px-4 py-3 flex items-center justify-between">
            <p className="font-display font-bold text-sm">{formatDate(day)}</p>
            <span className="text-[11px] font-semibold text-muted-foreground">
              {bookings.length} {bookings.length === 1 ? t("transportDash.trip", { defaultValue: "trip" }) : t("transportDash.trips", { defaultValue: "trips" })}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {bookings.map((b) => {
              const tr = getTransportBookingDetails(b.notes);
              const modeLabel = tr?.mode ? transportModeLabel(tr.mode) : null;
              return (
                <li
                  key={b.id}
                  onClick={() => onSelect(b)}
                  className="cursor-pointer px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="shrink-0 grid place-items-center w-12 text-center">
                    {/* Package/day holds now carry the real working window —
                        show it; only pre-widening 00:00–23:59 artifacts fall
                        back to the bare label. */}
                    {["driver-package", "driver-day"].includes(b.serviceCategory?.toLowerCase() ?? "")
                      && b.startTime?.startsWith("00:00") && b.endTime?.startsWith("23:59") ? (
                      <span className="font-bold text-xs leading-tight">{t("transportDash.fullDay", { defaultValue: "Full day" })}</span>
                    ) : (
                      <>
                        <span className="font-bold text-sm">{formatTime(b.startTime)}</span>
                        <span className="text-[10px] text-muted-foreground">{t("transportDash.to", { defaultValue: "to" })} {formatTime(b.endTime)}</span>
                      </>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold capitalize flex items-center gap-2 flex-wrap">
                      {b.serviceCategory?.replace(/-/g, " ")}
                      {modeLabel && (
                        <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold uppercase tracking-wider">
                          {modeLabel}
                        </span>
                      )}
                    </p>
                    {(tr?.pickup || b.address) && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 truncate">
                        <MapPin className="w-3 h-3 shrink-0" /> {tr?.pickup || b.address}
                      </p>
                    )}
                  </div>
                  {formatPrice(b) && (
                    <span className="font-bold text-sm shrink-0">{formatPrice(b)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default TransportDashboard;
