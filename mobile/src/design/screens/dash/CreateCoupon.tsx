// dash/CreateCoupon.tsx — create-coupon form overlay (modeled on web HostCouponsTab create flow).
import React, { useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, Modal } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font, noOutline } from "../../theme";
import { DashCoupon } from "./dashData";
import { useLanguage } from "@/contexts/LanguageContext";

type CouponCategory = "stay" | "service" | "transport";

type Translate = (key: string, opts: { defaultValue: string; [k: string]: any }) => string;

// "Applies to" is NOT a user choice — it's the category of the dashboard the
// coupon is created in (stays dashboard → stays, etc). Labels translated at render.
const appliesAllLabel = (t: Translate, cat: CouponCategory): string => {
  if (cat === "stay") return t("m.coupon.appliesAllStays", { defaultValue: "All your stays" });
  if (cat === "service") return t("m.coupon.appliesAllServices", { defaultValue: "All your services" });
  return t("m.coupon.appliesAllRides", { defaultValue: "All your rides" });
};

export function CreateCoupon({ onClose, onCreate, entryType, listings = [] }: {
  onClose: () => void;
  onCreate: (c: DashCoupon, raw?: { code: string; discountType: "percent" | "fixed"; discountValue: number; category?: CouponCategory; listingId?: string | null; maxUses?: number | null; validUntil?: string | null }) => void;
  entryType: CouponCategory;
  /** The host's listings in this dashboard's category — fed into the
   *  "Applies to" dropdown so a coupon can be scoped to one listing. */
  listings?: Array<{ apiId?: string; name: string }>;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"percent" | "flat">("percent");
  const [value, setValue] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [validUntil, setValidUntil] = useState(""); // YYYY-MM-DD
  const [appliesId, setAppliesId] = useState<string | null>(null); // null = all
  const [dropOpen, setDropOpen] = useState(false);
  const [done, setDone] = useState(false);

  const allLabel = appliesAllLabel(t, entryType);
  // "All your stays" + one row per real (backend) listing.
  const appliesOptions = [
    { id: null as string | null, label: allLabel },
    ...listings.filter((l) => l.apiId).map((l) => ({ id: l.apiId as string, label: l.name })),
  ];
  const appliesLabel = appliesOptions.find((o) => o.id === appliesId)?.label ?? allLabel;
  // Optional expiry → end-of-day ISO. Invalid / empty input is simply ignored.
  const isoUntil = (() => {
    const v = validUntil.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const dt = new Date(`${v}T23:59:59`);
    return isNaN(dt.getTime()) ? undefined : dt.toISOString();
  })();
  const dateBad = validUntil.trim().length > 0 && !isoUntil;
  const ready = code.trim().length >= 3 && value.trim().length >= 1 && !dateBad;
  const offLabel = kind === "percent"
    ? t("m.coupon.offPercent", { defaultValue: "{{value}}% off", value: value || "0" })
    : t("m.coupon.offFlat", { defaultValue: "₹{{value}} off", value: value || "0" });

  const create = () => {
    const c: DashCoupon = {
      code: code.toUpperCase().replace(/\s+/g, ""),
      off: offLabel,
      desc: appliesLabel,
      used: t("m.coupon.usedCount", { defaultValue: "{{count}} used", count: 0 }),
      status: "active",
      active: true,
    };
    setDone(true);
    const raw = {
      code: c.code,
      discountType: (kind === "percent" ? "percent" : "fixed") as "percent" | "fixed",
      discountValue: Number(value) || 0,
      category: entryType,
      listingId: appliesId,
      maxUses: maxUses.trim() ? Number(maxUses) : null,
      validUntil: isoUntil ?? null,
    };
    setTimeout(() => onCreate(c, raw), 1000);
  };

  return (
    <View style={[s.lob, { paddingTop: insets.top }]}>
      <View style={s.head}>
        <IconBtn name="x" onPress={onClose} />
        <View style={{ flex: 1 }}>
          <Text style={s.headTitle}>{t("m.coupon.createTitle", { defaultValue: "Create a coupon" })}</Text>
          <Text style={s.headSub}>{done ? t("m.coupon.published", { defaultValue: "Published" }) : t("m.coupon.setDiscount", { defaultValue: "Set the discount and conditions" })}</Text>
        </View>
      </View>

      {done ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 30, gap: 16 }}>
          <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.ring}>
            <Icon name="ticket" size={44} color="#fff" />
          </LinearGradient>
          <Text style={s.successTitle}>{t("m.coupon.createdTitle", { defaultValue: "Coupon created!" })}</Text>
          <Text style={s.successSub}>{t("m.coupon.createdSub", { defaultValue: "{{code}} · {{off}} is now live.", code: code.toUpperCase(), off: offLabel })}</Text>
        </View>
      ) : (
        <>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 130 }} showsVerticalScrollIndicator={false}>
            {/* live preview */}
            <View style={s.preview}>
              <View style={s.previewTag}><Icon name="ticket" size={18} color="#8b5e4a" /></View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <Text style={s.previewCode}>{code.toUpperCase() || t("m.coupon.yourCode", { defaultValue: "YOURCODE" })}</Text>
                  <View style={s.previewOff}><Text style={s.previewOffTxt}>{offLabel}</Text></View>
                </View>
                <Text style={s.previewDesc}>{appliesLabel}</Text>
              </View>
            </View>

            <Text style={s.label}>{t("m.coupon.couponCode", { defaultValue: "Coupon code" })}</Text>
            <TextInput style={s.input} value={code} onChangeText={(v) => setCode(v.toUpperCase())} placeholder="TEMPLE10" placeholderTextColor={T.muted} autoCapitalize="characters" />

            <Text style={s.label}>{t("m.coupon.appliesTo", { defaultValue: "Applies to" })}</Text>
            <Pressable style={s.applies} onPress={() => setDropOpen(true)}>
              <Icon name="ticket" size={15} color={T.terra} />
              <Text style={s.appliesTxt} numberOfLines={1}>{appliesLabel}</Text>
              <Icon name="chevD" size={16} color={T.muted} />
            </Pressable>

            <Text style={s.label}>{t("m.coupon.discountType", { defaultValue: "Discount type" })}</Text>
            <View style={s.seg}>
              {([["percent", t("m.coupon.percentage", { defaultValue: "Percentage" })], ["flat", t("m.coupon.flatAmount", { defaultValue: "Flat amount" })]] as const).map(([k, lb]) => (
                <Pressable key={k} onPress={() => setKind(k as "percent" | "flat")} style={({ pressed }: any) => [s.segBtn, kind === k && s.segActive, pressed && { opacity: 0.85 }]}>
                  <Text style={[s.segTxt, kind === k && { color: "#fff" }]}>{lb}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={s.label}>{kind === "percent" ? t("m.coupon.percentageOff", { defaultValue: "Percentage off" }) : t("m.coupon.amountOff", { defaultValue: "Amount off" })}</Text>
            <View style={s.mfPrefix}>
              <Text style={s.mfAffix}>{kind === "percent" ? "%" : "₹"}</Text>
              <TextInput style={s.mfInput} value={value} onChangeText={(v) => setValue(v.replace(/[^\d]/g, ""))} placeholder={kind === "percent" ? "10" : "200"} placeholderTextColor={T.muted} keyboardType="number-pad" />
            </View>

            <Text style={s.label}>{t("m.coupon.maxUses", { defaultValue: "Max uses (optional)" })}</Text>
            <TextInput style={s.input} value={maxUses} onChangeText={(v) => setMaxUses(v.replace(/[^\d]/g, ""))} placeholder={t("m.coupon.unlimited", { defaultValue: "Unlimited" })} placeholderTextColor={T.muted} keyboardType="number-pad" />

            <Text style={s.label}>{t("m.coupon.validUntil", { defaultValue: "Valid until (optional)" })}</Text>
            <TextInput style={[s.input, dateBad && { borderColor: T.coral }]} value={validUntil} onChangeText={setValidUntil} placeholder="YYYY-MM-DD" placeholderTextColor={T.muted} keyboardType="numbers-and-punctuation" autoCapitalize="none" />
            {dateBad && <Text style={s.dateHint}>{t("m.coupon.dateHint", { defaultValue: "Use the format YYYY-MM-DD (e.g. 2026-12-31)." })}</Text>}
          </ScrollView>

          <View style={[s.cta, { bottom: Math.max(insets.bottom, 12) }]}>
            <Pressable style={[s.primary, !ready && { opacity: 0.45 }]} disabled={!ready} onPress={create}>
              <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.primaryInner}>
                <Icon name="plus" size={17} color="#fff" />
                <Text style={s.primaryTxt}>{t("m.coupon.createButton", { defaultValue: "Create coupon" })}</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </>
      )}

      {/* "Applies to" dropdown — all listings in this category + an All option. */}
      <Modal visible={dropOpen} transparent animationType="fade" onRequestClose={() => setDropOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setDropOpen(false)}>
          <Pressable style={s.dropCard}>
            <Text style={s.dropTitle}>{t("m.coupon.appliesTo", { defaultValue: "Applies to" })}</Text>
            <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
              {appliesOptions.map((o) => {
                const sel = o.id === appliesId;
                return (
                  <Pressable key={o.id ?? "all"} style={({ pressed }: any) => [s.dropRow, pressed && { backgroundColor: "rgba(58,50,71,0.05)" }]} onPress={() => { setAppliesId(o.id); setDropOpen(false); }}>
                    <Text style={[s.dropTxt, sel && { fontFamily: font.bodyHeavy, color: T.aubergine }]} numberOfLines={1}>{o.label}</Text>
                    {sel && <Icon name="check" size={16} color={T.terra} />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  lob: { ...StyleSheet.absoluteFillObject, backgroundColor: T.bg, zIndex: 46 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface },
  headTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  headSub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  preview: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: "rgba(189,135,82,0.3)", backgroundColor: "rgba(189,135,82,0.08)", marginBottom: 8 },
  previewTag: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.16)" },
  previewCode: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.ink, letterSpacing: 0.4 },
  previewOff: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: "rgba(47,125,85,0.1)" },
  previewOffTxt: { fontSize: 11, fontFamily: font.bodyHeavy, color: "#2f7d55" },
  previewDesc: { fontSize: 12.5, color: T.muted, marginTop: 3, fontFamily: font.body },
  label: { fontSize: 12.5, fontFamily: font.bodyHeavy, color: T.aubergine, marginTop: 16, marginBottom: 8 },
  input: { minHeight: 46, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink, ...noOutline },
  applies: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 46, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: "rgba(139,94,74,0.3)", backgroundColor: "rgba(139,94,74,0.07)" },
  appliesTxt: { flex: 1, fontSize: 14, fontFamily: font.bodyHeavy, color: T.aubergine },
  backdrop: { flex: 1, backgroundColor: "rgba(34,31,39,0.4)", alignItems: "center", justifyContent: "center", padding: 28 },
  dropCard: { width: "100%", maxWidth: 420, borderRadius: 20, backgroundColor: "#fff", paddingVertical: 8, paddingHorizontal: 6, shadowColor: "#221f27", shadowOffset: { width: 0, height: 18 }, shadowOpacity: 0.24, shadowRadius: 40, elevation: 20 },
  dropTitle: { fontSize: 12.5, fontFamily: font.bodyHeavy, color: T.muted, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  dropRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 13, paddingHorizontal: 12, borderRadius: 12 },
  dropTxt: { flex: 1, fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink },
  dateHint: { fontSize: 11.5, color: T.coral, marginTop: 6, fontFamily: font.body },
  seg: { flexDirection: "row", gap: 6, padding: 5, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  segBtn: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 10 },
  segActive: { backgroundColor: T.aubergine },
  segTxt: { fontFamily: font.bodyHeavy, fontSize: 13, color: T.muted },
  mfPrefix: { flexDirection: "row", alignItems: "center", minHeight: 46, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden" },
  mfAffix: { paddingLeft: 14, paddingRight: 4, fontFamily: font.bodyHeavy, color: T.terra, fontSize: 15 },
  mfInput: { flex: 1, paddingHorizontal: 12, minHeight: 46, fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink, ...noOutline },
  cta: { position: "absolute", left: 12, right: 12, padding: 12, borderRadius: 24, borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.97)", shadowColor: "#221f27", shadowOffset: { width: 0, height: 22 }, shadowOpacity: 0.2, shadowRadius: 40, elevation: 16 },
  primary: { borderRadius: 16, overflow: "hidden" },
  primaryInner: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  primaryTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 16 },
  ring: { width: 104, height: 104, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  successTitle: { fontSize: 23, fontFamily: font.head, color: T.ink },
  successSub: { fontSize: 14, color: T.muted, textAlign: "center", fontFamily: font.body },
});
