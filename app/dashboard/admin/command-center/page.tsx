import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { loadCommandCenter } from "@/lib/kernel/command-center"
import { resolveEgressScope, describeScope } from "@/lib/kernel/egress-scope"
import { computeManagerTrust } from "@/lib/kernel/outcome-learning"
import { loadDealPlayLift } from "@/lib/kernel/deal-play-outcomes"
import { createServiceClient } from "@/lib/supabase/service"
import { CommandCenterClient } from "./command-center-client"
import { TrustMeter } from "./trust-meter"
import { EarnedAutonomyPanel } from "./earned-autonomy-panel"
import { QuarterlyReviewCard } from "./quarterly-review-card"
import { ActingAsLog } from "./acting-as-log"
import { CoverageCard } from "./coverage-card"
import { listEarnedAutonomyAction } from "@/app/actions/document-kernel-review"
import { getQuarterlyReviewAction } from "@/app/actions/quarterly-review"

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
  // TIER PARITY (owner rule): the Command Center — the feed, the Trust Meter,
  // Earned Autonomy — is for the tenancy's PRINCIPAL, whatever shape the
  // tenancy has. A solo agent IS their own broker; a team lead governs a team
  // signup. Only brokerage/multi_location tiers require the broker/admin seat.
  let mayEnter = ["admin", "broker", "superadmin"].includes(userType)
  if (!mayEnter && brokerageId) {
    const svcGate = createServiceClient()
    const { data: brk } = await svcGate.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
    const tier = String((brk as any)?.plan_tier ?? "solo_agent")
    if (tier === "solo_agent") mayEnter = true
    else if (tier === "team") {
      const { data: myAgent } = await svcGate.from("agents").select("id").eq("user_id", user.id).eq("brokerage_id", brokerageId).maybeSingle()
      if (myAgent) {
        const { data: lead } = await svcGate.from("teams").select("id")
          .eq("brokerage_id", brokerageId).eq("team_lead_id", (myAgent as any).id)
          .is("deleted_at", null).limit(1).maybeSingle()
        if (lead) mayEnter = true
      }
    }
  }
  if (!mayEnter) redirect("/dashboard")

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
      supabase.from("agents").select("user_id, users(first_name, last_name)").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(200),
    ])
    for (const l of (locs ?? []) as any[]) scopeOptions.push({ value: `location:${l.id}`, label: `Office — ${l.name}` })
    for (const t of (teams ?? []) as any[]) scopeOptions.push({ value: `team:${t.id}`, label: `Team — ${t.name}` })
    for (const a of (agentsList ?? []) as any[]) {
      const displayName = [(a.users as any)?.first_name, (a.users as any)?.last_name].filter(Boolean).join(" ")
      scopeOptions.push({ value: `agent:${a.user_id}`, label: `Agent — ${displayName || a.user_id}` })
    }

    // Apply a valid drill-down only if it matches an offered option (prevents scope-escalation via URL).
    if (view && scopeOptions.some((o) => o.value === view)) {
      currentView = view
      const [kind, id] = view.split(":")
      if (kind === "location") effectiveScope = resolveEgressScope({ userType: "admin", userId: user.id, brokerageId, locationId: id })
      else if (kind === "team") effectiveScope = resolveEgressScope({ userType: "team_lead", userId: user.id, brokerageId, teamId: id })
      else if (kind === "agent") effectiveScope = resolveEgressScope({ userType: "agent", userId: id, brokerageId })

      // ACTING-AS AUDIT (concierge §1.2) — a principal assuming a
      // subordinate's view is legitimate (troubleshooting, coaching) but
      // NEVER silent: every assumed view lands on the ledger. Best-effort.
      if (kind === "agent" || kind === "team") {
        await createServiceClient().from("lifecycle_events").insert({
          brokerage_id: brokerageId,
          entity_type: kind,
          entity_id: id,
          event_type: "acting_as_view",
          actor_user_id: user.id,
          metadata: { surface: "command_center", viewer_role: userType },
        }).then(() => {}, () => {})
      }
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

  // DEAL PLAY LIFT — did the AI-team play move listings? Honest by construction:
  // "still learning" until both cohorts clear the sample gate (never a thin-data claim).
  const lift = brokerageId && userType !== "superadmin"
    ? await loadDealPlayLift(createServiceClient(), brokerageId).catch(() => null)
    : null

  // EARNED AUTONOMY — the grant ledger beside the Trust Meter (broker/admin
  // only; the action enforces the role — a non-granting viewer sees nothing).
  const earned = brokerageId && userType !== "superadmin"
    ? await listEarnedAutonomyAction().catch(() => null)
    : null

  // QUARTERLY BUSINESS REVIEW + adoption pulse — the principal's 90-day read
  // (the action enforces tier-parity principal access; others see nothing).
  const qbr = brokerageId && userType !== "superadmin"
    ? await getQuarterlyReviewAction().catch(() => null)
    : null

  // COVERAGE MODE — who's away, who covers, until when (principal surface).
  let coverageAgents: import("./coverage-card").CoverageAgentOption[] = []
  let activeCoverages: import("./coverage-card").ActiveCoverage[] = []
  if (qbr?.ok && brokerageId) {
    try {
      const svc = createServiceClient()
      const { data: ags } = await svc.from("agents")
        .select("id, user_id, covering_agent_id, coverage_until")
        .eq("brokerage_id", brokerageId).eq("is_active", true).limit(100)
      const userIds = ((ags ?? []) as any[]).map((a) => a.user_id).filter(Boolean)
      const { data: us } = userIds.length > 0
        ? await svc.from("users").select("id, first_name, last_name").in("id", userIds)
        : { data: [] }
      const nameByUser = new Map(((us ?? []) as any[]).map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || "Agent"]))
      const nameByAgent = new Map(((ags ?? []) as any[]).map((a) => [a.id, (a.user_id && nameByUser.get(a.user_id)) || "Agent"]))
      coverageAgents = ((ags ?? []) as any[]).map((a) => ({ agentId: a.id, name: nameByAgent.get(a.id) ?? "Agent" }))
      activeCoverages = ((ags ?? []) as any[])
        .filter((a) => a.covering_agent_id && a.coverage_until && new Date(a.coverage_until).getTime() > Date.now())
        .map((a) => ({ awayAgentId: a.id, awayName: nameByAgent.get(a.id) ?? "Agent", coveringName: nameByAgent.get(a.covering_agent_id) ?? "Agent", until: a.coverage_until }))
    } catch { /* coverage panel is additive */ }
  }

  // ACTING-AS LOG — the assumed-view audit trail made visible (last 14d).
  let actingAsRows: import("./acting-as-log").ActingAsRow[] = []
  if (qbr?.ok && brokerageId) {
    try {
      const svc = createServiceClient()
      const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString()
      const { data: views } = await svc.from("lifecycle_events")
        .select("actor_user_id, entity_type, entity_id, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("event_type", "acting_as_view")
        .gte("created_at", since14)
        .order("created_at", { ascending: false })
        .limit(10)
      const ids = Array.from(new Set(((views ?? []) as any[]).flatMap((v) => [v.actor_user_id, v.entity_type === "agent" ? v.entity_id : null]).filter(Boolean)))
      const { data: names } = ids.length > 0
        ? await svc.from("users").select("id, first_name, last_name").in("id", ids)
        : { data: [] }
      const nameById = new Map(((names ?? []) as any[]).map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || "Member"]))
      actingAsRows = ((views ?? []) as any[]).map((v) => ({
        actorName: nameById.get(v.actor_user_id) ?? "A principal",
        targetLabel: v.entity_type === "agent" ? (nameById.get(v.entity_id) ?? "an agent") : `team ${String(v.entity_id).slice(0, 8)}`,
        at: v.created_at,
      }))
    } catch { /* visibility is additive */ }
  }

  return (
    <>
      {trust && <TrustMeter outcomes={trust.outcomes} feedback={trust.feedback} />}
      {earned?.ok && earned.grants && (
        <div className="mx-6 mt-4">
          <EarnedAutonomyPanel grants={earned.grants} />
        </div>
      )}
      {qbr?.ok && (
        <div className="mx-6 mt-4">
          <QuarterlyReviewCard review={qbr.review} pulse={qbr.pulse} />
        </div>
      )}
      {qbr?.ok && (
        <div className="mx-6 mt-4 grid gap-4 lg:grid-cols-2">
          <ActingAsLog rows={actingAsRows} />
          <CoverageCard agents={coverageAgents} active={activeCoverages} />
        </div>
      )}
      {lift && (lift.playedTotal > 0 || lift.verdict !== "insufficient") && (
        <div className={"mx-6 mt-4 rounded-lg border p-3 text-sm " + (lift.verdict === "lift" ? "border-emerald-200 bg-emerald-50/50" : "bg-muted/20")}>
          <span className="font-semibold">
            {lift.verdict === "lift" ? "📈 Deal Play lift" : lift.verdict === "no_lift" ? "Deal Play — no clear lift yet" : "Deal Play — still learning"}
          </span>
          <span className="text-muted-foreground"> · {lift.why}</span>
        </div>
      )}
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
