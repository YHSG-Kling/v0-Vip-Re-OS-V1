"use client"

// The door for app/actions/compliance-monitoring.ts:analyzeFairHousingRisk
// (restored by owner ruling, lane F2 2026-08-28) — the CONTACT-LINKED post-hoc
// fair-housing review. An agent or reviewer pastes a communication that
// already happened with a specific contact and gets a coaching/audit verdict;
// the finding is filed as a compliance_flags row (status "flagged") that the
// compliance command center's Flagged Content Queue lists and resolves.
// Identity and tenant are session-derived inside the action — this form sends
// only WHICH contact, WHAT KIND of communication, and the text.

import { useState, useTransition } from "react"
import { analyzeFairHousingRisk } from "@/app/actions/compliance-monitoring"

export interface ReviewContact {
  id: string
  name: string
}

const INTERACTION_TYPES = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text message" },
  { value: "call_transcript", label: "Call transcript" },
  { value: "note", label: "Note" },
  { value: "other", label: "Other" },
] as const

type InteractionType = (typeof INTERACTION_TYPES)[number]["value"]

interface ReviewResult {
  riskScore: number
  severity: "critical" | "high" | "medium"
  protectedClassMentioned: boolean
  steeringDetected: boolean
  flaggedPhrases: string[]
  explanation: string
  recommendation: string
}

const SEVERITY_STYLES: Record<ReviewResult["severity"], string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-400 text-black",
}

export default function FairHousingReviewCard({ contacts }: { contacts: ReviewContact[] }) {
  const [contactId, setContactId] = useState("")
  const [interactionType, setInteractionType] = useState<InteractionType>("email")
  const [text, setText] = useState("")
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleRun() {
    setError(null)
    setResult(null)
    startTransition(async () => {
      try {
        const res = await analyzeFairHousingRisk({
          contactId,
          interactionType,
          communicationText: text,
        })
        if (!res.success) {
          setError(("error" in res && res.error) || "The review could not be completed.")
          return
        }
        setResult(res as ReviewResult & { success: true })
      } catch (err: any) {
        setError(err?.message ?? "The review could not be completed.")
      }
    })
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Fair-Housing Review</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Post-hoc review of a specific communication with a contact. A flagged finding is filed to
          the compliance command center&rsquo;s flagged-content queue for officer review.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Contact</label>
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            className="w-full text-sm border border-border rounded px-2 py-1.5 bg-background text-foreground"
          >
            <option value="">Select a contact…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Communication type</label>
          <select
            value={interactionType}
            onChange={(e) => setInteractionType(e.target.value as InteractionType)}
            className="w-full text-sm border border-border rounded px-2 py-1.5 bg-background text-foreground"
          >
            {INTERACTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Communication text</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Paste the message, note, or transcript exactly as it was sent or said…"
          className="w-full text-sm border border-border rounded px-2 py-1.5 bg-background text-foreground resize-y"
        />
      </div>

      <button
        onClick={handleRun}
        disabled={isPending || !contactId || !text.trim()}
        className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-40"
      >
        {isPending ? "Reviewing…" : "Run fair-housing review"}
      </button>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {result && (
        <div className="rounded-md border border-border p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${SEVERITY_STYLES[result.severity]}`}>
              {result.severity.toUpperCase()} · {Math.round(result.riskScore * 100)}%
            </span>
            {result.protectedClassMentioned && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                protected class mentioned
              </span>
            )}
            {result.steeringDetected && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                steering detected
              </span>
            )}
          </div>
          {result.flaggedPhrases.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Flagged phrases: </span>
              {result.flaggedPhrases.join("; ")}
            </p>
          )}
          {result.explanation && <p className="text-sm text-foreground">{result.explanation}</p>}
          {result.recommendation && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Recommended: </span>
              {result.recommendation}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            This finding was filed to the compliance flagged-content queue for officer review.
          </p>
        </div>
      )}
    </div>
  )
}
