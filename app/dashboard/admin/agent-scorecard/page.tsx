import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Users } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { generateAgentScorecards } from "@/lib/intelligence/agent-scorecard"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

/**
 * AGENT SCORECARD — the agent-management capstone. One row per agent tying production,
 * deal health, education completion, and recruiting-source ROI into the view a broker
 * actually manages on. Feeds off the Owner's Report (same trustworthy columns).
 */
function usd(n: number): string { return `$${Math.round(n).toLocaleString()}` }
function healthTone(s: number | null): string {
  if (s == null) return "text-muted-foreground"
  if (s >= 85) return "text-green-700"
  if (s >= 70) return "text-amber-700"
  return "text-red-700"
}

export default async function AgentScorecardPage() {
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
  if (!isAdminOrBroker({ user_type: profile.user_type ?? "" })) {
    return <div className="p-6 text-red-600">Forbidden — manager/admin only</div>
  }

  const cards = await generateAgentScorecards({ brokerageId: profile.brokerage_id })

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="h-6 w-6 text-slate-700" /> Agent Scorecard
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Production, deal health, education and recruiting ROI per agent — the signals you manage on, in one view.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{cards.length} agent{cards.length === 1 ? "" : "s"}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {cards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents on the roster yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3">Agent</th>
                  <th className="py-2 pr-3">YTD GCI</th>
                  <th className="py-2 pr-3">Closings</th>
                  <th className="py-2 pr-3">Active deals</th>
                  <th className="py-2 pr-3">Avg deal health</th>
                  <th className="py-2 pr-3">Education</th>
                  <th className="py-2 pr-3">Recruiting ROI</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c, i) => (
                  <tr key={c.agentId} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <Badge className={i === 0 && c.ytdGci > 0 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}>
                        {i === 0 && c.ytdGci > 0 && "★ "}{c.name}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 font-medium">{usd(c.ytdGci)}</td>
                    <td className="py-2 pr-3">{c.closings}</td>
                    <td className="py-2 pr-3">{c.activeDeals}</td>
                    <td className={"py-2 pr-3 font-medium " + healthTone(c.avgHealthScore)}>{c.avgHealthScore ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {c.educationCompletionPct == null ? <span className="text-muted-foreground">—</span>
                        : <span>{c.lessonsCompleted}/{c.lessonsAssigned} ({c.educationCompletionPct}%)</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {c.recruitingRoiPct == null ? <span className="text-muted-foreground">—</span>
                        : <span className={c.recruitingRoiPct >= 0 ? "text-green-700" : "text-red-700"}>{c.recruitingRoiPct}%</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
