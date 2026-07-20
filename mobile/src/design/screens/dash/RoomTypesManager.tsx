// dash/RoomTypesManager.tsx — live CRUD for a multi-room stay's room types,
// opened from the dashboard listing card (host stays only). RN port of the
// web RoomTypesManager: same fields, validations, error strings, and the
// same dedicated /api/listings/:id/room-types endpoints. Photos upload
// immediately on pick (like web); ₹→paise conversion on save.
import React, { useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, Image, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { Icon } from "../../Icon";
import { IconBtn } from "../../primitives";
import { T, font, noOutline } from "../../theme";
import { listRoomTypes, createRoomType, updateRoomType, deleteRoomType, RoomTypeRow } from "../../api/roomTypes";
import { uploadToStorage } from "../../api/storage";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/toast";

type TFn = (key: string, options?: Record<string, unknown>) => string;

const ROOM_AMENITY_MIN = 3;
// Same preset list as the web RoomTypesManager (RoomAmenityChips).
const ROOM_AMENITY_PRESETS = [
  "AC", "WiFi", "TV", "Hot Water", "Heater", "Kitchenette", "Refrigerator",
  "Balcony", "Bathtub", "Hair Dryer", "Iron", "Wardrobe", "Workspace",
  "Coffee Maker", "Minibar", "Safe", "Pool Access", "Gym Access",
];

type Draft = {
  id?: string;
  name: string;
  description: string;
  pricePerNight: string; // ₹ as string for the input
  maxGuests: number;
  bedrooms: number;
  bathrooms: number;
  quantity: number;
  unitIdentifiers: string[];
  amenities: string[];
  photos: string[];
  sortOrder: number;
};

const EMPTY: Draft = {
  name: "", description: "", pricePerNight: "", maxGuests: 2, bedrooms: 1, bathrooms: 1,
  quantity: 1, unitIdentifiers: [], amenities: [], photos: [], sortOrder: 0,
};

const missingLabels = (t: TFn): Record<string, string> => ({
  name: t("m.roomtypes.missing.name", { defaultValue: "Room name" }),
  price: t("m.roomtypes.missing.price", { defaultValue: "Price per night" }),
  maxGuests: t("m.roomtypes.missing.maxGuests", { defaultValue: "Max guests" }),
  quantity: t("m.roomtypes.missing.quantity", { defaultValue: "Rooms of this type" }),
  photos: t("m.roomtypes.missing.photos", { defaultValue: "At least one photo" }),
  amenities: t("m.roomtypes.missing.amenities", { defaultValue: "At least {{count}} amenities", count: ROOM_AMENITY_MIN }),
});

const computeMissing = (d: Draft): Set<string> => {
  const m = new Set<string>();
  if (!d.name.trim()) m.add("name");
  if (!d.pricePerNight || Number(d.pricePerNight) <= 0) m.add("price");
  if (!d.maxGuests || d.maxGuests < 1) m.add("maxGuests");
  if (!d.quantity || d.quantity < 1) m.add("quantity");
  if (!d.photos || d.photos.length === 0) m.add("photos");
  if (!d.amenities || d.amenities.length < ROOM_AMENITY_MIN) m.add("amenities");
  return m;
};

const rupees = (paise: number) => (Number(paise) / 100).toLocaleString("en-IN");

export function RoomTypesManager({ listingId, listingName, onClose }: { listingId: string; listingName?: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [triedSave, setTriedSave] = useState(false);
  const [uploading, setUploading] = useState(false);

  const roomsQ = useQuery({
    queryKey: ["room-types", listingId],
    queryFn: () => listRoomTypes(listingId),
    enabled: !!listingId,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["room-types", listingId] });

  const saveMutation = useMutation({
    mutationFn: async (d: Draft) => {
      const payload = {
        name: d.name.trim(),
        description: d.description.trim(),
        basePricePaise: Math.round(Number(d.pricePerNight) * 100),
        maxGuests: d.maxGuests,
        bedrooms: d.bedrooms,
        bathrooms: d.bathrooms,
        quantity: d.quantity,
        unitIdentifiers: d.unitIdentifiers,
        amenities: d.amenities,
        photos: d.photos,
        sortOrder: d.sortOrder,
      };
      return d.id ? updateRoomType(listingId, d.id, payload) : createRoomType(listingId, payload);
    },
    onSuccess: () => { toast.success(t("m.roomtypes.savedToast", { defaultValue: "Room saved" })); setDraft(null); setTriedSave(false); refresh(); },
    onError: (e: any) => toast.error(e?.message || t("m.roomtypes.saveError", { defaultValue: "Couldn't save room" })),
  });

  const deleteMutation = useMutation({
    mutationFn: (roomId: string) => deleteRoomType(listingId, roomId),
    onSuccess: () => { toast.success(t("m.roomtypes.removedToast", { defaultValue: "Room removed" })); refresh(); },
    onError: (e: any) => toast.error(e?.message || t("m.roomtypes.removeError", { defaultValue: "Couldn't remove room" })),
  });

  const missing = draft ? computeMissing(draft) : new Set<string>();
  const isMissing = (k: string) => triedSave && missing.has(k);
  const upd = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const openNew = () => { setTriedSave(false); setDraft({ ...EMPTY, sortOrder: roomsQ.data?.length || 0 }); };
  const openEdit = (r: RoomTypeRow) => {
    setTriedSave(false);
    setDraft({
      id: r.id,
      name: r.name || "",
      description: r.description || "",
      pricePerNight: String(Number(r.base_price_paise) / 100),
      maxGuests: r.max_guests ?? 2,
      bedrooms: r.bedrooms ?? 1,
      bathrooms: r.bathrooms ?? 1,
      quantity: r.quantity ?? 1,
      unitIdentifiers: Array.isArray(r.unit_identifiers) ? r.unit_identifiers : [],
      amenities: Array.isArray(r.amenities) ? r.amenities : [],
      photos: Array.isArray(r.photos) ? r.photos : [],
      sortOrder: r.sort_order ?? 0,
    });
  };

  const attemptSave = () => {
    if (!draft) return;
    const m = computeMissing(draft);
    if (m.size > 0) {
      setTriedSave(true);
      const labels = missingLabels(t);
      toast.error(t("m.roomtypes.missingToast", { defaultValue: "Missing: {{fields}}", fields: [...m].map((k) => labels[k] ?? k).join(", ") }));
      return;
    }
    saveMutation.mutate(draft);
  };

  const confirmDelete = (r: RoomTypeRow) =>
    Alert.alert(
      t("m.roomtypes.removeAlertTitle", { defaultValue: "Remove room type" }),
      t("m.roomtypes.removeAlertMsg", { defaultValue: "Remove \"{{name}}\"?", name: r.name }),
      [
        { text: t("m.roomtypes.cancel", { defaultValue: "Cancel" }), style: "cancel" },
        { text: t("m.roomtypes.remove", { defaultValue: "Remove" }), style: "destructive", onPress: () => deleteMutation.mutate(r.id) },
      ],
    );

  const pickPhotos = async () => {
    if (!draft || !user) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6, allowsMultipleSelection: true });
    if (res.canceled) return;
    setUploading(true);
    try {
      const urls: string[] = [];
      for (const a of res.assets) urls.push(await uploadToStorage({ userId: user.id, uri: a.uri, bucket: "listing-images", keyPrefix: "rooms" }));
      upd({ photos: [...draft.photos, ...urls] });
    } catch (e: any) {
      toast.error(e?.message || t("m.roomtypes.photoUploadFailed", { defaultValue: "Photo upload failed" }));
    } finally {
      setUploading(false);
    }
  };

  const rooms = roomsQ.data || [];
  const saving = saveMutation.isPending;

  return (
    <View style={[st.lob, { paddingTop: insets.top }]}>
      <View style={st.head}>
        <IconBtn name={draft ? "chevL" : "x"} onPress={() => (draft ? (setDraft(null), setTriedSave(false)) : onClose())} />
        <View style={{ flex: 1 }}>
          <Text style={st.headTitle}>{t("m.roomtypes.headTitle", { defaultValue: "Room types" })}</Text>
          <Text style={st.headSub} numberOfLines={1}>{draft ? (draft.id ? t("m.roomtypes.editRoom", { defaultValue: "Edit room" }) : t("m.roomtypes.addARoom", { defaultValue: "Add a room" })) : listingName || t("m.roomtypes.manageRooms", { defaultValue: "Manage bookable rooms" })}</Text>
        </View>
      </View>

      {/* LIST */}
      {!draft && (
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: Math.max(insets.bottom, 20) + 80 }} showsVerticalScrollIndicator={false}>
          {roomsQ.isLoading ? (
            <View style={{ paddingVertical: 40, alignItems: "center" }}><ActivityIndicator color={T.aubergine} /></View>
          ) : rooms.length === 0 ? (
            <View style={st.emptyBox}>
              <Icon name="bed" size={30} color="rgba(104,112,122,0.5)" />
              <Text style={st.emptyTitle}>{t("m.roomtypes.emptyTitle", { defaultValue: "No rooms yet" })}</Text>
              <Text style={st.emptySub}>{t("m.roomtypes.emptySub", { defaultValue: "Add at least one room type so guests can book." })}</Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {rooms.map((r) => (
                <View key={r.id} style={st.roomRow}>
                  {r.photos?.[0] ? (
                    <Image source={{ uri: r.photos[0] }} style={st.thumb} />
                  ) : (
                    <View style={[st.thumb, st.thumbPh]}><Icon name="bed" size={20} color={T.terra} /></View>
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={st.roomName} numberOfLines={1}>{r.name}</Text>
                    <Text style={st.roomMeta} numberOfLines={1}>
                      {t("m.roomtypes.roomMeta", {
                        defaultValue: "₹{{price}} / night · sleeps {{guests}} · {{rooms}}",
                        price: rupees(r.base_price_paise),
                        guests: r.max_guests,
                        rooms: (r.quantity ?? 1) > 1
                          ? t("m.roomtypes.roomCountPlural", { defaultValue: "{{count}} rooms", count: r.quantity ?? 1 })
                          : t("m.roomtypes.roomCountSingular", { defaultValue: "{{count}} room", count: r.quantity ?? 1 }),
                      })}
                    </Text>
                  </View>
                  <Pressable hitSlop={8} onPress={() => openEdit(r)} style={st.rowBtn}><Icon name="pencil" size={16} color={T.aubergine} /></Pressable>
                  <Pressable hitSlop={8} onPress={() => confirmDelete(r)} style={st.rowBtn}><Icon name="x" size={16} color={T.coral} /></Pressable>
                </View>
              ))}
            </View>
          )}
          <Pressable style={st.addRoom} onPress={openNew}>
            <Icon name="plus" size={16} color={T.terra} /><Text style={st.addRoomTxt}>{t("m.roomtypes.addRoomType", { defaultValue: "Add room type" })}</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* DRAFT FORM */}
      {draft && (
        <>
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Field label={t("m.roomtypes.fieldRoomName", { defaultValue: "Room name" })} required error={isMissing("name") ? t("m.roomtypes.errRoomNameRequired", { defaultValue: "Room name is required." }) : undefined}>
              <TextInput style={[st.input, isMissing("name") && st.inputErr]} value={draft.name} onChangeText={(v) => upd({ name: v })} placeholder={t("m.roomtypes.phRoomName", { defaultValue: "e.g. Deluxe King Room" })} placeholderTextColor={T.muted} />
            </Field>
            <Field label={t("m.roomtypes.fieldDescription", { defaultValue: "Description" })}>
              <TextInput style={[st.input, st.textarea]} multiline value={draft.description} onChangeText={(v) => upd({ description: v })} placeholder={t("m.roomtypes.phDescription", { defaultValue: "What makes this room special?" })} placeholderTextColor={T.muted} />
            </Field>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1.2 }}>
                <Field label={t("m.roomtypes.fieldPrice", { defaultValue: "Price / night (₹)" })} required error={isMissing("price") ? t("m.roomtypes.errPrice", { defaultValue: "Enter a price > 0." }) : undefined}>
                  <TextInput style={[st.input, isMissing("price") && st.inputErr]} value={draft.pricePerNight} onChangeText={(v) => upd({ pricePerNight: v.replace(/[^\d]/g, "") })} placeholder="5000" placeholderTextColor={T.muted} keyboardType="number-pad" />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label={t("m.roomtypes.fieldMaxGuests", { defaultValue: "Max guests" })} required error={isMissing("maxGuests") ? t("m.roomtypes.errAtLeast1", { defaultValue: "At least 1." }) : undefined}>
                  <NumField value={draft.maxGuests} onChange={(n) => upd({ maxGuests: n })} err={isMissing("maxGuests")} />
                </Field>
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}><Field label={t("m.roomtypes.fieldBedrooms", { defaultValue: "Bedrooms" })}><NumField value={draft.bedrooms} onChange={(n) => upd({ bedrooms: n })} /></Field></View>
              <View style={{ flex: 1 }}><Field label={t("m.roomtypes.fieldBathrooms", { defaultValue: "Bathrooms" })}><NumField value={draft.bathrooms} onChange={(n) => upd({ bathrooms: n })} /></Field></View>
              <View style={{ flex: 1 }}>
                <Field label={t("m.roomtypes.fieldRoomsOfType", { defaultValue: "Rooms of type" })} required error={isMissing("quantity") ? t("m.roomtypes.errAtLeast1", { defaultValue: "At least 1." }) : undefined}>
                  <NumField value={draft.quantity} onChange={(n) => upd({ quantity: n })} err={isMissing("quantity")} />
                </Field>
              </View>
            </View>

            <Field label={t("m.roomtypes.fieldRoomIds", { defaultValue: "Room numbers / IDs" })} hint={t("m.roomtypes.hintRoomIds", { defaultValue: "Optional — e.g. 101, 8a, Tulip. Type a starting number and auto-fill the rest." })}>
              <RoomIds value={draft.unitIdentifiers} quantity={draft.quantity} onChange={(v) => upd({ unitIdentifiers: v })} t={t} />
            </Field>

            <Field label={t("m.roomtypes.fieldAmenities", { defaultValue: "Amenities (this room)" })} required hint={t("m.roomtypes.hintAmenities", { defaultValue: "Pick at least {{count}} so search filters surface the room.", count: ROOM_AMENITY_MIN })} error={isMissing("amenities") ? t("m.roomtypes.errAmenities", { defaultValue: "Pick at least {{count}} amenities ({{have}}/{{count}}).", count: ROOM_AMENITY_MIN, have: draft.amenities.length }) : undefined}>
              <AmenityChips value={draft.amenities} onChange={(v) => upd({ amenities: v })} err={isMissing("amenities")} t={t} />
            </Field>

            <Field label={t("m.roomtypes.fieldPhotos", { defaultValue: "Photos" })} required error={isMissing("photos") ? t("m.roomtypes.errPhotos", { defaultValue: "Add at least one photo of this room." }) : undefined}>
              <View style={[st.photoGrid, isMissing("photos") && st.gridErr]}>
                {draft.photos.map((uri, i) => (
                  <View key={i} style={st.photo}>
                    <Image source={{ uri }} style={StyleSheet.absoluteFill as any} />
                    <Pressable style={st.photoX} onPress={() => upd({ photos: draft.photos.filter((_, j) => j !== i) })}><Icon name="x" size={12} color="#fff" /></Pressable>
                  </View>
                ))}
                <Pressable style={st.photoAdd} onPress={pickPhotos} disabled={uploading}>
                  {uploading ? <ActivityIndicator size="small" color={T.terra} /> : <Icon name="camera" size={22} color={T.terra} />}
                  <Text style={st.photoAddTxt}>{uploading ? t("m.roomtypes.uploading", { defaultValue: "Uploading…" }) : t("m.roomtypes.add", { defaultValue: "Add" })}</Text>
                </Pressable>
              </View>
            </Field>
          </ScrollView>

          <View style={[st.cta, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Pressable style={st.ghost} onPress={() => { setDraft(null); setTriedSave(false); }} disabled={saving}><Text style={st.ghostTxt}>{t("m.roomtypes.cancel", { defaultValue: "Cancel" })}</Text></Pressable>
            <Pressable style={[st.save, saving && { opacity: 0.6 }]} onPress={attemptSave} disabled={saving}>
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={st.saveTxt}>{draft.id ? t("m.roomtypes.saveChanges", { defaultValue: "Save changes" }) : t("m.roomtypes.addRoom", { defaultValue: "Add room" })}</Text>}
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

/* ---------- small field pieces ---------- */
function Field({ label, hint, required, error, children }: { label: string; hint?: string; required?: boolean; error?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={st.label}>{label}{required ? <Text style={{ color: T.coral }}> *</Text> : null}</Text>
      {hint ? <Text style={st.hint}>{hint}</Text> : null}
      {children}
      {error ? <Text style={st.err}>{error}</Text> : null}
    </View>
  );
}

function NumField({ value, onChange, err }: { value: number; onChange: (n: number) => void; err?: boolean }) {
  return (
    <TextInput
      style={[st.input, err && st.inputErr]}
      value={String(value)}
      onChangeText={(v) => onChange(Math.max(0, Number(v.replace(/[^\d]/g, "")) || 0))}
      keyboardType="number-pad"
      placeholderTextColor={T.muted}
    />
  );
}

function AmenityChips({ value, onChange, err, t }: { value: string[]; onChange: (v: string[]) => void; err?: boolean; t: TFn }) {
  const [text, setText] = useState("");
  const has = (a: string) => value.some((v) => v.toLowerCase() === a.toLowerCase());
  const toggle = (a: string) => onChange(has(a) ? value.filter((v) => v.toLowerCase() !== a.toLowerCase()) : [...value, a]);
  const addCustom = () => { const t = text.trim(); if (!t || has(t)) { setText(""); return; } onChange([...value, t]); setText(""); };
  const presetLower = new Set(ROOM_AMENITY_PRESETS.map((a) => a.toLowerCase()));
  const custom = value.filter((v) => !presetLower.has(v.toLowerCase()));
  return (
    <View style={[{ gap: 10 }, err && st.gridErr]}>
      <View style={st.chipWrap}>
        {ROOM_AMENITY_PRESETS.map((a) => (
          <Pressable key={a} onPress={() => toggle(a)} style={[st.chip, has(a) && st.chipOn]}>
            <Text style={[st.chipTxt, has(a) && { color: "#fff" }]}>{a}</Text>
          </Pressable>
        ))}
      </View>
      {custom.length > 0 && (
        <View style={st.chipWrap}>
          {custom.map((a) => (
            <View key={a} style={st.removableChip}>
              <Text style={st.removableTxt}>{a}</Text>
              <Pressable onPress={() => onChange(value.filter((v) => v !== a))}><Icon name="x" size={12} color={T.aubergine} /></Pressable>
            </View>
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[st.input, { flex: 1 }]} value={text} onChangeText={setText} onSubmitEditing={addCustom} placeholder={t("m.roomtypes.phAddAmenity", { defaultValue: "Add another (e.g. sea view, minibar)" })} placeholderTextColor={T.muted} />
        <Pressable style={st.addBtn} onPress={addCustom}><Icon name="plus" size={18} color="#fff" /></Pressable>
      </View>
    </View>
  );
}

function RoomIds({ value, quantity, onChange, t }: { value: string[]; quantity: number; onChange: (v: string[]) => void; t: TFn }) {
  const [text, setText] = useState("");
  const has = (v: string) => value.some((x) => x.toLowerCase() === v.toLowerCase());
  const remove = (v: string) => onChange(value.filter((x) => x !== v));
  const addOne = () => { const t = text.trim(); if (!t || has(t)) { setText(""); return; } onChange([...value, t]); setText(""); };
  // Auto-fill: if the draft is a bare integer, generate sequential numbers up
  // to `quantity` (mirrors the web RoomIdentifiers autoFillFromDraft).
  const autoFill = () => {
    const t = text.trim();
    const n = Number(t);
    if (!(Number.isInteger(n) && String(n) === t && quantity > 0)) { addOne(); return; }
    const remaining = quantity - value.length;
    if (remaining <= 0) { setText(""); return; }
    const out: string[] = [];
    const seen = new Set(value.map((x) => x.toLowerCase()));
    let k = n;
    while (out.length < remaining) {
      const id = String(k);
      if (!seen.has(id.toLowerCase())) { out.push(id); seen.add(id.toLowerCase()); }
      k += 1;
    }
    onChange([...value, ...out]);
    setText("");
  };
  const canAuto = /^\d+$/.test(text.trim()) && quantity > value.length;
  return (
    <View style={{ gap: 10 }}>
      {value.length > 0 && (
        <View style={st.chipWrap}>
          {value.map((v) => (
            <View key={v} style={st.removableChip}>
              <Text style={st.removableTxt}>{v}</Text>
              <Pressable onPress={() => remove(v)}><Icon name="x" size={12} color={T.aubergine} /></Pressable>
            </View>
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[st.input, { flex: 1 }]} value={text} onChangeText={setText} onSubmitEditing={addOne} placeholder={t("m.roomtypes.phRoomId", { defaultValue: "e.g. 101, 8a, Tulip" })} placeholderTextColor={T.muted} keyboardType="default" />
        <Pressable style={[st.addBtn, { width: "auto", paddingHorizontal: 14 }]} onPress={autoFill}>
          <Text style={st.addBtnTxt}>{canAuto ? t("m.roomtypes.autoFill", { defaultValue: "Auto-fill {{count}}", count: Math.max(0, quantity - value.length) }) : t("m.roomtypes.add", { defaultValue: "Add" })}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  lob: { ...StyleSheet.absoluteFillObject, backgroundColor: T.bg, zIndex: 46 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: T.line, backgroundColor: T.surface },
  headTitle: { fontSize: 16, fontFamily: font.head, color: T.ink },
  headSub: { fontSize: 12, color: T.muted, fontFamily: font.body },

  emptyBox: { alignItems: "center", gap: 6, paddingVertical: 30, borderWidth: 1.5, borderStyle: "dashed", borderColor: T.line, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.4)" },
  emptyTitle: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink, marginTop: 4 },
  emptySub: { fontSize: 12, color: T.muted, fontFamily: font.body },

  roomRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.7)" },
  thumb: { width: 52, height: 52, borderRadius: 12, backgroundColor: T.line },
  thumbPh: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(189,135,82,0.14)" },
  roomName: { fontSize: 14, fontFamily: font.bodyBold, color: T.ink },
  roomMeta: { fontSize: 12, color: T.muted, fontFamily: font.body, marginTop: 3 },
  rowBtn: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  addRoom: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 14, minHeight: 50, borderRadius: 16, borderWidth: 1.5, borderStyle: "dashed", borderColor: "rgba(139,94,74,0.4)", backgroundColor: "rgba(255,255,255,0.5)" },
  addRoomTxt: { color: T.terra, fontFamily: font.bodyHeavy, fontSize: 14 },

  label: { fontSize: 13, fontFamily: font.bodyHeavy, color: T.aubergine, marginBottom: 7 },
  hint: { fontSize: 12, color: T.muted, fontFamily: font.body, marginTop: -3, marginBottom: 7 },
  err: { fontSize: 11.5, fontFamily: font.bodyHeavy, color: T.coral, marginTop: 5 },
  input: { minHeight: 46, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: T.line, backgroundColor: "#fff", fontSize: 14.5, fontFamily: font.bodySemi, color: T.ink, ...noOutline },
  inputErr: { borderColor: T.coral },
  textarea: { minHeight: 80, paddingTop: 12, textAlignVertical: "top", fontFamily: font.body },

  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.7)" },
  chipOn: { backgroundColor: T.aubergine, borderColor: T.aubergine },
  chipTxt: { color: T.aubergine, fontSize: 12, fontFamily: font.bodyBold },
  removableChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingLeft: 12, paddingRight: 9, borderRadius: 999, backgroundColor: "rgba(58,50,71,0.07)" },
  removableTxt: { color: T.aubergine, fontSize: 12, fontFamily: font.bodyBold },
  addBtn: { minWidth: 46, height: 46, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: T.aubergine },
  addBtnTxt: { color: "#fff", fontSize: 12.5, fontFamily: font.bodyHeavy },
  gridErr: { borderRadius: 14, borderWidth: 1, borderColor: "rgba(164,93,98,0.5)", padding: 4 },

  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  photo: { width: 88, height: 88, borderRadius: 12, overflow: "hidden", backgroundColor: T.line },
  photoX: { position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(23,20,29,0.55)" },
  photoAdd: { width: 88, height: 88, borderRadius: 12, alignItems: "center", justifyContent: "center", gap: 4, borderWidth: 1.5, borderStyle: "dashed", borderColor: T.line, backgroundColor: "rgba(255,255,255,0.5)" },
  photoAddTxt: { color: T.terra, fontFamily: font.bodyBold, fontSize: 12 },

  cta: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface },
  ghost: { flex: 1, minHeight: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: T.line, backgroundColor: "rgba(255,255,255,0.6)" },
  ghostTxt: { color: T.aubergine, fontFamily: font.bodyHeavy, fontSize: 15 },
  save: { flex: 1.4, minHeight: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: T.terra },
  saveTxt: { color: "#fff", fontFamily: font.bodyHeavy, fontSize: 15 },
});
