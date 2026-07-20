// design/screens/chatCards.tsx — inline cards rendered inside the Ista AI chat
// feed. Each mirrors its web counterpart (src/components/assistant/*Inline.tsx):
// the agent's action carries the payload, the card is the user-facing render —
// and for cancel/message-host, the explicit consent gate before the side effect.
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Image, TextInput, ActivityIndicator } from "react-native";
import { Icon } from "../Icon";
import { T, font, noOutline } from "../theme";
import { useDesign } from "../DesignContext";
import {
  InlineListingHit, InlineBooking, BookingInsights, CancelBookingRequest, HostMessageDraft,
} from "../api/assistant";
import { fetchCancelPreview, cancelBookingAsGuest, CancelPreview } from "../api/bookings";
import { sendMessage } from "../api/chat";
import { WishType } from "../api/wishlist";
import { useLanguage } from "@/contexts/LanguageContext";

/** Normalise a hit's `type` into a wishlist bucket / detail route. Stays carry
 *  many property types (hotel/homestay/lodge/…) — mirrors the web savedBucket. */
export function listingBucket(type: string): WishType {
  const t = (type || "").toLowerCase();
  if (/transport|driver|cab|auto|taxi|vehicle|tempo|bike/.test(t)) return "transport";
  if (t === "service") return "service";
  if (/stay|hotel|homestay|lodge|villa|resort|guesthouse|guest house|heritage|sathram|farm|hostel|apartment|room|cottage|bungalow|village/.test(t)) return "stay";
  return "service";
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-06-15" → "Jun 15, 2026" without pulling in a date lib. */
function fmtIso(iso?: string): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MON[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
}

/* ------------------------- show_listing_cards ------------------------- */

export function ListingCardsInline({ hits, onOpen, onBook }: {
  hits: InlineListingHit[];
  onOpen: (hit: InlineListingHit) => void;
  /** "Book" hands the listing back to the agent (prepare_booking flow). */
  onBook: (hit: InlineListingHit) => void;
}) {
  const { wish, toggleWish } = useDesign();
  const { t } = useLanguage();
  if (!hits.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 6 }}>
      {hits.map((hit) => {
        const saved = wish.has(hit.id);
        const bucket = listingBucket(hit.type);
        return (
          <View key={hit.id} style={c.hitCard}>
            <Pressable style={c.heart} onPress={() => toggleWish(hit.id, bucket)} hitSlop={8}>
              <Icon name={saved ? "heartFill" : "heart"} size={15} color={saved ? T.coral : T.muted} />
            </Pressable>
            <Pressable onPress={() => onOpen(hit)}>
              {hit.image && /^https?:/.test(hit.image) ? (
                <Image source={{ uri: hit.image }} style={c.hitImg} />
              ) : (
                <View style={[c.hitImg, { alignItems: "center", justifyContent: "center" }]}>
                  <Icon name={bucket === "stay" ? "bedDouble" : bucket === "transport" ? "car" : "sparkle"} size={26} color={T.muted} />
                </View>
              )}
            </Pressable>
            <View style={{ padding: 10, gap: 3 }}>
              <Text style={c.hitTitle} numberOfLines={1}>{hit.title}</Text>
              {!!hit.location && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                  <Icon name="mappin" size={11} color={T.muted} />
                  <Text style={c.hitSub} numberOfLines={1}>{hit.location}</Text>
                </View>
              )}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={c.hitPrice} numberOfLines={1}>{hit.price ?? ""}</Text>
                {typeof hit.rating === "number" && hit.rating > 0 && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                    <Icon name="starFill" size={11} color="#d99a2b" />
                    <Text style={c.hitRating}>{hit.rating.toFixed(1)}</Text>
                  </View>
                )}
              </View>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 5 }}>
                <Pressable style={c.hitBtnOutline} onPress={() => onOpen(hit)}>
                  <Text style={c.hitBtnOutlineTxt}>{t("m.chatcards.open", { defaultValue: "Open" })}</Text>
                </Pressable>
                <Pressable style={c.hitBtnFill} onPress={() => onBook(hit)}>
                  <Text style={c.hitBtnFillTxt}>{t("m.chatcards.book", { defaultValue: "Book" })}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

/* --------------------------- show_bookings ---------------------------- */

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  confirmed: { bg: "rgba(46,125,82,0.12)", fg: "#2e7d52" },
  completed: { bg: "rgba(46,125,82,0.12)", fg: "#2e7d52" },
  pending: { bg: "rgba(217,154,43,0.14)", fg: "#a06a14" },
  cancelled: { bg: "rgba(214,69,93,0.12)", fg: "#c2425c" },
  refunded: { bg: "rgba(214,69,93,0.12)", fg: "#c2425c" },
};

