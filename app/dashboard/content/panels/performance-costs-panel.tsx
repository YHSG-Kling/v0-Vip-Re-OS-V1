"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, TrendingUp, DollarSign, Lightbulb } from "lucide-react"
import { toast } from "sonner"
import {
  getContentPerformanceStats,
  getContentPerformanceMetrics,
  getContentInsights,
  getMonthlyAICosts,
  trackContentPerformance,
  logGenerationCost,
} from "@/app/actions/ai-content-generation"

// The CANONICAL model ids — the `AIModel` union in lib/ai/cost-tracking.ts,
// which is what the platform actually emits and what getModelPricing() is keyed
// on. This list used to read "openai/gpt-4o" / "anthropic/claude-sonnet-4.5" /
// "gemini-2.0-flash": a provider-prefixed namespace that existed only in the
// rival price table this panel's server action used to call. That table is
// gone, so those strings would now price at $0 (calculateCost warns and refuses
// to guess rather than silently charging gpt-4o-mini rates, as the old one did).
const MODELS = [
  "claude-sonnet",
  "claude-opus",
  "claude-haiku",
  "gpt-4o",
  "gpt-4-turbo",
  "gpt-4o-mini",
  "gemini-pro",
  "gemini-flash",
]
const PLATFORMS = ["instagram", "facebook", "linkedin", "twitter", "tiktok", "email", "blog"]

