import { Link } from "react-router-dom";
import { Car, Heart, MapPin, Star, Wrench, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSaved } from "@/contexts/SavedContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useSavedListings } from "@/hooks/use-marketplace-data";
import BackButton from "@/components/BackButton";

// Standalone Wishlist page. Extracted from the old GuestDashboard's "saved"
// tab when the guest dashboard was dissolved into dedicated pages
// (/bookings, /wishlist, /notifications) — the three saved sections and
// their card markup are unchanged.
const Wishlist = () => {
  const { t } = useLanguage();
  const { savedStays, savedServices, savedTransport, toggleSaveStay, toggleSaveService, toggleSaveTransport } = useSaved();
  // Saved cards resolved by fetching each saved listing directly. The old
  // approach filtered saved IDs against the first 100 rows of each public
  // feed (the server's hard MAX_LIMIT), so saves past position 100 in the
  // newest-first feed silently vanished from this page.
  const {
    stays: resolvedSavedStays,
    services: resolvedSavedServices,
    transports: resolvedSavedTransport,
  } = useSavedListings({ stay: savedStays, service: savedServices, transport: savedTransport });

  const savedCount = resolvedSavedStays.length + resolvedSavedServices.length + resolvedSavedTransport.length;

  return (
    <div className="min-h-screen">
      <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <BackButton className="mb-3" label={t("common.back", { defaultValue: "Back" })} />
        {/* Page header — glassy redesign tile, same surface language as the
            dashboards, slimmed to a title band. */}
        <div className="mb-6 rounded-[18px] border border-white/70 bg-white/64 p-5 sm:p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_16px_44px_rgba(34,31,39,0.08)] backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div
              className="inline-grid h-11 w-11 place-items-center rounded-2xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_26px_rgba(58,50,71,0.18)]"
              style={{ background: "linear-gradient(135deg, #2b2436 0%, #7b5244 60%, #c08a5a 100%)" }}
            >
              <Heart className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight">{t("nav.myWishlist", { defaultValue: "My Wishlist" })}</h1>
              <p className="text-sm text-muted-foreground">{t("guest.saved.count", { count: savedCount, defaultValue: "{{count}} saved" })}</p>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          <div>
            <h3 className="font-display font-semibold mb-4 flex items-center gap-2">
              <Heart className="w-4 h-4 text-destructive" /> {t("guest.saved.stays")}
              <span className="text-xs text-muted-foreground font-normal">({resolvedSavedStays.length})</span>
            </h3>
            {resolvedSavedStays.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {resolvedSavedStays.map(stay => {
                  return (
                    <Link key={stay.id} to={`/stay/${stay.id}`} className="bg-card rounded-2xl border border-border overflow-hidden hover:shadow-lg transition-all group">
                      <div className="relative h-40 overflow-hidden">
                        <img src={stay.image} alt={stay.title} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                        {stay.verified && (
                          <span className="absolute top-2 left-2 px-2 py-0.5 bg-success/90 text-success-foreground text-[10px] font-medium rounded-full flex items-center gap-1">
                            <BadgeCheck className="w-3 h-3" />{t("guest.saved.verified")}
                          </span>
                        )}
                        {/* Filled-red heart matches the explore-page card
                            treatment so saved state reads the same wherever
                            the listing appears. Tapping it unsaves the
                            listing — `preventDefault` stops the wrapper
                            <Link> from navigating to the detail page on
                            the same click. */}
                        <button
                          type="button"
                          aria-label={t("guest.saved.removeFromSaved", { defaultValue: "Remove from saved" })}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSaveStay(String(stay.id)); }}
                          className="absolute top-2 right-2 inline-grid h-8 w-8 place-items-center rounded-full bg-white/95 shadow-md hover:bg-white"
                        >
                          <Heart className="w-4 h-4 fill-destructive text-destructive" />
                        </button>
                      </div>
                      <div className="p-4">
                        <h3 className="font-semibold text-sm group-hover:text-primary transition-colors">{stay.title}</h3>
                        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><MapPin className="w-3 h-3" />{stay.location}</p>
                        <div className="flex items-center justify-between mt-3">
                          {/* Multi-room stays (hotels / sathrams / lodges)
                              have no listing-level nightly price — the
                              real price lives on each room_type. The
                              saved-listing card was reading stay.price
                              directly and showing "₹0/night" for those.
                              Fall back to the cheapest room's price
                              (in paise, so we /100) and label it as a
                              "from" price. */}
                          {(() => {
                            const roomFromPaise = (stay.roomTypes ?? [])
                              .map((r) => Number(r.basePricePaise) || 0)
                              .filter((p) => p > 0)
                              .sort((a, b) => a - b)[0];
                            const fromRupees = roomFromPaise ? Math.round(roomFromPaise / 100) : 0;
                            const display = stay.price > 0 ? stay.price : fromRupees;
                            const isFrom = stay.price <= 0 && fromRupees > 0;
                            if (display <= 0) {
                              return (
                                <p className="text-xs font-semibold text-muted-foreground">{t("guest.saved.pricingOnRequest", { defaultValue: "Pricing on request" })}</p>
                              );
                            }
                            return (
                              <p className="font-bold">
                                {isFrom && <span className="text-xs text-muted-foreground font-normal mr-1">{t("guest.saved.from", { defaultValue: "from" })}</span>}
                                ₹{display.toLocaleString()}
                                <span className="text-xs text-muted-foreground font-normal">{t("guest.perNight")}</span>
                              </p>
                            );
                          })()}
                          <div className="flex items-center gap-1"><Star className="w-3 h-3 fill-secondary text-secondary" /><span className="text-xs font-medium">{stay.rating}</span></div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="bg-card rounded-2xl border border-border p-10 text-center">
                <Heart className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground mb-1">{t("guest.saved.noStays")}</p>
                <p className="text-xs text-muted-foreground mb-4">{t("guest.saved.noStaysHint")}</p>
                <Button variant="outline" className="rounded-xl" asChild><Link to="/explore">{t("guest.saved.exploreStays")}</Link></Button>
              </div>
            )}
          </div>
          <div>
            <h3 className="font-display font-semibold mb-4 flex items-center gap-2">
              <Wrench className="w-4 h-4 text-primary" /> {t("guest.saved.services")}
              <span className="text-xs text-muted-foreground font-normal">({resolvedSavedServices.length})</span>
            </h3>
            {resolvedSavedServices.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {/* Same image-top card as Saved Stays (and the discovery
                    pages) so all three saved sections read as one grid —
                    the old compact row made services look like a different
                    product surface. */}
                {resolvedSavedServices.map(svc => (
                  <Link key={String(svc.id)} to={`/service/${svc.id}`} className="bg-card rounded-2xl border border-border overflow-hidden hover:shadow-lg transition-all group">
                    <div className="relative h-40 overflow-hidden">
                      <img src={svc.image} alt={svc.title} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                      {svc.mainCategory && (
                        <span className="absolute top-2 left-2 px-2 py-0.5 bg-background/90 text-foreground text-[10px] font-medium rounded-full">{svc.mainCategory}</span>
                      )}
                      <button
                        type="button"
                        aria-label={t("guest.saved.removeFromSaved", { defaultValue: "Remove from saved" })}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSaveService(String(svc.id)); }}
                        className="absolute top-2 right-2 inline-grid h-8 w-8 place-items-center rounded-full bg-white/95 shadow-md hover:bg-white"
                      >
                        <Heart className="w-4 h-4 fill-destructive text-destructive" />
                      </button>
                    </div>
                    <div className="p-4">
                      <h3 className="font-semibold text-sm group-hover:text-primary transition-colors">{svc.title}</h3>
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><MapPin className="w-3 h-3" />{[svc.provider, svc.location].filter(Boolean).join(" • ")}</p>
                      <div className="flex items-center justify-between mt-3">
                        <p className="font-bold">₹{svc.price.toLocaleString()}</p>
                        <div className="flex items-center gap-1"><Star className="w-3 h-3 fill-secondary text-secondary" /><span className="text-xs font-medium">{svc.rating}</span></div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="bg-card rounded-2xl border border-border p-10 text-center">
                <Wrench className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground mb-1">{t("guest.saved.noServices")}</p>
                <Button variant="outline" className="rounded-xl mt-3" asChild><Link to="/services">{t("guest.browseServices")}</Link></Button>
              </div>
            )}
          </div>
          {/* Saved Transport — mirrors the stays / services blocks above.
              Headline pulls per-mode rate via the same hourly→day→perKm
              fallback the marketplace card uses, so the saved card never
              shows ₹0 when the driver only published a daily or per-km
              rate. */}
          <div>
            <h3 className="font-display font-semibold mb-4 flex items-center gap-2">
              <Car className="w-4 h-4 text-primary" /> {t("guest.saved.transport", { defaultValue: "Saved Transport" })}
              <span className="text-xs text-muted-foreground font-normal">({resolvedSavedTransport.length})</span>
            </h3>
            {resolvedSavedTransport.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {resolvedSavedTransport.map((item) => {
                  const rate =
                    item.hourly > 0 ? { value: item.hourly, unit: t("guest.saved.perHour", { defaultValue: "/ hour" }) }
                    : item.day > 0 ? { value: item.day,    unit: t("guest.saved.perDay", { defaultValue: "/ day" }) }
                    : item.perKm > 0 ? { value: item.perKm, unit: t("guest.saved.perKm", { defaultValue: "/ km" }) }
                    : null;
                  return (
                    <Link
                      key={String(item.id)}
                      to={`/transport/${item.id}`}
                      className="bg-card rounded-2xl border border-border overflow-hidden hover:shadow-lg transition-all group"
                    >
                      <div className="relative h-40 overflow-hidden">
                        {item.image
                          ? <img src={item.image} alt={item.driver} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                          : <div className="w-full h-full grid place-items-center bg-muted text-primary"><Car className="w-8 h-8" /></div>}
                        {item.type && (
                          <span className="absolute top-2 left-2 px-2 py-0.5 bg-background/90 text-foreground text-[10px] font-medium rounded-full">{item.type}</span>
                        )}
                        <button
                          type="button"
                          aria-label={t("guest.saved.removeFromSaved", { defaultValue: "Remove from saved" })}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSaveTransport(String(item.id)); }}
                          className="absolute top-2 right-2 inline-grid h-8 w-8 place-items-center rounded-full bg-white/95 shadow-md hover:bg-white"
                        >
                          <Heart className="w-4 h-4 fill-destructive text-destructive" />
                        </button>
                      </div>
                      <div className="p-4">
                        <h3 className="font-semibold text-sm group-hover:text-primary transition-colors">{item.driver}</h3>
                        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1"><MapPin className="w-3 h-3" />{[item.vehicle, item.area].filter(Boolean).join(" · ")}</p>
                        <div className="flex items-center justify-between mt-3">
                          {rate ? (
                            <p className="font-bold">₹{rate.value.toLocaleString()}<span className="text-xs text-muted-foreground font-normal"> {rate.unit}</span></p>
                          ) : (
                            <p className="text-xs font-semibold text-muted-foreground">{t("guest.saved.pricingOnRequest", { defaultValue: "Pricing on request" })}</p>
                          )}
                          <div className="flex items-center gap-1"><Star className="w-3 h-3 fill-secondary text-secondary" /><span className="text-xs font-medium">{item.rating}</span></div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="bg-card rounded-2xl border border-border p-10 text-center">
                <Car className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground mb-1">{t("guest.saved.noTransport", { defaultValue: "No saved transport yet" })}</p>
                <Button variant="outline" className="rounded-xl mt-3" asChild>
                  <Link to="/transport">{t("guest.saved.browseTransport", { defaultValue: "Browse Transport" })}</Link>
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Wishlist;
