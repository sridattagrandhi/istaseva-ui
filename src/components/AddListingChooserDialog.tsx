import { useNavigate } from "react-router-dom";
import { Sparkles, ClipboardList, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";

const NOUN: Record<string, string> = {
  host: "property",
  service: "service",
  transport: "vehicle",
};

/**
 * "How do you want to add your listing?" chooser. Replaces the redundant
 * Onboarding + Add toolbar pair on the three partner dashboards: both buttons
 * led to the same /onboarding surface in different modes, eating two toolbar
 * slots (and wrapping the toolbar). One "+ Add" now opens this dialog; the
 * choice of AI-guided vs manual form lives at the moment of intent. Both
 * destination pages keep their own AI/form switch, so a "wrong" pick is
 * recoverable mid-flow.
 */
export function AddListingChooserDialog({
  open,
  onOpenChange,
  type,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Onboarding type param — "host" | "service" | "transport". Omitted on the
   * unfiltered guest Listings tab (it spans all three types); the onboarding
   * surface then asks for the type itself.
   */
  type?: "host" | "service" | "transport";
}) {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const noun = type
    ? t(`addChooser.noun_${type}`, { defaultValue: NOUN[type] ?? "listing" })
    : t("addChooser.noun_listing", { defaultValue: "listing" });
  const typeParam = type ? `type=${type}` : "";
  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addChooser.title", { defaultValue: "Add a {{noun}}", noun })}</DialogTitle>
          <DialogDescription>{t("addChooser.sub", { defaultValue: "How would you like to set it up?" })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <button
            type="button"
            onClick={() => go(typeParam ? `/onboarding?${typeParam}` : "/onboarding")}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted/60"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{t("addChooser.ai", { defaultValue: "With the AI assistant" })}</span>
              <span className="block text-xs text-muted-foreground">{t("addChooser.aiSub", { defaultValue: "Answer a few questions in chat — recommended" })}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <button
            type="button"
            onClick={() => go(typeParam ? `/onboarding?mode=form&${typeParam}` : "/onboarding?mode=form")}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-muted/60"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <ClipboardList className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{t("addChooser.form", { defaultValue: "Fill the form myself" })}</span>
              <span className="block text-xs text-muted-foreground">{t("addChooser.formSub", { defaultValue: "Classic step-by-step form, full control" })}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
