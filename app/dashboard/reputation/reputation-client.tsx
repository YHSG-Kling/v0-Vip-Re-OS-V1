"use client"

import { useState, useTransition } from "react"
import {
  Star,
  MessageCircle,
  Share2,
  RefreshCw,
  Settings,
  Send,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  Plus,
  ThumbsUp,
  Eye,
  Loader2,
  PenLine,
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ReputationPanel } from "@/app/components/reputation/ReputationPanel"
import { aiGenerateReviewRequest, aiGenerateReviewResponse } from "@/app/actions/ai-review-automation"
import { ReviewRequestPanel, GratitudeGiftingPanel } from "@/app/dashboard/referrals/components/os"
import {
  recordReviewAction,
  respondToReviewAction,
} from "@/app/actions/reputation-kernel"
import type { ReviewRow, ReviewRequestRow, ReputationPerformance } from "@/lib/kernel/reputation"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface ReputationClientProps {
  agentId:       string
  brokerageId?:  string
  userId:        string
  reviews:       ReviewRow[]
  reviewRequests: ReviewRequestRow[]
  recentClosings: any[]
}

const REVIEW_PLATFORMS = [
  { value: "google",      label: "Google" },
  { value: "zillow",      label: "Zillow" },
  { value: "realtor_com", label: "Realtor.com" },
  { value: "yelp",        label: "Yelp" },
  { value: "facebook",    label: "Facebook" },
  { value: "trulia",      label: "Trulia" },
  { value: "other",       label: "Other" },
] as const

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

// Performance summary cards — real numbers from DB
function PerformanceSummary({
  reviews,
  reviewRequests,
  recentClosings,
}: {
  reviews:        ReviewRow[]
  reviewRequests: ReviewRequestRow[]
  recentClosings: any[]
}) {
  const totalReviews   = reviews.length
  const avgRating      = totalReviews > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / totalReviews) * 10) / 10
    : 0
  const withResponse   = reviews.filter(r => !!r.response_text).length
  const responseRate   = totalReviews > 0 ? Math.round((withResponse / totalReviews) * 100) : 0
  const totalClosings  = recentClosings.length
  const reviewRate     = totalClosings > 0 ? Math.round((totalReviews / totalClosings) * 100) : 0
  const pendingRequests = reviewRequests.filter(r => r.status === "pending").length

  const sorted      = [...reviews].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  const recentAvg   = sorted.slice(0, 5).reduce((s, r) => s + r.rating, 0) / Math.max(sorted.slice(0, 5).length, 1)
  const priorAvg    = sorted.slice(5, 10).reduce((s, r) => s + r.rating, 0) / Math.max(sorted.slice(5, 10).length, 1)
  const trend = !sorted.slice(5, 10).length ? "stable"
    : recentAvg > priorAvg + 0.2 ? "improving"
    : recentAvg < priorAvg - 0.2 ? "declining"
    : "stable"

  const TrendIcon = trend === "improving" ? TrendingUp : trend === "declining" ? TrendingDown : Minus
  const trendColor = trend === "improving" ? "text-green-600" : trend === "declining" ? "text-red-500" : "text-muted-foreground"

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Star className="h-4 w-4 text-amber-500" />
            Avg Rating
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-2">
            <div className="text-2xl font-bold">{avgRating || "—"}</div>
            <TrendIcon className={`h-4 w-4 mb-1 ${trendColor}`} />
          </div>
          <p className="text-xs text-muted-foreground">{totalReviews} total reviews</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <MessageCircle className="h-4 w-4" />
            Response Rate
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{responseRate}%</div>
          <p className="text-xs text-muted-foreground">{withResponse} of {totalReviews} responded</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Review Rate
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{reviewRate}%</div>
          <p className="text-xs text-muted-foreground">Reviews per closing (90d)</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Send className="h-4 w-4" />
            Pending Requests
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{pendingRequests}</div>
          <p className="text-xs text-muted-foreground">Awaiting response</p>
        </CardContent>
      </Card>
    </div>
  )
}

