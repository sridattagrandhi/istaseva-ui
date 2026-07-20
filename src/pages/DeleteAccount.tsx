import { Link } from "react-router-dom";
import LegalPage, { LegalSection } from "@/components/legal/LegalPage";
import { GRIEVANCE_EMAIL } from "@/lib/legal";

/**
 * Public account-deletion page (LEG-017). Google Play requires a deletion
 * URL reachable WITHOUT signing in, so this page is intentionally
 * unauthenticated: it explains the flow and points signed-in users at the
 * in-app path, with an email fallback for users who lost access.
 */
const DeleteAccount = () => (
  <LegalPage title="Delete Your Account" updated="13 July 2026">
    <LegalSection title="Delete from the app or website">
      <p>
        Sign in, open the account menu, then go to <strong>Profile &amp; privacy → Delete
        account</strong>. You&apos;ll be asked to confirm; for security you must have signed in
        recently. Deletion runs after a <strong>48-hour grace period</strong> — your account keeps
        working until then and you can cancel the request from the same page. We also email you
        when a deletion is scheduled, so you can step in if you didn&apos;t request it. Once the
        grace period ends, erasure begins and you are signed out everywhere.
      </p>
      <p>
        <Link to="/login" className="text-primary underline">Sign in to get started</Link>
      </p>
    </LegalSection>

    <LegalSection title="What gets deleted">
      <p>
        Your profile, sign-in identity, listings, messages, reviews, saved places, uploaded
        documents (including KYC), notification tokens and analytics identity are permanently
        removed from our systems. Records we are legally required to keep under Indian tax and
        financial law — completed bookings, payments, invoices and payouts — are retained with
        your personal details removed. Deletion is permanent and cannot be undone.
      </p>
    </LegalSection>

    <LegalSection title="Before you delete">
      <p>
        Deletion does not automatically cancel upcoming bookings — cancel them first to receive
        any applicable refund. You can also download a copy of your data first from{" "}
        <strong>Profile &amp; privacy → Download my data</strong>.
      </p>
    </LegalSection>

    <LegalSection title="Lost access to your account?">
      <p>
        Email{" "}
        <a href={`mailto:${GRIEVANCE_EMAIL}`} className="text-primary underline">{GRIEVANCE_EMAIL}</a>{" "}
        from the email address registered to the account and we&apos;ll verify your identity and
        process the deletion.
      </p>
    </LegalSection>
  </LegalPage>
);

export default DeleteAccount;
