"use client"

// EquityEstimateCard — the seller's "what would I actually walk away with?" tool. The seller-side
// analogue of the buyer affordability card and the #1 thing sellers ask for: not a top-line value,
// but NET proceeds after their mortgage payoff and selling costs. Live-recomputes via the PURE
// engine as the seller tunes their mortgage balance; saves the balance server-side. Honest (shows
// gross/costs until the balance is entered) and warm (never a cold number; routes to the agent).

import { useState, useTransition } from "react"
import Link from "next/link"
import { Wallet, TrendingUp, Pencil, Check } from "lucide-react"
import { Card, CardContent, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { estimateSellerNetProceeds, clientEquityFraming } from "@/lib/seller-equity/equity-estimate"
import { buildPricingScenarios } from "@/lib/seller-equity/scenarios"
import { setSellerMortgageBalance } from "@/app/actions/seller-equity"

interface MoveReadinessView { score: number | null; band: string; headline: string; line: string; drivers: string[] }

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export function EquityEstimateCard({
  contactId, estimatedValue, initialMortgageBalance, hoaDuesMonthly, valuationNote,
  annualAppreciationPct, moveReadiness,
}: {
  contactId: string
  estimatedValue: number
  initialMortgageBalance: number | null
  hoaDuesMonthly?: number | null
  /** Where the estimated value came from (a comps-adjusted CMA is the gold standard) — shown for trust. */
  valuationNote?: string | null
  /** Zip annual appreciation (decimal) — enables the "wait ~6 months" what-if scenario. */
  annualAppreciationPct?: number | null
  /** Precomputed move-readiness (equity + market + engagement), resolved server-side. */
  moveReadiness?: MoveReadinessView | null
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [balance, setBalance] = useState<number | null>(initialMortgageBalance)
  const [editing, setEditing] = useState(initialMortgageBalance === null)
  const [draft, setDraft] = useState(initialMortgageBalance != null ? String(initialMortgageBalance) : "")

  const est = estimateSellerNetProceeds({ estimatedValue, mortgageBalance: balance, hoaDuesMonthly })
  const framing = clientEquityFraming(est)
  const scenarios = buildPricingScenarios({ estimatedValue, mortgageBalance: balance, hoaDuesMonthly, annualAppreciationPct })

  function save() {
    const parsed = draft.trim() === "" ? null : Number(draft.replace(/[^0-9.]/g, ""))
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      toast({ title: "Enter a valid balance", variant: "destructive" }); return
    }
    startTransition(async () => {
      const r = await setSellerMortgageBalance(contactId, parsed)
      if (r.success) { setBalance(parsed); setEditing(false); toast({ title: "Saved" }) }
      else toast({ title: r.error ?? "Couldn't save", variant: "destructive" })
    })
  }

  return (
    <Card className="overflow-hidden">
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-3">
        <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
          <Wallet className="h-4 w-4" /> Your Equity &amp; Net Proceeds
        </CardTitle>
      </div>
      <CardContent className="pt-5 space-y-4">
        {/* Headline number */}
        <div>
          {est.mortgageKnown && est.netProceeds !== null ? (
            <>
              <p className="text-xs text-muted-foreground">{framing.label}</p>
              <p className={`text-3xl font-bold ${framing.tone === "good" ? "text-emerald-700" : "text-foreground"}`}>
                {usd(est.netProceeds)}
              </p>
              <p className="text-xs text-muted-foreground">estimated net in your pocket at closing</p>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Estimated home value</p>
              <p className="text-3xl font-bold text-foreground">{usd(est.estimatedValue)}</p>
              <p className="text-xs text-amber-700">{framing.label}</p>
            </>
          )}
        </div>

        {/* Valuation provenance — sellers trust a number they understand the source of. */}
        {valuationNote && <p className="text-[11px] text-emerald-700 -mt-2">{valuationNote}</p>}

        {/* Breakdown */}
        <div className="space-y-1.5 text-sm">
          <Row label="Estimated value" value={usd(est.estimatedValue)} />
          <Row label={`Selling costs (commission, taxes, fees)`} value={`− ${usd(est.sellingCosts)}`} muted />
          {/* Mortgage balance — editable */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Mortgage payoff</span>
            {editing ? (
              <div className="flex items-center gap-1">
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="balance" className="h-7 w-28 text-sm text-right" inputMode="numeric" />
                <Button size="sm" className="h-7 px-2" onClick={save} disabled={isPending}><Check className="h-3.5 w-3.5" /></Button>
              </div>
            ) : (
              <button onClick={() => { setEditing(true); setDraft(balance != null ? String(balance) : "") }} className="flex items-center gap-1 text-foreground">
                {balance != null ? `− ${usd(balance)}` : "Add balance"} <Pencil className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>
          {est.mortgageKnown && est.netProceeds !== null && (
            <div className="flex items-center justify-between border-t pt-1.5 font-semibold">
              <span className="flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5 text-emerald-600" /> Your net proceeds</span>
              <span className={framing.tone === "good" ? "text-emerald-700" : ""}>{usd(est.netProceeds)}</span>
            </div>
          )}
        </div>

        {/* Move-readiness — "where do I stand at a glance?" (equity + market + your interest) */}
        {moveReadiness && moveReadiness.score !== null && (
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{moveReadiness.headline}</p>
              <span className="text-lg font-bold text-emerald-700">{moveReadiness.score}<span className="text-xs text-muted-foreground">/100</span></span>
            </div>
            <p className="text-[11px] text-muted-foreground">Move-readiness · {moveReadiness.drivers.join(" · ")}</p>
          </div>
        )}

        {/* What-if scenarios — list at X vs Y, wait, improve (each with the real net they'd keep) */}
        {est.mortgageKnown && scenarios.some((s) => s.netProceeds !== null) && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">What if you…</p>
            <div className="space-y-1">
              {scenarios.filter((s) => s.netProceeds !== null).map((s) => (
                <div key={s.key} className="flex items-center justify-between text-sm rounded-md border border-border px-2.5 py-1.5">
                  <div className="min-w-0">
                    <span className="font-medium">{s.label}</span>
                    {s.note && <span className="block text-[10px] text-muted-foreground truncate">{s.note}</span>}
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <span className="font-semibold">{usd(s.netProceeds as number)}</span>
                    {s.deltaVsBase !== null && s.deltaVsBase !== 0 && (
                      <span className={`block text-[10px] ${s.deltaVsBase > 0 ? "text-emerald-700" : "text-slate-500"}`}>
                        {s.deltaVsBase > 0 ? "+" : ""}{usd(s.deltaVsBase)} vs estimate
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Estimates only — your agent models these with you for real.</p>
          </div>
        )}

        <p className="text-xs text-muted-foreground">{framing.line}</p>
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href={`/portal/${contactId}/messages`}>Talk through my numbers with my agent</Link>
        </Button>
        <p className="text-[10px] text-muted-foreground text-center">Estimate only — your agent confirms every figure. Assumes a 6% commission; ask about your actual rate.</p>
      </CardContent>
    </Card>
  )
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={muted ? "text-muted-foreground" : "text-foreground"}>{value}</span>
    </div>
  )
}
