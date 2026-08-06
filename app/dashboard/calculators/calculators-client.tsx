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
  calculateRentVsBuy,
  saveCalculation,
} from "@/app/actions/calculators"
// One persisted identity for every tool on this page. Each tab used to mint its
// own `crypto.randomUUID()` per mount, so a saved calculation was filed under an
// id that died with the component — unreadable by anything, including the
// retrieval action written for it.
import { getOrCreateVisitorId, isVisitorIdPersistent } from "@/lib/tools/visitor-id"

// ─── Types ────────────────────────────────────────────────────────────────────

type SellerNetResult = Awaited<ReturnType<typeof calculateSellerNet>>
type MortgageResult = Awaited<ReturnType<typeof compareMortgageScenarios>>
type RentVsBuyResult = Awaited<ReturnType<typeof calculateRentVsBuy>>

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

  const [homeValue, setHomeValue] = useState("")
  const [mortgageBalance, setMortgageBalance] = useState("")
  const [location, setLocation] = useState("")
  const [state, setState] = useState("")
  const [hoaFees, setHoaFees] = useState("")
  const [repairsConcessions, setRepairsConcessions] = useState("")
  const [stagingCost, setStagingCost] = useState("")
  const [movingCost, setMovingCost] = useState("")

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
      })
      setSaveMsg(res.success ? saveMessageWithRetrievalCaveat(res.message ?? "Saved.") : "Save failed.")
    })
  }

  const canCalculate = !!homeValue && !!location && !!state

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
                  placeholder="auto"
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
                  placeholder="2000"
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
                  <span className={result.net_proceeds >= 0 ? "text-green-600" : "text-red-600"}>
                    {fmt(result.net_proceeds)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

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
          <div className="flex items-center gap-3">
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
  { name: "30-Year Fixed", term: 30, interestRate: 7.0, downPayment: 60000, loanType: "fixed" },
  { name: "15-Year Fixed", term: 15, interestRate: 6.5, downPayment: 60000, loanType: "fixed" },
  { name: "5/1 ARM", term: 30, interestRate: 6.25, downPayment: 60000, loanType: "arm" },
]

