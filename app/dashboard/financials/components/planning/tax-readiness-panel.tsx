"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { AlertTriangle, Sparkles, Loader2, Calendar, Copy, Check } from "lucide-react"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"
import { getTaxPlanAction } from "@/app/actions/tax-planning"

interface TaxReadinessPanelProps {
  agentId: string
  brokerageId: string
  ytdGCI: number
  ytdExpenses: number
  quarter: number // 1-4
}

export function TaxReadinessPanel({
  agentId,
  brokerageId,
  ytdGCI,
  ytdExpenses,
  quarter,
}: TaxReadinessPanelProps) {
  const [aiExplanation, setAiExplanation] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)

  // WAVE 153 (lane 153A) — NO SECOND TAX ENGINE. This panel used to compute its own "Est. Tax Due" at a hardcoded 25%
  // and print evergreen due dates (Apr 15 / Jun 15 / Sep 15 / Jan 15, never moved for a weekend or holiday). Both now
  // come from THE ONE estimator (lib/finance/tax-planning.ts via getTaxPlanAction): the suggested reserve exists only
  // once the person has entered their rates (or their accountant's amounts), and the due date is the real one.
  void quarter
  const grossTaxable = ytdGCI - ytdExpenses
  const [plan, setPlan] = useState<Extract<Awaited<ReturnType<typeof getTaxPlanAction>>, { success: true }>["plan"] | null>(null)
  useEffect(() => { getTaxPlanAction().then((r) => { if (r.success) setPlan(r.plan) }).catch(() => {}) }, [])
  const nextQuarter = plan?.quarterly.find((q) => q.status === "open" || q.status === "partly_recorded" || q.status === "needs_input") ?? null
  const estimatedTaxLiability = plan && plan.inputs.status === "ready" ? plan.alreadySetAsideOrPaid + (plan.remainingSuggestedReserve ?? 0) : 0
  const reserveKnown = !!plan && plan.inputs.status === "ready"
  const quarterlyPayment = nextQuarter?.suggested ?? 0
  const nextQuarterDue = nextQuarter
    ? new Date(`${nextQuarter.dueDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "—"
  const expenseRatio = ytdGCI > 0 ? (ytdExpenses / ytdGCI) * 100 : 0

  const handleGenerateExplanation = async () => {
    setGenerating(true)
    try {
      const result = await (generateSmartResponse as any)({
        agentId,
        context: `Tax planning situation. Gross: $${ytdGCI.toLocaleString()}. Expenses: $${ytdExpenses.toLocaleString()}. ${reserveKnown ? `Suggested planning reserve from the rates the agent entered: $${estimatedTaxLiability.toLocaleString()}.` : "The agent has not entered tax rates yet."}`,
        prompt: `Explain this agent's estimated-tax planning in plain language. Gross: $${ytdGCI.toLocaleString()}. Expenses: $${ytdExpenses.toLocaleString()}. ${reserveKnown ? `Suggested planning reserve from the rates they entered: $${estimatedTaxLiability.toLocaleString()}.` : "They have not entered tax rates yet."} Next due date: ${nextQuarterDue}. Do NOT state or suggest a tax rate or say what they legally owe; say a tax professional confirms that. Be specific and practical about record-keeping and setting money aside.`,
        responseType: "advice",
      })
      if ((result as any).draft) {
        setAiExplanation((result as any).draft)
      }
    } catch (error) {
      console.error("Error generating tax explanation:", error)
    } finally {
      setGenerating(false)
    }
  }

  const handleCopyAmount = () => {
    navigator.clipboard.writeText(quarterlyPayment.toFixed(2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          Tax Readiness
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 4-metric grid */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="text-xs text-muted-foreground">YTD Gross</p>
            <p className="text-lg font-semibold">{formatCurrency(ytdGCI)}</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="text-xs text-muted-foreground">YTD Expenses</p>
            <p className="text-lg font-semibold">{formatCurrency(ytdExpenses)}</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="text-xs text-muted-foreground">Est. Taxable</p>
            <p className="text-lg font-semibold">{formatCurrency(grossTaxable)}</p>
          </div>
          <div className={`p-3 rounded-lg ${estimatedTaxLiability > 0 ? "bg-red-50" : "bg-muted/50"}`}>
            <p className="text-xs text-muted-foreground">Suggested reserve (planning)</p>
            {reserveKnown ? (
              <p className={`text-lg font-semibold ${estimatedTaxLiability > 0 ? "text-red-600" : ""}`}>{formatCurrency(estimatedTaxLiability)}</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">Enter your tax rates in the planner</p>
            )}
          </div>
        </div>

        {/* Progress bar: Expenses tracked vs gross */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Expense tracking ratio</span>
            <span className="font-medium">{expenseRatio.toFixed(1)}%</span>
          </div>
          <Progress value={Math.min(expenseRatio, 100)} className="h-2" />
          <p className="text-xs text-muted-foreground">
            Higher expense ratio = lower taxable income
          </p>
        </div>

        {/* Next quarterly payment card */}
        <div className="p-4 rounded-lg border bg-amber-50 border-amber-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-amber-900">Next quarterly date</p>
              <p className="text-2xl font-bold text-amber-700">{nextQuarter?.suggested != null ? formatCurrency(quarterlyPayment) : "Rates needed"}</p>
              <div className="flex items-center gap-1 mt-1">
                <Calendar className="h-3 w-3 text-amber-600" />
                <p className="text-xs text-amber-700">Due: {nextQuarterDue}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyAmount}
              className="border-amber-300 hover:bg-amber-100"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ml-1">{copied ? "Copied" : "Set Aside Now"}</span>
            </Button>
          </div>
        </div>

        {/* AI Explanation */}
        <div className="space-y-3">
          <Button
            variant="outline"
            onClick={handleGenerateExplanation}
            disabled={generating}
            className="w-full"
          >
            {generating ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            Get AI Tax Explanation
          </Button>

          {aiExplanation && (
            <div className="p-4 rounded-lg bg-blue-50 border border-blue-200">
              <p className="text-sm text-blue-900 whitespace-pre-wrap">{aiExplanation}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