export function PerformanceCostsPanel({ drafts }: { drafts: any[] }) {
  const [stats, setStats] = useState<any>(null)
  const [metrics, setMetrics] = useState<any>(null)
  const [insights, setInsights] = useState<any>(null)
  const [costs, setCosts] = useState<any>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isPending, startTransition] = useTransition()

  // performance recorder
  const [perfContentId, setPerfContentId] = useState("")
  const [perfPlatform, setPerfPlatform] = useState(PLATFORMS[0])
  const [impressions, setImpressions] = useState("")
  const [likes, setLikes] = useState("")
  const [shares, setShares] = useState("")
  const [comments, setComments] = useState("")

  // cost logger
  const [costModel, setCostModel] = useState(MODELS[0])
  const [promptTokens, setPromptTokens] = useState("")
  const [completionTokens, setCompletionTokens] = useState("")

  const reload = useCallback(async () => {
    const [statsRes, metricsRes, insightsRes, costsRes] = await Promise.all([
      getContentPerformanceStats(),
      getContentPerformanceMetrics(),
      getContentInsights(),
      getMonthlyAICosts(),
    ])

    const nextErrors: Record<string, string> = {}
    if (statsRes.success) setStats(statsRes.stats)
    else nextErrors.stats = statsRes.error
    if (metricsRes.success) setMetrics(metricsRes.metrics)
    else nextErrors.metrics = metricsRes.error
    if (insightsRes.success) setInsights(insightsRes.insights)
    else nextErrors.insights = insightsRes.error
    if (costsRes.success) setCosts(costsRes.costs)
    else nextErrors.costs = costsRes.error
    setErrors(nextErrors)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const handleTrackPerf = () => {
    startTransition(async () => {
      const res = await trackContentPerformance({
        contentId: perfContentId,
        platform: perfPlatform,
        impressions: Number(impressions) || 0,
        likes: Number(likes) || 0,
        shares: Number(shares) || 0,
        comments: Number(comments) || 0,
        engagement_rate:
          Number(impressions) > 0
            ? ((Number(likes) + Number(shares) + Number(comments)) / Number(impressions)) * 100
            : 0,
      })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Performance recorded")
      setImpressions("")
      setLikes("")
      setShares("")
      setComments("")
      reload()
    })
  }

  const handleLogCost = () => {
    startTransition(async () => {
      const res = await logGenerationCost({
        model: costModel,
        promptTokens: Number(promptTokens) || 0,
        completionTokens: Number(completionTokens) || 0,
        totalTokens: (Number(promptTokens) || 0) + (Number(completionTokens) || 0),
        success: true,
      })
      if (!res.success) { toast.error(res.error); return }
      // Priced by the canonical table (lib/ai/cost-tracking.ts), same as every
      // real generation. Says "recorded", not "billed": this row is content
      // telemetry and is not what the spend card totals.
      toast.success(`Recorded — priced at $${res.cost.toFixed(4)}`)
      setPromptTokens("")
      setCompletionTokens("")
      reload()
    })
  }

  return (
    <div className="space-y-4">
      {/* ── HEADLINE STATS ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Reach &amp; engagement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {errors.stats ? (
            <p className="text-xs text-destructive">{errors.stats}</p>
          ) : stats ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Impressions" value={stats.totalImpressions.toLocaleString()} />
                <Stat label="Engagement" value={stats.totalEngagement.toLocaleString()} />
                <Stat label="Avg rate" value={`${stats.avgEngagementRate.toFixed(1)}%`} />
              </div>
              {stats.topPerformingContent.length > 0 && (
                <div className="divide-y">
                  {stats.topPerformingContent.map((c: any) => (
                    <div key={c.contentId} className="py-2 flex items-center justify-between text-xs">
                      <span className="truncate">{c.title}</span>
                      <span className="text-muted-foreground shrink-0">
                        {c.impressions.toLocaleString()} impressions · {c.engagement.toLocaleString()} engagement
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {Object.keys(stats.performanceByType).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(stats.performanceByType).map(([type, v]: [string, any]) => (
                    <Badge key={type} variant="outline" className="text-[10px]">
                      {type}: {v.impressions.toLocaleString()} / {v.engagement.toLocaleString()}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          ) : null}

          <div className="border-t pt-3 space-y-3">
            <Label className="text-xs">Record platform results for a piece</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select value={perfContentId} onValueChange={setPerfContentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick content" />
                </SelectTrigger>
                <SelectContent>
                  {drafts.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title || d.content_type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={perfPlatform} onValueChange={setPerfPlatform}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Input
                type="number"
                min={0}
                placeholder="Impressions"
                value={impressions}
                onChange={(e) => setImpressions(e.target.value)}
              />
              <Input type="number" min={0} placeholder="Likes" value={likes} onChange={(e) => setLikes(e.target.value)} />
              <Input
                type="number"
                min={0}
                placeholder="Shares"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
              />
              <Input
                type="number"
                min={0}
                placeholder="Comments"
                value={comments}
                onChange={(e) => setComments(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={handleTrackPerf} disabled={isPending || !perfContentId}>
              {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Record performance
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── OPS METRICS ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Generation metrics</CardTitle>
        </CardHeader>
        <CardContent>
          {errors.metrics ? (
            <p className="text-xs text-destructive">{errors.metrics}</p>
          ) : metrics ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Pieces generated" value={String(metrics.content_volume)} />
              <Stat label="Avg time" value={`${Math.round(metrics.avg_generation_time_ms)}ms`} />
              <Stat label="Used as written" value={`${Math.round(metrics.approval_rate * 100)}%`} />
              <Stat label="Success rate" value={`${Math.round(metrics.usage_rate * 100)}%`} />
              <Stat label="Most used" value={metrics.most_used_content_type} />
              <Stat
                label="Peak hours"
                value={metrics.peak_usage_hours.length ? metrics.peak_usage_hours.join(", ") : "—"}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── INSIGHTS ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Lightbulb className="h-4 w-4" /> Insights
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {errors.insights ? (
            <p className="text-xs text-destructive">{errors.insights}</p>
          ) : insights ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {insights.total_pieces} pieces
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {Math.round(insights.edit_rate * 100)}% edited
                </Badge>
                {insights.most_popular_personas.map((p: string) => (
                  <Badge key={p} variant="secondary" className="text-[10px]">
                    {p}
                  </Badge>
                ))}
              </div>
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                {insights.recommendations.map((r: string, i: number) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ── AI SPEND ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Content AI spend this month
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {errors.costs ? (
            <p className="text-xs text-destructive">{errors.costs}</p>
          ) : costs ? (
            <>
              {/* These four now come from ai_tool_usage — the platform's ONE
                  cost ledger, the same table the billing rollup and the
                  fair-use counter read — filtered to the content features and
                  scoped to this agent's brokerage. That means BOTH content
                  lanes count, so the figures are legitimately larger than what
                  this card showed when it read Lane B's own table.

                  `Tokens` is the capability ported off the deleted
                  getContentGenerationStats — the one number of its four that
                  nothing else surfaced. It read a column that does not exist,
                  so it always showed 0; this reads ai_tool_usage.tokens_used,
                  the provider's real input+output count.

                  "Avg each" is labelled as a ceiling on purpose: cost_cents is
                  an integer Math.ceil'd per call, so a sub-cent generation
                  books as 1 cent and the average can never read below $0.01. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Total" value={`$${costs.total_cost.toFixed(2)}`} />
                <Stat label="Generations" value={String(costs.total_generations)} />
                <Stat label="Avg each (max)" value={`$${costs.avg_cost_per_generation.toFixed(4)}`} />
                <Stat label="Tokens" value={costs.total_tokens.toLocaleString()} />
              </div>
              <p className="text-[10px] text-muted-foreground">
                From the platform usage ledger, across every content generator. Costs are rounded up to
                the nearest cent per generation, so totals are an upper bound.
              </p>
              {costs.breakdown_by_model.length > 0 && (
                <div className="divide-y">
                  {costs.breakdown_by_model.map((m: any) => (
                    <div key={m.model} className="py-2 flex items-center justify-between text-xs">
                      <span className="font-mono">{m.model}</span>
                      <span className="text-muted-foreground">
                        ${m.cost.toFixed(4)} over {m.count} · {m.tokens.toLocaleString()} tok
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}

          <div className="border-t pt-3 space-y-3">
            {/* HONESTY FIX. This form writes content_generation_logs, which is
                the per-artifact telemetry lane — NOT the cost ledger the card
                above reads. It therefore moves "Generation metrics", not "AI
                spend". Calling it "Log a generation cost" next to a spend total
                it cannot change would be a lie about what the button does. */}
            <Label className="text-xs">Record a generation in the content log</Label>
            <p className="text-[10px] text-muted-foreground">
              Adds a row to this agent&apos;s content generation history. It does not change the spend
              figures above — those come from the platform usage ledger, which only real AI calls write.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Select value={costModel} onValueChange={setCostModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={0}
                placeholder="Prompt tokens"
                value={promptTokens}
                onChange={(e) => setPromptTokens(e.target.value)}
              />
              <Input
                type="number"
                min={0}
                placeholder="Completion tokens"
                value={completionTokens}
                onChange={(e) => setCompletionTokens(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={handleLogCost} disabled={isPending || !promptTokens}>
              {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Record generation
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  )
}
