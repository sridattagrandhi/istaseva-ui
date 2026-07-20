// design/screens/StayDetailScreen.tsx — ported from detail.jsx StayDetail.
import React, { useEffect } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Image } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "@/contexts/LanguageContext";
import { Icon } from "../Icon";
import { Ph } from "../primitives";
import { RoomType, BLANK_STAY } from "../types";
import { useDesign } from "../DesignContext";
import { useListingDetail, useListingReviews } from "../api/hooks";
import { track } from "../api/analyticsEvents";
import { T, font, rupee } from "../theme";
import {
  HeroGallery, DetailSheet, Eyebrow, StatBox, LangChip, MiniMap, ReviewsSection, CtaBar, dt,
  DetailLoading, DetailNotFound,
} from "./detailParts";

const TYPE_LABEL: Record<string, string> = {
  Homestay: "HOMESTAY", Lodge: "LODGE", "Farm stay": "FARM STAY", "Village stay": "VILLAGE STAY",
  Hotel: "HOTEL", Heritage: "HERITAGE", Sathram: "SATHRAM",
};

function RoomCard({ room, onReserve }: { room: RoomType; onReserve: () => void }) {
  const { t } = useLanguage();
  const bedsTxt = t("m.stayDetail.beds", { defaultValue: "{{count}} bed", count: room.beds });
  const bathsTxt = t("m.stayDetail.baths", { defaultValue: "{{count}} bath", count: room.baths });
  const roomsTxt = room.quantity && room.quantity > 1
    ? ` · ${t("m.stayDetail.roomsCount", { defaultValue: "{{count}} rooms", count: room.quantity })}`
    : "";
  return (
    <View style={s.roomCard}>
      <View style={s.roomMedia}>
        {room.photoUrls && room.photoUrls[0]
          ? <Image source={{ uri: room.photoUrls[0] }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
          : <Ph tone={room.tone} icon="bedDouble" label={room.name} style={StyleSheet.absoluteFill as any} />}
      </View>
      <View style={s.roomBody}>
        <Text style={s.roomName}>{room.name}</Text>
        <View style={s.roomMeta}>
          <Icon name="users" size={13} color={T.terra} />
          <Text style={s.roomMetaTxt}>{t("m.stayDetail.sleeps", { defaultValue: "Sleeps {{count}}", count: room.sleeps })} · {bedsTxt} · {bathsTxt}{roomsTxt}</Text>
        </View>
        <View style={s.chipWrap}>
          {room.amenities.map((a) => (
            <View key={a} style={s.chipSm}><Text style={s.chipSmTxt}>{a}</Text></View>
          ))}
        </View>
        <View style={s.roomFoot}>
          <Text style={s.roomPrice}>{rupee(room.price)}<Text style={s.roomPriceSmall}> {t("m.stayDetail.perNight", { defaultValue: "/night" })}</Text></Text>
          <Pressable style={({ pressed }) => [s.reserveBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] }]} onPress={onReserve}>
            <Text style={s.reserveTxt}>{t("m.stayDetail.reserve", { defaultValue: "Reserve" })}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function StayDetailScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { wish, toggleWish } = useDesign();
  const { item: stay, loading, notFound } = useListingDetail(route.params?.id, "stay", BLANK_STAY);
  const { reviews } = useListingReviews(route.params?.id);
  useEffect(() => { const id = route.params?.id; if (id) void track("listing_viewed", { listingId: String(id), listingType: "stay", source: "stay_detail" }); }, [route.params?.id]);
  if (loading) return <DetailLoading onBack={() => nav.goBack()} />;
  if (notFound) return <DetailNotFound onBack={() => nav.goBack()} label={t("m.stayDetail.labelStay", { defaultValue: "stay" })} />;
  const reviewList = reviews.length ? reviews : (stay.topReviews ?? []);
  const isRooms = stay.listingKind === "rooms";
  const maxSleeps = isRooms ? Math.max(...stay.roomTypes!.map((r) => r.sleeps)) : stay.guests;
  const fromPrice = isRooms ? Math.min(...stay.roomTypes!.map((r) => r.price)) : stay.price;

  return (
    <View style={{ flex: 1, backgroundColor: "#f4efe9" }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        <HeroGallery
          count={stay.photos} photoUrls={stay.photoUrls} icon="bedDouble" label={stay.type} title={stay.title}
          onBack={() => nav.goBack()} wishOn={wish.has(stay.id)} onWish={() => toggleWish(stay.id, "stay")} insetTop={insets.top}
          shareKind="stay" shareId={stay.id}
        />
        <DetailSheet>
          <Eyebrow>{TYPE_LABEL[stay.type] || stay.type}</Eyebrow>
          <Text style={dt.h1}>{stay.title}</Text>
          <View style={dt.ratingRow}>
            <View style={dt.ratingStrong}>
              <Icon name="starFill" size={13} color={T.saffron} />
              <Text style={dt.ratingTxt}>{stay.rating}</Text>
            </View>
            <Text style={dt.mutedSm}>· {t("m.stayDetail.reviewsCount", { defaultValue: "{{count}} reviews", count: stay.reviews })}</Text>
          </View>
          <View style={dt.loc}>
            <Icon name="mappin" size={15} color={T.muted} />
            <Text style={dt.locTxt}>{stay.address}</Text>
          </View>

          <View style={dt.divider} />
          <View style={dt.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={dt.h2}>{t("m.stayDetail.hostedBy", { defaultValue: "Hosted by {{owner}}", owner: stay.owner })}</Text>
              <Text style={[dt.body, { marginTop: 8 }]}>
                {isRooms
                  ? `${t("m.stayDetail.roomTypesCount", { defaultValue: "{{count}} room types", count: stay.roomTypes!.length })} · ${t("m.stayDetail.upToGuests", { defaultValue: "up to {{count}} guests", count: maxSleeps })} · ${t("m.stayDetail.hostingSince", { defaultValue: "hosting since {{since}}", since: stay.hostSince })}`
                  : `${t("m.stayDetail.upToGuestsCap", { defaultValue: "Up to {{count}} guests", count: stay.guests })} · ${t("m.stayDetail.bedrooms", { defaultValue: "{{count}} bedrooms", count: stay.rooms })} · ${t("m.stayDetail.bathrooms", { defaultValue: "{{count}} bathrooms", count: stay.baths })} · ${t("m.stayDetail.hostingSince", { defaultValue: "hosting since {{since}}", since: stay.hostSince })}`}
              </Text>
            </View>
            <StatBox icon="bed" label={isRooms ? t("m.stayDetail.statRoomTypes", { defaultValue: "ROOM TYPES" }) : t("m.stayDetail.statBedrooms", { defaultValue: "BEDROOMS" })} value={isRooms ? stay.roomTypes!.length : stay.rooms} />
          </View>

          <View style={s.ioBox}>
            <View style={s.ioCol}>
              <Text style={s.ioLabel}>{t("m.stayDetail.checkIn", { defaultValue: "CHECK-IN" })}</Text>
              <Text style={s.ioVal}>{stay.checkIn}</Text>
            </View>
            <View style={s.ioSep} />
            <View style={s.ioCol}>
              <Text style={s.ioLabel}>{t("m.stayDetail.checkOut", { defaultValue: "CHECK-OUT" })}</Text>
              <Text style={s.ioVal}>{stay.checkOut}</Text>
            </View>
          </View>

          <View style={[dt.chipRow, { marginTop: 16 }]}>
            {stay.languages.map((l) => <LangChip key={l}>{l}</LangChip>)}
          </View>

          <Text style={dt.sectionTitle}>{t("m.stayDetail.aboutPlace", { defaultValue: "About this place" })}</Text>
          <Text style={dt.body}>{stay.blurb}</Text>

          {isRooms ? (
            <>
              <Text style={dt.sectionTitle}>{t("m.stayDetail.roomOptions", { defaultValue: "Room options" })}</Text>
              <View style={{ gap: 14 }}>
                {stay.roomTypes!.map((r, i) => (
                  <RoomCard key={i} room={r} onReserve={() => nav.navigate("Booking", { kind: "stay", id: stay.id, roomIndex: i })} />
                ))}
              </View>
              {/* Property-wide facilities (pool, gym, restaurant…) — the listing-level
                  amenities field carries these for multi-room stays; in-room
                  amenities render inside each RoomCard. */}
              {stay.amenityLabels.length > 0 && (
                <>
                  <Text style={dt.sectionTitle}>{t("m.stayDetail.hotelFacilities", { defaultValue: "Hotel facilities" })}</Text>
                  <View style={{ gap: 9 }}>
                    {stay.amenityLabels.map((a, i) => (
                      <View key={i} style={s.amcheck}>
                        <Icon name="checkSm" size={15} color="#2f7d55" strokeWidth={2.6} />
                        <Text style={s.amcheckTxt}>{a}</Text>
                      </View>
                    ))}
                  </View>
                </>
              )}
            </>
          ) : (
            <>
              <Text style={dt.sectionTitle}>{t("m.stayDetail.amenities", { defaultValue: "Amenities" })}</Text>
              <View style={{ gap: 9 }}>
                {stay.amenityLabels.map((a, i) => (
                  <View key={i} style={s.amcheck}>
                    <Icon name="checkSm" size={15} color="#2f7d55" strokeWidth={2.6} />
                    <Text style={s.amcheckTxt}>{a}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          <Text style={dt.sectionTitle}>{t("m.stayDetail.cancellation", { defaultValue: "Cancellation" })}</Text>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <Icon name="shield" size={16} color="#2f7d55" />
            <Text style={[dt.body, { flex: 1, fontSize: 13 }]}>{stay.cancellation}</Text>
          </View>

          <Text style={dt.sectionTitle}>{t("m.stayDetail.whereYoullBe", { defaultValue: "Where you'll be" })}</Text>
          <View style={[dt.loc, { marginTop: 0, marginBottom: 12 }]}>
            <Icon name="mappin" size={15} color={T.muted} />
            <Text style={dt.locTxt}>{stay.address}</Text>
          </View>
          <MiniMap lat={stay.lat} lng={stay.lng} label={stay.title} />
          {/* WS6: this viewer got privacy-approximated geo — the line above
              is the area, not an address. Mirrors web's detail-page note. */}
          {stay.geoExact === false && (
            <Text style={{ fontFamily: font.body, fontSize: 12, lineHeight: 16, color: T.muted, marginTop: 8 }}>
              {t("m.detail.approxLocation", { defaultValue: "This is the approximate area. The exact address is shared once your booking is confirmed." })}
            </Text>
          )}

          <View style={dt.divider} />
          <Text style={[dt.sectionTitle, { marginTop: 0 }]}>{t("m.stayDetail.reviews", { defaultValue: "Reviews" })}</Text>
          <ReviewsSection rating={stay.rating} reviews={stay.reviews} list={reviewList} emptyText={t("m.stayDetail.reviewsEmpty", { defaultValue: "Be the first to share an experience after your stay." })} />
        </DetailSheet>
      </ScrollView>

      <CtaBar
        price={`${isRooms ? t("m.stayDetail.fromPrefix", { defaultValue: "from " }) : ""}${rupee(fromPrice)}`}
        unit={` ${t("m.stayDetail.perNight", { defaultValue: "/night" })}`}
        rating={stay.rating}
        meta={t("m.stayDetail.reviewsCount", { defaultValue: "{{count}} reviews", count: stay.reviews })}
        label={isRooms ? t("m.stayDetail.chooseRoom", { defaultValue: "Choose a room" }) : t("m.stayDetail.reserve", { defaultValue: "Reserve" })}
        onPress={() => nav.navigate("Booking", { kind: "stay", id: stay.id })}
        insetBottom={insets.bottom}
      />
    </View>
  );
}

const s = StyleSheet.create({
  ioBox: { flexDirection: "row", marginTop: 18, borderWidth: 1, borderColor: T.line, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.45)", overflow: "hidden" },
  ioCol: { flex: 1, paddingVertical: 14, paddingHorizontal: 16, gap: 4 },
  ioLabel: { fontSize: 10.5, fontFamily: font.bodyHeavy, letterSpacing: 0.6, color: T.muted },
  ioVal: { fontSize: 15.5, fontFamily: font.bodyBold, color: T.ink },
  ioSep: { width: 1, backgroundColor: T.line },
  amcheck: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 13, paddingHorizontal: 15, borderWidth: 1, borderColor: T.line, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.45)" },
  amcheckTxt: { fontSize: 14, fontFamily: font.bodySemi, color: T.ink },
  roomCard: { borderWidth: 1, borderColor: T.line, borderRadius: 18, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.5)" },
  roomMedia: { height: 180, position: "relative" },
  roomBody: { paddingHorizontal: 16, paddingTop: 15, paddingBottom: 16 },
  roomName: { fontSize: 17, fontFamily: font.head, color: T.ink },
  roomMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  roomMetaTxt: { color: T.muted, fontSize: 12.5, fontFamily: font.body },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 11 },
  chipSm: { paddingVertical: 5, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  chipSmTxt: { fontSize: 11.5, fontFamily: font.bodySemi, color: T.ink },
  roomFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 },
  roomPrice: { fontSize: 18, fontFamily: font.bodyHeavy, color: T.ink },
  roomPriceSmall: { color: T.muted, fontSize: 12, fontFamily: font.bodySemi },
  reserveBtn: { backgroundColor: T.aubergine, paddingHorizontal: 20, minHeight: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  reserveTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 14 },
});
