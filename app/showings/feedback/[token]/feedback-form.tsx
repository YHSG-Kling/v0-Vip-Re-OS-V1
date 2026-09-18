"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Star } from "lucide-react"
import { aiAnalyzeShowingFeedback } from "@/app/actions/ai-showing-management"

interface Props {
  token: string
  requestId: string
  showingId: string
  displayDate: string
  propertyAddress: string
  alreadySubmitted: boolean
}

type LargeOption = { value: string; label: string }

function LargeSelect({
  options,
  value,
  onChange,
}: {
  options: LargeOption[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-xl border px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            value === o.value
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background text-foreground hover:bg-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hovered, setHovered] = useState(0)
  return (
    <div className="flex gap-1" role="group" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(i)}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(0)}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${i} star${i > 1 ? "s" : ""}`}
        >
          <Star
            className={`h-8 w-8 transition-colors ${
              i <= (hovered || value)
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground/30"
            }`}
          />
        </button>
      ))}
    </div>
  )
}

const PRICE_OPTIONS: LargeOption[] = [
  { value: "too_high",    label: "Too High" },
  { value: "priced_right",label: "Priced Right" },
  { value: "good_value",  label: "Good Value" },
]

const MEETS_OPTIONS: LargeOption[] = [
  { value: "yes",         label: "Yes" },
  { value: "partially",   label: "Partially" },
  { value: "no",          label: "No" },
]

const OFFER_OPTIONS: LargeOption[] = [
  { value: "very_likely", label: "Very Likely" },
  { value: "possible",    label: "Possible" },
  { value: "unlikely",    label: "Unlikely" },
  { value: "no",          label: "No" },
]

// The ONE showing-verdict vocabulary (§6, m568): love_it | like_it | maybe | no —
// the same CHECK showings.buyer_interest_level and tour_stops.buyer_interest_level
// carry. The old private dialect (loved_it | liked_it | neutral | not_interested)
// is retired; the API route still normalises it for tabs opened pre-deploy.
const IMPRESSION_OPTIONS: LargeOption[] = [
  { value: "love_it",  label: "Loved It" },
  { value: "like_it",  label: "Liked It" },
  { value: "maybe",    label: "Neutral" },
  { value: "no",       label: "Not Interested" },
]

const INTEREST_OPTIONS: LargeOption[] = [
  { value: "hot",   label: "Hot" },
  { value: "warm",  label: "Warm" },
  { value: "cool",  label: "Cool" },
  { value: "cold",  label: "Cold" },
]

export default function FeedbackForm({
  token,
  requestId,
  showingId,
  displayDate,
  propertyAddress,
  alreadySubmitted: initialSubmitted,
}: Props) {
  const [submitted, setSubmitted] = useState(initialSubmitted)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [presentationRating, setPresentationRating] = useState(0)
  const [cleanlinessRating, setCleanlinessRating] = useState(0)
  const [priceOpinion, setPriceOpinion] = useState("")
  const [meetsBuyerNeeds, setMeetsBuyerNeeds] = useState("")
  const [offerInterest, setOfferInterest] = useState("")
  const [favoriteFeatures, setFavoriteFeatures] = useState("")
  const [specificConcerns, setSpecificConcerns] = useState("")
  const [overallImpression, setOverallImpression] = useState("")
  const [buyerInterestLevel, setBuyerInterestLevel] = useState("")
  const [additionalNotes, setAdditionalNotes] = useState("")
  // WHO SUBMITTED. showing_feedback.submitted_by_agent_name / _email are read
  // back by the listing agent's feedback panel
  // (app/components/dashboard/listings/showings/feedback-summary-panel.tsx:217)
  // and by getShowingFeedbackCards (app/actions/seller-showings.ts:731) — and
  // nothing on this form ever collected them, so every card fell through to the
  // showing's buyer-agent name or, failing that, to "Anonymous". Optional: a
  // showing agent who would rather not be named still gets to submit.
  const [submittedByAgentName, setSubmittedByAgentName] = useState("")
  const [submittedByAgentEmail, setSubmittedByAgentEmail] = useState("")

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-sm text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Star className="h-8 w-8 fill-amber-400 text-amber-400" />
            </div>
          </div>
          <h1 className="mb-2 text-xl font-semibold text-foreground">Thank You!</h1>
          <p className="text-sm text-muted-foreground">
            Your feedback on <strong>{propertyAddress}</strong> has been received. The listing agent appreciates you taking the time.
          </p>
        </div>
      </div>
    )
  }

  function handleSubmit() {
    if (!presentationRating || !cleanlinessRating || !priceOpinion || !meetsBuyerNeeds || !offerInterest || !overallImpression || !buyerInterestLevel) {
      setError("Please complete all required questions before submitting.")
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await fetch(`/api/showings/feedback/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          showingId,
          presentationRating,
          cleanlinessRating,
          priceOpinion,
          meetsBuyerNeeds,
          offerInterest,
          favoriteFeatures,
          specificConcerns,
          overallImpression,
          buyerInterestLevel,
          additionalNotes,
          submittedByAgentName,
          submittedByAgentEmail,
        }),
      })
      const body = await res.json()
      if (body.success) {
        setSubmitted(true)
        // Fire analysis in background — does not block success UX
        const savedFeedbackId = body.feedbackId
        if (savedFeedbackId) {
          aiAnalyzeShowingFeedback(savedFeedbackId).catch(err =>
            console.warn('[ShowingFeedback] Analysis running in background:', err)
          )
        }
      } else {
        setError(body.error ?? "Something went wrong. Please try again.")
      }
    })
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <div className="bg-background border-b border-border px-4 py-6">
        <div className="mx-auto max-w-lg">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Showing Feedback</p>
          <h1 className="text-xl font-semibold text-foreground leading-tight">{propertyAddress}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Showing on {displayDate}</p>
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 py-6 flex flex-col gap-4">
        {/* Q1 — Presentation */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">1. How was the home presentation?</p>
          <StarRating value={presentationRating} onChange={setPresentationRating} />
        </div>

        {/* Q2 — Cleanliness */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">2. How was the cleanliness?</p>
          <StarRating value={cleanlinessRating} onChange={setCleanlinessRating} />
        </div>

        {/* Q3 — Price opinion */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">3. What is your opinion on the price?</p>
          <LargeSelect options={PRICE_OPTIONS} value={priceOpinion} onChange={setPriceOpinion} />
        </div>

        {/* Q4 — Meets needs */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">4. Does it meet your buyer's needs?</p>
          <LargeSelect options={MEETS_OPTIONS} value={meetsBuyerNeeds} onChange={setMeetsBuyerNeeds} />
        </div>

        {/* Q5 — Offer interest */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">5. How likely are you to make an offer?</p>
          <LargeSelect options={OFFER_OPTIONS} value={offerInterest} onChange={setOfferInterest} />
        </div>

        {/* Q6 — Liked most */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">
            6. What did your buyers like most?{" "}
            <span className="text-xs text-muted-foreground font-normal">(optional)</span>
          </p>
          <Textarea
            value={favoriteFeatures}
            onChange={(e) => setFavoriteFeatures(e.target.value)}
            placeholder="e.g. open floor plan, natural light, kitchen layout..."
            rows={3}
          />
        </div>

        {/* Q7 — Specific concerns */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">
            7. Any specific concerns?{" "}
            <span className="text-xs text-muted-foreground font-normal">(optional)</span>
          </p>
          <Textarea
            value={specificConcerns}
            onChange={(e) => setSpecificConcerns(e.target.value)}
            placeholder="e.g. small backyard, busy street, price..."
            rows={3}
          />
        </div>

        {/* Q8 — Overall impression */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">8. Overall impression?</p>
          <LargeSelect options={IMPRESSION_OPTIONS} value={overallImpression} onChange={setOverallImpression} />
        </div>

        {/* Q9 — Buyer interest level */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">9. Buyer interest level?</p>
          <LargeSelect options={INTEREST_OPTIONS} value={buyerInterestLevel} onChange={setBuyerInterestLevel} />
        </div>

        {/* Q10 — Anything else */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">
            10. Anything else you'd like to share?{" "}
            <span className="text-xs text-muted-foreground font-normal">(optional)</span>
          </p>
          <Textarea
            value={additionalNotes}
            onChange={(e) => setAdditionalNotes(e.target.value)}
            placeholder="Any other notes for the listing agent..."
            rows={3}
          />
        </div>

        {/* Who submitted — optional, and the only place this is ever collected */}
        <div className="rounded-xl border border-border bg-background p-5">
          <p className="mb-3 font-medium text-foreground">
            11. Who should the listing agent thank?{" "}
            <span className="text-xs text-muted-foreground font-normal">(optional)</span>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              type="text"
              value={submittedByAgentName}
              onChange={(e) => setSubmittedByAgentName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <input
              type="email"
              value={submittedByAgentEmail}
              onChange={(e) => setSubmittedByAgentEmail(e.target.value)}
              placeholder="Your email"
              aria-label="Your email"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Leave blank to stay anonymous.
          </p>
        </div>

        {/* Error */}
        {error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Submit */}
        <Button
          onClick={handleSubmit}
          disabled={isPending}
          className="w-full py-6 text-base"
        >
          {isPending ? "Submitting..." : "Submit Feedback"}
        </Button>

        <p className="pb-6 text-center text-xs text-muted-foreground">
          Your feedback is shared only with the listing agent.
        </p>
      </div>
    </div>
  )
}
