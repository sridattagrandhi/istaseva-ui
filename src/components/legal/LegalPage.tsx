import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { LEGAL_DOCS_VERSION } from "@/lib/legal";

/**
 * Shared layout for the legal/policy pages (/privacy, /terms, /grievance,
 * /refunds, /delete-account). Renders a title, version stamp, a
 * pending-legal-review notice while the copy is still an engineering draft,
 * and prose sections.
 */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-bold text-foreground">{title}</h2>
      <div className="text-sm text-muted-foreground leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

const LegalPage = ({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) => {
  const navigate = useNavigate();
  // Back to wherever the reader came from (dropdown, footer, signup link);
  // fall back to home when the page was opened directly (new tab / deep link).
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16 space-y-10">
        <header className="space-y-3">
          <button
            onClick={goBack}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors -ml-1 mb-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">
            Version {LEGAL_DOCS_VERSION} · Last updated {updated}
          </p>
          {LEGAL_DOCS_VERSION.includes("draft") && (
            <p className="text-xs rounded-lg border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2">
              Draft — this document describes current system behavior and is pending review by legal
              counsel. It will be replaced by the final version before general availability.
            </p>
          )}
        </header>
        {children}
      </div>
    </div>
  );
};

export default LegalPage;