export function BookingsListInline({ bookings, onManage }: {
  bookings: InlineBooking[];
  onManage: () => void;
}) {
  const { t } = useLanguage();
  if (!bookings.length) return null;
  return (
    <View style={{ gap: 7 }}>
      {bookings.map((b) => {
        const tone = STATUS_TONE[b.status] ?? { bg: "rgba(58,50,71,0.08)", fg: T.muted };
        const date = fmtIso(b.start);
        return (
          <View key={b.id} style={c.card}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={c.strong} numberOfLines={1}>{b.listing ?? t("m.chatcards.bookingFallback", { defaultValue: "Booking" })}</Text>
                {!!b.provider && <Text style={c.sub} numberOfLines={1}>{b.provider}</Text>}
              </View>
              <View style={[c.pill, { backgroundColor: tone.bg }]}>
                <Text style={[c.pillTxt, { color: tone.fg }]}>{b.status}</Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                {!!date && <Icon name="calendar" size={12} color={T.muted} />}
                {!!date && <Text style={c.sub}>{date}</Text>}
              </View>
              {!!b.amount && <Text style={c.amount}>{b.amount}</Text>}
            </View>
          </View>
        );
      })}
      <Pressable style={c.footerBtn} onPress={onManage}>
        <Text style={c.footerTxt}>{t("m.chatcards.manageInBookings", { defaultValue: "Manage in Bookings" })}</Text>
        <Icon name="chevR" size={13} color={T.terra} />
      </Pressable>
    </View>
  );
}

/* --------------------------- show_insights ---------------------------- */

export function InsightsStripInline({ insights, onViewAll }: {
  insights: BookingInsights;
  onViewAll: () => void;
}) {
  const { t } = useLanguage();
  const nextDate = fmtIso(insights.nextTrip?.date);
  // Show the cancelled bucket only when there are any — keeps the common case
  // a clean 3-up but lets the visible counts reconcile with the agent's total.
  const showCancelled = insights.counts.cancelled > 0;
  return (
    <View style={[c.card, { gap: 10 }]}>
      <View style={{ flexDirection: "row" }}>
        <View style={c.stat}>
          <View style={c.statHead}>
            <Icon name="wallet" size={11} color={T.muted} />
            <Text style={c.statLabel}>{t("m.chatcards.spent", { defaultValue: "Spent" })}</Text>
          </View>
          <Text style={c.statValue}>{insights.totalSpent}</Text>
        </View>
        <View style={c.stat}>
          <Text style={c.statLabel}>{t("m.chatcards.upcoming", { defaultValue: "Upcoming" })}</Text>
          <Text style={c.statValue}>{insights.counts.upcoming}</Text>
        </View>
        <View style={c.stat}>
          <Text style={c.statLabel}>{t("m.chatcards.past", { defaultValue: "Past" })}</Text>
          <Text style={c.statValue}>{insights.counts.past}</Text>
        </View>
        {showCancelled && (
          <View style={c.stat}>
            <Text style={c.statLabel}>{t("m.chatcards.cancelled", { defaultValue: "Cancelled" })}</Text>
            <Text style={[c.statValue, { color: "#c2425c" }]}>{insights.counts.cancelled}</Text>
          </View>
        )}
      </View>
      {insights.nextTrip && (
        <View style={c.nextTrip}>
          <Text style={c.statLabel}>{t("m.chatcards.nextTrip", { defaultValue: "Next trip" })}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
            <Text style={[c.strong, { flex: 1 }]} numberOfLines={1}>{insights.nextTrip.listing ?? t("m.chatcards.bookingFallback", { defaultValue: "Booking" })}</Text>
            {!!nextDate && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon name="calendar" size={12} color={T.muted} />
                <Text style={c.sub}>{nextDate}</Text>
              </View>
            )}
          </View>
        </View>
      )}
      <Pressable onPress={onViewAll} style={{ alignItems: "center" }} hitSlop={6}>
        <Text style={c.footerTxt}>{t("m.chatcards.viewAllBookings", { defaultValue: "View all bookings" })}</Text>
      </Pressable>
    </View>
  );
}

