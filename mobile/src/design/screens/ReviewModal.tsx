// design/screens/ReviewModal.tsx — the star-rating bottom sheet (moved out of
// BookingsScreen so the app-open review prompt can reuse the exact same UI),
// plus ReviewPromptHost: the post-completion prompt mounted at the Navigator
// root.
//
// Prompt rules (mirrors web src/components/ReviewPromptGate.tsx — keep the
// seeding/dismissal semantics in sync):
//  - Backlog-safe: the FIRST run for a user seeds every currently-pending
//    booking as dismissed, so shipping this never buries existing users under
//    old bookings — only bookings that finish afterwards prompt.
//  - One prompt per app open (newest completion first).
//  - Closing without submitting retires that booking permanently — it never
//    auto-prompts again (the manual "Write a review" on the Bookings tab card
//    remains available).
//  - Server truth for "already reviewed": /api/reviews/me/pending only returns
//    bookings without a pinned review. Dismissals stay device-local
//    (AsyncStorage), following the api/recentSearches.ts pattern.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Modal, TextInput, ActivityIndicator, Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "../Icon";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { createReview, fetchPendingReviewPrompts, PendingReviewPrompt } from "../api/reviews";
import { T, font, noOutline } from "../theme";
import { Booking } from "../types";

/** The subset of Booking the review sheet needs — a full Booking satisfies it,
 *  and the prompt host can synthesize one from a pending-review candidate. */
export type ReviewableBooking = Pick<Booking, "id" | "kind" | "title" | "listingId" | "providerId">;

export function ReviewModal({ booking, onClose, onSubmitted }: {
  booking: ReviewableBooking | null;
  onClose: () => void;
  onSubmitted?: () => void;
}) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { if (booking) { setRating(5); setComment(""); } }, [booking?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!booking) return;
    if (!comment.trim()) { Alert.alert(t("m.bookings.addCommentTitle", { defaultValue: "Add a comment" }), t("m.bookings.addCommentBody", { defaultValue: "Tell other guests about your experience." })); return; }
    setSubmitting(true);
    try {
      await createReview({
        kind: booking.kind,
        listingId: booking.listingId,
        providerId: booking.providerId,
        bookingId: booking.id,
        rating,
        comment: comment.trim(),
        displayName: user?.name || undefined,
      });
      onSubmitted?.();
      onClose();
      Alert.alert(t("m.bookings.reviewThanksTitle", { defaultValue: "Thank you!" }), t("m.bookings.reviewThanksBody", { defaultValue: "Your review has been posted." }));
    } catch (e: any) {
      Alert.alert(t("m.bookings.reviewFailedTitle", { defaultValue: "Couldn't post review" }), e?.response?.data?.error?.message || e?.message || t("m.bookings.tryAgain", { defaultValue: "Please try again." }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={!!booking} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>{t("m.bookings.reviewTitle", { defaultValue: "Review {{title}}", title: booking?.title ?? "" })}</Text>
        <Text style={styles.sheetSub}>{t("m.bookings.reviewPrompt", { defaultValue: "How was your experience?" })}</Text>

        <View style={styles.stars}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable key={n} onPress={() => setRating(n)} hitSlop={6}>
              <Icon name="star" size={34} color={n <= rating ? T.terra : "rgba(58,50,71,0.18)"} />
            </Pressable>
          ))}
        </View>

        <TextInput
          value={comment}
          onChangeText={setComment}
          placeholder={t("m.bookings.reviewPlaceholder", { defaultValue: "Share details of your stay/service…" })}
          placeholderTextColor={T.muted}
          multiline
          style={styles.reviewInput}
        />

        <Pressable style={[styles.submit, submitting && { opacity: 0.7 }]} onPress={submitting ? undefined : submit}>
          <Text style={styles.submitTxt}>{submitting ? t("m.bookings.posting", { defaultValue: "Posting…" }) : t("m.bookings.postReview", { defaultValue: "Post review" })}</Text>
        </Pressable>
        {submitting && <ActivityIndicator color={T.aubergine} style={{ marginTop: 8 }} />}
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// ReviewPromptHost — app-open review prompt (mounted in Navigator.tsx).
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "istaseva:review-prompts:v1:";
const MAX_DISMISSED = 300;

