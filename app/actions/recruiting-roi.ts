"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"

/**
 * TENANT FROM THE SESSION (§4). Every export here took `brokerageId` as a PARAMETER
 * and filtered on it. The reads run on the RLS client, so a foreign id could not
 * return foreign rows — but the shape was still wrong in two ways: (1) the write
 * (`addRecruitingCost`) stamped the caller-supplied id onto recruiting_costs and
 * lifecycle_events and then handed it to a SERVICE-client recompute
 * (upsertRecruitingRoi) that bypasses RLS; (2) every caller resolved the tenant from
 * the session and then threw it away into a parameter this file re-trusted — the
 * "passed and never verified" shape scripts/inert-argument-sweep-simulator.ts exists
 * for. The parameter is GONE from all six exports; the tenant is the caller's own
 * users.brokerage_id, and because recruiting ROI is brokerage-wide money (§5:
 * commission and spend are off agent-facing display), the caller must administer
 * that tenant (resolveTenantAdmin — the ONE roster). Refusals THROW, matching how
 * every function here already surfaced a database error; the callers that must
 * degrade already `.catch()`.
 */
/**
 * WAVE 156 (lane 156K, round 2) — WHO MAY READ WHICH FIGURE, from the existing rules (never a copied list):
 *   · the surface: the tenant-admin roster (resolveTenantAdmin — TENANT_ADMIN_USER_TYPES or a pinned grant); anyone else
 *     (agent, vendor, contact, ISA …) is refused;
 *   · the recruiting MONEY (recruiting_roi / recruiting_costs / recruiting_analytics — the brokerage's books): a seat that may
 *     read the books, the same seats public.can_read_brokerage_books() admits — the finance tier (resolveBrokerageFinanceAdmin:
 *     BROKERAGE_FINANCE_ADMIN_USER_TYPES, a pinned grant, or the principal of a team-scale tenant) or the compliance officer,
 *     who reads the books and never keeps them (m467). Writing a cost needs the finance tier itself;
 *   · everyone else the roster admits is a team lead, who sees recruiting STAGE counts for THEIR team (teams.team_lead_id)
 *     and none of the money.
 * Before this, a non-principal team lead passed the roster, the books came back EMPTY by row security, and the page drew
 * zeros — "nobody may read this" rendered as "checked and it is zero" (CLAUDE.md §4). A figure this seat may not read is now
 * reported as not permitted; a figure whose source refused is unknown; only a figure that was read is a number.
 * A role check that could not run refuses the whole surface (fail closed).
 */
type RecruitingBooks = { state: "ok" } | { state: "not_permitted"; reason: string }
async function requireRecruitingCaller(): Promise<{ client: Awaited<ReturnType<typeof createClient>>; userId: string; brokerageId: string; userType: string; books: RecruitingBooks; keepsBooks: boolean }> {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const { data: u, error } = await client
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (error) throw new Error(`Could not resolve your profile: ${error.message}`)
  if (!u?.brokerage_id) throw new Error("Your account is not linked to a brokerage")
  const admin = await resolveTenantAdmin(client, user.id, { user_type: u.user_type, brokerage_id: u.brokerage_id })
  if (!admin.ok) throw new Error(`Could not verify your role: ${admin.error}`)
  if (!admin.isTenantAdmin) throw new Error("Forbidden: recruiting ROI is a brokerage admin surface")
  const { resolveBrokerageFinanceAdmin } = await import("@/lib/auth/resolve-user-role")
  const finance = await resolveBrokerageFinanceAdmin(client, user.id, { user_type: u.user_type, brokerage_id: u.brokerage_id })
  if (!finance.ok) throw new Error(`Could not verify whether your seat reads the brokerage's books: ${finance.error}`)
  const userType = String(u.user_type ?? "").toLowerCase()
  // m467: the compliance officer READS the books (public.can_read_brokerage_books admits the seat) and never keeps them.
  const readsBooks = finance.isFinanceAdmin || userType === "compliance_officer"
  const books: RecruitingBooks = readsBooks ? { state: "ok" }
    : { state: "not_permitted", reason: "Recruiting spend, return and production are the brokerage's books, which your seat does not read — your broker or a finance admin does." }
  return { client, userId: user.id, brokerageId: u.brokerage_id as string, userType, books, keepsBooks: finance.isFinanceAdmin }
}

