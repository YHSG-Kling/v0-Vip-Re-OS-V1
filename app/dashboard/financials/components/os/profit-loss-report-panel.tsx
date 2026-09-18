"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  FileText,
  Loader2,
  TrendingUp,
  TrendingDown,
  DollarSign,
  AlertCircle,
  Copy,
  Check,
} from "lucide-react"
import { aiGenerateProfitLossReport } from "@/app/actions/ai-financial-management"

interface PLReportPanelProps {
  agentId: string
  defaultStartDate?: string
  defaultEndDate?: string
}

interface PLReportData {
  period: { start: string; end: string }
  income: {
    total: number
    transactionCount: number
    averageCommission: number
  }
  expenses: {
    total: number
    byCategory: Record<string, number>
    deductible: number
  }
  netProfit: number
  profitMargin: number
  analysis?: {
    performanceSummary?: string
    healthScore?: number
    recommendations?: { area: string; suggestion: string; potentialSavings?: number }[]
    taxProjection?: {
      estimatedTaxableIncome?: number
      estimatedTaxLiability?: number
      quarterlyPaymentSuggestion?: number
    }
  }
}

export function ProfitLossReportPanel({
  agentId,
  defaultStartDate,
  defaultEndDate,
}: PLReportPanelProps) {
  const currentYear = new Date().getFullYear()
  const [startDate, setStartDate] = useState(
    defaultStartDate || `${currentYear}-01-01`
  )
  const [endDate, setEndDate] = useState(
    defaultEndDate || new Date().toISOString().split("T")[0]
  )
  const [includeProjections, setIncludeProjections] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [report, setReport] = useState<PLReportData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const formatPercent = (val: number) => `${val.toFixed(1)}%`

  const handleGenerate = async () => {
    setIsGenerating(true)
    setError(null)

    try {
      const result = await aiGenerateProfitLossReport({
        agentId,
        startDate,
        endDate,
        includeProjections,
      })

      if (result.success && result.report) {
        setReport(result.report as PLReportData)
      } else {
        setError(result.error || "Failed to generate report")
      }
    } catch (err) {
      setError("An error occurred while generating the report")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopyReport = async () => {
    if (!report) return

    const reportText = `
PROFIT & LOSS REPORT
Period: ${report.period.start} to ${report.period.end}

INCOME
Total Commission Income: ${formatCurrency(report.income.total)}
Transactions: ${report.income.transactionCount}
Average Commission: ${formatCurrency(report.income.averageCommission)}

EXPENSES
Total Expenses: ${formatCurrency(report.expenses.total)}
Deductible Expenses: ${formatCurrency(report.expenses.deductible)}

${Object.entries(report.expenses.byCategory)
  .map(([cat, amt]) => `  ${cat}: ${formatCurrency(amt as number)}`)
  .join("\n")}

NET PROFIT: ${formatCurrency(report.netProfit)}
Profit Margin: ${formatPercent(report.profitMargin)}

${report.analysis?.performanceSummary || ""}
    `.trim()

    await navigator.clipboard.writeText(reportText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card className="border-violet-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-violet-100">
              <FileText className="h-5 w-5 text-violet-700" />
            </div>
            <div>
              <CardTitle className="text-base">Profit & Loss Report</CardTitle>
              <CardDescription>AI-powered financial analysis</CardDescription>
            </div>
          </div>
          {report && (
            <Badge variant="outline" className="border-green-200 text-green-700">
              Generated
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Date Range Selection */}
        {!report && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="includeProjections"
                checked={includeProjections}
                onCheckedChange={(checked) =>
                  setIncludeProjections(checked as boolean)
                }
              />
              <Label htmlFor="includeProjections" className="text-sm">
                Include AI projections and recommendations
              </Label>
            </div>

            <Button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full bg-violet-600 hover:bg-violet-700"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating Report...
                </>
              ) : (
                <>
                  <FileText className="h-4 w-4 mr-2" />
                  Generate P&L Report
                </>
              )}
            </Button>

            {error && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </div>
        )}

        {/* Report Display */}
        {report && (
          <div className="space-y-4">
            {/* Period Header */}
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <span className="text-sm font-medium">
                {new Date(report.period.start).toLocaleDateString()} -{" "}
                {new Date(report.period.end).toLocaleDateString()}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyReport}
                >
                  {copied ? (
                    <Check className="h-4 w-4 mr-1" />
                  ) : (
                    <Copy className="h-4 w-4 mr-1" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReport(null)}
                >
                  New Report
                </Button>
              </div>
            </div>

            {/* Income Section */}
            <div className="p-4 rounded-lg bg-green-50 border border-green-200">
              <h4 className="text-sm font-medium text-green-800 mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Income
              </h4>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-green-700">Total</p>
                  <p className="text-xl font-bold text-green-600">
                    {formatCurrency(report.income.total)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-green-700">Transactions</p>
                  <p className="text-xl font-bold text-green-600">
                    {report.income.transactionCount}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-green-700">Avg Commission</p>
                  <p className="text-xl font-bold text-green-600">
                    {formatCurrency(report.income.averageCommission)}
                  </p>
                </div>
              </div>
            </div>

            {/* Expenses Section */}
            <div className="p-4 rounded-lg bg-red-50 border border-red-200">
              <h4 className="text-sm font-medium text-red-800 mb-3 flex items-center gap-2">
                <TrendingDown className="h-4 w-4" />
                Expenses
              </h4>
              <div className="grid grid-cols-2 gap-4 mb-3">
                <div>
                  <p className="text-xs text-red-700">Total</p>
                  <p className="text-xl font-bold text-red-600">
                    {formatCurrency(report.expenses.total)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-red-700">Deductible</p>
                  <p className="text-xl font-bold text-red-600">
                    {formatCurrency(report.expenses.deductible)}
                  </p>
                </div>
              </div>
              {Object.keys(report.expenses.byCategory).length > 0 && (
                <div className="space-y-1 pt-3 border-t border-red-200">
                  {Object.entries(report.expenses.byCategory)
                    .sort(([, a], [, b]) => (b as number) - (a as number))
                    .slice(0, 5)
                    .map(([cat, amt]) => (
                      <div key={cat} className="flex items-center justify-between text-sm">
                        <span className="text-red-700">{cat}</span>
                        <span className="font-medium text-red-600">
                          {formatCurrency(amt as number)}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Net Profit */}
            <div className="p-4 rounded-lg bg-violet-50 border border-violet-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-violet-600" />
                  <span className="font-medium text-violet-800">Net Profit</span>
                </div>
                <div className="text-right">
                  <p
                    className={`text-2xl font-bold ${
                      report.netProfit >= 0 ? "text-violet-600" : "text-red-600"
                    }`}
                  >
                    {formatCurrency(report.netProfit)}
                  </p>
                  <p className="text-sm text-violet-600">
                    {formatPercent(report.profitMargin)} margin
                  </p>
                </div>
              </div>
            </div>

            {/* AI Analysis */}
            {report.analysis && (
              <div className="space-y-3">
                {report.analysis.performanceSummary && (
                  <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                    <p className="text-sm text-blue-800">
                      {report.analysis.performanceSummary}
                    </p>
                  </div>
                )}

                {report.analysis.healthScore !== undefined && (
                  <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                    <span className="text-sm font-medium">Financial Health Score</span>
                    <Badge
                      variant="outline"
                      className={`${
                        report.analysis.healthScore >= 80
                          ? "border-green-200 text-green-700"
                          : report.analysis.healthScore >= 60
                            ? "border-amber-200 text-amber-700"
                            : "border-red-200 text-red-700"
                      }`}
                    >
                      {report.analysis.healthScore}/100
                    </Badge>
                  </div>
                )}

                {report.analysis.recommendations &&
                  report.analysis.recommendations.length > 0 && (
                    <div>
                      <h5 className="text-sm font-medium mb-2">Recommendations</h5>
                      <div className="space-y-2">
                        {report.analysis.recommendations.slice(0, 3).map((rec, idx) => (
                          <div
                            key={idx}
                            className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-sm"
                          >
                            <span className="font-medium text-amber-800">{rec.area}:</span>{" "}
                            <span className="text-amber-700">{rec.suggestion}</span>
                            {rec.potentialSavings && (
                              <Badge variant="outline" className="ml-2 text-xs">
                                Save {formatCurrency(rec.potentialSavings)}
                              </Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                {report.analysis.taxProjection && (
                  <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200">
                    <h5 className="text-sm font-medium text-indigo-800 mb-2">Tax Projection</h5>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      {report.analysis.taxProjection.estimatedTaxLiability && (
                        <div>
                          <p className="text-xs text-indigo-600">Est. Tax Liability</p>
                          <p className="font-medium text-indigo-800">
                            {formatCurrency(report.analysis.taxProjection.estimatedTaxLiability)}
                          </p>
                        </div>
                      )}
                      {report.analysis.taxProjection.quarterlyPaymentSuggestion && (
                        <div>
                          <p className="text-xs text-indigo-600">Quarterly Payment</p>
                          <p className="font-medium text-indigo-800">
                            {formatCurrency(
                              report.analysis.taxProjection.quarterlyPaymentSuggestion
                            )}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
