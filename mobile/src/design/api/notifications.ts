// design/api/notifications.ts — in-app notifications (GET list, mark read).
import { api } from "@/lib/api";

export type Notif = {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  icon: string;
  tone: string;
  time: string; // relative ("2m", "1h", "3d")
  // Preserved so a tapped notification can deep-link to its target (booking,
  // thread, …). `link` is the web route; mobile routes off `metadata`.
  metadata: Record<string, unknown>;
  link?: string;
};

// Map a backend notification type → an icon + accent tone for the row.
function metaFor(type: string): { icon: string; tone: string } {
  const t = (type || "").toLowerCase();
  if (t.includes("cancel")) return { icon: "calendar", tone: "coral" };
  if (t.includes("confirm") || t.includes("booking")) return { icon: "badge", tone: "saffron" };
  if (t.includes("payment") || t.includes("refund") || t.includes("payout")) return { icon: "card", tone: "blue" };
  if (t.includes("coupon") || t.includes("promo") || t.includes("discount")) return { icon: "ticket", tone: "coral" };
  if (t.includes("review")) return { icon: "starFill", tone: "saffron" };
  if (t.includes("driver") || t.includes("transport") || t.includes("ride")) return { icon: "car", tone: "blue" };
  if (t.includes("verif") || t.includes("kyc")) return { icon: "badge", tone: "blue" };
  return { icon: "bell", tone: "aubergine" };
}

function relTime(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function mapNotif(n: any): Notif {
  const { icon, tone } = metaFor(n.type);
  return {
    id: n.id,
    type: n.type,
    title: n.title || "Notification",
    message: n.message || n.body || "",
    read: !!n.is_read,
    icon,
    tone,
    time: relTime(n.created_at),
    metadata: n.metadata && typeof n.metadata === "object" ? n.metadata : {},
    link: typeof n.link === "string" ? n.link : undefined,
  };
}

export async function fetchNotifications(): Promise<Notif[]> {
  const res = await api.get("/api/notifications", { params: { limit: 50 } });
  const items = res.data?.data ?? res.data ?? [];
  return (Array.isArray(items) ? items : []).map(mapNotif);
}

export async function markNotificationRead(id: string) {
  const res = await api.patch(`/api/notifications/${id}/read`);
  return res.data?.data ?? res.data;
}

export async function markAllNotificationsRead() {
  const res = await api.post("/api/notifications/mark-all-read");
  return res.data?.data ?? res.data;
}
