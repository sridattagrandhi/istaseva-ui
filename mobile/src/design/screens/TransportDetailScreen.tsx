// design/screens/TransportDetailScreen.tsx — ported from detail.jsx TransportDetail.
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { Segmented } from "../primitives";
import { TransportTour, Transport, BLANK_TRANSPORT } from "../types";
import { useDesign } from "../DesignContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useListingDetail, useListingReviews } from "../api/hooks";
import { track } from "../api/analyticsEvents";
import { T, font, rupee } from "../theme";
import { HeroGallery, DetailSheet, Eyebrow, StatBox, MiniMap, LangChip, VerifyChip, FlexibleChip, ReviewsSection, CtaBar, dt, DetailLoading, DetailNotFound } from "./detailParts";

type Translate = (key: string, opts: { defaultValue: string; [k: string]: any }) => string;

// Mode ids are stable logic values; their human labels are translated at render.
const MODE_IDS = ["package", "hourly", "day"] as const;
const modeLabel = (t: Translate, mode: string): string => {
  if (mode === "package") return t("m.transportDetail.modeTourPackage", { defaultValue: "Tour package" });
  if (mode === "hourly") return t("m.transportDetail.modeHourlyRental", { defaultValue: "Hourly rental" });
  if (mode === "day") return t("m.transportDetail.modeDayRental", { defaultValue: "Day rental" });
  return "";
};
const isMode = (mode: string | undefined): boolean => !!mode && (MODE_IDS as readonly string[]).includes(mode);
const trModes = (t: Translate): [string, string, string][] => [
  ["package", "landmark", t("m.transportDetail.modeShortPackage", { defaultValue: "Package" })],
  ["hourly", "clock", t("m.transportDetail.modeShortHourly", { defaultValue: "Hourly" })],
  ["day", "calendar", t("m.transportDetail.modeShortDay", { defaultValue: "Day rental" })],
];

// Weekly working hours → compact summary chips ("Mon–Fri 9:00 AM – 5:00 PM",
// "Sat–Sun 12:00 PM – 7:00 PM"). Consecutive days sharing a window group into
// one range; closed days are simply omitted. Empty when no hours are set.
const WH_DAYS: [string, string][] = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
function fmt12h(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]), mm = m[2], p = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1;
  return mm === "00" ? `${h12} ${p}` : `${h12}:${mm} ${p}`;
}
function hoursSummary(wh: Record<string, [string, string] | null> | undefined, t: Translate): string[] {
  if (!wh) return [];
  const windows = WH_DAYS.map(([key, label]) => {
    const slot = wh[key];
    const ok = Array.isArray(slot) && slot.length === 2 && slot[0] && slot[1];
    return { label: t(`m.transportDetail.day_${key}`, { defaultValue: label }), win: ok ? `${fmt12h(slot![0])} – ${fmt12h(slot![1])}` : null };
  });
  const out: string[] = [];
  let i = 0;
  while (i < windows.length) {
    if (!windows[i].win) { i += 1; continue; }
    let j = i;
    while (j + 1 < windows.length && windows[j + 1].win === windows[i].win) j += 1;
    out.push(`${windows[i].label}${j > i ? `–${windows[j].label}` : ""} ${windows[i].win}`);
    i = j + 1;
  }
  return out;
}

function TourCard({ tour, item, active, onPress }: { tour: TransportTour; item: Transport; active: boolean; onPress: () => void }) {
  const { t } = useLanguage();
  return (
    <Pressable style={[s.tourCard, active && s.tourActive]} onPress={onPress}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <Text style={s.tourName}>{tour.name}</Text>
        <View style={s.pricePill}><Text style={s.pricePillTxt}>{rupee(tour.price)}</Text></View>
      </View>
      <Text style={s.tourHours}><Text style={s.tourHoursNum}>{tour.hours}</Text> {t("m.transportDetail.hours", { defaultValue: "hours" })}</Text>
      <Text style={[dt.body, { fontSize: 13, marginTop: 4 }]}>{t("m.transportDetail.driverAvailable", { defaultValue: "Driver available {{available}} · picks exact start with you", available: item.available })}</Text>
      <View style={[dt.chipRow, { marginTop: 12 }]}>
        <LangChip>{tour.km}</LangChip>
        <LangChip>{item.languages.map((l) => l.toUpperCase()).join(" · ")}</LangChip>
      </View>
      <Text style={s.tourSub}>{t("m.transportDetail.placesYouVisit", { defaultValue: "PLACES YOU'LL VISIT" })}</Text>
      <View style={{ gap: 10 }}>
        {tour.places.map((pl, i) => (
          <View key={i} style={s.stop}>
            <View style={s.stopNum}><Text style={s.stopNumTxt}>{i + 1}</Text></View>
            <Text style={s.stopTxt}><Text style={{ fontFamily: font.bodyHeavy }}>{pl.name}</Text> · {pl.dur}</Text>
          </View>
        ))}
      </View>
      <Text style={[dt.body, { fontSize: 13, marginTop: 10 }]}>{tour.note}</Text>
    </Pressable>
  );
}

