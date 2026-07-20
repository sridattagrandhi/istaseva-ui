import { Link } from "react-router-dom";
import LegalPage, { LegalSection } from "@/components/legal/LegalPage";

/**
 * Terms of Service (LEG-001 / LEG-004). Engineering draft pending counsel —
 * the account-termination clause reflects the implemented deletion behavior.
 */
const Terms = () => (
  <LegalPage title="Terms of Service" updated="15 July 2026">
    <LegalSection title="Eligibility">
      <p>
        IstaSeva is for adults. You must be at least 18 years old to create an account or use the
        service, and by creating an account you confirm that you are 18 or older. If we learn that
        an account belongs to someone under 18, we will suspend it and delete the associated
        personal data. This applies to the account holder — an adult may of course book stays or
        services for a family that includes children.
      </p>
    </LegalSection>

    <LegalSection title="The service">
      <p>
        IstaSeva is a marketplace that connects travellers and customers with independent hosts,
        service providers and transport operators across India. Hosts and providers are
        independent businesses — IstaSeva facilitates discovery, booking and payment but is not
        the provider of the underlying accommodation, service or transport.
      </p>
    </LegalSection>

    <LegalSection title="Accounts">
      <p>
        You must provide accurate information when creating an account and keep your sign-in
        credentials secure. Accounts that violate these terms, applicable law, or the safety of
        other users may be suspended or removed.
      </p>
    </LegalSection>

    <LegalSection title="Bookings, payments and cancellations">
      <p>
        Prices, fees and taxes are shown before you pay. Payments are processed by our payment
        partner. Cancellation and refund terms are shown at booking time and summarised in the{" "}
        <Link to="/refunds" className="text-primary underline">cancellation &amp; refunds policy</Link>.
      </p>
    </LegalSection>

    <LegalSection title="Closing your account">
      <p>
        You may delete your account at any time from your dashboard or the{" "}
        <Link to="/delete-account" className="text-primary underline">account deletion page</Link>.
        On deletion: your profile, listings, messages and saved data are permanently removed;
        active listings are withdrawn from the marketplace; records we must keep under Indian tax
        and financial law (completed bookings, payments, invoices, payouts) are retained with
        personal details removed. Obligations arising before deletion — for example amounts owed,
        ongoing disputes, or in-progress bookings — survive account closure. Deletion does not
        automatically cancel upcoming bookings; cancel them first to receive any applicable
        refund.
      </p>
    </LegalSection>

    <LegalSection title="Content">
      <p>
        You retain rights to content you post (listings, photos, reviews) and grant IstaSeva a
        licence to display it on the platform. Content that is unlawful, misleading or harmful
        may be removed; see the <Link to="/grievance" className="text-primary underline">grievance page</Link>{" "}
        to report content.
      </p>
    </LegalSection>

    <LegalSection title="Listings and non-discrimination">
      <p>
        Hosts and providers are solely responsible for the content of their listings, including
        any description of their property, services, house rules, or eligibility requirements,
        and for ensuring that content and their conduct comply with all applicable laws.
      </p>
      <p>
        IstaSeva does not collect or verify caste or community information, and does not
        determine or enforce any listing&apos;s eligibility requirements. Any such requirements a
        host chooses to describe are the host&apos;s own; we recommend you review a listing&apos;s
        description before booking. We prohibit unlawful discrimination on our platform and may
        remove any listing or content that violates this policy or applicable law. To the extent
        permitted by law, IstaSeva is not liable for host-authored content or for the conduct of
        hosts, providers, or guests.
      </p>
    </LegalSection>

    <LegalSection title="Governing law">
      <p>These terms are governed by the laws of India.</p>
    </LegalSection>
  </LegalPage>
);

export default Terms;
