import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, Calendar, Star, Wrench, CheckCircle, CheckCheck, Clock, MessageCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePushNotifications, permissionState, pushSupported, type PushPermissionState } from "@/hooks/usePushNotifications";
import BackButton from "@/components/BackButton";

// Standalone notifications page (web parity with mobile's
// NotificationsScreen). Reached from the global bell in the navbar and the
// account menu; replaces the per-dashboard NotificationsDropdown panels.
interface Notification {
  id: string;
  type: "booking" | "review" | "service" | "system" | "message" | "payment" | "verification" | "safety";
  title: string;
  message: string;
  link?: string | null;
  is_read: boolean;
  created_at: string;
}

const iconMap: Record<string, any> = {
  booking: Calendar,
  review: Star,
  service: Wrench,
  system: CheckCircle,
  message: MessageCircle,
  payment: CheckCircle,
  verification: CheckCircle,
  safety: Wrench,
};

const colorMap: Record<string, string> = {
  booking: "bg-primary/10 text-primary",
  review: "bg-secondary/10 text-secondary",
  service: "bg-accent/10 text-accent",
  system: "bg-success/10 text-success",
  message: "bg-blue-500/10 text-blue-500",
  payment: "bg-success/10 text-success",
  verification: "bg-primary/10 text-primary",
  safety: "bg-destructive/10 text-destructive",
};

