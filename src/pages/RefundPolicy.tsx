import LegalPage, { LegalSection } from "@/components/legal/LegalPage";

/**
 * Cancellation & refunds (LEG-008). Draft summary — the binding,
 * category-specific matrix must match server-side cancellation behavior and
 * is pending Legal/CFO sign-off.
 */
const RefundPolicy = () => (
  <LegalPage title="Cancellation & Refunds" updated="13 July 2026">
    <LegalSection title="How cancellations work">
      <p>
        Each listing shows its cancellation terms before you pay, and the exact refund amount is
        computed and shown when you cancel from your dashboard. The amount depends on the listing
        category, how far in advance you cancel, and the host or provider&apos;s policy shown at
        booking time.
      </p>
    </LegalSection>

    <LegalSection title="Refund processing">
      <p>
        Approved refunds are returned to the original payment method via our payment partner,
        typically within 5–7 business days of the cancellation, depending on your bank.
        Platform fees and payment-gateway charges may be non-refundable where stated at checkout.
      </p>
    </LegalSection>

    <LegalSection title="Disputes">
      <p>
        If a service was not delivered as described, raise it from the booking in your dashboard
        or through the grievance process within 48 hours of the scheduled service.
      </p>
    </LegalSection>
  </LegalPage>
);

export default RefundPolicy;
