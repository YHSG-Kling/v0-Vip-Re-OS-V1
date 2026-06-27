"use client"

import { useState, useEffect, useTransition } from "react"
import { Heart, Calendar, Sparkles, CheckCircle2, AlertTriangle, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  saveProperty,
  unsaveProperty,
  requestShowing,
  generateSmartInsights,
  updateShowingFeedback,
} from "@/app/actions/smart-insights"
import { NeighborhoodLifestyleCard } from "./NeighborhoodLifestyleCard"

interface CommuteDestination { name: string; address: string; type: "work" | "school" | "family" | "other" }

// ── Types ──────────────────────────────────────────────────────────────────────

interface SmartInsights {
  id?: string
  match_score?: number | null
  match_reasons?: string[] | null
  match_concerns?: string[] | null
  commute_insights?: Record<string, any> | null
  school_insights?: Record<string, any> | null
  investment_insights?: Record<string, any> | null
  neighborhood_insights?: Record<string, any> | null
}

interface ShowingRequest {
  id: string
  status: string
  feedback_rating?: number | null
  feedback_notes?: string | null
  requested_date?: string | null
}

interface PropertyDetailIntelligenceClientProps {
  contactId: string
  propertyId: string
  propertyAddress: string
  propertyData: Record<string, any>
  initialIsSaved: boolean
  initialInsights: SmartInsights | null
  showings: ShowingRequest[]
  initialCommuteDestinations?: CommuteDestination[]
}

// ── Buyer Fit Score Gauge ─────────────────────────────────────────────────────

