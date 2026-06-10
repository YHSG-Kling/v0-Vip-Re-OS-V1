"use client"

import { useState, useTransition } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Check, X, Phone } from "lucide-react"
import { proposeDialBatchAction, approveDialBatchAction, rejectDialBatchAction } from "@/app/actions/voice-dial-batch"

interface Batch {
  id: string
  status: string
  script: string | null
  proposedCount: number
  dialedCount: number | null
  proposedAt: string | null
  completedAt: string | null
  targets: Array<{ name: string; propensity_score: number }>
}

function statusBadge(s: string) {
  const tone: Record<string, string> = {
    proposed: "bg-blue-100 text-blue-800", completed: "bg-green-100 text-green-800",
    rejected: "bg-slate-100 text-slate-600", cancelled: "bg-slate-100 text-slate-600",
  }
  return <Badge className={`text-xs ${tone[s] ?? "bg-slate-100 text-slate-600"}`}>{s}</Badge>
}

export function DialBatchClient({ initialBatches }: { initialBatches: Batch[] }) {
  const [batches, setBatches] = useState<Batch[]>(initialBatches)
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  function propose() {
    setMsg(null)
    startTransition(async () => {
      const r = await proposeDialBatchAction()
      if (r.ok) setMsg(`Proposed a batch of ${r.eligibleCount} consented contacts — reload to review.`)
      else setMsg(r.error ?? "Could not propose a batch.")
    })
  }
  function act(id: string, kind: "approve" | "reject") {
    setMsg(null)
    startTransition(async () => {
      if (kind === "approve") {
        const r = await approveDialBatchAction(id)
        if (r.ok) { setMsg(`Approved — ${r.dialedCount} will dial${(r.droppedForConsent ?? 0) > 0 ? `, ${r.droppedForConsent} dropped (consent changed)` : ""}.`); setBatches((p) => p.map((b) => b.id === id ? { ...b, status: "completed", dialedCount: r.dialedCount ?? 0 } : b)) }
        else setMsg(r.error ?? "Approve failed.")
      } else {
        const r = await rejectDialBatchAction(id)
        if (r.ok) setBatches((p) => p.map((b) => b.id === id ? { ...b, status: "rejected" } : b))
        else setMsg(r.error ?? "Reject failed.")
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button onClick={propose} disabled={pending} className="bg-indigo-600 hover:bg-indigo-700">
          <Phone className="h-4 w-4 mr-1" /> Propose new batch
        </Button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </div>

      {batches.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">No dial batches yet — propose one from your consented hot-list.</Card>
      ) : batches.map((b) => (
        <Card key={b.id} className="p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {statusBadge(b.status)}
              <span className="text-sm font-medium">{b.proposedCount} consented contact{b.proposedCount === 1 ? "" : "s"}</span>
              {b.dialedCount != null && <span className="text-xs text-muted-foreground">· {b.dialedCount} dialed</span>}
            </div>
            {b.status === "proposed" && (
              <div className="flex gap-2">
                <Button size="sm" className="bg-green-600 hover:bg-green-700" disabled={pending} onClick={() => act(b.id, "approve")}>
                  <Check className="h-4 w-4 mr-1" /> Approve &amp; dial
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(b.id, "reject")}>
                  <X className="h-4 w-4 mr-1" /> Reject
                </Button>
              </div>
            )}
          </div>
          {b.script && <p className="text-xs text-muted-foreground">{b.script}</p>}
          <div className="flex flex-wrap gap-1.5">
            {b.targets.slice(0, 12).map((t, i) => (
              <Badge key={i} className="bg-slate-100 text-slate-700 text-[11px]">{t.name} · {t.propensity_score}</Badge>
            ))}
            {b.targets.length > 12 && <span className="text-[11px] text-muted-foreground">+{b.targets.length - 12} more</span>}
          </div>
        </Card>
      ))}
    </div>
  )
}
