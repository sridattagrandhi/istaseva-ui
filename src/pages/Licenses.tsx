import LegalPage, { LegalSection } from "@/components/legal/LegalPage";
import { useLanguage } from "@/contexts/LanguageContext";
import ossLicenses from "@/data/oss-licenses.json";

type OssEntry = {
  name: string;
  version: string;
  license: string;
  copyright: string | null;
};

/**
 * Open-source attributions (LEG-016). Renders the COMMITTED data in
 * src/data/oss-licenses.json — regenerate with `npm run licenses:generate`
 * after dependency changes. The Apache-2.0 packages shipped in the web
 * bundle require notice preservation; the mobile app has its own mirror
 * screen (its dependency set differs).
 */
const Licenses = () => {
  const { t } = useLanguage();
  const packages = ossLicenses.packages as OssEntry[];
  return (
    <LegalPage title={t("licenses.title", { defaultValue: "Open-source licences" })} updated="15 July 2026">
      <LegalSection title={t("licenses.heading", { defaultValue: "Software we build on" })}>
        <p>
          {t("licenses.intro", {
            defaultValue:
              "IstaSeva is built with the open-source software below. Each package remains under its own licence; names, versions and copyright notices are reproduced here as those licences require.",
          })}
        </p>
        <ul className="divide-y divide-border">
          {packages.map((p) => (
            <li key={`${p.name}@${p.version}`} className="py-2">
              <span className="font-medium text-foreground">{p.name}</span>{" "}
              <span className="text-xs">v{p.version}</span>
              <div className="text-xs">
                {p.license}
                {p.copyright ? ` · ${p.copyright}` : ""}
              </div>
            </li>
          ))}
        </ul>
      </LegalSection>
    </LegalPage>
  );
};

export default Licenses;
