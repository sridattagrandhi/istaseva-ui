// The mobile admin OPERATIONS tabs — parity with the web ops console
// (Bookings, Fraud, Listings, Coupons, Audit). Each hits the same /api/admin/*
// endpoints and reuses the shared ops UI kit in adminOpsUi.tsx.
import React, { useState } from "react";
import { View, Text, ScrollView, Pressable, Alert, Modal, TextInput, StyleSheet } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { toast } from "@/lib/toast";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font, noOutline } from "../../theme";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { DateRangeSheet } from "../DateRangeSheet";
import { BookForGuest } from "../dash/BookForGuest";
import { ListingOnboarding } from "../dash/ListingOnboarding";
import { createListingForUser } from "../../api/dash";
import { uploadListingPhotos } from "../../api/storage";
import {
  adminOps, type AdminBookingFilters, type AdminBookingRow, type AdminListingFilters,
  type AdminListingRow, type FraudSignalFilters, type FraudSignalRow, type AdminCouponRow,
  type AdminActionFilters, type DateFilter, type CreatePlatformCouponInput,
} from "../../api/adminOps";
import {
  OpsLoading, OpsEmpty, OpsInput, OpsButton, SelectChip, DateRangeChip, MultiSelectChip,
  useAdminFacetOptions, Badge, RowCard, KV,
  DetailSheet, ReasonSheet, UserPicker, FieldLabel, PillAction, ListingPickerSheet, rupees, dateLabel, dateTimeLabel,
} from "./adminOpsUi";

const PAGE = 30;

function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={o.filterRow}>
      {children}
    </ScrollView>
  );
}
function Pager({ page, total, onPrev, onNext }: { page: number; total: number; onPrev: () => void; onNext: () => void }) {
  const { t } = useLanguage();
  const pageCount = Math.max(1, Math.ceil(total / PAGE));
  return (
    <View style={o.pager}>
      <Text style={o.pagerTxt}>{t("m.adminOps.pager", { defaultValue: "{{total}} total · page {{page}} of {{count}}", total, page: page + 1, count: pageCount })}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <OpsButton label={t("m.adminOps.prev", { defaultValue: "Prev" })} tone="outline" small disabled={page === 0} onPress={onPrev} />
        <OpsButton label={t("m.adminOps.next", { defaultValue: "Next" })} tone="outline" small disabled={page + 1 >= pageCount} onPress={onNext} />
      </View>
    </View>
  );
}
function bookingTone(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "confirmed" || status === "completed") return "ok";
  if (status === "cancelled" || status === "expired") return "danger";
  return "warn";
}