function MortgageTab({ brokerageId: _brokerageId }: { brokerageId: string }) {
  const [visitorId] = useState(getOrCreateVisitorId)
  const [isPending, startTransition] = useTransition()
  const [isSaving, startSaveTransition] = useTransition()
  const [result, setResult] = useState<MortgageResult | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

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
      { name: `Scenario ${prev.length + 1}`, term: 30, interestRate: 7.0, downPayment: 0, loanType: "fixed" },
    ])
  }

  function removeScenario(idx: number) {
    setScenarios((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleCalculate() {
    const la = parseFloat(loanAmount)
    if (!la || scenarios.length === 0) return

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
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeScenario(idx)}>
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

          <div className="flex items-center gap-3">
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

function RentVsBuyTab({ brokerageId }: { brokerageId: string }) {
  const [visitorId] = useState(getOrCreateVisitorId)
  const [isPending, startTransition] = useTransition()
  const [isSaving, startSaveTransition] = useTransition()
  const [result, setResult] = useState<RentVsBuyResult | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const [rentAmount, setRentAmount] = useState("")
  const [homePrice, setHomePrice] = useState("")
  const [downPayment, setDownPayment] = useState("")
  const [interestRate, setInterestRate] = useState("")
  const [yearsToStay, setYearsToStay] = useState("")
  const [annualAppreciation, setAnnualAppreciation] = useState("")
  const [city, setCity] = useState("")

  function handleCalculate() {
    const fields = { rentAmount, homePrice, downPayment, interestRate, yearsToStay }
    if (Object.values(fields).some((v) => !v)) return

    startTransition(async () => {
      const res = await calculateRentVsBuy({
        rentAmount: parseFloat(rentAmount),
        homePrice: parseFloat(homePrice),
        downPayment: parseFloat(downPayment),
        interestRate: parseFloat(interestRate),
        yearsToStay: parseFloat(yearsToStay),
        annualAppreciation: annualAppreciation ? parseFloat(annualAppreciation) / 100 : undefined,
        city: city || undefined,
        brokerageId,
      })
      setResult(res)
      setSaveMsg(null)
    })
  }

  /**
   * Save only. The Share button that sat beside this was REMOVED on the owner's
   * ruling: "not sure why we would need to share a calculator, sharing property
   * listings yes". Listing sharing already exists at
   * /dashboard/listings/[id]/share — that is the capability that was wanted.
   *
   * It was also broken and unsafe in three ways, which is why nothing is lost:
   *   · the URL it produced, /tools/shared/{token}, had NO ROUTE — every link an
   *     agent copied and sent to a client 404'd.
   *   · tool_shares RLS requires brokerage membership, so even with a route the
   *     recipient (a client, by definition not a member) could never read it.
   *   · the token was `Date.now()` plus ~24 bits of Math.random() — guessable —
   *     and the shared payload carried the saver's email address.
   */
  function handleSave() {
    if (!result) return
    startSaveTransition(async () => {
      const res = await saveCalculation({
        toolName: "rent_vs_buy",
        calculationData: result,
        visitorId,
      })
      setSaveMsg(res.success ? saveMessageWithRetrievalCaveat(res.message ?? "Saved.") : "Save failed.")
    })
  }

  const canCalculate =
    !!rentAmount && !!homePrice && !!downPayment && !!interestRate && !!yearsToStay

  const isBuyBetter = result?.recommendation?.startsWith("BUYING")

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Rent vs. Buy Calculator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Monthly Rent ($)</Label>
              <Input
                type="number"
                placeholder="2500"
                value={rentAmount}
                onChange={(e) => setRentAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Home Price ($)</Label>
              <Input
                type="number"
                placeholder="500000"
                value={homePrice}
                onChange={(e) => setHomePrice(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Down Payment ($)</Label>
              <Input
                type="number"
                placeholder="100000"
                value={downPayment}
                onChange={(e) => setDownPayment(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Interest Rate (%)</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="7.0"
                value={interestRate}
                onChange={(e) => setInterestRate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Years Planning to Stay</Label>
              <Input
                type="number"
                placeholder="5"
                value={yearsToStay}
                onChange={(e) => setYearsToStay(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Annual Appreciation (% — optional)</Label>
              <Input
                type="number"
                step="0.1"
                placeholder="3"
                value={annualAppreciation}
                onChange={(e) => setAnnualAppreciation(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>City (optional)</Label>
              <Input
                placeholder="Austin"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </div>
          </div>

          <Button onClick={handleCalculate} disabled={!canCalculate || isPending} className="w-full sm:w-auto">
            {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Calculating…</> : "Calculate"}
          </Button>
        </CardContent>
      </Card>

      {result && result.success && (
        <>
          {/* Recommendation Banner */}
          <Card className={`border-2 ${isBuyBetter ? "border-green-500 bg-green-50 dark:bg-green-950/20" : "border-blue-500 bg-blue-50 dark:bg-blue-950/20"}`}>
            <CardContent className="p-4">
              <p className={`font-semibold ${isBuyBetter ? "text-green-700 dark:text-green-400" : "text-blue-700 dark:text-blue-400"}`}>
                {result.recommendation}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Break-even at: <strong>{result.breakEvenYears} years</strong>
              </p>
            </CardContent>
          </Card>

          {/* Scenario comparison */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Renting</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Monthly Rent</span>
                  <span className="font-medium">{fmt(result.rentScenario.monthlyPayment)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Cost ({yearsToStay} yrs)</span>
                  <span className="font-medium">{fmt(result.rentScenario.totalCost)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Equity Built</span>
                  <span className="font-medium">$0</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Buying</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Monthly Payment</span>
                  <span className="font-medium">{fmt(result.buyScenario.monthlyPayment)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Cost ({yearsToStay} yrs)</span>
                  <span className="font-medium">{fmt(result.buyScenario.totalCost)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Equity Built</span>
                  <span className="font-medium text-green-600">{fmt(result.buyScenario.equityBuilt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Home Value</span>
                  <span className="font-medium">{fmt(result.buyScenario.homeValueAfterYears)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Net If Sold</span>
                  <span className="font-medium">{fmt(result.buyScenario.netProceedsIfSold)}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Analysis */}
          {result.analysis && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Analysis</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {Object.entries(result.analysis).map(([key, val]) => (
                  <div key={key} className="flex flex-col sm:flex-row sm:gap-3">
                    <span className="text-muted-foreground capitalize min-w-40 shrink-0">
                      {key.replace(/([A-Z])/g, " $1").trim()}
                    </span>
                    <span>{String(val)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Save. Sharing a CALCULATION was removed — see the note on
              handleSave below. Sharing a property LISTING is the wanted
              capability and lives at /dashboard/listings/[id]/share. */}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save
            </Button>
            {saveMsg && <p className="text-sm text-muted-foreground">{saveMsg}</p>}
          </div>
        </>
      )}
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
      </Tabs>
    </div>
  )
}