function timeAgo(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("notifDropdown.justNow", { defaultValue: "Just now" });
  if (mins < 60) return t("notifDropdown.minAgo", { defaultValue: "{{count}} min ago", count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("notifDropdown.hourAgo", { defaultValue: "{{count}} hour ago", defaultValue_plural: "{{count}} hours ago", count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 7) return t("notifDropdown.dayAgo", { defaultValue: "{{count}} day ago", defaultValue_plural: "{{count}} days ago", count: days });
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

const Notifications = () => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  // Browser-push permission CTA — same three states as the old dropdown:
  // default → enable button, denied → muted hint, granted/unsupported → hidden.
  const [pushPerm, setPushPerm] = useState<PushPermissionState>(() => permissionState());
  const [pushEnabling, setPushEnabling] = useState(false);
  const { t } = useLanguage();
  const { user } = useAuth();
  const { enable: enablePush } = usePushNotifications();
  const navigate = useNavigate();

  const fetchNotifications = useCallback(async () => {
    if (!user?.id) return;
    try {
      const result = await apiRequest<{ data: Notification[]; unreadCount: number }>("/api/notifications?limit=50");
      if (result.success && result.data) {
        setNotifications(result.data.data || []);
        setUnreadCount(result.data.unreadCount || 0);
      }
    } catch {
      // best effort — the page just shows its empty state
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  // Fetch on mount + a 20s background poll so a status change made by
  // another party shows up without a manual refresh (same cadence as the
  // navbar bell).
  useEffect(() => {
    fetchNotifications();
    const id = setInterval(fetchNotifications, 20000);
    return () => clearInterval(id);
  }, [fetchNotifications]);

  const handleEnablePush = async () => {
    if (pushEnabling) return;
    setPushEnabling(true);
    try {
      const result = await enablePush();
      if (result === "granted") {
        toast.success(t("notifDropdown.toastEnabled", { defaultValue: "Browser notifications enabled." }));
      } else if (result === "denied") {
        toast.error(t("notifDropdown.toastBlocked", { defaultValue: "Notifications were blocked. Re-enable them in your browser's site settings." }));
      } else if (result === "unsupported" || result === "missing-config") {
        toast.error(t("notifDropdown.toastUnsupported", { defaultValue: "This browser doesn't support push notifications." }));
      }
      setPushPerm(permissionState());
    } finally {
      setPushEnabling(false);
    }
  };

  const markAsRead = async (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await apiRequest(`/api/notifications/${id}/read`, { method: "PATCH" });
    } catch { /* best effort */ }
  };

  const markAllRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    setUnreadCount(0);
    try {
      await apiRequest("/api/notifications/mark-all-read", { method: "POST" });
    } catch { /* best effort */ }
  };

  // Mark read + follow the notification's target. Mark-read and navigation
  // are independent so re-tapping an already-read row still navigates.
  const handleTap = (n: Notification) => {
    if (!n.is_read) markAsRead(n.id);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="min-h-screen">
      <div className="max-w-[800px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <BackButton className="mb-3" label={t("common.back", { defaultValue: "Back" })} />
        {/* Page header — glassy redesign tile, same surface language as the
            other account pages. */}
        <div className="mb-6 rounded-[18px] border border-white/70 bg-white/64 p-5 sm:p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className="inline-grid h-11 w-11 place-items-center rounded-2xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_26px_rgba(58,50,71,0.18)]"
                style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #c08a5a 100%)" }}
              >
                <Bell className="h-5 w-5" />
              </div>
              <div>
                <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight">{t("notifDropdown.title", { defaultValue: "Notifications" })}</h1>
                <p className="text-sm text-muted-foreground">
                  {unreadCount > 0
                    ? t("notifPage.unreadCount", { count: unreadCount, defaultValue: "{{count}} unread" })
                    : t("notifPage.allCaughtUp", { defaultValue: "You're all caught up" })}
                </p>
              </div>
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="inline-flex items-center gap-2 self-start sm:self-auto rounded-full border border-border bg-card px-4 py-2 text-[13px] font-bold text-primary transition-colors hover:bg-muted/60"
              >
                <CheckCheck className="w-4 h-4" />
                {t("notifDropdown.markAllRead", { defaultValue: "Mark all read" })}
              </button>
            )}
          </div>
        </div>

        {/* Push-permission CTA (default) / blocked hint (denied). */}
        {user?.id && pushSupported() && pushPerm === "default" && (
          <div className="mb-4 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3">
            <div className="flex items-start gap-3">
              <Bell className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground">{t("notifDropdown.ctaTitle", { defaultValue: "Get instant booking alerts" })}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {t("notifDropdown.ctaDesc", { defaultValue: "Browser notifications for new bookings, messages, and status updates." })}
                </p>
                <button
                  onClick={handleEnablePush}
                  disabled={pushEnabling}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-[11px] font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {pushEnabling ? t("notifDropdown.enabling", { defaultValue: "Enabling…" }) : t("notifDropdown.enableBtn", { defaultValue: "Enable browser notifications" })}
                </button>
              </div>
            </div>
          </div>
        )}
        {user?.id && pushPerm === "denied" && (
          <div className="mb-4 rounded-2xl border border-border bg-muted/40 px-4 py-2.5 flex items-start gap-2">
            <BellOff className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground">
              {t("notifDropdown.deniedNote", { defaultValue: "Browser notifications are blocked for this site. Re-enable them from the lock icon in your address bar." })}
            </p>
          </div>
        )}

        {/* Notification list */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          {loading && notifications.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="py-16 text-center">
              <Bell className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">{t("notifDropdown.empty", { defaultValue: "No notifications yet" })}</p>
              <p className="text-xs text-muted-foreground mt-1">{t("notifPage.emptyHint", { defaultValue: "Booking updates, messages, and alerts will show up here." })}</p>
            </div>
          ) : (
            notifications.map(n => {
              const Icon = iconMap[n.type] || CheckCircle;
              const color = colorMap[n.type] || colorMap.system;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleTap(n)}
                  className={`flex w-full items-start gap-3 px-4 sm:px-5 py-3.5 text-left transition-colors border-b border-border/50 last:border-0 hover:bg-muted/40 ${
                    !n.is_read ? "bg-primary/[0.03]" : ""
                  } ${n.link ? "cursor-pointer" : "cursor-default"}`}
                >
                  <div className={`w-9 h-9 rounded-xl ${color} flex items-center justify-center shrink-0 mt-0.5`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className={`text-sm ${!n.is_read ? "font-semibold" : "font-medium"} truncate`}>{n.title}</p>
                      {!n.is_read && <span className="w-2 h-2 bg-primary rounded-full shrink-0" />}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                    <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                      <Clock className="w-3 h-3" />{timeAgo(n.created_at, t)}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default Notifications;
