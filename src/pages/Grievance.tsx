import LegalPage, { LegalSection } from "@/components/legal/LegalPage";
import { GRIEVANCE_EMAIL } from "@/lib/legal";

/**
 * Grievance redressal (LEG-006, IT Rules / DPDP). The named officer is a
 * placeholder pending appointment — required before launch.
 */
const Grievance = () => (
  <LegalPage title="Grievance Redressal" updated="13 July 2026">
    <LegalSection title="Grievance officer">
      <p>
        Grievance Officer: <em>appointment pending</em>
        <br />
        Email: <a href={`mailto:${GRIEVANCE_EMAIL}`} className="text-primary underline">{GRIEVANCE_EMAIL}</a>
        <br />
        IstaSeva, Bengaluru, India
      </p>
    </LegalSection>

    <LegalSection title="What you can raise">
      <p>
        Complaints about listings, reviews or other content; privacy and personal-data concerns
        (including access, correction, export and deletion requests you could not complete
        in-app); payment and refund disputes; and safety incidents.
      </p>
    </LegalSection>

    <LegalSection title="How it works">
      <p>
        Email the grievance officer with your registered email address, a description of the
        issue, and any booking or listing reference. Complaints are acknowledged within 48 hours
        and resolved within 15 days. Content takedown requests are actioned within the timelines
        required by the IT Rules.
      </p>
    </LegalSection>
  </LegalPage>
);

export default Grievance;
