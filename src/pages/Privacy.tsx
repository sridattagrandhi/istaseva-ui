import { Link } from "react-router-dom";
import LegalPage, { LegalSection } from "@/components/legal/LegalPage";
import { GRIEVANCE_EMAIL } from "@/lib/legal";

/**
 * Privacy Policy (PRIV-001 / LEG-001). Engineering draft: the section
 * contents accurately reflect what the system collects, shares, retains and
 * deletes — counsel supplies the binding wording before launch.
 */
const Privacy = () => (
  <LegalPage title="Privacy Policy" updated="15 July 2026">
    <LegalSection title="What we collect">
      <p>
        Account details (name, email, phone, profile photo, preferred language); identity
        verification documents you submit for KYC; booking details (addresses, dates, guests,
        notes); payment and payout records; messages and assistant conversations; reviews and
        photos; device and usage data (device identifiers, IP address, app events) used for
        analytics, fraud prevention and notifications.
      </p>
    </LegalSection>

    <LegalSection title="Why we use it">
      <p>
        To operate the marketplace: create and manage bookings, process payments and refunds,
        verify hosts and providers, keep the platform safe, send booking and service
        notifications, provide customer support, and improve the product. Marketing
        communications are sent only with your opt-in consent, which you can withdraw at any time
        from your dashboard.
      </p>
    </LegalSection>

    <LegalSection title="Who we share it with">
      <p>
        Service providers (processors) that power the platform: payment processing (Razorpay),
        cloud hosting and storage (Amazon Web Services), sign-in (Google Firebase Authentication),
        maps and location search (Google Maps), AI assistance and voice (Google Vertex AI /
        Gemini), usage analytics (Mixpanel, only if you allow analytics), transactional email and
        SMS (Amazon SES and Amazon SNS), and push notifications (Firebase Cloud Messaging). Hosts
        and providers see the booking details needed to deliver the service. We do not sell
        personal data.
      </p>
    </LegalSection>

    <LegalSection title="Where your data is processed (cross-border transfers)">
      <p>
        Our primary systems run on Amazon Web Services in India (Mumbai, ap-south-1). Some of the
        processors above — Google Firebase, Google Maps, Google Vertex AI, and Mixpanel — process
        data on global infrastructure, which means your personal data may be stored or processed
        outside India, including in the United States. We share only what each processor needs to
        provide its service, under that processor&apos;s data-protection terms, and we maintain a
        register of processors and transfer destinations that we review before adding a new one.
      </p>
    </LegalSection>

    <LegalSection title="Analytics and device tracking">
      <p>
        Usage analytics (a random device identifier, pages viewed and searches) is collected only
        after you allow it in the analytics banner or in Profile &amp; privacy, and you can switch
        it off there at any time — turning it off also discards the device identifier. Essential
        storage needed to keep you signed in and remember your language works without analytics.
      </p>
    </LegalSection>

    <LegalSection title="How long we keep it">
      <p>
        Account data is kept while your account is active. Financial records (bookings, payments,
        invoices, payouts) are retained after account deletion for the periods required by Indian
        tax and financial law. Identity verification documents are deleted when your account is
        deleted. Analytics events expire automatically within one to two years.
      </p>
    </LegalSection>

    <LegalSection title="Your rights: access, export and deletion">
      <p>
        You can download a copy of your personal data and permanently delete your account from
        your profile page (menu → Profile &amp; privacy), or from the{" "}
        <Link to="/delete-account" className="text-primary underline">account deletion page</Link>.
        Deletion runs after a 48-hour grace period during which you can cancel the request.
        Once it runs, it removes your profile, listings, messages, saved data, uploaded documents
        and analytics identity across our systems, and we ask analytics processors to erase data
        keyed to your account; legally retained financial records are kept with personal details
        scrubbed. After the grace period, deletion is permanent and cannot be undone.
      </p>
    </LegalSection>

    <LegalSection title="Children">
      <p>
        IstaSeva is not directed at children and we do not knowingly collect personal data from
        anyone under 18. Creating an account requires confirming that you are 18 or older, and we
        record that confirmation. If we learn that an account belongs to someone under 18, we
        suspend the account and delete its personal data through our standard account-deletion
        process. If you believe a minor holds an account, contact our grievance officer below.
      </p>
    </LegalSection>

    <LegalSection title="Grievances">
      <p>
        Questions or complaints about your data go to our grievance officer at{" "}
        <a href={`mailto:${GRIEVANCE_EMAIL}`} className="text-primary underline">{GRIEVANCE_EMAIL}</a>{" "}
        — see the <Link to="/grievance" className="text-primary underline">grievance page</Link> for
        the process and response times.
      </p>
    </LegalSection>
  </LegalPage>
);

export default Privacy;
