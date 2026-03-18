"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Star,
  MessageSquare,
  Gift,
  ThumbsUp,
  Send,
  Copy,
  Loader2,
  ExternalLink,
  Sparkles,
  CheckCircle2,
  Clock,
} from "lucide-react"
import {
  aiDetermineReviewTiming,
  aiGenerateReviewRequest,
  aiExtractTestimonials,
} from "@/app/actions/ai-review-automation"
import {
  aiRecommendGift,
  aiGenerateThankYouNote,
  aiPlanBulkGifting,
} from "@/app/actions/ai-client-gifting"

interface ReputationPanelProps {
  agentId: string
  brokerageId?: string
  userId?: string
  clients?: any[]
  reviews?: any[]
  recentClosings?: any[]
}

export function ReputationPanel({
  agentId,
  brokerageId,
  userId,
  clients = [],
  reviews = [],
  recentClosings = [],
}: ReputationPanelProps) {
  const [isPending, startTransition] = useTransition()

  // Review request state
  const [reviewDraft, setReviewDraft] = useState<string | null>(null)
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [selectedClientForReview, setSelectedClientForReview] = useState<any>(null)

  // Thank you note state
  const [thankYouDraft, setThankYouDraft] = useState<string | null>(null)
  const [thankYouDialogOpen, setThankYouDialogOpen] = useState(false)
  const [selectedClientForThankYou, setSelectedClientForThankYou] = useState<any>(null)

  // Gift recommendation state
  const [giftRecommendation, setGiftRecommendation] = useState<any>(null)
  const [giftDialogOpen, setGiftDialogOpen] = useState(false)
  const [selectedClientForGift, setSelectedClientForGift] = useState<any>(null)

  // Testimonial extraction state
  const [extractedTestimonials, setExtractedTestimonials] = useState<any[]>([])
  const [testimonialDialogOpen, setTestimonialDialogOpen] = useState(false)

  // Bulk gifting state
  const [bulkGiftPlan, setBulkGiftPlan] = useState<any>(null)
  const [bulkGiftDialogOpen, setBulkGiftDialogOpen] = useState(false)

  // Stats
  const totalReviews = reviews.length
  const avgRating = reviews.length > 0
    ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(1)
    : "N/A"
  const reviewReadyClients = recentClosings.filter((c: any) => {
    const closeDate = new Date(c.actual_close_date || c.close_date)
    const daysSince = Math.floor((Date.now() - closeDate.getTime()) / (1000 * 60 * 60 * 24))
    return daysSince >= 7 && daysSince <= 30
  })

  // Handlers
  async function handleGenerateReviewRequest(client: any) {
    setSelectedClientForReview(client)
    startTransition(async () => {
      const result = await aiGenerateReviewRequest({
        agentId,
        contactId: client.id || client.contact_id,
        platform: "google",
      })
      if (result.success && result.message) {
        setReviewDraft(result.message)
        setReviewDialogOpen(true)
      }
    })
  }

  async function handleGenerateThankYouNote(client: any) {
    setSelectedClientForThankYou(client)
    startTransition(async () => {
      const result = await aiGenerateThankYouNote({
        agentId,
        contactId: client.id || client.contact_id,
      })
      if (result.success && result.note) {
        setThankYouDraft(result.note)
        setThankYouDialogOpen(true)
      }
    })
  }

  async function handleRecommendGift(client: any) {
    setSelectedClientForGift(client)
    startTransition(async () => {
      const result = await aiRecommendGift({
        agentId,
        contactId: client.id || client.contact_id,
      })
      if (result.success) {
        setGiftRecommendation(result)
        setGiftDialogOpen(true)
      }
    })
  }

  async function handleExtractTestimonials() {
    startTransition(async () => {
      const result = await aiExtractTestimonials({ agentId })
      if (result.success && result.testimonials) {
        setExtractedTestimonials(result.testimonials)
        setTestimonialDialogOpen(true)
      }
    })
  }

  async function handlePlanBulkGifting() {
    startTransition(async () => {
      const result = await aiPlanBulkGifting({ agentId })
      if (result.success) {
        setBulkGiftPlan(result)
        setBulkGiftDialogOpen(true)
      }
    })
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="space-y-6">
      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Reviews</p>
              <p className="text-2xl font-bold">{totalReviews}</p>
            </div>
            <div className="p-3 bg-yellow-50 rounded-full">
              <Star className="w-6 h-6 text-yellow-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Avg Rating</p>
              <p className="text-2xl font-bold">{avgRating}</p>
            </div>
            <div className="p-3 bg-green-50 rounded-full">
              <ThumbsUp className="w-6 h-6 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Review Ready</p>
              <p className="text-2xl font-bold">{reviewReadyClients.length}</p>
            </div>
            <div className="p-3 bg-blue-50 rounded-full">
              <MessageSquare className="w-6 h-6 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Gifts Sent</p>
              <p className="text-2xl font-bold">--</p>
            </div>
            <div className="p-3 bg-purple-50 rounded-full">
              <Gift className="w-6 h-6 text-purple-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section 1: Review Requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Star className="w-5 h-5 text-yellow-500" />
            Review Requests
          </CardTitle>
          <CardDescription>
            Request reviews from recent closings at the optimal time
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {reviewReadyClients.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No clients ready for review requests right now
            </p>
          ) : (
            reviewReadyClients.slice(0, 5).map((client: any) => (
              <div
                key={client.id}
                className="flex items-center justify-between p-3 rounded-lg border"
              >
                <div>
                  <p className="font-medium text-sm">
                    {client.contacts?.first_name || client.first_name} {client.contacts?.last_name || client.last_name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {client.property_address} - Closed {new Date(client.actual_close_date || client.close_date).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleGenerateReviewRequest(client)}
                  disabled={isPending}
                >
                  {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                  Request
                </Button>
              </div>
            ))
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={handleExtractTestimonials}
            disabled={isPending}
          >
            <Sparkles className="w-4 h-4 mr-2" />
            Extract Testimonials from Reviews
          </Button>
        </CardContent>
      </Card>

      {/* Section 2: Thank You Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-blue-500" />
            Thank You Notes
          </CardTitle>
          <CardDescription>
            Send personalized thank you notes to recent clients
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {recentClosings.slice(0, 5).map((client: any) => (
            <div
              key={client.id}
              className="flex items-center justify-between p-3 rounded-lg border"
            >
              <div>
                <p className="font-medium text-sm">
                  {client.contacts?.first_name || client.first_name} {client.contacts?.last_name || client.last_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {client.property_address}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleGenerateThankYouNote(client)}
                disabled={isPending}
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                Generate
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Section 3: Client Gifting */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gift className="w-5 h-5 text-purple-500" />
            Client Gifting
          </CardTitle>
          <CardDescription>
            AI-recommended gifts for your clients
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {clients.slice(0, 5).map((client: any) => (
            <div
              key={client.id}
              className="flex items-center justify-between p-3 rounded-lg border"
            >
              <div>
                <p className="font-medium text-sm">
                  {client.first_name} {client.last_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {client.transactions?.[0]?.property_address || "Past Client"}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleRecommendGift(client)}
                disabled={isPending}
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gift className="w-4 h-4 mr-1" />}
                Recommend
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            className="w-full"
            onClick={handlePlanBulkGifting}
            disabled={isPending}
          >
            <Sparkles className="w-4 h-4 mr-2" />
            Plan Bulk Gifting Campaign
          </Button>
        </CardContent>
      </Card>

      {/* Section 4: Recent Reviews */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ThumbsUp className="w-5 h-5 text-green-500" />
            Recent Reviews
          </CardTitle>
        </CardHeader>
        <CardContent>
          {reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No reviews yet
            </p>
          ) : (
            <div className="space-y-3">
              {reviews.slice(0, 5).map((review: any) => (
                <div key={review.id} className="p-3 rounded-lg border space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">{review.reviewer_name || "Anonymous"}</p>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: review.rating || 5 }).map((_, i) => (
                        <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                      ))}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {review.review_text || review.content}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {review.platform} - {new Date(review.created_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Review Request Dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Generated for {selectedClientForReview?.contacts?.first_name || selectedClientForReview?.first_name}
            </p>
            <Textarea
              value={reviewDraft || ""}
              onChange={(e) => setReviewDraft(e.target.value)}
              rows={6}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => copyToClipboard(reviewDraft || "")}>
              <Copy className="w-4 h-4 mr-2" />
              Copy
            </Button>
            <Button onClick={() => setReviewDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Thank You Note Dialog */}
      <Dialog open={thankYouDialogOpen} onOpenChange={setThankYouDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Thank You Note</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Generated for {selectedClientForThankYou?.contacts?.first_name || selectedClientForThankYou?.first_name}
            </p>
            <Textarea
              value={thankYouDraft || ""}
              onChange={(e) => setThankYouDraft(e.target.value)}
              rows={6}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => copyToClipboard(thankYouDraft || "")}>
              <Copy className="w-4 h-4 mr-2" />
              Copy
            </Button>
            <Button onClick={() => setThankYouDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Gift Recommendation Dialog */}
      <Dialog open={giftDialogOpen} onOpenChange={setGiftDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gift Recommendation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              For {selectedClientForGift?.first_name} {selectedClientForGift?.last_name}
            </p>
            {giftRecommendation && (
              <div className="space-y-3">
                <div className="p-4 rounded-lg bg-purple-50 border border-purple-200">
                  <p className="font-medium">{giftRecommendation.recommendation}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {giftRecommendation.reason}
                  </p>
                  {giftRecommendation.budget && (
                    <Badge variant="secondary" className="mt-2">
                      Budget: ${giftRecommendation.budget}
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setGiftDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Testimonials Dialog */}
      <Dialog open={testimonialDialogOpen} onOpenChange={setTestimonialDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Extracted Testimonials</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 max-h-96 overflow-y-auto">
            {extractedTestimonials.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No testimonials extracted
              </p>
            ) : (
              extractedTestimonials.map((t: any, i: number) => (
                <div key={i} className="p-4 rounded-lg border space-y-2">
                  <p className="text-sm italic">"{t.quote}"</p>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">— {t.author}</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copyToClipboard(t.quote)}
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setTestimonialDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Gifting Dialog */}
      <Dialog open={bulkGiftDialogOpen} onOpenChange={setBulkGiftDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bulk Gifting Plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 max-h-96 overflow-y-auto">
            {bulkGiftPlan && (
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-purple-50 border border-purple-200">
                  <p className="font-medium">Campaign: {bulkGiftPlan.campaignName || "Holiday Gifting"}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {bulkGiftPlan.description || "Personalized gifts for your sphere"}
                  </p>
                </div>
                {bulkGiftPlan.recipients?.map((r: any, i: number) => (
                  <div key={i} className="p-3 rounded-lg border flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{r.name}</p>
                      <p className="text-xs text-muted-foreground">{r.gift}</p>
                    </div>
                    <Badge variant="secondary">${r.budget}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setBulkGiftDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
