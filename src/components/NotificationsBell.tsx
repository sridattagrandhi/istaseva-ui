import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

// Global notifications bell for the navbar. Shows the unread count and
// links to the standalone /notifications page (web parity with mobile).
// Replaces the four per-dashboard NotificationsDropdown instances — the
// badge poll AND the stale-cache invalidation that used to live there now
// run here, app-wide.
export const NotificationsBell = () => {
  const [unreadCount, setUnreadCount] = useState(0);
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  // Track the last-seen latest-notification id; when a new id appears we
  // invalidate the bookings caches so a host-side cancel surfaces on the
  // guest's bookings page (and vice versa) within the next poll tick.
  const lastSeenIdRef = useRef<string | null>(null);

  const fetchUnread = useCallback(async () => {
    if (!user?.id) return;
    try {
      const result = await apiRequest<{ data: { id: string; type: string }[]; unreadCount: number }>(
        "/api/notifications?limit=1",
      );
      if (result.success && result.data) {
        setUnreadCount(result.data.unreadCount || 0);
        const newest = result.data.data?.[0];
        if (newest && lastSeenIdRef.current && newest.id !== lastSeenIdRef.current) {
          // Backend tags notification rows with verbose types like
          // `booking_confirmed`, `booking_cancelled`, `new_booking`,
          // `booking_completed`, `payment`. Any of those imply the bookings
          // cache is now stale; invalidate broadly.
          const nt = newest.type;
          if (nt.startsWith("booking") || nt === "new_booking" || nt === "payment" || nt === "message") {
            queryClient.invalidateQueries({ queryKey: ["bookings"] });
            queryClient.invalidateQueries({ queryKey: ["provider-bookings"] });
            queryClient.invalidateQueries({ queryKey: ["partner-bookings"] });
          }
        }
        lastSeenIdRef.current = newest?.id ?? null;
      }
    } catch {
      // silently fail — bell icon stays visible
    }
  }, [user?.id, queryClient]);

  // Fetch on mount + a 20s background poll so the badge tracks changes made
  // on another device or by another party without a manual refresh.
  useEffect(() => {
    fetchUnread();
    const id = setInterval(fetchUnread, 20000);
    return () => clearInterval(id);
  }, [fetchUnread]);

  if (!user?.id) return null;

  return (
    <Link
      to="/notifications"
      className="relative inline-grid h-10 w-10 place-items-center rounded-full border border-white/70 bg-white/55 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:bg-white/75"
      aria-label={t("nav.notifications", { defaultValue: "Notifications" })}
    >
      <Bell className="h-[17px] w-[17px]" />
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </Link>
  );
};

export default NotificationsBell;