/* ----------------------- confirm_cancel_booking ----------------------- */

/**
 * Explicit user gate before a cancellation: the agent's cancel_booking_preview
 * tool surfaced the refund, this card fires the actual PATCH only on Confirm.
 * The refund preview re-fetches on mount so the shown amount is current.
 */
export function CancelBookingCard({ req, onDone }: {
  req: CancelBookingRequest;
  /** ok=true when the booking was actually cancelled. */
  onDone: (ok: boolean, note: string) => void;
}) {
  const { t } = useLanguage();
  type CardState = "idle" | "cancelling" | "done" | "failed" | "kept";
  const [state, setState] = useState<CardState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  useEffect(() => {
    let gone = false;
    fetchCancelPreview(req.bookingId)
      .then((p) => { if (!gone) setPreview(p); })
      .catch(() => {})
      .finally(() => { if (!gone) setPreviewLoading(false); });
    return () => { gone = true; };
  }, [req.bookingId]);

  const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  const cancel = async () => {
    setState("cancelling");
    setError(null);
    try {
      await cancelBookingAsGuest(req.bookingId);
      setState("done");
      onDone(true, t("m.chatcards.cancelDoneNote", { defaultValue: "Done — your booking is cancelled. Any refund will be processed to your original payment method." }));
    } catch (e: any) {
      setState("failed");
      const msg = e?.message || t("m.chatcards.cancelError", { defaultValue: "Couldn't cancel the booking. Please try again." });
      setError(msg);
      onDone(false, t("m.chatcards.cancelFailedNote", { defaultValue: "Cancellation failed: {{msg}}", msg }));
    }
  };

  return (
    <View style={c.card}>
      <View style={{ flexDirection: "row", gap: 9 }}>
        <Icon name="info" size={16} color="#a06a14" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={c.strong}>{t("m.chatcards.cancelTitle", { defaultValue: "Cancel this booking?" })}</Text>
          {!!req.summary && <Text style={[c.sub, { marginTop: 2 }]}>{req.summary}</Text>}
          {previewLoading ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 }}>
              <ActivityIndicator size="small" color={T.muted} />
              <Text style={c.sub}>{t("m.chatcards.calculatingRefund", { defaultValue: "Calculating refund…" })}</Text>
            </View>
          ) : preview ? (
            <View style={{ marginTop: 5, gap: 2 }}>
              <Text style={c.body}>
                {preview.refundRupees > 0
                  ? <>{t("m.chatcards.youllGetBack", { defaultValue: "You'll get back" })} <Text style={c.strong}>{rupees(preview.refundRupees)}</Text>{preview.platformKeepsRupees > 0 ? t("m.chatcards.retainedSuffix", { defaultValue: " ({{amount}} retained)", amount: rupees(preview.platformKeepsRupees) }) : ""}</>
                  : t("m.chatcards.noRefund", { defaultValue: "No refund applies." })}
              </Text>
              {!!preview.reason && <Text style={c.sub}>{preview.reason}</Text>}
              {preview.insuranceVoided && <Text style={c.sub}>{t("m.chatcards.protectionVoided", { defaultValue: "Trip protection will be voided." })}</Text>}
            </View>
          ) : (
            <Text style={[c.sub, { marginTop: 5 }]}>{t("m.chatcards.refundPolicyNote", { defaultValue: "The refund follows the listing's cancellation policy." })}</Text>
          )}
        </View>
      </View>

      {state === "failed" && !!error && <Text style={c.error}>{error}</Text>}

      {state === "done" ? (
        <View style={c.doneRow}>
          <Icon name="check" size={15} color="#2e7d52" />
          <Text style={c.doneTxt}>{t("m.chatcards.bookingCancelled", { defaultValue: "Booking cancelled" })}</Text>
        </View>
      ) : state === "kept" ? (
        <View style={c.doneRow}>
          <Icon name="check" size={15} color={T.muted} />
          <Text style={[c.doneTxt, { color: T.muted }]}>{t("m.chatcards.bookingKept", { defaultValue: "Booking kept" })}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 11 }}>
          <Pressable style={[c.btnDanger, state === "cancelling" && { opacity: 0.6 }]} disabled={state === "cancelling"} onPress={cancel}>
            {state === "cancelling" && <ActivityIndicator size="small" color="#fff" />}
            <Text style={c.btnDangerTxt}>{state === "cancelling" ? t("m.chatcards.cancelling", { defaultValue: "Cancelling…" }) : t("m.chatcards.confirmCancel", { defaultValue: "Confirm cancel" })}</Text>
          </Pressable>
          <Pressable
            style={c.btnGhost}
            disabled={state === "cancelling"}
            onPress={() => { setState("kept"); onDone(false, t("m.chatcards.keptNote", { defaultValue: "No problem — I've kept the booking as is." })); }}
          >
            <Text style={c.btnGhostTxt}>{t("m.chatcards.keepBooking", { defaultValue: "Keep booking" })}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/* ------------------------ confirm_message_host ------------------------ */

