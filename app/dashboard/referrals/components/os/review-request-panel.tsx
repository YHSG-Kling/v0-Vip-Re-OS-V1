"use client"

import { useState, useTransition } from "react"
import { Star, Send, Copy, Check, Sparkles, Loader2, MessageSquare } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  aiDetermineReviewTiming,
  aiGenerateReviewRequest,
  aiExtractTestimonials,
  aiGenerateReviewResponse,
} from "@/app/actions/ai-review-automation"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"
import { ContextualAiAssistBar } from "@/app/components/ai-copilot"
import { awardPointsForAction } from "@/app/lib/gamification/award-on-action"
import { sendThankYouNoteAction, respondToReviewAction } from "@/app/actions/reputation-kernel"
import { toast } from "sonner"

interface RecentClosing {
  id: string
  contact_id: string
  contactName: string
  address: string
  closeDate: string
  transactionId: string
  contactEmail?: string
}

interface ExistingReview {
  id: string
  platform: string
  rating: number
  review_text: string
}

interface ReviewRequestPanelProps {
  agentId: string
  recentClosings: RecentClosing[]
  existingReviews: ExistingReview[]
}

export function ReviewRequestPanel({
  agentId,
  recentClosings,
  existingReviews,
}: ReviewRequestPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [selectedContact, setSelectedContact] = useState<string | null>(null)
  const [platform, setPlatform] = useState<string>("google")
  const [channel, setChannel] = useState<string>("email")
  const [draft, setDraft] = useState<string>("")
  const [complianceOk, setComplianceOk] = useState<boolean | null>(null)
  const [extractedTestimonials, setExtractedTestimonials] = useState<string[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [responseId, setResponseId] = useState<string | null>(null)
  const [responseText, setResponseText] = useState<string>("")
  const [sendingDraft, setSendingDraft] = useState(false)

  const handleRequestReview = async (closing: RecentClosing) => {
    setSelectedContact(closing.id)
    setDraft("")
    setComplianceOk(null)

    startTransition(async () => {
      // Check timing first
      await aiDetermineReviewTiming({ transactionId: closing.transactionId, agentId })

      // Generate request
      const result = await aiGenerateReviewRequest({
        transactionId: closing.transactionId,
        agentId,
        platform: platform as "google" | "zillow" | "realtor" | "yelp" | "facebook",
        channel: (channel === "sms" ? "text" : channel) as "email" | "text" | "in_person",
      })

      if (result.success && result.message) {
        setDraft(result.message)
        awardPointsForAction(agentId, "review_received").catch(() => {})
        // checkThemFirstCompliance returns { score, themFirstCount,
        // agentFirstCount, feedback } — never an `isCompliant` flag. Reading one
        // yielded undefined, and `complianceOk !== null` is TRUE for undefined,
        // so the badge rendered on every draft and always said "Review Needed".
        // Same threshold as the gifting and drafting panels.
        const compliance = await checkThemFirstCompliance(result.message)
        setComplianceOk(((compliance as any)?.score ?? 0) >= 50)
      }
    })
  }

  const handleExtractTestimonials = () => {
    startTransition(async () => {
      const result = await aiExtractTestimonials({
        agentId,
        source: "reviews",
      })
      if (result.success && result.testimonials) {
        setExtractedTestimonials(result.testimonials)
      }
    })
  }

  const handleGenerateResponse = (review: ExistingReview) => {
    setResponseId(review.id)
    setResponseError(null)
    setResponsePublished(null)
    startTransition(async () => {
      const result = await aiGenerateReviewResponse({
        reviewId: review.id,
        agentId,
        reviewText: review.review_text,
        rating: review.rating,
        platform: review.platform,
        reviewerName: "",
      })
      if (result.success && (result as any).data?.publicResponse) {
        setResponseText((result as any).data?.publicResponse ?? "")
      } else {
        // The draft used to be dropped in silence when generation failed, so the
        // button looked like it had simply done nothing.
        setResponseError((result as any).error ?? "The AI could not draft a response to this review.")
      }
    })
  }

  // ── PUBLISHING THE RESPONSE ────────────────────────────────────────────────
  //
  // aiGenerateReviewResponse writes response_text on agent_reviews as a DRAFT
  // and deliberately leaves is_published false — its own comment says the agent
  // publishes "via respondToReview kernel command". That command existed, was
  // complete, and had no caller: the draft rendered in a read-only grey box with
  // no way to send it anywhere. This is that caller.
  //
  // respondToReview verifies the review belongs to the acting agent and stamps
  // response_at; publishNow is what puts the response (and the review) on the
  // public agent profile, so it is an explicit choice, not a default.
  const [responseError, setResponseError] = useState<string | null>(null)
  const [responsePublished, setResponsePublished] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  const handleSaveResponse = async (reviewId: string, publishNow: boolean) => {
    if (!responseText.trim()) {
      setResponseError("Write a response first.")
      return
    }
    setPublishing(true)
    setResponseError(null)
    setResponsePublished(null)
    try {
      const result = await respondToReviewAction({ reviewId, responseText, publishNow })
      if (result.success) {
        setResponsePublished(
          publishNow ? "Response published to your public profile." : "Response saved to this review.",
        )
        toast.success(publishNow ? "Response published" : "Response saved")
      } else {
        // The SERVER's verdict, verbatim — never an optimistic success.
        setResponseError((result as { error?: string }).error ?? "The response could not be saved.")
        toast.error((result as { error?: string }).error ?? "The response could not be saved.")
      }
    } finally {
      setPublishing(false)
    }
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleSendDraft = async () => {
    if (!draft || !selectedContact) return
    const closing = recentClosings.find(c => c.id === selectedContact)
    if (!closing) return
    setSendingDraft(true)
    try {
      const result = await sendThankYouNoteAction({
        contactId:    closing.contact_id,
        contactEmail: closing.contactEmail || "",
        contactName:  closing.contactName,
        noteText:     draft,
      })
      if (result.success) {
        toast.success("Review request sent")
        setDraft("")
        setSelectedContact(null)
      } else {
        toast.error(result.error ?? "Failed to send")
      }
    } finally {
      setSendingDraft(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Star className="h-5 w-5 text-amber-500" />
          Review Requests & Reputation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Best Candidates */}
        <div>
          <h4 className="text-sm font-medium mb-3">Best Candidates for Reviews</h4>
          <div className="flex items-center gap-2 mb-3">
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google">Google</SelectItem>
                <SelectItem value="zillow">Zillow</SelectItem>
                <SelectItem value="realtor">Realtor.com</SelectItem>
                <SelectItem value="facebook">Facebook</SelectItem>
              </SelectContent>
            </Select>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="sms">SMS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            {recentClosings.slice(0, 3).map((closing) => (
              <div key={closing.id} className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                <div>
                  <p className="font-medium text-sm">{closing.contactName}</p>
                  <p className="text-xs text-muted-foreground">{closing.address}</p>
                  <p className="text-xs text-muted-foreground">
                    Closed: {new Date(closing.closeDate).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => handleRequestReview(closing)}
                  disabled={isPending && selectedContact === closing.id}
                >
                  {isPending && selectedContact === closing.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4 mr-1" />
                      Request
                    </>
                  )}
                </Button>
              </div>
            ))}
            {recentClosings.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No recent closings</p>
            )}
          </div>
        </div>

        {/* Draft Editor */}
        {draft && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Generated Request</h4>
              {complianceOk !== null && (
                <Badge variant={complianceOk ? "default" : "destructive"}>
                  {complianceOk ? "Compliant" : "Review Needed"}
                </Badge>
              )}
            </div>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              className="font-mono text-sm"
            />
            <ContextualAiAssistBar
              agentId={agentId}
              context={{
                type: 'review_request',
                contactName: recentClosings.find(c => c.id === selectedContact)?.contactName,
                propertyAddress: recentClosings.find(c => c.id === selectedContact)?.address,
                currentContent: draft,
              }}
              onAcceptDraft={(newDraft) => setDraft(newDraft)}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(draft, "draft")}>
                {copiedId === "draft" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1">Copy</span>
              </Button>
              <Button size="sm" onClick={handleSendDraft} disabled={sendingDraft}>
                {sendingDraft ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                Send
              </Button>
            </div>
          </div>
        )}

        {/* Extract Testimonials */}
        <div>
          <Button variant="outline" size="sm" onClick={handleExtractTestimonials} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            Extract Testimonials
          </Button>
          {extractedTestimonials.length > 0 && (
            <div className="mt-3 space-y-2">
              {extractedTestimonials.map((testimonial, i) => (
                <div key={i} className="p-3 rounded-lg border bg-muted/30">
                  <p className="text-sm italic">"{testimonial}"</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => copyToClipboard(testimonial, `testimonial-${i}`)}
                  >
                    {copiedId === `testimonial-${i}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    <span className="ml-1 text-xs">Copy</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Existing Reviews */}
        <div>
          <h4 className="text-sm font-medium mb-3">Existing Reviews</h4>
          <div className="space-y-2 max-h-[200px] overflow-y-auto">
            {existingReviews.slice(0, 5).map((review) => (
              <div key={review.id} className="p-3 rounded-lg border">
                <div className="flex items-center justify-between mb-1">
                  <Badge variant="outline">{review.platform}</Badge>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: review.rating }).map((_, i) => (
                      <Star key={i} className="h-3 w-3 fill-amber-400 text-amber-400" />
                    ))}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">{review.review_text}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => handleGenerateResponse(review)}
                  disabled={isPending && responseId === review.id}
                >
                  {isPending && responseId === review.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <MessageSquare className="h-3 w-3" />
                  )}
                  <span className="ml-1 text-xs">Generate Response</span>
                </Button>
                {responseId === review.id && (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={responseText}
                      onChange={(e) => setResponseText(e.target.value)}
                      rows={4}
                      placeholder="Write your response, or generate a draft above…"
                      className="text-sm"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={publishing || !responseText.trim()}
                        onClick={() => handleSaveResponse(review.id, false)}
                      >
                        {publishing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                        <span className="text-xs">Save Response</span>
                      </Button>
                      <Button
                        size="sm"
                        disabled={publishing || !responseText.trim()}
                        onClick={() => handleSaveResponse(review.id, true)}
                      >
                        {publishing ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Send className="h-3 w-3 mr-1" />
                        )}
                        <span className="text-xs">Publish Response</span>
                      </Button>
                    </div>
                    {responseError && (
                      <p className="text-xs text-destructive">{responseError}</p>
                    )}
                    {responsePublished && (
                      <p className="text-xs text-emerald-600">{responsePublished}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
            {existingReviews.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No reviews yet</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
