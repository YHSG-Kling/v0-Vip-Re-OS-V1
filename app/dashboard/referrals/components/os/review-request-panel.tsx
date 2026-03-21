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

interface RecentClosing {
  id: string
  contact_id: string
  contactName: string
  address: string
  closeDate: string
  transactionId: string
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

  const handleRequestReview = async (closing: RecentClosing) => {
    setSelectedContact(closing.id)
    setDraft("")
    setComplianceOk(null)

    startTransition(async () => {
      // Check timing first
      await aiDetermineReviewTiming({ transactionId: closing.transactionId })

      // Generate request
      const result = await aiGenerateReviewRequest({
        transactionId: closing.transactionId,
        agentId,
        platform: platform as "google" | "zillow" | "realtor" | "yelp" | "facebook",
        channel: channel as "email" | "sms" | "in_person",
      })

      if (result.success && result.message) {
        setDraft(result.message)
        awardPointsForAction(agentId, "review_received").catch(() => {})
        // Check compliance
        const compliance = await checkThemFirstCompliance(result.message)
        setComplianceOk(compliance.isCompliant)
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
    startTransition(async () => {
      const result = await aiGenerateReviewResponse({
        reviewId: review.id,
        agentId,
        reviewText: review.review_text,
        rating: review.rating,
      })
      if (result.success && result.response) {
        setResponseText(result.response)
      }
    })
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
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
              <Button size="sm">
                <Send className="h-4 w-4 mr-1" />
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
                {responseId === review.id && responseText && (
                  <div className="mt-2 p-2 bg-muted rounded text-sm">{responseText}</div>
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
