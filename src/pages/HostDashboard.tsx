import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Building, Calendar, Star, Eye, BarChart3, Plus, Users, User, LogOut, MapPin, ChevronRight, IndianRupee, ArrowUpRight, ArrowDownRight, Package, Settings, Zap, Clock, Shield, ToggleLeft, ToggleRight, MessageCircle, Pencil, Phone, Ticket, TrendingUp, QrCode, Banknote } from "lucide-react";
import { InsightsPanel } from "@/components/dashboard/InsightsPanel";
import { EarningsStatement } from "@/components/dashboard/EarningsStatement";
import { EarningsTrendCard } from "@/components/dashboard/EarningsTrendCard";
import { EarningsRangePill, customRangeLabel, type CustomEarningsRange } from "@/components/dashboard/EarningsRangePill";
import { HostOnBehalfBookingModal } from "@/redesign/HostOnBehalfBookingModal";
import { AddListingChooserDialog } from "@/components/AddListingChooserDialog";
import { DashFilterSelect } from "@/components/dashboard/DashFilterSelect";
import { DashboardProfilePanel } from "@/components/dashboard/DashboardProfilePanel";
import { UserAvatar } from "@/components/UserAvatar";
import { effectiveBookingStatus } from "@/lib/booking-status";
import { bookingKindOf } from "@/lib/booking-kind";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import MyListings from "@/components/MyListings";
import EditListingModal from "@/components/EditListingModal";
import HostCouponsTab from "@/components/HostCouponsTab";
import { AwaitingPayoutTile, PayoutAccountCard, PayoutHistoryCard, PayoutNudgeBanner, PayoutStatusTiles } from "@/components/dashboard/PayoutsSection";
import { getBookingService, getListingService, getReviewService, getProviderService } from "@/domains";
import { downloadBookingTaxInvoice } from "@/lib/booking-invoice";
import type { Booking, Listing, Review } from "@/types/domain";
import { useLanguage } from "@/contexts/LanguageContext";

const STAY_CATEGORIES = new Set(["hotel", "homestay", "lodge", "village-stay", "farm-stay", "heritage", "sathram"]);

/** Display-shaped booking row built from a provider booking (see the
 *  `bookingRequests` mapping in HostDashboard) — the raw `Booking` rides
 *  along on `raw` for the details dialog / derived-status checks. */
type BookingRequestCard = {
  id: string;
  raw: Booking;
  guestUserId: string;
  guest: string;
  guestAvatar: string;
  property: string;
  dates: string;
  nights: number;
  guests: number;
  status: string;
  amount: number;
  requestedAt: string;
};

/** Review row shaped for the Reviews panel cards (see `hostReviewCards`). */
type HostReviewCard = {
  id: string;
  displayName: string;
  initials: string;
  property: string;
  date: string;
  rating: number;
  text: string;
};

