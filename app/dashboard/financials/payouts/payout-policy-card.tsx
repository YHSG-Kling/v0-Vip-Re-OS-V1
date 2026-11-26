"use client"

// THE BROKERAGE'S PAYOUT GATE + CONCESSION-APPROVAL POLICY (wave 144, lane 144D; owner rulings 8 and 4).
// "Payout gate is a brokerage SETTING: either pay out at closing (CDA authorizes the permitted closing-time distribution) or
// pay out when the brokerage receives the final commission and then pays the agent/team." Undeclared = after receipt (the
// funds-received gate). Closing-time payout needs a CDA brokerage. The rule lives in lib/transactions/cda-closing-policy.ts.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { getCommissionPayoutPolicyAction, setCommissionPayoutPolicyAction } from "@/app/actions/commission-policy/commission-policy"

type Policy = Extract<Awaited<ReturnType<typeof getCommissionPayoutPolicyAction>>, { success: true }>

export function PayoutPolicyCard() {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [timing, setTiming] = useState<"at_closing_per_cda" | "after_brokerage_receipt">("after_brokerage_receipt")
  const [approval, setApproval] = useState<"broker_approval_required" | "no_approval_required">("broker_approval_required")
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    startTransition(async () => {
      const r = await getCommissionPayoutPolicyAction()
      if (!r.success) { setMessage(r.error); return }
      setPolicy(r)
      setTiming(r.effectiveTiming === "at_closing_per_cda" ? "at_closing_per_cda" : "after_brokerage_receipt")
      setApproval(r.concessionRequiresApproval ? "broker_approval_required" : "no_approval_required")
    })
  }, [])

  const save = () => {
    startTransition(async () => {
      const r = await setCommissionPayoutPolicyAction({ payoutTiming: timing, agentConcessionApproval: approval })
      setMessage(r.success ? (r.note ?? "Saved.") : r.error)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payout policy</CardTitle>
        <CardDescription>
          When agents are paid, and whether an agent must ask before giving a concession.
          {policy && policy.payoutTiming === null ? " Not set yet — agents are paid after the brokerage receives the commission." : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {policy?.timingFinding ? <p className="text-amber-700">{policy.timingFinding}</p> : null}
        <div className="space-y-1">
          <Label>Pay agents</Label>
          <select className="w-full rounded-md border px-2 py-1" value={timing} disabled={!policy?.canEdit} onChange={(e) => setTiming(e.target.value as typeof timing)}>
            {(policy?.timingOptions ?? []).map((o) => (
              <option key={o.value} value={o.value} disabled={!o.available}>{o.label}{o.available ? "" : " (needs CDA)"}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Agent concessions</Label>
          <select className="w-full rounded-md border px-2 py-1" value={approval} disabled={!policy?.canEdit} onChange={(e) => setApproval(e.target.value as typeof approval)}>
            <option value="broker_approval_required">The agent asks the broker first</option>
            <option value="no_approval_required">No approval needed</option>
          </select>
        </div>
        {policy?.canEdit ? <Button size="sm" disabled={pending} onClick={save}>Save payout policy</Button> : null}
        {message ? <p className="text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  )
}