export function TransportDetailScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { wish, toggleWish } = useDesign();
  const { t } = useLanguage();
  const mock = BLANK_TRANSPORT;
  const { item, loading, notFound } = useListingDetail(route.params?.id, "transport", mock);
  const { reviews } = useListingReviews(route.params?.id);
  const initialMode = isMode(route.params?.mode) ? route.params.mode : "package";
  const [m, setM] = useState(initialMode);
  const [selTour, setSelTour] = useState(0);
  // Only the modes this driver actually offers (item.modes); the segmented and
  // default mode are constrained to it so a day-rental-only driver never shows
  // Package/Hourly. item loads async, so snap `m` to a valid mode once it arrives.
  const modes = item.modes && item.modes.length ? item.modes : ["package", "hourly", "day"];
  useEffect(() => {
    if (!modes.includes(m)) setM(modes[0]);
  }, [modes.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const modeOptions = trModes(t).filter(([k]) => modes.includes(k));
  useEffect(() => { const id = route.params?.id; if (id) void track("listing_viewed", { listingId: String(id), listingType: "transport", source: "transport_detail" }); }, [route.params?.id]);
  if (loading) return <DetailLoading onBack={() => nav.goBack()} />;
  if (notFound) return <DetailNotFound onBack={() => nav.goBack()} label={t("m.transportDetail.vehicle", { defaultValue: "vehicle" })} />;
  const reviewList = reviews.length ? reviews : (item.topReviews ?? []);
  const tours = item.tours || [];
  const price = m === "hourly" ? item.hourly : m === "day" ? item.day : (tours[selTour] || {}).price || item.day;
  const unit = m === "hourly" ? t("m.transportDetail.unitHour", { defaultValue: " /hour" }) : m === "day" ? t("m.transportDetail.unitDay", { defaultValue: " /day" }) : t("m.transportDetail.unitPackage", { defaultValue: " · package" });

  return (
    <View style={{ flex: 1, backgroundColor: "#f4efe9" }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        <HeroGallery
          count={item.photos || 5} photoUrls={item.photoUrls} icon="car" label={item.type} title={item.driver}
          onBack={() => nav.goBack()} wishOn={wish.has(item.id)} onWish={() => toggleWish(item.id, "transport")} insetTop={insets.top}
          shareKind="transport" shareId={item.id}
        />
        <DetailSheet>
          <Eyebrow icon="car">{item.type.toUpperCase()}</Eyebrow>
          <Text style={dt.h1}>{item.driver}</Text>
          <View style={dt.ratingRow}>
            <View style={dt.ratingStrong}>
              <Icon name="starFill" size={13} color={T.saffron} />
              <Text style={dt.ratingTxt}>{item.rating}</Text>
            </View>
            <Text style={dt.mutedSm}>· {t("m.transportDetail.tripsCount", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString("en-IN") })} · {item.area.split(",")[0]}</Text>
          </View>
          <View style={[dt.chipRow, { marginTop: 12 }]}>
            <VerifyChip>{t("m.transportDetail.verifiedDriver", { defaultValue: "Verified driver" })}</VerifyChip>
            {item.flexibleHours && <FlexibleChip />}
          </View>

          <View style={dt.divider} />
          <View style={dt.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={dt.h2}>{item.vehicle}</Text>
              <Text style={[dt.body, { marginTop: 8 }]}>{t("m.transportDetail.seatsSpeaks", { defaultValue: "Seats {{seats}} · Speaks {{languages}}", seats: item.seats, languages: item.languages.join(", ") })}</Text>
            </View>
            <StatBox icon="users" label={t("m.transportDetail.seatsLabel", { defaultValue: "SEATS" })} value={item.seats} />
          </View>

          {modeOptions.length > 1 ? (
            <>
              <Text style={dt.sectionTitle}>{t("m.transportDetail.bookingType", { defaultValue: "Booking type" })}</Text>
              <Segmented options={modeOptions} value={m} onChange={setM} small faint />
            </>
          ) : (
            <View style={dt.chipRow}>
              <VerifyChip>{modeLabel(t, m) || t("m.transportDetail.modeDayRental", { defaultValue: "Day rental" })}</VerifyChip>
            </View>
          )}

          <Text style={dt.sectionTitle}>{t("m.transportDetail.areaCoverage", { defaultValue: "Area & coverage" })}</Text>
          <View style={[dt.loc, { marginTop: 0, marginBottom: 12 }]}>
            <Icon name="mappin" size={15} color={T.muted} />
            <Text style={dt.locTxt}>{item.area}</Text>
          </View>
          <MiniMap lat={item.lat} lng={item.lng} label={item.driver} />

          {m === "package" && tours.length > 0 && (
            <>
              <Text style={dt.sectionTitle}>{t("m.transportDetail.packagesOnOffer", { defaultValue: "Packages on offer" })}</Text>
              <View style={{ gap: 14 }}>
                {tours.map((t, i) => <TourCard key={i} tour={t} item={item} active={i === selTour} onPress={() => setSelTour(i)} />)}
              </View>
            </>
          )}

          {m === "hourly" && (
            <>
              <Text style={dt.sectionTitle}>{t("m.transportDetail.rates", { defaultValue: "Rates" })}</Text>
              <View style={dt.chipRow}>
                <View style={s.ratePill}><Text style={s.ratePillTxt}>{rupee(item.hourly)} {t("m.transportDetail.perHour", { defaultValue: "/ hour" })}</Text></View>
              </View>
            </>
          )}

          {m === "day" && (
            <>
              <Text style={dt.sectionTitle}>{t("m.transportDetail.rates", { defaultValue: "Rates" })}</Text>
              <View style={dt.chipRow}>
                <View style={s.ratePill}><Text style={s.ratePillTxt}>{rupee(item.day)} {t("m.transportDetail.perDay", { defaultValue: "/ day" })}</Text></View>
              </View>
            </>
          )}

          {/* Weekly availability — real working hours when onboarded, else
              the legacy free-text. Flexible note mirrors the web's copy. */}
          {(hoursSummary(item.workingHours, t).length > 0 || !!item.available || item.flexibleHours) && (
            <>
              <Text style={dt.sectionTitle}>{t("m.transportDetail.availability", { defaultValue: "Availability" })}</Text>
              <View style={dt.chipRow}>
                {hoursSummary(item.workingHours, t).length > 0
                  ? hoursSummary(item.workingHours, t).map((h) => (
                      <View key={h} style={s.ratePill}>
                        <Icon name="clock" size={13} color={T.ink} />
                        <Text style={s.ratePillTxt}> {h}</Text>
                      </View>
                    ))
                  : !!item.available && (
                      <View style={s.ratePill}>
                        <Icon name="clock" size={13} color={T.ink} />
                        <Text style={s.ratePillTxt}> {item.available}</Text>
                      </View>
                    )}
              </View>
              {item.flexibleHours && (
                <Text style={[dt.mutedSm, { marginTop: 8 }]}>{t("m.transportDetail.flexibleNote", { defaultValue: "Flexible hours — other times can be arranged with the driver." })}</Text>
              )}
            </>
          )}

          <Text style={dt.sectionTitle}>{t("m.transportDetail.languages", { defaultValue: "Languages" })}</Text>
          <View style={dt.chipRow}>
            {item.languages.map((l) => <LangChip key={l}>{l}</LangChip>)}
          </View>

          <Text style={dt.sectionTitle}>{t("m.transportDetail.aboutThisRide", { defaultValue: "About this ride" })}</Text>
          <Text style={dt.body}>{item.blurb}</Text>

          <View style={dt.divider} />
          <Text style={[dt.sectionTitle, { marginTop: 0 }]}>{t("m.transportDetail.reviews", { defaultValue: "Reviews" })}</Text>
          <ReviewsSection rating={item.rating} reviews={item.reviews || 0} list={reviewList} emptyText={t("m.transportDetail.reviewsEmpty", { defaultValue: "Be the first to ride and leave a review." })} />
        </DetailSheet>
      </ScrollView>

      <CtaBar
        price={rupee(price)}
        unit={unit}
        rating={item.rating}
        meta={t("m.transportDetail.tripsCount", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString("en-IN") })}
        label={t("m.transportDetail.matchDriver", { defaultValue: "Match driver" })}
        onPress={() => nav.navigate("Booking", { kind: "transport", id: item.id, mode: m })}
        insetBottom={insets.bottom}
      />
    </View>
  );
}

const s = StyleSheet.create({
  tourCard: { borderWidth: 1, borderColor: T.line, borderRadius: 18, padding: 16, backgroundColor: "rgba(255,255,255,0.5)" },
  tourActive: { borderColor: "rgba(58,50,71,0.45)", borderWidth: 1.5 },
  tourName: { fontSize: 18, fontFamily: font.head, color: T.ink, flex: 1, paddingRight: 10 },
  pricePill: { backgroundColor: T.ink, paddingVertical: 6, paddingHorizontal: 13, borderRadius: 999 },
  pricePillTxt: { color: "#fff", fontSize: 13, fontFamily: font.bodyHeavy },
  tourHours: { marginTop: 12, fontSize: 14, color: T.muted, fontFamily: font.body },
  tourHoursNum: { fontSize: 26, fontFamily: font.head, color: T.ink },
  tourSub: { marginTop: 16, marginBottom: 10, fontSize: 11, fontFamily: font.bodyHeavy, letterSpacing: 0.6, color: T.muted },
  stop: { flexDirection: "row", alignItems: "center", gap: 11 },
  stopNum: { width: 24, height: 24, borderRadius: 999, backgroundColor: T.ink, alignItems: "center", justifyContent: "center" },
  stopNumTxt: { color: "#fff", fontSize: 11.5, fontFamily: font.bodyHeavy },
  stopTxt: { fontSize: 14, fontFamily: font.bodySemi, color: T.ink, flex: 1 },
  ratePill: { flexDirection: "row", alignItems: "center", paddingVertical: 9, paddingHorizontal: 15, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  rateGhost: { backgroundColor: "rgba(255,255,255,0.3)" },
  ratePillTxt: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.ink },
});
