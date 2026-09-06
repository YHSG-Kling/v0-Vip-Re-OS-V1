"use client"

/**
 * app/crm/contacts/[contactId]/components/memory-video-card.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OFFER SURFACE for the memory video, and the sheet the agent types the
 * seller's answers onto.
 *
 * OWNER RULING: "memory video is for sellers that have been in their home more
 * than 20 years which is a seller dictated video going over the history of the
 * house so the family has it (this is a special service that can be offered)."
 *
 * Three product facts show up as three properties of this component:
 *
 *   · IT IS OFFERED, NOT SENT. The button files a GATED PROPOSAL for a human to
 *     approve (lib/video/memory-video.ts → proposeClientMessage). Nothing on this
 *     card reaches the seller by itself.
 *   · ELIGIBILITY IS DECIDED SERVER-SIDE AND FAILS CLOSED. The card renders only
 *     for a contact the tenure gate admitted; when tenure is unknown or under the
 *     threshold the parent renders NOTHING. No "coming soon" tile, no greyed-out
 *     teaser — an affordance for a service this family cannot be offered is worse
 *     than no affordance. The action re-checks anyway, so a stale page cannot
 *     smuggle an ineligible contact through.
 *   · THE SELLER WRITES IT. Every box below is captioned with whose words belong
 *     in it, and there is deliberately NO "generate" / "help me write this"
 *     control anywhere on this card. A model that writes a family's history has
 *     invented it, and the family — who keep this film — are the one party who
 *     cannot tell. The rule is stated to the agent on the card, not just in a
 *     comment: lib/video/memory-video-gate.ts MODEL_MAY_NOT.
 */
import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { MEMORY_VIDEO_PROMPTS, type SellerDictatedSegment } from "@/lib/video/memory-video-gate"
import { offerMemoryVideoAction, saveMemoryVideoDictationAction } from "@/app/actions/video/memory-video"

interface Props {
  contactId: string
  /** Years in the home, as the server established them. */
  tenureYears: number
  /** True once a memory-video offer is already standing for this contact. */
  offerStanding: boolean
  /** Chapters already dictated, keyed by prompt id. */
  initialWords: Record<string, string>
  /** ai_video_projects id when a capture already exists. */
  projectId: string | null
}

export function MemoryVideoCard({
  contactId, tenureYears, offerStanding, initialWords, projectId,
}: Props) {
  const [words, setWords] = useState<Record<string, string>>(initialWords)
  const [offered, setOffered] = useState(offerStanding)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const dictatedCount = MEMORY_VIDEO_PROMPTS.filter((p) => (words[p.id] ?? "").trim().length > 0).length

  function offer() {
    setError(null); setMessage(null)
    startTransition(async () => {
      const r = await offerMemoryVideoAction(contactId)
      // The action RETURNS its refusal rather than throwing, so a failure that is
      // shown to nobody is the defect this branch exists to prevent.
      if (!r.ok) { setError(r.reason); return }
      if (r.status === "not_eligible" || r.status === "suppressed") { setError(r.reason); return }
      setOffered(true)
      setMessage(r.reason)
    })
  }

  function save() {
    setError(null); setMessage(null)
    const capturedAt = new Date().toISOString()
    const segments: SellerDictatedSegment[] = MEMORY_VIDEO_PROMPTS
      .filter((p) => (words[p.id] ?? "").trim().length > 0)
      .map((p) => ({
        promptId:    p.id,
        sellerWords: words[p.id].trim(),
        // The agent is TRANSCRIBING what the seller says. The provenance is
        // recorded on every chapter so a later reader can see whose words these
        // are without taking anyone's word for it.
        capturedVia: "agent_transcription",
        capturedAt,
      }))
    startTransition(async () => {
      const r = await saveMemoryVideoDictationAction(contactId, segments)
      if (!r.ok) { setError(r.reason); return }
      setMessage(r.reason)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Memory video
          <Badge variant="secondary">{Math.floor(tenureYears)} years in the home</Badge>
          {offered ? <Badge variant="outline">offer standing</Badge> : null}
          {projectId ? <Badge variant="outline">{dictatedCount}/{MEMORY_VIDEO_PROMPTS.length} chapters</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          A special service for long-time owners: the story of the house, in the seller&apos;s own
          words, for the family to keep. Offering it proposes a note for your approval — nothing is
          sent until you approve it.
        </p>
        <p className="text-sm font-medium">
          Type what they say, as they say it. Nothing on this page writes any part of this film —
          a family&apos;s history is theirs to tell, not ours to compose.
        </p>

        <Button onClick={offer} disabled={pending || offered} size="sm">
          {offered ? "Offer already proposed" : "Offer the memory video"}
        </Button>

        <div className="space-y-3 pt-2">
          {MEMORY_VIDEO_PROMPTS.map((p) => (
            <div key={p.id} className="space-y-1">
              <label htmlFor={`mv-${p.id}`} className="text-sm font-medium">{p.ask}</label>
              <Textarea
                id={`mv-${p.id}`}
                rows={3}
                placeholder="Their answer, in their words"
                value={words[p.id] ?? ""}
                onChange={(e) => setWords((w) => ({ ...w, [p.id]: e.target.value }))}
              />
            </div>
          ))}
        </div>

        <Button onClick={save} disabled={pending || dictatedCount === 0} size="sm" variant="secondary">
          Save what they dictated
        </Button>

        {message ? <p className="text-sm text-emerald-600">{message}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  )
}
