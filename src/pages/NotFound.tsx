import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { MapPin, Home, Search, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

const NotFound = () => {
  const location = useLocation();
  const { t } = useLanguage();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="w-24 h-24 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-6">
          <MapPin className="w-12 h-12" />
        </div>
        <h1 className="font-display text-6xl font-extrabold text-primary mb-2">404</h1>
        <h2 className="font-display text-xl font-bold text-foreground mb-3">{t("notFound.title", { defaultValue: "Page Not Found" })}</h2>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          {t("notFound.description", { defaultValue: "Looks like this page doesn't exist. It might have been moved, or you may have mistyped the URL." })}
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button className="rounded-full font-semibold shadow-md shadow-primary/20" asChild>
            <Link to="/"><Home className="w-4 h-4 mr-2" />{t("notFound.backHome", { defaultValue: "Back to Home" })}</Link>
          </Button>
          <Button variant="outline" className="rounded-full font-semibold" asChild>
            <Link to="/explore"><Search className="w-4 h-4 mr-2" />{t("notFound.exploreStays", { defaultValue: "Explore Stays" })}</Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-8">
          {t("notFound.triedToAccess", { defaultValue: "Tried to access:" })} <code className="px-2 py-0.5 bg-muted rounded text-foreground">{location.pathname}</code>
        </p>
      </div>
    </div>
  );
};

export default NotFound;