function FitScoreGauge({ score }: { score: number }) {
  const clampedScore = Math.max(0, Math.min(100, score))
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (clampedScore / 100) * circumference

  const color =
    clampedScore >= 80
      ? "#16a34a"
      : clampedScore >= 60
      ? "#2563eb"
      : clampedScore >= 40
      ? "#d97706"
      : "#dc2626"

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="100" height="100" className="-rotate-90">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.8s ease" }}
        />
      </svg>
      <div className="-mt-16 flex flex-col items-center">
        <span className="text-3xl font-bold text-foreground">{clampedScore}</span>
        <span className="text-xs text-muted-foreground">/ 100</span>
      </div>
      <div className="mt-8" />
      <span className="text-xs font-medium text-muted-foreground">Buyer Fit Score</span>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function PropertyDetailIntelligenceClient({
  contactId,
  propertyId,
  propertyAddress,
  propertyData,
  initialIsSaved,
  initialInsights,
  showings,
  initialCommuteDestinations = [],
}: PropertyDetailIntelligenceClientProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  // Save state
  const [isSaved, setIsSaved] = useState(initialIsSaved)

  // Insights state
  const [insights, setInsights] = useState<SmartInsights | null>(initialInsights)
  const [insightsLoading, setInsightsLoading] = useState(!initialInsights)

  // Showing modal state
  const [showingOpen, setShowingOpen] = useState(false)
  const [showingDate, setShowingDate] = useState("")
  const [showingTime, setShowingTime] = useState("")
  const [showingNotes, setShowingNotes] = useState("")
  const [showingSubmitting, setShowingSubmitting] = useState(false)

  // Feedback state
  const [feedbackShowingId, setFeedbackShowingId] = useState<string | null>(null)
  const [feedbackRating, setFeedbackRating] = useState(0)
  const [feedbackNotes, setFeedbackNotes] = useState("")
  const [feedbackInterest, setFeedbackInterest] = useState<
    "very_interested" | "interested" | "neutral" | "not_interested" | ""
  >("")
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackDone, setFeedbackDone] = useState(false)

  // Find a completed showing without feedback for capture
  const pendingFeedbackShowing = showings.find(
    (s) => s.status === "completed" && !s.feedback_rating
  )

  // Generate insights on mount if not already present
  useEffect(() => {
    if (initialInsights) return
    let cancelled = false
    ;(async () => {
      try {
        const result = await generateSmartInsights(propertyId, propertyData, contactId,
          initialCommuteDestinations.length ? { commuteDestinations: initialCommuteDestinations } : undefined)
        if (!cancelled && result) {
          setInsights(result as SmartInsights)
        }
      } catch {
        // Graceful degradation — show empty state
      } finally {
        if (!cancelled) setInsightsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [contactId, propertyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleToggleSave() {
    const was = isSaved
    setIsSaved(!was)
    startTransition(async () => {
      if (was) {
        const result = await unsaveProperty(contactId, propertyId)
        if (!result.success) {
          setIsSaved(true)
          toast({ title: "Could not remove from saved", variant: "destructive" })
        } else {
          toast({ title: "Removed from saved" })
        }
      } else {
        const result = await saveProperty({
          contactId,
          propertyId,
          propertyAddress,
          propertyData,
        })
        if (!result.success && !result.alreadySaved) {
          setIsSaved(false)
          toast({ title: "Could not save property", variant: "destructive" })
        } else {
          toast({ title: "Saved to your collection" })
        }
      }
    })
  }

  async function handleRequestShowing() {
    if (!showingDate || !showingTime) {
      toast({ title: "Please select a date and time", variant: "destructive" })
      return
    }
    setShowingSubmitting(true)
    try {
      const result = await requestShowing(
        contactId,
        propertyId,
        propertyAddress,
        propertyData,
        [{ date: showingDate, time: showingTime }],
        showingNotes || undefined
      )
      if (result.error) {
        toast({ title: "Could not submit request", description: result.error, variant: "destructive" })
      } else {
        toast({ title: "Showing requested! Your agent will confirm." })
        setShowingOpen(false)
        setShowingDate("")
        setShowingTime("")
        setShowingNotes("")
      }
    } finally {
      setShowingSubmitting(false)
    }
  }

  async function handleSubmitFeedback() {
    if (!feedbackShowingId || feedbackRating === 0 || !feedbackInterest) {
      toast({ title: "Please provide a rating and interest level", variant: "destructive" })
      return
    }
    setFeedbackSubmitting(true)
    try {
      const result = await updateShowingFeedback(
        feedbackShowingId,
        feedbackRating,
        feedbackNotes,
        feedbackInterest as "very_interested" | "interested" | "neutral" | "not_interested"
      )
      if (result.error) {
        toast({ title: "Could not save feedback", variant: "destructive" })
      } else {
        toast({ title: "Feedback saved, thank you!" })
        setFeedbackDone(true)
      }
    } finally {
      setFeedbackSubmitting(false)
    }
  }

  // ── Derived data ───────────────────────────────────────────────────────────

  const matchScore = insights?.match_score ?? null
  const reasons = insights?.match_reasons ?? []
  const concerns = insights?.match_concerns ?? []
  const neighborhood = insights?.neighborhood_insights as any
  const investment = insights?.investment_insights as any
  const marketTrends = neighborhood?.marketTrends

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* ── Action Buttons ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant={isSaved ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={handleToggleSave}
          disabled={isPending}
        >
          <Heart
            className="h-4 w-4"
            fill={isSaved ? "currentColor" : "none"}
          />
          {isSaved ? "Saved" : "Save Property"}
        </Button>
        <Button
          size="sm"
          className="gap-2"
          onClick={() => setShowingOpen(true)}
        >
          <Calendar className="h-4 w-4" />
          Request Showing
        </Button>
      </div>

      {/* ── AI Intelligence Card ─────────────────────────────────────────── */}
      {insightsLoading ? (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 mb-4">
              <Sparkles className="h-5 w-5 text-indigo-500 animate-pulse" />
              <span className="text-sm font-medium text-muted-foreground">
                Analyzing this property for you...
              </span>
            </div>
            <div className="space-y-3">
              <div className="h-4 w-3/4 bg-muted animate-pulse rounded" />
              <div className="h-4 w-1/2 bg-muted animate-pulse rounded" />
              <div className="h-4 w-2/3 bg-muted animate-pulse rounded" />
            </div>
          </CardContent>
        </Card>
      ) : insights ? (
        <Card className="overflow-hidden">
          {/* Gradient header */}
          <div className="bg-gradient-to-r from-indigo-600 to-blue-600 px-6 py-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-white" />
              <h3 className="text-base font-semibold text-white">AI Analysis for You</h3>
            </div>
          </div>

          <CardContent className="pt-6 space-y-6">
            {/* Score + summary row */}
            <div className="flex items-start gap-6 flex-wrap">
              {matchScore !== null && (
                <div className="shrink-0">
                  <FitScoreGauge score={matchScore} />
                </div>
              )}
              <div className="flex-1 min-w-0 space-y-3">
                {reasons.length > 0 && (
                  <div>
                    <p className="text-sm font-semibold text-foreground mb-2">What You May Love</p>
                    <ul className="space-y-1">
                      {reasons.map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-green-700">
                          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {concerns.length > 0 && (
                  <div>
                    <p className="text-sm font-semibold text-foreground mb-2">Things to Know</p>
                    <ul className="space-y-1">
                      {concerns.map((c, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-amber-700">
                          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Neighborhood / Market Intelligence ──────────────────────────── */}
      {marketTrends && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Price Intelligence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xl font-bold text-foreground">
                {marketTrends.medianHomePrice
                  ? `$${(marketTrends.medianHomePrice as number).toLocaleString()}`
                  : "—"}{" "}
                median
              </span>
              {marketTrends.yoyPriceChange !== undefined && (
                <Badge
                  variant="outline"
                  className={
                    marketTrends.yoyPriceChange >= 0
                      ? "text-green-700 border-green-200"
                      : "text-red-700 border-red-200"
                  }
                >
                  {marketTrends.yoyPriceChange > 0 ? "+" : ""}
                  {marketTrends.yoyPriceChange}% YoY
                </Badge>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {marketTrends.avgDaysOnMarket !== undefined && (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Avg Days on Market</p>
                  <p className="font-semibold">{marketTrends.avgDaysOnMarket} days</p>
                </div>
              )}
              {marketTrends.inventoryLevel && (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Inventory</p>
                  <p className="font-semibold capitalize">{marketTrends.inventoryLevel}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Investment Snapshot ──────────────────────────────────────────── */}
      {investment?.returns && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Investment Snapshot</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Cap Rate</p>
                <p className="font-semibold">{investment.returns.capRate}%</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Cash-on-Cash</p>
                <p className="font-semibold">{investment.returns.cashOnCash}%</p>
              </div>
              {investment.rentalAnalysis?.estimatedMonthlyRent && (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Est. Rent / Mo</p>
                  <p className="font-semibold">
                    ${investment.rentalAnalysis.estimatedMonthlyRent.toLocaleString()}
                  </p>
                </div>
              )}
              {investment.appreciation?.estimatedAnnualRate && (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Est. Appreciation</p>
                  <p className="font-semibold">{investment.appreciation.estimatedAnnualRate}% / yr</p>
                </div>
              )}
            </div>
            {investment.recommendation && (
              <p className="text-xs text-muted-foreground mt-3">{investment.recommendation}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Neighborhood & Lifestyle (schools, walkability, amenities, personal commute) ── */}
      {insights && (
        <NeighborhoodLifestyleCard
          contactId={contactId}
          propertyId={propertyId}
          propertyData={propertyData}
          schoolInsights={insights.school_insights ?? null}
          neighborhoodInsights={insights.neighborhood_insights ?? null}
          commuteInsights={insights.commute_insights ?? null}
          initialDestinations={initialCommuteDestinations}
        />
      )}

      {/* ── Showing Feedback Capture ─────────────────────────────────────── */}
      {!feedbackDone && pendingFeedbackShowing && (
        <Card className="border-blue-200">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">How was your showing?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Star rating */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Overall Rating</Label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => {
                      setFeedbackRating(star)
                      setFeedbackShowingId(pendingFeedbackShowing.id)
                    }}
                    className="focus:outline-none"
                  >
                    <Star
                      className="h-6 w-6 transition-colors"
                      fill={star <= feedbackRating ? "#f59e0b" : "none"}
                      stroke={star <= feedbackRating ? "#f59e0b" : "#94a3b8"}
                    />
                  </button>
                ))}
              </div>
            </div>

            {/* Interest level */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Interest Level</Label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { value: "very_interested", label: "Very Interested" },
                    { value: "interested", label: "Interested" },
                    { value: "neutral", label: "Neutral" },
                    { value: "not_interested", label: "Not Interested" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      setFeedbackInterest(opt.value)
                      setFeedbackShowingId(pendingFeedbackShowing.id)
                    }}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      feedbackInterest === opt.value
                        ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                        : "border-border text-muted-foreground hover:border-indigo-400"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-1">
              <Label htmlFor="feedbackNotes" className="text-xs text-muted-foreground">
                Notes (optional)
              </Label>
              <Textarea
                id="feedbackNotes"
                placeholder="What did you think? Any concerns?"
                value={feedbackNotes}
                onChange={(e) => setFeedbackNotes(e.target.value)}
                rows={3}
                className="resize-none text-sm"
              />
            </div>

            <Button
              size="sm"
              onClick={handleSubmitFeedback}
              disabled={feedbackSubmitting || feedbackRating === 0 || !feedbackInterest}
              className="w-full"
            >
              {feedbackSubmitting ? "Saving..." : "Submit Feedback"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Request Showing Modal ────────────────────────────────────────── */}
      <Dialog open={showingOpen} onOpenChange={setShowingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a Showing</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">{propertyAddress}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="showingDate">Preferred Date</Label>
                <input
                  id="showingDate"
                  type="date"
                  value={showingDate}
                  min={new Date(Date.now() + 86400000).toISOString().split("T")[0]}
                  onChange={(e) => setShowingDate(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="showingTime">Preferred Time</Label>
                <input
                  id="showingTime"
                  type="time"
                  value={showingTime}
                  onChange={(e) => setShowingTime(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="showingNotes">Notes for your agent (optional)</Label>
              <Textarea
                id="showingNotes"
                placeholder="e.g. interested in the backyard, want to see the basement..."
                value={showingNotes}
                onChange={(e) => setShowingNotes(e.target.value)}
                rows={3}
                className="resize-none text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowingOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRequestShowing}
              disabled={showingSubmitting || !showingDate || !showingTime}
            >
              {showingSubmitting ? "Submitting..." : "Request Showing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