/** A money export asked by a seat that may not read the books: refused in words (never an empty, zero-shaped answer). */
function requireBooks(c: { books: RecruitingBooks }): void {
  if (c.books.state !== "ok") throw new Error(`NOT_PERMITTED: ${c.books.reason}`)
}

/**
 * WAVE 106 (lane 106E) — THE RECRUITING "NEEDS" BLOCK: the twin's recruiting needs (territory
 * demand ↑ vs capacity vs specialist coverage — lib/kernel/brokerage-twin.ts recruitingNeeds over
 * the last persisted twin) beside the recruiting missions those needs became (held
 * APPROVAL_REQUIRED until a human approves them on the Missions card; ACTIVE = approved and
 * feeding the sourcer's criteria). Tenant from the session; admin roster. A missing twin or a
 * refused missions read is PUBLISHED, never an empty "no needs".
 */
export async function getRecruitingNeeds(): Promise<{
  needs: Array<{ territory: string; specialization: string; count: number; reasons: string[] }>
  missions: Array<{ id: string; objective: string; state: string; territory: string | null; specialization: string | null; createdAt: string }>
  workforceLine: string | null
  twinAt: string | null
  blindSpots: string[]
}> {
  const { brokerageId } = await requireRecruitingCaller()
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { readBrokerageTwin, recruitingNeeds, workforceLine } = await import("@/lib/kernel/brokerage-twin")
  const { activeMissionsFor, recruitingTargetingOf } = await import("@/lib/kernel/missions")
  const svc = createServiceClient() as any
  const blindSpots: string[] = []
  const twin = await readBrokerageTwin(brokerageId, { svc, snapshot: {} })
  if (!twin) blindSpots.push("no brokerage twin persisted in the last 24h — open the Command Center to build one")
  else if (!twin.workforce) blindSpots.push("the last twin predates the workforce section — the next Command Center visit rebuilds it")
  const needs = twin?.workforce ? recruitingNeeds(twin) : []
  const ms = await activeMissionsFor(brokerageId, { ownerManager: "recruiting_manager", limit: 200 }, svc)
  if (ms.readRefused) blindSpots.push(`missions read refused: ${ms.readRefused}`)
  const missions = ms.active.filter((m) => m.mission_type === "recruiting").map((m) => {
    const t = recruitingTargetingOf(m)
    return { id: m.id, objective: m.objective, state: m.state, territory: t?.territory ?? null, specialization: t?.specialization ?? null, createdAt: m.created_at }
  })
  return { needs, missions, workforceLine: workforceLine(twin?.workforce), twinAt: twin?.at ?? null, blindSpots }
}

// TOMBSTONE (wave 106 integration, CLAUDE.md §1.3): `setWorkforceThresholds` was a public "use server"
// endpoint no surface called. The thresholds are a TENANT POLICY KEY (lib/kernel/tenant-policy.ts
// workforce_thresholds) and policy keys change through the ONE path every other key uses — an
// improvement_proposals `policy` proposal promoted on the Manager Trust page
// (lib/kernel/improvement-proposals.ts → appendTenantPolicyVersion → mergeBrokerageSettings).

export async function getRecruitingROISummary() {
  const caller = await requireRecruitingCaller(); requireBooks(caller); const { client, brokerageId } = caller

  // `computed_at` IS THE FRESHNESS OF EVERY NUMBER BELOW. lib/recruiting/recruiting-roi-writer.ts:34
  // stamps it on every recompute and nothing read it, so the recruiting-ROI headline could show a
  // roi_pct computed months ago — after a cost entry whose recompute silently failed (the writer's
  // caller at :247 swallows the error by design) — and present it as today's number. A stale money
  // figure that says nothing about its own age is the money-surface defect (§5).
  const { data: summary, error } = await client
    .from("recruiting_roi")
    .select("total_recruiting_cost, lifetime_brokerage_net, roi_pct, breakeven_month, computed_at")
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  const totalInvested = summary?.reduce((sum, r) => sum + (r.total_recruiting_cost || 0), 0) || 0
  const totalGenerated = summary?.reduce((sum, r) => sum + (r.lifetime_brokerage_net || 0), 0) || 0
  const avgROI = summary?.length ? summary.reduce((sum, r) => sum + (r.roi_pct || 0), 0) / summary.length : 0
  const activeRecruits = summary?.length || 0
  const profitableRecruits = summary?.filter(r => (r.roi_pct || 0) > 0).length || 0

  // NEWEST and OLDEST, not an average: the headline is a SUM across recruits, so it is only
  // as fresh as its stalest row. Both null when no row carries a stamp — never inferred.
  const stamps = (summary ?? [])
    .map((r) => r.computed_at as string | null)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort()

  return {
    totalInvested,
    totalGenerated,
    avgROI,
    activeRecruits,
    profitableRecruits,
    /** recruiting_roi.computed_at — most recent recompute across the tenant's recruits. */
    computedAt: stamps.length > 0 ? stamps[stamps.length - 1] : null,
    /** The STALEST recompute in the sum. A headline is only as current as this. */
    oldestComputedAt: stamps.length > 0 ? stamps[0] : null,
  }
}

