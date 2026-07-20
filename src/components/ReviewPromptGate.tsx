import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReviewModal from "@/components/ReviewModal";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { getReviewService } from "@/domains";
import type { PendingReviewPrompt } from "@/domains/reviews/review.service";

/**
 * Post-completion review prompt (app-open gate).
 *
 * When a guest's booking finishes (checkout / scheduled date passed), the next
 * app open pops the existing ReviewModal for it. Rules:
 *  - Backlog-safe: the FIRST run for a user seeds every currently-pending
 *    booking as dismissed, so shipping this never buries existing users under
 *    old bookings — only bookings that finish afterwards prompt.
 *  - One prompt per app open (newest completion first).
 *  - Closing without submitting retires that booking permanently — it never
 *    auto-prompts again (the manual "Write a review" on the booking card in
 *    /bookings remains available).
 *  - Server truth for "already reviewed": /api/reviews/me/pending only returns
 *    bookings without a pinned review, so reviewing from the card (or another
 *    device) removes the prompt everywhere. Dismissals stay device-local.
 *
 * Mirrors mobile's ReviewPromptHost in mobile/src/design/screens/ReviewModal.tsx
 * — keep the seeding/dismissal semantics in sync.
 */

// Same skip-set as TermsReconsentDialog: never prompt mid-auth-flow.
const AUTH_ROUTES = new Set(["/signup", "/login", "/verify-email", "/reset-password", "/forgot-password"]);

const STORAGE_PREFIX = "istaseva:review-prompts:v1:";
const MAX_DISMISSED = 300;

type PromptState = { seeded: boolean; dismissed: string[] };

function loadState(userId: string): PromptState | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.seeded !== "boolean" || !Array.isArray(parsed.dismissed)) return null;
    return { seeded: parsed.seeded, dismissed: parsed.dismissed.map(String) };
  } catch {
    return null;
  }
}

function saveState(userId: string, state: PromptState) {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${userId}`,
      JSON.stringify({ ...state, dismissed: state.dismissed.slice(-MAX_DISMISSED) }),
    );
  } catch { /* storage full/blocked — prompt again next open, harmless */ }
}

const ReviewPromptGate = () => {
  const { user } = useAuth();
  const { t } = useLanguage();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<PendingReviewPrompt | null>(null);
  // One prompt per app open, even across route changes / query refetches.
  const shownForUser = useRef<string | null>(null);

  const userId = user?.id ?? null;
  const onAuthRoute = AUTH_ROUTES.has(location.pathname);

  const pendingQuery = useQuery({
    queryKey: ["review-prompts", userId],
    queryFn: async () => {
      const result = await getReviewService().getPendingPrompts();
      if (!result.success || !result.data) throw new Error(result.error || "pending reviews unavailable");
      return result.data;
    },
    enabled: !!userId && !onAuthRoute,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const candidates = pendingQuery.data;
  useEffect(() => {
    if (!userId || !candidates || shownForUser.current === userId) return;
    const state = loadState(userId);
    if (!state?.seeded) {
      // First run for this user: retire the entire backlog silently so only
      // bookings that finish AFTER this feature ships ever prompt.
      saveState(userId, { seeded: true, dismissed: candidates.map((c) => c.bookingId) });
      shownForUser.current = userId;
      return;
    }
    const dismissed = new Set(state.dismissed);
    const next = candidates.find((c) => !dismissed.has(c.bookingId) && (c.listingId || c.providerId));
    if (!next) return;
    shownForUser.current = userId;
    setTarget(next);
  }, [userId, candidates]);

  const retire = (bookingId: string) => {
    if (!userId) return;
    const state = loadState(userId) ?? { seeded: true, dismissed: [] };
    if (!state.dismissed.includes(bookingId)) state.dismissed.push(bookingId);
    saveState(userId, { ...state, seeded: true });
    setTarget(null);
  };

  const listingName = useMemo(() => {
    if (!target) return "";
    return (
      target.listingName
      || target.serviceCategory?.replace(/-/g, " ")
      || t("guest.details.listing", { defaultValue: "Listing" })
    );
  }, [target, t]);

  if (!userId || onAuthRoute || !target) return null;

  return (
    <ReviewModal
      listingId={target.listingId || target.providerId!}
      listingName={listingName}
      bookingId={target.bookingId}
      onClose={() => retire(target.bookingId)}
      onSubmitted={() => {
        retire(target.bookingId);
        queryClient.invalidateQueries({ queryKey: ["review-prompts", userId] });
        queryClient.invalidateQueries({ queryKey: ["bookings"] });
      }}
    />
  );
};

export default ReviewPromptGate;