/**
 * Editable draft DM to the listing's host — it's the USER's voice going out,
 * so they can tweak before sending. Send hits the same POST /api/chat/messages
 * as the Messages tab (receiver resolved server-side during the preview tool).
 */
export function MessageHostCard({ draft, onDone }: {
  draft: HostMessageDraft;
  onDone: (ok: boolean, note: string) => void;
}) {
  const { t } = useLanguage();
  type CardState = "idle" | "sending" | "done" | "failed" | "skipped";
  const [state, setState] = useState<CardState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(draft.message);

  const send = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setState("sending");
    setError(null);
    try {
      await sendMessage(draft.hostUserId, trimmed);
      setState("done");
      onDone(true, draft.hostName
        ? t("m.chatcards.sentNoteNamed", { defaultValue: "Sent! {{name}} will reply in your Messages tab.", name: draft.hostName })
        : t("m.chatcards.sentNoteHost", { defaultValue: "Sent! The host will reply in your Messages tab." }));
    } catch (e: any) {
      setState("failed");
      const msg = e?.message || t("m.chatcards.sendError", { defaultValue: "Couldn't send the message. Please try again." });
      setError(msg);
      onDone(false, t("m.chatcards.sendFailedNote", { defaultValue: "Sending failed: {{msg}}", msg }));
    }
  };

  const locked = state === "sending" || state === "done" || state === "skipped";

  return (
    <View style={c.card}>
      <View style={{ flexDirection: "row", gap: 9 }}>
        <Icon name="send" size={15} color={T.muted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={c.strong}>{draft.hostName ? t("m.chatcards.messageNamed", { defaultValue: "Message {{name}}?", name: draft.hostName }) : t("m.chatcards.messageHost", { defaultValue: "Message the host?" })}</Text>
          <Text style={[c.sub, { marginTop: 2 }]}>{t("m.chatcards.editDraft", { defaultValue: "Edit the draft below before sending." })}</Text>
        </View>
      </View>

      <TextInput
        value={body}
        onChangeText={setBody}
        editable={!locked}
        multiline
        style={[c.draftInput, locked && { opacity: 0.6 }]}
        placeholder={t("m.chatcards.messagePlaceholder", { defaultValue: "Your message to the host…" })}
        placeholderTextColor={T.muted}
      />

      {state === "failed" && !!error && <Text style={c.error}>{error}</Text>}

      {state === "done" ? (
        <View style={c.doneRow}>
          <Icon name="check" size={15} color="#2e7d52" />
          <Text style={c.doneTxt}>{t("m.chatcards.messageSent", { defaultValue: "Message sent" })}</Text>
        </View>
      ) : state === "skipped" ? (
        <View style={c.doneRow}>
          <Icon name="check" size={15} color={T.muted} />
          <Text style={[c.doneTxt, { color: T.muted }]}>{t("m.chatcards.notSent", { defaultValue: "Not sent" })}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 11 }}>
          <Pressable style={[c.btnFill, (state === "sending" || !body.trim()) && { opacity: 0.6 }]} disabled={state === "sending" || !body.trim()} onPress={send}>
            {state === "sending" && <ActivityIndicator size="small" color="#fff" />}
            <Text style={c.btnFillTxt}>{state === "sending" ? t("m.chatcards.sending", { defaultValue: "Sending…" }) : t("m.chatcards.send", { defaultValue: "Send" })}</Text>
          </Pressable>
          <Pressable
            style={c.btnGhost}
            disabled={state === "sending"}
            onPress={() => { setState("skipped"); onDone(false, t("m.chatcards.dontSendNote", { defaultValue: "Okay, I won't send it." })); }}
          >
            <Text style={c.btnGhostTxt}>{t("m.chatcards.dontSend", { defaultValue: "Don't send" })}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const c = StyleSheet.create({
  card: { alignSelf: "stretch", borderRadius: 18, padding: 13, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.95)" },
  strong: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink },
  sub: { fontSize: 12, fontFamily: font.body, color: T.muted },
  body: { fontSize: 12.5, fontFamily: font.body, color: T.ink },
  amount: { fontSize: 13, fontFamily: font.bodyHeavy, color: T.ink },
  pill: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  pillTxt: { fontSize: 10.5, fontFamily: font.bodyBold, textTransform: "capitalize" },
  error: { marginTop: 8, fontSize: 12, fontFamily: font.body, color: "#c2425c" },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 11 },
  doneTxt: { fontSize: 13, fontFamily: font.bodyBold, color: "#2e7d52" },

  footerBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 8 },
  footerTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.terra },

  stat: { flex: 1, alignItems: "center", gap: 2 },
  statHead: { flexDirection: "row", alignItems: "center", gap: 3 },
  statLabel: { fontSize: 9.5, fontFamily: font.bodyBold, color: T.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  statValue: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.ink },
  nextTrip: { borderRadius: 12, backgroundColor: "rgba(58,50,71,0.06)", paddingVertical: 8, paddingHorizontal: 10 },

  hitCard: { width: 200, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.95)" },
  hitImg: { width: "100%", height: 88, backgroundColor: T.line },
  heart: { position: "absolute", top: 7, right: 7, zIndex: 2, width: 26, height: 26, borderRadius: 99, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.9)" },
  hitTitle: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  hitSub: { fontSize: 11, fontFamily: font.body, color: T.muted, flex: 1 },
  hitPrice: { fontSize: 12, fontFamily: font.bodyHeavy, color: T.ink, flexShrink: 1 },
  hitRating: { fontSize: 11, fontFamily: font.bodyBold, color: "#a06a14" },
  hitBtnOutline: { flex: 1, minHeight: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(58,50,71,0.25)" },
  hitBtnOutlineTxt: { fontSize: 11.5, fontFamily: font.bodyBold, color: T.aubergine },
  hitBtnFill: { flex: 1, minHeight: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },
  hitBtnFillTxt: { fontSize: 11.5, fontFamily: font.bodyBold, color: "#fff" },

  btnFill: { flex: 1, minHeight: 42, borderRadius: 12, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },
  btnFillTxt: { fontSize: 13, fontFamily: font.bodyBold, color: "#fff" },
  btnDanger: { flex: 1, minHeight: 42, borderRadius: 12, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", backgroundColor: "#c2425c" },
  btnDangerTxt: { fontSize: 13, fontFamily: font.bodyBold, color: "#fff" },
  btnGhost: { flex: 1, minHeight: 42, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(58,50,71,0.25)", backgroundColor: "transparent" },
  btnGhostTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.aubergine },

  draftInput: { marginTop: 9, minHeight: 72, maxHeight: 140, borderRadius: 12, borderWidth: 1, borderColor: "rgba(58,50,71,0.18)", backgroundColor: "rgba(58,50,71,0.04)", paddingHorizontal: 11, paddingVertical: 9, fontSize: 13, fontFamily: font.body, color: T.ink, textAlignVertical: "top", ...noOutline },
});