export async function getRecruitROIByRecruit() {
  const caller = await requireRecruitingCaller(); requireBooks(caller); const { client, brokerageId } = caller

  const { data: rois, error: roiError } = await client
    .from("recruiting_roi")
    .select(`
      id,
      recruited_agent_id,
      total_recruiting_cost,
      lifetime_brokerage_net,
      roi_pct,
      breakeven_month,
      agents!recruited_agent_id(created_at, is_active, users(first_name, last_name))
    `)
    .eq("brokerage_id", brokerageId)
    .order("roi_pct", { ascending: false })

  if (roiError) throw roiError
  return rois || []
}

export async function getRecruitingCostBreakdown() {
  const caller = await requireRecruitingCaller(); requireBooks(caller); const { client, brokerageId } = caller

  const { data: costs, error } = await client
    .from("recruiting_costs")
    .select("cost_type, amount")
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  const breakdown = {
    training: 0,
    marketing: 0,
    technology: 0,
    bonuses: 0,
    guarantees: 0,
    other: 0,
  }

  costs?.forEach((cost: any) => {
    const type = cost.cost_type?.toLowerCase() || "other"
    if (type in breakdown) {
      breakdown[type as keyof typeof breakdown] += cost.amount || 0
    } else {
      breakdown.other += cost.amount || 0
    }
  })

  return breakdown
}

export async function getBreakEvenAnalysis() {
  const caller = await requireRecruitingCaller(); requireBooks(caller); const { client, brokerageId } = caller

  const { data: rois, error } = await client
    .from("recruiting_roi")
    .select("breakeven_month")
    .eq("brokerage_id", brokerageId)
    .not("breakeven_month", "is", null)

  if (error) throw error

  const breakEvenMonths = (rois || [])
    .map(r => r.breakeven_month)
    .filter(m => typeof m === "number")

  const avgBreakEvenMonth = breakEvenMonths.length
    ? breakEvenMonths.reduce((a, b) => a + b, 0) / breakEvenMonths.length
    : 0

  return {
    avgBreakEvenMonth,
    breakEvenMonths,
  }
}

/**
 * THE TENANT'S AGENTS, FOR THE COST-ENTRY PICKER (built 2026-09-03, lane H4 —
 * orphan doctrine §1.2: the missing half). `addRecruitingCost` takes an
 * `agents.id` and verifies it is one of this tenant's agents, but the only UI
 * that called it (app/dashboard/recruiting-roi/cost-entry-panel.tsx) sent a
 * free-text "Recruit Name" as that id — so the verification refused every
 * submission and no recruiting cost could ever be entered from the page.
 *
 * Same gate as every sibling (requireRecruitingCaller — tenant from the SESSION,
 * caller must administer it). `id` is agents.id — the id the cost row keys on —
 * and the name crosses agents.user_id → users (§3: agents.id and users.id are
 * disjoint; the FK is the only bridge). One FK agents→users (agents_user_id_fkey),
 * so the bare embed is PGRST201-safe.
 */
export async function listRecruitableAgents(): Promise<Array<{ id: string; name: string; isActive: boolean }>> {
  const { client, brokerageId } = await requireRecruitingCaller()

  const { data, error } = await client
    .from("agents")
    .select("id, is_active, users(first_name, last_name, email)")
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  type Row = {
    id: string
    is_active: boolean | null
    users: { first_name: string | null; last_name: string | null; email: string | null } | null
  }
  return ((data ?? []) as unknown as Row[])
    .map((a) => {
      const full = `${a.users?.first_name ?? ""} ${a.users?.last_name ?? ""}`.trim()
      return { id: a.id, name: full || a.users?.email || `Agent ${a.id.slice(0, 8)}`, isActive: a.is_active !== false }
    })
    .sort((x, y) => Number(y.isActive) - Number(x.isActive) || x.name.localeCompare(y.name))
}

