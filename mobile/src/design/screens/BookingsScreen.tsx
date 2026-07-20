// design/screens/BookingsScreen.tsx — upcoming / completed / cancelled.
// Completed real bookings can be reviewed (POST /api/reviews).
import React, { useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Modal, Alert, Share } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation, useFocusEffect, useRoute } from "@react-navigation/native";
import { Background } from "../Background";
import { SectionHead, Ph } from "../primitives";
import { Icon } from "../Icon";
import { useDesign } from "../DesignContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGuestBookings } from "../api/hooks";
import { ReviewModal } from "./ReviewModal";
import { cancelBookingAsGuest, fetchCancelPreview, CANCELLATION_REASONS, CancellationReason } from "../api/bookings";
import { track } from "../api/analyticsEvents";
import { T, font, toneOf, rupee } from "../theme";
import { displayRef } from "../reference";
import { Booking } from "../types";

const TABS = [
  { k: "upcoming", label: "Upcoming", set: ["upcoming", "confirmed"] },
  { k: "completed", label: "Completed", set: ["completed"] },
  { k: "cancelled", label: "Cancelled", set: ["cancelled"] },
];

function statusColor(status: string) {
  if (status === "confirmed" || status === "upcoming") return { bg: "rgba(97,122,146,0.14)", fg: T.blue };
  if (status === "completed") return { bg: "rgba(67,140,99,0.16)", fg: "#3f7d56" };
  return { bg: "rgba(164,93,98,0.16)", fg: T.coral };
}

const canReview = (b: Booking) => b.status === "completed" && !!(b.listingId || b.providerId);

function BookingCard({ b, onReview, onOpen }: { b: Booking; onReview: (b: Booking) => void; onOpen: (b: Booking) => void }) {
  const { t } = useLanguage();
  const c = toneOf(b.tone);
  const sc = statusColor(b.status);
  return (
    <View style={styles.card}>
      <Pressable style={({ pressed }) => [styles.cardTop, pressed && { opacity: 0.6 }]} onPress={() => onOpen(b)} hitSlop={4}>
        <View style={[styles.thumb, { backgroundColor: c.soft }]}>
          <Icon name={b.icon} size={22} color={c.base} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>{b.title}</Text>
          <Text style={styles.sub} numberOfLines={1}>{b.sub}</Text>
          <Text style={styles.when}>{b.when}</Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <View style={[styles.chip, { backgroundColor: sc.bg }]}>
            <Text style={[styles.chipTxt, { color: sc.fg }]}>{b.status}</Text>
          </View>
          <Text style={styles.price}>{rupee(b.price)}</Text>
          <Icon name="chevR" size={15} color={T.muted} />
        </View>
      </Pressable>
      {canReview(b) && (
        <Pressable style={styles.reviewBtn} onPress={() => onReview(b)}>
          <Icon name="star" size={15} color={T.terra} />
          <Text style={styles.reviewBtnTxt}>{t("m.bookings.writeReview", { defaultValue: "Write a review" })}</Text>
        </Pressable>
      )}
    </View>
  );
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIco}><Icon name={icon} size={17} color={T.aubergine} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

