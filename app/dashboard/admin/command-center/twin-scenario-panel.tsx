"use client"

// Wave 107D — THE WHAT-IF PANEL on the twin card: named levers in, the projection out (opportunity
// gain, the stage that saturates first, marketing cost, margin, risks, every assumption with its
// source). Simulation only — "promote" creates a PROPOSED mission a human must plan / activate.
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { simulateTwinScenario, promoteTwinScenarioToMission } from "@/app/actions/twin-scenario"
import type { ScenarioProjection } from "@/lib/kernel/twin-scenario"

const PCT_LEVERS = [
  ["seller_lead_acquisition_pct", "Seller lead acquisition %"],
  ["buyer_lead_acquisition_pct", "Buyer lead acquisition %"],
  ["ad_spend_pct", "Ad spend %"],
  ["campaign_cadence_pct", "Campaign cadence %"],
  ["isa_capacity_pct", "AI ISA capacity %"],
] as const
const HEADCOUNT = ["listing", "buyer", "luxury", "investor", "general"] as const
const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`

export function TwinScenarioPanel({ territories }: { territories: string[] }) {
  const [pct, setPct] = useState<Record<string, string>>({ seller_lead_acquisition_pct: "30" })
  const [heads, setHeads] = useState<Record<string, string>>({})
  const [activated, setActivated] = useState<string[]>([])
  const [result, setResult] = useState<{ projection: ScenarioProjection; headline: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const levers = () => {
    const l: Record<string, unknown> = {}
    for (const [k] of PCT_LEVERS) if (pct[k]?.trim()) l[k] = Number(pct[k])
    const h = Object.fromEntries(HEADCOUNT.filter((k) => heads[k]?.trim() && Number(heads[k]) !== 0).map((k) => [k, Number(heads[k])]))
    if (Object.keys(h).length) l.agent_headcount = h
    if (activated.length) l.territory_activation = activated
    return l
  }
  const run = () => start(async () => {
    setMsg(null)
    const r = await simulateTwinScenario(levers())
    if (!r.ok) { setMsg(r.error); setResult(null); return }
    setResult({ projection: r.projection, headline: r.headline })
    if (r.evidenceError) setMsg(`Projection shown; evidence not recorded: ${r.evidenceError}`)
  })
  const promote = () => start(async () => {
    const r = await promoteTwinScenarioToMission(levers())
    setMsg(r.ok ? `Proposed mission created (${r.state}) — it waits on the Missions card for your approval.` : r.error)
  })

  const p = result?.projection
  return (
    <div className="space-y-3 border-t pt-3">
      <div className="text-sm font-medium">What if… <span className="text-xs font-normal text-muted-foreground">(simulation only — nothing is changed)</span></div>
      <div className="grid gap-2 sm:grid-cols-3">
        {PCT_LEVERS.map(([k, label]) => (
          <label key={k} className="text-xs space-y-1">
            <span className="block text-muted-foreground">{label}</span>
            <input type="number" className="w-full rounded border bg-background px-2 py-1 text-sm" value={pct[k] ?? ""} onChange={(e) => setPct({ ...pct, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-5">
        {HEADCOUNT.map((k) => (
          <label key={k} className="text-xs space-y-1">
            <span className="block text-muted-foreground">+/− {k} agents</span>
            <input type="number" className="w-full rounded border bg-background px-2 py-1 text-sm" value={heads[k] ?? ""} onChange={(e) => setHeads({ ...heads, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      {territories.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="text-muted-foreground">Aim the seller lift at:</span>
          {territories.map((t) => (
            <label key={t} className="flex items-center gap-1">
              <input type="checkbox" checked={activated.includes(t)} onChange={(e) => setActivated(e.target.checked ? [...activated, t] : activated.filter((x) => x !== t))} />{t}
            </label>
          ))}
        </div>
      )}
      {territories.length === 0 && (
        <p className="text-xs text-muted-foreground">No farm territories assigned yet — the seller lift applies brokerage-wide.</p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={run} disabled={pending}>{pending ? "Projecting…" : "Project"}</Button>
        {p && p.opportunityGain.addedCloses30d > 0 && <Button size="sm" variant="outline" onClick={promote} disabled={pending}>Promote to proposed mission</Button>}
      </div>
      {msg && <div className="text-xs text-muted-foreground">{msg}</div>}
      {p && (
        <div className="space-y-2 text-sm">
          <div>{result!.headline}</div>
          <div className="grid gap-1 text-xs sm:grid-cols-2">
            <div>Opportunity gain: +{p.opportunityGain.addedLeads30d} leads · +{p.opportunityGain.addedConversions30d} conversions · +{p.opportunityGain.addedListings30d} listings · +{p.opportunityGain.addedCloses30d} closes /30d</div>
            <div>Marketing cost: {usd(p.marketingCost.totalCents)} (acquisition {usd(p.marketingCost.acquisitionCents)} · ads {usd(p.marketingCost.adSpendCents)} · nurture {usd(p.marketingCost.campaignCents)} · media {usd(p.marketingCost.mediaCents)} · AI {usd(p.marketingCost.aiCents)}) · margin {usd(p.expectedMarginCents)}</div>
          </div>
          <ul className="text-xs space-y-0.5">
            {p.chain.map((s) => (
              <li key={s.stage} className={s.saturated ? "text-red-600" : ""}>
                {s.stage.replace(/_/g, " ")} — {s.utilization === null ? (s.note ?? "unbounded") : `${Math.round(s.utilization * 100)}% of capacity (${s.unit})`}
                {p.staffingConstraint.saturationPoints[s.stage] != null ? ` · saturates at ${p.staffingConstraint.lever ?? "lever"} ${p.staffingConstraint.saturationPoints[s.stage]}%` : ""}
              </li>
            ))}
          </ul>
          {p.risks.length > 0 && <div className="text-xs"><span className="font-medium">Risks:</span> {p.risks.join(" · ")}</div>}
          {p.unsupported.length > 0 && <div className="text-xs text-muted-foreground">Not understood: {p.unsupported.join(", ")}</div>}
          <details className="text-xs">
            <summary className="cursor-pointer">Assumptions & coefficients ({p.assumptions.length} assumed / low confidence of {p.coefficients.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {p.coefficients.map((k) => <li key={k.key}><span className="font-mono">{k.key}</span> = {Math.round(k.value * 1000) / 1000} {k.unit} — {k.source} [{k.confidence}, {k.manager}]</li>)}
            </ul>
          </details>
        </div>
      )}
    </div>
  )
}