export async function getRecruitingAnalyticsByYear(recruitedAgentId: string) {
  const caller = await requireRecruitingCaller(); requireBooks(caller); const { client, brokerageId } = caller

  const { data: analytics, error } = await client
    .from("recruiting_analytics")
    // computed_at: same freshness contract as recruiting_roi above. lib/kernel/manager-signals.ts:459
    // stamps it on every yearly rollup and nothing read it, so the per-recruit revenue chart could
    // not say whether it was drawn from this week's rollup or last quarter's.
    .select("year_number, gross_commission_generated, brokerage_net_from_agent, transaction_count, computed_at")
    .eq("brokerage_id", brokerageId)
    .eq("recruited_agent_id", recruitedAgentId)
    .order("year_number", { ascending: true })

  if (error) throw error
  return analytics || []
}

export async function addRecruitingCost(
  recruitedAgentId: string,
  costType: string,
  amount: number,
  notes?: string
) {
  // `userId` is taken here (and only here) because the kernel event below stamps
  // lifecycle_events.actor_user_id — the "who" the raw insert this replaced never
  // wrote. It comes from the SESSION, resolved by requireRecruitingCaller (§4).
  const caller = await requireRecruitingCaller()
  if (!caller.keepsBooks) throw new Error("NOT_PERMITTED: a recruiting cost is an entry in the brokerage's books — only its finance admins keep them.")
  const { client, brokerageId, userId } = caller

  // The recruit must be one of THIS tenant's agents: the cost row, the kernel event
  // and the service-client recompute below all key on it, so a foreign agents.id
  // would otherwise be stamped into this brokerage's books.
  const { data: recruit, error: recruitError } = await client
    .from("agents")
    .select("id")
    .eq("id", recruitedAgentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (recruitError) throw new Error(`Could not verify the recruit: ${recruitError.message}`)
  if (!recruit) throw new Error("Recruit not found in your brokerage")

  const { data, error } = await client
    .from("recruiting_costs")
    .insert({
      brokerage_id: brokerageId,
      recruited_agent_id: recruitedAgentId,
      cost_type: costType,
      amount,
      incurred_date: new Date().toISOString(),
      notes,
    })
    .select()

  if (error) throw error

  // THE KERNEL EVENT, THROUGH THE ONE EMITTER (lib/kernel/emit.ts).
  //
  // This was a raw `.from("lifecycle_events").insert(...)`. The row landed and
  // nothing downstream ever heard it: emitKernelEvent does BOTH halves — the
  // audit insert AND the reactor fan-out (staff notifications, campaign
  // enrollment, portal cards, every handler) — and a direct insert is exactly the
  // "audit row that reaches no notification rule and no handler" the owner's
  // ruling bans. It also silently dropped the WHO: actor_user_id was never
  // written, so a spend entry on the brokerage's books named nobody.
  //
  // HONEST ABOUT WHAT THIS BUYS TODAY: "RECRUITING_COST_ADDED" is a FREE-FORM
  // string, not a KernelEvent value (lib/kernel/events.ts has
  // RECRUITING_ROI_CALCULATED and RECRUITING_TERRITORY_SCORED, not this), so
  // emit's fan-out gate persists it and stops there — audit-only, deliberately.
  // The gain is the canonical path, the actor, and the dedupe column; the day
  // this event earns a handler it fans out with no further change here.
  //
  // The row id is the entity, so a write that returned none has no event to
  // emit — a lifecycle row pointing at nothing is worse than no row. §3: the
  // insert's own refusal already threw above; this guards the empty-return case.
  const costId = (data?.[0] as { id?: string } | null | undefined)?.id
  if (costId) {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const emitted = await emitKernelEvent({
      event: "RECRUITING_COST_ADDED",
      brokerageId,
      entityType: "recruiting_cost",
      entityId: costId,
      actorUserId: userId,
      source: "ui",
      metadata: {
        recruited_agent_id: recruitedAgentId,
        cost_type: costType,
        amount,
      },
    })
    // emitKernelEvent never throws; it RETURNS the refusal. Swallowing that would
    // put us back where the raw insert was — a write nobody knows failed.
    if (emitted.error) {
      console.error("[recruiting-roi] RECRUITING_COST_ADDED emit failed:", emitted.error)
    }
  }

  // Recompute the recruited agent's ROI now that spend changed — keeps the recruiting_roi row (and the
  // dashboard's headline KPIs) live. Best-effort; a recompute hiccup never blocks the cost entry.
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { upsertRecruitingRoi } = await import("@/lib/recruiting/recruiting-roi-writer")
    await upsertRecruitingRoi(createServiceClient(), { brokerageId, recruitedAgentId })
  } catch (e) {
    console.error("[recruiting-roi] recompute after cost entry failed:", e)
  }

  return data?.[0]
}

