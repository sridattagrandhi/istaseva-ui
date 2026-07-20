// design/screens/ServiceDetailScreen.tsx — ported from detail.jsx ServiceDetail.
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "@/contexts/LanguageContext";
import { Icon } from "../Icon";
import { BLANK_SERVICE } from "../types";
import { useDesign } from "../DesignContext";
import { useListingDetail, useListingReviews } from "../api/hooks";
import { track } from "../api/analyticsEvents";
import { T, font, rupee } from "../theme";
import {
  HeroGallery, DetailSheet, Eyebrow, StatBox, MiniMap, Pill, VerifyChip, ReviewsSection, CtaBar, dt,
  DetailLoading, DetailNotFound,
} from "./detailParts";

const MODE_META: Record<string, [string, string]> = {
  "at-home": ["home", "At home"], "visit-provider": ["store", "Visit provider"], online: ["globe", "Online"],
};

export function ServiceDetailScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { wish, toggleWish } = useDesign();
  const { item: svc, loading, notFound } = useListingDetail(route.params?.id, "service", BLANK_SERVICE);
  const { reviews } = useListingReviews(route.params?.id);
  useEffect(() => { const id = route.params?.id; if (id) void track("listing_viewed", { listingId: String(id), listingType: "service", source: "service_detail" }); }, [route.params?.id]);
  const [mode, setMode] = useState(svc.mode[0]);
  const [variant, setVariant] = useState(0);
  // Add-ons the user has toggled on for the current variant. They're
  // per-variant, so switching variants clears the selection. All picks
  // carry into the booking screen when the user taps the CTA.
  const [addonSel, setAddonSel] = useState<Set<number>>(() => new Set());
  useEffect(() => { setAddonSel(new Set()); }, [variant]);
  const toggleAddon = (i: number) => setAddonSel((set) => { const n = new Set(set); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  if (loading) return <DetailLoading onBack={() => nav.goBack()} />;
  if (notFound) return <DetailNotFound onBack={() => nav.goBack()} label={t("m.serviceDetail.labelService", { defaultValue: "service" })} />;
  const reviewList = reviews.length ? reviews : (svc.topReviews ?? []);
  const base = svc.variants ? svc.variants[variant] : { name: svc.title, price: svc.price, addOns: svc.addOns || [] };
  const addOnList = base.addOns || [];
  // Live running subtotal (variant base + toggled add-ons). The booking
  // screen stays authoritative for fees/tax.
  const basePrice = base.price + [...addonSel].reduce((sum, i) => sum + (addOnList[i]?.price ?? 0), 0);
  const isOnline = mode === "online";

  return (
    <View style={{ flex: 1, backgroundColor: "#f4efe9" }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        <HeroGallery
          count={svc.photos} photoUrls={svc.photoUrls} icon={svc.icon} label={svc.category} title={svc.title}
          onBack={() => nav.goBack()} wishOn={wish.has(svc.id)} onWish={() => toggleWish(svc.id, "service")} insetTop={insets.top}
          shareKind="service" shareId={svc.id}
        />
        <DetailSheet>
          <Eyebrow icon="sparkle">{svc.category.toUpperCase()}</Eyebrow>
          {svc.subcategory ? <Text style={[dt.mutedSm, { marginTop: 3 }]}>{svc.subcategory}</Text> : null}
          <Text style={dt.h1}>{svc.title}</Text>
          <View style={dt.ratingRow}>
            <View style={dt.ratingStrong}>
              <Icon name="starFill" size={13} color={T.saffron} />
              <Text style={dt.ratingTxt}>{svc.rating}</Text>
            </View>
            <Text style={dt.mutedSm}>· {t("m.serviceDetail.reviewsCount", { defaultValue: "{{count}} reviews", count: svc.reviews })}</Text>
          </View>
          <View style={dt.loc}>
            <Icon name="mappin" size={15} color={T.muted} />
            <Text style={dt.locTxt}>{svc.address}</Text>
          </View>
          {svc.verified ? <View style={{ marginTop: 12, flexDirection: "row" }}><VerifyChip>{t("m.serviceDetail.verifiedProvider", { defaultValue: "Verified provider" })}</VerifyChip></View> : null}

          <View style={dt.divider} />
          <View style={dt.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={dt.h2}>{t("m.serviceDetail.by", { defaultValue: "By {{provider}}", provider: svc.provider })}</Text>
              <Text style={[dt.body, { marginTop: 8 }]}>{t("m.serviceDetail.sessionMeta", { defaultValue: "Session length · {{duration}} · Next slot {{slot}}", duration: svc.duration, slot: svc.nextSlot })}</Text>
            </View>
            <StatBox icon="clock" label={t("m.serviceDetail.statDuration", { defaultValue: "DURATION" })} value={svc.duration} small />
          </View>

          <Text style={dt.sectionTitle}>{t("m.serviceDetail.aboutService", { defaultValue: "About this service" })}</Text>
          <Text style={dt.body}>{svc.blurb}</Text>

          <Text style={dt.sectionTitle}>{t("m.serviceDetail.servicesCatalog", { defaultValue: "Services catalog" })}</Text>
          {svc.variants ? (
            <View style={[dt.chipRow, { marginBottom: 12 }]}>
              {svc.variants.map((v, i) => (
                <Pill key={i} active={variant === i} onPress={() => setVariant(i)}>{v.name} · {rupee(v.price)}</Pill>
              ))}
            </View>
          ) : null}
          {/* The base service is always included for the selected variant —
              the variant pills above choose which one. */}
          <View style={[s.catalogRow, s.catalogPrimary]}>
            <View style={s.crCheck}><Icon name="checkSm" size={13} color="#fff" strokeWidth={2.8} /></View>
            <Text style={s.catalogTxt}>{base.name}</Text>
            <Text style={s.catalogPrice}>{rupee(base.price)}</Text>
          </View>
          {addOnList.map((a, i) => {
            const on = addonSel.has(i);
            // Toggle the add-on in/out — the picks carry into booking via the
            // CTA. Pressed-state feedback keeps the tap responsive.
            return (
              <Pressable
                key={i}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => toggleAddon(i)}
                style={({ pressed }) => [s.catalogRow, on && s.catalogRowOn, pressed && { opacity: 0.9, transform: [{ scale: 0.995 }] }]}
              >
                <View style={[s.addonCheck, on && s.addonCheckOn]}>
                  {on ? <Icon name="checkSm" size={12} color="#fff" strokeWidth={2.8} /> : <Text style={s.addonPlus}>＋</Text>}
                </View>
                <Text style={[s.catalogTxt, on && s.catalogTxtOn]}>{a.name}</Text>
                <Text style={[s.catalogPrice, on && s.catalogTxtOn]}>+{rupee(a.price)}</Text>
              </Pressable>
            );
          })}
          {addOnList.length === 0 && <Text style={[dt.mutedSm, { marginTop: 8 }]}>{t("m.serviceDetail.noAddOns", { defaultValue: "No add-ons for this option." })}</Text>}
          {addOnList.length > 0 && <Text style={[dt.mutedSm, { marginTop: 8 }]}>{t("m.serviceDetail.addOnsHint", { defaultValue: "Tap add-ons to include them — your picks carry into booking." })}</Text>}

          <Text style={dt.sectionTitle}>{t("m.serviceDetail.serviceModes", { defaultValue: "Service modes available" })}</Text>
          {/* marginTop matches the chipRow spacing convention on the other
              detail screens (Stay/Transport add 12–16 too). */}
          <View style={[dt.chipRow, { marginTop: 12 }]}>
            {svc.mode.map((m) => {
              const [ic, lb] = MODE_META[m];
              return <Pill key={m} active={mode === m} icon={ic} onPress={() => setMode(m)}>{t(`m.serviceDetail.mode.${m}`, { defaultValue: lb })}</Pill>;
            })}
          </View>

          <View style={s.modeBox}>
            {mode === "at-home" && (<>
              <Text style={s.mbLabel}>{t("m.serviceDetail.atYourHome", { defaultValue: "AT YOUR HOME" })}</Text>
              <Text style={s.mbText}>{t("m.serviceDetail.travelsFrom", { defaultValue: "Travels up to {{km}} km from {{address}}.", km: svc.travelKm, address: svc.address })}</Text>
            </>)}
            {mode === "visit-provider" && (<>
              <Text style={s.mbLabel}>{t("m.serviceDetail.visitProviderLabel", { defaultValue: "VISIT THE PROVIDER" })}</Text>
              {/* WS6: for unbooked viewers the address is withheld unless the
                  host opted in — svc.address then holds the area label. */}
              <Text style={s.mbText}>{svc.geoExact === false ? `${svc.address} · ${t("m.detail.approxLocation", { defaultValue: "This is the approximate area. The exact address is shared once your booking is confirmed." })}` : svc.address}</Text>
            </>)}
            {mode === "online" && (<>
              <Text style={s.mbLabel}>{t("m.serviceDetail.onlineDelivery", { defaultValue: "ONLINE DELIVERY" })}</Text>
              <Text style={s.mbText}>{svc.onlineNote}</Text>
            </>)}
          </View>

          {!isOnline && (
            <>
              <Text style={dt.sectionTitle}>{mode === "at-home" ? t("m.serviceDetail.serviceArea", { defaultValue: "Service area" }) : t("m.serviceDetail.whereToVisit", { defaultValue: "Where to visit" })}</Text>
              <View style={[dt.loc, { marginTop: 0, marginBottom: 12 }]}>
                <Icon name="mappin" size={15} color={T.muted} />
                <Text style={dt.locTxt}>{svc.address}{mode === "at-home" ? ` · ${t("m.serviceDetail.travelsUpTo", { defaultValue: "travels up to {{km}} km", km: svc.travelKm })}` : ""}</Text>
              </View>
              <MiniMap lat={svc.lat} lng={svc.lng} label={svc.title} />
              {/* WS6: privacy-approximated geo for this viewer — mirror the
                  stay screen's note so the map pin isn't read as exact. */}
              {svc.geoExact === false && (
                <Text style={{ fontFamily: font.body, fontSize: 12, lineHeight: 16, color: T.muted, marginTop: 8 }}>
                  {t("m.detail.approxLocation", { defaultValue: "This is the approximate area. The exact address is shared once your booking is confirmed." })}
                </Text>
              )}
            </>
          )}

          <View style={dt.divider} />
          <Text style={[dt.sectionTitle, { marginTop: 0 }]}>{t("m.serviceDetail.reviews", { defaultValue: "Reviews" })}</Text>
          <ReviewsSection rating={svc.rating} reviews={svc.reviews} list={reviewList} emptyText={t("m.serviceDetail.reviewsEmpty", { defaultValue: "Be the first to book and share your experience." })} />
        </DetailSheet>
      </ScrollView>

      <CtaBar
        price={rupee(basePrice)}
        unit={` · ${svc.duration}`}
        rating={svc.rating}
        meta={t("m.serviceDetail.reviewsCount", { defaultValue: "{{count}} reviews", count: svc.reviews })}
        label={t("m.serviceDetail.bookSlot", { defaultValue: "Book slot" })}
        onPress={() => nav.navigate("Booking", { kind: "service", id: svc.id, mode, variantIndex: variant, addonIndexes: [...addonSel] })}
        insetBottom={insets.bottom}
      />
    </View>
  );
}

const s = StyleSheet.create({
  catalogRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14, paddingHorizontal: 16, marginTop: 9, borderWidth: 1, borderColor: T.line, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.5)" },
  catalogRowOn: { borderColor: T.aubergine, backgroundColor: "rgba(58,50,71,0.06)" },
  catalogPrimary: { borderColor: "rgba(58,50,71,0.3)" },
  crCheck: { width: 22, height: 22, borderRadius: 999, backgroundColor: T.aubergine, alignItems: "center", justifyContent: "center" },
  addonCheck: { width: 20, height: 20, borderRadius: 999, borderWidth: 1.5, borderColor: "rgba(58,50,71,0.35)", alignItems: "center", justifyContent: "center" },
  addonCheckOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  addonPlus: { fontSize: 13, lineHeight: 15, color: "rgba(58,50,71,0.6)", fontFamily: font.bodyBold },
  catalogTxt: { flex: 1, fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink },
  catalogTxtOn: { color: T.aubergine },
  catalogPrice: { fontSize: 15, fontFamily: font.bodyBold, color: T.ink },
  modeBox: { borderWidth: 1, borderColor: T.line, borderRadius: 16, padding: 16, backgroundColor: "rgba(255,255,255,0.45)", marginTop: 16 },
  mbLabel: { fontSize: 10.5, fontFamily: font.bodyHeavy, letterSpacing: 0.6, color: T.muted },
  mbText: { fontSize: 14, lineHeight: 21, marginTop: 6, color: T.ink, fontFamily: font.body },
});
