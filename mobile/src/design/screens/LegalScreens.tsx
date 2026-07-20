// design/screens/LegalScreens.tsx — Terms of Service, Privacy Policy and
// Grievance screens (LEG-001 / LEG-006 / LEG-017). Content mirrors the web
// pages (src/pages/Terms.tsx etc. — mobile shares no code with web; update
// both in the same PR). The copy is an ENGINEERING DRAFT pending counsel —
// it accurately describes system behavior; the binding wording comes from
// Legal before launch. Version: display mirror of the SERVER source of truth
// (server/src/modules/users/legal-docs-version.ts) — the server stamps the
// ledger; web mirror lives in src/lib/legal.ts. Bump all three together.
import React from "react";
import { View, Text, ScrollView, StyleSheet, FlatList } from "react-native";
import ossLicenses from "../data/oss-licenses.json";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../primitives";
import { Background } from "../Background";
import { T, font } from "../theme";
import { useLanguage } from "@/contexts/LanguageContext";

const LEGAL_DOCS_VERSION = "1.3.0-draft";
const GRIEVANCE_EMAIL = "grievance@istaseva.com";

function LegalDoc({ title, sections }: { title: string; sections: [string, string][] }) {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={title} onBack={() => nav.goBack()} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.version}>Version {LEGAL_DOCS_VERSION} · Last updated 15 July 2026</Text>
        <View style={styles.draftNote}>
          <Text style={styles.draftNoteTxt}>
            Draft — this document describes current system behavior and is pending review by legal
            counsel. It will be replaced by the final version before general availability.
          </Text>
        </View>
        {sections.map(([head, body]) => (
          <View key={head} style={styles.section}>
            <Text style={styles.head}>{head}</Text>
            <Text style={styles.body}>{body}</Text>
          </View>
        ))}
      </ScrollView>
    </Background>
  );
}

export function TermsScreen() {
  const { t } = useLanguage();
  return (
    <LegalDoc
      title={t("m.legal.termsTitle", { defaultValue: "Terms of Service" })}
      sections={[
        [
          "Eligibility",
          "IstaSeva is for adults. You must be at least 18 years old to create an account or use the service, and by creating an account you confirm that you are 18 or older. If we learn that an account belongs to someone under 18, we will suspend it and delete the associated personal data. This applies to the account holder — an adult may of course book stays or services for a family that includes children.",
        ],
        [
          "The service",
          "IstaSeva is a marketplace that connects travellers and customers with independent hosts, service providers and transport operators across India. Hosts and providers are independent businesses — IstaSeva facilitates discovery, booking and payment but is not the provider of the underlying accommodation, service or transport.",
        ],
        [
          "Accounts",
          "You must provide accurate information when creating an account and keep your sign-in credentials secure. Accounts that violate these terms, applicable law, or the safety of other users may be suspended or removed.",
        ],
        [
          "Bookings, payments and cancellations",
          "Prices, fees and taxes are shown before you pay. Payments are processed by our payment partner. Cancellation and refund terms are shown at booking time.",
        ],
        [
          "Closing your account",
          "You may delete your account at any time from Profile → Privacy & safety. On deletion: your profile, listings, messages and saved data are permanently removed; active listings are withdrawn from the marketplace; records we must keep under Indian tax and financial law (completed bookings, payments, invoices, payouts) are retained with personal details removed. Obligations arising before deletion survive account closure. Deletion does not automatically cancel upcoming bookings — cancel them first to receive any applicable refund.",
        ],
        [
          "Content",
          "You retain rights to content you post (listings, photos, reviews) and grant IstaSeva a licence to display it on the platform. Content that is unlawful, misleading or harmful may be removed.",
        ],
        [
          "Listings and non-discrimination",
          "Hosts and providers are solely responsible for the content of their listings — including any description of their property, services, house rules, or eligibility requirements — and for ensuring that content and their conduct comply with all applicable laws. IstaSeva does not collect or verify caste or community information, and does not determine or enforce any listing's eligibility requirements. Any such requirements a host chooses to describe are the host's own; review a listing's description before booking. We prohibit unlawful discrimination on our platform and may remove any listing or content that violates this policy or applicable law. To the extent permitted by law, IstaSeva is not liable for host-authored content or for the conduct of hosts, providers, or guests.",
        ],
        ["Governing law", "These terms are governed by the laws of India."],
      ]}
    />
  );
}

