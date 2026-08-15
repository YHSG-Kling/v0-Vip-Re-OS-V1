"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Target, Sparkles, Loader2, Copy, Check, TrendingUp } from "lucide-react"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"
import { toast } from "sonner"

interface BusinessPlanningPanelProps {
  agentId: string
  ytdGCI: number
  ytdTransactionCount: number
  ytdExpenses: number
}

export function BusinessPlanningPanel({
  agentId,
  ytdGCI,
  ytdTransactionCount,
  ytdExpenses,
}: BusinessPlanningPanelProps) {
  const [annualTarget, setAnnualTarget] = useState<number>(ytdGCI > 0 ? Math.ceil(ytdGCI * 1.2 / 10000) * 10000 : 100000)
  const [aiPlan, setAiPlan] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)

  // Calculate projections
  const currentMonth = new Date().getMonth() + 1
  const projectedAnnual = currentMonth > 0 ? (ytdGCI / currentMonth) * 12 : 0
  const avgGCIPerDeal = ytdTransactionCount > 0 ? ytdGCI / ytdTransactionCount : 0
  const dealsNeededForTarget = avgGCIPerDeal > 0 ? Math.ceil(annualTarget / avgGCIPerDeal) : 0
  const dealsNeededRemaining = Math.max(0, dealsNeededForTarget - ytdTransactionCount)
  const onTrackStatus = projectedAnnual >= annualTarget ? "on-track" : "behind"

  const handleGeneratePlan = async () => {
    setGenerating(true)
    try {
      const result = await (generateSmartResponse as any)({
        agentId,
        context: `Business planning for real estate agent. YTD GCI: $${ytdGCI.toLocaleString()}, ${ytdTransactionCount} deals closed, expenses: $${ytdExpenses.toLocaleString()}, annual target: $${annualTarget.toLocaleString()}.`,
        prompt: `Create a 90-day business plan for a real estate agent with these metrics: YTD GCI $${ytdGCI.toLocaleString()}, ${ytdTransactionCount} deals closed, expenses $${ytdExpenses.toLocaleString()}. Annual target: $${annualTarget.toLocaleString()}. Include: lead generation plan, marketing actions, relationship touchpoints, financial discipline steps. Be specific and actionable.`,
        responseType: "plan",
      })
      if ((result as any).draft) {
        setAiPlan((result as any).draft)
      }
    } catch (error) {
      console.error("Error generating business plan:", error)
      toast.error("Failed to generate business plan")
    } finally {
      setGenerating(false)
    }
  }

  const handleCopyPlan = async () => {
    if (aiPlan) {
      await navigator.clipboard.writeText(aiPlan)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success("Plan copied to clipboard")
    }
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
          <Target className="h-5 w-5 text-blue-600" />
          Business Planning
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Annual target input */}
        <div className="space-y-2">
          <Label htmlFor="annual-target">Annual GCI Target</Label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">$</span>
            <Input
              id="annual-target"
              type="number"
              value={annualTarget}
              onChange={(e) => setAnnualTarget(Number(e.target.value))}
              className="flex-1"
            />
          </div>
        </div>

        {/* Current pace */}
        <div className={`p-4 rounded-lg ${onTrackStatus === "on-track" ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"} border`}>
          <div className="flex items-center gap-2">
            <TrendingUp className={`h-4 w-4 ${onTrackStatus === "on-track" ? "text-green-600" : "text-amber-600"}`} />
            <p className={`text-sm font-medium ${onTrackStatus === "on-track" ? "text-green-700" : "text-amber-700"}`}>
              {onTrackStatus === "on-track" ? "On Track" : "Behind Pace"}
            </p>
          </div>
          <p className="text-sm mt-1">
            At your current pace, you're on track for{" "}
            <span className="font-semibold">{formatCurrency(projectedAnnual)}</span> this year
          </p>
        </div>

        {/* Deals needed */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-xs text-muted-foreground">Deals to Hit Target</p>
            <p className="text-2xl font-bold">{dealsNeededForTarget}</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-xs text-muted-foreground">Deals Remaining</p>
            <p className="text-2xl font-bold">{dealsNeededRemaining}</p>
          </div>
        </div>

        {/* Average GCI per deal */}
        <div className="text-center text-sm text-muted-foreground">
          Average GCI per deal:{" "}
          <span className="font-semibold text-foreground">{formatCurrency(avgGCIPerDeal)}</span>
        </div>

        {/* Generate plan button */}
        <Button
          onClick={handleGeneratePlan}
          disabled={generating}
          className="w-full"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4 mr-2" />
          )}
          Generate 90-Day Business Plan
        </Button>

        {/* AI Plan display */}
        {aiPlan && (
          <div className="relative">
            <div className="p-4 rounded-lg bg-blue-50 border border-blue-200 max-h-64 overflow-y-auto">
              <p className="text-sm text-blue-900 whitespace-pre-wrap">{aiPlan}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyPlan}
              className="absolute top-2 right-2"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