// ══ BOOKINGS ══
export function BookingsOpsTab() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<AdminBookingFilters>({});
  const [filters, setFilters] = useState<AdminBookingFilters>({});
  const { stateOptions, cityOptions, typeOptions, categoryOptions } = useAdminFacetOptions(draft.states ?? [], draft.types ?? []);
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refundMode, setRefundMode] = useState<"policy" | "full">("policy");
  const [busy, setBusy] = useState(false);
  // New booking (admin on-behalf): pick any listing → BookForGuest.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [onBehalf, setOnBehalf] = useState<{ id: string; name: string; type: "stay" | "service" | "transport" } | null>(null);

  const list = useQuery({
    queryKey: ["m-ops-bookings", filters, page],
    queryFn: () => adminOps.bookings.search({ ...filters, limit: PAGE, offset: page * PAGE }),
  });
  const detail = useQuery({
    queryKey: ["m-ops-booking", detailId],
    queryFn: () => adminOps.bookings.detail(detailId as string),
    enabled: detailId !== null,
  });
  const apply = () => { setPage(0); setFilters(draft); };
  const hasAnyFilter = Object.values(draft).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ""));
  const clearFilters = () => { setDraft({}); setFilters({}); setPage(0); };
  const d = detail.data;
  const cancellable = d && ["pending", "confirmed", "in_progress"].includes(String(d.booking.status));

  const doCancel = async (reason: string) => {
    if (!detailId) return;
    setBusy(true);
    try {
      await adminOps.bookings.cancel(detailId, { refundMode, reason });
      setCancelOpen(false);
      qc.invalidateQueries({ queryKey: ["m-ops-bookings"] });
      qc.invalidateQueries({ queryKey: ["m-ops-booking"] });
      Alert.alert(t("m.adminOps.bkCancelledTitle", { defaultValue: "Booking cancelled" }), t("m.adminOps.bkCancelledBody", { defaultValue: "The guest and provider have been notified." }));
    } catch (e: any) {
      Alert.alert(t("m.adminOps.bkCancelFail", { defaultValue: "Couldn't cancel" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." }));
    } finally { setBusy(false); }
  };

  const rows = list.data?.bookings ?? [];
  return (
    <View>
      <View style={{ marginBottom: 12 }}>
        <OpsButton label={t("m.adminOps.newBooking", { defaultValue: "+ New booking" })} tone="outline" onPress={() => setPickerOpen(true)} />
      </View>
      <FilterBar>
        <SelectChip label={t("m.adminOps.anyStatus", { defaultValue: "Any status" })} value={draft.status ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, status: v || undefined }))}
          options={[
            { value: "", label: t("m.adminOps.anyStatus", { defaultValue: "Any status" }) },
            ...["pending", "confirmed", "in_progress", "completed", "cancelled", "expired"].map((v) => ({ value: v, label: v.replace("_", " ") })),
          ]} />
        <DateRangeChip value={{ from: draft.from, to: draft.to }} onChange={(v: DateFilter) => setDraft((s) => ({ ...s, from: v.from, to: v.to }))} />
        <MultiSelectChip label={t("m.adminOps.state", { defaultValue: "State" })} values={draft.states ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, states: v.length ? v : undefined }))} options={stateOptions} />
        <MultiSelectChip label={t("m.adminOps.city", { defaultValue: "City" })} searchable values={draft.cities ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, cities: v.length ? v : undefined }))} options={cityOptions} />
        <MultiSelectChip label={t("m.adminOps.type", { defaultValue: "Type" })} values={draft.types ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, types: v.length ? v : undefined }))} options={typeOptions} />
        <MultiSelectChip label={t("m.adminOps.category", { defaultValue: "Category" })} searchable values={draft.categories ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, categories: v.length ? v : undefined }))} options={categoryOptions} />
        <SelectChip label={t("m.adminOps.allBookings", { defaultValue: "All bookings" })} value={draft.bookedOnBehalf ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, bookedOnBehalf: (v || undefined) as "true" | undefined }))}
          options={[{ value: "", label: t("m.adminOps.allBookings", { defaultValue: "All bookings" }) }, { value: "true", label: t("m.adminOps.onBehalfOnly", { defaultValue: "On-behalf only" }) }]} />
      </FilterBar>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <OpsInput value={draft.user ?? ""} onChangeText={(v) => setDraft((s) => ({ ...s, user: v || undefined }))}
            placeholder={t("m.adminOps.guestSearch", { defaultValue: "Guest uid / email / phone" })} onSubmit={apply} />
        </View>
        <OpsButton label={t("m.adminOps.search", { defaultValue: "Search" })} onPress={apply} />
        {hasAnyFilter && <OpsButton label={t("m.adminOps.clear", { defaultValue: "Clear" })} tone="outline" onPress={clearFilters} />}
      </View>

      {list.isLoading ? <OpsLoading /> : list.error ? <OpsEmpty>{t("m.adminOps.loadBookingsFail", { defaultValue: "Couldn’t load bookings." })}</OpsEmpty> : rows.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.noBookings", { defaultValue: "No bookings match these filters." })}</OpsEmpty>
      ) : (
        <>
          {rows.map((b: AdminBookingRow) => (
            <RowCard key={b.id} onPress={() => setDetailId(b.id)}>
              <View style={o.rowTop}>
                <Text style={o.rowTitle} numberOfLines={1}>{b.listing_name ?? b.service_category ?? "—"}</Text>
                <Badge text={b.status.replace("_", " ")} tone={bookingTone(b.status)} />
              </View>
              <Text style={o.rowSub} numberOfLines={1}>{b.guest_name ?? b.guest_contact?.name ?? b.guest_email ?? b.user_id}</Text>
              <View style={o.rowMetaLine}>
                <Text style={o.rowMeta}>{String(b.scheduled_date).slice(0, 10)}</Text>
                <Text style={o.rowMeta}>{rupees(b.payment_amount_paise ?? b.agreed_price_paise)}</Text>
                {b.booked_on_behalf && <Text style={[o.rowMeta, { color: T.aubergine }]}>{t("m.adminOps.onBehalf", { defaultValue: "on-behalf" })}</Text>}
              </View>
            </RowCard>
          ))}
          <Pager page={page} total={list.data?.total ?? 0} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
        </>
      )}

      <DetailSheet visible={detailId !== null} title={t("m.adminOps.bookingDetail", { defaultValue: "Booking detail" })} subtitle={detailId ?? undefined} onClose={() => setDetailId(null)}>
        {detail.isLoading ? <OpsLoading /> : !d ? <OpsEmpty>{t("m.adminOps.loadBookingFail", { defaultValue: "Couldn’t load booking." })}</OpsEmpty> : (
          <View style={{ paddingBottom: 8 }}>
            <KV label={t("m.adminOps.listing", { defaultValue: "Listing" })} value={String(d.booking.listing_name ?? d.booking.service_category ?? "—")} />
            <View style={{ flexDirection: "row", marginBottom: 8 }}><Badge text={String(d.booking.status).replace("_", " ")} tone={bookingTone(String(d.booking.status))} /></View>
            {d.booking.cancellation_reason ? <KV label={t("m.adminOps.cancelReason", { defaultValue: "Cancel reason" })} value={String(d.booking.cancellation_reason)} /> : null}
            <KV label={t("m.adminOps.guest", { defaultValue: "Guest" })} value={String(d.booking.guest_name ?? d.booking.guest_contact?.name ?? "—")} />
            <KV label={t("m.adminOps.contact", { defaultValue: "Contact" })} value={String(d.booking.guest_email ?? d.booking.guest_phone ?? d.booking.guest_contact?.phone ?? d.booking.user_id)} />
            <KV label={t("m.adminOps.schedule", { defaultValue: "Schedule" })} value={`${String(d.booking.scheduled_date).slice(0, 10)}${d.booking.end_date ? ` → ${String(d.booking.end_date).slice(0, 10)}` : ""} · ${d.booking.start_time}–${d.booking.end_time}`} />

            <Text style={o.detailSec}>{t("m.adminOps.payments", { defaultValue: "Payments" })}</Text>
            {d.payments.length === 0 ? <OpsEmpty>{t("m.adminOps.noPayments", { defaultValue: "No payment attempts." })}</OpsEmpty> : d.payments.map((p) => (
              <View key={p.id} style={o.payRow}>
                <View style={o.rowTop}>
                  <Badge text={p.status.replace("_", " ")} tone={p.status === "completed" ? "ok" : p.status.includes("refund") ? "warn" : "muted"} />
                  <Text style={o.rowTitle}>{rupees(p.amount_paise)}</Text>
                </View>
                <Text style={o.rowMeta}>
                  {t("m.adminOps.subtotal", { defaultValue: "subtotal" })} {rupees(p.subtotal_paise)} · {t("m.adminOps.fee", { defaultValue: "fee" })} {rupees(p.platform_fee_paise)} · {t("m.adminOps.tax", { defaultValue: "tax" })} {rupees(p.taxes_paise)}
                  {p.refund_paise ? ` · ${t("m.adminOps.refunded", { defaultValue: "refunded" })} ${rupees(p.refund_paise)}` : ""}
                </Text>
              </View>
            ))}

            {d.cancelPreview && cancellable && (
              <View style={o.previewBox}>
                <Text style={o.previewTitle}>{t("m.adminOps.ifCancelled", { defaultValue: "If cancelled now (policy: {{policy}})", policy: d.cancelPreview.policy })}</Text>
                <Text style={o.rowMeta}>{t("m.adminOps.refundSplit", { defaultValue: "Guest refund {{refund}} · platform keeps {{keep}}", refund: rupees(d.cancelPreview.refundPaise), keep: rupees(d.cancelPreview.platformKeepsPaise) })}</Text>
              </View>
            )}
            {cancellable && (
              <View style={{ marginTop: 14 }}>
                <OpsButton label={t("m.adminOps.cancelBookingCta", { defaultValue: "Cancel booking…" })} tone="danger" onPress={() => { setRefundMode("policy"); setCancelOpen(true); }} />
              </View>
            )}
          </View>
        )}

        {/* Nested INSIDE the DetailSheet modal — iOS won't present a second
            sibling Modal while one is up, so a sheet-over-sheet must be a
            descendant of the presented modal's tree. */}
        <ReasonSheet
          visible={cancelOpen}
          title={t("m.adminOps.cancelAsAdmin", { defaultValue: "Cancel booking as admin" })}
          body={t("m.adminOps.cancelAsAdminBody", { defaultValue: "Both the guest and the provider are notified that support cancelled this booking. Recorded in the audit log." })}
          confirmLabel={t("m.adminOps.cancelBooking", { defaultValue: "Cancel booking" })}
          busy={busy}
          onConfirm={doCancel}
          onClose={() => setCancelOpen(false)}
          extra={
            <View style={{ gap: 8, marginBottom: 12 }}>
              {(["policy", "full"] as const).map((m) => (
                <Pressable key={m} style={({ pressed }) => [o.radioRow, refundMode === m && o.radioRowOn, pressed && { backgroundColor: "rgba(58,50,71,0.06)" }]} onPress={() => setRefundMode(m)}>
                  <Icon name={refundMode === m ? "check" : "dot"} size={16} color={refundMode === m ? T.aubergine : T.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={o.radioTitle}>{m === "policy" ? t("m.adminOps.policyRefund", { defaultValue: "Policy refund" }) : t("m.adminOps.fullRefund", { defaultValue: "Full refund" })}</Text>
                    <Text style={o.rowMeta}>
                      {m === "policy"
                        ? t("m.adminOps.policyRefundDesc", { defaultValue: "Standard cancellation math{{extra}}.", extra: d?.cancelPreview ? ` — ${t("m.adminOps.guestGets", { defaultValue: "guest gets" })} ${rupees(d.cancelPreview.refundPaise)}` : "" })
                        : t("m.adminOps.fullRefundDesc", { defaultValue: "Everything the guest paid{{amount}}, incl. fees & protection.", amount: d?.cancelPreview?.chargedPaise ? ` (${rupees(d.cancelPreview.chargedPaise)})` : "" })}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          }
        />
      </DetailSheet>

      <ListingPickerSheet
        visible={pickerOpen}
        title={t("m.adminOps.bookOnBehalf", { defaultValue: "Book on behalf of a guest" })}
        subtitle={t("m.adminOps.bookOnBehalfSub", { defaultValue: "Pick any live listing — the guest pays via a Razorpay link (QR / SMS)." })}
        onPick={(l) => { setPickerOpen(false); setOnBehalf(l); }}
        onClose={() => setPickerOpen(false)}
      />
      <Modal visible={onBehalf !== null} animationType="slide" onRequestClose={() => setOnBehalf(null)}>
        {onBehalf && (
          <BookForGuest
            entryType={onBehalf.type}
            listings={[{ apiId: onBehalf.id, name: onBehalf.name }]}
            initialListingId={onBehalf.id}
            asAdmin
            onClose={() => setOnBehalf(null)}
            onCreated={() => qc.invalidateQueries({ queryKey: ["m-ops-bookings"] })}
          />
        )}
      </Modal>
    </View>
  );
}

// ══ FRAUD ══
export function FraudOpsTab() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<FraudSignalFilters>({});
  const [filters, setFilters] = useState<FraudSignalFilters>({});
  const [page, setPage] = useState(0);
  const [dossierId, setDossierId] = useState<string | null>(null);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = useQuery({
    queryKey: ["m-ops-fraud", filters, page],
    queryFn: () => adminOps.fraud.signals({ ...filters, limit: PAGE, offset: page * PAGE }),
  });
  const eventTypes = useQuery({ queryKey: ["m-ops-fraud-types"], queryFn: () => adminOps.fraud.eventTypes(), staleTime: 5 * 60_000 });
  const dossier = useQuery({
    queryKey: ["m-ops-dossier", dossierId],
    queryFn: () => adminOps.fraud.userDossier(dossierId as string),
    enabled: dossierId !== null,
  });
  const apply = () => { setPage(0); setFilters(draft); };
  const dos = dossier.data;
  const suspended = dos?.profile?.is_suspended === true;

  const riskTone = (r: string): "danger" | "warn" | "muted" => r === "critical" || r === "high" ? "danger" : r === "medium" ? "warn" : "muted";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["m-ops-fraud"] });
    qc.invalidateQueries({ queryKey: ["m-ops-dossier"] });
  };
  const doSuspend = async (reason: string) => {
    if (!dossierId) return;
    setBusy(true);
    try { await adminOps.users.suspend(dossierId, reason); setSuspendOpen(false); invalidate(); Alert.alert(t("m.adminOps.userSuspendedTitle", { defaultValue: "User suspended" }), t("m.adminOps.userSuspendedBody", { defaultValue: "Sign-in and bookings are blocked." })); }
    catch (e: any) { Alert.alert(t("m.adminOps.suspendFail", { defaultValue: "Couldn't suspend" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." })); }
    finally { setBusy(false); }
  };
  const doUnsuspend = () => {
    if (!dossierId) return;
    Alert.alert(t("m.adminOps.unsuspendTitle", { defaultValue: "Unsuspend user?" }), t("m.adminOps.unsuspendBody", { defaultValue: "They'll be able to sign in and book again." }), [
      { text: t("m.adminOps.cancel", { defaultValue: "Cancel" }), style: "cancel" },
      { text: t("m.adminOps.unsuspend", { defaultValue: "Unsuspend" }), onPress: async () => { try { await adminOps.users.unsuspend(dossierId); invalidate(); } catch (e: any) { Alert.alert(t("m.adminOps.unsuspendFail", { defaultValue: "Couldn't unsuspend" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." })); } } },
    ]);
  };

  const rows = list.data?.signals ?? [];
  return (
    <View>
      <FilterBar>
        <SelectChip label={t("m.adminOps.anyRisk", { defaultValue: "Any risk" })} value={draft.riskLevel ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, riskLevel: v || undefined }))}
          options={[{ value: "", label: t("m.adminOps.anyRisk", { defaultValue: "Any risk" }) }, ...["critical", "high", "medium", "low"].map((v) => ({ value: v, label: v }))]} />
        <SelectChip label={t("m.adminOps.anyEvent", { defaultValue: "Any event" })} value={draft.eventType ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, eventType: v || undefined }))}
          options={[{ value: "", label: t("m.adminOps.anyEvent", { defaultValue: "Any event" }) }, ...(eventTypes.data?.eventTypes ?? []).map((v) => ({ value: v, label: v }))]} />
        <DateRangeChip value={{ from: draft.from, to: draft.to }} onChange={(v) => setDraft((s) => ({ ...s, from: v.from, to: v.to }))} />
      </FilterBar>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <OpsInput value={draft.userId ?? ""} onChangeText={(v) => setDraft((s) => ({ ...s, userId: v || undefined }))} placeholder={t("m.adminOps.userId", { defaultValue: "User id" })} onSubmit={apply} />
        </View>
        <OpsButton label={t("m.adminOps.apply", { defaultValue: "Apply" })} onPress={apply} />
      </View>

      {list.isLoading ? <OpsLoading /> : list.error ? <OpsEmpty>{t("m.adminOps.loadFraudFail", { defaultValue: "Couldn’t load fraud signals." })}</OpsEmpty> : rows.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.noFraud", { defaultValue: "No fraud signals match these filters." })}</OpsEmpty>
      ) : (
        <>
          {rows.map((sg: FraudSignalRow) => (
            <RowCard key={sg.id} onPress={() => setDossierId(sg.user_id)}>
              <View style={o.rowTop}>
                <Text style={o.rowTitle} numberOfLines={1}>{sg.event_type}</Text>
                <Badge text={sg.risk_level} tone={riskTone(sg.risk_level)} />
              </View>
              <Text style={o.rowSub} numberOfLines={1}>{sg.user_name ?? sg.user_email ?? sg.user_id}</Text>
              <Text style={o.rowMeta}>{dateTimeLabel(sg.created_at)}{sg.user_suspended ? ` · ${t("m.adminOps.suspendedLower", { defaultValue: "suspended" })}` : ""}</Text>
            </RowCard>
          ))}
          <Pager page={page} total={list.data?.total ?? 0} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
        </>
      )}

      <DetailSheet visible={dossierId !== null} title={dos?.profile?.display_name ?? t("m.adminOps.userInvestigation", { defaultValue: "User investigation" })} subtitle={dossierId ?? undefined} onClose={() => setDossierId(null)}>
        {dossier.isLoading ? <OpsLoading /> : !dos ? <OpsEmpty>{t("m.adminOps.loadUserFail", { defaultValue: "Couldn’t load this user." })}</OpsEmpty> : (
          <View style={{ paddingBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              {suspended ? <Badge text={t("m.adminOps.suspended", { defaultValue: "Suspended" })} tone="danger" /> : <Badge text={t("m.adminOps.active", { defaultValue: "Active" })} tone="ok" />}
              <Text style={o.rowMeta}>{dos.profile?.email ?? t("m.adminOps.noEmail", { defaultValue: "no email" })} · {t("m.adminOps.kyc", { defaultValue: "KYC" })} {dos.profile?.verification_status ?? t("m.adminOps.unknown", { defaultValue: "unknown" })}</Text>
            </View>
            {suspended
              ? <OpsButton label={t("m.adminOps.unsuspendUser", { defaultValue: "Unsuspend user" })} tone="outline" onPress={doUnsuspend} />
              : <OpsButton label={t("m.adminOps.suspendUser", { defaultValue: "Suspend user" })} tone="danger" onPress={() => setSuspendOpen(true)} />}

            <Text style={o.detailSec}>{t("m.adminOps.bookingStats", { defaultValue: "Booking stats" })}</Text>
            {Object.keys(dos.bookingStats).length === 0 ? <OpsEmpty>{t("m.adminOps.noBookingsShort", { defaultValue: "No bookings." })}</OpsEmpty> : (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {Object.entries(dos.bookingStats).map(([st, n]) => (
                  <View key={st} style={o.statBox}><Text style={o.statNum}>{n}</Text><Text style={o.rowMeta}>{st.replace("_", " ")}</Text></View>
                ))}
              </View>
            )}

            <Text style={o.detailSec}>{t("m.adminOps.fraudSignalsN", { defaultValue: "Fraud signals ({{n}})", n: dos.signalsTotal })}</Text>
            {dos.signals.length === 0 ? <OpsEmpty>{t("m.adminOps.noneRecorded", { defaultValue: "None recorded." })}</OpsEmpty> : dos.signals.slice(0, 20).map((sg) => (
              <View key={sg.id} style={o.miniRow}>
                <Badge text={sg.risk_level} tone={riskTone(sg.risk_level)} />
                <Text style={[o.rowTitle, { flex: 1 }]} numberOfLines={1}>{sg.event_type}</Text>
                <Text style={o.rowMeta}>{dateLabel(sg.created_at)}</Text>
              </View>
            ))}

            <Text style={o.detailSec}>{t("m.adminOps.safetyAlertsN", { defaultValue: "Safety alerts ({{n}})", n: dos.safetyAlerts.length })}</Text>
            {dos.safetyAlerts.length === 0 ? <OpsEmpty>{t("m.adminOps.none", { defaultValue: "None." })}</OpsEmpty> : dos.safetyAlerts.map((a) => (
              <View key={a.id} style={o.payRow}>
                <View style={o.rowTop}><Text style={o.rowTitle}>{a.alert_type}</Text><Badge text={a.status} tone={a.status === "open" ? "warn" : "muted"} /></View>
                {a.description ? <Text style={o.rowMeta}>{a.description}</Text> : null}
              </View>
            ))}

            {dos.listings.length > 0 && (
              <>
                <Text style={o.detailSec}>{t("m.adminOps.listingsHostedN", { defaultValue: "Listings hosted ({{n}})", n: dos.listings.length })}</Text>
                {dos.listings.map((l) => (
                  <View key={l.id} style={o.miniRow}>
                    <Text style={[o.rowTitle, { flex: 1 }]} numberOfLines={1}>{l.name ?? l.title ?? t("m.adminOps.untitled", { defaultValue: "Untitled" })}</Text>
                    {l.banned_at ? <Badge text={t("m.adminOps.suspendedLower", { defaultValue: "suspended" })} tone="danger" /> : <Text style={o.rowMeta}>{l.listing_type}</Text>}
                  </View>
                ))}
              </>
            )}
          </View>
        )}

        {/* Nested INSIDE the DetailSheet modal — iOS won't present a second
            sibling Modal while one is up (see BookingsOpsTab). */}
        <ReasonSheet visible={suspendOpen} title={t("m.adminOps.suspendUser", { defaultValue: "Suspend user" })}
          body={t("m.adminOps.suspendUserBody", { defaultValue: "Suspension blocks sign-in and all API access immediately, and hides every listing they host. Recorded in the audit log." })}
          confirmLabel={t("m.adminOps.suspendUser", { defaultValue: "Suspend user" })} busy={busy} onConfirm={doSuspend} onClose={() => setSuspendOpen(false)} />
      </DetailSheet>
    </View>
  );
}

// ══ LISTINGS ══
export function ListingsOpsTab() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const { user: admin } = useAuth();
  const [draft, setDraft] = useState<AdminListingFilters>({});
  const [filters, setFilters] = useState<AdminListingFilters>({});
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  // One reason sheet serves both moderation verbs: ban (policy violation)
  // and archive (takedown/"delete" — the only removal path; rows retained).
  const [mod, setMod] = useState<{ id: string; kind: "ban" | "archive" } | null>(null);
  const [busy, setBusy] = useState(false);
  // Assisted onboarding: pick a KYC-verified user → entry type → onboarding.
  const [createStep, setCreateStep] = useState<"user" | "type" | "form" | null>(null);
  const [createUser, setCreateUser] = useState<{ user_id: string; display_name: string } | null>(null);
  const [createType, setCreateType] = useState<"stay" | "service" | "transport">("stay");

  const adminPublish = async (_l: any, formState: any) => {
    if (!admin?.id || !createUser) return;
    try {
      // Listing photos were already uploaded to the target's path during the
      // onboarding's moderation step (photoTargetUserId), so these are https
      // pass-throughs. Room photos are still local uris → upload with the
      // cross-user header. Rooms are created server-side as the owner.
      const photos = Array.isArray(formState.photos) ? await uploadListingPhotos(admin.id, formState.photos, createUser.user_id) : [];
      const rooms: Array<Record<string, any>> = [];
      if (createType === "stay" && Array.isArray(formState.rooms)) {
        for (let i = 0; i < formState.rooms.length; i++) {
          const r = formState.rooms[i];
          const roomPhotos = Array.isArray(r.photos) && r.photos.length ? await uploadListingPhotos(admin.id, r.photos, createUser.user_id) : [];
          rooms.push({
            name: r.name, description: r.description || null,
            base_price_paise: Math.round((Number(r.price) || 0) * 100),
            max_guests: Number(r.maxGuests) || 2, quantity: Number(r.quantity) || 1,
            bedrooms: Number(r.bedrooms) || 1, bathrooms: Number(r.bathrooms) || 1,
            unit_identifiers: Array.isArray(r.unitIdentifiers) ? r.unitIdentifiers : [],
            amenities: Array.isArray(r.amenities) ? r.amenities : [], photos: roomPhotos,
          });
        }
      }
      await createListingForUser(createType, { ...formState, photos }, createUser.user_id, rooms);
      setCreateStep(null); setCreateUser(null);
      qc.invalidateQueries({ queryKey: ["m-ops-listings"] });
      toast.success(t("m.adminOps.listingCreated", { defaultValue: "Draft listing created on {{name}}'s account — they've been notified.", name: createUser.display_name }));
    } catch (e: any) {
      toast.error(e?.message || t("m.adminOps.createListingFail", { defaultValue: "Couldn't create the listing." }));
    }
  };

  const list = useQuery({
    queryKey: ["m-ops-listings", filters, page],
    queryFn: () => adminOps.listings.search({ ...filters, limit: PAGE, offset: page * PAGE }),
  });
  const detail = useQuery({
    queryKey: ["m-ops-listing", detailId],
    queryFn: () => adminOps.listings.detail(detailId as string),
    enabled: detailId !== null,
  });
  const apply = () => { setPage(0); setFilters(draft); };
  const hasAnyFilter = Object.values(draft).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ""));
  const clearFilters = () => { setDraft({}); setFilters({}); setPage(0); };
  const { stateOptions, cityOptions, typeOptions, categoryOptions } = useAdminFacetOptions(draft.states ?? [], draft.types ?? []);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["m-ops-listings"] });

  const doMod = async (reason: string) => {
    if (!mod) return;
    setBusy(true);
    try {
      if (mod.kind === "ban") await adminOps.listings.ban(mod.id, reason);
      else await adminOps.listings.archive(mod.id, reason);
      setMod(null); invalidate();
    }
    catch (e: any) { Alert.alert(mod.kind === "ban" ? t("m.adminOps.suspendFail", { defaultValue: "Couldn't suspend" }) : t("m.adminOps.deleteFail", { defaultValue: "Couldn't delete" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." })); }
    finally { setBusy(false); }
  };
  const doUnban = (id: string) => {
    Alert.alert(t("m.adminOps.unsuspendTitle", { defaultValue: "Unsuspend listing?" }), t("m.adminOps.unsuspendBody", { defaultValue: "It becomes visible and bookable again." }), [
      { text: t("m.adminOps.cancel", { defaultValue: "Cancel" }), style: "cancel" },
      { text: t("m.adminOps.unsuspend", { defaultValue: "Unsuspend" }), onPress: async () => { try { await adminOps.listings.unban(id); invalidate(); } catch (e: any) { Alert.alert(t("m.adminOps.unsuspendFail", { defaultValue: "Couldn't unsuspend" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." })); } } },
    ]);
  };
  const doRestore = (id: string) => {
    Alert.alert(t("m.adminOps.restoreTitle", { defaultValue: "Restore listing?" }), t("m.adminOps.restoreBody", { defaultValue: "The listing comes back (inactive) — the owner can reactivate it." }), [
      { text: t("m.adminOps.cancel", { defaultValue: "Cancel" }), style: "cancel" },
      { text: t("m.adminOps.restore", { defaultValue: "Restore" }), onPress: async () => { try { await adminOps.listings.unarchive(id); invalidate(); } catch (e: any) { Alert.alert(t("m.adminOps.restoreFail", { defaultValue: "Couldn't restore" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." })); } } },
    ]);
  };

  const listingStatus = (l: AdminListingRow): { text: string; tone: "ok" | "danger" | "muted" } =>
    l.archived_at ? { text: t("m.adminOps.removed", { defaultValue: "Removed" }), tone: "muted" }
    : l.banned_at ? { text: t("m.adminOps.suspended", { defaultValue: "Suspended" }), tone: "danger" }
    : !l.is_active ? { text: t("m.adminOps.inactive", { defaultValue: "Inactive" }), tone: "muted" }
    : { text: t("m.adminOps.live", { defaultValue: "Live" }), tone: "ok" };

  const rows = list.data?.listings ?? [];
  const det = detail.data?.listing as Record<string, any> | undefined;
  const host = detail.data?.host;
  const photos: string[] = det ? (Array.isArray(det.photos) && det.photos.length ? det.photos : (det.image_url ? [det.image_url] : [])) : [];

  return (
    <View>
      <View style={{ marginBottom: 12 }}>
        <OpsButton label={t("m.adminOps.newListing", { defaultValue: "+ New listing" })} tone="outline" onPress={() => { setCreateUser(null); setCreateStep("user"); }} />
      </View>
      <FilterBar>
        <SelectChip label={t("m.adminOps.anyStatus", { defaultValue: "Any status" })} value={draft.state ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, state: (v || undefined) as AdminListingFilters["state"] }))}
          options={[{ value: "", label: t("m.adminOps.anyStatus", { defaultValue: "Any status" }) }, { value: "live", label: t("m.adminOps.live", { defaultValue: "Live" }) }, { value: "inactive", label: t("m.adminOps.inactive", { defaultValue: "Inactive" }) }, { value: "banned", label: t("m.adminOps.suspended", { defaultValue: "Suspended" }) }, { value: "archived", label: t("m.adminOps.removed", { defaultValue: "Removed" }) }]} />
        <DateRangeChip value={{ from: draft.from, to: draft.to }} onChange={(v) => setDraft((s) => ({ ...s, from: v.from, to: v.to }))} />
        <MultiSelectChip label={t("m.adminOps.state", { defaultValue: "State" })} values={draft.states ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, states: v.length ? v : undefined }))} options={stateOptions} />
        <MultiSelectChip label={t("m.adminOps.city", { defaultValue: "City" })} searchable values={draft.cities ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, cities: v.length ? v : undefined }))} options={cityOptions} />
        <MultiSelectChip label={t("m.adminOps.type", { defaultValue: "Type" })} values={draft.types ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, types: v.length ? v : undefined }))} options={typeOptions} />
        <MultiSelectChip label={t("m.adminOps.category", { defaultValue: "Category" })} searchable values={draft.categories ?? []}
          onChange={(v) => setDraft((s) => ({ ...s, categories: v.length ? v : undefined }))} options={categoryOptions} />
      </FilterBar>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <OpsInput value={draft.q ?? ""} onChangeText={(v) => setDraft((s) => ({ ...s, q: v || undefined }))} placeholder={t("m.adminOps.listingSearchShort", { defaultValue: "Name, city, or listing id" })} onSubmit={apply} />
        </View>
        <OpsButton label={t("m.adminOps.search", { defaultValue: "Search" })} onPress={apply} />
        {hasAnyFilter && <OpsButton label={t("m.adminOps.clear", { defaultValue: "Clear" })} tone="outline" onPress={clearFilters} />}
      </View>

      {list.isLoading ? <OpsLoading /> : list.error ? <OpsEmpty>{t("m.adminOps.loadListingsFail", { defaultValue: "Couldn’t load listings." })}</OpsEmpty> : rows.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.noListings", { defaultValue: "No listings match these filters." })}</OpsEmpty>
      ) : (
        <>
          {rows.map((l: AdminListingRow) => {
            const st = listingStatus(l);
            return (
              <RowCard key={l.id} onPress={() => setDetailId(l.id)}>
                <View style={o.rowTop}>
                  <Text style={o.rowTitle} numberOfLines={1}>{l.name ?? l.title ?? t("m.adminOps.untitled", { defaultValue: "Untitled" })}</Text>
                  <Badge text={st.text} tone={st.tone} />
                </View>
                <Text style={o.rowSub} numberOfLines={1}>{l.host_name ?? l.host_email ?? l.user_id}</Text>
                <View style={o.rowMetaLine}>
                  <Text style={o.rowMeta}>{l.listing_type}{l.city ? ` · ${l.city}` : ""}</Text>
                  {l.archived_at ? (
                    <PillAction label={t("m.adminOps.restore", { defaultValue: "Restore" })} onPress={() => doRestore(l.id)} />
                  ) : (
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      {l.banned_at
                        ? <PillAction label={t("m.adminOps.unsuspend", { defaultValue: "Unsuspend" })} onPress={() => doUnban(l.id)} />
                        : <PillAction label={t("m.adminOps.suspend", { defaultValue: "Suspend" })} tone="danger" onPress={() => setMod({ id: l.id, kind: "ban" })} />}
                      <PillAction label={t("m.adminOps.delete", { defaultValue: "Delete" })} tone="danger" onPress={() => setMod({ id: l.id, kind: "archive" })} />
                    </View>
                  )}
                </View>
              </RowCard>
            );
          })}
          <Pager page={page} total={list.data?.total ?? 0} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
        </>
      )}

      <DetailSheet visible={detailId !== null} title={String(det?.name ?? det?.title ?? t("m.adminOps.listing", { defaultValue: "Listing" }))} subtitle={det ? `${det.listing_type}${det.category ? ` · ${det.category}` : ""}` : undefined} onClose={() => setDetailId(null)}>
        {detail.isLoading ? <OpsLoading /> : !det ? <OpsEmpty>{t("m.adminOps.loadListingFail", { defaultValue: "Couldn’t load this listing." })}</OpsEmpty> : (
          <View style={{ paddingBottom: 8 }}>
            {det.banned_at ? (
              <View style={[o.previewBox, { backgroundColor: "rgba(164,93,98,0.10)" }]}>
                <Text style={[o.previewTitle, { color: T.coral }]}>{t("m.adminOps.suspendedOn", { defaultValue: "Suspended {{date}}", date: dateLabel(String(det.banned_at)) })}{det.banned_reason ? ` — ${det.banned_reason}` : ""}</Text>
              </View>
            ) : null}
            {det.archived_at ? (
              <View style={[o.previewBox, { backgroundColor: "rgba(23,22,28,0.06)" }]}>
                <Text style={o.previewTitle}>{t("m.adminOps.removedOn", { defaultValue: "Removed {{date}}", date: dateLabel(String(det.archived_at)) })}{det.archived_reason ? ` — ${det.archived_reason}` : ""}</Text>
              </View>
            ) : null}
            {det.description ? <Text style={[o.rowMeta, { marginBottom: 10 }]}>{String(det.description)}</Text> : null}
            <KV label={t("m.adminOps.city", { defaultValue: "City" })} value={det.city} />
            <KV label={t("m.adminOps.location", { defaultValue: "Location" })} value={det.location} />
            <KV label={t("m.adminOps.price", { defaultValue: "Price" })} value={det.price ? `₹${det.price}` : (det.price_per_night ? `₹${det.price_per_night}/night` : null)} />
            <KV label={t("m.adminOps.propertyType", { defaultValue: "Property type" })} value={det.property_type} />
            <KV label={t("m.adminOps.created", { defaultValue: "Created" })} value={dateLabel(String(det.created_at))} />
            {Array.isArray(det.amenities) && det.amenities.length > 0 && (
              <KV label={t("m.adminOps.amenities", { defaultValue: "Amenities" })} value={det.amenities.join(", ")} />
            )}
            {Array.isArray(det.room_types) && det.room_types.length > 0 && (
              <>
                <Text style={o.detailSec}>{t("m.adminOps.roomTypes", { defaultValue: "Room types" })}</Text>
                {det.room_types.map((r: any) => (
                  <View key={String(r.id)} style={o.miniRow}>
                    <Text style={[o.rowTitle, { flex: 1 }]}>{r.name}</Text>
                    <Text style={o.rowMeta}>{t("m.adminOps.roomPrice", { defaultValue: "{{price}}/night · {{qty}} unit(s)", price: rupees(r.base_price_paise), qty: r.quantity })}</Text>
                  </View>
                ))}
              </>
            )}
            <Text style={o.detailSec}>{det.listing_type === "transport" ? t("m.adminOps.driverOwner", { defaultValue: "Driver / owner" }) : det.listing_type === "service" ? t("m.adminOps.provider", { defaultValue: "Provider" }) : t("m.adminOps.host", { defaultValue: "Host" })} {t("m.adminOps.contactLower", { defaultValue: "contact" })}</Text>
            {host ? (
              <View style={o.payRow}>
                <Text style={o.rowTitle}>{host.display_name}</Text>
                {host.email ? <Text style={o.rowMeta}>{host.email}</Text> : null}
                {host.phone ? <Text style={o.rowMeta}>{host.phone}</Text> : null}
                <Text style={o.rowMeta}>{t("m.adminOps.kyc", { defaultValue: "KYC" })} {host.verification_status ?? t("m.adminOps.unknown", { defaultValue: "unknown" })}{host.is_suspended ? ` · ${t("m.adminOps.suspendedLower", { defaultValue: "suspended" })}` : ""}</Text>
              </View>
            ) : <OpsEmpty>{t("m.adminOps.noProfile", { defaultValue: "No profile on record." })}</OpsEmpty>}
            <Text style={[o.rowMeta, { marginTop: 10, marginBottom: 4 }]}>{t("m.adminOps.readOnlyView", { defaultValue: "Read-only view — use Suspend on the list to moderate. {{n}} photo(s).", n: photos.length })}</Text>
          </View>
        )}
      </DetailSheet>

      <ReasonSheet visible={mod !== null}
        title={mod?.kind === "archive" ? t("m.adminOps.deleteListing", { defaultValue: "Delete listing" }) : t("m.adminOps.suspendListing", { defaultValue: "Suspend listing" })}
        body={mod?.kind === "archive"
          ? t("m.adminOps.deleteListingBody", { defaultValue: "The listing is removed from the platform — hidden everywhere with new bookings blocked. The record is retained for booking history and an admin can restore it." })
          : t("m.adminOps.banListingBody", { defaultValue: "The listing is removed from search and browse, and new bookings are blocked. The host cannot undo this." })}
        confirmLabel={mod?.kind === "archive" ? t("m.adminOps.deleteListing", { defaultValue: "Delete listing" }) : t("m.adminOps.suspendListing", { defaultValue: "Suspend listing" })}
        busy={busy} onConfirm={doMod} onClose={() => setMod(null)} />

      {/* Assisted onboarding: user pick → type pick → onboarding form. */}
      <Modal visible={createStep === "user"} transparent animationType="slide" onRequestClose={() => setCreateStep(null)}>
        <Pressable style={o.scrim} onPress={() => setCreateStep(null)} />
        <View style={o.pickSheet}>
          <View style={o.handle} />
          <View style={o.sheetHead}>
            <Text style={o.sheetTitle}>{t("m.adminOps.createForUser", { defaultValue: "Create a listing for a user" })}</Text>
            <IconBtn name="x" onPress={() => setCreateStep(null)} bare />
          </View>
          <Text style={[o.rowMeta, { marginBottom: 10 }]}>{t("m.adminOps.createForUserBody", { defaultValue: "The user must have an account and be KYC-verified. The listing lands as a draft they publish themselves." })}</Text>
          <UserPicker
            filter={(u) => u.verification_status !== "verified" ? t("m.adminOps.kycNotVerified", { defaultValue: "KYC not verified" }) : u.is_suspended ? t("m.adminOps.suspendedLower", { defaultValue: "suspended" }) : null}
            onPick={(u) => { setCreateUser({ user_id: u.user_id, display_name: u.display_name }); setCreateStep("type"); }}
          />
          <View style={{ height: 12 }} />
        </View>
      </Modal>

      <Modal visible={createStep === "type"} transparent animationType="slide" onRequestClose={() => setCreateStep(null)}>
        <Pressable style={o.scrim} onPress={() => setCreateStep(null)} />
        <View style={o.pickSheet}>
          <View style={o.handle} />
          <View style={o.sheetHead}>
            <Text style={o.sheetTitle}>{t("m.adminOps.whatOffering", { defaultValue: "What are they offering?" })}</Text>
            <IconBtn name="x" onPress={() => setCreateStep(null)} bare />
          </View>
          <Text style={[o.rowMeta, { marginBottom: 12 }]}>{t("m.adminOps.creatingFor", { defaultValue: "Creating for {{name}}.", name: createUser?.display_name ?? "" })}</Text>
          {([["stay", t("m.adminOps.stay", { defaultValue: "Stay" }), "bed"], ["service", t("m.adminOps.service", { defaultValue: "Service" }), "sparkle"], ["transport", t("m.adminOps.transport", { defaultValue: "Transport" }), "car"]] as const).map(([type, label, icon]) => (
            <Pressable key={type} style={({ pressed }) => [o.typeRow, pressed && { backgroundColor: "rgba(58,50,71,0.06)", borderColor: T.aubergine }]} onPress={() => { setCreateType(type); setCreateStep("form"); }}>
              <Icon name={icon} size={20} color={T.aubergine} />
              <Text style={o.typeLabel}>{label}</Text>
              <Icon name="chevR" size={16} color={T.muted} />
            </Pressable>
          ))}
          <View style={{ height: 12 }} />
        </View>
      </Modal>

      <Modal visible={createStep === "form"} animationType="slide" onRequestClose={() => setCreateStep(null)}>
        {createStep === "form" && createUser && (
          <ListingOnboarding
            entryType={createType}
            photoTargetUserId={createUser.user_id}
            onClose={() => setCreateStep(null)}
            onPublish={adminPublish}
          />
        )}
      </Modal>
    </View>
  );
}

// ══ COUPONS ══
function couponScopeParts(c: AdminCouponRow, t: (k: string, o?: any) => string): string {
  const parts: string[] = [];
  if (!c.is_platform) parts.push(t("m.adminOps.scopeHostOwn", { defaultValue: "host's own listings" }));
  parts.push(c.category ? t("m.adminOps.scopeCatOnly", { defaultValue: "{{cat}}s only", cat: c.category }) : t("m.adminOps.scopeAllCats", { defaultValue: "all categories" }));
  if (c.listing_id) parts.push(t("m.adminOps.scopeOneListing", { defaultValue: "only “{{name}}”", name: c.listing_name ?? t("m.adminOps.oneListing", { defaultValue: "one listing" }) }));
  if (c.target_user_count > 0) parts.push(t("m.adminOps.scopeNUsers", { defaultValue: "only {{n}} specific user(s)", n: c.target_user_count }));
  return parts.join(" · ");
}
export function CouponsOpsTab() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<{ q?: string; scope?: "platform" | "host"; active?: "true" | "false" }>({});
  const [filters, setFilters] = useState(draft);
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ["m-ops-coupons", filters, page],
    queryFn: () => adminOps.coupons.list({ ...filters, limit: PAGE, offset: page * PAGE }),
  });
  const detail = useQuery({
    queryKey: ["m-ops-coupon", detailId],
    queryFn: () => adminOps.coupons.detail(detailId as string),
    enabled: detailId !== null,
  });
  const apply = () => { setPage(0); setFilters(draft); };
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["m-ops-coupons"] }); qc.invalidateQueries({ queryKey: ["m-ops-coupon"] }); };

  const toggle = (c: AdminCouponRow) => {
    Alert.alert(c.is_active ? t("m.adminOps.deactivateQ", { defaultValue: "Deactivate coupon?" }) : t("m.adminOps.activateQ", { defaultValue: "Activate coupon?" }), c.code, [
      { text: t("m.adminOps.cancel", { defaultValue: "Cancel" }), style: "cancel" },
      { text: c.is_active ? t("m.adminOps.deactivate", { defaultValue: "Deactivate" }) : t("m.adminOps.activate", { defaultValue: "Activate" }), onPress: async () => { try { await adminOps.coupons.setActive(c.id, !c.is_active); invalidate(); } catch (e: any) { Alert.alert(t("m.adminOps.updateFail", { defaultValue: "Couldn't update" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." })); } } },
    ]);
  };

  const discountLabel = (c: AdminCouponRow) => c.discount_type === "percent" ? t("m.adminOps.pctOff", { defaultValue: "{{v}}% off", v: Number(c.discount_value) }) : t("m.adminOps.rsOff", { defaultValue: "₹{{v}} off", v: Number(c.discount_value) });
  const rows = list.data?.coupons ?? [];
  const dc = detail.data;

  return (
    <View>
      <FilterBar>
        <SelectChip label={t("m.adminOps.allScopes", { defaultValue: "All scopes" })} value={draft.scope ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, scope: (v || undefined) as "platform" | "host" | undefined }))}
          options={[{ value: "", label: t("m.adminOps.allScopes", { defaultValue: "All scopes" }) }, { value: "platform", label: t("m.adminOps.platform", { defaultValue: "Platform" }) }, { value: "host", label: t("m.adminOps.host", { defaultValue: "Host" }) }]} />
        <SelectChip label={t("m.adminOps.anyState", { defaultValue: "Any state" })} value={draft.active ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, active: (v || undefined) as "true" | "false" | undefined }))}
          options={[{ value: "", label: t("m.adminOps.anyState", { defaultValue: "Any state" }) }, { value: "true", label: t("m.adminOps.activeState", { defaultValue: "Active" }) }, { value: "false", label: t("m.adminOps.inactive", { defaultValue: "Inactive" }) }]} />
      </FilterBar>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <OpsInput value={draft.q ?? ""} onChangeText={(v) => setDraft((s) => ({ ...s, q: v || undefined }))} placeholder={t("m.adminOps.code", { defaultValue: "Code" })} onSubmit={apply} />
        </View>
        <OpsButton label={t("m.adminOps.search", { defaultValue: "Search" })} onPress={apply} />
      </View>
      <View style={{ marginBottom: 12 }}>
        <OpsButton label={t("m.adminOps.newCoupon", { defaultValue: "+ New platform coupon" })} tone="outline" onPress={() => setCreateOpen(true)} />
      </View>

      {list.isLoading ? <OpsLoading /> : list.error ? <OpsEmpty>{t("m.adminOps.loadCouponsFail", { defaultValue: "Couldn’t load coupons." })}</OpsEmpty> : rows.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.noCoupons", { defaultValue: "No coupons match these filters." })}</OpsEmpty>
      ) : (
        <>
          {rows.map((c: AdminCouponRow) => (
            <RowCard key={c.id} onPress={() => setDetailId(c.id)}>
              <View style={o.rowTop}>
                <Text style={[o.rowTitle, { fontFamily: font.head }]}>{c.code}</Text>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {c.is_platform && <Badge text={t("m.adminOps.platformLower", { defaultValue: "platform" })} tone="primary" />}
                  {!c.is_active && <Badge text={t("m.adminOps.inactiveLower", { defaultValue: "inactive" })} tone="muted" />}
                </View>
              </View>
              <Text style={o.rowSub}>{discountLabel(c)} · {couponScopeParts(c, t)}</Text>
              <View style={o.rowMetaLine}>
                <Text style={o.rowMeta}>{t("m.adminOps.usesLine", { defaultValue: "{{used}} uses", used: c.uses_count + (c.max_uses ? ` / ${c.max_uses}` : "") })} · {c.redemption_count > 0 ? t("m.adminOps.redeemedAmt", { defaultValue: "{{amt}} redeemed", amt: rupees(c.redeemed_paise) }) : t("m.adminOps.notRedeemed", { defaultValue: "not redeemed" })}</Text>
                <PillAction label={c.is_active ? t("m.adminOps.deactivate", { defaultValue: "Deactivate" }) : t("m.adminOps.activate", { defaultValue: "Activate" })} tone={c.is_active ? "danger" : "neutral"} onPress={() => toggle(c)} />
              </View>
            </RowCard>
          ))}
          <Pager page={page} total={list.data?.total ?? 0} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
        </>
      )}

      <DetailSheet visible={detailId !== null} title={dc?.coupon.code ?? t("m.adminOps.coupon", { defaultValue: "Coupon" })} subtitle={dc ? `${discountLabel(dc.coupon)} · ${dc.coupon.is_platform ? t("m.adminOps.platformCoupon", { defaultValue: "platform coupon" }) : t("m.adminOps.hostCoupon", { defaultValue: "host coupon" })}` : undefined} onClose={() => setDetailId(null)}>
        {detail.isLoading ? <OpsLoading /> : !dc ? <OpsEmpty>{t("m.adminOps.loadCouponFail", { defaultValue: "Couldn’t load coupon." })}</OpsEmpty> : (
          <View style={{ paddingBottom: 8 }}>
            <View style={o.appliesBox}>
              <Text style={o.detailSec}>{t("m.adminOps.appliesTo", { defaultValue: "Applies to" })}</Text>
              <KV label={t("m.adminOps.category", { defaultValue: "Category" })} value={dc.coupon.category ? t("m.adminOps.scopeCatOnly", { defaultValue: "{{cat}}s only", cat: dc.coupon.category }) : t("m.adminOps.everything", { defaultValue: "everything — stays, services & transport" })} />
              <KV label={t("m.adminOps.listing", { defaultValue: "Listing" })} value={dc.coupon.listing_id ? t("m.adminOps.scopeOneListing", { defaultValue: "only “{{name}}”", name: dc.coupon.listing_name ?? dc.coupon.listing_id }) : (dc.coupon.is_platform ? t("m.adminOps.anyListing", { defaultValue: "any listing" }) : t("m.adminOps.anyHostListing", { defaultValue: "any of the host's listings" }))} />
              <KV label={t("m.adminOps.whoCanRedeem", { defaultValue: "Who can redeem" })} value={dc.targetUsers.length > 0 ? t("m.adminOps.onlyNBelow", { defaultValue: "only the {{n}} user(s) below", n: dc.targetUsers.length }) : t("m.adminOps.anyone", { defaultValue: "anyone" })} />
            </View>
            {dc.targetUsers.length > 0 && (
              <>
                <Text style={o.detailSec}>{t("m.adminOps.targetedUsersN", { defaultValue: "Targeted users ({{n}})", n: dc.targetUsers.length })}</Text>
                {dc.targetUsers.map((u) => <Text key={u.user_id} style={o.rowMeta}>{u.display_name ?? "—"} · {u.email ?? u.user_id}</Text>)}
              </>
            )}
            <Text style={o.detailSec}>{t("m.adminOps.redemptionsN", { defaultValue: "Redemptions ({{n}})", n: dc.redemptions.length })}</Text>
            {dc.redemptions.length === 0 ? <OpsEmpty>{t("m.adminOps.notRedeemedYet", { defaultValue: "Not redeemed yet." })}</OpsEmpty> : dc.redemptions.map((r) => (
              <View key={r.id} style={o.miniRow}>
                <Text style={[o.rowTitle, { flex: 1 }]} numberOfLines={1}>{r.user_name ?? r.user_id}</Text>
                <Text style={o.rowMeta}>{t("m.adminOps.savedAmt", { defaultValue: "saved {{amt}}", amt: rupees(r.discount_paise) })} · {dateLabel(r.created_at)}</Text>
              </View>
            ))}
          </View>
        )}
      </DetailSheet>

      <CreateCouponSheet visible={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); invalidate(); }} />
    </View>
  );
}

