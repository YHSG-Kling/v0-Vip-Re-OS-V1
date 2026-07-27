import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, Target, Trophy } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { generateStrategyInsights } from "@/lib/strategy-learning/strategy-insights"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

/**
 * WHAT'S WINNING — the strategy-learning read side, surfaced. The outcome-closing
 * loop accumulates strategy_outcomes; this shows the broker which offer strategies
 * are actually converting and how close winning offers landed to the AI's
 * recommendation. The same numbers feed the next recommendation's prompt (Shopping
 * Agent), so this panel and the recommender share one source of truth.
 */
function pct(n: number | null): string { return n == null ? "—" : `${Math.round(n * 100)}%` }
function usd(n: number | null): string { return n == null ? "—" : `$${Math.round(n).toLocaleString()}` }

export default async function StrategyInsightsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return <div className="p-6 text-red-600">Brokerage not configured</div>
  if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(profile.user_type ?? "")) {
    return <div className="p-6 text-red-600">Forbidden</div>
  }

  const insights = await generateStrategyInsights({ brokerageId: profile.brokerage_id })

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Trophy className="h-6 w-6 text-amber-500" /> What&apos;s Winning — Offer Strategy
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Last {insights.windowDays} days of offer outcomes. The Shopping Agent feeds these same
          numbers into every new recommendation — your AI learns from what actually closed.
        </p>
      </div>

      {insights.sampleSize === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">
          No offer-strategy outcomes recorded yet. As offers close, this panel fills in and the
          recommender starts grounding its advice in your brokerage&apos;s real results.
        </CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Card><CardContent className="py-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs"><Target className="h-3.5 w-3.5" /> Acceptance rate</div>
              <div className="text-3xl font-semibold">{pct(insights.winRate)}</div>
              <div className="text-xs text-muted-foreground">{insights.outcomeCounts.accepted} accepted · {insights.outcomeCounts.rejected} rejected</div>
            </CardContent></Card>
            <Card><CardContent className="py-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs"><TrendingUp className="h-3.5 w-3.5" /> Avg accepted deviation</div>
              <div className="text-3xl font-semibold">{usd(insights.avgAcceptedDeviation)}</div>
              <div className="text-xs text-muted-foreground">how far winning offers landed from the recommendation</div>
            </CardContent></Card>
            <Card><CardContent className="py-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs">Sample</div>
              <div className="text-3xl font-semibold">{insights.sampleSize}</div>
              <div className="text-xs text-muted-foreground">recorded outcomes</div>
            </CardContent></Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">By strategy type</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-3">Strategy</th>
                    <th className="py-2 pr-3">Outcomes</th>
                    <th className="py-2 pr-3">Accepted</th>
                    <th className="py-2 pr-3">Win rate</th>
                    <th className="py-2 pr-3">Avg accepted deviation</th>
                  </tr>
                </thead>
                <tbody>
                  {insights.byStrategyType.map((s, i) => (
                    <tr key={s.type} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <Badge className={i === 0 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}>
                          {i === 0 && "★ "}{s.type}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3">{s.total}</td>
                      <td className="py-2 pr-3">{s.accepted}</td>
                      <td className="py-2 pr-3 font-medium">{pct(s.winRate)}</td>
                      <td className="py-2 pr-3">{usd(s.avgAcceptedDeviation)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card className="bg-slate-50/60">
            <CardHeader><CardTitle className="text-base">What the recommender sees</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-foreground italic">&ldquo;{insights.promptContext}&rdquo;</p>
              <p className="text-xs text-muted-foreground mt-2">
                This exact line is injected into every new offer-strategy recommendation — the learn→act loop, closed.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
