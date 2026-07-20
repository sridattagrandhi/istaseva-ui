// design/screens/PrivacyScreen.tsx — privacy & consent preferences + data
// rights (PRIV-002 / LEG-017). Hosts the marketing-consent toggle
// (consent_records trail via /api/users/me/consents), the DSAR "download my
// data" flow, the account-deletion flow, and links to the legal documents.
// Reached from the Profile menu's "Privacy & safety" row. Mobile has no
// signup form (OTP-first), so this toggle is the only place consent is
// granted on mobile.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Switch, StyleSheet, Pressable, Alert, Linking, ActivityIndicator } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../primitives";
import { Background } from "../Background";
import { Icon } from "../Icon";
import { T, font } from "../theme";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { hasMarketingConsent, setConsent } from "../api/consents";
import { hasAnalyticsConsent, setAnalyticsConsent } from "../api/analyticsEvents";
import { requestExport, fetchExportStatus, requestDeletion, fetchDeletionStatus, cancelDeletion, type AccountRequestState } from "../api/account";
import { toast } from "@/lib/toast";

export function PrivacyScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuth();
  const [marketing, setMarketing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportState, setExportState] = useState<AccountRequestState | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [deletionState, setDeletionState] = useState<AccountRequestState | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void hasMarketingConsent().then((granted) => {
      if (!cancelled) setMarketing(granted);
    });
    // A pending grace-window deletion should survive reloads/other devices.
    void fetchDeletionStatus().then((state) => {
      if (!cancelled) setDeletionState(state);
    }).catch(() => { /* non-fatal */ });
    // Device-analytics consent is per-device (LEG-014), opt-in.
    void hasAnalyticsConsent().then((granted) => {
      if (!cancelled) setAnalytics(granted);
    });
    // Load export state; poll while a request is in flight.
    const tick = async () => {
      try {
        const state = await fetchExportStatus();
        if (cancelled) return;
        setExportState(state);
        if (state && (state.status === "requested" || state.status === "processing")) {
          pollRef.current = setTimeout(tick, 4000);
        }
      } catch {
        // Non-fatal — the button re-fetches on demand.
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [user]);

  const toggle = async (granted: boolean) => {
    setMarketing(granted); // optimistic — revert on failure
    setSaving(true);
    try {
      await setConsent("marketing", granted);
    } catch {
      setMarketing(!granted);
      toast.error(t("m.privacy.saveFailed", { defaultValue: "Couldn't save your preference. Try again." }));
    } finally {
      setSaving(false);
    }
  };

  const exportInFlight = exportState?.status === "requested" || exportState?.status === "processing";

  const startExport = async () => {
    setExportBusy(true);
    try {
      const state = await requestExport();
      setExportState(state);
      toast.success(t("m.privacy.exportStarted", { defaultValue: "Preparing your data — check back in a minute." }));
      if (pollRef.current) clearTimeout(pollRef.current);
      const poll = async () => {
        try {
          const latest = await fetchExportStatus();
          setExportState(latest);
          if (latest && (latest.status === "requested" || latest.status === "processing")) {
            pollRef.current = setTimeout(poll, 4000);
          }
        } catch {
          // give up quietly; user can re-open the screen
        }
      };
      pollRef.current = setTimeout(poll, 4000);
    } catch {
      toast.error(t("m.privacy.exportFailed", { defaultValue: "Could not start the export. Try again." }));
    } finally {
      setExportBusy(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      t("m.privacy.deleteTitle", { defaultValue: "Delete your account permanently?" }),
      t("m.privacy.deleteBody", {
        defaultValue:
          "Deletion runs after a 48-hour grace period — until then your account keeps working and you can cancel from this screen. Afterwards your profile, listings, messages and personal data are permanently removed. Records required by tax law are kept with your personal details removed. Upcoming bookings are NOT cancelled automatically — cancel them first for a refund.",
      }),
      [
        { text: t("m.common.cancel", { defaultValue: "Cancel" }), style: "cancel" },
        {
          text: t("m.privacy.deleteCta", { defaultValue: "Delete my account" }),
          style: "destructive",
          onPress: async () => {
            setDeleteBusy(true);
            try {
              const state = await requestDeletion();
              setDeletionState(state);
              toast.success(t("m.privacy.deleteScheduled", { defaultValue: "Deletion scheduled. You have 48 hours to change your mind." }));
            } catch (err: any) {
              const status = err?.response?.status;
              if (status === 401) {
                // Stale sign-in — server demands a fresh login for deletion.
                Alert.alert(
                  t("m.privacy.reauthTitle", { defaultValue: "Please sign in again" }),
                  t("m.privacy.reauthBody", { defaultValue: "For security, deleting your account needs a recent sign-in. Log out, sign in again, then retry." })
                );
              } else {
                toast.error(t("m.privacy.deleteFailed", { defaultValue: "Could not delete your account. Try again or contact support." }));
              }
            } finally {
              setDeleteBusy(false);
            }
          },
        },
      ]
    );
  };

  const onCancelDeletion = async () => {
    setCancelBusy(true);
    try {
      const state = await cancelDeletion();
      setDeletionState(state);
      toast.success(t("m.privacy.cancelDone", { defaultValue: "Deletion cancelled. Your account stays active." }));
    } catch {
      toast.error(t("m.privacy.cancelFailed", { defaultValue: "Could not cancel — deletion may already be underway. Contact support." }));
    } finally {
      setCancelBusy(false);
    }
  };

  const deletionPending = deletionState?.status === "requested" && deletionState.cancellable !== false;
  const scheduledLabel = deletionState?.scheduledFor
    ? new Date(deletionState.scheduledFor).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={t("m.privacy.title", { defaultValue: "Privacy & safety" })} onBack={() => nav.goBack()} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.hint}>
          {t("m.privacy.hint", { defaultValue: "Control how IstaSeva can contact you." })}
        </Text>
        <View style={styles.card}>
          <View style={[styles.row, styles.divider]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.rowTitle}>{t("m.privacy.marketingToggle", { defaultValue: "Offers and updates" })}</Text>
              <Text style={styles.rowHint}>{t("m.privacy.marketingHint", { defaultValue: "Travel ideas, offers and product updates by email or SMS." })}</Text>
            </View>
            <Switch
              value={marketing}
              disabled={saving || !user}
              onValueChange={toggle}
              trackColor={{ true: T.aubergine, false: undefined }}
            />
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.rowTitle}>{t("m.privacy.analyticsToggle", { defaultValue: "Usage analytics" })}</Text>
              <Text style={styles.rowHint}>{t("m.privacy.analyticsHint", { defaultValue: "Share anonymous usage data (a device identifier, screens and searches) to help improve IstaSeva. Off by default." })}</Text>
            </View>
            <Switch
              value={analytics}
              onValueChange={(granted) => {
                setAnalytics(granted);
                void setAnalyticsConsent(granted); // device gate (suppresses analytics now)
                // + audit trail (LEG-014). Best-effort — the device gate is
                // authoritative; a failed register write must not revert it.
                void setConsent("analytics", granted).catch(() => undefined);
              }}
              trackColor={{ true: T.aubergine, false: undefined }}
            />
          </View>
        </View>

        {/* Data rights (PRIV-002): export + deletion */}
        <Text style={styles.secLabel}>{t("m.privacy.dataLabel", { defaultValue: "Your data" })}</Text>
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.row, styles.divider, pressed && { backgroundColor: "rgba(58,50,71,0.05)" }]}
            disabled={!user || exportBusy || exportInFlight}
            onPress={startExport}
          >
            <Icon name="arrowUR" size={19} color={T.aubergine} />
            <View style={{ flex: 1, paddingLeft: 12, paddingRight: 8 }}>
              <Text style={styles.rowTitle}>{t("m.privacy.exportTitle", { defaultValue: "Download my data" })}</Text>
              <Text style={styles.rowHint}>
                {exportInFlight
                  ? t("m.privacy.exportPreparing", { defaultValue: "Preparing your export…" })
                  : t("m.privacy.exportHint", { defaultValue: "Get a copy of your profile, bookings, messages and activity." })}
              </Text>
            </View>
            {exportBusy || exportInFlight ? <ActivityIndicator size="small" color={T.aubergine} /> : <Icon name="chevR" size={18} color={T.muted} />}
          </Pressable>
          {exportState?.status === "completed" && exportState.downloadUrl ? (
            <Pressable
              style={({ pressed }) => [styles.row, styles.divider, pressed && { backgroundColor: "rgba(58,50,71,0.05)" }]}
              onPress={() => exportState.downloadUrl && Linking.openURL(exportState.downloadUrl)}
            >
              <Icon name="check" size={19} color={T.terra} />
              <View style={{ flex: 1, paddingLeft: 12 }}>
                <Text style={[styles.rowTitle, { color: T.terra }]}>
                  {t("m.privacy.exportReady", { defaultValue: "Your export is ready — tap to download" })}
                </Text>
              </View>
            </Pressable>
          ) : null}
          {exportState?.status === "failed" ? (
            <View style={[styles.row, styles.divider]}>
              <Text style={[styles.rowHint, { color: T.coral }]}>
                {t("m.privacy.exportError", { defaultValue: "The last export failed — you can request a new one." })}
              </Text>
            </View>
          ) : null}
          {deletionPending ? (
            <View style={[styles.row, styles.scheduledBox]}>
              <Icon name="info" size={19} color={T.coral} />
              <View style={{ flex: 1, paddingLeft: 12, paddingRight: 8 }}>
                <Text style={[styles.rowTitle, { color: T.coral }]}>
                  {t("m.privacy.scheduledTitle", { defaultValue: "Account deletion scheduled" })}
                </Text>
                <Text style={styles.rowHint}>
                  {scheduledLabel
                    ? t("m.privacy.scheduledBody", { defaultValue: "Your data will be permanently erased after {{date}}. Until then everything keeps working.", date: scheduledLabel })
                    : t("m.privacy.scheduledBodyNoDate", { defaultValue: "Your account is scheduled for permanent deletion." })}
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}
                  disabled={cancelBusy}
                  onPress={onCancelDeletion}
                >
                  {cancelBusy
                    ? <ActivityIndicator size="small" color={T.aubergine} />
                    : <Text style={styles.cancelBtnText}>{t("m.privacy.cancelCta", { defaultValue: "Cancel deletion" })}</Text>}
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: "rgba(164,93,98,0.06)" }]}
              disabled={!user || deleteBusy}
              onPress={confirmDelete}
            >
              <Icon name="trash" size={19} color={T.coral} />
              <View style={{ flex: 1, paddingLeft: 12, paddingRight: 8 }}>
                <Text style={[styles.rowTitle, { color: T.coral }]}>{t("m.privacy.deleteRow", { defaultValue: "Delete account" })}</Text>
                <Text style={styles.rowHint}>{t("m.privacy.deleteRowHint", { defaultValue: "Permanently delete your account and personal data after a 48-hour grace period." })}</Text>
              </View>
              {deleteBusy ? <ActivityIndicator size="small" color={T.coral} /> : <Icon name="chevR" size={18} color={T.muted} />}
            </Pressable>
          )}
        </View>

        {/* Legal documents */}
        <Text style={styles.secLabel}>{t("m.privacy.legalLabel", { defaultValue: "Legal" })}</Text>
        <View style={styles.card}>
          {([
            ["m.privacy.termsRow", "Terms of Service", "Terms"],
            ["m.privacy.policyRow", "Privacy Policy", "PrivacyPolicy"],
            ["m.privacy.grievanceRow", "Grievance redressal", "Grievance"],
            ["m.privacy.licensesRow", "Open-source licences", "OssLicenses"],
          ] as [string, string, string][]).map(([key, label, route], i, arr) => (
            <Pressable
              key={route}
              style={({ pressed }) => [styles.row, i < arr.length - 1 && styles.divider, pressed && { backgroundColor: "rgba(58,50,71,0.05)" }]}
              onPress={() => nav.navigate(route)}
            >
              <Icon name="info" size={19} color={T.aubergine} />
              <Text style={[styles.rowTitle, { flex: 1, paddingLeft: 12 }]}>{t(key, { defaultValue: label })}</Text>
              <Icon name="chevR" size={18} color={T.muted} />
            </Pressable>
          ))}
        </View>

        {!user && (
          <Text style={styles.signedOut}>
            {t("m.privacy.signInFirst", { defaultValue: "Sign in to manage your preferences." })}
          </Text>
        )}
      </ScrollView>
    </Background>
  );
}