function BillLine({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  return (
    <View style={styles.billLine}>
      <Text style={[styles.billLabel, strong && styles.billStrong]}>{label}</Text>
      <Text style={[styles.billValue, strong && styles.billStrong, accent && { color: "#3f7d56" }]}>{value}</Text>
    </View>
  );
}

function BookingDetailModal({ booking, onClose, onCancelled }: { booking: Booking | null; onClose: () => void; onCancelled: () => void }) {
  const { t } = useLanguage();
  const nav = useNavigation<any>();
  const [busy, setBusy] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  if (!booking) return null;
  const b = booking;
  const sc = statusColor(b.status);
  const bd = b.breakdown;
  const cancellable = (b.status === "upcoming" || b.status === "confirmed");

  const messageHost = () => {
    if (!b.providerUserId) { Alert.alert(t("m.bookings.hostUnavailableTitle", { defaultValue: "Host unavailable" }), t("m.bookings.hostUnavailableBody", { defaultValue: "We couldn't find this host to message." })); return; }
    void track("message_provider_clicked", { source: "bookings" });
    onClose();
    nav.navigate("Thread", { id: b.providerUserId, name: b.providerName || b.title });
  };

  const downloadInvoice = async () => {
    const lines = [
      `${t("m.bookings.invoiceHeading", { defaultValue: "INVOICE" })} — ${b.title}`,
      b.providerName ? `${t("m.bookings.invoiceHost", { defaultValue: "Host" })}: ${b.providerName}` : "",
      `${t("m.bookings.invoiceBookingId", { defaultValue: "Booking ID" })}: ${displayRef(b.id)}`,
      b.when ? `${t("m.bookings.invoiceWhen", { defaultValue: "When" })}: ${b.when}` : "",
      "",
      bd ? `${t("m.bookings.subtotal", { defaultValue: "Subtotal" })}: ${rupee(bd.subtotal)}` : "",
      bd && bd.discount > 0 ? `${t("m.bookings.discount", { defaultValue: "Discount" })}: -${rupee(bd.discount)}` : "",
      bd ? `${t("m.bookings.platformFee", { defaultValue: "Platform fee" })}: ${rupee(bd.fee)}` : "",
      bd ? `${t("m.bookings.gst", { defaultValue: "GST" })}: ${rupee(bd.tax)}` : "",
      bd && bd.insurance > 0 ? `${t("m.bookings.tripProtection", { defaultValue: "Trip protection" })}: ${rupee(bd.insurance)}` : "",
      `${t("m.bookings.totalPaid", { defaultValue: "Total paid" })}: ${rupee(b.price)}`,
    ].filter(Boolean);
    try { await Share.share({ message: lines.join("\n"), title: `${t("m.bookings.invoiceTitle", { defaultValue: "Invoice" })} — ${b.title}` }); } catch { /* dismissed */ }
  };

  const cancelReasonLabel = (reason: CancellationReason) =>
    t(`m.bookings.cancelReason.${reason}`, {
      defaultValue: {
        plans_changed: "My plans changed",
        found_alternative: "I found a better option",
        price_too_high: "It was too expensive",
        booked_by_mistake: "I booked by mistake",
        host_asked_offline: "The host asked me to cancel / pay offline",
        property_issue: "Problem with the listing",
        other: "Other",
      }[reason],
    });

  // Final step after the refund-preview confirm + reason pick — the PATCH
  // issues the refund + cancellation emails, and the reason lands in
  // bookings.cancellation_reason + the booking_cancelled analytics event.
  const doCancel = async (reason: CancellationReason) => {
    setReasonOpen(false);
    setBusy(true);
    try {
      await cancelBookingAsGuest(b.id, reason);
      onCancelled();
      onClose();
      Alert.alert(t("m.bookings.cancelledTitle", { defaultValue: "Booking cancelled" }), t("m.bookings.cancelledBody", { defaultValue: "Your refund has been issued and a confirmation email is on its way." }));
    } catch (e: any) {
      Alert.alert(t("m.bookings.cancelFailedTitle", { defaultValue: "Couldn't cancel" }), e?.message || t("m.bookings.tryAgain", { defaultValue: "Please try again." }));
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    // Show the server-computed refund first (mirrors the web cancel-preview),
    // then confirm; confirming opens the reason picker (native Alert can't
    // host a list of options), and picking a reason executes the cancel.
    let msg = t("m.bookings.cancelGeneric", { defaultValue: "This frees the slot and a refund is issued per the cancellation policy." });
    try {
      const p = await fetchCancelPreview(b.id);
      msg = p.refundRupees > 0
        ? t("m.bookings.cancelRefund", {
            defaultValue: "You'll get back {{amount}}{{retained}}.",
            amount: rupee(p.refundRupees),
            retained: p.platformKeepsRupees > 0 ? t("m.bookings.cancelRetained", { defaultValue: " ({{amount}} retained)", amount: rupee(p.platformKeepsRupees) }) : "",
          })
        : t("m.bookings.cancelNoRefund", { defaultValue: "No refund applies for this cancellation." });
      if (p.reason) msg += `\n${p.reason}`;
      if (p.insuranceVoided) msg += "\n" + t("m.bookings.cancelInsuranceVoided", { defaultValue: "Trip protection will be voided." });
    } catch { /* preview is best-effort — fall back to the generic copy */ }
    Alert.alert(t("m.bookings.cancelTitle", { defaultValue: "Cancel booking?" }), msg, [
      { text: t("m.bookings.keepBooking", { defaultValue: "Keep booking" }), style: "cancel" },
      {
        text: t("m.bookings.cancelBooking", { defaultValue: "Cancel booking" }),
        style: "destructive",
        onPress: () => setReasonOpen(true),
      },
    ]);
  };

  return (
    <Modal visible={!!booking} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 540 }}>
          <View style={styles.detailHead}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.sheetTitle} numberOfLines={2}>{b.title}</Text>
              {/* Transport shows the DRIVER's name (the person), not the
                  provider-profile business name. Other kinds keep providerName. */}
              {(() => { const sub = b.kind === "transport" ? (b.driverName || b.providerName) : b.providerName; return sub ? <Text style={styles.sheetSub}>{sub}</Text> : null; })()}
            </View>
            <View style={[styles.chip, { backgroundColor: sc.bg }]}>
              <Text style={[styles.chipTxt, { color: sc.fg }]}>{b.status}</Text>
            </View>
          </View>

          <View style={styles.detailCard}>
            <DetailRow icon="calendar" label={t("m.bookings.when", { defaultValue: "When" })} value={b.when || "—"} />
            <DetailRow icon="mappin" label={b.kind === "service" ? t("m.bookings.location", { defaultValue: "Location" }) : t("m.bookings.where", { defaultValue: "Where" })} value={b.address || b.sub || "—"} />
            {/* WS6: the host gave no street-level address — be upfront and
                point at the affordances (chat / call) on this same screen. */}
            {b.hasExactAddress === false && (
              <DetailRow icon="chat" label={t("m.bookings.directions", { defaultValue: "Directions" })} value={t("m.bookings.noExactAddress", { defaultValue: "Message or call your host for exact directions" })} />
            )}
            {b.kind === "stay" && !!b.roomCount && (
              <DetailRow icon="bed" label={t("m.bookings.rooms", { defaultValue: "Rooms" })} value={t("m.bookings.roomCount", { defaultValue: "{{count}} room(s)", count: b.roomCount })} />
            )}
            {!!b.guestCount && (
              <DetailRow
                icon="users"
                label={b.kind === "transport" ? t("m.bookings.passengers", { defaultValue: "Passengers" }) : t("m.bookings.guests", { defaultValue: "Guests" })}
                value={b.kind === "transport"
                  ? t("m.bookings.passengerCount", { defaultValue: "{{count}} passenger(s)", count: b.guestCount })
                  : t("m.bookings.guestCount", { defaultValue: "{{count}} guest(s)", count: b.guestCount })}
              />
            )}
            {!!b.guestName && <DetailRow icon="user" label={t("m.bookings.bookedFor", { defaultValue: "Booked for" })} value={b.guestName} />}
            {/* Transport vehicle + driver contact snapshots — the booked car
                and a way to reach the driver. Driver name is the sheet subtitle
                above (providerName). */}
            {b.kind === "transport" && !!b.vehicleModel && <DetailRow icon="car" label={t("m.bookings.vehicle", { defaultValue: "Vehicle" })} value={b.vehicleModel} />}
            {b.kind === "transport" && !!b.vehicleColor && <DetailRow icon="car" label={t("m.bookings.vehicleColor", { defaultValue: "Colour" })} value={b.vehicleColor} />}
            {b.kind === "transport" && !!b.vehiclePlate && <DetailRow icon="tag" label={t("m.bookings.vehiclePlate", { defaultValue: "Number plate" })} value={b.vehiclePlate} />}
            {b.kind === "transport" && !!b.driverPhone && <DetailRow icon="phone" label={t("m.bookings.driverPhone", { defaultValue: "Driver phone" })} value={b.driverPhone} />}
            <DetailRow icon="ticket" label={t("m.bookings.bookingId", { defaultValue: "Booking ID" })} value={displayRef(b.id)} />
          </View>

          {bd && (
            <View style={styles.detailCard}>
              <Text style={styles.billTitle}>{t("m.bookings.payment", { defaultValue: "Payment" })}</Text>
              {bd.subtotal > 0 && <BillLine label={t("m.bookings.subtotal", { defaultValue: "Subtotal" })} value={rupee(bd.subtotal)} />}
              {bd.discount > 0 && <BillLine label={t("m.bookings.discount", { defaultValue: "Discount" })} value={`-${rupee(bd.discount)}`} accent />}
              {bd.fee > 0 && <BillLine label={t("m.bookings.platformFee", { defaultValue: "Platform fee" })} value={rupee(bd.fee)} />}
              {bd.tax > 0 && <BillLine label={t("m.bookings.gst", { defaultValue: "GST" })} value={rupee(bd.tax)} />}
              {bd.insurance > 0 && <BillLine label={t("m.bookings.tripProtection", { defaultValue: "Trip protection" })} value={rupee(bd.insurance)} />}
              <View style={styles.billDivider} />
              <BillLine label={t("m.bookings.totalPaid", { defaultValue: "Total paid" })} value={rupee(b.price)} strong />
            </View>
          )}

          <Pressable style={({ pressed }) => [styles.primaryAction, pressed && styles.pressedFill]} onPress={messageHost}>
            <Icon name="message" size={17} color="#fff" />
            <Text style={styles.primaryActionTxt}>{b.kind === "transport"
              ? t("m.bookings.messageDriver", { defaultValue: "Message driver" })
              : b.kind === "service"
                ? t("m.bookings.messageProvider", { defaultValue: "Message provider" })
                : t("m.bookings.messageHost", { defaultValue: "Message host" })}</Text>
          </Pressable>
          <View style={styles.actionRow}>
            <Pressable style={({ pressed }) => [styles.ghostAction, pressed && styles.pressedGhost]} onPress={downloadInvoice}>
              <Icon name="share" size={16} color={T.ink} />
              <Text style={styles.ghostActionTxt}>{t("m.bookings.invoice", { defaultValue: "Invoice" })}</Text>
            </Pressable>
            {cancellable && (
              <Pressable style={({ pressed }) => [styles.ghostAction, styles.dangerAction, pressed && styles.pressedDanger, busy && { opacity: 0.6 }]} disabled={busy} onPress={cancel}>
                <Icon name="x" size={16} color={T.coral} />
                <Text style={[styles.ghostActionTxt, { color: T.coral }]}>{busy ? t("m.bookings.cancelling", { defaultValue: "Cancelling…" }) : t("m.bookings.cancel", { defaultValue: "Cancel" })}</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </View>

      {/* Reason picker — the step between the refund-preview confirm and the
          actual cancel. Tapping a reason executes the cancellation. */}
      <Modal visible={reasonOpen} transparent animationType="fade" onRequestClose={() => setReasonOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setReasonOpen(false)} />
        <View style={styles.reasonSheet}>
          <Text style={styles.reasonTitle}>{t("m.bookings.cancelReasonTitle", { defaultValue: "Why are you cancelling?" })}</Text>
          {CANCELLATION_REASONS.map((reason) => (
            <Pressable
              key={reason}
              disabled={busy}
              style={({ pressed }) => [styles.reasonRow, pressed && { opacity: 0.6 }]}
              onPress={() => void doCancel(reason)}
            >
              <Text style={styles.reasonRowTxt}>{cancelReasonLabel(reason)}</Text>
              <Icon name="chevR" size={14} color={T.muted} />
            </Pressable>
          ))}
          <Pressable style={({ pressed }) => [styles.reasonKeep, pressed && { opacity: 0.6 }]} onPress={() => setReasonOpen(false)}>
            <Text style={styles.reasonKeepTxt}>{t("m.bookings.keepBooking", { defaultValue: "Keep booking" })}</Text>
          </Pressable>
        </View>
      </Modal>
    </Modal>
  );
}

export function BookingsScreen() {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const { bookings: localBookings } = useDesign();
  const guest = useGuestBookings();
  // Tab screens stay mounted, so without a focus refetch this list only
  // updates when the 20s staleTime happens to lapse — refetch every time the
  // user lands on the tab so fresh bookings/cancellations show immediately.
  useFocusEffect(React.useCallback(() => { guest.refetch?.(); }, [])); // eslint-disable-line react-hooks/exhaustive-deps
  const bookings = guest.fromBackend ? guest.bookings : localBookings;
  const [tab, setTab] = useState("upcoming");
  const [reviewing, setReviewing] = useState<Booking | null>(null);
  const [viewing, setViewing] = useState<Booking | null>(null);
  const active = TABS.find((t) => t.k === tab)!;
  const list = bookings.filter((b) => active.set.includes(b.status));

  // Deep-link target: a tapped notification routes here with `openBookingId`.
  // When the matching booking is loaded, switch to its tab and open its detail
  // sheet, then clear the param so closing the sheet doesn't re-open it.
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const openBookingId: string | undefined = route.params?.openBookingId;
  React.useEffect(() => {
    if (!openBookingId) return;
    const b = bookings.find((x) => x.id === openBookingId);
    if (!b) return; // not loaded yet (or not this user's booking) — wait
    const tb = TABS.find((tt) => tt.set.includes(b.status));
    if (tb) setTab(tb.k);
    setViewing(b);
    nav.setParams({ openBookingId: undefined });
  }, [openBookingId, bookings]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Background>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 6, paddingBottom: 122 }}
        showsVerticalScrollIndicator={false}
      >
        <SectionHead title={t("m.bookings.yourTrips", { defaultValue: "Your trips" })} />
        <View style={styles.tabs}>
          {TABS.map((tb) => (
            <Pressable key={tb.k} onPress={() => setTab(tb.k)} style={[styles.tab, tab === tb.k && styles.tabActive]}>
              <Text style={[styles.tabTxt, tab === tb.k && { color: "#fff" }]}>{t(`m.bookings.tab.${tb.k}`, { defaultValue: tb.label })}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ gap: 12, marginTop: 16 }}>
          {list.map((b) => <BookingCard key={b.id} b={b} onReview={setReviewing} onOpen={setViewing} />)}
          {list.length === 0 && <Text style={styles.empty}>{t(`m.bookings.empty.${active.k}`, { defaultValue: `No ${active.label.toLowerCase()} trips.` })}</Text>}
        </View>
      </ScrollView>
      <ReviewModal booking={reviewing} onClose={() => setReviewing(null)} />
      <BookingDetailModal booking={viewing} onClose={() => setViewing(null)} onCancelled={() => guest.refetch?.()} />
    </Background>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 8 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.6)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)" },
  tabActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  tabTxt: { fontFamily: font.bodyHeavy, fontSize: 13, color: T.muted },
  card: { padding: 14, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.92)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)" },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 14 },
  thumb: { width: 54, height: 54, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: font.head, fontSize: 15, color: T.ink },
  sub: { fontFamily: font.body, fontSize: 12.5, color: T.muted, marginTop: 3 },
  when: { fontFamily: font.bodyBold, fontSize: 12.5, color: T.aubergine, marginTop: 4 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipTxt: { fontFamily: font.bodyHeavy, fontSize: 11, textTransform: "capitalize" },
  price: { fontFamily: font.bodyHeavy, fontSize: 15, color: T.ink },
  empty: { color: T.muted, textAlign: "center", padding: 40, fontFamily: font.body },
  reviewBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 12, paddingVertical: 11, borderRadius: 12, borderWidth: 1, borderColor: "rgba(139,94,74,0.35)" },
  reviewBtnTxt: { fontFamily: font.bodyHeavy, fontSize: 13, color: T.terra },
  backdrop: { flex: 1, backgroundColor: "rgba(23,20,29,0.4)" },
  sheet: { backgroundColor: "#f7f3ee", borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 40 },
  reasonSheet: { backgroundColor: "#f7f3ee", borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 40 },
  reasonTitle: { fontFamily: font.head, fontSize: 17, color: T.ink, marginBottom: 10 },
  reasonRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: "rgba(23,20,29,0.06)" },
  reasonRowTxt: { fontFamily: font.body, fontSize: 14.5, color: T.ink, flex: 1, paddingRight: 8 },
  reasonKeep: { marginTop: 14, alignItems: "center", paddingVertical: 12, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.8)", borderWidth: 1, borderColor: "rgba(255,255,255,0.66)" },
  reasonKeepTxt: { fontFamily: font.bodyHeavy, fontSize: 14, color: T.ink },
  sheetHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.18)", marginBottom: 16 },
  sheetTitle: { fontFamily: font.head, fontSize: 18, color: T.ink },
  sheetSub: { fontFamily: font.body, fontSize: 13.5, color: T.muted, marginTop: 4 },
  // Booking detail modal
  detailHead: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 16 },
  detailCard: { backgroundColor: "rgba(255,255,255,0.7)", borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", padding: 14, marginBottom: 12 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9 },
  detailIco: { width: 26, alignItems: "center", justifyContent: "center" },
  detailLabel: { fontFamily: font.bodyBold, fontSize: 11, color: T.muted, textTransform: "uppercase", letterSpacing: 0.3 },
  detailValue: { fontFamily: font.bodyBold, fontSize: 14, color: T.ink, marginTop: 1 },
  billTitle: { fontFamily: font.head, fontSize: 14, color: T.ink, marginBottom: 8 },
  billLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  billLabel: { fontFamily: font.body, fontSize: 13.5, color: T.muted },
  billValue: { fontFamily: font.bodyBold, fontSize: 13.5, color: T.ink },
  billStrong: { fontFamily: font.bodyHeavy, fontSize: 15, color: T.ink },
  billDivider: { height: 1, backgroundColor: "rgba(23,22,28,0.08)", marginVertical: 8 },
  primaryAction: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 4, paddingVertical: 15, borderRadius: 16, backgroundColor: T.aubergine },
  primaryActionTxt: { fontFamily: font.bodyHeavy, fontSize: 15, color: "#fff" },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  ghostAction: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingVertical: 13, borderRadius: 14, borderWidth: 1, borderColor: "rgba(23,22,28,0.14)" },
  ghostActionTxt: { fontFamily: font.bodyHeavy, fontSize: 13.5, color: T.ink },
  dangerAction: { borderColor: "rgba(164,93,98,0.4)" },
  pressedFill: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  pressedGhost: { transform: [{ scale: 0.97 }], backgroundColor: "rgba(23,22,28,0.06)" },
  pressedDanger: { transform: [{ scale: 0.97 }], backgroundColor: "rgba(164,93,98,0.1)" },
});