const HostDashboard = () => {
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
  // Add Property no longer lives here — the button routes to
  // /onboarding?mode=form&type=host so hosts go through the same canonical
  // OnboardingForm + AI-switch surface that providers use. The previous
  // ~225-line inline modal (state, handlers, mutation, JSX) was removed
  // wholesale; nothing in this file references it anymore.
  const [editingProperty, setEditingProperty] = useState<Listing | null>(null);
  const [bookingRequests, setBookingRequests] = useState<BookingRequestCard[]>([]);
  const [bookingDetailsTarget, setBookingDetailsTarget] = useState<BookingRequestCard | null>(null);
  const [selectedListingId, setSelectedListingId] = useState<string>("");
  const [bookingMode, setBookingMode] = useState<"instant" | "manual_approval">("manual_approval");
  const [minNoticeHours, setMinNoticeHours] = useState(2);
  const [maxAdvanceDays, setMaxAdvanceDays] = useState(30);
  const [autoConfirmReturning, setAutoConfirmReturning] = useState(false);
  const [availabilityWindows, setAvailabilityWindows] = useState([
    { day: "Monday", enabled: true, start: "08:00", end: "22:00" },
    { day: "Tuesday", enabled: true, start: "08:00", end: "22:00" },
    { day: "Wednesday", enabled: true, start: "08:00", end: "22:00" },
    { day: "Thursday", enabled: true, start: "08:00", end: "22:00" },
    { day: "Friday", enabled: true, start: "08:00", end: "22:00" },
    { day: "Saturday", enabled: true, start: "08:00", end: "22:00" },
    { day: "Sunday", enabled: true, start: "08:00", end: "22:00" },
  ]);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [onBehalfOpen, setOnBehalfOpen] = useState(false);
  const [addChooserOpen, setAddChooserOpen] = useState(false);
  const { data: allProviderBookings = [] } = useQuery({
    queryKey: ["provider-bookings"],
    enabled: Boolean(user?.id),
    staleTime: 15 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 30 * 1000,
    queryFn: async () => {
      const result = await getBookingService().getProviderBookings(String(user?.id));
      if (!result.success || !result.data) throw new Error(result.error || t("host.dash.bk.loadFail"));
      return result.data;
    },
  });
  // Host dashboard only shows stay/property bookings. Classified via the
  // shared bookingKindOf — mobile-created stays store a BARE property type
  // ("hotel"), not the web's "stay:hotel", so a prefix check missed them.
  // Memoized on the source array: a bare .filter() returns a new identity
  // every render, which poisons liveProperties' useMemo and the bookingRequests
  // effect's dep array → "Maximum update depth exceeded" loop. (ProviderDashboard
  // already memoizes the same filter.)
  const providerBookings = useMemo(
    () => allProviderBookings.filter((b) => bookingKindOf(b.serviceCategory) === "stay"),
    [allProviderBookings]
  );
  const { data: liveListings } = useQuery({
    queryKey: ["my-listings", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getListingService().getByUserId(String(user?.id));
      if (!result.success || !result.data) throw new Error(result.error || t("host.dash.bk.loadListingsFail"));
      return result.data;
    },
  });

  const { data: providerProfile } = useQuery({
    queryKey: ["provider-profile", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const result = await getProviderService().getProfileByUserId(String(user?.id));
      return result.success ? result.data : null;
    },
  });
  const kycStatus = user?.verificationStatus || "pending";

  const stayListings = useMemo(
    // A draft/incomplete listing can come back from /api/listings/mine with a
    // null category (it's not published, so it never surfaces in search). It's
    // not a stay, so drop it — but guard the null FIRST: without the `l.category &&`
    // the fall-through `l.category.startsWith("stay:")` threw on that row and
    // crashed the whole dashboard into the error boundary on every render.
    () => (liveListings || []).filter((l) => !!l.category && (STAY_CATEGORIES.has(l.category) || l.category.startsWith("stay:"))),
    [liveListings]
  );

  // Reviews query keyed on stay listings only (not liveProperties — that would be
  // circular since per-property rating is derived from reviews).
  const { data: hostReviews = [] } = useQuery({
    queryKey: ["host-reviews", stayListings.map((l) => l.id).join(",")],
    enabled: stayListings.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        stayListings.map(async (listing) => {
          const response = await getReviewService().getByStayId(listing.id);
          return response.success && response.data ? response.data.map((review) => ({ ...review, property: listing.name })) : [];
        })
      );
      return results.flat();
    },
  });

  // Per-listing rating aggregation.
  const propertyRatings = useMemo(() => {
    const map = new Map<string, { sum: number; count: number }>();
    for (const r of hostReviews) {
      const entry = map.get(r.stayId) || { sum: 0, count: 0 };
      entry.sum += r.rating;
      entry.count += 1;
      map.set(r.stayId, entry);
    }
    return map;
  }, [hostReviews]);

  const liveProperties = useMemo(() => stayListings.map((listing) => {
    const listingBookings = providerBookings.filter((b) => b.providerId === listing.id);
    const inProgressCount = listingBookings.filter((b) => effectiveBookingStatus(b) === "in_progress").length;
    const rooms = Number(listing.metadata?.rooms || 1);
    const ratingEntry = propertyRatings.get(listing.id);
    return {
      id: listing.id,
      name: listing.name,
      location: listing.location || "India",
      rooms,
      available: Math.max(0, rooms - inProgressCount),
      // Occupancy = rooms currently occupied by an in-progress stay / total rooms.
      occupancy: rooms > 0 ? Math.min(100, Math.round((inProgressCount / rooms) * 100)) : 0,
      // Earnings only count once a stay is actually completed (effective status).
      earnings: listingBookings
        .filter((b) => effectiveBookingStatus(b) === "completed")
        // Same true-total preference the booking cards use — insurance and
        // coupon are part of the customer's payment, so they're part of
        // the host's earnings record.
        .reduce((total, b) => {
          const paise = (typeof b.totalPaidPaise === "number" && b.totalPaidPaise > 0)
            ? b.totalPaidPaise
            : b.agreedPricePaise;
          return total + (paise ? paise / 100 : Number(listing.price || 0));
        }, 0),
      rating: ratingEntry ? Number((ratingEntry.sum / ratingEntry.count).toFixed(1)) : 0,
      reviews: ratingEntry?.count || 0,
      image: listing.photos[0] || "",
      bookings: listingBookings.length,
      lat: listing.lat || 0,
      lng: listing.lng || 0,
      raw: listing,
    };
  }), [stayListings, providerBookings, propertyRatings]);

  const selectedListing = useMemo(
    () => liveProperties.find((listing) => listing.id === selectedListingId)?.raw || stayListings?.[0],
    [liveProperties, selectedListingId, stayListings]
  );

  const hostReviewCards = useMemo(() => {
    return hostReviews.map((review) => ({
      id: review.id,
      displayName: review.displayName || "Guest",
      initials: (review.displayName || "Guest")
        .split(" ")
        .map((part: string) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
      property: review.property || "Property",
      date: new Date(review.createdAt).toLocaleDateString("en-IN"),
      rating: review.rating,
      text: review.reviewText,
    }));
  }, [hostReviews]);

  useEffect(() => {
    if (!selectedListingId && stayListings?.[0]?.id) {
      setSelectedListingId(stayListings[0].id);
    }
  }, [stayListings, selectedListingId]);

  useEffect(() => {
    // Expired bookings are payments that never went through — they have no
    // value to the host. Drop them at the source so neither the Recent
    // Requests rail nor the Bookings tab can surface them.
    setBookingRequests(providerBookings.filter((b) => effectiveBookingStatus(b) !== "expired").map((booking) => {
      // Pull check-out and nights out of notes JSON so stay cards show a proper
      // "Apr 17 → Apr 18 · 1 night" range instead of a raw ISO timestamp.
      let checkOutStr: string | null = null;
      let notesGuests = 1;
      try {
        const parsed = booking.notes ? JSON.parse(booking.notes) : null;
        if (parsed?.checkOut) checkOutStr = String(parsed.checkOut);
        if (parsed?.guests) notesGuests = Number(parsed.guests) || 1;
      } catch { /* free-text notes */ }
      const checkInStr = booking.scheduledDate?.includes("T") ? booking.scheduledDate.split("T")[0] : booking.scheduledDate;
      const fmt = (s: string | null) => {
        if (!s) return "";
        const d = new Date(`${s}T00:00:00`);
        return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      };
      const nights = checkOutStr && checkInStr
        ? Math.max(1, Math.round((new Date(`${checkOutStr}T00:00:00`).getTime() - new Date(`${checkInStr}T00:00:00`).getTime()) / 86400000))
        : 1;
      // Display "Guest" + slice fallback only when no human-readable name is on
      // the user_profile yet. The default `display_name = 'User'` from signup is
      // not a real name — treat it as missing. Falls back to a snapshot stashed
      // on the booking's `notes` JSON at booking-creation time, then to a short
      // ID-based label.
      const profileName = booking.guestName && booking.guestName !== "User" ? booking.guestName : null;
      let snapshotName: string | null = null;
      try {
        const parsed = booking.notes ? JSON.parse(booking.notes) : null;
        if (parsed?.guestName && parsed.guestName !== "User") snapshotName = String(parsed.guestName);
      } catch { /* free-text notes */ }
      const rawName = profileName || snapshotName;
      const displayGuest = rawName || t("host.dash.guestFallback", { id: booking.userId.slice(0, 6) });
      return {
        id: booking.id,
        raw: booking,
        guestUserId: booking.userId,
        guest: displayGuest,
        guestAvatar: (rawName || booking.userId).slice(0, 2).toUpperCase(),
        property: booking.listingName || liveProperties.find((property) => property.id === booking.providerId)?.name || selectedListing?.name || t("host.dash.propertyFallback"),
        dates: checkOutStr ? `${fmt(checkInStr)} → ${fmt(checkOutStr)}` : fmt(checkInStr),
        nights,
        guests: notesGuests,
        status: booking.status === "confirmed" ? t("host.dash.statusConfirmed") : booking.status,
        amount: (() => {
          // True total paid (insurance + coupon included) wins; fall back
          // through agreed_price then listing nightly rate so the card
          // never goes blank on a legacy / draft booking.
          if (typeof booking.totalPaidPaise === "number" && booking.totalPaidPaise > 0) return booking.totalPaidPaise / 100;
          if (booking.agreedPricePaise) return booking.agreedPricePaise / 100;
          return Number(liveProperties.find((property) => property.id === booking.providerId)?.raw?.price || 0);
        })(),
        requestedAt: new Date(booking.createdAt).toLocaleDateString("en-IN"),
      };
    }));
  }, [liveProperties, providerBookings, selectedListing?.name]);

  // Gate on the listing ID, not the listing object — react-query refetches
  // produce a new object reference even when the data didn't change, and
  // depending on `selectedListing` itself made this effect fire on every
  // refetch, set 5 state values, re-render, and loop. "Maximum update
  // depth exceeded" was the symptom in the host dashboard console.
  useEffect(() => {
    if (!selectedListing) return;
    setBookingMode(selectedListing.bookingMode || "manual_approval");
    setMinNoticeHours(selectedListing.bookingRules?.minNoticeHours || 2);
    setMaxAdvanceDays(selectedListing.bookingRules?.maxAdvanceDays || 30);
    setAutoConfirmReturning(Boolean(selectedListing.bookingRules?.autoConfirmReturning));
    setAvailabilityWindows(selectedListing.metadata?.availabilityWindows || [
      { day: "Monday", enabled: true, start: "08:00", end: "22:00" },
      { day: "Tuesday", enabled: true, start: "08:00", end: "22:00" },
      { day: "Wednesday", enabled: true, start: "08:00", end: "22:00" },
      { day: "Thursday", enabled: true, start: "08:00", end: "22:00" },
      { day: "Friday", enabled: true, start: "08:00", end: "22:00" },
      { day: "Saturday", enabled: true, start: "08:00", end: "22:00" },
      { day: "Sunday", enabled: true, start: "08:00", end: "22:00" },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- we only
    // want this to fire when the user switches to a different listing,
    // not on every refetch of the same one.
  }, [selectedListing?.id]);

  const handleLogout = () => { logout(); navigate("/"); toast.success(t("host.dash.loggedOut")); };

  // Post-onboarding deep-link → preselect the listing the user just
  // created (?listing=<id>). Without this the dashboard defaults to
  // the first listing in the user's account, which is confusing right
  // after publishing a new one. Strips the param after consuming so
  // refresh / back-nav doesn't keep re-applying.
  useEffect(() => {
    const targetId = searchParams.get("listing");
    if (!targetId || !stayListings?.length) return;
    const exists = stayListings.some((l) => l.id === targetId);
    if (!exists) return;
    setSelectedListingId(targetId);
    const next = new URLSearchParams(searchParams);
    next.delete("listing");
    setSearchParams(next, { replace: true });
  }, [searchParams, stayListings, setSearchParams]);

  // Notification deep-link → open booking details modal.
  useEffect(() => {
    const targetId = searchParams.get("booking");
    if (!targetId || !bookingRequests?.length) return;
    const match = bookingRequests.find((b) => b.id === targetId);
    if (!match) return;
    setActiveTab("bookings");
    setBookingDetailsTarget(match);
    const next = new URLSearchParams(searchParams);
    next.delete("booking");
    setSearchParams(next, { replace: true });
  }, [searchParams, bookingRequests]);

  // Canonical partner tab order (mirrors Provider/Transport + mobile):
  // Overview · Analytics · My Listings · My Bookings · My Reviews ·
  // Earnings · Payment settings · Coupons · Profile.
  const tabs = [
    { id: "overview", label: t("host.dash.tabs.overview"), icon: BarChart3 },
    { id: "insights", label: t("host.dash.tabs.insights", { defaultValue: "Analytics" }), icon: Activity },
    { id: "listings", label: t("host.dash.tabs.listings"), icon: Package },
    { id: "bookings", label: t("host.dash.tabs.bookings", { defaultValue: "My Bookings" }), icon: Calendar },
    { id: "reviews", label: t("host.dash.tabs.reviews", { defaultValue: "My Reviews" }), icon: Star },
    { id: "earnings", label: t("host.dash.tabs.earnings"), icon: IndianRupee },
    { id: "payouts", label: t("host.dash.tabs.payouts", { defaultValue: "Payment settings" }), icon: Banknote },
    { id: "coupons", label: t("host.dash.tabs.coupons"), icon: Ticket },
    { id: "settings", label: t("partner.dash.tabs.profile", { defaultValue: "Profile" }), icon: User },
  ];

  // Mirror EarningsPanel's aggregation: sum all completed provider bookings
  // directly. Per-property aggregation missed bookings whose providerId didn't
  // map cleanly to a live listing id (e.g., archived or non-stay listings),
  // so the Overview tile could read ₹0 while Earnings showed real revenue.
  // The completed set + amount rule are shared with the Overview trend chart
  // so the tile and the chart's "All" range are the same number by
  // construction.
  const completedStays = providerBookings.filter((b) => effectiveBookingStatus(b) === "completed");
  const stayAmountFor = (b: Booking) => {
    // Match the same priority the booking cards use so the Overview tile
    // never diverges from Earnings.
    if (typeof b.totalPaidPaise === "number" && b.totalPaidPaise > 0) return b.totalPaidPaise / 100;
    if (b.agreedPricePaise) return b.agreedPricePaise / 100;
    const listing = liveProperties.find((p) => p.id === b.providerId)?.raw;
    return Number(listing?.price || 0);
  };
  // Stay earnings accrue at check-out (notes JSON carries checkOut), not at
  // check-in — same rule as the Earnings tab.
  const stayAccrualDate = (b: Booking) => {
    const dateStr = b.scheduledDate?.includes("T") ? b.scheduledDate.split("T")[0] : b.scheduledDate;
    let checkOut = dateStr;
    try { const parsed = b.notes ? JSON.parse(b.notes) : null; if (parsed?.checkOut) checkOut = String(parsed.checkOut); } catch { /* notes free-text */ }
    return new Date(`${checkOut}T00:00:00`);
  };
  const totalEarnings = completedStays.reduce((sum, b) => sum + stayAmountFor(b), 0);
  // "Active" = paid bookings that haven't happened yet or are mid-stay. We only
  // want to show things the host still has to care about, not historical noise.
  const activeBookingsCount = providerBookings.filter((b) => {
    const s = effectiveBookingStatus(b);
    return s === "confirmed" || s === "in_progress";
  }).length;
  const avgRating = hostReviews.length > 0
    ? (hostReviews.reduce((sum, r) => sum + r.rating, 0) / hostReviews.length).toFixed(1)
    : "—";
  const totalRooms = liveProperties.reduce((a, p) => a + p.rooms, 0);
  const occupiedRooms = liveProperties.reduce((a, p) => a + Math.min(p.rooms, p.rooms - p.available), 0);
  const avgOccupancy = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

  const stats = [
    { label: t("host.dash.stats.totalEarnings"), value: totalEarnings > 0 ? `₹${(totalEarnings / 1000).toFixed(1)}K` : "₹0", icon: IndianRupee, desc: t("host.dash.stats.completedOnly") },
    { label: t("host.dash.stats.activeBookings"), value: activeBookingsCount.toString(), icon: Calendar, desc: t("host.dash.stats.upcomingInProgress") },
    { label: t("host.dash.stats.avgRating"), value: avgRating, icon: Star, desc: hostReviews.length > 0 ? t("host.dash.stats.reviewCount", { count: hostReviews.length }) : t("host.dash.stats.noReviews") },
    { label: t("host.dash.stats.occupancy"), value: `${avgOccupancy}%`, icon: Eye, desc: t("host.dash.stats.roomsOccupied", { occupied: occupiedRooms, total: totalRooms }) },
  ];
  // Overview stat tiles deep-link to their detail tab on click.
  const statTabs = ["earnings", "bookings", "reviews", "insights"];

  const bookingStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "confirmed" | "cancelled" }) => {
      const result = await getBookingService().updateBookingStatus(id, status, "host");
      if (!result.success) throw new Error(result.error || t("host.dash.bk.updateFail"));
      return { id, status };
    },
    onSuccess: async ({ status }) => {
      await queryClient.invalidateQueries({ queryKey: ["provider-bookings"] });
      toast.success(status === "confirmed" ? t("host.dash.bk.acceptSuccess") : t("host.dash.bk.declineSuccess"));
    },
    onError: (error: Error) => toast.error(error.message),
  });


  const handleEditSave = async () => {
    await queryClient.invalidateQueries({ queryKey: ["my-listings", user?.id] });
  };

  const controlsMutation = useMutation({
    mutationFn: async () => {
      if (!selectedListing) throw new Error(t("host.dash.ctrl.selectFirst"));
      const result = await getListingService().update(selectedListing.id, {
        bookingMode,
        bookingRules: {
          minNoticeHours,
          maxAdvanceDays,
          autoConfirmReturning,
        },
        metadata: {
          ...(selectedListing.metadata || {}),
          availabilityWindows,
        },
      });
      if (!result.success) throw new Error(result.error || t("host.dash.ctrl.saveFail"));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["my-listings", user?.id] });
      toast.success(t("host.dash.ctrl.controlsSaved"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

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
                initials={user?.avatar || "RK"}
              />
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight">{t("host.dash.title")}</h1>
                <p className="text-muted-foreground text-sm">{t("host.dash.welcomeProps", { name: user?.name || "Host", properties: liveProperties.length, rooms: totalRooms })}</p>
              </div>
            </div>
            {/* Single-row toolbar — matches transport/provider dashboards.
                Label shortened to "Onboarding" to keep everything on one line. */}
            <div className="flex items-center gap-2 flex-nowrap overflow-x-auto scrollbar-hide">
              <Button variant="outline" asChild><Link to="/messages">{t("host.dash.messages")}</Link></Button>
              <Button variant="outline" onClick={() => setOnBehalfOpen(true)}>
                <QrCode className="w-4 h-4 mr-1" />Book for a guest
              </Button>
              {/* One Add entry point — the chooser dialog asks AI vs form,
                  replacing the old Onboarding + Add toolbar pair. */}
              <Button onClick={() => setAddChooserOpen(true)}>
                <Plus className="w-4 h-4 mr-1" />Add
              </Button>
            </div>
          </div>
        </div>

        {/* KYC Verification Banner */}
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
                {kycStatus === "rejected" ? t("host.dash.kyc.rejectedTitle") :
                 kycStatus === "submitted" ? t("host.dash.kyc.submittedTitle") :
                 t("host.dash.kyc.verifyTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {kycStatus === "rejected" ? t("host.dash.kyc.rejectedDesc") :
                 kycStatus === "submitted" ? t("host.dash.kyc.submittedDesc") :
                 t("host.dash.kyc.verifyDesc")}
              </p>
            </div>
            <span className="text-xs text-primary font-semibold shrink-0">{t("host.dash.kyc.verifyBtn")}</span>
          </Link>
        )}

        {/* Tabs — redesign pill nav */}
        <div className="mb-6 flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide rounded-full border border-border bg-muted/40 p-1.5 w-fit max-w-full">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-bold transition-all ${
                activeTab === tab.id
                  ? "text-white shadow-[0_10px_24px_rgba(58,50,71,0.18)] bg-[linear-gradient(135deg,#2b2436_0%,#7b5244_60%,#8b5e4a_100%)]"
                  : "text-foreground/70 hover:bg-background hover:text-foreground active:bg-background/80"
              }`}>
              <tab.icon className="h-4 w-4" />{tab.label}
            </button>
          ))}
        </div>

        {/* Overview */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            <PayoutNudgeBanner onOpen={() => setActiveTab("payouts")} />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {stats.map((s, i) => (
                <div key={i} onClick={() => setActiveTab(statTabs[i])} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTab(statTabs[i]); } }} role="button" tabIndex={0} className="cursor-pointer rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5 hover:shadow-md hover:border-primary/30 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
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
              completed={completedStays}
              amountFor={stayAmountFor}
              accrualDate={stayAccrualDate}
              className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5 sm:p-6"
            />

            {/* Recent Requests */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display font-semibold">{t("host.dash.recentRequests")}</h3>
                <button onClick={() => setActiveTab("bookings")} className="text-sm text-primary hover:underline flex items-center gap-1">{t("host.dash.viewAll")} <ChevronRight className="w-3 h-3" /></button>
              </div>
              <div className="space-y-3">
                {bookingRequests.slice(0, 3).map(b => (
                  <div
                    key={b.id}
                    onClick={() => setBookingDetailsTarget(b)}
                    className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:shadow-md transition-all cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold">{b.guestAvatar}</div>
                      <div>
                        <p className="font-medium text-sm">{b.guest}</p>
                        <p className="text-xs text-muted-foreground">{b.property} • {b.dates} • {t("host.dash.guestsCount", { count: b.guests })}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{b.requestedAt}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-bold">₹{b.amount.toLocaleString()}</span>
                      {/* Cancelled must read RED. Unmapped statuses arrive as
                          the raw slug (see status: mapping above), so match
                          "cancelled" directly. */}
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                        b.status === "cancelled" ? "bg-red-600/10 text-red-700 border border-red-600/30"
                        : "bg-success/10 text-success border border-success/20"}`}>{b.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* My Listings */}
        {activeTab === "listings" && <MyListings filter="stay" />}

        {activeTab === "earnings" && <EarningsPanel providerBookings={providerBookings} liveProperties={liveProperties} onOpenPayouts={() => setActiveTab("payouts")} />}

        {/* Payment settings — payout account first, then status tiles, period statement, history */}
        {activeTab === "payouts" && (
          <div className="space-y-5">
            <PayoutAccountCard />
            <PayoutStatusTiles />
            <EarningsStatement type="stay" listings={liveProperties.map((p) => ({ id: p.id, name: p.name }))} />
            <PayoutHistoryCard />
          </div>
        )}

        {/* Insights — partner-scoped analytics (bookings, cancellations,
            funnel, search demand) from /api/providers/me/insights. */}
        {activeTab === "insights" && <InsightsPanel category="stay" />}

        {/* Bookings — split by derived status so the host can see each pipeline stage. */}
        {activeTab === "bookings" && (
          <BookingsPanel
            providerBookings={providerBookings}
            liveProperties={liveProperties}
            bookingRequests={bookingRequests}
            onDecline={(id) => bookingStatusMutation.mutate({ id, status: "cancelled" })}
            onViewDetails={(b) => setBookingDetailsTarget(b)}
            mutationPending={bookingStatusMutation.isPending}
          />
        )}

        {/* Coupons */}
        {activeTab === "coupons" && <HostCouponsTab stayListings={stayListings} />}

        {/* Reviews */}
        {activeTab === "reviews" && (
          <ReviewsPanel
            hostReviewCards={hostReviewCards}
            hostReviews={hostReviews}
            avgRating={avgRating}
            liveProperties={liveProperties}
          />
        )}

        {/* Profile — shared editable panel (same as Provider / Transport) */}
        {activeTab === "settings" && (
          <DashboardProfilePanel
            roleNoun={t("host.dash.profile.defaultName", { defaultValue: "Host" })}
            verified={kycStatus === "verified"}
            verifiedLabel={t("host.dash.verifiedHost", { defaultValue: "Verified host" })}
            rating={avgRating}
            reviewCount={hostReviews.length}
            stats={[
              { label: t("host.dash.profile.bookings", { defaultValue: "Bookings" }), value: `${providerBookings.length}` },
              { label: t("host.dash.profile.rating", { defaultValue: "Rating" }), value: hostReviews.length > 0 ? `${avgRating}` : "—", sub: hostReviews.length > 0 ? t("host.dash.profile.reviewCount", { defaultValue: "{{count}} reviews", count: hostReviews.length }) : t("host.dash.profile.noReviews", { defaultValue: "No reviews yet" }) },
              { label: t("host.dash.profile.memberSince", { defaultValue: "Member since" }), value: user?.memberSince || "—" },
              { label: t("host.dash.profile.verification", { defaultValue: "Verification" }), value: kycStatus === "verified" ? t("host.dash.profile.verified", { defaultValue: "Verified" }) : kycStatus === "submitted" ? t("host.dash.profile.underReview", { defaultValue: "Under review" }) : kycStatus === "rejected" ? t("host.dash.profile.needsAttention", { defaultValue: "Needs attention" }) : t("host.dash.profile.notSubmitted", { defaultValue: "Not submitted" }) },
            ]}
            details={[
              { label: t("host.dash.profile.properties", { defaultValue: "Properties" }), value: stayListings && stayListings.length > 0 ? stayListings.map((l) => l.name).join(", ") : t("host.dash.profile.noneYet", { defaultValue: "None yet" }) },
              { label: t("host.dash.profile.totalRooms", { defaultValue: "Total rooms" }), value: `${totalRooms}` },
            ]}
            onLogout={handleLogout}
          />
        )}
        {/* Edit Property Modal — shared component */}
        {editingProperty && (
          <EditListingModal listing={editingProperty} onClose={() => setEditingProperty(null)} onSave={handleEditSave} />
        )}
      </div>

      <BookingDetailsDialog
        target={bookingDetailsTarget}
        onClose={() => setBookingDetailsTarget(null)}
      />

      <AddListingChooserDialog open={addChooserOpen} onOpenChange={setAddChooserOpen} type="host" />
      <HostOnBehalfBookingModal
        open={onBehalfOpen}
        onOpenChange={setOnBehalfOpen}
        stayListings={stayListings}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ["provider-bookings"] });
          queryClient.invalidateQueries({ queryKey: ["bookings"] });
        }}
      />
    </div>
  );
};

