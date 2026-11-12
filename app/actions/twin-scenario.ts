"use server"

/**
 * app/actions/twin-scenario.ts — THE WHAT-IF SURFACE ON THE TWIN (wave 107, lane 107D).
 * "No production action yet. Simulation first."
 *
 *   · simulateTwinScenario(levers) — the tenant admin's lever change projected through the twin
 *     (lib/kernel/twin-scenario.ts simulateScenario, PURE). The run is persisted as EVIDENCE on
 *     agent_action_ledger (`twin.scenario.simulate`, status 'skipped' / outcome 'simulated_no_action'
 *     — a 'skipped' non-decision row is never attribution-eligible in lib/intelligence/roi-ledger.ts,
 *     so a simulation can never be credited as a touch). Nothing else is written.
 *   · promoteTwinScenarioToMission(levers) — RE-PROJECTS server-side (the client's numbers are never
 *     trusted) and creates a PROPOSED mission (lib/kernel/missions.ts createMission — entitlement +
 *     authority ceiling + ledger there); PROPOSED moves only when a human plans / activates it. The
 *     projection rides the mission as an `evidence` row. Never an action.
 *
 * Tenant from the SESSION (users.brokerage_id); tenant-admin gate (resolveTenantAdmin — the roster in
 * lib/auth/resolve-user-role.ts, never retyped); entitlement (mayUseAndAfford "app.access") fails
 * closed. Every export here is a public endpoint and async (CLAUDE.md §4).
 */
import { createClient } from "@/lib/supabase/server"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import type { ScenarioProjection } from "@/lib/kernel/twin-scenario"

type Gate = { ok: true; userId: string; brokerageId: string } | { ok: false; error: string }

async function requireScenarioCaller(): Promise<Gate> {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: u, error } = await client.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (error) return { ok: false, error: `Could not resolve your profile: ${error.message}` }
  if (!u?.brokerage_id) return { ok: false, error: "Your account is not linked to a brokerage" }
  const admin = await resolveTenantAdmin(client, user.id, { user_type: u.user_type, brokerage_id: u.brokerage_id })
  if (!admin.ok) return { ok: false, error: `Could not verify your role: ${admin.error}` }
  if (!admin.isTenantAdmin) return { ok: false, error: "Forbidden: scenarios are a brokerage admin surface" }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const afford = await mayUseAndAfford({ brokerageId: u.brokerage_id as string, capability: "app.access", client: createServiceClient() as any })
  if (!afford.allowed) return { ok: false, error: `Not entitled: ${afford.reason}` }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id as string }
}

/** Project the levers on THIS tenant's twin (last persisted snapshot, else a fresh read-only build). */
async function project(brokerageId: string, levers: unknown): Promise<{ ok: true; projection: ScenarioProjection } | { ok: false; error: string }> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { readBrokerageTwin } = await import("@/lib/kernel/brokerage-twin")
  const twin = (await readBrokerageTwin(brokerageId, { svc, snapshot: {} })) ?? (await readBrokerageTwin(brokerageId, { svc }))
  if (!twin) return { ok: false, error: "The brokerage twin could not be built — no projection without it" }
  const { simulateScenario, loadScenarioFacts } = await import("@/lib/kernel/twin-scenario")
  const { GENERATION_COST_ESTIMATE_USD, MAX_MEDIA_VARIANTS } = await import("@/lib/kernel/media-intelligence")
  const facts = await loadScenarioFacts(svc, brokerageId)
  return { ok: true, projection: simulateScenario({ brokerageId, levers }, twin, { ...facts, mediaCostUsd: GENERATION_COST_ESTIMATE_USD, mediaVariants: MAX_MEDIA_VARIANTS }) }
}

/** The compact evidence a run leaves (no per-agent rows; the coefficients are the audit). */
function evidenceOf(p: ScenarioProjection, headline: string): Record<string, unknown> {
  return {
    headline, levers: p.levers, twin_at: p.twinAt, twin_digest: p.twinDigest, digest: p.digest,
    opportunity_gain: p.opportunityGain, marketing_cost: p.marketingCost, expected_margin_cents: p.expectedMarginCents,
    staffing_constraint: { first_saturated: p.staffingConstraint.firstSaturated, at_lever_value: p.staffingConstraint.atLeverValue, lever: p.staffingConstraint.lever, saturated_now: p.staffingConstraint.saturatedNow },
    chain: p.chain.map((s) => ({ stage: s.stage, manager: s.manager, utilization: s.utilization, saturated: s.saturated })),
    risks: p.risks, unsupported: p.unsupported,
    coefficients: p.coefficients.map((k) => ({ key: k.key, value: k.value, source: k.source, confidence: k.confidence, manager: k.manager })),
  }
}

