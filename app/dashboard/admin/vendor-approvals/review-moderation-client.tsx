"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Star, Loader2, MessageSquareWarning, ShieldCheck, Flag } from "lucide-react"
import { moderateVendorReview, getVendorReviewModerationQueue } from "@/app/actions/vendor-marketplace"

export interface QueuedReview {
  id: string
  vendor_id: string
  vendor_name: string | null
  rating: number | null
  review: string | null
  headline: string | null
  is_verified: boolean
  verification_method: string | null
  moderation_status: string
  flag_count: number
  created_at: string | null
  reviewer_name: string | null
  /** Why people flagged it — vendor_review_flags.reason, tallied (§1.2). */
  flag_reasons: Array<{ reason: string; count: number }>
  /** The booking / deal the review hangs off — vendor_reviews.booking_id / .transaction_id (§1.2). */
  booking_id: string | null
  transaction_id: string | null
}

/** The five codes flagVendorReview stores, in the words a moderator uses. */
const FLAG_REASON_LABEL: Record<string, string> = {
  inappropriate: "Inappropriate content",
  fake: "Believed fake",
  competitor: "Posted by a competitor",
  pii: "Contains personal information",
  irrelevant: "Irrelevant to the service",
  unspecified: "No reason given",
}

/**
 * THE HUMAN END OF screenReview / moderationAfterFlag.
 *
 * The moderation brain routes a review to `pending` (auto-screen trip) or
 * `under_review` (community flags past the threshold) — and until now nothing
 * displayed either bucket, so every routed review sat in the table forever and
 * never counted toward the vendor's weighted average.
 */
export function ReviewModerationClient({ initialQueue }: { initialQueue: QueuedReview[] }) {
  const [queue, setQueue] = useState<QueuedReview[]>(initialQueue)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [isPending, startTransition] = useTransition()

  const decide = (reviewId: string, decision: "approve" | "reject") => {
    setError("")
    setBusyId(reviewId)
    startTransition(async () => {
      try {
        await moderateVendorReview(reviewId, decision)
        setQueue(await getVendorReviewModerationQueue())
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not record the decision")
      } finally {
        setBusyId(null)
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquareWarning className="h-5 w-5" />
          Review Moderation Queue
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {queue.length === 0
            ? "Nothing waiting. Reviews land here when the auto-screen trips (one star, too short, profanity, PII, a brand-new account) or when three people flag one."
            : `${queue.length} review${queue.length === 1 ? "" : "s"} waiting on a human. Rejected reviews stop counting toward the vendor's average.`}
        </p>
      </CardHeader>
      {queue.length > 0 && (
        <CardContent className="space-y-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {queue.map((review) => (
            <div key={review.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-sm">{review.vendor_name ?? "Unknown vendor"}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        className={`h-3.5 w-3.5 ${star <= (review.rating ?? 0) ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
                      />
                    ))}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {review.reviewer_name ?? "Unknown reviewer"}
                      {review.created_at ? ` · ${new Date(review.created_at).toLocaleDateString()}` : ""}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {review.moderation_status.replace(/_/g, " ")}
                  </Badge>
                  {review.flag_count > 0 && (
                    <Badge variant="destructive" className="text-[10px]">
                      <Flag className="h-3 w-3 mr-1" />{review.flag_count}
                    </Badge>
                  )}
                  {review.is_verified && (
                    <Badge variant="secondary" className="text-[10px]">
                      <ShieldCheck className="h-3 w-3 mr-1" />
                      {review.verification_method === "transaction_party" ? "Deal party" : "Booking party"}
                    </Badge>
                  )}
                </div>
              </div>

              {review.headline && <p className="text-sm font-medium">{review.headline}</p>}
              {review.review && <p className="text-sm text-muted-foreground">{review.review}</p>}

              {/* §1.2 — WHY it was flagged. Without this the count above asked a
                  human to decide with the objection withheld. */}
              {review.flag_reasons.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] uppercase text-muted-foreground">Flagged for</span>
                  {review.flag_reasons.map((f) => (
                    <Badge key={f.reason} variant="outline" className="text-[10px]">
                      {FLAG_REASON_LABEL[f.reason] ?? f.reason}
                      {f.count > 1 ? ` ×${f.count}` : ""}
                    </Badge>
                  ))}
                </div>
              )}

              {/* §1.2 — the review's PROVENANCE: a booking or a closed deal it
                  actually hangs off, versus a review attached to neither. */}
              <p className="text-[11px] text-muted-foreground">
                {review.booking_id || review.transaction_id
                  ? `Attached to ${[review.booking_id ? "a booking" : null, review.transaction_id ? "a transaction" : null].filter(Boolean).join(" and ")} in this brokerage`
                  : "Not attached to any booking or transaction — no in-house record backs this review"}
              </p>

              <div className="flex gap-2">
                <Button size="sm" disabled={isPending && busyId === review.id}
                  onClick={() => decide(review.id, "approve")}>
                  {isPending && busyId === review.id && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Approve
                </Button>
                <Button size="sm" variant="destructive" disabled={isPending && busyId === review.id}
                  onClick={() => decide(review.id, "reject")}>
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  )
}
