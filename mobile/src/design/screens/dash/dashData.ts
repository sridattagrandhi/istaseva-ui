// dash/dashData.ts — dashboard STRUCTURE only (tabs, stat labels/icons, role
// titles). No mock content: listings/bookings/coupons/reviews/earnings come
// from the backend (DashboardScreen overlays useMyListings / useProviderBookings
// / useCoupons / useEarnings / useProviderReviews); empty here = empty states.
import { Tone } from "../../theme";
import { Review } from "../../types";

export type DashStat = { label: string; value: string; desc: string; icon: string };
export type DashListing = { name: string; location: string; status: string; price: string; metric: string; rating: number; icon: string; tone: Tone };
export type DashBooking = { guest: string; avatar: string; item: string; meta: string; amount: number; status: string; when: string; tone: Tone; icon: string;
  // Present on real backend bookings — power the host booking detail (the same
  // breakdown the guest sees). Optional so the bundled mock rows still satisfy.
  id?: string; kind?: "stay" | "service" | "transport"; roomCount?: number; guestCount?: number;
  // Guest's phone for the host/provider booking detail (tap-to-call). From the
  // on-behalf guest_contact when present, else the guest's profile phone.
  guestPhone?: string;
  // Transport vehicle snapshot for the host booking detail (the booked car).
  vehicleModel?: string; vehiclePlate?: string; vehicleColor?: string;
  breakdown?: { subtotal: number; fee: number; tax: number; insurance: number; discount: number; total: number };
};
export type DashCoupon = { code: string; off: string; desc: string; used: string; status: string; id?: string; active?: boolean };
export type DashRole = {
  role: string;
  title: string;
  welcome: string;
  addLabel: string;
  profile: { name: string; avatar: string; email: string; phone: string; memberSince: string; verified: boolean };
  kyc: string;
  tabs: [string, string, string][];
  stats: DashStat[];
  earnings: { total: string; sub: string; series: [string, number][] };
  listingsLabel: string;
  listings: DashListing[];
  bookings: DashBooking[];
  coupons: DashCoupon[];
  reviews: { rating: number; count: number; list: Review[] };
  profileRows: [string, string][];
};

const EMPTY_PROFILE = { name: "", avatar: "", email: "", phone: "", memberSince: "", verified: false };
const NO_EARNINGS = { total: "₹0", sub: "Last 30 days", series: [] as [string, number][] };
const NO_REVIEWS = { rating: 0, count: 0, list: [] as Review[] };

export const DASH: Record<string, DashRole> = {
  host: {
    role: "host", title: "Host Dashboard", welcome: "", addLabel: "Add property",
    profile: EMPTY_PROFILE, kyc: "",
    tabs: [["overview", "Overview", "chart"], ["insights", "Analytics", "chart"], ["listings", "My Listings", "home"], ["bookings", "My Bookings", "calendar"], ["reviews", "My Reviews", "starFill"], ["earnings", "Earnings", "wallet"], ["payouts", "Payment settings", "card"], ["coupons", "Coupons", "ticket"], ["profile", "Profile", "user"]],
    stats: [
      { label: "Total earnings", value: "₹0", desc: "Last 30 days", icon: "card" },
      { label: "Active bookings", value: "0", desc: "Upcoming & in-progress", icon: "calendar" },
      { label: "Avg rating", value: "—", desc: "No reviews yet", icon: "starFill" },
      { label: "Listings", value: "0", desc: "Published", icon: "home" },
    ],
    earnings: NO_EARNINGS,
    listingsLabel: "Properties",
    listings: [], bookings: [], coupons: [], reviews: NO_REVIEWS, profileRows: [],
  },
  provider: {
    role: "provider", title: "Provider Dashboard", welcome: "", addLabel: "Add service",
    profile: EMPTY_PROFILE, kyc: "",
    tabs: [["overview", "Overview", "chart"], ["insights", "Analytics", "chart"], ["listings", "My Services", "sparkle"], ["bookings", "My Bookings", "clock"], ["reviews", "My Reviews", "starFill"], ["earnings", "Earnings", "wallet"], ["payouts", "Payment settings", "card"], ["coupons", "Coupons", "ticket"], ["profile", "Profile", "user"]],
    stats: [
      { label: "Total earnings", value: "₹0", desc: "Last 30 days", icon: "card" },
      { label: "Jobs done", value: "0", desc: "Completed jobs", icon: "check" },
      { label: "Rating", value: "—", desc: "No reviews yet", icon: "starFill" },
      { label: "Listings", value: "0", desc: "Published", icon: "sparkle" },
    ],
    earnings: NO_EARNINGS,
    listingsLabel: "Services",
    listings: [], bookings: [], coupons: [], reviews: NO_REVIEWS, profileRows: [],
  },
  transport: {
    role: "transport", title: "Transport Dashboard", welcome: "", addLabel: "Add vehicle",
    profile: EMPTY_PROFILE, kyc: "",
    tabs: [["overview", "Overview", "chart"], ["insights", "Analytics", "chart"], ["listings", "My Vehicles", "car"], ["bookings", "My Bookings", "calendar"], ["reviews", "My Reviews", "starFill"], ["earnings", "Earnings", "wallet"], ["payouts", "Payment settings", "card"], ["coupons", "Coupons", "ticket"], ["profile", "Profile", "user"]],
    stats: [
      { label: "Total earnings", value: "₹0", desc: "Last 30 days", icon: "card" },
      { label: "Trips done", value: "0", desc: "Completed trips", icon: "check" },
      { label: "Rating", value: "—", desc: "No reviews yet", icon: "starFill" },
      { label: "Listings", value: "0", desc: "Published", icon: "car" },
    ],
    earnings: NO_EARNINGS,
    listingsLabel: "Vehicles",
    listings: [], bookings: [], coupons: [], reviews: NO_REVIEWS, profileRows: [],
  },
};