export async function simulateTwinScenario(levers: unknown): Promise<{ ok: true; projection: ScenarioProjection; headline: string; evidenceId: string | null; evidenceError: string | null } | { ok: false; error: string }> {
  const gate = await requireScenarioCaller()
  if (!gate.ok) return gate
  const r = await project(gate.brokerageId, levers)
  if (!r.ok) return r
  const { scenarioHeadline } = await import("@/lib/kernel/twin-scenario")
  const headline = scenarioHeadline(r.projection)
  // EVIDENCE (LAW 5) — claimed → "run" (nothing acts) → settled 'skipped'. A replay of the same
  // scenario on the same twin returns the existing row; the projection is recomputed either way.
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const { createServiceClient } = await import("@/lib/supabase/service")
  let evidenceId: string | null = null, evidenceError: string | null = null
  try {
    await withActionLedger<{ id: string | null }>(
      {
        brokerageId: gate.brokerageId, action: "twin.scenario.simulate",
        actor: { type: "user", userId: gate.userId }, subject: { type: "brokerage_twin", id: gate.brokerageId, ref: r.projection.digest },
        idempotencyKey: `twin.scenario:${gate.brokerageId}:${r.projection.digest}`, riskClass: "READ",
        reasonCode: "HUMAN_REQUESTED", systemSource: "twin_scenario", reasonDetail: headline.slice(0, 500),
        detail: evidenceOf(r.projection, headline),
      },
      async () => ({ id: null }),
      { settle: () => ({ status: "skipped", outcome: "simulated_no_action" }), replay: (c) => ({ id: "entry" in c ? (c.entry as { id?: string }).id ?? null : null }) },
      { client: createServiceClient() as any },
    ).then((x) => { evidenceId = x.id })
  } catch (e) { evidenceError = e instanceof Error ? e.message : String(e) }
  return { ok: true, projection: r.projection, headline, evidenceId, evidenceError }
}

export async function promoteTwinScenarioToMission(levers: unknown): Promise<{ ok: true; missionId: string; state: string } | { ok: false; error: string }> {
  const gate = await requireScenarioCaller()
  if (!gate.ok) return gate
  const r = await project(gate.brokerageId, levers)
  if (!r.ok) return r
  const p = r.projection
  if (p.opportunityGain.addedCloses30d <= 0) return { ok: false, error: "This scenario projects no added closes — nothing to promote" }
  const { scenarioHeadline } = await import("@/lib/kernel/twin-scenario")
  const { readTwinMeasure } = await import("@/lib/kernel/brokerage-twin")
  const { createMission, recordMissionEvidence } = await import("@/lib/kernel/missions")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const headline = scenarioHeadline(p)
  const owner = p.chain.find((s) => s.stage === p.staffingConstraint.firstSaturated)?.manager ?? "listing_concierge"
  const participants = [...new Set(p.chain.map((s) => s.manager))].filter((m) => m !== owner)
  // Criterion on a TWIN field so the Command Center's build measures it (syncMissionProgressFromTwin):
  // closed deals in the trailing 90 days at today's reading + three months of the projected lift.
  const { readBrokerageTwin } = await import("@/lib/kernel/brokerage-twin")
  const twin = await readBrokerageTwin(gate.brokerageId, { svc, snapshot: {} })
  const base = twin ? readTwinMeasure(twin, "economic.closedCount90d") : null
  const created = await createMission({
    brokerageId: gate.brokerageId, objective: `What-if: ${headline}`.slice(0, 480), missionType: "custom",
    ownerManager: owner, participatingManagers: participants, initialState: "PROPOSED", priority: "normal",
    successCriteria: base !== null ? [{ metric: "economic.closedCount90d", op: ">=", target: Math.ceil(base + p.opportunityGain.addedCloses30d * 3) }] : [],
    budget: { usd: Math.round(p.marketingCost.totalCents / 100), on_exhausted: "APPROVAL_REQUIRED" },
    createdBy: gate.userId, actor: { type: "user", id: gate.userId },
  }, svc)
  if (!created.ok) return { ok: false, error: created.reason }
  const ev = await recordMissionEvidence({ brokerageId: gate.brokerageId, missionId: created.mission.id, kind: "evidence", reason: "scenario projection (simulation only — no production action)", reasonCode: "HUMAN_REQUESTED", actor: { type: "user", id: gate.userId }, evidence: { kind: "scenario_projection", ...evidenceOf(p, headline) } }, svc)
  if (!ev.ok) console.error(`[twin-scenario] mission ${created.mission.id} created but the projection evidence was refused: ${ev.reason}`)
  return { ok: true, missionId: created.mission.id, state: created.mission.state }
}
