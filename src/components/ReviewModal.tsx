import { useState } from "react";
import { Star } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getReviewService } from "@/domains";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

interface ReviewModalProps {
  listingId: string;
  listingName: string;
  bookingId?: string;
  onClose: () => void;
  onSubmitted?: () => void;
}

const HALF_STEP = 0.5;

export default function ReviewModal({ listingId, listingName, bookingId, onClose, onSubmitted }: ReviewModalProps) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Returns the effective rating to display (hovered takes priority over selected)
  const display = hovered || rating;

  const handleMouseMove = (starIndex: number, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const half = e.clientX < rect.left + rect.width / 2;
    setHovered(starIndex - (half ? HALF_STEP : 0));
  };

  const handleClick = (starIndex: number, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const half = e.clientX < rect.left + rect.width / 2;
    setRating(starIndex - (half ? HALF_STEP : 0));
    setHovered(0);
  };

  const handleSubmit = async () => {
    if (!rating) { toast.error(t("reviewModal.errSelectRating", { defaultValue: "Please select a star rating first." })); return; }
    if (!user?.id) { toast.error(t("reviewModal.errSignedIn", { defaultValue: "You must be signed in to leave a review." })); return; }
    setSubmitting(true);
    try {
      const result = await getReviewService().create({
        userId: user.id,
        stayId: listingId,
        rating,
        reviewText: comment.trim(),
        displayName: user.name || user.email?.split("@")[0] || t("reviewModal.guest", { defaultValue: "Guest" }),
        bookingId,
      });
      if (!result.success) throw new Error(result.error || t("reviewModal.errSubmit", { defaultValue: "Failed to submit review" }));
      toast.success(t("reviewModal.toastSubmitted", { defaultValue: "Review submitted — thank you!" }));
      onSubmitted?.();
      onClose();
    } catch (err: any) {
      toast.error(err.message || t("reviewModal.errSubmitGeneric", { defaultValue: "Could not submit review" }));
    } finally {
      setSubmitting(false);
    }
  };

  const ratingLabel = rating >= 5 ? t("reviewModal.ratingExcellent", { defaultValue: "Excellent!" }) : rating >= 4 ? t("reviewModal.ratingVeryGood", { defaultValue: "Very Good" }) : rating >= 3 ? t("reviewModal.ratingGood", { defaultValue: "Good" }) : rating >= 2 ? t("reviewModal.ratingFair", { defaultValue: "Fair" }) : rating > 0 ? t("reviewModal.ratingPoor", { defaultValue: "Poor" }) : "";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("reviewModal.title", { defaultValue: "Write a review" })}</DialogTitle>
          <DialogDescription className="truncate">{listingName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-1">
          {/* Star rating */}
          <div>
            <p className="text-sm font-medium mb-2">{t("reviewModal.yourRating", { defaultValue: "Your rating" })} <span className="text-destructive">*</span></p>
            <div className="flex items-center gap-1" onMouseLeave={() => setHovered(0)}>
              {[1, 2, 3, 4, 5].map((star) => {
                const filled = display >= star;
                const half = !filled && display >= star - HALF_STEP;
                return (
                  <button
                    key={star}
                    type="button"
                    className="relative w-9 h-9 flex items-center justify-center transition-transform hover:scale-110 focus:outline-none"
                    onMouseMove={(e) => handleMouseMove(star, e)}
                    onClick={(e) => handleClick(star, e)}
                  >
                    {/* Background (empty) star */}
                    <Star className="w-7 h-7 text-muted stroke-muted-foreground/30 fill-muted" />
                    {/* Filled overlay — full or half via clip */}
                    {(filled || half) && (
                      <span
                        className="absolute inset-0 flex items-center justify-center overflow-hidden"
                        style={half ? { clipPath: "inset(0 50% 0 0)" } : undefined}
                      >
                        <Star className="w-7 h-7 fill-yellow-400 text-yellow-400" />
                      </span>
                    )}
                  </button>
                );
              })}
              {ratingLabel && (
                <span className="ml-2 text-sm font-medium text-yellow-600">{ratingLabel}</span>
              )}
            </div>
            {rating > 0 && (
              <p className="text-xs text-muted-foreground mt-1">{t("reviewModal.starsOf5", { defaultValue: "{{rating}} / 5 stars", rating })}</p>
            )}
          </div>

          {/* Comment */}
          <div>
            <label className="text-sm font-medium block mb-1.5">
              {t("reviewModal.comment", { defaultValue: "Comment" })} <span className="text-muted-foreground font-normal">{t("reviewModal.optional", { defaultValue: "(optional)" })}</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t("reviewModal.commentPlaceholder", { defaultValue: "Share your experience — what did you love? Any tips for future guests?" })}
              rows={4}
              maxLength={1000}
              className="w-full px-3 py-2.5 border border-border rounded-xl text-sm bg-background resize-none outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all"
            />
            <p className="text-[10px] text-muted-foreground text-right mt-0.5">{comment.length}/1000</p>
          </div>

          {/* Reviewer name preview */}
          {(rating > 0 || comment) && (
            <div className="bg-muted/40 rounded-xl p-3 text-xs text-muted-foreground flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-[10px] shrink-0">
                {(user?.name || user?.email || "G").slice(0, 2).toUpperCase()}
              </div>
              <span>
                <span className="font-medium text-foreground">{user?.name || user?.email?.split("@")[0] || t("reviewModal.guest", { defaultValue: "Guest" })}</span>
                {" · "}
                {rating > 0 && `${rating}★`}
                {comment && rating > 0 && " · "}
                {comment && `"${comment.slice(0, 60)}${comment.length > 60 ? "…" : ""}"`}
              </span>
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={onClose} disabled={submitting}>
              {t("reviewModal.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              className="flex-1 rounded-xl font-semibold"
              onClick={handleSubmit}
              disabled={!rating || submitting}
            >
              {submitting ? t("reviewModal.submitting", { defaultValue: "Submitting…" }) : t("reviewModal.submit", { defaultValue: "Submit review" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
