import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadCommandCenter } from "@/lib/kernel/command-center"
import { resolveEgressScope, describeScope } from "@/lib/kernel/egress-scope"
import { computeManagerTrust } from "@/lib/kernel/outcome-learning"
import { CommandCenterClient } from "./command-center-client"
import { TrustMeter } from "./trust-meter"

export const metadata = {
  title:       "Agent Command Center | Kernel OS Admin",
  description: "Live managed-agent sessions + the agent-action approval queue across the multi-manager runtime.",
}

/**
 * Agent Command Center — the operator surface over the multi-manager runtime.
 * Auth-gated (admin/broker/superadmin); superadmin sees platform-wide, others
 * are scoped to their brokerage. All data via loadCommandCenter() — no mock data.
 */
export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { view } = await searchParams

  const { data: userData } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const userType    = userData?.user_type ?? "agent"
  const brokerageId = userData?.brokerage_id ?? undefined
  if (!["admin", "broker", "superadmin"].includes(userType)) redirect("/dashboard")

  // Resolve the egress scope so the surface shows the right slice. superadmin = platform-wide (no
  // scope). For everyone else, resolve their office (agents.location_id) + team so a multi-location
  // admin is scoped to their location while broker/broker_admin see all locations.
  let locationId: string | null = null
  let teamId: string | null = null
  if (userType !== "superadmin" && brokerageId) {
    const { data: agentRow } = await supabase
      .from("agents").select("location_id, team_id").eq("user_id", user.id).eq("brokerage_id", brokerageId).maybeSingle()
    locationId = (agentRow as any)?.location_id ?? null
    teamId = (agentRow as any)?.team_id ?? null
  }
  const baseScope = userType !== "superadmin" && brokerageId
    ? resolveEgressScope({ userType, userId: user.id, brokerageId, locationId, teamId })
    : undefined

  // A brokerage-wide viewer may DRILL DOWN to one office/team/agent via ?view=. A narrower viewer
  // (location admin / team lead / agent) cannot widen scope — their base scope caps what they see.
  const canSwitch = !!brokerageId && (!baseScope || baseScope.kind === "brokerage")
  let effectiveScope = baseScope
  let currentView = "all"
  const scopeOptions: import("./scope-switcher").ScopeOption[] = [{ value: "all", label: "Whole brokerage" }]

  if (canSwitch && brokerageId) {
    const [{ data: locs }, { data: teams }, { data: agentsList }] = await Promise.all([
      supabase.from("locations").select("id, name").eq("brokerage_id", brokerageId).order("name").limit(100),
      supabase.from("teams").select("id, name").eq("brokerage_id", brokerageId).order("name").limit(100),
      supabase.from("agents").select("user_id, display_name").eq("brokerage_id", brokerageId).not("user_id", "is", null).order("display_name").limit(200),
    ])
    for (const l of (locs ?? []) as any[]) scopeOptions.push({ value: `location:${l.id}`, label: `Office — ${l.name}` })
    for (const t of (teams ?? []) as any[]) scopeOptions.push({ value: `team:${t.id}`, label: `Team — ${t.name}` })
    for (const a of (agentsList ?? []) as any[]) scopeOptions.push({ value: `agent:${a.user_id}`, label: `Agent — ${a.display_name ?? a.user_id}` })

    // Apply a valid drill-down only if it matches an offered option (prevents scope-escalation via URL).
    if (view && scopeOptions.some((o) => o.value === view)) {
      currentView = view
      const [kind, id] = view.split(":")
      if (kind === "location") effectiveScope = resolveEgressScope({ userType: "admin", userId: user.id, brokerageId, locationId: id })
      else if (kind === "team") effectiveScope = resolveEgressScope({ userType: "team_lead", userId: user.id, brokerageId, teamId: id })
      else if (kind === "agent") effectiveScope = resolveEgressScope({ userType: "agent", userId: id, brokerageId })
    }
  }

  const scopeLabel = effectiveScope
    ? describeScope(effectiveScope)
    : (userType === "superadmin" ? "Platform — all brokerages" : "Your brokerage")

  const data = await loadCommandCenter({
    brokerageId: userType === "superadmin" ? undefined : brokerageId,
    scope: effectiveScope,
    limit:       100,
  })

  // THE TRUST METER — per-manager human-approval rates + the broker's own rejection
  // reasons (outcome learning made visible; brokerage scope only).
  const trust = brokerageId && userType !== "superadmin"
    ? await computeManagerTrust(brokerageId).catch(() => null)
    : null

  return (
    <>
      {trust && <TrustMeter outcomes={trust.outcomes} feedback={trust.feedback} />}
      <CommandCenterClient
        data={data}
        scope={userType === "superadmin" ? "platform" : "brokerage"}
        scopeLabel={scopeLabel}
        canSwitch={canSwitch}
        scopeOptions={scopeOptions}
        currentView={currentView}
      />
    </>
  )
}
