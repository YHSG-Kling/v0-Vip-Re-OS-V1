"use client"

/**
 * DRAFT A SEQUENCE WITH AI — the campaign generator whose output could never be sent.
 *
 * `app/actions/ai-lead-nurturing.ts:aiGenerateDripCampaign` writes a whole
 * multi-touch nurture plan — day offsets, channel mix, subject lines, body copy,
 * a call to action per touch — grounded in one contact's persona, timeline and
 * property preferences. It had no caller anywhere, and its output landed in
 * `drip_campaigns.metadata` at status "paused", where the only consumer (the
 * queue-drain cron) reads active rows ONLY and explicitly refuses to send
 * message content out of drip metadata. So the platform paid a gpt-4o call for a
 * campaign that no cron and no screen could ever reach.
 *
 * The action now drafts into the canonical nurture engine — a
 * `campaign_sequences` row plus its `campaign_sequence_steps`, created through
 * the existing owners of those tables — which is what the step-execution cron
 * runs and what the Sequence Builder edits. This card is its surface.
 *
 * IT DRAFTS, IT DOES NOT LAUNCH. The sequence is created INACTIVE and nobody is
 * enrolled. The agent opens it in the builder, edits what the model wrote, and
 * launches it themselves. Model-authored copy does not start messaging real
 * people on its own.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sparkles, Loader2, ArrowRight } from "lucide-react"
import { toast } from "sonner"
import { aiGenerateDripCampaign } from "@/app/actions/ai-lead-nurturing"

const CAMPAIGN_TYPES = [
  { value: "buyer_nurture", label: "Buyer nurture" },
  { value: "seller_nurture", label: "Seller nurture" },
  { value: "lifetime_customer", label: "Past client / lifetime" },
  { value: "sphere", label: "Sphere touchpoints" },
  { value: "investor", label: "Investor" },
  { value: "relocation", label: "Relocation" },
] as const

const DURATIONS = [
  { value: "30_days", label: "30 days" },
  { value: "60_days", label: "60 days" },
  { value: "90_days", label: "90 days" },
  { value: "6_months", label: "6 months" },
  { value: "12_months", label: "12 months" },
] as const

type CampaignType = (typeof CAMPAIGN_TYPES)[number]["value"]
type Duration = (typeof DURATIONS)[number]["value"]

export function AiSequenceDrafterCard({
  agentId,
  contacts,
}: {
  agentId: string
  contacts: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [contactId, setContactId] = useState("")
  const [campaignType, setCampaignType] = useState<CampaignType>("buyer_nurture")
  const [duration, setDuration] = useState<Duration>("90_days")
  const [drafted, setDrafted] = useState<{
    id: string
    name: string
    stepCount: number
    droppedTouchpoints: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const run = () => {
    setError(null)
    setDrafted(null)
    startTransition(async () => {
      const result = await aiGenerateDripCampaign({
        contactId,
        agentId,
        campaignType,
        duration,
      })
      if (!result.success) {
        setError(result.error ?? "Could not draft a sequence.")
        return
      }
      const campaign = (result as any).campaign
      setDrafted({
        id: campaign.id,
        name: campaign.name,
        stepCount: campaign.stepCount ?? 0,
        droppedTouchpoints: campaign.droppedTouchpoints ?? 0,
      })
      toast.success(`"${campaign.name}" drafted with ${campaign.stepCount} steps — inactive until you launch it`)
      router.refresh()
    })
  }

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          Draft a sequence with AI
        </CardTitle>
        <CardDescription>
          Pick a contact to model it on. You get a full multi-touch draft to edit — nothing is sent.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {!agentId ? (
          <p className="text-sm text-muted-foreground">
            No agent profile is linked to this account yet, so a sequence has no owner to draft under.
          </p>
        ) : contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add a contact first — the draft is modelled on a real person's persona and timeline.
          </p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <Label className="text-[11px]">Model it on</Label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <SelectValue placeholder="Pick a contact" />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[11px]">Type</Label>
                <Select value={campaignType} onValueChange={(v) => setCampaignType(v as CampaignType)}>
                  <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAMPAIGN_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[11px]">Over</Label>
                <Select value={duration} onValueChange={(v) => setDuration(v as Duration)}>
                  <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button size="sm" onClick={run} disabled={isPending || !contactId}>
              {isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Draft sequence
            </Button>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {drafted && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                <p className="text-sm font-medium">{drafted.name}</p>
                <p className="text-muted-foreground">
                  {drafted.stepCount} steps · inactive · nobody enrolled
                  {drafted.droppedTouchpoints > 0 &&
                    ` · ${drafted.droppedTouchpoints} touchpoint${drafted.droppedTouchpoints === 1 ? "" : "s"} dropped (channel this platform cannot send)`}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7 text-xs"
                  onClick={() => router.push(`/dashboard/campaigns/sequences/${drafted.id}`)}
                >
                  Open in builder <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
