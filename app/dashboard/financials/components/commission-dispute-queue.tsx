"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, Scale, CheckCircle2, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { loadCommissionDisputesAction, resolveCommissionDisputeAction } from "@/app/actions/financial-kernel"

interface Dispute {
  id: string
  agent_id: string
  transaction_id: string | null
  gross_commission: number | null
  agent_commission: number | null
  agent_split_percent: number | null
  dispute_reason: string | null
  disputed_at: string | null
}

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

/** Broker-facing: the disputed-commission queue with uphold / correct / reopen resolution. */
export function CommissionDisputeQueue({ brokerageId }: { brokerageId: string }) {
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()

  const load = () => {
    loadCommissionDisputesAction().then((res) => {
      if (res.success) setDisputes(res.disputes as Dispute[])
      setLoading(false)
    })
  }
  useEffect(load, [])

  const resolve = (id: string, resolution: "upheld" | "corrected" | "reopened") => {
    startTransition(async () => {
      const res = await resolveCommissionDisputeAction({ commissionId: id, brokerageId, resolution })
      if (res.success) { toast.success(`Dispute ${resolution === "reopened" ? "reopened for recalculation" : "resolved"}`); load() }
      else toast.error("Could not resolve the dispute", { description: res.error })
    })
  }

  if (loading) return <Card><CardContent className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading disputes…</CardContent></Card>
  if (disputes.length === 0) return null

  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Scale className="h-4 w-4 text-amber-600" /> Commission disputes ({disputes.length})</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {disputes.map((d) => (
          <div key={d.id} className="rounded-lg border p-3 text-sm space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-muted-foreground">Txn #{d.transaction_id?.slice(0, 8) ?? "—"} · {d.agent_split_percent != null ? `${d.agent_split_percent}% split` : ""}</span>
              <span className="font-medium">{fmt(d.agent_commission ?? 0)} <span className="text-muted-foreground font-normal">of {fmt(d.gross_commission ?? 0)} GCI</span></span>
            </div>
            {d.dispute_reason && <p className="text-xs text-amber-700 italic">"{d.dispute_reason}"</p>}
            <div className="flex gap-1.5 flex-wrap">
              <Button size="sm" disabled={pending} onClick={() => resolve(d.id, "upheld")} className="gap-1"><CheckCircle2 className="h-3 w-3" /> Uphold (approve)</Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => resolve(d.id, "corrected")} className="gap-1"><CheckCircle2 className="h-3 w-3" /> Corrected → approve</Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => resolve(d.id, "reopened")} className="gap-1"><RotateCcw className="h-3 w-3" /> Reopen (recalculate)</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
