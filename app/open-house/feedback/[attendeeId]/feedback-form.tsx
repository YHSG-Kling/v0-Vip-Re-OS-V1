"use client"

// The client half of the open-house feedback page. Calls
// app/actions/open-house-automation.ts:submitFeedback — a writer that was
// complete, tenant-hardened (it refuses to write feedback it cannot anchor to a
// brokerage, because that table's RLS treats a null tenant as world-readable)
// and had no caller anywhere, because the page the emailed link points at had
// never been built.
//
// The action reports partial outcomes honestly ("your rating was recorded but
// the detailed feedback could not be saved") — this form shows exactly what it
// says rather than a blanket thank-you.

import { useState } from "react"
import { submitFeedback } from "@/app/actions/open-house-automation"

const RATINGS = [1, 2, 3, 4, 5] as const

export function FeedbackForm({
  attendeeId,
  alreadySubmitted,
}: {
  attendeeId: string
  alreadySubmitted: boolean
}) {
  const [rating, setRating] = useState<number | null>(null)
  const [likedMost, setLikedMost] = useState("")
  const [concerns, setConcerns] = useState("")
  const [pricing, setPricing] = useState("")
  const [wouldOffer, setWouldOffer] = useState<"yes" | "maybe" | "no" | "">("")
  const [comments, setComments] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(alreadySubmitted)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (rating === null) {
      setError("Pick a rating first.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await submitFeedback({
        attendeeId,
        overallRating: rating,
        whatLikedMost: likedMost || undefined,
        concerns: concerns || undefined,
        pricingFeedback: pricing || undefined,
        wouldMakeOffer: wouldOffer || undefined,
        additionalComments: comments || undefined,
      })
      if (!res.success) {
        setError(res.error ?? "Your feedback could not be saved. Please try again.")
        return
      }
      setDone(true)
    } catch (err: any) {
      setError(err?.message ?? "Your feedback could not be saved. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        Thank you — your feedback has been sent to the listing agent.
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Overall, how did the home show?</legend>
        <div className="flex gap-2">
          {RATINGS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRating(r)}
              aria-pressed={rating === r}
              className={`h-10 w-10 rounded-md border text-sm font-semibold ${
                rating === r ? "border-primary bg-primary/10" : "hover:bg-muted/50"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">1 = not for me · 5 = loved it</p>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">What did you like most?</span>
        <textarea
          rows={2}
          value={likedMost}
          onChange={(e) => setLikedMost(e.target.value)}
          className="w-full rounded-md border p-2 text-sm"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Any concerns?</span>
        <textarea
          rows={2}
          value={concerns}
          onChange={(e) => setConcerns(e.target.value)}
          className="w-full rounded-md border p-2 text-sm"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">How did the asking price feel?</span>
        <input
          value={pricing}
          onChange={(e) => setPricing(e.target.value)}
          placeholder="e.g. about right, a little high for the area"
          className="w-full rounded-md border p-2 text-sm"
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Would you consider making an offer?</legend>
        <div className="flex gap-2">
          {(["yes", "maybe", "no"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setWouldOffer(v)}
              aria-pressed={wouldOffer === v}
              className={`rounded-md border px-3 py-1.5 text-sm capitalize ${
                wouldOffer === v ? "border-primary bg-primary/10" : "hover:bg-muted/50"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Anything else?</span>
        <textarea
          rows={3}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          className="w-full rounded-md border p-2 text-sm"
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? "Sending…" : "Send feedback"}
      </button>
    </form>
  )
}
