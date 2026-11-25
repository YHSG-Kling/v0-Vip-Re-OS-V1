"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, Save, Plus, Trash2 } from "lucide-react"
import {
  calculateSellerNet,
  compareMortgageScenarios,
  saveCalculation,
  getSavedCalculations,
  emailCalculationResults,
} from "@/app/actions/calculators"
// One persisted identity for every tool on this page. Each tab used to mint its
// own `crypto.randomUUID()` per mount, so a saved calculation was filed under an
// id that died with the component — unreadable by anything, including the
// retrieval action written for it.
import { getOrCreateVisitorId, isVisitorIdPersistent } from "@/lib/tools/visitor-id"

// ─── Types ────────────────────────────────────────────────────────────────────

type SellerNetResult = Awaited<ReturnType<typeof calculateSellerNet>>
type MortgageResult = Awaited<ReturnType<typeof compareMortgageScenarios>>
// wave 156H: calculateRentVsBuy retired — the Rent vs Buy tab renders EngineCalculatorPanel (the ONE engine)
import { EngineCalculatorPanel } from "@/app/components/calculators/EngineCalculatorPanel"
import type { CalculatorOutcome } from "@/lib/calculators/engine"

interface MortgageScenario {
  name: string
  term: number
  interestRate: number
  downPayment: number
  loanType: "fixed" | "arm"
}

interface Props {
  brokerageId: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return "$" + Math.round(n).toLocaleString()
}

function fmtPct(n: number) {
  return n.toFixed(2) + "%"
}

/**
 * The server's save message, plus the one thing the server cannot know: whether
 * THIS browser will still have the visitor id on the next visit. Every save
 * message promises the calculation can be retrieved later; where storage is
 * blocked (private mode, cookies off) that promise is false, and the caveat has
 * to come from the browser or not at all.
 */
function saveMessageWithRetrievalCaveat(message: string): string {
  if (isVisitorIdPersistent()) return message
  return `${message} Note: this browser is blocking local storage, so this calculation will not be findable after you close the tab.`
}

// ─── Seller Net Sheet Tab ─────────────────────────────────────────────────────

