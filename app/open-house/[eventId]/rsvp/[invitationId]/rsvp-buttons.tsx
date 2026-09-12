"use client"

// Client half of the public RSVP page. Calls
// app/actions/open-house-automation.ts:handleRSVP, which returns a distinct
// message per answer AND refuses when the update touched zero rows — so what is
// rendered here is what the database actually recorded, not an assumption that
// the call worked.

import { useState } from "react"
import { handleRSVP } from "@/app/actions/open-house-automation"

const CHOICES = [
  { value: "yes",   label: "I'll be there" },
  { value: "maybe", label: "Maybe" },
  { value: "no",    label: "Can't make it" },
] as const

export function RsvpButtons({
  eventId,
  invitationId,
  existingResponse,
}: {
  eventId: string
  invitationId: string
  existingResponse: string | null
}) {
  const [answered, setAnswered] = useState<string | null>(existingResponse)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function respond(response: "yes" | "maybe" | "no") {
    setBusy(response)
    setError(null)
    try {
      const res = await handleRSVP({ eventId, invitationId, response })
      if (!res.success) {
        setError(res.error ?? "Your RSVP could not be saved. Please try again.")
        return
      }
      setAnswered(response)
      setMessage((res as { message?: string }).message ?? "Thanks — your RSVP is recorded.")
    } catch (e: any) {
      setError(e?.message ?? "Your RSVP could not be saved. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      {answered && !message && (
        <p className="text-sm text-muted-foreground">
          You previously answered <strong>{answered}</strong>. You can change it below.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            disabled={busy !== null}
            onClick={() => respond(c.value)}
            className={`rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60 ${
              answered === c.value ? "border-primary bg-primary/10" : "hover:bg-muted/50"
            }`}
          >
            {busy === c.value ? "Saving…" : c.label}
          </button>
        ))}
      </div>
      {message && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
