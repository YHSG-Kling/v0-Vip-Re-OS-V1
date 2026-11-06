"use client"

/**
 * Settings → Territories → Acquisition plan (wave 150, lane 150EFG — the Source Discovery Planner, directive 150E).
 *
 * Preview first, then approve: the panel shows each source's reach, quote, expected new leads and why, and a paid line
 * is bought ONLY after a seat that may commit the tenant's money approves it here (the pooled pull asks
 * paidPullApproval before it spends). Tenancy is not a prop — every action re-resolves the session itself.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2 } from "lucide-react"
import { approveAcquisitionPlan, proposeAcquisitionPlan, type AcquisitionPlanView } from "@/app/actions/acquisition-plan"

const money = (n: number | null | undefined) => (typeof n === "number" ? `$${n.toFixed(2)}` : "—")

export function AcquisitionPlanPanel({ view }: { view: AcquisitionPlanView }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [territoryId, setTerritoryId] = useState(view.territories[0]?.id ?? "")
  const [budget, setBudget] = useState(String(view.territories[0]?.monthlyBudgetUsd ?? 0))
  const [message, setMessage] = useState<string | null>(view.error)
  const [picked, setPicked] = useState<Record<string, string[]>>({})

  const propose = () => start(async () => {
    const r = await proposeAcquisitionPlan({ territoryId, budgetUsd: Number(budget) })
    setMessage(r.success ? "Plan proposed — nothing is bought until a line is approved." : r.error)
    if (r.success) router.refresh()
  })
  const approve = (planId: string) => start(async () => {
    const r = await approveAcquisitionPlan({ planId, sources: picked[planId] ?? [] })
    setMessage(r.success ? `Approved ${r.approved.join(", ")} until ${new Date(r.validUntil).toLocaleDateString()}.` : r.error)
    if (r.success) router.refresh()
  })
  const toggle = (planId: string, source: string) => setPicked((p) => {
    const cur = new Set(p[planId] ?? [])
    if (cur.has(source)) cur.delete(source); else cur.add(source)
    return { ...p, [planId]: [...cur] }
  })

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Acquisition plan</CardTitle>
        <CardDescription>
          Where new buyers and sellers could come from in each territory: reach, price, expected new leads and why.
          Paid sources are only used after you approve them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.territories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lead-scraping territories yet — add one to plan acquisition.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="acq-territory">Territory</Label>
              <select id="acq-territory" className="h-9 rounded-md border bg-background px-2 text-sm" value={territoryId} onChange={(e) => setTerritoryId(e.target.value)}>
                {view.territories.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="acq-budget">Budget (USD)</Label>
              <Input id="acq-budget" type="number" min={0} className="w-32" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <Button onClick={propose} disabled={pending || !territoryId}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Propose plan
            </Button>
          </div>
        )}
        {message ? <p className="text-sm" role="status">{message}</p> : null}
        {view.plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No acquisition plans yet.</p>
        ) : view.plans.map((plan) => (
          <div key={plan.id} className="rounded-md border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{plan.territoryLabel ?? "Territory"}</span>
              <Badge variant="outline">{plan.status}</Badge>
              <span className="text-muted-foreground">budget {money(plan.budgetUsd)} · planned {money(plan.totalQuoteUsd)} · {plan.marketMode} market · {plan.tilt === "balanced" ? "buyers and sellers weighed evenly" : `${plan.tilt}s favoured`}</span>
            </div>
            <ul className="space-y-1 text-sm">
              {plan.lines.filter((l) => l.status !== "over_budget" || plan.status === "proposed").map((l) => (
                <li key={l.source} className="flex flex-wrap items-center gap-2">
                  {plan.status === "proposed" && view.mayApprove && l.status === "proposed" ? (
                    <input type="checkbox" aria-label={`Approve ${l.source}`} checked={(picked[plan.id] ?? []).includes(l.source)} onChange={() => toggle(plan.id, l.source)} />
                  ) : null}
                  <span className="font-mono text-xs">{l.source}</span>
                  <Badge variant="secondary">{l.status.replace(/_/g, " ")}</Badge>
                  <span className="text-muted-foreground">{l.side} · {l.plays.join(", ").replace(/_/g, " ")} · reach {l.estimatedReach ?? "—"} · {l.paid ? money(l.quoteUsd) : "free"} · {l.why}</span>
                </li>
              ))}
            </ul>
            {plan.status === "proposed" && view.mayApprove ? (
              <Button size="sm" onClick={() => approve(plan.id)} disabled={pending || (picked[plan.id] ?? []).length === 0}>Approve selected</Button>
            ) : null}
            {plan.status === "proposed" && !view.mayApprove ? (
              <p className="text-xs text-muted-foreground">An owner or broker who manages the tenant&apos;s spending approves paid lines.</p>
            ) : null}
            {plan.blindSpots.length > 0 ? <p className="text-xs text-muted-foreground">Not known: {plan.blindSpots.join("; ")}</p> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
