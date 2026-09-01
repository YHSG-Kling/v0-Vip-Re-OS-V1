import { redirect } from "next/navigation"
import Link from "next/link"
import { ChevronLeft, Brain } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { getBrokerageInsights } from "@/app/actions/brokerage-intelligence"
import { IntelligenceMeshClient } from "./intelligence-mesh-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * /dashboard/admin/intelligence-mesh
 *
 * Broker / admin / team_lead surface. Lists open + recently-dismissed +
 * superseded brokerage intelligence insights with one-click adopt.
 */
export default async function IntelligenceMeshPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()

if (!isAdminOrBroker({ user_type: profile?.user_type ?? "" })) redirect("/dashboard")

  // Load all open + recently dismissed for triage
  const [openRes, dismissedRes] = await Promise.all([
    getBrokerageInsights({ status: "open",      limit: 30 }),
    getBrokerageInsights({ status: "dismissed", limit: 15 }),
  ])

  // Hydrate brokerage agent list for the per-insight adopt picker.
  let agents: Array<{ id: string; first_name: string | null; last_name: string | null }> = []
  if (profile?.brokerage_id) {
    const { data: agentRows } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("user_type", "agent")
    agents = (agentRows ?? []) as typeof agents
  }

  // Adoption log — every pattern pushed via adoptInsightAction, with the
  // +30d outcome-tracking columns (baseline/follow-up/lift) when populated.
  let adoptions: Array<Record<string, any>> = []
  if (profile?.brokerage_id) {
    const { data: adoptionRows } = await supabase
      .from("pattern_adoptions")
      .select(`
        id, applied_actions, baseline_metric, followup_metric, observed_lift_pct, followup_at, status, created_at,
        insight:brokerage_intelligence_insights(headline, pattern_key),
        agent:agents!pattern_adoptions_agent_id_fkey(users(first_name, last_name)),
        adopter:users!pattern_adoptions_adopted_by_fkey(first_name, last_name)
      `)
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(50)
    adoptions = (adoptionRows ?? []) as typeof adoptions
  }

  const fmtName = (u: { first_name: string | null; last_name: string | null } | null) =>
    u ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "—" : "—"

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <Link
          href="/dashboard/admin"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Admin
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
          <Brain className="h-4 w-4 text-violet-600" />
          Brokerage Intelligence Mesh
        </span>
      </div>

      <div className="flex-1 overflow-auto p-6 max-w-5xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Patterns mined from your brokerage&apos;s data</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Top-quartile agent behaviors vs. bottom-quartile, with the playbook required to close the gap. Adopt a pattern in one click — every selected agent inherits the winning configuration.
          </p>
        </div>

        <IntelligenceMeshClient
          open={openRes.insights ?? []}
          dismissed={dismissedRes.insights ?? []}
          agents={agents.map((a) => ({
            id: a.id,
            name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Unnamed agent",
          }))}
        />

        {/* Adopted patterns — audit log of every playbook push with observed lift */}
        <div className="space-y-2 pt-2">
          <h2 className="text-base font-semibold">Adopted patterns</h2>
          <p className="text-sm text-muted-foreground">
            Every pattern pushed to an agent, with baseline vs. follow-up metrics once the 30-day outcome check runs.
          </p>
          {adoptions.length === 0 ? (
            <p className="text-sm text-muted-foreground border border-border rounded-lg p-4">
              No patterns adopted yet. Adopt an insight above to start tracking outcomes.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Pattern</th>
                    <th className="px-4 py-2.5 font-medium">Agent</th>
                    <th className="px-4 py-2.5 font-medium">Adopted by</th>
                    <th className="px-4 py-2.5 font-medium text-right">Baseline</th>
                    <th className="px-4 py-2.5 font-medium text-right">Follow-up</th>
                    <th className="px-4 py-2.5 font-medium text-right">Lift</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Adopted</th>
                  </tr>
                </thead>
                <tbody>
                  {adoptions.map((adoption) => (
                    <tr key={adoption.id} className="border-b border-border/50 last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{adoption.insight?.headline ?? adoption.insight?.pattern_key ?? "—"}</span>
                        {Array.isArray(adoption.applied_actions) && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {adoption.applied_actions.length} action{adoption.applied_actions.length !== 1 ? "s" : ""}
                          </span>
                        )}
                      </td>
                      {/* agent_id is agents-class; the name it displays lives one hop away on users. */}
                      <td className="px-4 py-2.5">{fmtName(adoption.agent?.users ?? null)}</td>
                      <td className="px-4 py-2.5">{fmtName(adoption.adopter)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {adoption.baseline_metric != null ? Number(adoption.baseline_metric).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {adoption.followup_metric != null ? Number(adoption.followup_metric).toLocaleString() : "—"}
                      </td>
                      {/* Three honest states: measured (lift), measured-without-baseline
                          (follow-up ran on a legacy adoption that predates baseline
                          stamping — "n/a", never forever-"pending"), and pending (the
                          +30d follow-up in the weekly mine cron has not run yet). */}
                      <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${
                        adoption.observed_lift_pct == null
                          ? "text-muted-foreground"
                          : Number(adoption.observed_lift_pct) >= 0
                            ? "text-emerald-600"
                            : "text-red-600"
                      }`}>
                        {adoption.observed_lift_pct != null
                          ? `${Number(adoption.observed_lift_pct) >= 0 ? "+" : ""}${Number(adoption.observed_lift_pct).toFixed(1)}%`
                          : adoption.followup_at != null
                            ? "n/a"
                            : "pending"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs capitalize ${
                          adoption.status === "applied"
                            ? "bg-emerald-100 text-emerald-700"
                            : adoption.status === "reverted"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-red-100 text-red-700"
                        }`}>
                          {adoption.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {adoption.created_at ? new Date(adoption.created_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
