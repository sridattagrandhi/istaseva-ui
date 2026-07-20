// dash/ListingDetailsSheet.tsx — owner-facing read-only "everything about
// this listing" sheet, opened from the dashboard listing row's View action
// (parity: web MyListings → ListingDetailsModal). The OWNER is looking at
// their own row, so nothing is masked — private visit address, exact
// location and schedule all show. Mutations stay on the row's existing
// actions (Edit / Rooms / Calendar / Schedule); this sheet is action-free.
import React from "react";
import { View, Text, Modal, Pressable, ScrollView, StyleSheet, Image } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../Icon";
import { T, font } from "../../theme";
import { fetchListingRaw } from "../../api/dash";
import { useLanguage } from "@/contexts/LanguageContext";

const DAY_LABELS: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun",
};
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function KV({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === "") return null;
  return (
    <View style={s.kv}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={s.kvValue}>{String(value)}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={s.secLabel}>{title}</Text>
      {children}
    </View>
  );
}

export function ListingDetailsSheet({ apiId, name, status, onClose }: {
  apiId?: string;
  name: string;
  status: string;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const q = useQuery({
    queryKey: ["owner-listing-detail", apiId],
    enabled: !!apiId,
    queryFn: () => fetchListingRaw(apiId as string),
  });
  const l = (q.data ?? {}) as Record<string, any>;
  const meta = (l.metadata ?? {}) as Record<string, any>;

  // Real (https) photos only — mirrors api/listings' httpPhotos, which isn't exported.
  const photos: string[] = (Array.isArray(l.photos) ? l.photos : []).filter(
    (p: unknown): p is string => typeof p === "string" && /^https?:\/\//.test(p),
  );
  const amenities: string[] = Array.isArray(l.amenities) ? l.amenities : [];
  const rooms: Array<Record<string, any>> = Array.isArray(l.room_types) ? l.room_types : [];
  const workingHours = meta.workingHours && typeof meta.workingHours === "object" ? (meta.workingHours as Record<string, unknown>) : null;
  const hourRows = workingHours
    ? DAY_ORDER.filter((d) => Array.isArray(workingHours[d]) && (workingHours[d] as unknown[]).length === 2)
        .map((d) => ({ day: DAY_LABELS[d] ?? d, hours: (workingHours[d] as [string, string]).join(" – ") }))
    : [];
  const serviceModes: string[] = Array.isArray(meta.serviceModes) ? meta.serviceModes : [];
  const modeLabels: Record<string, string> = {
    "at-home": t("m.dashboard.modeAtHome", { defaultValue: "At customer's home" }),
    "visit-provider": t("m.dashboard.modeAtYourLocation", { defaultValue: "At your location" }),
    "online": t("m.dashboard.modeOnline", { defaultValue: "Online" }),
  };
  const packages: Array<Record<string, any>> = Array.isArray(meta.packageOptions) ? meta.packageOptions : [];
  const active = status === "live";

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.title} numberOfLines={2}>{l.name ?? name}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
              <Text style={s.subtitle}>{String(l.property_type ?? l.category ?? "").replace(/[-_]/g, " ")}</Text>
              <View style={[s.statusPill, { backgroundColor: active ? "rgba(47,125,85,0.12)" : "rgba(23,22,28,0.06)" }]}>
                <Text style={[s.statusTxt, { color: active ? "#2f7d55" : T.muted }]}>
                  {active ? t("m.dashboard.statusLive", { defaultValue: "Active" }) : t("m.dashboard.statusPaused", { defaultValue: "Inactive" })}
                </Text>
              </View>
            </View>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={s.closeBtn}><Icon name="x" size={18} color={T.ink} /></Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 12 }}>
          {q.isLoading ? (
            <Text style={s.empty}>{t("m.dashboard.detailLoading", { defaultValue: "Loading details…" })}</Text>
          ) : q.error ? (
            <Text style={s.empty}>{t("m.dashboard.detailError", { defaultValue: "Couldn't load this listing's details." })}</Text>
          ) : (
            <>
              {photos.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }} contentContainerStyle={{ gap: 8 }}>
                  {photos.slice(0, 10).map((src, i) => (
                    <Image key={i} source={{ uri: src }} style={s.photo} />
                  ))}
                </ScrollView>
              )}

              {l.description ? <Text style={s.desc}>{String(l.description)}</Text> : null}

              <View style={{ marginTop: 14 }}>
                <KV label={t("m.dashboard.detailLocation", { defaultValue: "Location" })} value={l.location} />
                <KV label={t("m.dashboard.detailServiceArea", { defaultValue: "Service area" })} value={l.service_area} />
                <KV label={t("m.dashboard.detailPrice", { defaultValue: "Price" })}
                  value={l.price ? `₹${String(l.price).replace(/^\s*(?:₹|Rs\.?|INR)\s*/i, "")}` : (l.price_per_night ? `₹${l.price_per_night}/night` : null)} />
                <KV label={t("m.dashboard.detailAvailability", { defaultValue: "Availability" })} value={l.availability} />
                <KV label={t("m.dashboard.detailMaxGuests", { defaultValue: "Max guests" })} value={l.max_guests} />
                <KV label={t("m.dashboard.detailVehicle", { defaultValue: "Vehicle" })}
                  value={l.vehicle_name ? `${l.vehicle_name}${l.vehicle_year ? ` (${l.vehicle_year})` : ""}` : null} />
                <KV label={t("m.dashboard.detailDiscount", { defaultValue: "Discount" })}
                  value={Number(l.discount_percent) > 0 ? `${l.discount_percent}%` : null} />
              </View>

              {/* Owner-only private details — never on the public page. */}
              {(meta.visitAddress || meta.meetingDetails || l.address) && (
                <View style={s.privateBox}>
                  <Text style={s.privateLabel}>{t("m.dashboard.detailPrivate", { defaultValue: "Private details (only you see these)" })}</Text>
                  {l.address ? <Text style={s.privateTxt}>{String(l.address)}</Text> : null}
                  {meta.visitAddress ? <Text style={s.privateTxt}>{String(meta.visitAddress)}</Text> : null}
                  {meta.meetingDetails ? <Text style={s.privateTxt}>{t("m.dashboard.modeOnline", { defaultValue: "Online" })}: {String(meta.meetingDetails)}</Text> : null}
                </View>
              )}

              {serviceModes.length > 0 && (
                <Section title={t("m.dashboard.detailServiceModes", { defaultValue: "Service modes" })}>
                  <View style={s.chipRow}>
                    {serviceModes.map((m) => (
                      <View key={m} style={s.chipPrimary}><Text style={s.chipPrimaryTxt}>{modeLabels[m] ?? m}</Text></View>
                    ))}
                    {meta.pricingUnit ? (
                      <View style={s.chipMuted}><Text style={s.chipMutedTxt}>{String(meta.pricingUnit).replace(/^per_/, "per ").replace(/_/g, " ")}</Text></View>
                    ) : null}
                  </View>
                </Section>
              )}

              {(meta.transportMode || Number(meta.pricePerHour) > 0 || Number(meta.pricePerDay) > 0 || packages.length > 0) && (
                <Section title={t("m.dashboard.detailTransport", { defaultValue: "Trip options" })}>
                  <View style={s.chipRow}>
                    {meta.transportMode ? <View style={s.chipPrimary}><Text style={s.chipPrimaryTxt}>{String(meta.transportMode)}</Text></View> : null}
                    {Number(meta.pricePerHour) > 0 ? <View style={s.chipMuted}><Text style={s.chipMutedTxt}>₹{Number(meta.pricePerHour)}/hr</Text></View> : null}
                    {Number(meta.pricePerDay) > 0 ? <View style={s.chipMuted}><Text style={s.chipMutedTxt}>₹{Number(meta.pricePerDay)}/day</Text></View> : null}
                  </View>
                  {packages.map((p, i) => (
                    <View key={i} style={s.miniRow}>
                      <Text style={s.miniName}>{p.name || p.label || t("m.dashboard.detailPackage", { defaultValue: "Package" })}</Text>
                      {p.price != null ? <Text style={s.miniMeta}>₹{p.price}</Text> : null}
                    </View>
                  ))}
                </Section>
              )}

              {hourRows.length > 0 && (
                <Section title={t("m.dashboard.detailWorkingHours", { defaultValue: "Working hours" })}>
                  {hourRows.map((r) => (
                    <View key={r.day} style={{ flexDirection: "row", gap: 10, paddingVertical: 2 }}>
                      <Text style={[s.miniName, { width: 38 }]}>{r.day}</Text>
                      <Text style={s.miniMeta}>{r.hours}</Text>
                    </View>
                  ))}
                </Section>
              )}

              {amenities.length > 0 && (
                <Section title={t("m.dashboard.detailAmenities", { defaultValue: "Amenities" })}>
                  <View style={s.chipRow}>
                    {amenities.map((a) => <View key={a} style={s.chipMuted}><Text style={s.chipMutedTxt}>{a}</Text></View>)}
                  </View>
                </Section>
              )}

              {rooms.length > 0 && (
                <Section title={t("m.dashboard.detailRoomTypes", { defaultValue: "Room types" })}>
                  {rooms.map((r) => (
                    <View key={String(r.id)} style={s.miniRow}>
                      <Text style={s.miniName}>{r.name}</Text>
                      <Text style={s.miniMeta}>
                        ₹{(Number(r.base_price_paise ?? 0) / 100).toLocaleString("en-IN")}/night · ×{r.quantity ?? 1}
                      </Text>
                    </View>
                  ))}
                </Section>
              )}

              <Text style={s.footnote}>{t("m.dashboard.detailFootnote", { defaultValue: "Read-only view — use Edit on the listing to make changes." })}</Text>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(23,22,28,0.4)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#faf8fa", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 8, maxHeight: "88%" },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: "rgba(23,22,28,0.15)", marginBottom: 10 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: { fontSize: 18, fontFamily: font.headHeavy, color: T.ink },
  subtitle: { fontSize: 12, color: T.muted, fontFamily: font.body, textTransform: "capitalize" },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  statusTxt: { fontSize: 10.5, fontFamily: font.bodyBold },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(23,22,28,0.05)" },
  photo: { width: 150, height: 104, borderRadius: 14, backgroundColor: "rgba(23,22,28,0.06)" },
  desc: { fontSize: 13, color: T.muted, fontFamily: font.body, lineHeight: 19, marginTop: 12 },
  kv: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.line },
  kvLabel: { fontSize: 12, color: T.muted, fontFamily: font.body },
  kvValue: { fontSize: 12.5, color: T.ink, fontFamily: font.bodyBold, flexShrink: 1, textAlign: "right" },
  privateBox: { marginTop: 14, padding: 12, borderRadius: 14, backgroundColor: "rgba(23,22,28,0.04)", borderWidth: 1, borderColor: T.line, gap: 4 },
  privateLabel: { fontSize: 10.5, color: T.muted, fontFamily: font.bodyHeavy, textTransform: "uppercase", letterSpacing: 0.4 },
  privateTxt: { fontSize: 12.5, color: T.ink, fontFamily: font.body },
  secLabel: { fontSize: 11, color: T.muted, fontFamily: font.bodyHeavy, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chipPrimary: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.1)", borderWidth: 1, borderColor: "rgba(58,50,71,0.2)" },
  chipPrimaryTxt: { fontSize: 11.5, color: T.aubergine, fontFamily: font.bodyBold, textTransform: "capitalize" },
  chipMuted: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: "rgba(23,22,28,0.05)", borderWidth: 1, borderColor: T.line },
  chipMutedTxt: { fontSize: 11.5, color: T.muted, fontFamily: font.body },
  miniRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "rgba(23,22,28,0.03)", marginTop: 4 },
  miniName: { fontSize: 12.5, color: T.ink, fontFamily: font.bodyBold },
  miniMeta: { fontSize: 11.5, color: T.muted, fontFamily: font.body },
  empty: { color: T.muted, fontSize: 13, textAlign: "center", paddingVertical: 26, fontFamily: font.body },
  footnote: { fontSize: 11, color: T.muted, fontFamily: font.body, marginTop: 16 },
});