// ══ AUDIT ══
export function AuditOpsTab() {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<AdminActionFilters>({});
  const [filters, setFilters] = useState<AdminActionFilters>({});
  const [page, setPage] = useState(0);
  // Listing facets for the vertical/category chips. Only listing-target rows
  // can match these — other actions (user/coupon/payout/fee) drop out while
  // one is active, since they carry no listing.
  const { typeOptions, categoryOptions } = useAdminFacetOptions([], draft.types ?? []);

  const list = useQuery({
    queryKey: ["m-ops-audit", filters, page],
    queryFn: () => adminOps.audit.actions({ ...filters, limit: PAGE, offset: page * PAGE }),
  });
  const apply = () => { setPage(0); setFilters(draft); };
  const rows = list.data?.actions ?? [];

  return (
    <View>
      <FilterBar>
        <SelectChip label={t("m.adminOps.allTargets", { defaultValue: "All targets" })} value={draft.targetType ?? ""}
          onChange={(v) => setDraft((s) => ({ ...s, targetType: v || undefined }))}
          options={[{ value: "", label: t("m.adminOps.allTargets", { defaultValue: "All targets" }) }, ...["user", "listing", "booking", "coupon", "payment"].map((v) => ({ value: v, label: v }))]} />
        <MultiSelectChip label={t("m.adminOps.vertical", { defaultValue: "Vertical" })} values={draft.types ?? []}
          onChange={(types) => setDraft((s) => ({ ...s, types: types.length ? types : undefined }))} options={typeOptions} />
        <MultiSelectChip label={t("m.adminOps.category", { defaultValue: "Category" })} searchable values={draft.categories ?? []}
          onChange={(categories) => setDraft((s) => ({ ...s, categories: categories.length ? categories : undefined }))} options={categoryOptions} />
        <DateRangeChip value={{ from: draft.from, to: draft.to }} onChange={(v) => setDraft((s) => ({ ...s, from: v.from, to: v.to }))} />
      </FilterBar>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <OpsInput value={draft.action ?? ""} onChangeText={(v) => setDraft((s) => ({ ...s, action: v || undefined }))} placeholder={t("m.adminOps.actionPlaceholder", { defaultValue: "Action (e.g. admin.listing.ban)" })} onSubmit={apply} />
        </View>
        <OpsButton label={t("m.adminOps.apply", { defaultValue: "Apply" })} onPress={apply} />
      </View>

      {(filters.types?.length || filters.categories?.length) ? (
        <Text style={{ fontSize: 11.5, fontFamily: font.body, color: T.muted, marginTop: -6, marginBottom: 10 }}>
          {t("m.adminOps.listingFilterNote", { defaultValue: "Listing filters active — only actions on matching listings are shown; user, coupon, payout and fee actions are hidden." })}
        </Text>
      ) : null}
      {list.isLoading ? <OpsLoading /> : list.error ? <OpsEmpty>{t("m.adminOps.loadAuditFail", { defaultValue: "Couldn’t load the audit log." })}</OpsEmpty> : rows.length === 0 ? (
        <OpsEmpty>{t("m.adminOps.noAudit", { defaultValue: "No admin actions match these filters." })}</OpsEmpty>
      ) : (
        <>
          {rows.map((a) => (
            <RowCard key={a.id}>
              <View style={o.rowTop}>
                <Text style={o.rowTitle} numberOfLines={1}>{a.action}</Text>
                <Text style={o.rowMeta}>{dateTimeLabel(a.created_at)}</Text>
              </View>
              <Text style={o.rowSub} numberOfLines={1}>
                <Text style={{ color: T.muted }}>{a.target_type} </Text>{a.target_id}
              </Text>
              <Text style={o.rowMeta} numberOfLines={1}>{t("m.adminOps.byActor", { defaultValue: "by {{actor}}", actor: a.actor_user_id })}{a.reason ? ` · ${a.reason}` : ""}</Text>
            </RowCard>
          ))}
          <Pager page={page} total={list.data?.total ?? 0} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
        </>
      )}
    </View>
  );
}

