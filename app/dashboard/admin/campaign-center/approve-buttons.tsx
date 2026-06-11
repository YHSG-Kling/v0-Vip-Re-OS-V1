"use client"
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import type { CampaignChannel } from "@/lib/kernel/campaign-center"
import { approveCampaignItemAction, approveCampaignPlayAction } from "./actions"

export function ApproveItemButton({ channel, id }: { channel: CampaignChannel; id: string }) {
  const [pending, start] = useTransition()
  const [note, setNote] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  if (done) return <span className="text-xs text-muted-foreground">Approved ✓</span>
  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-xs text-amber-600 max-w-[16rem] text-right">{note}</span>}
      <Button size="sm" variant="outline" disabled={pending}
        onClick={() => start(async () => { const r = await approveCampaignItemAction(channel, id); if (r.ok) setDone(true); else setNote(r.note ?? "Couldn't approve.") })}>
        {pending ? "…" : "Approve"}
      </Button>
    </div>
  )
}

export function ApprovePlayButton({ play }: { play: string }) {
  const [pending, start] = useTransition()
  const [result, setResult] = useState<{ approved: number; needsAttention: number } | null>(null)
  return (
    <Button size="sm" variant="default" disabled={pending}
      onClick={() => start(async () => setResult(await approveCampaignPlayAction(play)))}>
      {pending ? "Approving…" : result ? `Approved ${result.approved}${result.needsAttention ? ` · ${result.needsAttention} need a step` : ""}` : `Approve all · ${play}`}
    </Button>
  )
}
