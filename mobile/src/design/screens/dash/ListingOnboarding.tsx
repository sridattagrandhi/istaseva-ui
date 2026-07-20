// dash/ListingOnboarding.tsx — add/edit listing flow (chooser → full manual form → preview → success).
// The manual form mirrors the web OnboardingForm / Claude-design manual-form.jsx field set,
// role-aware for stay / service / transport.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, Image, StyleSheet, ActivityIndicator, Alert, Switch } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { Icon } from "../../Icon";
import { IconBtn, Ph } from "../../primitives";
import { T, font, Tone, noOutline } from "../../theme";
import { sendOnboardingChat, entryFor, OnboardMsg, enhanceOnboardingDescription } from "../../api/onboarding";
import { speak, stopSpeaking, useDictation, sttAvailable } from "../../api/voice";
import { AddressAutocomplete } from "../../AddressAutocomplete";
import { ChatText, stripChatMarkdown } from "../../ChatText";
import { saveOnboardingDraft, clearOnboardingDraft, OnboardingDraftEnvelope, OnboardingDraftView } from "../../api/onboardingDraft";
import { useAuth } from "../../../contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "../../../lib/toast";
import { uploadToStorage } from "../../api/storage";

type EntryType = "stay" | "service" | "transport";
export type DraftListing = { name: string; location: string; price: string; icon: string; tone: Tone; status: string; metric: string; rating: number };

/* ---- catalog data (mirrors web) ---- */
const STAY_TILES = [
  { propertyType: "homestay", label: "Homestay", emoji: "🏡" },
  { propertyType: "hotel", label: "Hotel", emoji: "🏨" },
  { propertyType: "lodge", label: "Lodge", emoji: "🏚️" },
  { propertyType: "village-stay", label: "Village stay", emoji: "🏞️" },
  { propertyType: "farm-stay", label: "Farm stay", emoji: "🚜" },
  { propertyType: "heritage", label: "Heritage", emoji: "🏛️" },
  { propertyType: "sathram", label: "Sathram", emoji: "🛕" },
];
const MULTI_ROOM = new Set(["hotel", "lodge", "heritage", "sathram"]);
const TRANSPORT_TILES = [
  { value: "Cab", emoji: "🚗" }, { value: "Auto", emoji: "🛺" }, { value: "Bus", emoji: "🚌" },
  { value: "Tempo", emoji: "🚐" }, { value: "Scooter", emoji: "🛵" }, { value: "Motorcycle", emoji: "🏍️" },
];
const SERVICE_CATS = [
  "Cleaning", "Deep cleaning", "Laundry & ironing", "Plumber", "Electrician", "AC repair", "Fridge repair",
  "Appliance repair", "Cook / chef", "Tiffin / meal prep", "Carpenter", "Painter", "Mechanic", "Car / bike wash",
  "Pest control", "Gardener", "Tour guide", "Photographer", "Videographer", "Makeup artist", "Salon at home",
  "Mehendi artist", "Barber", "Massage / spa", "Yoga instructor", "Fitness trainer", "Home nurse", "Elder care",
  "Babysitter / nanny", "Tutor", "Music teacher", "Dance teacher", "Event planner", "Decorator", "Caterer",
  "Pandit / priest", "Astrologer", "Tailor", "Packers & movers", "Pet grooming",
];
const STAY_AMENITIES = ["Wi-Fi", "AC", "Parking", "Breakfast", "TV", "Hot water", "Power backup", "Kitchen", "Pool", "Gym", "Restaurant", "Laundry", "Room service", "Pet friendly", "Garden", "Balcony", "Bonfire", "Housekeeping"];
// Property-wide facilities for multi-room stays (hotel/lodge/heritage/sathram).
// Stored in the same listings.amenities column — multi-room stays don't use it
// for in-room amenities (those live per-room), so it carries shared facilities.
const HOTEL_FACILITIES = ["Pool", "Gym", "Restaurant", "Parking", "Spa", "Bar", "Garden", "Laundry", "Power backup", "Lift", "Room service", "Banquet hall", "Rooftop", "Travel desk", "EV charging", "Wheelchair accessible"];
const LANGS = ["English", "Hindi", "Telugu", "Tamil", "Kannada", "Malayalam", "Marathi", "Bengali"];
const SERVICE_MODES: [string, string][] = [["at-home", "At home"], ["visit-provider", "Visit provider"], ["online", "Online"]];
const PRICE_UNITS: [string, string][] = [["per_hour", "Per hour"], ["per_visit", "Per visit"], ["per_session", "Per session"], ["per_day", "Per day"], ["fixed", "Fixed"]];
const BOOKING_MODES: [string, string][] = [["hourly", "Hourly"], ["day", "Day rental"], ["package", "Tour package"]];
const DAYS: [string, string][] = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];

type Room = { key: string; name: string; price: string; maxGuests: string; quantity: string; bedrooms: string; bathrooms: string; amenities: string[]; description: string; photos: string[]; unitIdentifiers: string[] };

// Agent-seeded rooms carry this key prefix so we can re-seed on agent
// corrections while never clobbering rooms the host has hand-edited.
const ROOM_SEED_PREFIX = "room-seed-";
// Map the AI agent's extracted `roomTypes` (numbers, ₹/night) onto the
// form's Room shape (everything stringified). Photos / unit numbers aren't
// captured by the agent — the host fills those in the editor.
function roomTypesToRooms(rt: any[]): Room[] {
  return (Array.isArray(rt) ? rt : []).map((r, i) => ({
    key: `${ROOM_SEED_PREFIX}${i}-${String(r?.name || "room").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16)}`,
    name: r?.name ?? "",
    price: r?.pricePerNight != null ? String(r.pricePerNight) : "",
    maxGuests: String(r?.maxGuests ?? 2),
    quantity: String(r?.quantity ?? 1),
    bedrooms: String(r?.bedrooms ?? 1),
    bathrooms: String(r?.bathrooms ?? 1),
    amenities: Array.isArray(r?.amenities) ? r.amenities : [],
    description: "",
    photos: [],
    unitIdentifiers: [],
  }));
}
type AddOn = { id?: string; name: string; price: string };
// Editor shape for a tour package. The activation gate requires label,
// price > 0, at least one named stop, and distanceKmMin — the editor keeps
// stops as a comma list of place names; buildCreatePayload converts to the
// wire shape ([{place}] + numeric km range).
type Pkg = { id: string; label: string; stops: string; price: string; hours: string; distanceKmMin: string; distanceKmMax: string };