// ── Create platform coupon (bottom sheet) ──
function CreateCouponSheet({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: () => void }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState("");
  const [discountType, setDiscountType] = useState<"percent" | "fixed">("percent");
  const [discountValue, setDiscountValue] = useState("10");
  const [category, setCategory] = useState<"" | "stay" | "service" | "transport">("");
  const [validUntil, setValidUntil] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState("");
  const [audience, setAudience] = useState<"everyone" | "specific">("everyone");
  const [pickedUsers, setPickedUsers] = useState<Array<{ user_id: string; display_name: string; email: string | null }>>([]);
  const [dateOpen, setDateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = () => { setCode(""); setDiscountType("percent"); setDiscountValue("10"); setCategory(""); setValidUntil(null); setMaxUses(""); setAudience("everyone"); setPickedUsers([]); };

  const submit = async () => {
    const input: CreatePlatformCouponInput = {
      code: code.trim().toUpperCase(),
      discountType,
      discountValue: Number(discountValue),
      maxUses: maxUses.trim() && Number(maxUses) > 0 ? Number(maxUses) : null,
      validUntil,
      category: category || null,
      userIds: audience === "specific" ? pickedUsers.map((u) => u.user_id) : [],
    };
    setBusy(true);
    try { await adminOps.coupons.create(input); reset(); onCreated(); }
    catch (e: any) { Alert.alert(t("m.adminOps.createFail", { defaultValue: "Couldn't create" }), e?.message || t("m.adminOps.tryAgain", { defaultValue: "Please try again." })); }
    finally { setBusy(false); }
  };

  const canSubmit = code.trim().length >= 2 && Number(discountValue) > 0 && (audience === "everyone" || pickedUsers.length > 0) && !busy;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onShow={reset}>
      <Pressable style={o.scrim} onPress={onClose} />
      <View style={[o.createSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={o.handle} />
        <View style={o.sheetHead}>
          <Text style={o.sheetTitle}>{t("m.adminOps.newCouponTitle", { defaultValue: "New platform coupon" })}</Text>
          <IconBtn name="x" onPress={onClose} bare />
        </View>
        <ScrollView style={{ maxHeight: 520 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <FieldLabel first>{t("m.adminOps.code", { defaultValue: "Code" })}</FieldLabel>
          <TextInput style={[o.input, noOutline]} value={code} onChangeText={setCode} placeholder="LAUNCH10" placeholderTextColor={T.muted} autoCapitalize="characters" autoCorrect={false} />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.discountType", { defaultValue: "Discount type" })}</FieldLabel>
              <SelectChip label={t("m.adminOps.type", { defaultValue: "Type" })} value={discountType} onChange={(v) => setDiscountType((v || "percent") as "percent" | "fixed")}
                options={[{ value: "percent", label: t("m.adminOps.pctOffShort", { defaultValue: "% off" }) }, { value: "fixed", label: t("m.adminOps.rsOffShort", { defaultValue: "₹ off" }) }]} />
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.value", { defaultValue: "Value" })}</FieldLabel>
              <TextInput style={[o.input, noOutline]} value={discountValue} onChangeText={setDiscountValue} keyboardType="number-pad" placeholder="10" placeholderTextColor={T.muted} />
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.category", { defaultValue: "Category" })}</FieldLabel>
              <SelectChip label={t("m.adminOps.allCategories", { defaultValue: "All categories" })} value={category} onChange={(v) => setCategory((v || "") as any)}
                options={[{ value: "", label: t("m.adminOps.allCategories", { defaultValue: "All categories" }) }, { value: "stay", label: t("m.adminOps.stays", { defaultValue: "Stays" }) }, { value: "service", label: t("m.adminOps.services", { defaultValue: "Services" }) }, { value: "transport", label: t("m.adminOps.transport", { defaultValue: "Transport" }) }]} />
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel>{t("m.adminOps.maxUses", { defaultValue: "Max uses" })}</FieldLabel>
              <TextInput style={[o.input, noOutline]} value={maxUses} onChangeText={setMaxUses} keyboardType="number-pad" placeholder={t("m.adminOps.unlimited", { defaultValue: "Unlimited" })} placeholderTextColor={T.muted} />
            </View>
          </View>

          <FieldLabel>{t("m.adminOps.validUntil", { defaultValue: "Valid until" })}</FieldLabel>
          <Pressable style={({ pressed }) => [o.input, { flexDirection: "row", alignItems: "center", gap: 8 }, pressed && { backgroundColor: "rgba(58,50,71,0.06)", borderColor: T.aubergine }]} onPress={() => setDateOpen(true)}>
            <Icon name="calendar" size={14} color={validUntil ? T.aubergine : T.muted} />
            <Text style={{ fontSize: 14, fontFamily: font.body, color: validUntil ? T.ink : T.muted }}>{validUntil ? dateLabel(validUntil) : t("m.adminOps.noExpiry", { defaultValue: "No expiry" })}</Text>
            {validUntil ? <Pressable style={{ marginLeft: "auto" }} onPress={() => setValidUntil(null)}><Icon name="x" size={14} color={T.muted} /></Pressable> : null}
          </Pressable>

          <FieldLabel>{t("m.adminOps.whoCanRedeem", { defaultValue: "Who can redeem" })}</FieldLabel>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["everyone", "specific"] as const).map((a) => (
              <Pressable key={a} onPress={() => setAudience(a)} style={({ pressed }) => [o.audChip, audience === a && o.audChipOn, pressed && audience !== a && { backgroundColor: "rgba(58,50,71,0.06)", borderColor: T.aubergine }]}>
                <Text style={[o.audTxt, audience === a && o.audTxtOn]}>{a === "everyone" ? t("m.adminOps.everyoneInScope", { defaultValue: "Everyone in scope" }) : t("m.adminOps.specificUsers", { defaultValue: "Specific users" })}</Text>
              </Pressable>
            ))}
          </View>
          {audience === "specific" && (
            <View style={{ marginTop: 10 }}>
              {pickedUsers.length > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  {pickedUsers.map((u) => (
                    <Pressable key={u.user_id} style={({ pressed }) => [o.userChip, pressed && { opacity: 0.7 }]} onPress={() => setPickedUsers((list) => list.filter((x) => x.user_id !== u.user_id))}>
                      <Text style={o.userChipTxt}>{u.display_name || u.email || u.user_id}</Text>
                      <Icon name="x" size={12} color={T.aubergine} />
                    </Pressable>
                  ))}
                </View>
              )}
              <UserPicker onPick={(u) => setPickedUsers((list) => list.some((x) => x.user_id === u.user_id) ? list : [...list, u])} />
            </View>
          )}

          <View style={{ height: 16 }} />
          <OpsButton label={busy ? t("m.adminOps.creating", { defaultValue: "Creating…" }) : t("m.adminOps.createCoupon", { defaultValue: "Create coupon" })} onPress={submit} disabled={!canSubmit} />
          <View style={{ height: 8 }} />
        </ScrollView>
      </View>
      <DateRangeSheet
        visible={dateOpen}
        value={{ start: validUntil, end: validUntil }}
        onApply={(r) => setValidUntil(r.start)}
        onClose={() => setDateOpen(false)}
      />
    </Modal>
  );
}

const o = StyleSheet.create({
  filterRow: { gap: 8, paddingBottom: 12 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowTitle: { fontSize: 14.5, fontFamily: font.head, color: T.ink, flexShrink: 1 },
  rowSub: { fontSize: 12.5, color: T.muted, fontFamily: font.body, marginTop: 3 },
  rowMetaLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 6 },
  rowMeta: { fontSize: 12, color: T.muted, fontFamily: font.body },
  pager: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4, marginBottom: 8 },
  pagerTxt: { fontSize: 12, color: T.muted, fontFamily: font.body },
  detailSec: { fontSize: 12, fontFamily: font.head, color: T.ink, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 16, marginBottom: 8 },
  payRow: { backgroundColor: T.bg, borderRadius: 12, padding: 10, marginBottom: 8 },
  previewBox: { backgroundColor: T.bg, borderRadius: 12, padding: 10, marginTop: 6 },
  previewTitle: { fontSize: 13, fontFamily: font.head, color: T.ink, marginBottom: 2 },
  radioRow: { flexDirection: "row", gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: T.line },
  radioRowOn: { borderColor: T.aubergine, backgroundColor: "rgba(58,50,71,0.04)" },
  radioTitle: { fontSize: 13.5, fontFamily: font.head, color: T.ink },
  statBox: { minWidth: "30%", flexGrow: 1, backgroundColor: T.bg, borderRadius: 12, padding: 10, alignItems: "center" },
  statNum: { fontSize: 18, fontFamily: font.head, color: T.ink },
  miniRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.line },
  appliesBox: { backgroundColor: T.bg, borderRadius: 12, padding: 12 },
  // create sheet
  scrim: { flex: 1, backgroundColor: "rgba(23,22,28,0.4)" },
  createSheet: { backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 10 },
  pickSheet: { backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16 },
  typeRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 15, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: T.line, marginBottom: 8 },
  typeLabel: { flex: 1, fontSize: 15, fontFamily: font.head, color: T.ink },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 999, backgroundColor: T.line, marginBottom: 10 },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  sheetTitle: { fontSize: 17, fontFamily: font.head, color: T.ink },
  input: { height: 40, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", paddingHorizontal: 12, fontSize: 14, fontFamily: font.body, color: T.ink },
  audChip: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 12, borderWidth: 1, borderColor: T.line },
  audChipOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  audTxt: { fontSize: 12.5, fontFamily: font.head, color: T.muted },
  audTxtOn: { color: "#fff" },
  userChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.10)" },
  userChipTxt: { fontSize: 12, fontFamily: font.head, color: T.aubergine },
});
