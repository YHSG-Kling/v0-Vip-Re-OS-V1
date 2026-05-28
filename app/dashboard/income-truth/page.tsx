import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  TrendingUp, TrendingDown, Target, AlertTriangle, CheckCircle2,
  Clock, DollarSign, Sparkles,
} from "lucide-react"
import { computeAndPersistGapAction, getLatestGapAction } from "@/app/actions/income-engine"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

function fmtCents(c: number | null | undefined) {
  if (c === null || c === undefined) return "—"
  return `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

const CATEGORY_LABELS: Record<string, string> = {
  prospecting:         "Prospecting",
  listing_acquisition: "Win listings",
  referral_ask:        "Referral ask",
  conversion_focus:    "Convert pipeline",
  reactivation:        "Re-engage",
  negotiation_close:   "Close deal",
  pricing_correction:  "Price correction",
  sphere_nurture:      "Sphere nurture",
  open_house:          "Open house",
  marketing_push:      "Marketing",
}

export default async function IncomeTruthPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Compute fresh on every page load (idempotent — upsert by (agent, date))
  await computeAndPersistGapAction()
  const r = await getLatestGapAction()

  if (!r.ok) {
    return <div className="p-6 text-red-600">Failed: {r.error}</div>
  }
  if (!r.snapshot) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="pt-6 text-center">
            <Sparkles className="h-10 w-10 mx-auto mb-3 text-primary" />
            <p className="font-medium">No income forecast yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Once you have an active pipeline + an annual GCI goal set in your profile,
              this view will show your forecast, gap, and weekly actions to close it.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const s = r.snapshot
  const isBehind = s.gap_to_goal_cents !== null && s.gap_to_goal_cents > 0
  const isAhead  = s.gap_to_goal_cents !== null && s.gap_to_goal_cents <= 0
  const goalProgress = s.annual_goal_cents > 0
    ? Math.min(100, Math.round((s.ytd_gci_cents / s.annual_goal_cents) * 100))
    : 0
  const projectedPct = s.annual_goal_cents > 0
    ? Math.min(150, Math.round((s.projected_year_end_cents / s.annual_goal_cents) * 100))
    : 0

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          Income Truth
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Honest answer to "will I hit my income goal?" — composed from your live
          pipeline, YTD actuals, and sphere expected value. Updated daily.
        </p>
      </div>

      {/* Hero: 4 numbers tell the story */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">YTD GCI</p>
            <p className="text-3xl font-bold">{fmtCents(s.ytd_gci_cents)}</p>
            {s.annual_goal_cents && (
              <Progress value={goalProgress} className="h-1.5 mt-2" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Annual goal</p>
            <p className="text-3xl font-bold">{fmtCents(s.annual_goal_cents)}</p>
            <p className="text-xs text-muted-foreground mt-2">
              {s.annual_goal_cents ? `${goalProgress}% achieved YTD` : "Set a goal in your profile"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Projected year-end</p>
            <p className="text-3xl font-bold">{fmtCents(s.projected_year_end_cents)}</p>
            <p className="text-xs text-muted-foreground mt-2">
              YTD + 90d weighted forecast {projectedPct ? `(${projectedPct}% of goal)` : ""}
            </p>
          </CardContent>
        </Card>
        <Card className={
          isBehind ? "border-red-300 bg-red-50/30" :
          isAhead  ? "border-emerald-300 bg-emerald-50/30" : ""
        }>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1">
              {isBehind ? <TrendingDown className="h-4 w-4 text-red-600" />
                        : isAhead ? <TrendingUp className="h-4 w-4 text-emerald-600" />
                        : <Clock className="h-4 w-4 text-muted-foreground" />}
              <p className="text-xs text-muted-foreground">
                {isBehind ? "Behind goal" : isAhead ? "Ahead of goal" : "Gap"}
              </p>
            </div>
            <p className={`text-3xl font-bold ${isBehind ? "text-red-700" : isAhead ? "text-emerald-700" : ""}`}>
              {s.gap_to_goal_cents === null
                ? "—"
                : isBehind
                ? fmtCents(s.gap_to_goal_cents)
                : fmtCents(-Number(s.gap_to_goal_cents))}
            </p>
            {s.gap_to_goal_pct != null && (
              <p className="text-xs text-muted-foreground mt-2">
                {isBehind
                  ? `${Math.abs(Number(s.gap_to_goal_pct))}% behind`
                  : `${Math.abs(Number(s.gap_to_goal_pct))}% ahead`}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pipeline breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary" />
            Pipeline forecast (weighted by stage probability)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Next 30 days</p>
              <p className="text-2xl font-bold">{fmtCents(s.weighted_30_cents)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Next 90 days</p>
              <p className="text-2xl font-bold">{fmtCents(s.weighted_90_cents)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Next 180 days (incl. sphere)</p>
              <p className="text-2xl font-bold">{fmtCents(s.weighted_180_cents)}</p>
            </div>
          </div>
          {(s.low_band_pct != null && s.high_band_pct != null) && (
            <p className="text-xs text-muted-foreground mt-3">
              Confidence band: {s.low_band_pct}% – {s.high_band_pct}%
            </p>
          )}
        </CardContent>
      </Card>

      {/* Action queue — the differentiator */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            This week's ranked actions
            {r.actions.length > 0 && (
              <Badge variant="outline" className="ml-2 text-xs">{r.actions.length} suggested</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {r.actions.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-600" />
              {isAhead
                ? "No actions needed this week — you're on pace. Keep going."
                : "No specific actions surfaced. Add buyers and listings to your pipeline to generate recommendations."}
            </div>
          ) : (
            <div className="divide-y">
              {r.actions.map((a: any, i: number) => (
                <div key={a.id} className="p-4 hover:bg-muted/10">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-blue-100 text-blue-800 text-xs">#{a.action_rank}</Badge>
                        <Badge variant="outline" className="text-xs">{CATEGORY_LABELS[a.action_category] ?? a.action_category}</Badge>
                        <span className="text-xs text-muted-foreground">
                          Priority {Math.round(Number(a.priority_score))}
                        </span>
                      </div>
                      <p className="font-medium text-sm">{a.action_title}</p>
                      {a.action_description && (
                        <p className="text-xs text-muted-foreground mt-1">{a.action_description}</p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-xs">
                        <span className="text-emerald-700 font-medium flex items-center gap-1">
                          <DollarSign className="h-3 w-3" />
                          +{fmtCents(a.estimated_gci_impact_cents)} expected
                        </span>
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {a.estimated_effort_hours}h
                        </span>
                        {a.due_by && (
                          <span className="text-amber-700">
                            Due {new Date(a.due_by).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Diagnostics — small print at the bottom for trust */}
      {s.diagnostics && Object.keys(s.diagnostics).length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">How this was calculated</summary>
          <div className="border rounded p-3 mt-2 bg-muted/20">
            <ul className="space-y-1">
              {Object.entries(s.diagnostics).map(([k, v]) => (
                <li key={k}><span className="font-mono">{k}</span>: {String(v)}</li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  )
}
