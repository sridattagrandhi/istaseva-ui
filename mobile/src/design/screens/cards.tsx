// design/screens/cards.tsx — listing cards ported from explore.jsx.
import React from "react";
import { View, Text, StyleSheet, Image } from "react-native";
import { Icon } from "../Icon";
import { Card, Ph, HeartBtn, RatingLine, Tag, rupee } from "../primitives";

/** Real photo when the listing has one (backend), else the striped placeholder. */
function Media({ url, tone, icon, label }: { url?: string; tone: any; icon: string; label: string }) {
  if (url) return <Image source={{ uri: url }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />;
  return <Ph tone={tone} icon={icon} label={label} style={StyleSheet.absoluteFill as any} />;
}
import { T, font } from "../theme";
import { Stay, Service, Transport } from "../types";
import { useDesign } from "../DesignContext";
import { useLanguage } from "@/contexts/LanguageContext";

export function StayCard({ stay, wide, onOpen }: { stay: Stay; wide?: boolean; onOpen: () => void }) {
  const { wish, toggleWish } = useDesign();
  const { t } = useLanguage();
  return (
    <Card onPress={onOpen} style={wide ? { width: 270 } : { width: "100%" }}>
      <View style={s.media}>
        <Media url={stay.photoUrls?.[0]} tone={stay.tone} icon="bedDouble" label={t("m.cards.typePhoto", { defaultValue: "{{type}} photo", type: stay.type })} />
        <View style={s.floatBadge}>
          <Text style={s.floatBadgeTxt}>{stay.type}</Text>
        </View>
        <HeartBtn on={wish.has(stay.id)} onPress={() => toggleWish(stay.id, "stay")} />
      </View>
      <View style={s.body}>
        <RatingLine rating={stay.rating} reviews={stay.reviews} verified={stay.verified} />
        <Text style={s.title}>{stay.title}</Text>
        <View style={s.loc}>
          <Icon name="mappin" size={14} color={T.muted} />
          <Text style={s.locTxt}>{stay.location}, {stay.district}</Text>
        </View>
        <View style={s.priceRow}>
          <View style={s.meta}>
            <Icon name="users" size={15} color={T.muted} />
            <Text style={s.metaTxt}>{t("m.cards.guests", { defaultValue: "{{count}} guests", count: stay.guests })}</Text>
          </View>
          <Text style={s.price}>{stay.listingKind === "rooms" ? <Text style={s.priceSmall}>{t("m.cards.from", { defaultValue: "from " })}</Text> : null}{rupee(stay.price)}<Text style={s.priceSmall}>{t("m.cards.perNight", { defaultValue: "/night" })}</Text></Text>
        </View>
      </View>
    </Card>
  );
}

export function ServiceCard({ service, onOpen, vertical }: { service: Service; onOpen: () => void; vertical?: boolean }) {
  const { wish, toggleWish } = useDesign();
  const { t } = useLanguage();
  // Vertical variant — same photo-on-top structure as StayCard, so the wishlist
  // renders stays/services/transport with one consistent card shape.
  if (vertical) {
    return (
      <Card onPress={onOpen} style={{ width: "100%" }}>
        <View style={s.media}>
          <Media url={service.photoUrls?.[0]} tone={service.tone} icon={service.icon} label={t("m.cards.categoryPhoto", { defaultValue: "{{category}} photo", category: service.category })} />
          <View style={s.floatBadge}><Icon name={service.icon} size={12} color="#fff" /><Text style={s.floatBadgeTxt}>{service.category}</Text></View>
          <HeartBtn on={wish.has(service.id)} onPress={() => toggleWish(service.id, "service")} />
        </View>
        <View style={s.body}>
          <RatingLine rating={service.rating} reviews={service.reviews} />
          <Text style={s.title} numberOfLines={1}>{service.title}</Text>
          {service.subcategory ? <Text style={s.subcat} numberOfLines={1}>{service.subcategory}</Text> : null}
          <View style={s.loc}>
            <Icon name="mappin" size={14} color={T.muted} />
            <Text style={s.locTxt} numberOfLines={1}>{service.address || service.location}</Text>
          </View>
          <View style={s.priceRow}>
            <View style={s.meta}><Icon name="clock" size={15} color={T.muted} /><Text style={s.metaTxt}>{service.duration}</Text></View>
            <Text style={s.price}><Text style={s.priceSmall}>{t("m.cards.from", { defaultValue: "from " })}</Text>{rupee(service.price)}</Text>
          </View>
        </View>
      </Card>
    );
  }
  return (
    <Card onPress={onOpen} style={{ width: "100%" }}>
      <View style={[s.body, { flexDirection: "row", gap: 13 }]}>
        <View style={s.svcThumb}>
          <Media url={service.photoUrls?.[0]} tone={service.tone} icon={service.icon} label="" />
          <View style={s.svcBadge}><Icon name={service.icon} size={11} color="#fff" /></View>
        </View>
        <View style={{ flex: 1, minWidth: 0, paddingRight: 30 }}>
          <RatingLine
            rating={service.rating}
            reviews={service.reviews}
            extra={
              <>
                <Text style={s.dotSep}>·</Text>
                <Icon name="clock" size={12} color={T.muted} />
                <Text style={s.metaTxt}>{service.duration}</Text>
              </>
            }
          />
          <Text style={[s.title, { fontSize: 15.5, marginTop: 5 }]} numberOfLines={1}>{service.title}</Text>
          {service.subcategory ? <Text style={s.subcat} numberOfLines={1}>{service.subcategory}</Text> : null}
          <View style={[s.loc, { marginTop: 3 }]}>
            <Icon name="mappin" size={13} color={T.muted} />
            <Text style={s.locTxt} numberOfLines={1}>{service.address || service.location}</Text>
          </View>
          <Text style={s.svcPrice}>{t("m.cards.startingFrom", { defaultValue: "Starting from " })}<Text style={s.price}>{rupee(service.price)}</Text></Text>
        </View>
      </View>
      <HeartBtn on={wish.has(service.id)} onPress={() => toggleWish(service.id, "service")} />
    </Card>
  );
}

// Mode-aware "from" price for a transport listing. Mirrors the web
// (ClientRedesign priceLabel / ExploreNearYou): pricePerDay/Hour are 0 for
// package-only drivers, so fall back to the cheapest concrete rate offered —
// day → hourly → per-km → cheapest package — instead of showing a bare ₹0/day.
export function transportFromPrice(item: Transport): { value: number; unit: string } | null {
  const pkgMin = item.tours.reduce<number>((m, t) => (t.price > 0 && (m === 0 || t.price < m) ? t.price : m), 0);
  if (item.day > 0) return { value: item.day, unit: "/day" };
  if (item.hourly > 0) return { value: item.hourly, unit: "/hr" };
  if (item.perKm > 0) return { value: item.perKm, unit: "/km" };
  if (pkgMin > 0) return { value: pkgMin, unit: "from" };
  return null;
}

/** Price for the ACTIVE explore tab — on the Package tab show the (cheapest)
 *  package price, Hourly tab the hourly rate, Day tab the day rate. Falls
 *  back to the generic priority order when the mode has no rate (shouldn't
 *  happen — the list is already filtered to drivers offering the mode). */
export function transportPriceForMode(item: Transport, mode?: string): { value: number; unit: string } | null {
  const pkgMin = item.tours.reduce<number>((m, t) => (t.price > 0 && (m === 0 || t.price < m) ? t.price : m), 0);
  if (mode === "package" && pkgMin > 0) return { value: pkgMin, unit: item.tours.length > 1 ? "from" : "/tour" };
  if (mode === "hourly" && item.hourly > 0) return { value: item.hourly, unit: "/hr" };
  if (mode === "day" && item.day > 0) return { value: item.day, unit: "/day" };
  return transportFromPrice(item);
}

export function TransportCard({ item, onOpen, vertical, mode }: { item: Transport; onOpen: () => void; vertical?: boolean; mode?: string }) {
  const { wish, toggleWish } = useDesign();
  const { t } = useLanguage();
  const price = transportPriceForMode(item, mode);
  const seatsLabel = item.seats ? t("m.cards.seats", { defaultValue: "{{count}} seats", count: item.seats }) : "";
  const tripsLabel = t("m.cards.trips", { defaultValue: "{{count}} trips", count: item.trips });
  const subParts = [item.vehicle, item.type, item.seats ? t("m.cards.seats", { defaultValue: "{{count}} seats", count: item.seats }) : ""].filter(Boolean).join(" · ");
  // Vertical variant — matches StayCard/ServiceCard so the wishlist is uniform.
  if (vertical) {
    return (
      <Card onPress={onOpen} style={{ width: "100%" }}>
        <View style={s.media}>
          <Media url={item.photoUrls?.[0]} tone={item.tone} icon="car" label={t("m.cards.transportPhoto", { defaultValue: "Transport photo" })} />
          <View style={s.floatBadge}><Icon name="car" size={12} color="#fff" /><Text style={s.floatBadgeTxt}>{item.type}</Text></View>
          <HeartBtn on={wish.has(item.id)} onPress={() => toggleWish(item.id, "transport")} />
        </View>
        <View style={s.body}>
          <RatingLine rating={item.rating} extra={<><Text style={s.dotSep}>·</Text><Text style={s.metaTxt}>{t("m.cards.trips", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString("en-IN") })}</Text></>} />
          <Text style={s.title} numberOfLines={1}>{item.driver}</Text>
          <Text style={s.subcat} numberOfLines={1}>{subParts}</Text>
          <View style={s.loc}>
            <Icon name="mappin" size={14} color={T.muted} />
            <Text style={s.locTxt} numberOfLines={1}>{item.area}</Text>
          </View>
          <View style={s.priceRow}>
            <View style={s.meta}><Icon name="users" size={15} color={T.muted} /><Text style={s.metaTxt}>{item.seats ? seatsLabel : tripsLabel}</Text></View>
            <Text style={s.price}>
              {price ? (
                <><Text style={s.priceSmall}>{t("m.cards.from", { defaultValue: "from " })}</Text>{rupee(price.value)}{price.unit !== "from" ? <Text style={s.priceSmall}>{price.unit}</Text> : null}</>
              ) : t("m.cards.ask", { defaultValue: "Ask" })}
            </Text>
          </View>
        </View>
      </Card>
    );
  }
  // Same row format as ServiceCard: thumb · content · heart, with a
  // "₹X/unit" price line (mode-aware unit for day/hourly/km).
  return (
    <Card onPress={onOpen} style={{ width: "100%" }}>
      <View style={[s.body, { flexDirection: "row", gap: 13 }]}>
        <View style={s.svcThumb}>
          <Media url={item.photoUrls?.[0]} tone={item.tone} icon="car" label="" />
          <View style={s.svcBadge}><Icon name="car" size={11} color="#fff" /></View>
        </View>
        <View style={{ flex: 1, minWidth: 0, paddingRight: 30 }}>
          <RatingLine
            rating={item.rating}
            extra={<><Text style={s.dotSep}>·</Text><Text style={s.metaTxt}>{t("m.cards.trips", { defaultValue: "{{count}} trips", count: item.trips.toLocaleString("en-IN") })}</Text></>}
          />
          <Text style={[s.title, { fontSize: 15.5, marginTop: 5 }]} numberOfLines={1}>{item.driver}</Text>
          <Text style={s.subcat} numberOfLines={1}>{subParts}</Text>
          <View style={[s.loc, { marginTop: 3 }]}>
            <Icon name="mappin" size={13} color={T.muted} />
            <Text style={s.locTxt} numberOfLines={1}>{item.area}</Text>
          </View>
          <Text style={s.svcPrice}>
            {price ? (
              <>{price.unit === "from" ? t("m.cards.from", { defaultValue: "from " }) : null}<Text style={s.price}>{rupee(price.value)}</Text>{price.unit !== "from" ? <Text style={s.priceSmall}>{price.unit}</Text> : null}</>
            ) : t("m.cards.askForPrice", { defaultValue: "Ask for price" })}
          </Text>
        </View>
      </View>
      <HeartBtn on={wish.has(item.id)} onPress={() => toggleWish(item.id, "transport")} />
    </Card>
  );
}

