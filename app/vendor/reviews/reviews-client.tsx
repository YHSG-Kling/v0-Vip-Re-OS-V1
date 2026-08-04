"use client"

import { useState, useTransition } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Star, Loader2, ShieldCheck, Flag } from "lucide-react"
import { respondToVendorReview, getMyVendorReviews } from "@/app/actions/vendor-marketplace"

interface Review {
  id: string
  rating: number | null
  review: string | null
  headline: string | null
  is_verified: boolean
  verification_method: string | null
  moderation_status: string
  flag_count: number | null
  vendor_response: string | null
  vendor_response_at: string | null
  created_at: string | null
}

export function VendorReviewsClient({ initialReviews }: { initialReviews: Review[] }) {
  const [reviews, setReviews] = useState<Review[]>(initialReviews)
  const [draftFor, setDraftFor] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [isPending, startTransition] = useTransition()

  const submitResponse = (reviewId: string) => {
    setError("")
    if (!draft.trim()) { setError("Write a response first."); return }
    startTransition(async () => {
      try {
        await respondToVendorReview(reviewId, draft.trim())
        const fresh = await getMyVendorReviews()
        setReviews(fresh.reviews as unknown as Review[])
        setDraftFor(null)
        setDraft("")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not post the response")
      }
    })
  }

  if (reviews.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No reviews yet. Reviews arrive when an agent rates a completed booking or a
        client reviews you through their portal.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {reviews.map((review) => (
        <Card key={review.id}>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star
                    key={star}
                    className={`h-4 w-4 ${star <= (review.rating ?? 0) ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
                  />
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {review.created_at ? new Date(review.created_at).toLocaleDateString() : ""}
              </span>
            </div>

            {review.headline && <p className="font-medium">{review.headline}</p>}
            {review.review && <p className="text-sm">{review.review}</p>}

            <div className="flex flex-wrap items-center gap-1.5">
              {review.is_verified ? (
                <Badge variant="secondary" className="text-[10px]">
                  <ShieldCheck className="h-3 w-3 mr-1" />
                  Verified {review.verification_method === "transaction_party" ? "deal party" : "booking party"}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">Unverified</Badge>
              )}
              {review.moderation_status !== "approved" && (
                <Badge variant="outline" className="text-[10px] capitalize">
                  {review.moderation_status.replace(/_/g, " ")} — not counted in your average yet
                </Badge>
              )}
              {(review.flag_count ?? 0) > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  <Flag className="h-3 w-3 mr-1" />{review.flag_count}
                </Badge>
              )}
            </div>

            {review.vendor_response ? (
              <div className="rounded border-l-2 border-blue-500/50 bg-muted/40 p-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Your response
                  {review.vendor_response_at ? ` · ${new Date(review.vendor_response_at).toLocaleDateString()}` : ""}
                </p>
                <p className="text-sm">{review.vendor_response}</p>
              </div>
            ) : draftFor === review.id ? (
              <div className="space-y-2">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  placeholder="Your public response. This can be posted once and cannot be edited or removed afterwards."
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={isPending} onClick={() => submitResponse(review.id)}>
                    {isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                    Post response
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setDraftFor(null); setDraft(""); setError("") }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => { setDraftFor(review.id); setDraft(""); setError("") }}>
                Respond
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
