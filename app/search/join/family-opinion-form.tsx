"use client"

/**
 * The collaborator's opinion on ONE shared home (C28, wave 149 lane 149B). Calls the server door only — the token is
 * the credential; the door resolves the member it proves and records the opinion for the buyer.
 */

import { useState, useTransition } from "react"
import { submitFamilyOpinionAction } from "@/app/actions/collaborative-search"
import { Button } from "@/components/ui/button"

const VOTES = [
  { key: "love", label: "Love it" },
  { key: "like", label: "Like it" },
  { key: "neutral", label: "Not sure" },
  { key: "dislike", label: "Not for me" },
  { key: "pass", label: "Pass" },
] as const
type Vote = (typeof VOTES)[number]["key"]

export function FamilyOpinionForm({ token, sharedHomeId, initialVote, initialComment }: {
  token: string
  sharedHomeId: string
  initialVote: Vote | null
  initialComment: string | null
}) {
  const [vote, setVote] = useState<Vote | null>(initialVote)
  const [comment, setComment] = useState(initialComment ?? "")
  const [status, setStatus] = useState<string | null>(initialVote ? "Your opinion is saved." : null)
  const [pending, start] = useTransition()

  const save = () => {
    if (!vote) { setStatus("Pick how this home feels to you first."); return }
    start(async () => {
      const r = await submitFamilyOpinionAction({ token, sharedHomeId, vote, comment })
      setStatus(r.ok ? "Thank you — your opinion is saved." : r.error)
    })
  }

  return (
    <div className="space-y-2">
      <div role="group" aria-label="How does this home feel to you?" className="flex flex-wrap gap-2">
        {VOTES.map((v) => (
          <Button key={v.key} type="button" size="sm" variant={vote === v.key ? "default" : "outline"} aria-pressed={vote === v.key} onClick={() => setVote(v.key)}>
            {v.label}
          </Button>
        ))}
      </div>
      <label className="block text-sm">
        <span className="text-muted-foreground">Anything you'd want them to know? (optional)</span>
        <textarea
          className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
          rows={2}
          maxLength={600}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save my opinion"}</Button>
        {status && <p className="text-sm text-muted-foreground" aria-live="polite">{status}</p>}
      </div>
    </div>
  )
}