// Star display helper
function StarDisplay({ rating, size = "sm" }: { rating: number; size?: "sm" | "md" }) {
  const px = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star
          key={i}
          className={`${px} ${i <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </span>
  )
}

// Respond to review dialog — wired to respondToReviewAction kernel command
function RespondDialog({
  review,
  agentId,
  open,
  onClose,
  onSuccess,
}: {
  review:    ReviewRow
  agentId:   string
  open:      boolean
  onClose:   () => void
  onSuccess: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [responseText, setResponseText]   = useState(review.response_text ?? "")
  const [isGenerating, setIsGenerating]   = useState(false)
  const [error, setError]                 = useState<string | null>(null)

  const handleGenerate = async () => {
    setIsGenerating(true)
    setError(null)
    try {
      const result = await aiGenerateReviewResponse({
        reviewId:     review.id,
        agentId,
        reviewText:   review.review_text ?? "",
        rating:       review.rating,
        platform:     review.platform,
        reviewerName: "Client",
      })
      if (result.success && result.data?.publicResponse) {
        setResponseText(result.data.publicResponse)
      }
    } catch {
      setError("AI generation failed. Write your response manually.")
    } finally {
      setIsGenerating(false)
    }
  }

  const handlePublish = () => {
    if (!responseText.trim()) return
    setError(null)
    startTransition(async () => {
      const res = await respondToReviewAction({
        reviewId:     review.id,
        responseText: responseText.trim(),
        publishNow:   true,
      })
      if (res.success) {
        onSuccess()
        onClose()
      } else {
        setError(res.error ?? "Failed to publish response.")
      }
    })
  }

  const handleSaveDraft = () => {
    if (!responseText.trim()) return
    setError(null)
    startTransition(async () => {
      const res = await respondToReviewAction({
        reviewId:     review.id,
        responseText: responseText.trim(),
        publishNow:   false,
      })
      if (res.success) {
        onSuccess()
        onClose()
      } else {
        setError(res.error ?? "Failed to save draft.")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Respond to Review</DialogTitle>
        </DialogHeader>

        {/* Original review */}
        <div className="rounded-lg bg-muted/50 p-4 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <StarDisplay rating={review.rating} />
            <Badge variant="outline" className="capitalize text-xs">{review.platform}</Badge>
          </div>
          <p className="text-muted-foreground leading-relaxed">{review.review_text || "(No review text)"}</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="response-text">Your Response</Label>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerate}
              disabled={isGenerating || isPending}
            >
              {isGenerating
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Generating...</>
                : <><PenLine className="h-3.5 w-3.5 mr-1.5" />AI Draft</>
              }
            </Button>
          </div>
          <Textarea
            id="response-text"
            value={responseText}
            onChange={e => setResponseText(e.target.value)}
            rows={5}
            placeholder="Write your public response..."
            disabled={isPending}
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button variant="outline" onClick={handleSaveDraft} disabled={isPending || !responseText.trim()}>
            Save Draft
          </Button>
          <Button onClick={handlePublish} disabled={isPending || !responseText.trim()}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ThumbsUp className="h-4 w-4 mr-2" />}
            Publish Response
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Received reviews tab — list with inline Respond button
function ReceivedReviewsTab({
  reviews,
  agentId,
  onReviewUpdated,
}: {
  reviews:         ReviewRow[]
  agentId:         string
  onReviewUpdated: () => void
}) {
  const [respondTo, setRespondTo] = useState<ReviewRow | null>(null)

  if (reviews.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <Star className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
        <p className="text-sm text-muted-foreground">No reviews recorded yet.</p>
        <p className="text-xs text-muted-foreground mt-1">Use the "Record Review" tab to add reviews you have received.</p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {reviews.map(review => (
          <Card key={review.id} className="overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StarDisplay rating={review.rating} />
                    <Badge variant="outline" className="capitalize text-xs">{review.platform}</Badge>
                    {review.is_published && (
                      <Badge variant="secondary" className="text-xs gap-1">
                        <Eye className="h-3 w-3" />Published
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-foreground leading-relaxed line-clamp-3">
                    {review.review_text || <span className="italic text-muted-foreground">(no text)</span>}
                  </p>
                  {review.response_text && (
                    <div className="mt-2 pl-3 border-l-2 border-muted">
                      <p className="text-xs font-medium text-muted-foreground mb-0.5">Your Response</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{review.response_text}</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {new Date(review.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                </div>
                <Button
                  variant={review.response_text ? "ghost" : "outline"}
                  size="sm"
                  onClick={() => setRespondTo(review)}
                  className="shrink-0"
                >
                  <MessageCircle className="h-3.5 w-3.5 mr-1.5" />
                  {review.response_text ? "Edit Response" : "Respond"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {respondTo && (
        <RespondDialog
          review={respondTo}
          agentId={agentId}
          open={true}
          onClose={() => setRespondTo(null)}
          onSuccess={onReviewUpdated}
        />
      )}
    </>
  )
}

// Record Inbound Review form — wired to recordReviewAction kernel command
function RecordReviewTab({
  agentId,
  onSuccess,
}: {
  agentId:   string
  onSuccess: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [platform, setPlatform]   = useState<string>("")
  const [rating, setRating]       = useState<number>(5)
  const [reviewText, setReviewText] = useState("")
  const [sourceUrl, setSourceUrl] = useState("")
  const [error, setError]         = useState<string | null>(null)
  const [success, setSuccess]     = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform || !reviewText.trim()) {
      setError("Platform and review text are required.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await recordReviewAction({
        platform:    platform as any,
        rating:      rating as any,
        reviewText:  reviewText.trim(),
        sourceUrl:   sourceUrl.trim() || undefined,
        isPublished: true,
      })
      if (res.success) {
        setSuccess(true)
        setPlatform("")
        setRating(5)
        setReviewText("")
        setSourceUrl("")
        onSuccess()
        setTimeout(() => setSuccess(false), 3000)
      } else {
        setError(res.error ?? "Failed to record review.")
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-xl">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="platform">Platform <span className="text-red-500">*</span></Label>
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger id="platform">
              <SelectValue placeholder="Select platform" />
            </SelectTrigger>
            <SelectContent>
              {REVIEW_PLATFORMS.map(p => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Star Rating <span className="text-red-500">*</span></Label>
          <div className="flex items-center gap-1 pt-2">
            {[1, 2, 3, 4, 5].map(i => (
              <button
                key={i}
                type="button"
                onClick={() => setRating(i)}
                className="focus:outline-none"
              >
                <Star className={`h-6 w-6 transition-colors ${i <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30 hover:text-amber-300"}`} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="review-text">Review Text <span className="text-red-500">*</span></Label>
        <Textarea
          id="review-text"
          value={reviewText}
          onChange={e => setReviewText(e.target.value)}
          placeholder="Paste or type the review text..."
          rows={4}
          disabled={isPending}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="source-url">Source URL (optional)</Label>
        <Input
          id="source-url"
          type="url"
          value={sourceUrl}
          onChange={e => setSourceUrl(e.target.value)}
          placeholder="https://g.page/r/..."
          disabled={isPending}
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          Review recorded successfully.
        </div>
      )}

      <Button type="submit" disabled={isPending || !platform || !reviewText.trim()}>
        {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
        Record Review
      </Button>
    </form>
  )
}

