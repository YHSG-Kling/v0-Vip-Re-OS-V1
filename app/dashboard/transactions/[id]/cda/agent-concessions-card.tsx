"use client"

// AGENT CONCESSIONS on this deal (wave 144, lane 144D; owner ruling 4).
// An agent asks to give the buyer / seller a credit off their own gross commission; where the brokerage requires it, a finance
// admin approves or denies BEFORE it is committed. A seller concession (seller → buyer, out of the seller's net) is NOT here —
// it is a contract term and never touches commission. The money is computed by the waterfall, never by this card or by AI.

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  listAgentConcessionsAction,
  requestAgentConcessionAction,
  decideAgentConcessionAction,
  withdrawAgentConcessionAction,
} from "@/app/actions/commission-policy/commission-policy"

type Listed = Extract<Awaited<ReturnType<typeof listAgentConcessionsAction>>, { success: true }>
// The status wording comes from the server (lib/commission/agent-concession.ts AGENT_CONCESSION_APPROVAL_LABEL) — one label set.

export function AgentConcessionsCard({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Listed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [beneficiary, setBeneficiary] = useState<"buyer" | "seller">("buyer")
  const [valueType, setValueType] = useState<"flat" | "percent">("flat")
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [note, setNote] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await listAgentConcessionsAction(transactionId)
      if (!r.success) { setError(r.error); return }
      setError(null)
      setData(r)
    })
  }, [transactionId])

  useEffect(() => { load() }, [load])

  const submit = () => {
    startTransition(async () => {
      const r = await requestAgentConcessionAction({ transactionId, beneficiary, amount: Number(amount), valueType, reason })
      if (!r.success) { setError(r.error); return }
      setAmount(""); setReason("")
      load()
    })
  }
  const decide = (id: string, decision: "approved" | "denied") => {
    startTransition(async () => {
      const r = await decideAgentConcessionAction({ concessionId: id, decision, note: note[id] ?? null })
      if (!r.success) { setError(r.error); return }
      load()
    })
  }
  const withdraw = (id: string) => {
    startTransition(async () => {
      const r = await withdrawAgentConcessionAction({ concessionId: id })
      if (!r.success) { setError(r.error); return }
      load()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent concessions</CardTitle>
        <CardDescription>
          A credit you give the buyer or seller comes off your gross commission, before the split. A seller credit to the
          buyer is the seller&apos;s money and is not entered here.
          {data ? (data.requiresApproval ? " This brokerage requires broker approval before a concession is committed." : " This brokerage does not require approval.") : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {(data?.concessions ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent concessions on this deal.</p>
        ) : (
          <ul className="space-y-3">
            {(data?.concessions ?? []).map((c) => (
              <li key={c.id} className="rounded-md border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    {c.valueType === "flat" ? `$${c.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : `${c.value}% of the gross commission`}
                  </span>
                  <span>to the {c.beneficiary ?? "—"}{c.beneficiaryName ? ` (${c.beneficiaryName})` : ""}</span>
                  <Badge variant={c.approvalStatus === "denied" || c.approvalStatus === "withdrawn" ? "outline" : c.approvalStatus === "requested" ? "secondary" : "default"}>
                    {c.approvalLabel}
                  </Badge>
                </div>
                {c.reason ? <p className="text-xs text-muted-foreground">{c.reason}</p> : null}
                {c.approvalNote ? <p className="text-xs text-muted-foreground">Broker note: {c.approvalNote}</p> : null}
                {c.approvalStatus === "requested" && data?.canDecide ? (
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Note (required to deny)"
                      value={note[c.id] ?? ""}
                      onChange={(e) => setNote((n) => ({ ...n, [c.id]: e.target.value }))}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={pending} onClick={() => decide(c.id, "approved")}>Approve</Button>
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => decide(c.id, "denied")}>Deny</Button>
                    </div>
                  </div>
                ) : null}
                {c.approvalStatus === "requested" && c.mine ? (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => withdraw(c.id)}>Withdraw my request</Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t pt-4">
          <Label>Ask to give a concession</Label>
          <div className="flex flex-wrap gap-2 text-sm">
            <select className="rounded-md border px-2 py-1" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value as "buyer" | "seller")}>
              <option value="buyer">to the buyer</option>
              <option value="seller">to the seller</option>
            </select>
            <select className="rounded-md border px-2 py-1" value={valueType} onChange={(e) => setValueType(e.target.value as "flat" | "percent")}>
              <option value="flat">dollar amount</option>
              <option value="percent">% of my gross commission</option>
            </select>
            <input
              className="w-32 rounded-md border px-2 py-1"
              inputMode="decimal"
              placeholder={valueType === "flat" ? "e.g. 1000" : "e.g. 0.5"}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <Textarea placeholder="Why (kept as evidence)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" disabled={pending || !amount || reason.trim().length < 5} onClick={submit}>
            {data?.requiresApproval === false ? "Record concession" : "Request broker approval"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
