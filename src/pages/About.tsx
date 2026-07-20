import { Globe, Heart, MapPin, TrendingUp, Users, Zap } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const About = () => {
  const { t } = useLanguage();
  const values = [
    { icon: MapPin, title: t("about.values.localFirst.title", { defaultValue: "Local-First" }), desc: t("about.values.localFirst.desc", { defaultValue: "We prioritize India's underserved towns and villages, bringing them the same digital convenience that metros enjoy." }) },
    { icon: Globe, title: t("about.values.multilingual.title", { defaultValue: "Multilingual by Design" }), desc: t("about.values.multilingual.desc", { defaultValue: "Every interface, every interaction — designed to work in 7 Indian languages from day one." }) },
    { icon: Heart, title: t("about.values.community.title", { defaultValue: "Community Empowerment" }), desc: t("about.values.community.desc", { defaultValue: "We create income opportunities for local hosts, families, and skilled workers in their own neighborhoods." }) },
    { icon: TrendingUp, title: t("about.values.tourism.title", { defaultValue: "Tourism Growth" }), desc: t("about.values.tourism.desc", { defaultValue: "We're helping India's smaller destinations become accessible, bookable, and discoverable." }) },
    { icon: Users, title: t("about.values.trust.title", { defaultValue: "Trust & Inclusion" }), desc: t("about.values.trust.desc", { defaultValue: "Every listing and provider is verified. Every user is valued, regardless of their tech experience." }) },
    { icon: Zap, title: t("about.values.instant.title", { defaultValue: "Instant & Simple" }), desc: t("about.values.instant.desc", { defaultValue: "From search to booking, everything is designed to be fast, clear, and frictionless." }) },
  ];

  const stats = [
    { value: "50+", label: t("about.stats.towns", { defaultValue: "Towns & Cities" }) },
    { value: "10,000+", label: t("about.stats.customers", { defaultValue: "Happy Customers" }) },
    { value: "2,500+", label: t("about.stats.hosts", { defaultValue: "Hosts & Providers" }) },
    { value: "7", label: t("about.stats.languages", { defaultValue: "Languages Supported" }) },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <section className="bg-gradient-to-br from-primary/5 to-accent/5 py-16 lg:py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mb-6">
            {t("about.hero.titleLead", { defaultValue: "Building Hospitality Infrastructure for" })} <span className="text-primary">{t("about.hero.titleHighlight", { defaultValue: "Bharat" })}</span>
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-3xl mx-auto">
            {t("about.hero.subtitle", { defaultValue: "IstaSeva exists to bring modern booking and service access to India's underserved towns and villages. We believe every small town deserves the same digital convenience, trust, and opportunity that major cities have." })}
          </p>
        </div>
      </section>

      {/* Stats */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          {stats.map((s) => (
            <div key={s.label} className="text-center p-6 bg-card rounded-2xl border border-border">
              <div className="text-3xl font-bold text-primary font-display">{s.value}</div>
              <div className="text-sm text-muted-foreground mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Story */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <h2 className="font-display text-2xl font-bold mb-6">{t("about.story.title", { defaultValue: "Our Story" })}</h2>
        <div className="prose prose-muted text-muted-foreground space-y-4 text-base leading-relaxed">
          <p>{t("about.story.p1", { defaultValue: "India is a country of 640,000+ villages and thousands of small towns. Yet, when it comes to travel, booking, and local services, most digital platforms focus only on metros and Tier 1 cities." })}</p>
          <p>{t("about.story.p2", { defaultValue: "We saw a gap — and an opportunity. Millions of travelers visit temple towns, heritage sites, family hometowns, and rural destinations every year. They struggle to find clean, affordable stays and reliable local help. Meanwhile, local hotel owners, families with spare rooms, and skilled workers have no easy way to reach these travelers." })}</p>
          <p>{t("about.story.p3", { defaultValue: "IstaSeva bridges this gap. We combine hotel booking, homestay booking, and instant local services into one unified, multilingual platform — purpose-built for India beyond the metros." })}</p>
          <p>{t("about.story.p4", { defaultValue: "Our vision is simple: whether you need a room in Hampi, a homestay in Alleppey, or a plumber in Kumbakonam, IstaSeva can help you — instantly, in your language, with trust." })}</p>
        </div>
      </section>

      {/* Values */}
      <section className="bg-muted/50 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-center mb-12">{t("about.valuesTitle", { defaultValue: "What We Stand For" })}</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {values.map((v, i) => (
              <div key={i} className="p-6 bg-card rounded-2xl border border-border">
                <v.icon className="w-8 h-8 text-primary mb-4" />
                <h3 className="font-display font-semibold mb-2">{v.title}</h3>
                <p className="text-sm text-muted-foreground">{v.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Team Vision */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h2 className="font-display text-2xl font-bold mb-4">{t("about.mission.title", { defaultValue: "Join Our Mission" })}</h2>
        <p className="text-muted-foreground max-w-2xl mx-auto mb-6">
          {t("about.mission.desc", { defaultValue: "We're a passionate team of builders, designers, and dreamers committed to digital inclusion and local empowerment. If you share our vision for making India's small towns more accessible and connected, we'd love to hear from you." })}
        </p>
        <p className="text-sm text-muted-foreground">📧 careers@istasewa.in</p>
      </section>
    </div>
  );
};

export default About;