type PromptState = { seeded: boolean; dismissed: string[] };

async function loadState(userId: string): Promise<PromptState | null> {
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.seeded !== "boolean" || !Array.isArray(parsed.dismissed)) return null;
    return { seeded: parsed.seeded, dismissed: parsed.dismissed.map(String) };
  } catch {
    return null;
  }
}

async function saveState(userId: string, state: PromptState) {
  try {
    await AsyncStorage.setItem(
      `${STORAGE_PREFIX}${userId}`,
      JSON.stringify({ ...state, dismissed: state.dismissed.slice(-MAX_DISMISSED) }),
    );
  } catch { /* storage failed — prompt again next open, harmless */ }
}

/** Booking-shaped object for the shared sheet, from a pending candidate. */
function toReviewable(c: PendingReviewPrompt, fallbackTitle: string): ReviewableBooking {
  return {
    id: c.bookingId,
    kind: c.kind,
    title: c.listingName || c.serviceCategory?.replace(/-/g, " ") || fallbackTitle,
    listingId: c.listingId ?? undefined,
    providerId: c.providerId ?? undefined,
  };
}

export function ReviewPromptHost() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<PendingReviewPrompt | null>(null);
  // One prompt per app open, even across refetches.
  const shownForUser = useRef<string | null>(null);

  const userId = user?.id ?? null;

  const pendingQuery = useQuery({
    queryKey: ["review-prompts", userId],
    queryFn: fetchPendingReviewPrompts,
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const candidates = pendingQuery.data;
  useEffect(() => {
    if (!userId || !candidates || shownForUser.current === userId) return;
    let cancelled = false;
    void (async () => {
      const state = await loadState(userId);
      if (cancelled || shownForUser.current === userId) return;
      if (!state?.seeded) {
        // First run for this user: retire the entire backlog silently so only
        // bookings that finish AFTER this feature ships ever prompt.
        await saveState(userId, { seeded: true, dismissed: candidates.map((c) => c.bookingId) });
        shownForUser.current = userId;
        return;
      }
      const dismissed = new Set(state.dismissed);
      const next = candidates.find((c) => !dismissed.has(c.bookingId) && (c.listingId || c.providerId));
      if (!next) return;
      shownForUser.current = userId;
      setTarget(next);
    })();
    return () => { cancelled = true; };
  }, [userId, candidates]);

  const retire = (bookingId: string) => {
    if (!userId) return;
    void (async () => {
      const state = (await loadState(userId)) ?? { seeded: true, dismissed: [] };
      if (!state.dismissed.includes(bookingId)) state.dismissed.push(bookingId);
      await saveState(userId, { ...state, seeded: true });
    })();
    setTarget(null);
  };

  if (!userId || !target) return null;

  return (
    <ReviewModal
      booking={toReviewable(target, t("m.bookings.yourBooking", { defaultValue: "your booking" }))}
      onClose={() => retire(target.bookingId)}
      onSubmitted={() => {
        retire(target.bookingId);
        void queryClient.invalidateQueries({ queryKey: ["review-prompts", userId] });
        void queryClient.invalidateQueries({ queryKey: ["reviews", target.listingId] });
      }}
    />
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(23,20,29,0.4)" },
  sheet: { backgroundColor: "#f7f3ee", borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 40 },
  sheetHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.18)", marginBottom: 16 },
  sheetTitle: { fontFamily: font.head, fontSize: 18, color: T.ink },
  sheetSub: { fontFamily: font.body, fontSize: 13.5, color: T.muted, marginTop: 4 },
  stars: { flexDirection: "row", justifyContent: "center", gap: 10, marginVertical: 18 },
  reviewInput: { minHeight: 100, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.9)", padding: 14, textAlignVertical: "top", fontFamily: font.body, fontSize: 15, color: T.ink, ...noOutline },
  submit: { marginTop: 16, paddingVertical: 15, borderRadius: 16, backgroundColor: T.aubergine, alignItems: "center" },
  submitTxt: { fontFamily: font.bodyHeavy, fontSize: 15, color: "#fff" },
});