const styles = StyleSheet.create({
  hint: { fontFamily: font.body, fontSize: 13, color: T.muted, marginBottom: 14, lineHeight: 19 },
  card: { backgroundColor: "#fff", borderRadius: 18, borderWidth: 1, borderColor: T.line, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 15 },
  divider: { borderBottomWidth: 1, borderBottomColor: "rgba(23,22,28,0.06)" },
  rowTitle: { fontFamily: font.bodySemi, fontSize: 15, color: T.ink },
  rowHint: { fontFamily: font.body, fontSize: 12.5, color: T.muted, marginTop: 3, lineHeight: 18 },
  secLabel: { fontFamily: font.bodyHeavy, fontSize: 12, color: T.aubergine, letterSpacing: 1, textTransform: "uppercase", marginTop: 22, marginBottom: 10 },
  scheduledBox: { alignItems: "flex-start", backgroundColor: "rgba(164,93,98,0.06)" },
  cancelBtn: {
    alignSelf: "flex-start",
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: T.line,
    backgroundColor: "#fff",
    minWidth: 130,
    alignItems: "center",
  },
  cancelBtnText: { fontFamily: font.bodySemi, fontSize: 13.5, color: T.ink },
  signedOut: { fontFamily: font.body, fontSize: 13, color: T.muted, marginTop: 14, textAlign: "center" },
});