// ─── MAIN CLIENT ──────────────────────────────────────────────────────────────

export function ReputationClient({
  agentId,
  brokerageId,
  userId,
  reviews: initialReviews,
  reviewRequests,
  recentClosings,
}: ReputationClientProps) {
  const [isPending, startTransition] = useTransition()
  const [reviews, setReviews]        = useState<ReviewRow[]>(initialReviews)
  const [selectedClosings, setSelectedClosings] = useState<Set<string>>(new Set())

  const handleBatchRequestReviews = async () => {
    if (selectedClosings.size === 0) return
    startTransition(async () => {
      for (const closingId of selectedClosings) {
        await aiGenerateReviewRequest({
          transactionId: closingId,
          agentId,
          platform: "google",
          channel: "email",
        })
      }
      setSelectedClosings(new Set())
    })
  }

  const toggleClosingSelection = (id: string) => {
    setSelectedClosings(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Refresh reviews list after record or respond
  const handleReviewUpdated = () => {
    window.location.reload()
  }

  const avgRating = reviews.length > 0
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
    : "—"

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="px-4 py-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                <Star className="h-5 w-5 text-amber-700" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">Reputation &amp; Advocacy</h1>
                <p className="text-sm text-muted-foreground">
                  Avg Rating: <span className="font-semibold">{avgRating}</span> from {reviews.length} reviews
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              {selectedClosings.size > 0 && (
                <>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleBatchRequestReviews}
                    disabled={isPending}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    Request Reviews ({selectedClosings.size})
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedClosings(new Set())}>
                    Clear
                  </Button>
                </>
              )}
              <Link href="/dashboard/settings">
                <Button variant="ghost" size="sm">
                  <Settings className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Performance Summary — real DB numbers */}
      <PerformanceSummary
        reviews={reviews}
        reviewRequests={reviewRequests}
        recentClosings={recentClosings}
      />

      {/* Main Tabs */}
      <Tabs defaultValue="request">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="request">Request Reviews</TabsTrigger>
          <TabsTrigger value="received">
            Received
            {reviews.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">{reviews.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="record">Record Review</TabsTrigger>
          <TabsTrigger value="panels">Gifting &amp; Advocacy</TabsTrigger>
        </TabsList>

        {/* Tab: Request Reviews */}
        <TabsContent value="request" className="space-y-6 mt-4">
          {recentClosings.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Batch Request from Recent Closings</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {recentClosings.map((closing: any) => (
                    <div
                      key={closing.id}
                      className="flex items-center gap-3 p-2 border rounded-lg hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        checked={selectedClosings.has(closing.id)}
                        onChange={() => toggleClosingSelection(closing.id)}
                        className="h-4 w-4 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{closing.property_address}</p>
                        <p className="text-xs text-muted-foreground">
                          {closing.contacts?.first_name} {closing.contacts?.last_name}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {new Date(closing.close_date).toLocaleDateString()}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div id="review-section">
            <ReviewRequestPanel
              agentId={agentId}
              recentClosings={recentClosings.map((c: any) => ({
                id:            c.id,
                contact_id:    c.contact_id,
                contactName:   `${c.contacts?.first_name || ""} ${c.contacts?.last_name || ""}`.trim() || "Client",
                address:       c.property_address,
                closeDate:     c.close_date,
                transactionId: c.id,
              }))}
              existingReviews={reviews.map((r) => ({
                id:          r.id,
                platform:    r.platform || "google",
                rating:      r.rating || 5,
                review_text: r.review_text || "",
              }))}
            />
          </div>
        </TabsContent>

        {/* Tab: Received Reviews */}
        <TabsContent value="received" className="mt-4">
          <ReceivedReviewsTab
            reviews={reviews}
            agentId={agentId}
            onReviewUpdated={handleReviewUpdated}
          />
        </TabsContent>

        {/* Tab: Record Inbound Review */}
        <TabsContent value="record" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Record an Inbound Review</CardTitle>
            </CardHeader>
            <CardContent>
              <RecordReviewTab agentId={agentId} onSuccess={handleReviewUpdated} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Gifting & Advocacy OS Panels */}
        <TabsContent value="panels" className="space-y-6 mt-4">
          {recentClosings.length > 0 && (
            <GratitudeGiftingPanel
              agentId={agentId}
              contactId={recentClosings[0].contact_id}
              contactName={`${recentClosings[0].contacts?.first_name || ""} ${recentClosings[0].contacts?.last_name || ""}`.trim() || "Client"}
              occasion="closing"
            />
          )}
          <ReputationPanel
            agentId={agentId}
            brokerageId={brokerageId}
            userId={userId}
            reviews={reviews}
            recentClosings={recentClosings}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