function BookingDetailsDialog({ target, onClose }: { target: BookingRequestCard | null; onClose: () => void }) {
  const { t } = useLanguage();
  if (!target) return (
    <Dialog open={false} onOpenChange={(o) => !o && onClose()}><DialogContent /></Dialog>
  );
  // `raw` is always set when a card is built, but keep the legacy `|| {}`
  // guard — cast rather than Partial so `effectiveBookingStatus` (which
  // requires `status`) accepts it unchanged.
  const raw = (target.raw || {}) as Booking;
  const derived = effectiveBookingStatus(raw);
  let checkOut: string | null = null;
  try {
    const parsed = raw.notes ? JSON.parse(raw.notes) : null;
    if (parsed?.checkOut) checkOut = String(parsed.checkOut);
  } catch { /* free-text notes */ }
  const fmt = (s?: string | null) => {
    if (!s) return "—";
    const dateOnly = s.includes("T") ? s.split("T")[0] : s;
    const d = new Date(`${dateOnly}T00:00:00`);
    return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  };
  const fmtTime = (s?: string) => {
    if (!s) return "";
    const [h, m] = s.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${(m || 0).toString().padStart(2, "0")} ${ampm}`;
  };
  // Prefer the true total paid (includes insurance + coupon discount) over
  // the host-facing agreed_price. Falls back to agreedPricePaise then the
  // target row's pre-computed amount so legacy / unpaid rows still render.
  const priceP = (typeof raw.totalPaidPaise === "number" && raw.totalPaidPaise > 0)
    ? raw.totalPaidPaise
    : raw.agreedPricePaise;
  const price = priceP
    ? `₹${(priceP / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : (target.amount ? `₹${target.amount.toLocaleString("en-IN")}` : null);
  const rows: Array<[string, string | null]> = [
    [t("host.dash.bk.dlg.bookingId", { defaultValue: "Booking" }), raw.id?.slice(0, 8) || null],
    [t("host.dash.bk.dlg.guest", { defaultValue: "Guest" }), target.guest || null],
    [t("host.dash.bk.dlg.status", { defaultValue: "Status" }), derived],
    [t("guest.bookings.checkIn", { defaultValue: "Check-in" }), fmt(raw.scheduledDate)],
    [t("guest.bookings.checkOut", { defaultValue: "Check-out" }), checkOut ? fmt(checkOut) : null],
    [t("host.dash.bk.dlg.time", { defaultValue: "Time" }), raw.startTime && raw.endTime ? `${fmtTime(raw.startTime)} – ${fmtTime(raw.endTime)}` : null],
    [t("host.dash.bk.dlg.guests", { defaultValue: "Guests" }), target.guests ? String(target.guests) : null],
    [t("host.dash.bk.dlg.amount", { defaultValue: "Amount" }), price],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">{target.property || t("host.dash.propertyFallback")}</DialogTitle>
          <DialogDescription className="capitalize">
            {raw.serviceCategory?.replace(/-/g, " ") || ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5 mt-2">
          {rows.map(([label, value]) => value ? (
            <div key={label} className="flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground shrink-0">{label}</span>
              <span className="font-medium text-right break-words capitalize">{value}</span>
            </div>
          ) : null)}
          {raw.guestPhone && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground shrink-0">{t("host.dash.bk.dlg.guestPhone", { defaultValue: "Guest phone" })}</span>
              <a
                href={`tel:${raw.guestPhone}`}
                className="font-medium text-right break-words text-primary hover:underline flex items-center gap-1 justify-end"
              >
                <Phone className="w-3 h-3 shrink-0" />{raw.guestPhone}
              </a>
            </div>
          )}
          {raw.address && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <span className="text-muted-foreground shrink-0">{t("guest.bookings.addressLabel", { defaultValue: "Address" })}</span>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(raw.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-right break-words text-primary hover:underline flex items-center gap-1 justify-end"
              >
                <MapPin className="w-3 h-3 shrink-0" />{raw.address}
              </a>
            </div>
          )}
          {raw.notes && !raw.notes.trim().startsWith("{") && (
            <div className="pt-2 border-t border-border/60">
              <p className="text-xs text-muted-foreground mb-1">{t("guest.bookings.notesLabel", { defaultValue: "Notes" })}</p>
              <p className="text-sm">{raw.notes}</p>
            </div>
          )}
          {/* Invoice exists only for paid bookings — hidden for cancelled /
              expired / pending (guest Bookings page behaves the same). */}
          {(derived === "confirmed" || derived === "completed") && (
          <div className="pt-3 border-t border-border/60">
            <Button
              variant="outline"
              className="w-full rounded-xl"
              onClick={async () => {
                try {
                  await downloadBookingTaxInvoice(raw.id);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to download invoice");
                }
              }}
            >
              {t("host.dash.bk.dlg.downloadInvoice", { defaultValue: "Download invoice" })}
            </Button>
          </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

type LiveProperty = {
  id: string;
  name: string;
  raw: Listing;
};

/**
 * Bookings panel — split by derived status.
 *
 * Only real bookings appear here: paid (Upcoming/Completed) or Cancelled. The
 * backend never returns unpaid holds ('pending') or lapsed holds ('expired')
 * on the provider scope. Statuses flow through `effectiveBookingStatus` so a
 * confirmed stay whose check-out already passed shows up under Completed, not
 * Upcoming.
 */
function BookingsPanel({
  providerBookings,
  liveProperties,
  bookingRequests,
  onDecline,
  onViewDetails,
  mutationPending,
}: {
  providerBookings: Booking[];
  liveProperties: LiveProperty[];
  bookingRequests: BookingRequestCard[];
  onDecline: (id: string) => void;
  onViewDetails: (b: BookingRequestCard) => void;
  mutationPending: boolean;
}) {
  const { t } = useLanguage();
  const [sub, setSub] = useState<"upcoming" | "completed" | "cancelled">("upcoming");

  // Map rawBooking.id → derived status so we can slice.
  const bucketed = useMemo(() => {
    const b: Record<string, string> = {};
    for (const bk of providerBookings) b[bk.id] = effectiveBookingStatus(bk);
    return b;
  }, [providerBookings]);

  const counts = useMemo(() => {
    const c = { upcoming: 0, completed: 0, cancelled: 0 };
    for (const bk of providerBookings) {
      const s = bucketed[bk.id];
      if (s === "completed") c.completed += 1;
      else if (s === "cancelled") c.cancelled += 1;
      // "in_progress" stays roll into Upcoming so a host can still see active stays in one place.
      else if (s === "confirmed" || s === "in_progress") c.upcoming += 1;
    }
    return c;
  }, [providerBookings, bucketed]);

  const filtered = useMemo(() => {
    return bookingRequests.filter((b) => {
      const s = bucketed[b.id];
      if (!s) return false;
      if (sub === "upcoming") return s === "confirmed" || s === "in_progress";
      if (sub === "completed") return s === "completed";
      if (sub === "cancelled") return s === "cancelled";
      return false;
    });
  }, [bookingRequests, bucketed, sub]);

  const subTabs: Array<{ id: typeof sub; label: string; count: number }> = [
    { id: "upcoming", label: t("host.dash.bk.tabUpcoming"), count: counts.upcoming },
    { id: "completed", label: t("host.dash.bk.tabCompleted"), count: counts.completed },
    { id: "cancelled", label: t("host.dash.bk.tabCancelled"), count: counts.cancelled },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="font-display font-semibold text-lg">{t("host.dash.bk.title")}</h2>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-1 bg-success/10 text-success font-medium rounded-full">{t("host.dash.bk.upcomingChip", { count: counts.upcoming })}</span>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {subTabs.map((st) => (
          <button
            key={st.id}
            onClick={() => setSub(st.id)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
              sub === st.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-card border border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {st.label}
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${sub === st.id ? "bg-primary-foreground/20" : "bg-muted"}`}>{st.count}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-10 text-center text-sm text-muted-foreground">
          {t("host.dash.bk.empty", { status: t(`host.dash.bk.status${sub.charAt(0).toUpperCase() + sub.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`, { defaultValue: sub.replace("_", " ") }) })}
        </div>
      )}

      {filtered.map((b) => {
        const derived = bucketed[b.id] || "confirmed";
        const statusKey = derived === "confirmed" ? "Upcoming" : derived === "in_progress" ? "InProgress" : derived.charAt(0).toUpperCase() + derived.slice(1);
        const statusLabel = t(`host.dash.bk.status${statusKey}`, { defaultValue: statusKey });
        const statusClass =
          derived === "confirmed" ? "bg-success/10 text-success border border-success/20" :
          derived === "in_progress" ? "bg-warning/10 text-warning border border-warning/20" :
          derived === "completed" ? "bg-muted text-foreground border border-border" :
          // cancelled: a clear red, not the muted destructive rose.
          "bg-red-600/10 text-red-700 border border-red-600/30";
        return (
          <div
            key={b.id}
            onClick={() => onViewDetails(b)}
            className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-4 sm:p-5 hover:shadow-md transition-all cursor-pointer"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold">{b.guestAvatar}</div>
                <div>
                  <p className="font-medium text-sm">{b.guest}</p>
                  <p className="text-xs text-muted-foreground">{t("host.dash.bk.cardMeta", { property: b.property, dates: b.dates, nights: b.nights, guests: b.guests })}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{t("host.dash.bk.requested", { date: b.requestedAt })}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-bold text-lg">₹{b.amount.toLocaleString()}</span>
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${statusClass}`}>{statusLabel}</span>
                {(derived === "confirmed" || derived === "in_progress") && b.guestUserId && (
                  <Link to={`/messages?user=${b.guestUserId}`} onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="outline" className="rounded-full text-xs">
                      <MessageCircle className="w-3.5 h-3.5 mr-1" />{t("host.dash.bk.message")}
                    </Button>
                  </Link>
                )}
                {(derived === "confirmed" || derived === "in_progress") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full text-xs text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(t("host.dash.bk.cancelConfirm"))) onDecline(b.id);
                    }}
                    disabled={mutationPending}
                  >
                    {t("host.dash.bk.cancel")}
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
 * Earnings panel — real numbers from completed bookings, sliced by time window.
 *
 * Earnings attach at check-out, not at booking time. That's what the host
 * actually banks, and it's what "Completed stays only" on the Overview tile
 * refers to.
 */
function EarningsPanel({
  providerBookings,
  liveProperties,
  onOpenPayouts,
}: {
  providerBookings: Booking[];
  liveProperties: LiveProperty[];
  /** Jump to the dashboard's Payouts tab (awaiting-payout tile). */
  onOpenPayouts?: () => void;
}) {
  const { t } = useLanguage();
  // `now` must be declared before any code that reads it — the FY default
  // and start-of-range calc both depend on it. Hoisting it to the top of
  // the panel was the fix for the Earnings tab rendering blank: previously
  // the temporal-dead-zone reference threw a ReferenceError at render and
  // the panel got stuck on its loading state.
  const now = new Date();
  const [range, setRange] = useState<"week" | "month" | "year" | "all" | "fy" | "custom">("month");
  // fyYear = the April-start year of the FY being viewed (e.g. 2025 = FY 25-26)
  const currentFyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const [fyYear, setFyYear] = useState(currentFyYear);
  // Exact [from, to] window for the Custom pill (inclusive, YYYY-MM-DD).
  const [customRange, setCustomRange] = useState<CustomEarningsRange | null>(null);

  const completed = useMemo(
    () => providerBookings.filter((b) => effectiveBookingStatus(b) === "completed"),
    [providerBookings]
  );

  // Per-listing filter: "all" or a listing id (providerId on the booking).
  // Filters the whole panel — totals, chart, and breakdown.
  const [listingFilter, setListingFilter] = useState<string>("all");
  const filtered = useMemo(
    () => (listingFilter === "all" ? completed : completed.filter((b) => (b.providerId || "unknown") === listingFilter)),
    [completed, listingFilter]
  );

  const amountFor = (b: Booking) => {
    // Earnings should reflect the true total the guest paid — base + platform
    // + GST + insurance − coupon. `totalPaidPaise` comes from the LATERAL-
    // joined payment row; we fall back to `agreedPricePaise` for legacy
    // rows and finally the listing's nightly rate.
    if (typeof b.totalPaidPaise === "number" && b.totalPaidPaise > 0) return b.totalPaidPaise / 100;
    if (b.agreedPricePaise) return b.agreedPricePaise / 100;
    const listing = liveProperties.find((p) => p.id === b.providerId)?.raw;
    return Number(listing?.price || 0);
  };

  // End-of-stay date → when the earnings actually accrued.
  // Normalize the time to HH:MM:SS because Postgres TIME columns return
  // "HH:MM:SS" and a naive `${time}:00` would double up the seconds → NaN.
  const normTime = (t: string) => {
    const parts = t.split(":");
    return `${(parts[0] || "00").padStart(2, "0")}:${(parts[1] || "00").padStart(2, "0")}:${(parts[2] || "00").padStart(2, "0")}`;
  };
  const endDateOf = (b: Booking): Date => {
    const dateStr = b.scheduledDate?.includes("T") ? b.scheduledDate.split("T")[0] : b.scheduledDate;
    let checkOut = dateStr;
    try { const parsed = b.notes ? JSON.parse(b.notes) : null; if (parsed?.checkOut) checkOut = String(parsed.checkOut); } catch { /* free-text notes */ }
    return new Date(`${checkOut}T${normTime(b.endTime || "11:00")}`);
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
    () => filtered.filter((b) => {
      const d = endDateOf(b);
      if (endOfRange) return d >= startOfRange && d <= endOfRange;
      return d >= startOfRange;
    }),
    [filtered, startOfRange, endOfRange]
  );

  const total = inRange.reduce((sum, b) => sum + amountFor(b), 0);
  const allTimeTotal = filtered.reduce((sum, b) => sum + amountFor(b), 0);

  // Bucket into per-day / per-month rows for the bar chart.
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

  const byProperty = useMemo(() => {
    const map = new Map<string, { name: string; total: number; count: number }>();
    for (const b of inRange) {
      const prop = liveProperties.find((p) => p.id === b.providerId);
      const key = b.providerId || "unknown";
      const entry = map.get(key) || { name: prop?.name || "Property", total: 0, count: 0 };
      entry.total += amountFor(b);
      entry.count += 1;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [inRange, liveProperties]);

  const avgPerStay = inRange.length > 0 ? total / inRange.length : 0;

  const fyLabel = `FY ${String(fyYear).slice(2)}-${String(fyYear + 1).slice(2)}`;

  const rangeTabs: Array<{ id: typeof range; label: string }> = [
    { id: "week", label: t("host.dash.earn.week") },
    { id: "month", label: t("host.dash.earn.month") },
    { id: "year", label: t("host.dash.earn.year") },
    { id: "fy", label: "Fin. Year" },
    { id: "all", label: t("host.dash.earn.all") },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-display font-semibold text-lg">{t("host.dash.earn.title")}</h2>
        <div className="flex items-center gap-2 flex-wrap">
          {liveProperties.length > 1 && (
            <DashFilterSelect
              value={listingFilter}
              onChange={setListingFilter}
              ariaLabel={t("host.dash.earn.allListings", { defaultValue: "All listings" })}
              options={[
                { value: "all", label: t("host.dash.earn.allListings", { defaultValue: "All listings" }) },
                ...liveProperties.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          )}
          <div className="flex gap-2 overflow-x-auto scrollbar-hide">
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
          </div>
          {range === "fy" && (
            <div className="flex items-center gap-1 bg-card border border-border rounded-full px-2 py-1">
              <button
                onClick={() => setFyYear(y => y - 1)}
                className="w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70"
              >‹</button>
              <span className="text-xs font-semibold px-1 whitespace-nowrap">{fyLabel}</span>
              <button
                onClick={() => setFyYear(y => Math.min(y + 1, currentFyYear))}
                disabled={fyYear >= currentFyYear}
                className="w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted/70 disabled:opacity-30"
              >›</button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5">
          <div className="w-10 h-10 rounded-xl bg-success/10 text-success flex items-center justify-center mb-3"><IndianRupee className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">₹{total.toLocaleString("en-IN")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{range === "custom" && customRange ? customRangeLabel(customRange) : rangeTabs.find((r) => r.id === range)?.label}</p>
        </div>
        <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5">
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-3"><Calendar className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">{inRange.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t("host.dash.earn.completedStays")}</p>
        </div>
        <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5">
          <div className="w-10 h-10 rounded-xl bg-secondary/10 text-secondary flex items-center justify-center mb-3"><TrendingUp className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">₹{Math.round(avgPerStay).toLocaleString("en-IN")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t("host.dash.earn.avgPerStay")}</p>
        </div>
        <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5">
          <div className="w-10 h-10 rounded-xl bg-muted text-foreground flex items-center justify-center mb-3"><BarChart3 className="w-5 h-5" /></div>
          <p className="text-2xl font-bold">₹{allTimeTotal.toLocaleString("en-IN")}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t("host.dash.earn.allTime")}</p>
        </div>
      </div>

      {/* Trend chart */}
      <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5 sm:p-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
          <h3 className="font-display font-semibold">{range === "fy" ? `${fyLabel} Breakdown` : monthlyBuckets ? t("host.dash.earn.monthlyBreakdown") : t("host.dash.earn.dailyBreakdown")}</h3>
          {(() => {
            // Period-over-period delta: compare the back half of the bucket
            // list to the front half. Cheap, doesn't need an extra query.
            if (buckets.length < 2) return null;
            const mid = Math.floor(buckets.length / 2);
            const first = buckets.slice(0, mid).reduce((s, [, v]) => s + v, 0);
            const second = buckets.slice(mid).reduce((s, [, v]) => s + v, 0);
            if (first === 0 && second === 0) return null;
            const pct = first === 0 ? 100 : Math.round(((second - first) / first) * 100);
            const up = pct >= 0;
            return (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full ${up ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {up ? "+" : ""}{pct}%
              </span>
            );
          })()}
        </div>
        {buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t("host.dash.earn.emptyRange")}</p>
        ) : (
          <>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={buckets.map(([key, value]) => ({ key, value }))} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="hostEarningsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(239, 84%, 67%)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(239, 84%, 67%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="key" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `₹${v}`} />
                  <Tooltip formatter={(v: number) => [`₹${Number(v).toLocaleString("en-IN")}`, "Earnings"]} />
                  <Area type="monotone" dataKey="value" stroke="hsl(239, 84%, 67%)" strokeWidth={2} fill="url(#hostEarningsFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2 mt-5">
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
          </>
        )}
      </div>

      {/* By property — only meaningful when not already filtered to one */}
      {listingFilter === "all" && (
      <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5 sm:p-6">
        <h3 className="font-display font-semibold mb-4">{t("host.dash.earn.byProperty")}</h3>
        {byProperty.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t("host.dash.earn.emptyProp")}</p>
        ) : (
          <div className="space-y-2">
            {byProperty.map((p, i) => (
              <div key={i} className="flex items-center justify-between bg-muted/30 rounded-xl px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-[10px] text-muted-foreground">{t("host.dash.earn.stays", { count: p.count })}</p>
                </div>
                <span className="font-bold text-success">₹{p.total.toLocaleString("en-IN")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* The payouts management surface lives in its own tab; Earnings keeps
          just the balance tile so the number is findable where people look. */}
      {onOpenPayouts && <AwaitingPayoutTile onOpen={onOpenPayouts} />}
    </div>
  );
}
/**
 * Reviews panel — real avg, property filter, rating histogram, sort + infinite
 * scroll. Client-side pagination (we already have every review in memory from
 * the aggregate query).
 */
function ReviewsPanel({
  hostReviewCards,
  hostReviews,
  avgRating,
  liveProperties,
}: {
  hostReviewCards: HostReviewCard[];
  hostReviews: Array<Review & { property: string }>;
  avgRating: string;
  liveProperties: LiveProperty[];
}) {
  const { t } = useLanguage();
  const [propertyFilter, setPropertyFilter] = useState<string>("all");
  const [ratingFilter, setRatingFilter] = useState<number | "all">("all");
  const [sort, setSort] = useState<"newest" | "oldest" | "highest" | "lowest">("newest");
  const [visible, setVisible] = useState(10);

  // Rating histogram (1..5).
  const histogram = useMemo(() => {
    const counts = [0, 0, 0, 0, 0];
    for (const r of hostReviews) {
      const idx = Math.min(5, Math.max(1, Math.round(r.rating))) - 1;
      counts[idx] += 1;
    }
    return counts; // index 0 = 1 star ... index 4 = 5 stars
  }, [hostReviews]);

  // Merge cards + raw review for filter/sort (cards already carry displayName etc.).
  const merged = useMemo(
    () => hostReviewCards.map((c) => {
      const raw = hostReviews.find((r) => r.id === c.id);
      return { ...c, rawRating: raw?.rating || c.rating, createdAt: raw?.createdAt, stayId: raw?.stayId };
    }),
    [hostReviewCards, hostReviews]
  );

  const filtered = useMemo(() => {
    let list = merged;
    if (propertyFilter !== "all") list = list.filter((r) => r.stayId === propertyFilter);
    if (ratingFilter !== "all") list = list.filter((r) => Math.round(r.rawRating) === ratingFilter);
    const sorted = [...list].sort((a, b) => {
      if (sort === "highest") return b.rawRating - a.rawRating;
      if (sort === "lowest") return a.rawRating - b.rawRating;
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sort === "oldest" ? ta - tb : tb - ta;
    });
    return sorted;
  }, [merged, propertyFilter, ratingFilter, sort]);

  // Reset pagination when filters change.
  useEffect(() => { setVisible(10); }, [propertyFilter, ratingFilter, sort]);

  // Infinite scroll via IntersectionObserver on a sentinel div.
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

  const numericAvg = hostReviews.length > 0 ? Number(avgRating) : 0;

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-6">
        <div className="grid md:grid-cols-2 gap-6 items-center">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 mb-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} className={`w-6 h-6 ${n <= Math.round(numericAvg) ? "fill-secondary text-secondary" : "fill-secondary/20 text-secondary/20"}`} />
              ))}
            </div>
            <p className="text-4xl font-bold">{avgRating}</p>
            <p className="text-sm text-muted-foreground">{hostReviews.length === 1 ? t("host.dash.rev.avgAllOne") : t("host.dash.rev.avgAll", { count: hostReviews.length })}</p>
          </div>
          <div className="space-y-1.5">
            {[5, 4, 3, 2, 1].map((star) => {
              const count = histogram[star - 1];
              const pct = hostReviews.length > 0 ? (count / hostReviews.length) * 100 : 0;
              return (
                <button
                  key={star}
                  onClick={() => setRatingFilter(ratingFilter === star ? "all" : star)}
                  className={`w-full flex items-center gap-2 hover:bg-muted/50 rounded px-2 py-1 transition-colors ${ratingFilter === star ? "bg-muted/70" : ""}`}
                >
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

      {/* Filters */}
      <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-3 sm:p-4 flex flex-wrap items-center gap-2">
        <DashFilterSelect
          value={propertyFilter}
          onChange={setPropertyFilter}
          ariaLabel={t("host.dash.rev.allProps")}
          options={[
            { value: "all", label: t("host.dash.rev.allProps") },
            ...liveProperties.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <DashFilterSelect
          value={String(ratingFilter)}
          onChange={(v) => setRatingFilter(v === "all" ? "all" : Number(v))}
          ariaLabel={t("host.dash.rev.allRatings")}
          options={[
            { value: "all", label: t("host.dash.rev.allRatings") },
            ...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: t("host.dash.rev.starsOpt", { count: n }) })),
          ]}
        />
        <DashFilterSelect
          value={sort}
          onChange={(v) => setSort(v as typeof sort)}
          ariaLabel={t("host.dash.rev.newest")}
          options={[
            { value: "newest", label: t("host.dash.rev.newest") },
            { value: "oldest", label: t("host.dash.rev.oldest") },
            { value: "highest", label: t("host.dash.rev.highest") },
            { value: "lowest", label: t("host.dash.rev.lowest") },
          ]}
        />
        <span className="text-xs text-muted-foreground ml-auto">{t("host.dash.rev.count", { count: filtered.length })}</span>
      </div>

      {filtered.length === 0 && (
        <div className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-10 text-center text-sm text-muted-foreground">
          {t("host.dash.rev.noMatch")}
        </div>
      )}

      {filtered.slice(0, visible).map((review) => (
        <div key={review.id} className="rounded-2xl border border-white/70 bg-white/64 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] p-5 hover:shadow-md transition-all">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold">{review.initials}</div>
              <div>
                <span className="font-medium text-sm">{review.displayName}</span>
                <p className="text-[10px] text-muted-foreground">{review.property}</p>
              </div>
            </div>
            <span className="text-xs text-muted-foreground">{review.date}</span>
          </div>
          <div className="flex gap-0.5 mb-2">
            {Array.from({ length: Math.round(review.rating) }).map((_, index) => (
              <Star key={index} className="w-4 h-4 fill-secondary text-secondary" />
            ))}
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">{review.text}</p>
        </div>
      ))}

      {/* Sentinel for infinite scroll */}
      {visible < filtered.length && (
        <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">{t("host.dash.rev.loadingMore")}</div>
      )}
    </div>
  );
}

export default HostDashboard;