/**
 * WAVE 156 (lane 156K, round 2) — WHAT THIS SEAT MAY READ on the recruiting surface, so the page can say it in words before it
 * asks for a figure: the money (the books) is "ok" or "not_permitted" with the reason, and the funnel's scope is the whole
 * tenant (a seat that reads the books) or the team(s) the caller leads (teams.team_lead_id). Same gate as every sibling.
 */
export async function getRecruitingAccess(): Promise<{ money: RecruitingBooks; funnelScope: "tenant" | "team"; keepsBooks: boolean }> {
  const caller = await requireRecruitingCaller()
  return { money: caller.books, funnelScope: caller.books.state === "ok" ? "tenant" : "team", keepsBooks: caller.keepsBooks }
}

/**
 * WAVE 156 (lane 156K) — THE RECRUITING FUNNEL on the recruiting ROI surface, from persisted events only
 * (lib/recruiting/recruiting-roi-compute.ts computeRecruitingFunnel holds the stage rules). Same gate as every sibling
 * (requireRecruitingCaller: tenant from the SESSION, the tenant-admin roster); then the service client, every read pinned to
 * that tenant and every read's error READ.
 * ROUND 2 — scope and permission per figure: a seat that reads the books sees the whole tenant, production included; any other
 * seat the roster admits is a team lead and sees the recruits of the team(s) they lead (teams.team_lead_id — a recruit referred
 * by one of the team's agents, or provisioned onto the team), with production NOT PERMITTED (it is read from the books). A
 * refused read makes its stages UNKNOWN; a team read that refuses refuses the funnel (the scope could not be established, so no
 * count may be shown for it).
 */