export function PrivacyPolicyScreen() {
  const { t } = useLanguage();
  return (
    <LegalDoc
      title={t("m.legal.privacyTitle", { defaultValue: "Privacy Policy" })}
      sections={[
        [
          "What we collect",
          "Account details (name, email, phone, profile photo, preferred language); identity verification documents you submit for KYC; booking details (addresses, dates, guests, notes); payment and payout records; messages and assistant conversations; reviews and photos; device and usage data (device identifiers, IP address, app events) used for analytics, fraud prevention and notifications.",
        ],
        [
          "Why we use it",
          "To operate the marketplace: create and manage bookings, process payments and refunds, verify hosts and providers, keep the platform safe, send booking and service notifications, provide customer support, and improve the product. Marketing communications are sent only with your opt-in consent, which you can withdraw at any time.",
        ],
        [
          "Who we share it with",
          "Service providers (processors) that power the platform: payment processing (Razorpay), cloud hosting and storage (Amazon Web Services), sign-in (Google Firebase Authentication), maps and location search (Google Maps), AI assistance and voice (Google Vertex AI / Gemini), usage analytics (Mixpanel, only if you allow analytics), transactional email and SMS (Amazon SES and Amazon SNS), and push notifications (Firebase Cloud Messaging). Hosts and providers see the booking details needed to deliver the service. We do not sell personal data.",
        ],
        [
          "Where your data is processed (cross-border transfers)",
          "Our primary systems run on Amazon Web Services in India (Mumbai, ap-south-1). Some processors — Google Firebase, Google Maps, Google Vertex AI, and Mixpanel — process data on global infrastructure, so your personal data may be stored or processed outside India, including in the United States. We share only what each processor needs, under that processor's data-protection terms, and we maintain a register of processors and transfer destinations.",
        ],
        [
          "Analytics and device tracking",
          "Usage analytics (a random device identifier, screens viewed and searches) is collected only after you turn on Usage analytics in Profile → Privacy & safety, and you can switch it off there at any time — turning it off also discards the device identifier. Essential features work without analytics.",
        ],
        [
          "How long we keep it",
          "Account data is kept while your account is active. Financial records (bookings, payments, invoices, payouts) are retained after account deletion for the periods required by Indian tax and financial law. Identity verification documents are deleted when your account is deleted. Analytics events expire automatically within one to two years.",
        ],
        [
          "Your rights: access, export and deletion",
          "You can download a copy of your personal data and delete your account from Profile → Privacy & safety. Deletion runs after a 48-hour grace period during which you can cancel the request. Once it runs, it removes your profile, listings, messages, saved data, uploaded documents and analytics identity across our systems, and we ask analytics processors to erase data keyed to your account; legally retained financial records are kept with personal details scrubbed. After the grace period, deletion is permanent and cannot be undone.",
        ],
        [
          "Children",
          "IstaSeva is not directed at children and we do not knowingly collect personal data from anyone under 18. Creating an account requires confirming that you are 18 or older, and we record that confirmation. If we learn that an account belongs to someone under 18, we suspend the account and delete its personal data through our standard account-deletion process. If you believe a minor holds an account, contact our grievance officer below.",
        ],
        [
          "Grievances",
          `Questions or complaints about your data go to our grievance officer at ${GRIEVANCE_EMAIL}. Complaints are acknowledged within 48 hours and resolved within 15 days.`,
        ],
      ]}
    />
  );
}

export function GrievanceScreen() {
  const { t } = useLanguage();
  return (
    <LegalDoc
      title={t("m.legal.grievanceTitle", { defaultValue: "Grievance Redressal" })}
      sections={[
        [
          "Grievance officer",
          `Grievance Officer: appointment pending\nEmail: ${GRIEVANCE_EMAIL}\nIstaSeva, Bengaluru, India`,
        ],
        [
          "What you can raise",
          "Complaints about listings, reviews or other content; privacy and personal-data concerns (including access, correction, export and deletion requests you could not complete in-app); payment and refund disputes; and safety incidents.",
        ],
        [
          "How it works",
          "Email the grievance officer with your registered email address, a description of the issue, and any booking or listing reference. Complaints are acknowledged within 48 hours and resolved within 15 days.",
        ],
      ]}
    />
  );
}

/**
 * Open-source licences (LEG-016). Renders the COMMITTED attribution data in
 * src/design/data/oss-licenses.json — regenerate with `npm run
 * licenses:generate` after dependency changes. The OFL-1.1 fonts and
 * Apache-2.0 packages that ship inside the binary require this attribution.
 */
type OssEntry = { name: string; version: string; license: string; copyright: string | null };

export function OssLicensesScreen() {
  const { t } = useLanguage();
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const packages = ossLicenses.packages as OssEntry[];
  return (
    <Background>
      <View style={{ paddingTop: insets.top }}>
        <AppBar title={t("m.legal.licensesTitle", { defaultValue: "Open-source licences" })} onBack={() => nav.goBack()} />
      </View>
      <FlatList
        data={packages}
        keyExtractor={(p) => `${p.name}@${p.version}`}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={24}
        ListHeaderComponent={
          <Text style={[styles.body, { marginBottom: 14 }]}>
            {t("m.legal.licensesIntro", {
              defaultValue: "IstaSeva is built with the open-source software below. Each package remains under its own licence.",
            })}
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.licenseRow}>
            <Text style={styles.licenseName}>{item.name} <Text style={styles.licenseVersion}>v{item.version}</Text></Text>
            <Text style={styles.licenseMeta}>{item.license}{item.copyright ? ` · ${item.copyright}` : ""}</Text>
          </View>
        )}
      />
    </Background>
  );
}

const styles = StyleSheet.create({
  version: { fontFamily: font.body, fontSize: 12.5, color: T.muted, marginBottom: 10 },
  licenseRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(0,0,0,0.08)" },
  licenseName: { fontFamily: font.head, fontSize: 13.5, color: T.ink },
  licenseVersion: { fontFamily: font.body, fontSize: 12, color: T.muted },
  licenseMeta: { fontFamily: font.body, fontSize: 12, color: T.muted, marginTop: 2 },
  draftNote: {
    borderRadius: 12, borderWidth: 1, borderColor: "rgba(180,130,40,0.35)",
    backgroundColor: "rgba(250,235,200,0.55)", padding: 12, marginBottom: 18,
  },
  draftNoteTxt: { fontFamily: font.body, fontSize: 12, color: "#7a5b16", lineHeight: 17 },
  section: { marginBottom: 18 },
  head: { fontFamily: font.head, fontSize: 16.5, color: T.ink, marginBottom: 6 },
  body: { fontFamily: font.body, fontSize: 13.5, color: T.muted, lineHeight: 20 },
});
