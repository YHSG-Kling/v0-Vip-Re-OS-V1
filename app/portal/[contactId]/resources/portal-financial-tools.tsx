"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, Truck, Calculator, Clock, ChevronDown, ChevronUp } from "lucide-react"
import { saveCalculatorResult } from "@/app/actions/calculators"
// Wave 156 (156H round 2): the moving budget is the ONE engine's "relocation_budget" over the person's own quotes — the invented
// per-home-size dollar table (estimateMovingCosts, tombstone in app/actions/calculators.ts) is gone.
import { CALCULATOR_SPECS, runCalculator, type CalculatorOutcome } from "@/lib/calculators/engine"
import { useToast } from "@/hooks/use-toast"

interface CalculatorHistoryEntry {
  id: string
  calculator_type: string
  inputs: any
  results: any
  created_at: string
}

interface PortalFinancialToolsProps {
  contactId: string
  calcHistory: CalculatorHistoryEntry[]
}

export function PortalFinancialTools({ contactId, calcHistory }: PortalFinancialToolsProps) {
  const { toast } = useToast()

  // Relocation budget state — the person's own quotes, keyed by the engine's field keys.
  const RELOCATION = CALCULATOR_SPECS.relocation_budget
  const [costs, setCosts] = useState<Record<string, string>>({})
  const [movingResult, setMovingResult] = useState<CalculatorOutcome | null>(null)
  const [movingLoading, setMovingLoading] = useState(false)

  // History expand/collapse
  const [historyOpen, setHistoryOpen] = useState(false)

  async function handleEstimateMoving() {
    setMovingLoading(true)
    try {
      const inputs = Object.fromEntries(Object.entries(costs).filter(([, v]) => v.trim() !== ""))
      const res = runCalculator("relocation_budget", inputs, { audience: "public" })
      setMovingResult(res)
      if (!res.ok) return
      toast({ title: "Moving budget ready" })
      // The budget above is shown. This SAVE is what the contact expects to find later; contactId → contact_id (lane W3).
      const saved = await saveCalculatorResult({
        contactId,
        calculatorType: "moving_cost",
        inputs,
        results: { total_estimated_cost: res.outputs.total, cost_breakdown: Object.fromEntries(res.lines.map((l) => [l.label, l.amount])), assumptions: res.assumptions, period: res.period, engine: res.engineVersion },
      })
      if (!saved?.success) {
        toast({ title: "Budget not saved", description: "The numbers above are correct, but they were not saved to your file.", variant: "destructive" })
      }
    } catch {
      toast({ title: "Could not save — please try again", variant: "destructive" })
    } finally {
      setMovingLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Moving Cost Estimator */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-blue-600" />
            <CardTitle>Moving Cost Estimator</CardTitle>
          </div>
          <CardDescription>
            Add up your move from your own quotes
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {RELOCATION.fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label className="text-sm" htmlFor={`reloc-${f.key}`}>{f.label}</Label>
                <Input id={`reloc-${f.key}`} inputMode="decimal" placeholder={f.kind === "months" ? "months" : "from your quote"}
                  value={costs[f.key] ?? ""} onChange={(e) => setCosts({ ...costs, [f.key]: e.target.value })} />
              </div>
            ))}
          </div>

          <Button onClick={handleEstimateMoving} disabled={movingLoading} className="w-full">
            {movingLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Calculator className="h-4 w-4 mr-2" />
            )}
            Total my moving budget
          </Button>

          {movingResult && !movingResult.ok && (
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              {movingResult.missing.map((m) => <li key={m.key}>{m.message}</li>)}
              {movingResult.refused.map((r) => <li key={r.key}>{r.label}: {r.reason}</li>)}
            </ul>
          )}
          {movingResult && movingResult.ok && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-blue-900">Total budget ({movingResult.period})</span>
                <span className="text-xl font-bold text-blue-700">${Number(movingResult.outputs.total).toLocaleString()}</span>
              </div>
              <div className="space-y-1.5 pt-2 border-t border-blue-200">
                {movingResult.lines.filter((l) => l.amount > 0).map((l) => (
                  <div key={l.key} className="flex items-center justify-between text-sm text-blue-800">
                    <span>{l.label}</span>
                    <span>${l.amount.toLocaleString()}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-blue-800">Built only from the figures you entered — nothing is assumed for a cost you left blank.</p>
              {movingResult.disclaimers.map((d) => <p key={d} className="text-xs text-blue-800">{d}</p>)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Calculator History */}
      {calcHistory.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <button
              className="flex items-center justify-between w-full text-left"
              onClick={() => setHistoryOpen((o) => !o)}
            >
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-slate-500" />
                <CardTitle>Your Calculator History</CardTitle>
                <Badge variant="secondary" className="text-xs">{calcHistory.length}</Badge>
              </div>
              {historyOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
            <CardDescription>Past calculations saved to your account</CardDescription>
          </CardHeader>
          {historyOpen && (
            <CardContent className="space-y-3">
              {calcHistory.map((entry) => (
                <div key={entry.id} className="p-3 rounded-lg border space-y-1">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="text-xs capitalize">
                      {entry.calculator_type.replace(/_/g, " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {entry.results?.net_proceeds != null && (
                    <p className="text-sm font-medium">
                      Net Proceeds: ${Number(entry.results.net_proceeds).toLocaleString()}
                    </p>
                  )}
                  {entry.results?.total_estimated_cost != null && (
                    <p className="text-sm font-medium">
                      Moving Cost: ${Number(entry.results.total_estimated_cost).toLocaleString()}
                    </p>
                  )}
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}
    </div>
  )
}