export async function getRecruitingFunnel(): Promise<{
  stages: Array<{ key: string; label: string; count: number | null; state: "ok" | "unknown" | "not_permitted" }>
  declined: number
  scope: "tenant" | "team"
  teamCount: number | null
  blindSpots: string[]
}> {
  const caller = await requireRecruitingCaller()
  const { userId, brokerageId } = caller
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { computeRecruitingFunnel } = await import("@/lib/recruiting/recruiting-roi-compute")
  const svc = createServiceClient() as any
  const blindSpots: string[] = []
  const readsBooks = caller.books.state === "ok"

  // The team scope (teams.team_lead_id, this tenant only) for a seat that does not read the books.
  let team: { agentIds: Set<string>; userIds: Set<string>; teams: number } | null = null
  if (!readsBooks) {
    const { data: teams, error: teamErr } = await svc.from("teams").select("id").eq("brokerage_id", brokerageId).eq("team_lead_id", userId).is("deleted_at", null)
    if (teamErr) throw new Error(`Could not establish the team you lead, so no recruiting figure is shown: ${teamErr.message}`)
    const teamIds = ((teams ?? []) as Array<{ id: string }>).map((t) => t.id)
    team = { agentIds: new Set(), userIds: new Set(), teams: teamIds.length }
    if (teamIds.length > 0) {
      const { data: members, error: memErr } = await svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).in("team_id", teamIds)
      if (memErr) throw new Error(`Could not read your team's members, so no recruiting figure is shown: ${memErr.message}`)
      for (const a of (members ?? []) as Array<{ id: string; user_id: string | null }>) { team.agentIds.add(a.id); if (a.user_id) team.userIds.add(a.user_id) }
    } else {
      blindSpots.push("you lead no team in this workspace, so there are no team recruits to count")
    }
  }

  const { data: recruitRows, error: recErr } = await svc.from("recruits")
    .select("id, status, provisioned, provisioned_user_id, recruiter_agent_id").eq("brokerage_id", brokerageId).limit(5000)
  if (recErr) throw new Error(`Could not read the recruiting pipeline: ${recErr.message}`)
  type RecruitRow = { id: string; status: string | null; provisioned: boolean | null; provisioned_user_id: string | null; recruiter_agent_id: string | null }
  const recruits = ((recruitRows ?? []) as RecruitRow[]).filter((r) => !team
    || (!!r.recruiter_agent_id && team.agentIds.has(r.recruiter_agent_id))
    || (!!r.provisioned_user_id && team.userIds.has(r.provisioned_user_id)))

  let recordedMoves: Record<string, string[]> | null = {}
  const { data: moves, error: movesErr } = await svc.from("agent_action_ledger")
    .select("subject_id, detail").eq("brokerage_id", brokerageId).eq("action", "recruiting.recruit.advance_stage").eq("status", "executed").limit(20000)
  if (movesErr) { recordedMoves = null; blindSpots.push(`recorded stage moves unreadable (${movesErr.message})`) }
  else for (const m of (moves ?? []) as Array<{ subject_id: string | null; detail: { to?: unknown } | null }>) {
    if (!m.subject_id || typeof m.detail?.to !== "string") continue
    ;(recordedMoves[m.subject_id] ??= []).push(m.detail.to)
  }

  let approvedOutreach: string[] | null = []
  const { data: msgs, error: msgErr } = await svc.from("agent_client_messages")
    .select("entity_id").eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "recruit").in("status", ["approved", "sent"]).limit(20000)
  if (msgErr) { approvedOutreach = null; blindSpots.push(`recruiting outreach unreadable (${msgErr.message})`) }
  else approvedOutreach = ((msgs ?? []) as Array<{ entity_id: string | null }>).map((m) => m.entity_id).filter((x): x is string => !!x)

  const seatUserIds = recruits.filter((r) => r.provisioned && r.provisioned_user_id).map((r) => r.provisioned_user_id as string)
  let seats: Record<string, { active: boolean | null; certified: boolean | null; producing: boolean | null }> | null = {}
  if (seatUserIds.length > 0) {
    const { data: agentRows, error: agErr } = await svc.from("agents").select("id, user_id, is_active").eq("brokerage_id", brokerageId).in("user_id", seatUserIds)
    if (agErr) { seats = null; blindSpots.push(`recruited seats unreadable (${agErr.message})`) }
    else {
      const agents = (agentRows ?? []) as Array<{ id: string; user_id: string; is_active: boolean | null }>
      const agentIds = agents.map((a) => a.id)
      const certified = new Set<string>(), producing = new Set<string>()
      let certOk = true, prodOk = readsBooks
      if (agentIds.length > 0) {
        const { data: certs, error: certErr } = await svc.from("agent_certifications").select("agent_id").eq("brokerage_id", brokerageId).in("agent_id", agentIds)
        if (certErr) { certOk = false; blindSpots.push(`certifications unreadable (${certErr.message})`) }
        else for (const c of (certs ?? []) as Array<{ agent_id: string }>) certified.add(c.agent_id)
        if (readsBooks) {
          const { data: prod, error: prodErr } = await svc.from("recruiting_analytics").select("recruited_agent_id, transaction_count").eq("brokerage_id", brokerageId).in("recruited_agent_id", agentIds)
          if (prodErr) { prodOk = false; blindSpots.push(`production unreadable (${prodErr.message})`) }
          else for (const p of (prod ?? []) as Array<{ recruited_agent_id: string; transaction_count: number | null }>) if (Number(p.transaction_count ?? 0) > 0) producing.add(p.recruited_agent_id)
        }
      }
      for (const uid of seatUserIds) {
        const a = agents.find((x) => x.user_id === uid)
        seats[uid] = { active: a ? a.is_active !== false : false, certified: certOk ? (a ? certified.has(a.id) : false) : null, producing: prodOk ? (a ? producing.has(a.id) : false) : null }
      }
    }
  }
  const out = computeRecruitingFunnel({ recruits, recordedMoves, approvedOutreach, seats, notPermitted: readsBooks ? [] : ["producing"] })
  return { stages: out.stages, declined: out.declined, scope: team ? "team" : "tenant", teamCount: team ? team.teams : null, blindSpots }
}
