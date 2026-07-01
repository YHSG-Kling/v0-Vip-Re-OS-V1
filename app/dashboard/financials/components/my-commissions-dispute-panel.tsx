"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, Flag, Check } from "lucide-react"
import { toast } from "sonner"
import { loadMyDisputableCommissionsAction, fileCommissionDisputeAction } from "@/app/actions/financial-kernel"

interface Row {
  id: string
  transaction_id: string | null
  gross_commission: number | null
  agent_commission: number | null
  agent_split_percent: number | null
  status: string
  dispute_reason: string | null
  dispute_resolution: string | null
}

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

/** Agent-facing: review your commissions and DISPUTE one that looks wrong (bad split/amount). */
export function MyCommissionsDisputePanel() {
  const [rows, setRows] = useState<Row[]>([])
  const [brokerageId, setBrokerageId] = useState("")
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [pending, startTransition] = useTransition()

  const load = () => {
    loadMyDisputableCommissionsAction().then((res) => {
      if (res.success) { setRows(res.commissions as Row[]); setBrokerageId(res.brokerageId) }
      setLoading(false)
    })
  }
  useEffect(load, [])

  const submit = (id: string) => {
    startTransition(async () => {
      const res = await fileCommissionDisputeAction({ commissionId: id, brokerageId, reason })
      if (res.success) { toast.success("Dispute filed — your broker will review it"); setOpenId(null); setReason(""); load() }
      else toast.error("Could not file the dispute", { description: res.error })
    })
  }

  if (loading) return <Card><CardContent className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading your commissions…</CardContent></Card>
  if (rows.length === 0) return null

  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Flag className="h-4 w-4 text-amber-600" /> My commissions</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-muted-foreground">Txn #{r.transaction_id?.slice(0, 8) ?? "—"} · {r.agent_split_percent != null ? `${r.agent_split_percent}% split` : ""}</span>
              <span className="flex items-center gap-2">
                <span className="font-medium">{fmt(r.agent_commission ?? 0)}</span>
                <Badge variant={r.status === "disputed" ? "destructive" : r.status === "approved" ? "default" : "secondary"} className="text-[10px]">{r.status}</Badge>
              </span>
            </div>
            {r.status === "disputed" ? (
              <p className="text-xs text-amber-700 mt-1">Disputed{r.dispute_reason ? `: "${r.dispute_reason}"` : ""}{r.dispute_resolution ? ` · resolved (${r.dispute_resolution})` : " · awaiting broker review"}</p>
            ) : openId === r.id ? (
              <div className="mt-2 space-y-2">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What looks wrong? (split, amount, missing adjustment…)" rows={2} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={pending || reason.trim().length < 5} onClick={() => submit(r.id)}>{pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}Submit dispute</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setOpenId(null); setReason("") }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] mt-1 text-amber-700" onClick={() => { setOpenId(r.id); setReason("") }}>Dispute this</Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
