import { Star, ThumbsUp, Send } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useDynamicTranslation } from "@/hooks/useDynamicTranslation";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { getReviewService } from "@/domains";

interface Review {
  id: string;
  user_id: string;
  stay_id: string;
  rating: number;
  review_text: string;
  tags: string[];
  helpful_count: number;
  display_name: string;
  created_at: string;
}

const TAG_OPTIONS = ["Clean", "Great Host", "Value for Money", "Amazing View", "Great Food", "Family Friendly", "Excellent Service", "Good Location", "Peaceful", "Cozy"];

type ReviewFilter = "all" | "5" | "4" | "3" | "2" | "1";
type ReviewSort = "best" | "newest" | "most_helpful";

const ReviewsSection = ({ stayId, stayRating, reviewCount }: { stayId: string; stayRating: number; reviewCount: number }) => {
  const { t } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  // Translate a tag for display only. The stored/sent value stays the
  // canonical English id from TAG_OPTIONS so the backend filter is stable.
  const tagLabel = (tag: string) =>
    t(`reviewsSection.tag.${tag.replace(/\s+/g, "")}`, { defaultValue: tag });
  const location = useLocation();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [showForm, setShowForm] = useState(false);
  // Filter + sort controls. Kept lightweight — these only read from the
  // already-fetched list, no refetch on change.
  const [ratingFilter, setRatingFilter] = useState<ReviewFilter>("all");
  const [sortBy, setSortBy] = useState<ReviewSort>("best");

  // Form state
  const [newRating, setNewRating] = useState(5);
  const [newText, setNewText] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const fetchReviews = async () => {
    const result = await getReviewService().getByStayId(stayId);
    if (result.success && result.data) {
      setReviews(result.data.map((review) => ({
        id: review.id,
        user_id: review.userId,
        stay_id: review.stayId,
        rating: review.rating,
        review_text: review.reviewText,
        tags: review.tags,
        helpful_count: review.helpfulCount,
        display_name: review.displayName,
        created_at: review.createdAt,
      })));
    }
    setLoading(false);
  };

  useEffect(() => { fetchReviews(); }, [stayId]);

  useEffect(() => {
    if (location.hash === "#reviews") {
      const section = document.getElementById("reviews");
      if (section) {
        setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
      }
    }
  }, [location.hash]);

  // Auto-open the "Write a review" form when the user arrives from the
  // Guest Dashboard → Completed bookings → Write a review shortcut.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("write_review") === "1" && isAuthenticated) {
      setShowForm(true);
    }
  }, [location.search, isAuthenticated]);

  const handleSubmit = async () => {
    if (!user) return;
    if (!newText.trim() || newText.trim().length < 10) {
      toast.error(t("reviewsSection.errMinLength", { defaultValue: "Review must be at least 10 characters" }));
      return;
    }
    if (newText.length > 1000) {
      toast.error(t("reviewsSection.errMaxLength", { defaultValue: "Review must be under 1000 characters" }));
      return;
    }

    setSubmitting(true);
    const result = await getReviewService().create({
      userId: user.id,
      stayId,
      rating: newRating,
      reviewText: newText.trim(),
      tags: newTags,
      displayName: user.name || t("reviewsSection.guest", { defaultValue: "Guest" }),
    });

    if (!result.success) {
      toast.error(t("reviewsSection.errSubmit", { defaultValue: "Failed to submit review. Please try again." }));
    } else {
      toast.success(t("reviewsSection.toastSubmitted", { defaultValue: "Review submitted!" }));
      setNewText("");
      setNewRating(5);
      setNewTags([]);
      setShowForm(false);
      fetchReviews();
    }
    setSubmitting(false);
  };

  const handleHelpful = async (reviewId: string) => {
    const review = reviews.find(r => r.id === reviewId);
    if (!review) return;
    await getReviewService().markHelpful(reviewId);
    setReviews(prev => prev.map(r => r.id === reviewId ? { ...r, helpful_count: r.helpful_count + 1 } : r));
  };

  const dist = [0, 0, 0, 0, 0];
  reviews.forEach(r => dist[r.rating - 1]++);
  const reversedDist = [...dist].reverse();

  const avgRating = reviews.length > 0
    ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
    : stayRating;

  const totalReviews = reviews.length || reviewCount;

  // Apply filter + sort on every render — cheap, list is small.
  const filteredReviews = ratingFilter === "all"
    ? reviews
    : reviews.filter((r) => r.rating === Number(ratingFilter));
  const sortedReviews = [...filteredReviews].sort((a, b) => {
    if (sortBy === "newest") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (sortBy === "most_helpful") return (b.helpful_count || 0) - (a.helpful_count || 0);
    // "best" = rating desc, then helpful_count desc as tiebreak — this is what
    // powers the "top 3 best reviews" surfacing the user asked for.
    return b.rating - a.rating || (b.helpful_count || 0) - (a.helpful_count || 0);
  });
  const displayed = showAll ? sortedReviews : sortedReviews.slice(0, 3);
  const { translated: translatedReviewTexts } = useDynamicTranslation(displayed.map((r) => r.review_text));

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  };

  return (
    <div id="reviews" className="border-t border-border pt-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display font-semibold text-lg flex items-center gap-2">
          <Star className="w-5 h-5 fill-secondary text-secondary" />
          {t("reviewsSection.ratingCount", { defaultValue: "{{rating}} · {{count}} reviews", rating: avgRating, count: totalReviews })}
        </h2>
        {isAuthenticated && (
          <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setShowForm(!showForm)}>
            {showForm ? t("reviewsSection.cancel", { defaultValue: "Cancel" }) : t("reviewsSection.writeReview", { defaultValue: "Write a Review" })}
          </Button>
        )}
      </div>

      {/* Write Review Form */}
      {showForm && isAuthenticated && (
        <div className="mb-6 p-4 bg-muted/50 rounded-xl border border-border/50 space-y-4">
          <div>
            <p className="text-sm font-medium mb-2">{t("reviewsSection.yourRating", { defaultValue: "Your Rating" })}</p>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map(s => (
                <button key={s} onClick={() => setNewRating(s)} className="p-0.5">
                  <Star className={`w-6 h-6 transition-colors ${s <= newRating ? "fill-secondary text-secondary" : "text-muted-foreground/30 hover:text-secondary/50"}`} />
                </button>
              ))}
              <span className="text-sm text-muted-foreground ml-2">{t("reviewsSection.ratingOf5", { defaultValue: "{{rating}}/5", rating: newRating })}</span>
            </div>
          </div>
          <div>
            <p className="text-sm font-medium mb-2">{t("reviewsSection.yourReview", { defaultValue: "Your Review" })}</p>
            <Textarea
              value={newText}
              onChange={e => setNewText(e.target.value)}
              placeholder={t("reviewsSection.reviewPlaceholder", { defaultValue: "Tell others about your experience..." })}
              className="min-h-[100px] rounded-xl"
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground mt-1">{newText.length}/1000</p>
          </div>
          <div>
            <p className="text-sm font-medium mb-2">{t("reviewsSection.tagsOptional", { defaultValue: "Tags (optional)" })}</p>
            <div className="flex flex-wrap gap-2">
              {TAG_OPTIONS.map(tag => (
                <button
                  key={tag}
                  onClick={() => setNewTags(prev => prev.includes(tag) ? prev.filter(x => x !== tag) : [...prev, tag])}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    newTags.includes(tag) ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  {tagLabel(tag)}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={handleSubmit} disabled={submitting} className="rounded-xl gap-2">
            <Send className="w-4 h-4" /> {submitting ? t("reviewsSection.submitting", { defaultValue: "Submitting..." }) : t("reviewsSection.submitReview", { defaultValue: "Submit Review" })}
          </Button>
        </div>
      )}

      {/* Rating Breakdown */}
      {reviews.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
          <div className="space-y-2">
            {[5, 4, 3, 2, 1].map((star, i) => (
              <div key={star} className="flex items-center gap-3 text-sm">
                <span className="w-12 text-muted-foreground">{t("reviewsSection.starLabel", { defaultValue: "{{star}} star", star })}</span>
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-secondary rounded-full transition-all" style={{ width: `${reviews.length ? (reversedDist[i] / reviews.length) * 100 : 0}%` }} />
                </div>
                <span className="w-6 text-muted-foreground text-right">{reversedDist[i]}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col items-center justify-center p-4 bg-muted/50 rounded-xl">
            <span className="text-4xl font-bold">{avgRating}</span>
            <div className="flex items-center gap-0.5 mt-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star key={i} className={`w-4 h-4 ${i < Math.round(Number(avgRating)) ? "fill-secondary text-secondary" : "text-muted-foreground/30"}`} />
              ))}
            </div>
            <span className="text-sm text-muted-foreground mt-1">{t("reviewsSection.reviewsCount", { defaultValue: "{{count}} reviews", count: totalReviews })}</span>
          </div>
        </div>
      )}

      {/* Filter + sort controls — only render when there's enough to sort. */}
      {reviews.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {([
              { id: "all", label: t("reviewsSection.filterAll", { defaultValue: "All" }) },
              { id: "5", label: "5★" },
              { id: "4", label: "4★" },
              { id: "3", label: "3★" },
              { id: "2", label: "2★" },
              { id: "1", label: "1★" },
            ] as Array<{ id: ReviewFilter; label: string }>).map((f) => {
              const count = f.id === "all" ? reviews.length : reviews.filter((r) => r.rating === Number(f.id)).length;
              return (
                <button
                  key={f.id}
                  onClick={() => { setRatingFilter(f.id); setShowAll(false); }}
                  className={`px-2.5 py-1 text-xs rounded-full border whitespace-nowrap transition-colors ${
                    ratingFilter === f.id ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground hover:border-primary/50"
                  }`}
                  disabled={count === 0}
                >
                  {f.label}
                  {f.id !== "all" && count > 0 && <span className="ml-1 opacity-70">{count}</span>}
                </button>
              );
            })}
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as ReviewSort)}
            className="ml-auto text-xs rounded-full border border-border bg-card px-2.5 py-1 text-muted-foreground hover:border-primary/50 outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="best">{t("reviewsSection.sortBest", { defaultValue: "Sort: Best first" })}</option>
            <option value="newest">{t("reviewsSection.sortNewest", { defaultValue: "Sort: Newest" })}</option>
            <option value="most_helpful">{t("reviewsSection.sortMostHelpful", { defaultValue: "Sort: Most helpful" })}</option>
          </select>
        </div>
      )}

      {/* Review Cards */}
      {loading ? (
        <div className="space-y-4">{[1, 2, 3].map(i => <div key={i} className="h-28 bg-muted rounded-xl animate-pulse" />)}</div>
      ) : reviews.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <p>{t("reviewsSection.noReviews", { defaultValue: "No reviews yet." })} {isAuthenticated ? t("reviewsSection.beFirst", { defaultValue: "Be the first to review!" }) : t("reviewsSection.logInToReview", { defaultValue: "Log in to write a review." })}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {displayed.map((review, i) => (
            <div key={review.id} className="p-4 bg-card rounded-xl border border-border/50 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold text-sm">
                    {review.display_name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{review.display_name}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(review.created_at)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className={`w-3.5 h-3.5 ${i < review.rating ? "fill-secondary text-secondary" : "text-muted-foreground/30"}`} />
                  ))}
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{translatedReviewTexts[i] || review.review_text}</p>
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap gap-1.5">
                  {review.tags?.map(tag => (
                    <span key={tag} className="px-2 py-0.5 bg-primary/5 text-primary/80 text-xs rounded-full border border-primary/10">{tagLabel(tag)}</span>
                  ))}
                </div>
                <button onClick={() => handleHelpful(review.id)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <ThumbsUp className="w-3.5 h-3.5" /> {review.helpful_count}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {sortedReviews.length > 3 && (
        <Button variant="outline" className="w-full mt-4 rounded-xl" onClick={() => setShowAll(!showAll)}>
          {showAll ? t("reviewsSection.showLess", { defaultValue: "Show less" }) : t("reviewsSection.showAll", { defaultValue: "Show all {{count}} review", defaultValue_plural: "Show all {{count}} reviews", count: sortedReviews.length })}
        </Button>
      )}
    </div>
  );
};

export default ReviewsSection;
