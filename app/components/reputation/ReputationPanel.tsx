"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
  Sparkles,
  Check,
} from "lucide-react"
import {
  aiGenerateReviewRequest,
  aiExtractTestimonials,
} from "@/app/actions/ai-review-automation"
import { aiRecommendGift, aiGenerateThankYouNote } from "@/app/actions/ai-client-gifting"
import {
  sendThankYouNoteAction,
  assignGiftAction,
} from "@/app/actions/reputation-kernel"

interface ReputationPanelProps {
  agentId: string
  brokerageId?: string
  clients?: any[]
  reviews?: any[]
  recentClosings?: any[]
}

export function ReputationPanel({
  agentId,
  clients = [],
  reviews = [],
  recentClosings = [],
}: ReputationPanelProps) {
  const [isPending, startTransition] = useTransition()

  // Shared copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Review request
  const [reviewDraft, setReviewDraft]           = useState<string>("")
  const [reviewPlatform, setReviewPlatform]     = useState<string>("google")
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [reviewClient, setReviewClient]         = useState<any>(null)

  // Thank you note
  const [thankYouDraft, setThankYouDraft]           = useState<string>("")
  const [thankYouDialogOpen, setThankYouDialogOpen] = useState(false)
  const [thankYouClient, setThankYouClient]         = useState<any>(null)
  const [sendingNote, setSendingNote]               = useState(false)

  // Gift
  const [giftRec, setGiftRec]             = useState<any>(null)
  const [giftDialogOpen, setGiftDialogOpen] = useState(false)
  const [giftClient, setGiftClient]       = useState<any>(null)
  const [assigningGift, setAssigningGift] = useState(false)

  // Testimonials
  const [testimonials, setTestimonials]               = useState<string[]>([])
  const [testimonialDialogOpen, setTestimonialDialogOpen] = useState(false)

  // Stats
  const totalReviews = reviews.length
  const avgRating =
    reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(1)
      : "N/A"
  const reviewReadyClients = recentClosings.filter((c: any) => {
    const closeDate = new Date(c.actual_close_date || c.close_date)
    const daysSince = Math.floor((Date.now() - closeDate.getTime()) / (1000 * 60 * 60 * 24))
    return daysSince >= 7 && daysSince <= 30
  })

  // ─── HANDLERS ──────────────────────────────────────────────────────────────

  function copyToClipboard(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  function handleGenerateReviewRequest(client: any) {
    const transactionId = client.transaction_id || client.transactionId || client.id
    if (!transactionId) {
      toast.error("No transaction found for this client")
      return
    }
    setReviewClient(client)
    startTransition(async () => {
      const result = await aiGenerateReviewRequest({
        transactionId,
        agentId,
        platform: reviewPlatform as "google" | "zillow" | "realtor" | "facebook" | "yelp",
        channel:  "email",
      })
      if (result.success && result.message) {
        setReviewDraft(result.message)
        setReviewDialogOpen(true)
      } else {
        toast.error(result.error ?? "Failed to generate review request")
      }
    })
  }

  function handleGenerateThankYouNote(client: any) {
    const contactId = client.contact_id || client.id
    if (!contactId) {
      toast.error("No contact found")
      return
    }
    setThankYouClient(client)
    startTransition(async () => {
      const result = await aiGenerateThankYouNote({
        agentId,
        contactId,
        occasion:  "closing",
        handwritten: false,
      })
      if (result.success && result.data?.note) {
        setThankYouDraft(result.data.note)
        setThankYouDialogOpen(true)
      } else {
        toast.error(result.error ?? "Failed to generate note")
      }
    })
  }

  async function handleSendThankYou() {
    if (!thankYouDraft || !thankYouClient) return
    setSendingNote(true)
    try {
      const result = await sendThankYouNoteAction({
        contactId:    thankYouClient.contact_id || thankYouClient.id,
        contactEmail: thankYouClient.contacts?.email || thankYouClient.email || "",
        contactName:  `${thankYouClient.contacts?.first_name || thankYouClient.first_name || ""} ${thankYouClient.contacts?.last_name || thankYouClient.last_name || ""}`.trim(),
        noteText:     thankYouDraft,
      })
      if (result.success) {
        toast.success("Thank you note sent")
        setThankYouDialogOpen(false)
      } else {
        toast.error(result.error ?? "Failed to send note")
      }
    } finally {
      setSendingNote(false)
    }
  }

  function handleRecommendGift(client: any) {
    const contactId = client.id || client.contact_id
    if (!contactId) {
      toast.error("No contact found")
      return
    }
    setGiftClient(client)
    startTransition(async () => {
      const result = await aiRecommendGift({
        agentId,
        contactId,
        occasion: "closing",
      })
      if (result.success && result.data) {
        setGiftRec(result.data)
        setGiftDialogOpen(true)
      } else {
        toast.error(result.error ?? "Failed to generate gift recommendation")
      }
    })
  }

  async function handleAssignGift() {
    if (!giftRec || !giftClient) return
    setAssigningGift(true)
    try {
      const top = giftRec.topRecommendation
      const result = await assignGiftAction({
        contactId:       giftClient.id || giftClient.contact_id,
        contactName:     `${giftClient.first_name || ""} ${giftClient.last_name || ""}`.trim(),
        giftName:        top.name,
        giftDescription: top.description,
        budget:          top.estimatedCost,
        occasion:        "closing",
      })
      if (result.success) {
        toast.success("Gift assigned")
        setGiftDialogOpen(false)
      } else {
        toast.error(result.error ?? "Failed to assign gift")
      }
    } finally {
      setAssigningGift(false)
    }
  }

  function handleExtractTestimonials() {
    startTransition(async () => {
      const result = await aiExtractTestimonials({ agentId, source: "reviews" })
      if (result.success && result.testimonials) {
        setTestimonials(result.testimonials)
        setTestimonialDialogOpen(true)
      } else {
        toast.error(result.error ?? "Failed to extract testimonials")
      }
    })
  }

  // ─── RENDER ────────────────────────────────────────────────────────────────

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
              <p className="text-sm text-muted-foreground">Past Clients</p>
              <p className="text-2xl font-bold">{clients.length}</p>
            </div>
            <div className="p-3 bg-indigo-50 rounded-full">
              <Gift className="w-6 h-6 text-indigo-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Review Requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Star className="w-5 h-5 text-yellow-500" />
            Review Requests
          </CardTitle>
          <CardDescription>Request reviews from recent closings at the optimal time</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 mb-2">
            <Select value={reviewPlatform} onValueChange={setReviewPlatform}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google">Google</SelectItem>
                <SelectItem value="zillow">Zillow</SelectItem>
                <SelectItem value="realtor">Realtor.com</SelectItem>
                <SelectItem value="facebook">Facebook</SelectItem>
                <SelectItem value="yelp">Yelp</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {reviewReadyClients.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No clients ready for review requests right now
            </p>
          ) : (
            reviewReadyClients.slice(0, 5).map((client: any) => (
              <div key={client.id} className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <p className="font-medium text-sm">
                    {client.contacts?.first_name || client.first_name}{" "}
                    {client.contacts?.last_name || client.last_name}
                  </p>
                  <p className="text-xs text-muted-foreground">{client.property_address}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => handleGenerateReviewRequest(client)}
                >
                  {isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <><Sparkles className="w-4 h-4 mr-1" />Request</>
                  )}
                </Button>
              </div>
            ))
          )}
          <Button variant="outline" className="w-full" disabled={isPending} onClick={handleExtractTestimonials}>
            <Sparkles className="w-4 h-4 mr-2" />
            Extract Testimonials from Reviews
          </Button>
        </CardContent>
      </Card>

      {/* Thank You Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-blue-500" />
            Thank You Notes
          </CardTitle>
          <CardDescription>Send personalized thank you notes to recent clients</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {recentClosings.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No recent closings</p>
          ) : (
            recentClosings.slice(0, 5).map((client: any) => (
              <div key={client.id} className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <p className="font-medium text-sm">
                    {client.contacts?.first_name || client.first_name}{" "}
                    {client.contacts?.last_name || client.last_name}
                  </p>
                  <p className="text-xs text-muted-foreground">{client.property_address}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => handleGenerateThankYouNote(client)}
                >
                  {isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <><Send className="w-4 h-4 mr-1" />Generate</>
                  )}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Client Gifting */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gift className="w-5 h-5 text-indigo-500" />
            Client Gifting
          </CardTitle>
          <CardDescription>AI-recommended gifts for your clients</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {clients.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No clients found</p>
          ) : (
            clients.slice(0, 5).map((client: any) => (
              <div key={client.id} className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <p className="font-medium text-sm">{client.first_name} {client.last_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {client.transactions?.[0]?.property_address || "Past Client"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => handleRecommendGift(client)}
                >
                  {isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <><Gift className="w-4 h-4 mr-1" />Recommend</>
                  )}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Recent Reviews */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ThumbsUp className="w-5 h-5 text-green-500" />
            Recent Reviews
          </CardTitle>
        </CardHeader>
        <CardContent>
          {reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No reviews yet</p>
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
                    {review.review_text}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {review.platform} &mdash; {new Date(review.created_at).toLocaleDateString()}
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
          <p className="text-sm text-muted-foreground">
            For {reviewClient?.contacts?.first_name || reviewClient?.first_name}
          </p>
          <Textarea value={reviewDraft} onChange={(e) => setReviewDraft(e.target.value)} rows={6} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => copyToClipboard(reviewDraft, "review")}
            >
              {copiedId === "review" ? (
                <><Check className="w-4 h-4 mr-2" />Copied</>
              ) : (
                <><Copy className="w-4 h-4 mr-2" />Copy</>
              )}
            </Button>
            <Button onClick={() => setReviewDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Thank You Note Dialog */}
      <Dialog open={thankYouDialogOpen} onOpenChange={setThankYouDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Thank You Note</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            For {thankYouClient?.contacts?.first_name || thankYouClient?.first_name}
          </p>
          <Textarea value={thankYouDraft} onChange={(e) => setThankYouDraft(e.target.value)} rows={6} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => copyToClipboard(thankYouDraft, "thankyou")}
            >
              {copiedId === "thankyou" ? (
                <><Check className="w-4 h-4 mr-2" />Copied</>
              ) : (
                <><Copy className="w-4 h-4 mr-2" />Copy</>
              )}
            </Button>
            <Button onClick={handleSendThankYou} disabled={sendingNote}>
              {sendingNote ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Gift Recommendation Dialog */}
      <Dialog open={giftDialogOpen} onOpenChange={setGiftDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gift Recommendation</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            For {giftClient?.first_name} {giftClient?.last_name}
          </p>
          {giftRec?.topRecommendation && (
            <div className="p-4 rounded-lg bg-indigo-50 border border-indigo-200 space-y-2">
              <p className="font-medium">{giftRec.topRecommendation.name}</p>
              <p className="text-sm text-muted-foreground">{giftRec.topRecommendation.description}</p>
              <p className="text-sm text-muted-foreground italic">{giftRec.topRecommendation.whyThisGift}</p>
              <Badge variant="secondary">~${giftRec.topRecommendation.estimatedCost}</Badge>
            </div>
          )}
          {giftRec?.alternatives && giftRec.alternatives.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Alternatives</p>
              {giftRec.alternatives.slice(0, 2).map((alt: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-sm border rounded px-3 py-2">
                  <span>{alt.name}</span>
                  <Badge variant="outline">~${alt.estimatedCost}</Badge>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setGiftDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAssignGift} disabled={assigningGift}>
              {assigningGift ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Gift className="w-4 h-4 mr-2" />}
              Assign Gift
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Testimonials Dialog */}
      <Dialog open={testimonialDialogOpen} onOpenChange={setTestimonialDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Extracted Testimonials</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {testimonials.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No testimonials extracted</p>
            ) : (
              testimonials.map((t, i) => (
                <div key={i} className="p-4 rounded-lg border flex items-start justify-between gap-3">
                  <p className="text-sm italic flex-1">"{t}"</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => copyToClipboard(t, `t-${i}`)}
                  >
                    {copiedId === `t-${i}` ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setTestimonialDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
