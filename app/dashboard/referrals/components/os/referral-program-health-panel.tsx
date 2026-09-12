"use client"

/**
 * REFERRAL PROGRAM HEALTH — the only view of the program AS A PROGRAM.
 *
 * `app/actions/ai-referral-management.ts:analyzeReferralProgram` reads the
 * caller's OWN referral book (referrer disambiguated by FK constraint, after a
 * pass that found the old embed named a column — `referring_contact_id` — that
 * does not exist on `referrals`, which made PostgREST refuse the whole request
 * so this analytic had never once seen a referral) plus the transactions sourced
 * to referrals, and returns program health, conversion rate, top referrers,
 * insights, prioritised recommendations and a benchmark comparison.
 *
 * Its three siblings in that file are all wired — identifyReferralOpportunities,
 * generateReferralRequest, nurturePendingReferral, recommendReferralReward — and
 * every one of them is about ONE relationship. This is the only one that answers
 * "is my referral program working", and it had no caller anywhere, so nothing in
 * the product ever answered that question.
 *
 * The action derives its agent from the SESSION and refuses a request for
 * anybody else's book, so this panel passes no id.
 *
 * Every number shown came back from the action. The benchmark is the model's
 * estimate of an industry average, not a measured figure, and is labelled as one.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Activity, Loader2, TrendingUp, TrendingDown, Minus, Lightbulb } from "lucide-react"
import { analyzeReferralProgram } from "@/app/actions/ai-referral-management"

interface ProgramAnalysis {
  overallHealth: { score: number; trend: "improving" | "stable" | "declining"; summary: string }
  metrics: {
    totalReferrals: number
    conversionRate: number
    averageValue: number
    topReferrers: Array<{ name: string; referrals: number; closedValue: number }>
  }
  insights: Array<{ insight: string; impact: "high" | "medium" | "low"; actionable: boolean }>
  recommendations: Array<{
    recommendation: string
    expectedImpact: string
    effort: "low" | "medium" | "high"
    priority: number
  }>
  benchmarkComparison: { industryAverage: number; yourPerformance: number; gap: string }
}

const TREND_ICON = { improving: TrendingUp, stable: Minus, declining: TrendingDown } as const

export function ReferralProgramHealthPanel() {
  const [analysis, setAnalysis] = useState<ProgramAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const run = () => {
    setError(null)
    startTransition(async () => {
      const result = await analyzeReferralProgram()
      if (!result.success) {
        // The action returns a specific reason for every refusal — a blocked
        // referral read, a blocked transaction read, no agent profile. Any of
        // those rendered as an empty program would be a false report on the
        // agent's own business.
        setError((result as { error?: string }).error ?? "Could not analyze the referral program.")
        setAnalysis(null)
        return
      }
      setAnalysis((result as any).analysis as ProgramAnalysis)
    })
  }

  const TrendIcon = analysis ? (TREND_ICON[analysis.overallHealth.trend] ?? Minus) : Minus

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Program health
          </CardTitle>
          <CardDescription>
            Your whole referral book, read as one program.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={isPending}>
          {isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          {analysis ? "Re-run" : "Analyze"}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!analysis && !error && !isPending && (
          <p className="text-sm text-muted-foreground">
            Run the analysis to see conversion, top referrers and where the program is losing business.
          </p>
        )}

        {analysis && (
          <>
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xl font-semibold">{analysis.overallHealth.score}</span>
                <span className="text-xs text-muted-foreground">/ 100</span>
                <Badge variant="secondary" className="gap-1 text-[10px] capitalize">
                  <TrendIcon className="h-3 w-3" />
                  {analysis.overallHealth.trend}
                </Badge>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{analysis.overallHealth.summary}</p>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2">
                <p className="text-lg font-semibold">{analysis.metrics.totalReferrals}</p>
                <p className="text-[11px] text-muted-foreground">Referrals</p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-lg font-semibold">{Math.round(analysis.metrics.conversionRate)}%</p>
                <p className="text-[11px] text-muted-foreground">Converted</p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-lg font-semibold">
                  ${Math.round(analysis.metrics.averageValue).toLocaleString()}
                </p>
                <p className="text-[11px] text-muted-foreground">Avg value</p>
              </div>
            </div>

            {analysis.metrics.topReferrers?.length > 0 && (
              <div>
                <p className="text-sm font-medium">Who is sending you business</p>
                <div className="mt-1.5 space-y-1">
                  {analysis.metrics.topReferrers.slice(0, 5).map((r, i) => (
                    <div key={`${r.name}-${i}`} className="flex items-center justify-between rounded border px-2 py-1 text-xs">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-muted-foreground">
                        {r.referrals} referral{r.referrals === 1 ? "" : "s"} · ${Math.round(r.closedValue).toLocaleString()} closed
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {analysis.recommendations?.length > 0 && (
              <div>
                <p className="text-sm font-medium">Do this next</p>
                <div className="mt-1.5 space-y-1.5">
                  {[...analysis.recommendations]
                    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
                    .slice(0, 4)
                    .map((rec, i) => (
                      <div key={i} className="rounded border p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <Lightbulb className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="font-medium">{rec.recommendation}</span>
                          <Badge variant="outline" className="text-[10px] capitalize">{rec.effort} effort</Badge>
                        </div>
                        <p className="mt-1 text-muted-foreground">{rec.expectedImpact}</p>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {analysis.insights?.length > 0 && (
              <div>
                <p className="text-sm font-medium">What the book shows</p>
                <ul className="mt-1.5 ml-4 list-disc space-y-0.5 text-xs text-muted-foreground">
                  {analysis.insights.slice(0, 5).map((ins, i) => (
                    <li key={i}>
                      {ins.insight}
                      {ins.impact === "high" && <span className="ml-1 font-medium text-foreground">(high impact)</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.benchmarkComparison && (
              <p className="text-[11px] text-muted-foreground">
                You: {analysis.benchmarkComparison.yourPerformance} · estimated industry average:{" "}
                {analysis.benchmarkComparison.industryAverage} — {analysis.benchmarkComparison.gap}. The
                benchmark is the model's estimate, not a measured figure.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