/* ---------- small field components ---------- */
function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    // Descending zIndex so an earlier section's absolute overlay (the address
    // autocomplete dropdown) paints ABOVE the sections below it. Without this,
    // later sibling sections paint on top and the dropdown shows through them.
    <View style={[st.section, { zIndex: 100 - n }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={st.sectionNum}><Text style={st.sectionNumTxt}>{n}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={st.sectionTitle}>{title}</Text>
          {hint ? <Text style={st.sectionHint}>{hint}</Text> : null}
        </View>
      </View>
      <View style={{ gap: 14, marginTop: 14 }}>{children}</View>
    </View>
  );
}
function Field({ label, hint, required, children, style }: { label: string; hint?: string; required?: boolean; children: React.ReactNode; style?: any }) {
  return (
    <View style={style}>
      <Text style={st.label}>{label}{required ? <Text style={{ color: T.coral }}> *</Text> : null}</Text>
      {hint ? <Text style={st.fieldHint}>{hint}</Text> : null}
      {children}
    </View>
  );
}
function TField({ value, onChangeText, placeholder, numeric }: any) {
  return <TextInput style={st.input} value={value} onChangeText={(v: string) => onChangeText(numeric ? v.replace(/[^\d]/g, "") : v)} placeholder={placeholder} placeholderTextColor={T.muted} keyboardType={numeric ? "number-pad" : "default"} />;
}
function Money({ value, onChangeText, placeholder }: any) {
  return (
    <View style={st.mfPrefix}>
      <Text style={st.mfRupee}>₹</Text>
      <TextInput style={st.mfInput} value={value} onChangeText={(v: string) => onChangeText(v.replace(/[^\d]/g, ""))} placeholder={placeholder} placeholderTextColor={T.muted} keyboardType="number-pad" />
    </View>
  );
}
function Tiles({ items, value, onPick }: { items: { key: string; label: string; emoji: string }[]; value?: string; onPick: (k: string) => void }) {
  return (
    <View style={st.tileWrap}>
      {items.map((it) => {
        const active = value === it.key;
        return (
          <Pressable key={it.key} onPress={() => onPick(it.key)} style={({ pressed }: any) => [st.tile, active && st.tileActive, pressed && { opacity: 0.85 }]}>
            <Text style={{ fontSize: 22 }}>{it.emoji}</Text>
            <Text style={[st.tileTxt, active && { color: "#fff" }]}>{it.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
function Chips({ options, values, onToggle }: { options: [string, string][] | string[]; values: string[]; onToggle: (v: string) => void }) {
  const opts = options.map((o) => (Array.isArray(o) ? o : [o, o])) as [string, string][];
  return (
    <View style={st.chipWrap}>
      {opts.map(([v, lb]) => {
        const active = values.includes(v);
        return (
          <Pressable key={v} onPress={() => onToggle(v)} style={({ pressed }: any) => [st.chip, active && st.chipActive, pressed && { opacity: 0.8 }]}>
            <Text style={[st.chipTxt, active && { color: "#fff" }]}>{lb}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
function ChipListAdd({ items, onChange, presets, placeholder }: { items: string[]; onChange: (v: string[]) => void; presets?: string[]; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const has = (v: string) => items.some((x) => x.toLowerCase() === v.toLowerCase());
  const add = (v?: string) => { const t = (v ?? draft).trim(); if (!t || has(t)) { setDraft(""); return; } onChange([...items, t]); setDraft(""); };
  const remove = (v: string) => onChange(items.filter((x) => x !== v));
  const customItems = items.filter((i) => !presets || !presets.some((p) => p.toLowerCase() === i.toLowerCase()));
  return (
    <View style={{ gap: 10 }}>
      {presets && (
        <View style={st.chipWrap}>
          {presets.map((p) => (
            <Pressable key={p} onPress={() => (has(p) ? remove(items.find((x) => x.toLowerCase() === p.toLowerCase())!) : add(p))} style={({ pressed }: any) => [st.chip, has(p) && st.chipActive, pressed && { opacity: 0.8 }]}>
              <Text style={[st.chipTxt, has(p) && { color: "#fff" }]}>{p}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {customItems.length > 0 && (
        <View style={st.chipWrap}>
          {customItems.map((i) => (
            <View key={i} style={st.removableChip}>
              <Text style={st.removableTxt}>{i}</Text>
              <Pressable onPress={() => remove(i)}><Icon name="x" size={12} color={T.aubergine} /></Pressable>
            </View>
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[st.input, { flex: 1 }]} value={draft} onChangeText={setDraft} placeholder={placeholder} placeholderTextColor={T.muted} onSubmitEditing={() => add()} />
        <Pressable style={st.addBtn} onPress={() => add()}><Icon name="plus" size={18} color="#fff" /></Pressable>
      </View>
    </View>
  );
}
function ServiceCombo({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const { t } = useLanguage();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const matches = SERVICE_CATS.filter((c) => c.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
  return (
    <View>
      <TextInput
        style={st.input}
        value={open ? q : value || ""}
        onChangeText={(txt) => { setQ(txt); setOpen(true); }}
        onFocus={() => { setQ(""); setOpen(true); }}
        placeholder={t("m.listingOnboard.serviceCombo.ph", { defaultValue: "Type to search — plumber, cook, tutor…" })}
        placeholderTextColor={T.muted}
      />
      {open && matches.length > 0 && (
        <View style={st.comboMenu}>
          {matches.map((c) => (
            <Pressable key={c} onPress={() => { onChange(c); setOpen(false); }} style={({ pressed }: any) => [st.comboItem, pressed && { backgroundColor: "rgba(58,50,71,0.06)" }]}>
              <Text style={st.comboTxt}>{c}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!on)} style={[st.switch, on && { backgroundColor: T.terra }]}>
      <View style={[st.knob, on && { transform: [{ translateX: 18 }] }]} />
    </Pressable>
  );
}
function AddOnsEditor({ items, onChange }: { items: AddOn[]; onChange: (v: AddOn[]) => void }) {
  const { t } = useLanguage();
  const [name, setName] = useState(""); const [price, setPrice] = useState("");
  const add = () => { if (!name.trim()) return; onChange([...items, { name: name.trim(), price }]); setName(""); setPrice(""); };
  return (
    <View style={{ gap: 8 }}>
      {items.map((a, i) => (
        <View key={i} style={st.listRow}>
          <Text style={st.listRowTxt}>{a.name}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={st.listRowPrice}>+₹{a.price || 0}</Text>
            <Pressable onPress={() => onChange(items.filter((_, j) => j !== i))}><Icon name="x" size={14} color={T.muted} /></Pressable>
          </View>
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[st.input, { flex: 1 }]} value={name} onChangeText={setName} placeholder={t("m.listingOnboard.addon.namePh", { defaultValue: "Add-on, e.g. Hot stone" })} placeholderTextColor={T.muted} />
        <TextInput style={[st.input, { width: 76 }]} value={price} onChangeText={(v) => setPrice(v.replace(/[^\d]/g, ""))} placeholder="₹" placeholderTextColor={T.muted} keyboardType="number-pad" />
        <Pressable style={st.addBtn} onPress={add}><Icon name="plus" size={18} color="#fff" /></Pressable>
      </View>
    </View>
  );
}
function PackageEditor({ items, onChange }: { items: Pkg[]; onChange: (v: Pkg[]) => void }) {
  const { t: tr } = useLanguage();
  const [t, setT] = useState(""); const [stops, setStops] = useState(""); const [price, setPrice] = useState("");
  const [kmMin, setKmMin] = useState(""); const [kmMax, setKmMax] = useState(""); const [hours, setHours] = useState("");
  // Editing an existing row: its id. The inputs hold the row's values and
  // the add button becomes "save" (✓), updating in place (id preserved).
  const [editId, setEditId] = useState<string | null>(null);
  const reset = () => { setT(""); setStops(""); setPrice(""); setKmMin(""); setKmMax(""); setHours(""); setEditId(null); };
  const startEdit = (p: Pkg) => { setEditId(p.id); setT(p.label); setStops(p.stops); setPrice(p.price); setKmMin(p.distanceKmMin); setKmMax(p.distanceKmMax); setHours(p.hours); };
  // Stops + km range are REQUIRED by the activation gate (each package needs
  // at least one named stop and distanceKmMin) — the add button stays
  // disabled until the row would pass.
  const valid = !!t.trim() && !!stops.trim() && Number(price) > 0 && Number(kmMin) > 0;
  const add = () => {
    if (!valid) return;
    const row = { label: t.trim(), stops: stops.trim(), price, hours: hours.trim(), distanceKmMin: kmMin.trim(), distanceKmMax: (kmMax || kmMin).trim() };
    onChange(editId
      ? items.map((x) => (x.id === editId ? { ...x, ...row } : x))
      : [...items, { id: "pkg-" + Date.now().toString(36) + "-" + (items.length + 1), ...row }]);
    reset();
  };
  return (
    <View style={{ gap: 8 }}>
      {items.map((p) => (
        <View key={p.id} style={[st.listRow, { flexDirection: "column", alignItems: "stretch", gap: 4 }, p.id === editId && { borderColor: T.terra }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={st.listRowTxt}>{p.label}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={st.listRowPrice}>₹{p.price || 0}</Text>
              <Pressable hitSlop={6} onPress={() => startEdit(p)}><Icon name="pencil" size={14} color={T.muted} /></Pressable>
              <Pressable hitSlop={6} onPress={() => { if (p.id === editId) reset(); onChange(items.filter((x) => x.id !== p.id)); }}><Icon name="x" size={14} color={T.muted} /></Pressable>
            </View>
          </View>
          <Text style={st.listRowSub}>
            {[p.stops, Number(p.distanceKmMin) > 0 ? `${p.distanceKmMin}${p.distanceKmMax && p.distanceKmMax !== p.distanceKmMin ? `–${p.distanceKmMax}` : ""} ${tr("m.listingOnboard.unit.km", { defaultValue: "km" })}` : null, Number(p.hours) > 0 ? `${p.hours} ${tr("m.listingOnboard.unit.hr", { defaultValue: "hr" })}` : null].filter(Boolean).join(" · ")}
          </Text>
        </View>
      ))}
      <TextInput style={st.input} value={t} onChangeText={setT} placeholder={tr("m.listingOnboard.pkg.namePh", { defaultValue: "Package name, e.g. Temple loop" })} placeholderTextColor={T.muted} />
      <TextInput style={st.input} value={stops} onChangeText={setStops} placeholder={tr("m.listingOnboard.pkg.stopsPh", { defaultValue: "Stops, comma-separated (Kukkuteswara, Pada Gaya…)" })} placeholderTextColor={T.muted} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[st.input, { flex: 1 }]} value={kmMin} onChangeText={(v) => setKmMin(v.replace(/[^\d]/g, ""))} placeholder={tr("m.listingOnboard.pkg.kmMinPh", { defaultValue: "Km (min)" })} placeholderTextColor={T.muted} keyboardType="number-pad" />
        <TextInput style={[st.input, { flex: 1 }]} value={kmMax} onChangeText={(v) => setKmMax(v.replace(/[^\d]/g, ""))} placeholder={tr("m.listingOnboard.pkg.kmMaxPh", { defaultValue: "Km (max)" })} placeholderTextColor={T.muted} keyboardType="number-pad" />
        <TextInput style={[st.input, { flex: 1 }]} value={hours} onChangeText={(v) => setHours(v.replace(/[^\d]/g, ""))} placeholder={tr("m.listingOnboard.pkg.hoursPh", { defaultValue: "Hours" })} placeholderTextColor={T.muted} keyboardType="number-pad" />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[st.input, { flex: 1 }]} value={price} onChangeText={(v) => setPrice(v.replace(/[^\d]/g, ""))} placeholder={tr("m.listingOnboard.pkg.pricePh", { defaultValue: "Price ₹" })} placeholderTextColor={T.muted} keyboardType="number-pad" />
        <Pressable style={[st.addBtn, !valid && { opacity: 0.45 }]} onPress={add} disabled={!valid}><Icon name={editId ? "check" : "plus"} size={18} color="#fff" /></Pressable>
      </View>
      {editId && (
        <Pressable onPress={reset} hitSlop={8} style={({ pressed }: any) => [pressed && { opacity: 0.6 }]}>
          <Text style={{ fontSize: 12, color: T.terra, fontFamily: font.bodySemi }}>{tr("m.listingOnboard.pkg.editingNote", { defaultValue: "Editing “{{label}}” — tap ✓ to save, or cancel", label: items.find((x) => x.id === editId)?.label })}</Text>
        </Pressable>
      )}
    </View>
  );
}
function RoomTypesEditor({ rooms, onChange }: { rooms: Room[]; onChange: (v: Room[]) => void }) {
  const { t } = useLanguage();
  const blank = (): Room => ({ key: "r" + rooms.length + Math.round(rooms.reduce((a, r) => a + r.name.length, 1)), name: "", price: "", maxGuests: "2", quantity: "1", bedrooms: "1", bathrooms: "1", amenities: [], description: "", photos: [], unitIdentifiers: [] });
  const [draft, setDraft] = useState<Room | null>(null);
  // Index of the row being edited, or null when adding a new one. Lets the
  // host tap an existing/AI-seeded room to fill in what chat couldn't — e.g.
  // the required per-room photo.
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const save = () => {
    if (!draft || !draft.name.trim()) return;
    onChange(editIndex == null
      ? [...rooms, draft]
      : rooms.map((r, j) => (j === editIndex ? draft : r)));
    setDraft(null);
    setEditIndex(null);
  };
  const startEdit = (i: number) => { setDraft({ ...rooms[i] }); setEditIndex(i); };
  const upd = (k: keyof Room, v: any) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  return (
    <View style={{ gap: 10 }}>
      {rooms.map((r, i) => {
        const needsPhoto = (r.photos?.length || 0) === 0;
        const needsAmenities = r.amenities.length < 3;
        return (
        <View key={r.key} style={st.roomRow}>
          <View style={{ flex: 1 }}>
            <Text style={st.listRowTxt}>{r.name}</Text>
            <Text style={st.listRowSub}>{[
              t("m.listingOnboard.room.summaryRooms", { defaultValue: "{{count}} rooms", count: Number(r.quantity) || 0 }),
              t("m.listingOnboard.room.summarySleeps", { defaultValue: "sleeps {{n}}", n: r.maxGuests }),
              t("m.listingOnboard.room.summaryBed", { defaultValue: "{{n}} bed", n: r.bedrooms }),
              t("m.listingOnboard.room.summaryBath", { defaultValue: "{{n}} bath", n: r.bathrooms }),
              ...(r.amenities.length ? [t("m.listingOnboard.room.summaryAmenities", { defaultValue: "{{count}} amenities", count: r.amenities.length })] : []),
            ].join(" · ")}</Text>
            {(needsPhoto || needsAmenities) && (
              <Text style={[st.listRowSub, { color: T.coral }]}>
                {t("m.listingOnboard.room.editToAdd", { defaultValue: "Edit to add {{items}}", items: [needsPhoto ? t("m.listingOnboard.room.needsPhoto", { defaultValue: "a photo" }) : null, needsAmenities ? t("m.listingOnboard.room.needsAmenities", { defaultValue: "3+ amenities" }) : null].filter(Boolean).join(" + ") })}
              </Text>
            )}
          </View>
          <Text style={st.listRowPrice}>₹{r.price || 0}</Text>
          <Pressable hitSlop={8} onPress={() => startEdit(i)}><Icon name="pencil" size={15} color={T.terra} /></Pressable>
          <Pressable hitSlop={8} onPress={() => onChange(rooms.filter((_, j) => j !== i))}><Icon name="x" size={15} color={T.muted} /></Pressable>
        </View>
        );
      })}
      {draft ? (
        <View style={st.roomEditor}>
          <TextInput style={st.input} value={draft.name} onChangeText={(v) => upd("name", v)} placeholder={t("m.listingOnboard.room.namePh", { defaultValue: "Room type, e.g. Deluxe King" })} placeholderTextColor={T.muted} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}><Text style={st.mini}>{t("m.listingOnboard.room.perNight", { defaultValue: "₹/night" })}</Text><TField value={draft.price} onChangeText={(v: string) => upd("price", v)} numeric placeholder="0" /></View>
            <View style={{ flex: 1 }}><Text style={st.mini}>{t("m.listingOnboard.room.sleeps", { defaultValue: "Sleeps" })}</Text><TField value={draft.maxGuests} onChangeText={(v: string) => upd("maxGuests", v)} numeric placeholder="2" /></View>
            <View style={{ flex: 1 }}><Text style={st.mini}>{t("m.listingOnboard.room.rooms", { defaultValue: "Rooms" })}</Text><TField value={draft.quantity} onChangeText={(v: string) => upd("quantity", v)} numeric placeholder="1" /></View>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}><Text style={st.mini}>{t("m.listingOnboard.room.bedrooms", { defaultValue: "Bedrooms" })}</Text><TField value={draft.bedrooms} onChangeText={(v: string) => upd("bedrooms", v)} numeric placeholder="1" /></View>
            <View style={{ flex: 1 }}><Text style={st.mini}>{t("m.listingOnboard.room.bathrooms", { defaultValue: "Bathrooms" })}</Text><TField value={draft.bathrooms} onChangeText={(v: string) => upd("bathrooms", v)} numeric placeholder="1" /></View>
          </View>
          <Text style={st.mini}>{t("m.listingOnboard.room.unitIds", { defaultValue: "Room numbers / IDs (optional)" })}</Text>
          <ChipListAdd items={draft.unitIdentifiers} onChange={(v) => upd("unitIdentifiers", v)} placeholder={t("m.listingOnboard.room.unitIdsPh", { defaultValue: "e.g. 101, 8a, Tulip" })} />
          <Text style={[st.mini, { marginTop: 4 }]}>{t("m.listingOnboard.room.amenities", { defaultValue: "Room amenities" })}</Text>
          <ChipListAdd items={draft.amenities} onChange={(v) => upd("amenities", v)} presets={STAY_AMENITIES} placeholder={t("m.listingOnboard.property.amenitiesPh", { defaultValue: "Add another (e.g. rooftop terrace)" })} />
          <Text style={[st.mini, { marginTop: 4 }]}>{t("m.listingOnboard.room.description", { defaultValue: "Description" })}</Text>
          <TextInput style={[st.textarea, { minHeight: 70 }]} multiline value={draft.description} onChangeText={(v) => upd("description", v)} placeholder={t("m.listingOnboard.room.descriptionPh", { defaultValue: "What's special about this room — view, size, bedding…" })} placeholderTextColor={T.muted} />
          <Text style={[st.mini, { marginTop: 4 }]}>{t("m.listingOnboard.room.photos", { defaultValue: "Room photos" })}</Text>
          <PhotoGrid photos={draft.photos} onChange={(v) => upd("photos", v)} />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
            <Pressable style={[st.ghostMini, { flex: 1 }]} onPress={() => { setDraft(null); setEditIndex(null); }}><Text style={st.ghostMiniTxt}>{t("m.listingOnboard.room.cancel", { defaultValue: "Cancel" })}</Text></Pressable>
            <Pressable style={[st.addRoomBtn, { flex: 1 }]} onPress={save}><Text style={st.addRoomTxt}>{editIndex == null ? t("m.listingOnboard.room.add", { defaultValue: "Add room" }) : t("m.listingOnboard.room.save", { defaultValue: "Save room" })}</Text></Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={st.addRoomDashed} onPress={() => setDraft(blank())}><Icon name="plus" size={16} color={T.terra} /><Text style={st.addRoomDashedTxt}>{t("m.listingOnboard.room.addType", { defaultValue: "Add a room type" })}</Text></Pressable>
      )}
    </View>
  );
}
function PhotoGrid({ photos, onChange }: { photos: string[]; onChange: (v: string[]) => void }) {
  const { t } = useLanguage();
  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6, allowsMultipleSelection: true });
    if (!res.canceled) onChange([...photos, ...res.assets.map((a) => a.uri)]);
  };
  return (
    <View style={st.photoGrid}>
      {photos.map((uri, i) => (
        <View key={i} style={st.photo}>
          <Image source={{ uri }} style={StyleSheet.absoluteFill as any} />
          <Pressable style={st.photoX} onPress={() => onChange(photos.filter((_, j) => j !== i))}><Icon name="x" size={12} color="#fff" /></Pressable>
        </View>
      ))}
      <Pressable style={st.photoAdd} onPress={pick}><Icon name="camera" size={22} color={T.terra} /><Text style={st.photoAddTxt}>{t("m.listingOnboard.photoAdd", { defaultValue: "Add" })}</Text></Pressable>
    </View>
  );
}
function WorkingHours({ hours, onChange }: { hours: Record<string, [string, string] | null>; onChange: (v: any) => void }) {
  const { t } = useLanguage();
  const toggle = (d: string) => onChange({ ...hours, [d]: hours[d] ? null : ["09:00", "19:00"] });
  const setTime = (d: string, idx: 0 | 1, v: string) => { const cur = hours[d] || ["09:00", "19:00"]; const nxt = [...cur] as [string, string]; nxt[idx] = v; onChange({ ...hours, [d]: nxt }); };
  return (
    <View style={{ gap: 8 }}>
      {DAYS.map(([d, lb]) => {
        const open = !!hours[d];
        return (
          <View key={d} style={st.whRow}>
            <Pressable onPress={() => toggle(d)} style={{ flexDirection: "row", alignItems: "center", gap: 8, width: 86 }}>
              <View style={[st.whCheck, open && { backgroundColor: T.aubergine, borderColor: T.aubergine }]}>{open && <Icon name="checkSm" size={12} color="#fff" strokeWidth={2.6} />}</View>
              <Text style={st.whDay}>{t(`m.listingOnboard.day.${d}`, { defaultValue: lb })}</Text>
            </Pressable>
            {open ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                <TextInput style={[st.input, { flex: 1, minHeight: 40 }]} value={(hours[d] as [string, string])[0]} onChangeText={(v) => setTime(d, 0, v)} placeholder="09:00" placeholderTextColor={T.muted} />
                <Text style={{ color: T.muted }}>–</Text>
                <TextInput style={[st.input, { flex: 1, minHeight: 40 }]} value={(hours[d] as [string, string])[1]} onChangeText={(v) => setTime(d, 1, v)} placeholder="19:00" placeholderTextColor={T.muted} />
              </View>
            ) : (
              <Text style={[st.listRowSub, { flex: 1 }]}>{t("m.listingOnboard.closed", { defaultValue: "Closed" })}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

/* ---------- duration parsing + slot generation ----------
   Mirrors the web's _durationToMinutes (src/components/EditListingModal.tsx):
   a BARE number is interpreted as HOURS (×60), not minutes — so "1" = 60 min,
   matching how the listing detail renders "1 hr". Also handles half/full day. */
export function parseDurationMin(s?: string): number | null {
  if (!s || !s.trim()) return null;
  const v = s.toLowerCase().trim();
  if (v.includes("half day")) return 240;
  if (v.includes("full day")) return 480;
  const hours = v.match(/(\d+(?:\.\d+)?)\s*(?:hr|hrs|hour|hours|h\b)/);
  const mins = v.match(/(\d+)\s*(?:min|mins|minute|minutes|m\b)/);
  let total = 0;
  if (hours) total += Math.round(parseFloat(hours[1]) * 60);
  if (mins) total += parseInt(mins[1], 10);
  if (!total) { const just = v.match(/^(\d+(?:\.\d+)?)/); if (just) total = Math.round(parseFloat(just[1]) * 60); }
  return total > 0 ? total : null;
}
const hasOpenDay = (wh: Record<string, any>) => Object.values(wh || {}).some((v) => Array.isArray(v));
const toMin = (hhmm: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmtSlot = (mins: number) => { const h = Math.floor(mins / 60), m = mins % 60, ap = h >= 12 ? "PM" : "AM", h12 = ((h + 11) % 12) + 1; return m === 0 ? `${h12}:00 ${ap}` : `${h12}:${String(m).padStart(2, "0")} ${ap}`; };
function genSlots(wh: Record<string, any>, durationMin: number, bufferMin: number): string[] {
  const out: string[] = [];
  const step = durationMin + bufferMin;
  for (const [day, lbl] of DAYS) {
    const w = wh?.[day];
    if (!Array.isArray(w)) continue;
    const s = toMin(w[0]), e = toMin(w[1]);
    if (s == null || e == null) continue;
    for (let t = s; t + durationMin <= e; t += step) out.push(`${lbl} ${fmtSlot(t)}`);
  }
  return out;
}

type SvcGroup = { id: string; name: string; basePrice: string; addOns: AddOn[] };

function ServicesCatalogEditor({ items, onChange }: { items: SvcGroup[]; onChange: (v: SvcGroup[]) => void }) {
  const { t } = useLanguage();
  const upd = (i: number, patch: Partial<SvcGroup>) => onChange(items.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const remove = (i: number) => onChange(items.filter((_, j) => j !== i));
  const add = () => onChange([...items, { id: "g" + items.length + items.reduce((a, g) => a + g.name.length, 0), name: "", basePrice: "", addOns: [] }]);
  return (
    <View style={{ gap: 12 }}>
      {items.map((g, i) => (
        <View key={g.id} style={st.catalogCard}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput style={[st.input, { flex: 1 }]} value={g.name} onChangeText={(v) => upd(i, { name: v })} placeholder={t("m.listingOnboard.catalog.namePh", { defaultValue: "Service name (e.g. Men's haircut)" })} placeholderTextColor={T.muted} />
            <View style={[st.mfPrefix, { width: 116 }]}>
              <Text style={st.mfRupee}>₹</Text>
              <TextInput style={st.mfInput} value={g.basePrice} onChangeText={(v) => upd(i, { basePrice: v.replace(/[^\d]/g, "") })} placeholder={t("m.listingOnboard.catalog.basePricePh", { defaultValue: "Base price" })} placeholderTextColor={T.muted} keyboardType="number-pad" />
            </View>
            {items.length > 1 && <Pressable onPress={() => remove(i)} hitSlop={8}><Icon name="x" size={18} color={T.muted} /></Pressable>}
          </View>
          <View style={st.addonBox}>
            <Text style={st.addonHint}>{t("m.listingOnboard.catalog.addonHint", { defaultValue: "Add-ons — extras priced on top (optional)." })}</Text>
            <AddOnsEditor items={g.addOns} onChange={(v) => upd(i, { addOns: v })} />
          </View>
        </View>
      ))}
      <Pressable style={st.addAnother} onPress={add}>
        <Icon name="plus" size={16} color={T.terra} />
        <Text style={st.addAnotherTxt}>{t("m.listingOnboard.catalog.addAnother", { defaultValue: "Add another service" })}</Text>
      </Pressable>
    </View>
  );
}

function SlotsPreview({ wh, duration, buffer }: { wh: Record<string, any>; duration?: string; buffer: number }) {
  const { t } = useLanguage();
  const durMin = parseDurationMin(duration);
  const slots = durMin && durMin > 0 ? genSlots(wh, durMin, Number(buffer) || 0) : [];
  return (
    <View style={st.slotsBox}>
      <Text style={st.slotsTitle}>{t("m.listingOnboard.slots.title", { defaultValue: "Bookable time slots" })}</Text>
      {slots.length ? (
        <>
          <Text style={st.fieldHint}>{t("m.listingOnboard.slots.autoGen", { defaultValue: "Auto-generated from your hours and a {{min}}-minute job duration.", min: durMin })}</Text>
          <View style={[st.chipWrap, { marginTop: 8 }]}>
            {slots.slice(0, 6).map((sl, i) => <View key={i} style={st.slotChip}><Text style={st.slotChipTxt}>{sl}</Text></View>)}
            {slots.length > 6 && <View style={st.slotChipMuted}><Text style={st.slotChipMutedTxt}>{t("m.listingOnboard.slots.more", { defaultValue: "+{{count}} more", count: slots.length - 6 })}</Text></View>}
          </View>
        </>
      ) : (
        <Text style={st.fieldHint}>{t("m.listingOnboard.slots.empty", { defaultValue: "Set your hours and appointment duration to preview bookable slots." })}</Text>
      )}
    </View>
  );
}

/* ---------------- main ---------------- */
const META: Record<EntryType, { word: string; icon: string; tone: Tone }> = {
  stay: { word: "property", icon: "bedDouble", tone: "saffron" },
  service: { word: "service", icon: "flower", tone: "coral" },
  transport: { word: "vehicle", icon: "car", tone: "blue" },
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------- AI onboarding (conversational, mirrors web /api/onboarding-chat) ---------------- */
function AiOnboarding({
  entryType, word, profile, mergeProfile, messages, setMessages, goToForm,
}: {
  entryType: EntryType;
  word: string;
  profile: any;
  mergeProfile: (u: Record<string, any>) => void;
  // Lifted to the parent so the conversation persists when the user toggles
  // between AI and the manual form (until they leave onboarding entirely).
  messages: OnboardMsg[];
  setMessages: React.Dispatch<React.SetStateAction<OnboardMsg[]>>;
  // Switches the onboarding view to the manual form — used for photos (which
  // can't be added in chat) and when the agent marks the listing ready to
  // review. The agent can't upload images, so all photos live in the form.
  goToForm: () => void;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const greet = t("m.listingOnboard.ai.greet", { defaultValue: "Namaskaram! 🙏 Tell me about your {{word}} in your own words — what it is, where it's based, and your rate — and I'll fill in the listing for you. You can review and tweak everything before publishing.", word });
  // Seed the greeting on first entry only (parent keeps the array across switches).
  useEffect(() => { if (messages.length === 0) setMessages([{ role: "assistant", content: greet }]); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Shown when the agent requests photos — taps through to the manual form,
  // where the photo uploaders (listing + per-room) live.
  const [showPhotoCta, setShowPhotoCta] = useState(false);
  const sessionId = useRef(`onb_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`).current;
  const scrollRef = useRef<ScrollView>(null);
  // On (re)entering the AI view, jump to the latest message. The parent keeps
  // `messages` across form↔AI switches, so a returning user would otherwise
  // land at the top of a long conversation. Instant (no animation) on mount.
  useEffect(() => {
    if (messages.length === 0) return;
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 60);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Voice: mic dictation fills the input; the speaker toggle reads replies
  // aloud — same pattern as the Ista AI client assistant (AiChatScreen).
  // Single voice affordance (mic): tapping it lets you talk; the reply for that
  // voice turn is then read aloud. Mirrors the web — no separate speaker button.
  const [speakOn, setSpeakOn] = useState(false);
  const dict = useDictation((text) => setDraft(text));
  useEffect(() => () => stopSpeaking(), []);
  const voiceActive = dict.listening || speakOn;
  const micPress = () => {
    if (dict.listening) { dict.stop(); return; }
    stopSpeaking();
    setSpeakOn(true); // this turn's reply will be spoken
    dict.start();
  };

  const STARTERS: Record<EntryType, string[]> = {
    stay: [
      t("m.listingOnboard.ai.starter.stay0", { defaultValue: "I run a 3-bedroom homestay in Hyderabad" }),
      t("m.listingOnboard.ai.starter.stay1", { defaultValue: "Lakeview farm stay, ₹2500/night" }),
      t("m.listingOnboard.ai.starter.stay2", { defaultValue: "Heritage haveli near the old city" }),
    ],
    service: [
      t("m.listingOnboard.ai.starter.service0", { defaultValue: "I'm a plumber with 8 years experience" }),
      t("m.listingOnboard.ai.starter.service1", { defaultValue: "Salon at home — haircut & beard" }),
      t("m.listingOnboard.ai.starter.service2", { defaultValue: "Home AC repair, same-day" }),
    ],
    transport: [
      t("m.listingOnboard.ai.starter.transport0", { defaultValue: "Sedan cab for airport runs" }),
      t("m.listingOnboard.ai.starter.transport1", { defaultValue: "Day rentals in my Innova" }),
      t("m.listingOnboard.ai.starter.transport2", { defaultValue: "Temple day-tour packages" }),
    ],
  };

  const send = async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!text || sending) return;
    if (dict.listening) dict.stop();
    const next: OnboardMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    setSending(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    try {
      const reply = await sendOnboardingChat({
        messages: next.filter((m) => m.role !== "system"),
        profile,
        entryType: entryFor(entryType),
        sessionId,
      });
      const msg = reply.message || t("m.listingOnboard.ai.gotIt", { defaultValue: "Got it." });
      setMessages((m) => [...m, { role: "assistant", content: msg }]);
      if (reply.profileUpdates && Object.keys(reply.profileUpdates).length) mergeProfile(reply.profileUpdates);
      if (speakOn) { speak(stripChatMarkdown(msg)); setSpeakOn(false); } // speak this voice turn, then reset
      // Show the "add photos in the form" affordance whenever it's photo
      // time. The agent SHOULD emit the 'photo_upload' picker action, but it
      // often just mentions photos in text without calling the tool — so we
      // also trigger on the reply text. Photos can't be added in chat (the
      // agent can't upload or see them); this button is the reliable path to
      // the form's uploaders, so the agent's "tap the photo button" lands.
      setShowPhotoCta(reply.action === "photo_upload" || /\bphotos?\b/i.test(msg));
      // is_complete means submit_listing passed the required-field gate and
      // the listing is ready to review. The actual create + photo upload
      // happen in the form/preview, so open the form (matches the agent's
      // "opening the review" line — previously this signal was dropped and
      // nothing happened).
      if (reply.isComplete) goToForm();
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: t("m.listingOnboard.ai.errorMsg", { defaultValue: "Sorry — I couldn't reach the assistant just now. You can switch to the form and fill it in manually." }) }]);
    } finally {
      setSending(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    }
  };

  const captured: [string, string][] = [];
  if (profile.name) captured.push([t("m.listingOnboard.ai.cap.name", { defaultValue: "Name" }), profile.name]);
  const typeVal = profile.propertyType || profile.category || profile.vehicleType;
  if (typeVal) captured.push([t("m.listingOnboard.ai.cap.type", { defaultValue: "Type" }), typeVal]);
  if (profile.location) captured.push([t("m.listingOnboard.ai.cap.where", { defaultValue: "Where" }), profile.location]);
  if (profile.experience) captured.push([t("m.listingOnboard.ai.cap.experience", { defaultValue: "Experience" }), profile.experience]);
  if (Array.isArray(profile.rooms) && profile.rooms.length) {
    captured.push([t("m.listingOnboard.ai.cap.rooms", { defaultValue: "Rooms" }), t("m.listingOnboard.ai.cap.roomTypes", { defaultValue: "{{count}} types", count: profile.rooms.length })]);
  } else if (profile.price) {
    captured.push([t("m.listingOnboard.ai.cap.price", { defaultValue: "Price" }), `₹${profile.price}`]);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={ai.head}>
        <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ai.headAvatar}><Icon name="bot" size={18} color="#fff" /></LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={ai.headName}>Ista AI</Text>
          <Text style={ai.headSub}>{sending ? t("m.listingOnboard.ai.typing", { defaultValue: "Typing…" }) : dict.listening ? t("m.listingOnboard.ai.listening", { defaultValue: "Listening…" }) : speakOn ? t("m.listingOnboard.ai.voiceOn", { defaultValue: "Voice on · tap mic to talk" }) : t("m.listingOnboard.ai.listingAssistant", { defaultValue: "Listing assistant" })}</Text>
        </View>
        {voiceActive && <View style={ai.voiceDot} />}
      </View>
      {captured.length > 0 && (
        <View style={ai.capStrip}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            {captured.map(([k, v]) => (
              <View key={k} style={ai.capChip}>
                <Icon name="checkSm" size={12} color="#2f7d55" strokeWidth={2.6} />
                <Text style={ai.capTxt} numberOfLines={1}>{k}: <Text style={{ fontFamily: font.bodyHeavy, color: T.ink }}>{String(v)}</Text></Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 16, paddingBottom: 20, gap: 12 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {messages.map((m, i) => (
          <View key={i} style={[ai.row, m.role === "user" ? { justifyContent: "flex-end" } : { justifyContent: "flex-start" }]}>
            {m.role === "assistant" && (
              <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ai.avatar}><Icon name="bot" size={15} color="#fff" /></LinearGradient>
            )}
            <View style={[ai.bubble, m.role === "user" ? ai.bubbleUser : ai.bubbleBot]}>
              {m.role === "user"
                ? <Text style={[ai.bubbleTxt, { color: "#fff" }]}>{m.content}</Text>
                : <ChatText text={m.content} style={ai.bubbleTxt} />}
            </View>
          </View>
        ))}
        {sending && (
          <View style={[ai.row, { justifyContent: "flex-start" }]}>
            <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ai.avatar}><Icon name="bot" size={15} color="#fff" /></LinearGradient>
            <View style={[ai.bubble, ai.bubbleBot, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
              <ActivityIndicator size="small" color={T.muted} />
              <Text style={[ai.bubbleTxt, { color: T.muted }]}>{t("m.listingOnboard.ai.thinking", { defaultValue: "Thinking…" })}</Text>
            </View>
          </View>
        )}
        {messages.length === 1 && !sending && (
          <View style={ai.starters}>
            {STARTERS[entryType].map((sgg) => (
              <Pressable key={sgg} onPress={() => send(sgg)} style={({ pressed }) => [ai.starter, pressed && { opacity: 0.8 }]}>
                <Icon name="sparkle" size={13} color={T.terra} />
                <Text style={ai.starterTxt}>{sgg}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {showPhotoCta && !sending && (
          <Pressable onPress={goToForm} style={({ pressed }) => [ai.photoCta, pressed && { opacity: 0.85 }]}>
            <Icon name="camera" size={17} color={T.terra} />
            <Text style={ai.photoCtaTxt}>{t("m.listingOnboard.ai.addPhotosCta", { defaultValue: "Add photos in the form" })}</Text>
            <Icon name="chevR" size={16} color={T.terra} />
          </Pressable>
        )}
      </ScrollView>

      <View style={[ai.composer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={ai.field}>
          <Icon name="sparkle" size={18} color={T.terra} />
          <TextInput
            style={ai.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={dict.listening ? t("m.listingOnboard.ai.listening", { defaultValue: "Listening…" }) : t("m.listingOnboard.ai.composerPh", { defaultValue: "Describe your {{word}}…", word })}
            placeholderTextColor={T.muted}
            onSubmitEditing={() => send()}
            returnKeyType="send"
          />
        </View>
        {sttAvailable && (
          <Pressable onPress={micPress} style={[ai.micBtn, dict.listening && ai.micBtnOn]}>
            <Icon name={dict.listening ? "micOff" : "mic"} size={20} color={dict.listening ? "#fff" : T.aubergine} />
          </Pressable>
        )}
        <Pressable onPress={() => send()}>
          <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ai.sendBtn}>
            <Icon name="send" size={20} color="#fff" />
          </LinearGradient>
        </Pressable>
      </View>
    </View>
  );
}

const ai = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: "rgba(58,50,71,0.08)" },
  headAvatar: { width: 38, height: 38, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  headName: { fontSize: 15, fontFamily: font.bodyHeavy, color: T.ink },
  headSub: { fontSize: 12, fontFamily: font.body, color: T.muted, marginTop: 1 },
  voiceDot: { width: 9, height: 9, borderRadius: 999, backgroundColor: T.coral },
  starters: { gap: 8, marginTop: 4, marginLeft: 36 },
  starter: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", paddingVertical: 9, paddingHorizontal: 13, borderRadius: 14, borderWidth: 1, borderColor: "rgba(139,94,74,0.3)", backgroundColor: "rgba(255,255,255,0.85)" },
  starterTxt: { fontSize: 13, fontFamily: font.bodyBold, color: T.ink },
  photoCta: { flexDirection: "row", alignItems: "center", gap: 9, alignSelf: "flex-start", marginLeft: 36, paddingVertical: 11, paddingHorizontal: 15, borderRadius: 14, borderWidth: 1, borderColor: "rgba(139,94,74,0.4)", backgroundColor: "rgba(139,94,74,0.08)" },
  photoCtaTxt: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.terra },
  capStrip: { paddingVertical: 10, borderBottomWidth: 1, borderColor: "rgba(58,50,71,0.08)" },
  capChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, backgroundColor: "rgba(67,140,99,0.1)", maxWidth: 240 },
  capTxt: { fontSize: 12, fontFamily: font.body, color: T.muted },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  avatar: { width: 28, height: 28, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  bubble: { maxWidth: "80%", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18 },
  bubbleBot: { backgroundColor: "rgba(255,255,255,0.92)", borderWidth: 1, borderColor: "rgba(58,50,71,0.08)", borderBottomLeftRadius: 6 },
  bubbleUser: { backgroundColor: T.aubergine, borderBottomRightRadius: 6 },
  bubbleTxt: { fontSize: 14, lineHeight: 20, fontFamily: font.body, color: T.ink },
  // Composer — same layout/spacing as the client assistant (AiChatScreen).
  composer: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  field: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.85)" },
  input: { flex: 1, fontFamily: font.body, fontSize: 15, color: T.ink, paddingVertical: 0, ...noOutline },
  sendBtn: { width: 48, height: 48, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  micBtn: { width: 48, height: 48, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.7)", backgroundColor: "rgba(255,255,255,0.7)" },
  micBtnOn: { backgroundColor: T.coral, borderColor: T.coral },
});

export function ListingOnboarding({
  entryType,
  editing,
  initialForm,
  resumeDraft,
  onClose,
  onPublish,
  onManageRooms,
  photoTargetUserId,
}: {
  entryType: EntryType;
  editing?: boolean;
  initialForm?: Record<string, any>;
  /** Create mode only: a saved draft (from the dashboard's "Continue
   *  onboarding" row) to resume — seeds form state, the AI conversation,
   *  and reopens the view the host left from, skipping the chooser. */
  resumeDraft?: OnboardingDraftEnvelope;
  onClose: () => void;
  onPublish: (l: DraftListing, formState?: any) => void;
  // Edit mode only: rooms are a separate resource managed in the live Room
  // types manager (mirrors the web). Opening it is delegated to the parent.
  onManageRooms?: () => void;
  /** Admin assisted-onboarding: upload photos into THIS user's path (via the
   *  role-gated cross-user header) instead of the admin's own. */
  photoTargetUserId?: string;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const meta = META[entryType];
  // Translated noun for the entry type ("property"/"service"/"vehicle"), used
  // throughout the headers/CTA copy. wordCap is the capitalised variant.
  const word = t(`m.listingOnboard.word.${entryType}`, { defaultValue: meta.word });
  const wordCap = t(`m.listingOnboard.wordCap.${entryType}`, { defaultValue: cap(meta.word) });
  const host = entryType === "stay", service = entryType === "service", transport = entryType === "transport";
  const [view, setView] = useState<"chooser" | "ai" | "form" | "preview" | "success">(
    editing ? "form" : resumeDraft ? resumeDraft.view : "chooser",
  );

  // On edit, `initialForm` is the existing listing reverse-mapped to form state
  // (see listingToForm in api/dash.ts), merged over the create-mode defaults so
  // a full PATCH doesn't wipe fields the host didn't re-enter.
  const [p, setP] = useState<any>({
    name: "", location: "", price: "",
    serviceModes: [], transportModes: [], languages: [], amenities: [], subcategories: [], rooms: [],
    packageOptions: [], photos: [], workingHours: {} as Record<string, any>,
    bedrooms: "", bathrooms: "", maxGuests: "", checkInTime: "", checkOutTime: "",
    vehicleColor: "", licensePlate: "",
    pricingUnit: "", duration: "", experience: "", description: "", bufferMinutes: 15,
    servicesCatalog: [{ id: "g0", name: "", basePrice: "", addOns: [] }] as SvcGroup[],
    ...(initialForm || {}),
    ...(!editing && resumeDraft ? resumeDraft.form : {}),
  });
  const set = (k: string, v: any) => setP((q: any) => ({ ...q, [k]: v }));
  const toggle = (k: string, v: string) => setP((q: any) => ({ ...q, [k]: (q[k] || []).includes(v) ? q[k].filter((x: string) => x !== v) : [...(q[k] || []), v] }));

  // Opt-in "enhance with AI" for the description — mirrors the web form.
  const [enhancingDesc, setEnhancingDesc] = useState(false);
  const enhanceDescription = async () => {
    const current = (p.description ?? "").trim();
    if (enhancingDesc || !current) return;
    setEnhancingDesc(true);
    try {
      const enhanced = (await enhanceOnboardingDescription({ description: current, profile: p })).trim();
      if (enhanced && enhanced !== current) {
        set("description", enhanced);
        toast.success(t("m.listingOnboard.story.descEnhanced", { defaultValue: "Description polished — edit it however you like." }));
      } else {
        toast.info(t("m.listingOnboard.story.descEnhanceNoChange", { defaultValue: "That already reads well — no changes made." }));
      }
    } catch {
      toast.error(t("m.listingOnboard.story.descEnhanceFailed", { defaultValue: "Couldn't enhance just now. Please try again." }));
    } finally {
      setEnhancingDesc(false);
    }
  };
  // AI conversation lives here (not in AiOnboarding) so it survives toggling to
  // the manual form and back — only a full exit of onboarding clears it.
  const [aiMessages, setAiMessages] = useState<OnboardMsg[]>(
    !editing && resumeDraft ? resumeDraft.aiMessages : [],
  );

  // ── Draft persistence (create mode only — edits always load the live row).
  // Mirrors the web flow: an explicit "Save draft" button (top-right) writes
  // the snapshot to AsyncStorage keyed by user + entryType and exits; the
  // dashboard's listings tab surfaces it as a non-activatable Draft row with
  // "Continue onboarding" / delete. Publishing clears the draft.
  const { user } = useAuth();

  // Seed the listing name from the signed-in account (create mode only), if
  // it's still empty. Keeps `name` pre-filled so the host doesn't re-type
  // their own name and the AI never asks for it; edits keep the existing
  // listing's name, and a resumed draft's name (already in `p`) is left
  // alone by the empty-check.
  useEffect(() => {
    if (editing || !user?.name) return;
    setP((q: any) => (q.name && String(q.name).trim() ? q : { ...q, name: user.name }));
  }, [editing, user?.name]);

  // ── Review gate: upload (and thereby NSFW-moderate) the photos when the
  // host taps Review, not at Publish. Passing photos are swapped in-place for
  // their CDN urls (uploadToStorage passes https urls through untouched, so
  // Publish's re-upload is a no-op); rejected ones are removed with the
  // server's message and the host stays on the form to pick replacements.
  const [reviewChecking, setReviewChecking] = useState(false);
  const goToReview = async () => {
    if (reviewChecking) return;
    const uris: string[] = Array.isArray(p.photos) ? p.photos : [];
    if (!user?.id || uris.length === 0) { setView("preview"); return; }
    setReviewChecking(true);
    try {
      const kept: string[] = [];
      const rejections: string[] = [];
      for (const uri of uris) {
        try {
          kept.push(await uploadToStorage({ userId: user.id, uri, bucket: "listing-images", keyPrefix: "listings", adminTargetUserId: photoTargetUserId }));
        } catch (e: any) {
          if (e?.code === "IMAGE_CONTENT_REJECTED") {
            rejections.push(e?.message || t("m.listingOnboard.photoRejected", { defaultValue: "A photo was rejected by content moderation." }));
          } else {
            throw e;
          }
        }
      }
      set("photos", kept);
      if (rejections.length > 0) {
        toast.error(`${rejections[0]} ${t("m.listingOnboard.photoRejectedPickAgain", { defaultValue: "{{count}} photo(s) removed — add different photos, then review again.", count: rejections.length })}`);
        return;
      }
      setView("preview");
    } catch (e: any) {
      toast.error(e?.message || t("m.listingOnboard.photoCheckFailed", { defaultValue: "Couldn't check your photos just now. Please try again." }));
    } finally {
      setReviewChecking(false);
    }
  };

  const saveDraft = async () => {
    const draftView: OnboardingDraftView = view === "ai" ? "ai" : "form";
    await saveOnboardingDraft(user?.id, entryType, p, aiMessages, draftView);
    toast.success(t("m.listingOnboard.draftSavedToast", { defaultValue: "Draft saved — continue anytime from your listings." }));
    onClose();
  };

  // Autofill the address from device GPS (mirrors the web "Use current" button),
  // also stashing lat/lng so the listing pins on the map.
  const [locating, setLocating] = useState(false);
  const useMyLocation = async () => {
    if (locating) return;
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(t("m.listingOnboard.locOffTitle", { defaultValue: "Location off" }), t("m.listingOnboard.locOffMsg", { defaultValue: "Allow location access to autofill your address." }));
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const [g] = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      const parts = g ? [g.name, g.street, g.city || g.subregion, g.region, g.postalCode].filter(Boolean) : [];
      setP((q: any) => ({
        ...q,
        location: parts.length ? parts.join(", ") : `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      }));
    } catch {
      Alert.alert(t("m.listingOnboard.locFailTitle", { defaultValue: "Couldn't get location" }), t("m.listingOnboard.locFailMsg", { defaultValue: "Please type your address instead." }));
    } finally {
      setLocating(false);
    }
  };

  const multiRoom = host && MULTI_ROOM.has(p.propertyType);

  // validation — mirrors web field-registry.shared.ts + onboarding-validation.ts
  const onlineOnly = service && p.serviceModes.length > 0 && p.serviceModes.every((m: string) => m === "online");
  const miss = new Set<string>();
  if (!p.name?.trim()) miss.add("name");
  if (!p.description?.trim()) miss.add("description"); // required for all types (web)
  if ((p.photos?.length || 0) < 5) miss.add("photos (5+)"); // web onboarding-validation: min 5 photos
  if (host) {
    if (!p.propertyType) miss.add("type");
    if (!p.location?.trim()) miss.add("location");
    if (multiRoom) {
      // Create only — in edit mode rooms are a separate resource managed in
      // the live Room types manager, so the listing form doesn't gate on them.
      if (!editing) {
        const rooms = p.rooms as Room[];
        const valid = rooms.filter((r) => r.name.trim() && Number(r.price) > 0);
        if (!rooms.length || valid.length !== rooms.length) miss.add("room types");
        // Per-room bar — matches the edit-mode Room types manager:
        // 3+ amenities, max guests, room count, and 1+ photo each.
        const every = (fn: (r: Room) => boolean) => rooms.length > 0 && rooms.every(fn);
        if (!every((r) => r.amenities.length >= 3)) miss.add("room amenities (3+)");
        if (!every((r) => Number(r.maxGuests) >= 1)) miss.add("room max guests");
        if (!every((r) => Number(r.quantity) >= 1)) miss.add("rooms per type");
        if (!every((r) => (r.photos?.length || 0) >= 1)) miss.add("room photos (1+ each)");
      }
    } else {
      if (!p.price) miss.add("price"); if (!p.bedrooms) miss.add("bedrooms"); if (!p.maxGuests) miss.add("max guests");
      if ((p.amenities?.length || 0) < 5) miss.add("amenities (5+)");
    }
    if (!p.checkInTime) miss.add("check-in"); if (!p.checkOutTime) miss.add("check-out");
  }
  if (service) {
    if (!p.category) miss.add("category");
    if (!onlineOnly && !p.location?.trim()) miss.add("location");
    if (!p.experience?.trim()) miss.add("experience");
    const durMin = parseDurationMin(p.duration);
    if (!p.duration?.trim() || durMin == null || durMin <= 0 || durMin > 1440) miss.add("appointment duration");
    if (!p.pricingUnit) miss.add("pricing unit");
    if (!p.serviceModes.length) miss.add("delivery mode");
    if (!p.languages.length) miss.add("languages");
    if (p.serviceModes.includes("at-home") && !p.serviceRadius) miss.add("service radius");
    if (p.serviceModes.includes("visit-provider") && !p.visitAddress?.trim()) miss.add("visit address");
    if (p.serviceModes.includes("online") && !p.meetingDetails?.trim()) miss.add("online details");
    if (!(p.servicesCatalog as SvcGroup[]).some((g) => g.name.trim() && Number(g.basePrice) > 0)) miss.add("services catalog");
    if (!hasOpenDay(p.workingHours)) miss.add("working hours");
  }
  if (transport) {
    if (!p.vehicleType) miss.add("vehicle type");
    if (!p.location?.trim()) miss.add("location");
    // Model, colour, and plate are required for EVERY transport listing —
    // riders see them in the booking summary to spot the car (autos included:
    // an auto still has a make like "Bajaj RE", a colour, and a plate).
    if (!p.vehicleName?.trim()) miss.add("model");
    if (!p.vehicleColor?.trim()) miss.add("vehicle colour");
    if (!p.licensePlate?.trim()) miss.add("number plate");
    if (!p.seatingCapacity || Number(p.seatingCapacity) <= 0) miss.add("seating capacity");
    if (!p.experience?.trim()) miss.add("experience");
    if (!p.languages.length) miss.add("languages");
    if (!p.serviceRadius) miss.add("service radius");
    if (!p.transportModes.length) miss.add("booking types");
    if (p.transportModes.includes("hourly") && !p.pricePerHour) miss.add("hourly rate");
    if (p.transportModes.includes("day") && !p.pricePerDay) miss.add("day rate");
    if (p.transportModes.includes("package")) {
      // Mirror the activation gate: every package row needs a label, a
      // price, at least one named stop, and a km figure — not just "one
      // package exists". Otherwise activation fails after publish.
      const pkgs = p.packageOptions as Pkg[];
      const pkgOk = pkgs.length > 0 && pkgs.every((k) =>
        String(k.label || "").trim() && Number(k.price) > 0 && String(k.stops || "").trim() && Number(k.distanceKmMin) > 0);
      if (!pkgOk) miss.add("tour packages (stops + km + price)");
      // Hours-fit (mirrors the server gate): a tour that fits NO working-day
      // window can never be booked. Fitting only SOME days is fine — those
      // days simply grey out for customers.
      const windows = Object.values(p.workingHours || {}).filter((s: any) => Array.isArray(s) && s.length === 2) as [string, string][];
      const winMin = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s).trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
      const fitsNone = (h: number) => windows.length > 0 && !windows.some(([o, c]) => winMin(c) - winMin(o) >= h * 60);
      if (pkgs.some((k) => Number(k.hours) > 0 && fitsNone(Number(k.hours)))) {
        miss.add("package hours (a tour is longer than every working day — extend hours or shorten it)");
      }
    }
    if (!hasOpenDay(p.workingHours)) miss.add("working hours");
  }

  // The `miss` set keeps English keys for logic; this maps each to a translated
  // label for the CTA summary only.
  const MISS_LABELS: Record<string, string> = {
    name: t("m.listingOnboard.miss.name", { defaultValue: "name" }),
    description: t("m.listingOnboard.miss.description", { defaultValue: "description" }),
    "photos (5+)": t("m.listingOnboard.miss.photos5", { defaultValue: "photos (5+)" }),
    type: t("m.listingOnboard.miss.type", { defaultValue: "type" }),
    location: t("m.listingOnboard.miss.location", { defaultValue: "location" }),
    "room types": t("m.listingOnboard.miss.roomTypes", { defaultValue: "room types" }),
    "room amenities (3+)": t("m.listingOnboard.miss.roomAmenities3", { defaultValue: "room amenities (3+)" }),
    "room max guests": t("m.listingOnboard.miss.roomMaxGuests", { defaultValue: "room max guests" }),
    "rooms per type": t("m.listingOnboard.miss.roomsPerType", { defaultValue: "rooms per type" }),
    "room photos (1+ each)": t("m.listingOnboard.miss.roomPhotos1", { defaultValue: "room photos (1+ each)" }),
    price: t("m.listingOnboard.miss.price", { defaultValue: "price" }),
    bedrooms: t("m.listingOnboard.miss.bedrooms", { defaultValue: "bedrooms" }),
    "max guests": t("m.listingOnboard.miss.maxGuests", { defaultValue: "max guests" }),
    "amenities (5+)": t("m.listingOnboard.miss.amenities5", { defaultValue: "amenities (5+)" }),
    "check-in": t("m.listingOnboard.miss.checkIn", { defaultValue: "check-in" }),
    "check-out": t("m.listingOnboard.miss.checkOut", { defaultValue: "check-out" }),
    category: t("m.listingOnboard.miss.category", { defaultValue: "category" }),
    experience: t("m.listingOnboard.miss.experience", { defaultValue: "experience" }),
    "appointment duration": t("m.listingOnboard.miss.appointmentDuration", { defaultValue: "appointment duration" }),
    "pricing unit": t("m.listingOnboard.miss.pricingUnit", { defaultValue: "pricing unit" }),
    "delivery mode": t("m.listingOnboard.miss.deliveryMode", { defaultValue: "delivery mode" }),
    languages: t("m.listingOnboard.miss.languages", { defaultValue: "languages" }),
    "service radius": t("m.listingOnboard.miss.serviceRadius", { defaultValue: "service radius" }),
    "visit address": t("m.listingOnboard.miss.visitAddress", { defaultValue: "visit address" }),
    "online details": t("m.listingOnboard.miss.onlineDetails", { defaultValue: "online details" }),
    "services catalog": t("m.listingOnboard.miss.servicesCatalog", { defaultValue: "services catalog" }),
    "working hours": t("m.listingOnboard.miss.workingHours", { defaultValue: "working hours" }),
    "vehicle type": t("m.listingOnboard.miss.vehicleType", { defaultValue: "vehicle type" }),
    model: t("m.listingOnboard.miss.model", { defaultValue: "model" }),
    "vehicle colour": t("m.listingOnboard.miss.vehicleColor", { defaultValue: "vehicle colour" }),
    "number plate": t("m.listingOnboard.miss.licensePlate", { defaultValue: "number plate" }),
    "seating capacity": t("m.listingOnboard.miss.seatingCapacity", { defaultValue: "seating capacity" }),
    "booking types": t("m.listingOnboard.miss.bookingTypes", { defaultValue: "booking types" }),
    "hourly rate": t("m.listingOnboard.miss.hourlyRate", { defaultValue: "hourly rate" }),
    "day rate": t("m.listingOnboard.miss.dayRate", { defaultValue: "day rate" }),
    "tour packages (stops + km + price)": t("m.listingOnboard.miss.tourPackages", { defaultValue: "tour packages (stops + km + price)" }),
    "package hours (a tour is longer than every working day — extend hours or shorten it)": t("m.listingOnboard.miss.packageHours", { defaultValue: "package hours (a tour is longer than every working day — extend hours or shorten it)" }),
  };
  const missLabel = (k: string) => MISS_LABELS[k] ?? k;

  let num = 0; const N = () => ++num;
  const svcPrices = (p.servicesCatalog as SvcGroup[]).map((g) => Number(g.basePrice) || 0).filter((n) => n > 0);
  const perNight = t("m.listingOnboard.price.perNight", { defaultValue: "/ night" });
  const fromWord = t("m.listingOnboard.price.from", { defaultValue: "from" });
  const priceLabel = host
    ? (multiRoom ? `${fromWord} ₹${Math.min(...(p.rooms.length ? p.rooms.map((r: Room) => Number(r.price) || 0) : [0]))} ${perNight}` : `₹${p.price || 0} ${perNight}`)
    : transport ? `₹${p.pricePerHour || p.pricePerDay || 0} / ${p.pricePerHour ? t("m.listingOnboard.price.hr", { defaultValue: "hr" }) : t("m.listingOnboard.price.day", { defaultValue: "day" })}`
    : `${fromWord} ₹${svcPrices.length ? Math.min(...svcPrices) : 0}`;
  const draft: DraftListing = { name: p.name || t("m.listingOnboard.newWord", { defaultValue: "New {{word}}", word }), location: p.location || (transport ? p.vehicleType : ""), price: priceLabel, icon: meta.icon, tone: meta.tone, status: "live", metric: t("m.listingOnboard.newlyListed", { defaultValue: "Newly listed" }), rating: 5 };

  return (
    <View style={[st.lob, { paddingTop: insets.top }]}>
      <View style={st.head}>
        <IconBtn name={(view === "form" || view === "ai") && !editing ? "chevL" : "x"} onPress={() => ((view === "form" || view === "ai") && !editing ? setView("chooser") : onClose())} />
        <View style={{ flex: 1 }}>
          <Text style={st.headTitle}>{editing ? t("m.listingOnboard.head.edit", { defaultValue: "Edit {{word}}", word }) : t("m.listingOnboard.head.add", { defaultValue: "Add a {{word}}", word })}</Text>
          <Text style={st.headSub}>{view === "chooser" ? t("m.listingOnboard.head.subChooser", { defaultValue: "Choose how to create it" }) : view === "ai" ? t("m.listingOnboard.head.subAi", { defaultValue: "Set up with Ista AI" }) : view === "form" ? t("m.listingOnboard.head.subForm", { defaultValue: "Fill in the details" }) : view === "preview" ? t("m.listingOnboard.head.subPreview", { defaultValue: "Preview your listing" }) : t("m.listingOnboard.head.subPublished", { defaultValue: "Published" })}</Text>
        </View>
        {(view === "ai" || view === "form" || view === "preview") && !editing && (
          <Pressable onPress={() => { void saveDraft(); }} style={({ pressed }) => [st.switchBtn, st.saveDraftBtn, pressed && { opacity: 0.8 }]}>
            <Icon name="check" size={14} color={T.terra} />
            <Text style={[st.switchTxt, { color: T.terra }]}>{t("m.listingOnboard.saveDraft", { defaultValue: "Save draft" })}</Text>
          </Pressable>
        )}
        {(view === "ai" || view === "form") && !editing && (
          <Pressable onPress={() => setView(view === "ai" ? "form" : "ai")} style={({ pressed }) => [st.switchBtn, pressed && { opacity: 0.8 }]}>
            <Icon name={view === "ai" ? "edit" : "bot"} size={14} color={T.aubergine} />
            <Text style={st.switchTxt}>{view === "ai" ? t("m.listingOnboard.switchForm", { defaultValue: "Form" }) : t("m.listingOnboard.switchAi", { defaultValue: "Ista AI" })}</Text>
          </Pressable>
        )}
      </View>

      {view === "chooser" && (
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
          <Text style={st.lead}>{t("m.listingOnboard.chooser.lead", { defaultValue: "How would you like to list your {{word}}?", word })}</Text>
          <Pressable style={({ pressed }: any) => [st.choice, pressed && { opacity: 0.9 }]} onPress={() => setView("ai")}>
            <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.choiceIco}><Icon name="bot" size={24} color="#fff" /></LinearGradient>
            <View style={{ flex: 1 }}><Text style={st.choiceTitle}>{t("m.listingOnboard.chooser.aiTitleTyped", { defaultValue: "Start {{word}} Onboarding with AI", word: wordCap })}</Text><Text style={st.choiceSub}>{t("m.listingOnboard.chooser.aiSub", { defaultValue: "Answer a few questions and AI fills the form for you." })}</Text></View>
            <Icon name="chevR" size={18} color={T.muted} />
          </Pressable>
          <Pressable style={({ pressed }: any) => [st.choice, pressed && { opacity: 0.9 }]} onPress={() => setView("form")}>
            <View style={st.choiceIcoAlt}><Icon name="edit" size={22} color={T.aubergine} /></View>
            <View style={{ flex: 1 }}><Text style={st.choiceTitle}>{t("m.listingOnboard.chooser.formTitle", { defaultValue: "Fill the form myself" })}</Text><Text style={st.choiceSub}>{t("m.listingOnboard.chooser.formSub", { defaultValue: "Enter the details manually, section by section." })}</Text></View>
            <Icon name="chevR" size={18} color={T.muted} />
          </Pressable>
        </ScrollView>
      )}

      {view === "ai" && (
        <AiOnboarding
          entryType={entryType}
          word={meta.word}
          profile={p}
          mergeProfile={(u) => setP((q: any) => {
            const v: any = { ...u };
            // The agent emits numbers (serviceRadius: 25, seatingCapacity: 3,
            // bedrooms: 2…) but RN TextInput silently renders a numeric
            // `value` as blank — the form looked empty even though the data
            // was extracted. Coerce every form-text field to string.
            for (const k of ["serviceRadius", "seatingCapacity", "bedrooms", "bathrooms", "maxGuests", "experience", "pricePerHour", "pricePerDay", "vehicleYear", "duration", "price"]) {
              if (typeof v[k] === "number") v[k] = String(v[k]);
            }
            // The form's vehicle-type tiles key off "Cab"/"Auto"/"Bus"/… but
            // the agent reports category="driver-auto" and/or free-text
            // vehicleType ("auto rickshaw", "SUV"). Map whatever signal this
            // patch carries onto the matching tile so it lights up in the form.
            if (transport && (v.vehicleType || v.category)) {
              const hint = String(v.vehicleType || v.category);
              const tile = ([
                [/auto|rickshaw|tuk/i, "Auto"],
                [/bus/i, "Bus"],
                [/tempo|van|traveller/i, "Tempo"],
                [/scooter|activa|moped/i, "Scooter"],
                [/motor|bike|bullet/i, "Motorcycle"],
                [/cab|sedan|suv|hatch|car|taxi/i, "Cab"],
              ] as [RegExp, string][]).find(([re]) => re.test(hint))?.[1];
              if (tile) v.vehicleType = tile;
              else delete v.vehicleType; // unmappable free-text would break the tile picker
            }
            const next = { ...q, ...v };
            // Translate the agent's roomTypes[] into the form's rooms[] so
            // the room editor / preview open pre-filled. Re-seed only while
            // the rooms are still agent-seeded (untouched by the host).
            if (Array.isArray(u.roomTypes) && u.roomTypes.length) {
              const cur: Room[] = Array.isArray(q.rooms) ? q.rooms : [];
              const untouched = cur.length === 0
                || cur.every((r) => typeof r.key === "string" && r.key.startsWith(ROOM_SEED_PREFIX));
              if (untouched) next.rooms = roomTypesToRooms(u.roomTypes);
            }
            // The agent emits packageOptions in the WIRE shape (numeric
            // price, stops as [{place, dwellMinutes?}]) — translate to the
            // editor's string-based shape so the form renders them.
            if (Array.isArray(u.packageOptions) && u.packageOptions.length) {
              next.packageOptions = u.packageOptions.map((k: any, i: number) => ({
                id: k.id || `pkg-${i + 1}`,
                label: k.label || k.title || "",
                price: String(k.price ?? ""),
                hours: k.hours != null ? String(k.hours) : "",
                stops: Array.isArray(k.stops)
                  ? k.stops.map((s: any) => (typeof s === "string" ? s : s?.place || "")).filter(Boolean).join(", ")
                  : String(k.stops || ""),
                distanceKmMin: k.distanceKmMin != null ? String(k.distanceKmMin) : "",
                distanceKmMax: k.distanceKmMax != null ? String(k.distanceKmMax) : "",
              }));
            }
            return next;
          })}
          messages={aiMessages}
          setMessages={setAiMessages}
          goToForm={() => setView("form")}
        />
      )}

      {view === "form" && (
        <>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 130 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {/* The basics */}
            <Section n={N()} title={t("m.listingOnboard.sec.basics", { defaultValue: "The basics" })} hint={host ? t("m.listingOnboard.sec.basicsHintStay", { defaultValue: "What kind of stay, and its name." }) : transport ? t("m.listingOnboard.sec.basicsHintTransport", { defaultValue: "What you drive, and your name." }) : t("m.listingOnboard.sec.basicsHintService", { defaultValue: "What you do, and your name." })}>
              {host && <Field label={t("m.listingOnboard.basics.stayType", { defaultValue: "Stay type" })} required><Tiles items={STAY_TILES.map((tile) => ({ key: tile.propertyType, label: t(`m.listingOnboard.stayTile.${tile.propertyType}`, { defaultValue: tile.label }), emoji: tile.emoji }))} value={p.propertyType} onPick={(k) => set("propertyType", k)} /></Field>}
              {transport && <Field label={t("m.listingOnboard.basics.vehicleType", { defaultValue: "Vehicle type" })} required><Tiles items={TRANSPORT_TILES.map((tile) => ({ key: tile.value, label: t(`m.listingOnboard.transportTile.${tile.value}`, { defaultValue: tile.value }), emoji: tile.emoji }))} value={p.vehicleType} onPick={(k) => { set("vehicleType", k); }} /></Field>}
              {service && <Field label={t("m.listingOnboard.basics.category", { defaultValue: "Category" })} required><ServiceCombo value={p.category} onChange={(v) => set("category", v)} /></Field>}
              <Field label={host ? t("m.listingOnboard.basics.propertyName", { defaultValue: "Property name" }) : transport ? t("m.listingOnboard.basics.driverName", { defaultValue: "Driver / business name" }) : t("m.listingOnboard.basics.serviceName", { defaultValue: "Service or business name" })} required hint={host ? t("m.listingOnboard.basics.propertyNameHint", { defaultValue: "What guests see when they search." }) : t("m.listingOnboard.basics.bizNameHint", { defaultValue: "How customers recognise you." })}>
                <TField value={p.name} onChangeText={(v: string) => set("name", v)} placeholder={host ? t("m.listingOnboard.basics.propertyNamePh", { defaultValue: "e.g. Sri Padmavathi Homestay" }) : transport ? t("m.listingOnboard.basics.driverNamePh", { defaultValue: "e.g. Ramesh Travels" }) : t("m.listingOnboard.basics.serviceNamePh", { defaultValue: "e.g. Veda Wellness Studio" })} />
              </Field>
            </Section>

            {/* About your work (service) */}
            {service && (
              <Section n={N()} title={t("m.listingOnboard.sec.work", { defaultValue: "About your work" })} hint={t("m.listingOnboard.sec.workHint", { defaultValue: "What makes you stand out." })}>
                <Field label={t("m.listingOnboard.work.subSkills", { defaultValue: "Sub-skills you offer" })} hint={t("m.listingOnboard.work.subSkillsHint", { defaultValue: "Optional — add each as a chip." })}><ChipListAdd items={p.subcategories} onChange={(v) => set("subcategories", v)} placeholder={t("m.listingOnboard.work.subSkillsPh", { defaultValue: "e.g. Deep tissue, Bridal makeup" })} /></Field>
                <Field label={t("m.listingOnboard.work.experience", { defaultValue: "Years of experience" })} required><TField value={p.experience} onChangeText={(v: string) => set("experience", v)} placeholder={t("m.listingOnboard.work.experiencePh", { defaultValue: "e.g. 8 years" })} /></Field>
                <Field label={t("m.listingOnboard.work.deliver", { defaultValue: "How you deliver it" })} required><Chips options={SERVICE_MODES.map(([v, lb]) => [v, t(`m.listingOnboard.serviceMode.${v}`, { defaultValue: lb })] as [string, string])} values={p.serviceModes} onToggle={(v) => toggle("serviceModes", v)} /></Field>
                {p.serviceModes.includes("visit-provider") && <Field label={t("m.listingOnboard.work.shopAddress", { defaultValue: "Your shop / studio address" })} required style={{ zIndex: 30 }}>
                  <AddressAutocomplete value={p.visitAddress} onChangeText={(v) => set("visitAddress", v)} onPick={(desc) => set("visitAddress", desc)} placeholder={t("m.listingOnboard.work.shopAddressPh", { defaultValue: "Shop / studio address" })} />
                  {/* WS6 host consent: OFF (default) = customers get the
                      address only after a confirmed booking; ON = it shows
                      on the public listing (walk-in premises). Mirrors web. */}
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: T.surface }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: font.bodySemi, fontSize: 13, color: T.ink }}>{t("m.listingOnboard.work.showAddressPublicly", { defaultValue: "Show this address publicly" })}</Text>
                      <Text style={{ fontFamily: font.body, fontSize: 11, lineHeight: 15, color: T.muted, marginTop: 2 }}>{t("m.listingOnboard.work.showAddressPubliclyHint", { defaultValue: "For a shop, salon, or clinic customers walk into. When off, the address is shared only after a confirmed booking." })}</Text>
                    </View>
                    <Switch value={p.showAddressPublicly === true} onValueChange={(v) => set("showAddressPublicly", v)} trackColor={{ true: T.aubergine, false: undefined }} />
                  </View>
                </Field>}
                {p.serviceModes.includes("online") && <Field label={t("m.listingOnboard.work.onlineDetails", { defaultValue: "Online delivery details" })} required><TField value={p.meetingDetails} onChangeText={(v: string) => set("meetingDetails", v)} placeholder={t("m.listingOnboard.work.onlineDetailsPh", { defaultValue: "e.g. I'll WhatsApp the meeting link" })} /></Field>}
                <Field label={t("m.listingOnboard.work.pricingUnit", { defaultValue: "Pricing unit" })} required hint={t("m.listingOnboard.work.pricingUnitHint", { defaultValue: "How customers see the rate." })}><Chips options={PRICE_UNITS.map(([v, lb]) => [v, t(`m.listingOnboard.priceUnit.${v}`, { defaultValue: lb })] as [string, string])} values={[p.pricingUnit]} onToggle={(v) => set("pricingUnit", v)} /></Field>
                <Field label={t("m.listingOnboard.work.catalog", { defaultValue: "Services catalog" })} required hint={t("m.listingOnboard.work.catalogHint", { defaultValue: "Each service has a base price. Add optional add-ons (extras priced on top) under each service." })}><ServicesCatalogEditor items={p.servicesCatalog} onChange={(v) => set("servicesCatalog", v)} /></Field>
              </Section>
            )}

            {/* Where you are */}
            <Section n={N()} title={t("m.listingOnboard.sec.where", { defaultValue: "Where you are" })} hint={host ? t("m.listingOnboard.sec.whereHintStay", { defaultValue: "Include the full street address — guests browsing only ever see the area and city; the exact address is shared after a confirmed booking." }) : t("m.listingOnboard.sec.whereHintOther", { defaultValue: "Your base — we match you to nearby jobs." })}>
              {/* zIndex lifts the autocomplete dropdown ABOVE the service-radius
                  row below it — without it the predictions list and that row
                  paint on top of each other. */}
              <Field label={t("m.listingOnboard.where.address", { defaultValue: "Address or area" })} required style={{ zIndex: 30 }}>
                <AddressAutocomplete
                  value={p.location}
                  onChangeText={(v) => set("location", v)}
                  onPick={(desc, d) => setP((q: any) => ({
                    ...q,
                    location: desc,
                    // Also capture city/state (locality/district) + coords so the
                    // listing is discoverable in Explore's "Near <city>" geo filter
                    // even if backend geocoding of the free-text address misses.
                    ...(d ? {
                      lat: d.lat,
                      lng: d.lng,
                      ...(d.locality ? { city: d.locality } : {}),
                      ...(d.district ? { state: d.district } : {}),
                    } : {}),
                  }))}
                  placeholder={t("m.listingOnboard.where.addressPh", { defaultValue: "City, area, landmark" })}
                />
                <Pressable onPress={useMyLocation} disabled={locating} style={({ pressed }) => [st.useLoc, pressed && { opacity: 0.7 }, locating && { opacity: 0.5 }]}>
                  <Icon name={locating ? "refresh" : "mappin"} size={13} color={T.terra} />
                  <Text style={st.useLocTxt}>{locating ? t("m.listingOnboard.where.locating", { defaultValue: "Locating…" }) : t("m.listingOnboard.where.useCurrent", { defaultValue: "Use current location" })}</Text>
                </Pressable>
                {!!(p.lat && p.lng) && <Text style={st.fieldHint}>📍 {Number(p.lat).toFixed(4)}, {Number(p.lng).toFixed(4)}</Text>}
              </Field>
              {(service || transport) && (
                <View style={{ flexDirection: "row", gap: 12, zIndex: 1 }}>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.where.serviceRadius", { defaultValue: "Service radius" })} required hint={t("m.listingOnboard.where.serviceRadiusHint", { defaultValue: "How far you'll travel." })}><View style={st.mfSuffix}><TextInput style={st.mfInput} value={p.serviceRadius} onChangeText={(v) => set("serviceRadius", v.replace(/[^\d]/g, ""))} placeholder="10" placeholderTextColor={T.muted} keyboardType="number-pad" /><Text style={st.mfRupee}>km</Text></View></Field></View>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.where.areasCovered", { defaultValue: "Areas you cover" })} hint={t("m.listingOnboard.optional", { defaultValue: "Optional." })}><TField value={p.serviceArea} onChangeText={(v: string) => set("serviceArea", v)} placeholder={transport ? t("m.listingOnboard.where.areasPhTransport", { defaultValue: "Airport routes" }) : t("m.listingOnboard.where.areasPhService", { defaultValue: "Suryaraopeta" })} /></Field></View>
                </View>
              )}
            </Section>

            {/* About the property (single-room stay) */}
            {host && !multiRoom && (
              <Section n={N()} title={t("m.listingOnboard.sec.property", { defaultValue: "About the property" })} hint={t("m.listingOnboard.sec.propertyHint", { defaultValue: "What guests need to know." })}>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.property.bedrooms", { defaultValue: "Bedrooms" })} required><TField value={p.bedrooms} onChangeText={(v: string) => set("bedrooms", v)} numeric placeholder="2" /></Field></View>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.property.bathrooms", { defaultValue: "Bathrooms" })}><TField value={p.bathrooms} onChangeText={(v: string) => set("bathrooms", v)} numeric placeholder="1" /></Field></View>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.property.maxGuests", { defaultValue: "Max guests" })} required><TField value={p.maxGuests} onChangeText={(v: string) => set("maxGuests", v)} numeric placeholder="4" /></Field></View>
                </View>
                <Field label={t("m.listingOnboard.property.amenities", { defaultValue: "Amenities" })} hint={t("m.listingOnboard.property.amenitiesHint", { defaultValue: "Pick what your place has — guests filter on these." })}><ChipListAdd items={p.amenities} onChange={(v) => set("amenities", v)} presets={STAY_AMENITIES} placeholder={t("m.listingOnboard.property.amenitiesPh", { defaultValue: "Add another (e.g. rooftop terrace)" })} /></Field>
              </Section>
            )}

            {/* Your vehicle (transport) */}
            {transport && (
              <Section n={N()} title={t("m.listingOnboard.sec.vehicle", { defaultValue: "Your vehicle" })} hint={t("m.listingOnboard.sec.vehicleHint", { defaultValue: "Helps riders pick the right driver." })}>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.vehicle.model", { defaultValue: "Model" })} required><TField value={p.vehicleName} onChangeText={(v: string) => set("vehicleName", v)} placeholder={t("m.listingOnboard.vehicle.modelPh", { defaultValue: "e.g. Maruti Dzire" })} /></Field></View>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.vehicle.year", { defaultValue: "Year" })}><TField value={p.vehicleYear} onChangeText={(v: string) => set("vehicleYear", v)} numeric placeholder="2021" /></Field></View>
                </View>
                {/* Colour + number plate — riders see these in the booking
                    summary to spot the car, so both are required. */}
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.vehicle.color", { defaultValue: "Colour" })} required><TField value={p.vehicleColor} onChangeText={(v: string) => set("vehicleColor", v)} placeholder={t("m.listingOnboard.vehicle.colorPh", { defaultValue: "e.g. White" })} /></Field></View>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.vehicle.plate", { defaultValue: "Number plate" })} required><TField value={p.licensePlate} onChangeText={(v: string) => set("licensePlate", v)} placeholder={t("m.listingOnboard.vehicle.platePh", { defaultValue: "e.g. KA 01 AB 1234" })} /></Field></View>
                </View>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.vehicle.seating", { defaultValue: "Seating capacity" })} required><TField value={p.seatingCapacity} onChangeText={(v: string) => set("seatingCapacity", v)} numeric placeholder="4" /></Field></View>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.vehicle.yearsDriving", { defaultValue: "Years driving" })} required><TField value={p.experience} onChangeText={(v: string) => set("experience", v)} placeholder="e.g. 8" /></Field></View>
                </View>
                <Field label={t("m.listingOnboard.vehicle.bookingTypes", { defaultValue: "Booking types" })} required><Chips options={BOOKING_MODES.map(([v, lb]) => [v, t(`m.listingOnboard.bookingMode.${v}`, { defaultValue: lb })] as [string, string])} values={p.transportModes} onToggle={(v) => toggle("transportModes", v)} /></Field>
                {p.transportModes.includes("hourly") && <Field label={t("m.listingOnboard.vehicle.hourlyRate", { defaultValue: "Hourly rate" })} required><Money value={p.pricePerHour} onChangeText={(v: string) => set("pricePerHour", v)} placeholder={t("m.listingOnboard.vehicle.perHourPh", { defaultValue: "per hour" })} /></Field>}
                {p.transportModes.includes("day") && <Field label={t("m.listingOnboard.vehicle.dayRate", { defaultValue: "Day rate" })} required><Money value={p.pricePerDay} onChangeText={(v: string) => set("pricePerDay", v)} placeholder={t("m.listingOnboard.vehicle.perDayPh", { defaultValue: "per day" })} /></Field>}
                {p.transportModes.includes("package") && <Field label={t("m.listingOnboard.vehicle.tourPackages", { defaultValue: "Tour packages" })} required><PackageEditor items={p.packageOptions} onChange={(v) => set("packageOptions", v)} /></Field>}
              </Section>
            )}

            {/* Pricing & timing (stay) */}
            {host && (
              <Section n={N()} title={multiRoom ? t("m.listingOnboard.sec.checkInOut", { defaultValue: "Check-in & check-out" }) : t("m.listingOnboard.sec.pricingTiming", { defaultValue: "Pricing & timing" })} hint={multiRoom ? t("m.listingOnboard.sec.checkInOutHint", { defaultValue: "Per-room prices live in Room types." }) : t("m.listingOnboard.sec.pricingTimingHint", { defaultValue: "Set your nightly price and timings." })}>
                {!multiRoom && <Field label={t("m.listingOnboard.stay.pricePerNight", { defaultValue: "Price per night" })} required><Money value={p.price} onChangeText={(v: string) => set("price", v)} placeholder="2500" /></Field>}
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.stay.checkIn", { defaultValue: "Check-in time" })} required><TField value={p.checkInTime} onChangeText={(v: string) => set("checkInTime", v)} placeholder="13:00" /></Field></View>
                  <View style={{ flex: 1 }}><Field label={t("m.listingOnboard.stay.checkOut", { defaultValue: "Check-out time" })} required><TField value={p.checkOutTime} onChangeText={(v: string) => set("checkOutTime", v)} placeholder="11:00" /></Field></View>
                </View>
              </Section>
            )}

            {/* Room types (multi-room stay) */}
            {multiRoom && (
              <Section n={N()} title={t("m.listingOnboard.sec.roomTypes", { defaultValue: "Room types" })} hint={editing ? t("m.listingOnboard.sec.roomTypesHintEdit", { defaultValue: "Add, edit, or remove bookable rooms." }) : t("m.listingOnboard.sec.roomTypesHintNew", { defaultValue: "Add the rooms guests can book — each row is one type." })}>
                {editing ? (
                  <Pressable style={({ pressed }) => [st.manageRooms, pressed && { opacity: 0.85 }]} onPress={onManageRooms}>
                    <View style={st.manageRoomsIco}><Icon name="bed" size={18} color={T.terra} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={st.manageRoomsTitle}>{t("m.listingOnboard.manageRooms.title", { defaultValue: "Manage room types" })}</Text>
                      <Text style={st.manageRoomsSub}>{t("m.listingOnboard.manageRooms.sub", { defaultValue: "Per-room price, photos & amenities live here." })}</Text>
                    </View>
                    <Icon name="chevR" size={18} color={T.muted} />
                  </Pressable>
                ) : (
                  <RoomTypesEditor rooms={p.rooms} onChange={(v) => set("rooms", v)} />
                )}
              </Section>
            )}

            {/* Hotel-wide facilities (multi-room stay) — shared spaces, not in-room
                amenities. Persisted via the listing-level amenities field. */}
            {multiRoom && (
              <Section n={N()} title={t("m.listingOnboard.sec.hotelFacilities", { defaultValue: "Hotel facilities" })} hint={t("m.listingOnboard.sec.hotelFacilitiesHint", { defaultValue: "Shared facilities guests can use — separate from in-room amenities." })}>
                <Field label={t("m.listingOnboard.facilities.label", { defaultValue: "Facilities" })} hint={t("m.listingOnboard.facilities.hint", { defaultValue: "Optional, but guests filter on these — pick everything the property offers." })}>
                  <ChipListAdd items={p.amenities} onChange={(v) => set("amenities", v)} presets={HOTEL_FACILITIES} placeholder={t("m.listingOnboard.facilities.ph", { defaultValue: "Add another (e.g. conference hall)" })} />
                </Field>
              </Section>
            )}

            {/* Working hours / availability (service/transport) */}
            {(service || transport) && (
              <Section n={N()} title={service ? t("m.listingOnboard.sec.availability", { defaultValue: "Availability & time slots" }) : t("m.listingOnboard.sec.workingHours", { defaultValue: "Working hours" })} hint={t("m.listingOnboard.sec.workingHoursHint", { defaultValue: "When you take bookings." })}>
                <Field label={t("m.listingOnboard.hours.weekly", { defaultValue: "Weekly working hours" })} required><WorkingHours hours={p.workingHours} onChange={(v) => set("workingHours", v)} /></Field>
                {service && (
                  <Field label={t("m.listingOnboard.hours.appointmentDuration", { defaultValue: "Appointment duration" })} required hint={t("m.listingOnboard.hours.appointmentDurationHint", { defaultValue: "How long one job typically takes. Used to generate bookable slots. Max 24 hours." })}>
                    <TField value={p.duration} onChangeText={(v: string) => set("duration", v)} placeholder={t("m.listingOnboard.hours.durationPh", { defaultValue: "e.g. 1 hour, 30 min" })} />
                  </Field>
                )}
                <Field label={service ? t("m.listingOnboard.hours.bufferJobs", { defaultValue: "Buffer between jobs (optional)" }) : t("m.listingOnboard.hours.bufferTrips", { defaultValue: "Buffer between trips (optional)" })} hint={t("m.listingOnboard.hours.bufferHint", { defaultValue: "Extra minutes between back-to-back bookings (travel, prep). Default 15." })}>
                  <TField value={String(p.bufferMinutes)} onChangeText={(v: string) => set("bufferMinutes", Math.max(0, Math.min(240, Number(v.replace(/[^\d]/g, "")) || 0)))} numeric placeholder="15" />
                </Field>
                {service && <SlotsPreview wh={p.workingHours} duration={p.duration} buffer={p.bufferMinutes} />}
                {transport && (
                  <View style={st.toggleRow}>
                    <View style={{ flex: 1 }}><Text style={st.toggleTitle}>{t("m.listingOnboard.hours.flexible", { defaultValue: "Flexible with hours" })}</Text><Text style={st.fieldHint}>{t("m.listingOnboard.hours.flexibleHint", { defaultValue: "Adds a “Flexible hours” tag — riders can message to arrange times outside these hours." })}</Text></View>
                    <Toggle on={!!p.flexibleHours} onChange={(v) => set("flexibleHours", v)} />
                  </View>
                )}
              </Section>
            )}


            {/* Story */}
            <Section n={N()} title={t("m.listingOnboard.sec.story", { defaultValue: "Tell your story" })} hint={t("m.listingOnboard.sec.storyHint", { defaultValue: "What makes it worth booking." })}>
              <Field label={t("m.listingOnboard.story.description", { defaultValue: "Description" })} required hint={t("m.listingOnboard.story.descriptionHint", { defaultValue: "A short blurb so customers know what makes you worth booking." })}>
                <TextInput style={st.textarea} multiline value={p.description} onChangeText={(v) => set("description", v)} placeholder={host ? t("m.listingOnboard.story.descPhStay", { defaultValue: "Two-room family home near the temple, home meals included…" }) : transport ? t("m.listingOnboard.story.descPhTransport", { defaultValue: "10 years driving in the district, clean AC car…" }) : t("m.listingOnboard.story.descPhService", { defaultValue: "Certified therapist, 5 years experience, calming home visits…" })} placeholderTextColor={T.muted} />
                <Pressable
                  onPress={enhanceDescription}
                  disabled={enhancingDesc || !(p.description ?? "").trim()}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, alignSelf: "flex-start", opacity: (enhancingDesc || !(p.description ?? "").trim()) ? 0.4 : 1 }}
                >
                  {enhancingDesc
                    ? <ActivityIndicator size="small" color={T.terra} />
                    : <Text style={{ fontSize: 13 }}>✨</Text>}
                  <Text style={{ color: T.terra, fontFamily: font.bodySemi, fontSize: 13 }}>
                    {t("m.listingOnboard.story.enhance", { defaultValue: "Enhance with AI" })}
                  </Text>
                </Pressable>
              </Field>
              <Field label={t("m.listingOnboard.story.languages", { defaultValue: "Languages you speak" })} required={service || transport}><Chips options={LANGS} values={p.languages} onToggle={(v) => toggle("languages", v)} /></Field>
              <Field label={t("m.listingOnboard.story.photos", { defaultValue: "Photos" })} required hint={t("m.listingOnboard.story.photosHint", { defaultValue: "Minimum 5 — {{count}}/5 added. Showcase the space / work; builds trust fast.", count: (p.photos?.length || 0) })}><PhotoGrid photos={p.photos} onChange={(v) => set("photos", v)} /></Field>
            </Section>
          </ScrollView>

          <View style={[st.cta, { bottom: Math.max(insets.bottom, 12) }]}>
            <View style={{ flex: 1 }}>
              <Text style={st.ctaStrong}>{miss.size ? t("m.listingOnboard.cta.requiredLeft", { defaultValue: "{{count}} required left", count: miss.size }) : t("m.listingOnboard.cta.allSet", { defaultValue: "All set" })}</Text>
              <Text style={st.ctaSub} numberOfLines={1}>{miss.size ? [...miss].slice(0, 3).map(missLabel).join(" · ") : t("m.listingOnboard.cta.readyToReview", { defaultValue: "Ready to review" })}</Text>
            </View>
            <Pressable style={[st.review, (miss.size > 0 || reviewChecking) && { opacity: 0.5 }]} disabled={miss.size > 0 || reviewChecking} onPress={() => void goToReview()}>
              <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.reviewInner}>
                {reviewChecking
                  ? (<><ActivityIndicator size="small" color="#fff" /><Text style={st.reviewTxt}>{t("m.listingOnboard.cta.checkingPhotos", { defaultValue: "Checking photos…" })}</Text></>)
                  : (<><Text style={st.reviewTxt}>{t("m.listingOnboard.cta.review", { defaultValue: "Review" })}</Text><Icon name="arrowR" size={18} color="#fff" /></>)}
              </LinearGradient>
            </Pressable>
          </View>
        </>
      )}

      {view === "preview" && (
        <>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
            <Text style={st.lead}>{t("m.listingOnboard.preview.lead", { defaultValue: "Here's how customers will see it:" })}</Text>
            <View style={st.card}>
              <View style={st.cardMedia}>
                {p.photos?.[0] ? <Image source={{ uri: p.photos[0] }} style={StyleSheet.absoluteFill as any} /> : <Ph tone={meta.tone} icon={meta.icon} label={t("m.listingOnboard.preview.photoLabel", { defaultValue: "{{word}} photo", word: wordCap })} style={StyleSheet.absoluteFill as any} />}
              </View>
              <View style={{ padding: 14 }}>
                <Text style={st.cardTitle}>{draft.name}</Text>
                {!!p.location && <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 }}><Icon name="mappin" size={14} color={T.muted} /><Text style={st.cardLoc}>{p.location}</Text></View>}
                {!!p.description && <Text style={st.cardDesc}>{p.description}</Text>}
                {!!(p.languages?.length) && <View style={[st.chipWrap, { marginTop: 10 }]}>{p.languages.slice(0, 4).map((l: string) => <View key={l} style={st.miniTag}><Text style={st.miniTagTxt}>{l}</Text></View>)}</View>}
                <View style={st.cardFoot}>
                  <View style={st.draftChip}><Text style={st.draftChipTxt}>{editing ? t("m.listingOnboard.preview.editing", { defaultValue: "Editing" }) : t("m.listingOnboard.preview.draft", { defaultValue: "Draft" })}</Text></View>
                  <Text style={st.cardPrice}>{draft.price}</Text>
                </View>
              </View>
            </View>
          </ScrollView>
          <View style={[st.cta, { bottom: Math.max(insets.bottom, 12) }]}>
            <Pressable style={st.ghost} onPress={() => setView("form")}><Text style={st.ghostTxt}>{t("m.listingOnboard.preview.edit", { defaultValue: "Edit" })}</Text></Pressable>
            <Pressable style={st.review} onPress={() => { if (!editing) void clearOnboardingDraft(user?.id, entryType); setView("success"); setTimeout(() => onPublish(draft, p), 1100); }}>
              <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.reviewInner}>
                <Text style={st.reviewTxt}>{editing ? t("m.listingOnboard.preview.saveChanges", { defaultValue: "Save changes" }) : t("m.listingOnboard.preview.publish", { defaultValue: "Publish" })}</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </>
      )}

      {view === "success" && (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 30, gap: 16 }}>
          <LinearGradient colors={[T.gradFrom, T.gradTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={st.ring}><Icon name="check" size={48} color="#fff" strokeWidth={2.6} /></LinearGradient>
          <Text style={st.successTitle}>{editing ? t("m.listingOnboard.success.changesSaved", { defaultValue: "Changes saved!" }) : t("m.listingOnboard.success.published", { defaultValue: "{{word}} published!", word: wordCap })}</Text>
          <Text style={st.successSub}>{t("m.listingOnboard.success.listingId", { defaultValue: "Listing ID · ISL{{id}}", id: (p.name.length * 137 + 1000) % 9000 + 1000 })}</Text>
          <Text style={st.successBody}>{editing ? t("m.listingOnboard.success.updatesLive", { defaultValue: "Your updates are live." }) : t("m.listingOnboard.success.live", { defaultValue: "Your {{word}} is now live and bookable.", word })}</Text>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  lob: { ...StyleSheet.absoluteFillObject, backgroundColor: T.bg, zIndex: 46 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface },
  headTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  headSub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  switchBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.35)", backgroundColor: "rgba(139,94,74,0.08)" },
  switchTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.aubergine },
  lead: { color: T.ink, fontSize: 15, fontFamily: font.bodySemi, marginBottom: 4 },
  choice: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.7)" },
  saveDraftBtn: { borderColor: T.terra, marginRight: 8 },
  choiceIco: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  choiceIcoAlt: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: T.greenSoft },
  choiceTitle: { fontSize: 15, fontFamily: font.head, color: T.ink },
  choiceSub: { fontSize: 12.5, color: T.muted, marginTop: 3, fontFamily: font.body, lineHeight: 17 },

  section: { marginBottom: 26 },
  sectionNum: { width: 26, height: 26, borderRadius: 999, backgroundColor: T.aubergine, alignItems: "center", justifyContent: "center" },
  sectionNumTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 13 },
  sectionTitle: { fontSize: 17, fontFamily: font.head, color: T.ink },
  sectionHint: { fontSize: 12.5, color: T.muted, fontFamily: font.body, marginTop: 1 },

  label: { fontSize: 13, fontFamily: font.bodyHeavy, color: T.aubergine, marginBottom: 7 },
  fieldHint: { fontSize: 12, color: T.muted, fontFamily: font.body, marginTop: -3, marginBottom: 7 },
  useLoc: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", marginTop: 8, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: "rgba(139,94,74,0.4)", backgroundColor: "rgba(139,94,74,0.08)" },
  useLocTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.terra },
  input: { minHeight: 46, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink, ...noOutline },
  textarea: { minHeight: 96, padding: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", fontSize: 14.5, fontFamily: font.body, color: T.ink, textAlignVertical: "top", ...noOutline },
  mfPrefix: { flexDirection: "row", alignItems: "center", minHeight: 46, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden" },
  mfSuffix: { flexDirection: "row", alignItems: "center", minHeight: 46, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden", paddingRight: 14 },
  mfRupee: { paddingHorizontal: 12, fontFamily: font.bodyHeavy, color: T.terra },
  mfInput: { flex: 1, paddingHorizontal: 12, minHeight: 46, fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink, ...noOutline },
  iconInput: { flexDirection: "row", alignItems: "center", paddingLeft: 12, minHeight: 46, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },

  tileWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { width: "30%", flexGrow: 1, alignItems: "center", gap: 6, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  tileActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  tileTxt: { fontSize: 12.5, fontFamily: font.bodyBold, color: T.ink },

  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.7)" },
  chipActive: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  chipTxt: { color: T.aubergine, fontSize: 12.5, fontFamily: font.bodyBold },
  removableChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingLeft: 12, paddingRight: 9, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.07)" },
  removableTxt: { color: T.aubergine, fontSize: 12.5, fontFamily: font.bodyBold },
  addBtn: { width: 46, height: 46, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },

  comboMenu: { marginTop: 6, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", overflow: "hidden" },
  comboItem: { paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: "rgba(23,22,28,0.05)" },
  comboTxt: { fontSize: 14, fontFamily: font.bodySemi, color: T.ink },

  listRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  listRowTxt: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink, flex: 1 },
  listRowSub: { fontSize: 12, color: T.muted, fontFamily: font.body },
  listRowPrice: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.ink },

  roomRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 13, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  roomEditor: { gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(139,94,74,0.3)", backgroundColor: "rgba(189,135,82,0.05)" },
  mini: { fontSize: 11, fontFamily: font.bodyHeavy, color: T.muted, marginBottom: 5 },
  ghostMini: { minHeight: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  ghostMiniTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 13 },
  addRoomBtn: { minHeight: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },
  addRoomTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 13 },
  addRoomDashed: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, borderRadius: 14, borderWidth: 1.5, borderStyle: "dashed", borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  manageRooms: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(139,94,74,0.3)", backgroundColor: "rgba(189,135,82,0.06)" },
  manageRoomsIco: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.16)" },
  manageRoomsTitle: { fontSize: 14.5, fontFamily: font.bodyHeavy, color: T.ink },
  manageRoomsSub: { fontSize: 12, fontFamily: font.body, color: T.muted, marginTop: 2 },
  addRoomDashedTxt: { color: T.terra, fontFamily: font.bodyHeavy, fontSize: 14 },

  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  photo: { width: 88, height: 88, borderRadius: 12, overflow: "hidden", backgroundColor: T.line },
  photoX: { position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(23,20,29,0.55)" },
  photoAdd: { width: 88, height: 88, borderRadius: 12, alignItems: "center", justifyContent: "center", gap: 4, borderWidth: 1.5, borderStyle: "dashed", borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  photoAddTxt: { color: T.terra, fontFamily: font.bodyBold, fontSize: 12 },

  whRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  whCheck: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: T.line, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" },
  whDay: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink },

  catalogCard: { gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  addonBox: { gap: 8, padding: 12, borderRadius: 13, borderWidth: 1, borderStyle: "dashed", borderColor: T.line, backgroundColor: "rgba(255,255,255,0.4)" },
  addonHint: { fontSize: 11.5, color: T.muted, fontFamily: font.body },
  addAnother: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 46, borderRadius: 13, borderWidth: 1.5, borderStyle: "dashed", borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  addAnotherTxt: { color: T.terra, fontFamily: font.bodyHeavy, fontSize: 14 },
  slotsBox: { padding: 14, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  slotsTitle: { fontSize: 13.5, fontFamily: font.bodyBold, color: T.ink },
  slotChip: { paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff" },
  slotChipTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.ink },
  slotChipMuted: { paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.07)" },
  slotChipMutedTxt: { fontSize: 12, fontFamily: font.bodyBold, color: T.muted },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  toggleTitle: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  switch: { width: 44, height: 26, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.18)", justifyContent: "center", paddingHorizontal: 3 },
  knob: { width: 20, height: 20, borderRadius: 999, backgroundColor: "#fff" },

  card: { borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", marginTop: 12 },
  cardMedia: { height: 170 },
  cardTitle: { fontSize: 17, fontFamily: font.head, color: T.ink },
  cardLoc: { color: T.muted, fontSize: 12.5, fontFamily: font.body },
  cardDesc: { color: T.muted, fontSize: 13, lineHeight: 19, marginTop: 8, fontFamily: font.body },
  miniTag: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.07)" },
  miniTagTxt: { fontSize: 11.5, fontFamily: font.bodyBold, color: T.aubergine },
  cardFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.line },
  draftChip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: "rgba(189,135,82,0.14)" },
  draftChipTxt: { fontSize: 11, fontFamily: font.bodyHeavy, color: T.terra },
  cardPrice: { fontSize: 16, fontFamily: font.bodyHeavy, color: T.ink },

  cta: { position: "absolute", left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingLeft: 18, paddingRight: 12, borderRadius: 24, borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.97)", shadowColor: "#221f27", shadowOffset: { width: 0, height: 22 }, shadowOpacity: 0.2, shadowRadius: 40, elevation: 16 },
  ctaStrong: { fontSize: 14, fontFamily: font.bodyHeavy, color: T.ink },
  ctaSub: { fontSize: 11.5, color: T.muted, fontFamily: font.body },
  ghost: { flex: 1, minHeight: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.72)", backgroundColor: "rgba(255,255,255,0.6)" },
  ghostTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 15 },
  review: { borderRadius: 16, overflow: "hidden", minWidth: 130, flex: 1 },
  reviewInner: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 18 },
  reviewTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 15 },
  ring: { width: 104, height: 104, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  successTitle: { fontSize: 23, fontFamily: font.head, color: T.ink },
  successSub: { fontSize: 13, color: T.muted, fontFamily: font.body },
  successBody: { fontSize: 14, color: T.muted, textAlign: "center", fontFamily: font.body, lineHeight: 20 },
});