function SellerNetTab({ brokerageId }: { brokerageId: string }) {
  const [visitorId] = useState(getOrCreateVisitorId)
  const [isPending, startTransition] = useTransition()
  const [isSaving, startSaveTransition] = useTransition()
  const [result, setResult] = useState<SellerNetResult | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  // The address a copy is emailed to. saveCalculation has always ACCEPTED an
  // email and its success message has always promised "we'll email you a copy",
  // but no caller ever supplied one and nothing ever sent it. The address is
  // recorded ON THE ROW here because emailCalculationResults refuses to send
  // anywhere else — the destination is never the caller's to choose.
  const [saveEmail, setSaveEmail] = useState("")

  const [homeValue, setHomeValue] = useState("")
  const [mortgageBalance, setMortgageBalance] = useState("")
  const [location, setLocation] = useState("")
  const [state, setState] = useState("")
  const [hoaFees, setHoaFees] = useState("")
  const [repairsConcessions, setRepairsConcessions] = useState("")
  const [stagingCost, setStagingCost] = useState("")
  const [movingCost, setMovingCost] = useState("")
  // Wave 156 (156H): the figures the sheet used to invent (title 0.7%, escrow 1.5%, a 0.1% transfer tax) are now the seller's.
  const [titleEscrowFees, setTitleEscrowFees] = useState("")
  const [transferTaxAmount, setTransferTaxAmount] = useState("")
  const [buyerBrokerCompPct, setBuyerBrokerCompPct] = useState("")

  const US_STATES = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY",
  ]

  function handleCalculate() {
    const hv = parseFloat(homeValue)
    // Mortgage balance is optional — a blank or "0" value means fully paid off
    const mb = mortgageBalance === "" ? 0 : parseFloat(mortgageBalance)
    if (!hv || !location || !state) return
    if (isNaN(mb)) return

    startTransition(async () => {
      const res = await calculateSellerNet({
        homeValue: hv,
        mortgageBalance: mb,
        location,
        state,
        hoaFees: hoaFees ? parseFloat(hoaFees) : undefined,
        repairsConcessions: repairsConcessions ? parseFloat(repairsConcessions) : undefined,
        stagingCost: stagingCost ? parseFloat(stagingCost) : undefined,
        movingCost: movingCost ? parseFloat(movingCost) : undefined,
        brokerageId,
        titleEscrowFees: titleEscrowFees ? parseFloat(titleEscrowFees) : undefined,
        transferTaxAmount: transferTaxAmount ? parseFloat(transferTaxAmount) : undefined,
        buyerBrokerCompPct: buyerBrokerCompPct ? parseFloat(buyerBrokerCompPct) : undefined,
      })
      setResult(res)
      setSaveMsg(null)
    })
  }

  function handleSave() {
    if (!result) return
    startSaveTransition(async () => {
      const res = await saveCalculation({
        toolName: "seller_net_sheet",
        calculationData: result,
        visitorId,
        email: saveEmail.trim() || undefined,
      })
      setSaveMsg(res.success ? saveMessageWithRetrievalCaveat(res.message ?? "Saved.") : "Save failed.")
    })
  }

  const canCalculate = !!homeValue && !!location && !!state && titleEscrowFees !== ""

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Seller Net Sheet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Home Value ($)</Label>
              <Input
                type="number"
                placeholder="450000"
                value={homeValue}
                onChange={(e) => setHomeValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Mortgage Balance ($)</Label>
              <Input
                type="number"
                placeholder="250000"
                value={mortgageBalance}
                onChange={(e) => setMortgageBalance(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>City / Location</Label>
              <Input
                placeholder="Austin"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>State</Label>
              <Select value={state} onValueChange={setState}>
                <SelectTrigger>
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Title, escrow &amp; settlement ($ — from a quote)</Label>
              <Input type="number" placeholder="required" value={titleEscrowFees} onChange={(e) => setTitleEscrowFees(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Transfer tax ($ — blank uses the cited statute for FL, CA or NY; enter 0 if none)</Label>
              <Input type="number" placeholder="cited statute" value={transferTaxAmount} onChange={(e) => setTransferTaxAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Buyer-broker compensation the seller pays (%, optional)</Label>
              <Input type="number" placeholder="not included" value={buyerBrokerCompPct} onChange={(e) => setBuyerBrokerCompPct(e.target.value)} />
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="text-sm text-muted-foreground mb-3">Optional adjustments</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label>HOA Fees ($)</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={hoaFees}
                  onChange={(e) => setHoaFees(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Repairs / Concessions ($)</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={repairsConcessions}
                  onChange={(e) => setRepairsConcessions(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Staging Cost ($)</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={stagingCost}
                  onChange={(e) => setStagingCost(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Moving Cost ($)</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={movingCost}
                  onChange={(e) => setMovingCost(e.target.value)}
                />
              </div>
            </div>
          </div>

          <Button onClick={handleCalculate} disabled={!canCalculate || isPending} className="w-full sm:w-auto">
            {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Calculating…</> : "Calculate Net Proceeds"}
          </Button>
        </CardContent>
      </Card>

      {result && !result.success && (
        <p role="alert" className="text-sm text-destructive">{result.error}</p>
      )}

      {result && result.success && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="border-l-4 border-l-blue-500">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Home Value</p>
                <p className="text-2xl font-bold">{fmt(result.home_value)}</p>
              </CardContent>
            </Card>
            <Card className="border-l-4 border-l-red-500">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Total Costs</p>
                <p className="text-2xl font-bold text-red-600">{fmt(result.total_costs)}</p>
              </CardContent>
            </Card>
            <Card className={`border-l-4 ${result.net_proceeds >= 0 ? "border-l-green-500" : "border-l-red-500"}`}>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Net Proceeds</p>
                <p className={`text-2xl font-bold ${result.net_proceeds >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {fmt(result.net_proceeds)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Cost Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cost Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-border">
                {Object.entries(result.cost_breakdown).map(([key, value]) => (
                  <div key={key} className="flex justify-between py-2 text-sm">
                    <span className="text-muted-foreground capitalize">{key.replace(/_/g, " ")}</span>
                    <span className="font-medium">{fmt(value as number)}</span>
                  </div>
                ))}
                <div className="flex justify-between py-2 text-sm font-semibold">
                  <span>Mortgage Payoff</span>
                  <span>{fmt(result.mortgage_payoff)}</span>
                </div>
                <div className="flex justify-between py-2 font-bold">
                  <span>Net Proceeds</span>
                  <span className={result.net_proceeds >= 0 ? "text-green-700" : "text-red-600"}>
                    {fmt(result.net_proceeds)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {"assumptions" in result && Array.isArray(result.assumptions) && (
            <Card>
              <CardHeader><CardTitle className="text-base">Assumptions · {result.period}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                {result.assumptions.map((a) => (
                  <p key={a.key}><span className="font-medium">{a.label}:</span> {a.display} <span className="text-xs text-muted-foreground">({a.basis.replace(/_/g, " ")}{a.source ? ` — ${a.source.citation}, read ${a.source.retrievedOn}` : ""})</span></p>
                ))}
                {result.disclaimers.map((d) => <p key={d} className="text-xs text-muted-foreground">{d}</p>)}
              </CardContent>
            </Card>
          )}

          {/* AI Scenarios */}
          {result.scenarios && result.scenarios.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">AI Market Scenarios</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {result.scenarios.map((s: any, i: number) => (
                  <div key={i} className="p-3 bg-muted rounded-lg space-y-1">
                    <p className="font-medium text-sm">{s.timeframe}</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-muted-foreground">Est. Home Value</span>
                      <span className="font-medium">{fmt(s.estimated_home_value)}</span>
                      <span className="text-muted-foreground">Net Proceeds</span>
                      <span className="font-medium">{fmt(s.net_proceeds)}</span>
                    </div>
                    {s.reasoning && <p className="text-xs text-muted-foreground">{s.reasoning}</p>}
                  </div>
                ))}
                {result.recommendation && (
                  <p className="text-sm font-medium text-primary mt-2">{result.recommendation}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Save */}
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="email"
              className="max-w-64"
              placeholder="Email a copy to (optional)"
              value={saveEmail}
              onChange={(e) => setSaveEmail(e.target.value)}
            />
            <Button variant="outline" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save Calculation
            </Button>
            {saveMsg && <p className="text-sm text-muted-foreground">{saveMsg}</p>}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Mortgage Comparison Tab ──────────────────────────────────────────────────

const DEFAULT_SCENARIOS: MortgageScenario[] = [
  // Wave 156 (156H round 2): no prefilled rate or down payment — each scenario's rate is the lender's quote the person enters.
  { name: "30-Year Fixed", term: 30, interestRate: 0, downPayment: 0, loanType: "fixed" },
  { name: "15-Year Fixed", term: 15, interestRate: 0, downPayment: 0, loanType: "fixed" },
  { name: "5/1 ARM", term: 30, interestRate: 0, downPayment: 0, loanType: "arm" },
]

function MortgageTab({ brokerageId: _brokerageId }: { brokerageId: string }) {
  const [visitorId] = useState(getOrCreateVisitorId)
  const [isPending, startTransition] = useTransition()
  const [isSaving, startSaveTransition] = useTransition()
  const [result, setResult] = useState<MortgageResult | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  // The address a copy is emailed to. saveCalculation has always ACCEPTED an
  // email and its success message has always promised "we'll email you a copy",
  // but no caller ever supplied one and nothing ever sent it. The address is
  // recorded ON THE ROW here because emailCalculationResults refuses to send
  // anywhere else — the destination is never the caller's to choose.
  const [saveEmail, setSaveEmail] = useState("")

  const [loanAmount, setLoanAmount] = useState("")
  const [scenarios, setScenarios] = useState<MortgageScenario[]>(DEFAULT_SCENARIOS)

  function updateScenario(idx: number, field: keyof MortgageScenario, val: string) {
    setScenarios((prev) => {
      const next = [...prev]
      if (field === "term" || field === "interestRate" || field === "downPayment") {
        ;(next[idx] as any)[field] = parseFloat(val) || 0
      } else {
        ;(next[idx] as any)[field] = val
      }
      return next
    })
  }

  function addScenario() {
    if (scenarios.length >= 3) return
    setScenarios((prev) => [
      ...prev,
      { name: `Scenario ${prev.length + 1}`, term: 30, interestRate: 0, downPayment: 0, loanType: "fixed" },
    ])
  }

  function removeScenario(idx: number) {
    setScenarios((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleCalculate() {
    const la = parseFloat(loanAmount)
    if (!la || scenarios.length === 0) return
    if (scenarios.some((sc) => !(sc.interestRate > 0))) { setResult({ success: false, error: "Enter each scenario's interest rate (your lender's quote) — none is assumed." } as MortgageResult); return }

    startTransition(async () => {
      const res = await compareMortgageScenarios({ loanAmount: la, scenarios })
      setResult(res)
      setSaveMsg(null)
    })
  }

  function handleSave() {
    if (!result) return
    startSaveTransition(async () => {
      const res = await saveCalculation({
        toolName: "mortgage_comparison",
        calculationData: result,
        visitorId,
        email: saveEmail.trim() || undefined,
      })
      setSaveMsg(res.success ? saveMessageWithRetrievalCaveat(res.message ?? "Saved.") : "Save failed.")
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Mortgage Comparison</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5 max-w-xs">
            <Label>Loan Amount / Home Price ($)</Label>
            <Input
              type="number"
              placeholder="500000"
              value={loanAmount}
              onChange={(e) => setLoanAmount(e.target.value)}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Scenarios</p>
              {scenarios.length < 3 && (
                <Button variant="outline" size="sm" onClick={addScenario}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Scenario
                </Button>
              )}
            </div>

            {scenarios.map((s, idx) => (
              <Card key={idx} className="bg-muted/40">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-muted-foreground">Scenario {idx + 1}</p>
                    {scenarios.length > 1 && (
                      <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Remove scenario" onClick={() => removeScenario(idx)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="col-span-2 sm:col-span-3 space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input
                        className="h-8 text-sm"
                        value={s.name}
                        onChange={(e) => updateScenario(idx, "name", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Term (years)</Label>
                      <Input
                        className="h-8 text-sm"
                        type="number"
                        value={s.term}
                        onChange={(e) => updateScenario(idx, "term", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Interest Rate (%)</Label>
                      <Input
                        className="h-8 text-sm"
                        type="number"
                        step="0.01"
                        value={s.interestRate}
                        onChange={(e) => updateScenario(idx, "interestRate", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Down Payment ($)</Label>
                      <Input
                        className="h-8 text-sm"
                        type="number"
                        value={s.downPayment}
                        onChange={(e) => updateScenario(idx, "downPayment", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1 col-span-2 sm:col-span-3">
                      <Label className="text-xs">Loan Type</Label>
                      <Select
                        value={s.loanType}
                        onValueChange={(v) => updateScenario(idx, "loanType", v)}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fixed">Fixed</SelectItem>
                          <SelectItem value="arm">ARM</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Button
            onClick={handleCalculate}
            disabled={!loanAmount || scenarios.length === 0 || isPending}
            className="w-full sm:w-auto"
          >
            {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Comparing…</> : "Compare Scenarios"}
          </Button>
        </CardContent>
      </Card>

      {result && result.success && result.comparisons && (
        <>
          {/* Side-by-side comparison table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comparison</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Metric</th>
                      {result.comparisons.map((c, i) => (
                        <th key={i} className="text-right py-2 px-2 font-semibold">
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {[
                      { label: "Monthly Payment", key: "monthly_payment", format: fmt },
                      { label: "Loan Amount", key: "loan_amount", format: fmt },
                      { label: "Down Payment", key: "down_payment", format: fmt },
                      { label: "Interest Rate", key: "interest_rate", format: (v: number) => fmtPct(v) },
                      { label: "Term", key: "term_years", format: (v: number) => `${v} yr` },
                      { label: "Total Interest", key: "total_interest", format: fmt },
                      { label: "Total Paid", key: "total_paid", format: fmt },
                    ].map((row) => (
                      <tr key={row.key}>
                        <td className="py-2 pr-4 text-muted-foreground">{row.label}</td>
                        {result.comparisons.map((c, i) => (
                          <td key={i} className="text-right py-2 px-2 font-medium">
                            {row.format((c as any)[row.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* AI Recommendations */}
          {result.recommendations && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">AI Recommendations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(result.recommendations).map(([key, val]) => (
                  <div key={key} className="flex gap-3 text-sm">
                    <span className="text-muted-foreground capitalize min-w-36 shrink-0">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span>{String(val)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {result.winner_by_category && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Best By Category</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(result.winner_by_category).map(([key, val]) => (
                  <div key={key} className="flex justify-between text-sm">
                    <span className="text-muted-foreground capitalize">{key.replace(/_/g, " ")}</span>
                    <span className="font-semibold text-primary">{String(val)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="email"
              className="max-w-64"
              placeholder="Email a copy to (optional)"
              value={saveEmail}
              onChange={(e) => setSaveEmail(e.target.value)}
            />
            <Button variant="outline" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save Calculation
            </Button>
            {saveMsg && <p className="text-sm text-muted-foreground">{saveMsg}</p>}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Rent vs Buy Tab ──────────────────────────────────────────────────────────

function RentVsBuyTab({ brokerageId: _brokerageId }: { brokerageId: string }) {
  // Wave 156 (156H round 2): the ONE engine's "buy_vs_rent" on the person's own figures — rent growth, appreciation, selling
  // cost, tax, insurance and maintenance are asked for (calculateRentVsBuy filled them with 3% / 1.25% / 1% / $150 defaults and
  // a 7% "opportunity" return and 25% bracket nobody entered — tombstone in app/actions/calculators.ts).
  const [visitorId] = useState(getOrCreateVisitorId)
  const [isSaving, startSaveTransition] = useTransition()
  const [result, setResult] = useState<CalculatorOutcome | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saveEmail, setSaveEmail] = useState("")

  function handleSave() {
    if (!result || !result.ok) return
    startSaveTransition(async () => {
      const res = await saveCalculation({ toolName: "rent_vs_buy", calculationData: result, visitorId, email: saveEmail.trim() || undefined })
      setSaveMsg(res.success ? saveMessageWithRetrievalCaveat(res.message ?? "Saved.") : "Save failed.")
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Rent vs. Buy Calculator</CardTitle>
        </CardHeader>
        <CardContent>
          <EngineCalculatorPanel kind="buy_vs_rent" visitorId={visitorId} onResult={(o) => { setResult(o); setSaveMsg(null) }} />
        </CardContent>
      </Card>
      {result && result.ok && (
        <div className="flex flex-wrap items-center gap-3">
          <Input type="email" className="max-w-64" placeholder="Email a copy to (optional)" value={saveEmail} onChange={(e) => setSaveEmail(e.target.value)} />
          <Button variant="outline" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save
          </Button>
          {saveMsg && <p className="text-sm text-muted-foreground">{saveMsg}</p>}
        </div>
      )}
    </div>
  )
}

// ─── Saved Calculations Tab ───────────────────────────────────────────────────

/**
 * The retrieval half of `saveCalculation`.
 *
 * `getSavedCalculations` and `emailCalculationResults` were both written and
 * never called: the calculators screen used to mint a throwaway visitor id per
 * tab, so there was never an id to read back with. `getOrCreateVisitorId()`
 * persists one id per browser (already used by the three tabs above), which is
 * the key both actions take — so this tab is the missing UI, not new plumbing.
 *
 * The visitor id IS the retrieval credential. It never leaves this browser
 * except as the argument to these two actions, and `emailCalculationResults`
 * sends only to the address recorded ON THE ROW at save time — the button below
 * cannot redirect a send.
 */
function SavedCalculationsTab() {
  const [visitorId] = useState(getOrCreateVisitorId)
  const [isLoading, startLoad] = useTransition()
  const [rows, setRows] = useState<Array<{
    id: string
    tool_name: string
    calculation_data_json: unknown
    created_at: string
  }> | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [emailingId, setEmailingId] = useState<string | null>(null)
  const [emailMsg, setEmailMsg] = useState<{ id: string; text: string } | null>(null)

  function load() {
    startLoad(async () => {
      setEmailMsg(null)
      const res = await getSavedCalculations(visitorId)
      // The action returns { success:false, calculations: [] } for a refused
      // read as well as for a blank id. An empty list is not proof there is
      // nothing saved, so the two are reported differently.
      setLoadFailed(!res.success)
      setRows(res.success ? (res.calculations as typeof rows) ?? [] : [])
    })
  }

  async function handleEmail(calculationId: string) {
    setEmailingId(calculationId)
    setEmailMsg(null)
    try {
      // The action's branches return either { success, message } or
      // { success, error } and it carries no return annotation, so `success`
      // widens to boolean and the union does not discriminate. Read both
      // optional fields rather than pretend it narrows.
      const res = (await emailCalculationResults({ calculationId, visitorId })) as {
        success: boolean
        message?: string
        error?: string
      }
      setEmailMsg({
        id: calculationId,
        text: res.success ? (res.message ?? "Sent.") : (res.error ?? "The email was not sent."),
      })
    } finally {
      setEmailingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Saved Calculations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={load} disabled={isLoading}>
              {isLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {rows === null ? "Load my saved calculations" : "Refresh"}
            </Button>
            {!isVisitorIdPersistent() && (
              <p className="text-sm text-muted-foreground">
                This browser is blocking local storage, so nothing saved from a previous visit can be
                found here.
              </p>
            )}
          </div>

          {loadFailed && (
            <p className="text-sm text-destructive">
              Your saved calculations could not be read, so this list is not a reading of what you
              have saved.
            </p>
          )}

          {rows !== null && !loadFailed && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing saved from this browser yet. Run a calculation above and press Save.
            </p>
          )}

          {rows !== null && rows.length > 0 && (
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.id} className="rounded-lg border px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium capitalize">{r.tool_name.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEmail(r.id)}
                      disabled={emailingId === r.id}
                    >
                      {emailingId === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      ) : null}
                      Email me a copy
                    </Button>
                  </div>
                  {emailMsg?.id === r.id && (
                    <p className="mt-2 text-sm text-muted-foreground">{emailMsg.text}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function CalculatorsDashboardClient({ brokerageId }: Props) {
  return (
    <div className="px-4 sm:px-6 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Calculators</h1>
        <p className="text-muted-foreground">Financial analysis tools for agents and clients</p>
      </div>

      <Tabs defaultValue="seller-net">
        <TabsList>
          <TabsTrigger value="seller-net">Seller Net Sheet</TabsTrigger>
          <TabsTrigger value="mortgage">Mortgage Comparison</TabsTrigger>
          <TabsTrigger value="rent-vs-buy">Rent vs Buy</TabsTrigger>
          <TabsTrigger value="saved">Saved</TabsTrigger>
        </TabsList>

        <TabsContent value="seller-net" className="mt-6">
          <SellerNetTab brokerageId={brokerageId} />
        </TabsContent>

        <TabsContent value="mortgage" className="mt-6">
          <MortgageTab brokerageId={brokerageId} />
        </TabsContent>

        <TabsContent value="rent-vs-buy" className="mt-6">
          <RentVsBuyTab brokerageId={brokerageId} />
        </TabsContent>

        <TabsContent value="saved" className="mt-6">
          <SavedCalculationsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