export function PackageCard({ pkg, onOpen }: { pkg: { title: string; stops: string; hours: string; price: number; tone: any; photo?: string }; onOpen: () => void }) {
  const { t } = useLanguage();
  return (
    <Card onPress={onOpen} style={{ width: 270 }}>
      <View style={[s.media, { height: 120 }]}>
        <Media url={pkg.photo} tone={pkg.tone} icon="landmark" label={t("m.cards.templeRoute", { defaultValue: "Temple route" })} />
        <View style={s.floatBadge}>
          <Icon name="route" size={13} color="#fff" />
          <Text style={s.floatBadgeTxt}>{t("m.cards.package", { defaultValue: "Package" })}</Text>
        </View>
      </View>
      <View style={s.body}>
        <Text style={[s.title, { fontSize: 15.5, marginTop: 0 }]}>{pkg.title}</Text>
        <View style={s.loc}>
          <Icon name="landmark" size={13} color={T.muted} />
          <Text style={s.locTxt}>{pkg.stops}</Text>
        </View>
        <View style={s.priceRow}>
          <View style={s.meta}>
            <Icon name="clock" size={14} color={T.muted} />
            <Text style={s.metaTxt}>{pkg.hours}</Text>
          </View>
          <Text style={s.price}>{rupee(pkg.price)}</Text>
        </View>
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  media: { position: "relative", height: 168 },
  body: { padding: 14 },
  title: { fontSize: 16.5, lineHeight: 20, fontFamily: font.head, color: T.ink, marginTop: 8 },
  subcat: { fontSize: 12, fontFamily: font.bodySemi, color: T.terra, marginTop: 3 },
  loc: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  locTxt: { color: T.muted, fontSize: 12.5, fontFamily: font.body, flexShrink: 1 },
  priceRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 13,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(23,22,28,0.08)",
  },
  meta: { flexDirection: "row", alignItems: "center", gap: 5 },
  metaTxt: { color: T.muted, fontSize: 12, fontFamily: font.bodyBold },
  price: { fontSize: 18, fontFamily: font.bodyHeavy, color: T.ink },
  priceSmall: { color: T.muted, fontSize: 12, fontFamily: font.bodySemi },
  dotSep: { color: T.muted },
  floatBadge: {
    position: "absolute",
    top: 12,
    left: 12,
    zIndex: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(47,41,59,0.62)",
  },
  floatBadgeTxt: { color: "#fff", fontSize: 11.5, fontFamily: font.bodyHeavy },
  trThumb: { width: 92, height: 92, borderRadius: 14, overflow: "hidden" },
  svcThumb: { width: 108, height: 108, borderRadius: 16, overflow: "hidden", position: "relative" },
  svcBadge: { position: "absolute", top: 8, left: 8, width: 24, height: 24, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(47,41,59,0.62)" },
  svcPrice: { fontSize: 13, fontFamily: font.bodySemi, color: T.muted, marginTop: 8 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 9 },
});
