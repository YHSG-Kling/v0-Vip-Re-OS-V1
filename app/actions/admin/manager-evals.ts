"use server"

/**
 * app/actions/admin/manager-evals.ts
 *
 * The Manager Trust Scorecard. Anthropic Managed Agents grade every outcome-graded
 * session against a rubric; results land in agent_outcome_evaluations (written by
 * app/api/webhooks/anthropic-agent). That data was queryable via an admin API but
 * had ZERO UI — so the brokerage could never SEE how well its AI managers are
 * performing. This aggregates it per manager into a trust tier + recommended
 * autonomy posture: the certifiable-governance surface no competitor has.
 *
 * Read-only over existing tables (no migration). Admin-gated, brokerage-scoped
 * (platform staff see all brokerages).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { isPlatformStaffIdentity, isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { revalidatePath } from "next/cache"
import {
  scoreEvals, teamTrust, effectiveAutonomy, isAutonomyPosture,
  type ManagerEvalScore, type AutonomyPosture,
} from "@/lib/managers/eval-scoring"
import {
  scoreStrategyOutcomes, scoreMarketingOutcomes, effectivenessBand,
  type EffectivenessBand,
} from "@/lib/managers/outcome-attribution"

export interface ManagerTrustRow {
  agentKind: string
  label: string
  domain: string
  accent: string
  score: ManagerEvalScore
  sessionCount: number
  lastEvaluatedAt: string | null
  tokensIn: number
  tokensOut: number
  /** Broker-set policy override stored on managed_agents.config (null = follow recommendation). */
  overrideAutonomy: AutonomyPosture | null
  /** What the manager actually operates under = override ?? recommended. */
  effectiveAutonomy: AutonomyPosture
  /** Whether this manager has an instantiated managed_agents row (override is settable only then). */
  isActive: boolean
  /** RETIRED — this kind has NO live row and at least one archived one, i.e. a
   *  broker retired it (managed_agents.archived_at). A retired manager is shown
   *  and labelled rather than hidden: a governance board that silently drops a
   *  manager is how a retirement goes unnoticed. */
  isRetired: boolean
  /** When the most recent retirement happened (null unless isRetired). */
  retiredAt: string | null
  /** CLOSED LEARNING LOOP — 0–100 real-world decision effectiveness (outcomes attributed
   *  back to this manager's decisions), sitting alongside the rubric pass-rate. */
  outcomeEffectiveness: number
  outcomeSample: number
  outcomeBand: EffectivenessBand
}

export interface ManagerTrustScorecard {
  ok: true
  managers: ManagerTrustRow[]
  team: { passRate: number; total: number; trustedCount: number; managerCount: number }
}

export async function getManagerTrustScorecard(): Promise<
  ManagerTrustScorecard | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }

  const svc = createServiceClient()
  // Platform staff see all brokerages; everyone else is scoped to their own.
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  const { data: profile } = user
    ? await svc.from("users").select("platform_role").eq("id", user.id).maybeSingle()
    : { data: null }
  const isPlatform = isPlatformStaffIdentity(ctx.userType, profile?.platform_role)
  if (!isPlatform && !ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  // 1) All graded outcomes (brokerage-scoped).
  let evalQ = svc
    .from("agent_outcome_evaluations")
    .select("managed_agent_session_id, result, input_tokens, output_tokens, evaluated_at")
    .order("evaluated_at", { ascending: false })
    .limit(5000)
  if (!isPlatform) evalQ = evalQ.eq("brokerage_id", ctx.brokerageId as string)
  const { data: evals, error } = await evalQ
  if (error) return { ok: false, error: error.message }

  // 2) session → managed_agent, and managed_agent → agent_kind.
  const sessionIds = Array.from(new Set((evals ?? []).map((e) => e.managed_agent_session_id as string).filter(Boolean)))
  const sessionToAgent = new Map<string, string>()
  if (sessionIds.length > 0) {
    const { data: sessions } = await svc.from("managed_agent_sessions").select("id, managed_agent_id").in("id", sessionIds)
    for (const s of sessions ?? []) sessionToAgent.set(s.id as string, s.managed_agent_id as string)
  }
  const agentIds = Array.from(new Set(Array.from(sessionToAgent.values()).filter(Boolean)))
  const agentToKind = new Map<string, string>()
  if (agentIds.length > 0) {
    const { data: agents } = await svc.from("managed_agents").select("id, agent_kind").in("id", agentIds)
    for (const a of agents ?? []) agentToKind.set(a.id as string, a.agent_kind as string)
  }

  // 3) Bucket evals by agent_kind.
  interface Bucket { evals: Array<{ result: string }>; sessions: Set<string>; lastAt: string | null; tokensIn: number; tokensOut: number }
  const buckets = new Map<string, Bucket>()
  for (const e of evals ?? []) {
    const sid = e.managed_agent_session_id as string
    const kind = agentToKind.get(sessionToAgent.get(sid) ?? "") ?? null
    if (!kind) continue
    const b = buckets.get(kind) ?? { evals: [], sessions: new Set(), lastAt: null, tokensIn: 0, tokensOut: 0 }
    b.evals.push({ result: e.result as string })
    b.sessions.add(sid)
    const at = e.evaluated_at as string | null
    if (at && (!b.lastAt || at > b.lastAt)) b.lastAt = at
    b.tokensIn += (e.input_tokens as number | null) ?? 0
    b.tokensOut += (e.output_tokens as number | null) ?? 0
    buckets.set(kind, b)
  }

  // 3b) Per-kind autonomy override (broker policy of record) from managed_agents.config.
  //     Fetch ALL of the brokerage's managed agents so overrides show even for kinds with no evals.
  let agentRowQ = svc.from("managed_agents").select("id, agent_kind, config").is("archived_at", null)
  if (!isPlatform) agentRowQ = agentRowQ.eq("brokerage_id", ctx.brokerageId as string)
  const { data: agentRows } = await agentRowQ
  // RETIRED KINDS — a SEPARATE read, deliberately. The `.is("archived_at", null)`
  // filter above keeps its exact meaning (live rows, and only those, decide the
  // override and the active flag); this one only answers "was this kind retired?"
  // so the board can SAY SO instead of rendering a retired manager as one that
  // was never instantiated. §3: the error is read, and an unreadable answer
  // degrades to "not retired" on the board rather than taking the scorecard down.
  let archivedQ = svc.from("managed_agents").select("agent_kind, archived_at").not("archived_at", "is", null)
  if (!isPlatform) archivedQ = archivedQ.eq("brokerage_id", ctx.brokerageId as string)
  const { data: archivedRows, error: archivedErr } = await archivedQ
  if (archivedErr) console.error("[manager-evals] archived managed_agents read refused:", archivedErr.message)
  const retiredAtByKind = new Map<string, string>()
  for (const a of archivedRows ?? []) {
    const kind = a.agent_kind as string
    const at = a.archived_at as string
    const prev = retiredAtByKind.get(kind)
    if (!prev || at > prev) retiredAtByKind.set(kind, at)
  }
  const overrideByKind = new Map<string, AutonomyPosture | null>()
  const activeKinds = new Set<string>()
  for (const a of agentRows ?? []) {
    const kind = a.agent_kind as string
    activeKinds.add(kind)
    const cfg = (a.config ?? {}) as Record<string, unknown>
    const ov = cfg.autonomy_tier
    if (isAutonomyPosture(ov)) overrideByKind.set(kind, ov)
  }

  // 3c) CLOSED LEARNING LOOP — attribute REAL business outcomes back to the manager
  //     whose decision produced them (effectiveness alongside the rubric pass-rate).
  const effByKind = new Map<string, { effectiveness: number; sample: number }>()
  // Shopping Agent: offer-strategy recommendations → strategy_outcomes (accepted/countered/…).
  let soQ = svc.from("strategy_outcomes").select("outcome, deviation_from_recommendation").limit(5000)
  if (!isPlatform) soQ = soQ.eq("brokerage_id", ctx.brokerageId as string)
  const { data: strategyRows } = await soQ
  if ((strategyRows ?? []).length > 0) {
    const s = scoreStrategyOutcomes((strategyRows ?? []) as never[])
    effByKind.set("shopping_agent", { effectiveness: s.effectiveness, sample: s.total })
  }
  // Marketing/Campaign managers: weekly outcomes (plan quality + realized engagement) → by session→kind.
  let moQ = svc.from("marketing_agent_weekly_outcomes")
    .select("spawned_session_id, plan_quality_score, realized_open_rate, realized_click_rate").limit(5000)
  if (!isPlatform) moQ = moQ.eq("brokerage_id", ctx.brokerageId as string)
  const { data: mktRows } = await moQ
  if ((mktRows ?? []).length > 0) {
    const mktSessionIds = Array.from(new Set((mktRows ?? []).map((r) => r.spawned_session_id as string).filter(Boolean)))
    const mktSessionToAgent = new Map<string, string>()
    if (mktSessionIds.length > 0) {
      const { data: ms } = await svc.from("managed_agent_sessions").select("id, managed_agent_id").in("id", mktSessionIds)
      for (const s of ms ?? []) mktSessionToAgent.set(s.id as string, s.managed_agent_id as string)
    }
    const byKind = new Map<string, typeof mktRows>()
    for (const r of mktRows ?? []) {
      const kind = agentToKind.get(mktSessionToAgent.get(r.spawned_session_id as string) ?? "")
        ?? (await (async () => {
          const aid = mktSessionToAgent.get(r.spawned_session_id as string)
          if (!aid) return null
          const { data } = await svc.from("managed_agents").select("agent_kind").eq("id", aid).maybeSingle()
          return (data?.agent_kind as string | null) ?? null
        })())
      if (!kind) continue
      const arr = byKind.get(kind) ?? []
      arr.push(r); byKind.set(kind, arr)
    }
    for (const [kind, rows] of byKind) {
      const m = scoreMarketingOutcomes((rows ?? []) as never[])
      effByKind.set(kind, { effectiveness: m.effectiveness, sample: m.weeks })
    }
  }

  // 4) Render the FULL team (every registered manager), even those with no evals yet.
  const managers: ManagerTrustRow[] = (Object.keys(MANAGERS) as ManagerKey[])
    .map((kind) => {
      const info = MANAGERS[kind]
      const b = buckets.get(kind)
      const score = scoreEvals(b?.evals ?? [])
      const override = overrideByKind.get(kind) ?? null
      const eff = effByKind.get(kind) ?? { effectiveness: 0, sample: 0 }
      return {
        agentKind: kind,
        outcomeEffectiveness: eff.effectiveness,
        outcomeSample: eff.sample,
        outcomeBand: effectivenessBand(eff.effectiveness, eff.sample),
        label: info.label,
        domain: info.domain,
        accent: info.accent,
        score,
        sessionCount: b?.sessions.size ?? 0,
        lastEvaluatedAt: b?.lastAt ?? null,
        tokensIn: b?.tokensIn ?? 0,
        tokensOut: b?.tokensOut ?? 0,
        overrideAutonomy: override,
        effectiveAutonomy: effectiveAutonomy(score.autonomy, override),
        isActive: activeKinds.has(kind),
        // Retired = archived AND not live. A kind that was retired and later
        // respawned has a live row again and is simply active.
        isRetired: !activeKinds.has(kind) && retiredAtByKind.has(kind),
        retiredAt: (!activeKinds.has(kind) && retiredAtByKind.get(kind)) || null,
      }
    })
    .sort((a, b) => b.score.total - a.score.total || a.label.localeCompare(b.label))

  // CLOSED LOOP → ENFORCEMENT: persist each manager's eval-derived posture onto its
  // managed_agents.config so the dispatch autonomy gate can enforce it even with no broker
  // override (the override still wins). Best-effort, change-only; never blocks the read.
  const postureByKind = new Map(managers.map((m) => [m.agentKind, m.score.autonomy]))
  await Promise.all((agentRows ?? []).map(async (a) => {
    const recommended = postureByKind.get(a.agent_kind as string)
    if (!recommended) return
    const cfg = (a.config ?? {}) as Record<string, unknown>
    if (cfg.autonomy_recommended === recommended) return
    try {
      await svc.from("managed_agents")
        .update({ config: { ...cfg, autonomy_recommended: recommended, autonomy_recommended_at: new Date().toISOString() } })
        .eq("id", a.id as string)
    } catch { /* best-effort — the scorecard read must not fail on a cache write */ }
  }))

  const team = teamTrust(managers.map((m) => m.score))
  return { ok: true, managers, team: { ...team, managerCount: managers.length } }
}

/**
 * SINGLE-SESSION DETAIL for the Command Center's session drawer — the door onto
 * lib/kernel/command-center.ts:loadManagerSessionDetail (merged from the retired
 * /api/admin/agents/sessions ?session_id= mode, §1.1 lane N3b 2026-09-01).
 *
 * Gate first (same shape as getManagerTrustScorecard above): admin/broker role,
 * then the platform/tenant split. Platform staff — resolved from BOTH identity
 * columns via isPlatformStaffIdentity — read cross-tenant through the explicit
 * platformScope machinery (lib/kernel/tenant-scope.ts); everyone else is pinned
 * to their session brokerage, and a session outside it reads as "not found".
 * A caller with neither authority nor a tenant refuses (§4 fail closed).
 */
export async function getManagerSessionDetail(sessionId: string): Promise<
  | { ok: true; detail: import("@/lib/kernel/command-center").ManagerSessionDetail }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
  if (!sessionId?.trim()) return { ok: false, error: "Missing session id" }

  const svc = createServiceClient()
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  const { data: profile } = user
    ? await svc.from("users").select("platform_role").eq("id", user.id).maybeSingle()
    : { data: null }
  const isPlatform = isPlatformStaffIdentity(ctx.userType, profile?.platform_role)
  if (!isPlatform && !ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  const { loadManagerSessionDetail } = await import("@/lib/kernel/command-center")
  const { isTenantScopeRefusal } = await import("@/lib/kernel/tenant-scope")
  try {
    return await loadManagerSessionDetail({
      sessionId,
      ...(isPlatform
        ? { platform: { reason: "platform staff (platform_role) — cross-tenant manager-session drill-down" } }
        : { brokerageId: ctx.brokerageId as string }),
    })
  } catch (e) {
    if (isTenantScopeRefusal(e)) {
      return { ok: false, error: "This session could not be scoped to a tenant — nothing is shown." }
    }
    throw e
  }
}

/**
 * Broker governance: set (or clear) a manager's autonomy posture override. Persisted
 * on managed_agents.config.autonomy_tier for every instantiated agent of that kind in
 * the brokerage — the policy of record an enforcement layer gates on. Pass null to
 * clear the override (manager reverts to its eval-derived recommendation).
 */
export async function setManagerAutonomy(
  agentKind: string,
  posture: AutonomyPosture | null,
): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  // Setting team operating policy is a broker/admin decision (not team_lead).
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden — only a broker or admin can set manager autonomy policy" }
  }
  if (posture !== null && !isAutonomyPosture(posture)) return { ok: false, error: "Invalid autonomy posture" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  const svc = createServiceClient()
  const { data: rows, error: readErr } = await svc
    .from("managed_agents")
    .select("id, config")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("agent_kind", agentKind)
    .is("archived_at", null)
  if (readErr) return { ok: false, error: readErr.message }
  if (!rows || rows.length === 0) {
    return { ok: false, error: "This manager has no active session yet — autonomy policy applies once it runs." }
  }

  let updated = 0
  const nowIso = new Date().toISOString()
  for (const row of rows) {
    const cfg = { ...((row.config ?? {}) as Record<string, unknown>) }
    if (posture === null) { delete cfg.autonomy_tier; delete cfg.autonomy_updated_at; delete cfg.autonomy_set_by }
    else { cfg.autonomy_tier = posture; cfg.autonomy_updated_at = nowIso; cfg.autonomy_set_by = ctx.userId }
    const { error } = await svc.from("managed_agents").update({ config: cfg, updated_at: nowIso }).eq("id", row.id as string)
    if (!error) updated += 1
  }
  revalidatePath("/dashboard/admin/manager-trust")
  return { ok: true, updated }
}

// ── RETIRE / RESTORE A MANAGER (lane W3, 2026-09-01) ─────────────────────────────────────────
//
// THE HALF THAT WAS MISSING. `managed_agents.archived_at` was READ in four places —
// this file at :121 and in setManagerAutonomy, lib/managers/autonomy-gate.ts:239,
// lib/onboarding/critical-setup.ts:451, lib/agents/spawn-helper.ts:160 — always as the
// filter `.is("archived_at", null)`, and WRITTEN BY NOBODY. Verified against the live
// database (hrvaqgvukzxfskkcrwbt, 2026-09-01): the column is `timestamptz`, nullable,
// no default, and the table carries NO trigger at all — so none of §3's three invisible
// writers (backfill / .rpc() / trigger) applies. The filter was inert: a manager could
// be spawned and never retired.
//
// THE SCHEMA WAS BUILT FOR THIS AND WAS WAITING FOR IT. The uniqueness rule is
// PARTIAL — `uq_managed_agents_brokerage_kind UNIQUE (brokerage_id, agent_kind) WHERE
// (archived_at IS NULL)` — which only makes sense if archiving is expected to FREE the
// slot for a future row of the same kind. A plain unique would have made retirement
// impossible to follow with a respawn.
//
// ── WHAT RETIREMENT IS, AND THE ONE THING IT IS NOT ──────────────────────────────────
// It retires the manager's IDENTITY ROW and with it the broker's stored policy for that
// kind. It is NOT a kill switch, and saying so is the whole reason this comment exists:
// lib/managers/autonomy-gate.ts:234-246 resolves posture from the live row and FAILS
// OPEN (`absence ⇒ null ⇒ allow`), so an archived manager's dispatch reads as
// unrestricted, not as stopped — and lib/agents/spawn-helper.ts:155-216 would create a
// FRESH row (config `{}`) the next time that kind is dispatched, because the partial
// index has freed the slot. A broker who needs sends to STOP wants the halt, not the
// retirement: `setTenantAutonomyHaltAction` (app/actions/superadmin/tenant-entitlements.ts:305,
// consumed at autonomy-gate.ts:222-225) holds every manager in the tenant to the
// approval queue. The confirm text on the trust board says this in the broker's words.
//
// ── AND IT REFUSES TO STRAND IN-FLIGHT WORK ──────────────────────────────────────────
// `managed_agent_sessions` hangs off this row (lib/kernel/command-center.ts:355 reads
// sessions through it, and the webhook routes events back by it). Retiring a kind whose
// session is still `running`/`idle` would leave live work pointing at a row every
// governance surface filters out. So the sessions are counted FIRST, in the same status
// vocabulary spawn-helper uses (§6), and a busy manager is refused with the count.

export async function setManagerRetired(
  agentKind: string,
  retired: boolean,
): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  // Retiring a manager is the same class of decision as setting its autonomy policy:
  // broker/admin, never team_lead. Gate first, then the service client (§4).
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden — only a broker or admin can retire or restore a manager" }
  }
  if (!agentKind?.trim()) return { ok: false, error: "Missing manager kind" }
  if (!(agentKind in MANAGERS)) return { ok: false, error: "Unknown manager kind" }
  // TENANT FROM THE SESSION. Platform staff read cross-tenant on the scorecard, but a
  // retirement is a tenant's own governance act and is written only inside a brokerage.
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  const svc = createServiceClient()
  const nowIso = new Date().toISOString()

  if (retired) {
    const { data: rows, error: readErr } = await svc
      .from("managed_agents")
      .select("id, config")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_kind", agentKind)
      .is("archived_at", null)
    if (readErr) return { ok: false, error: readErr.message }
    if (!rows || rows.length === 0) {
      return { ok: false, error: "This manager has no active row to retire — it has never run for your brokerage." }
    }

    // IN-FLIGHT WORK FIRST. Same status vocabulary as lib/agents/spawn-helper.ts:142.
    const { count: busy, error: busyErr } = await svc
      .from("managed_agent_sessions")
      .select("id", { count: "exact", head: true })
      .in("managed_agent_id", rows.map((r) => r.id as string))
      .in("status", ["running", "idle"])
    // Fail CLOSED (§4): if the session count cannot be read we do not know whether work
    // is in flight, and "nobody checked" must never render as "checked and fine".
    if (busyErr) {
      return { ok: false, error: `Could not check for work still in flight — nothing was retired (${busyErr.message})` }
    }
    if ((busy ?? 0) > 0) {
      return {
        ok: false,
        error: `${MANAGERS[agentKind as ManagerKey].label} still has ${busy} session${busy === 1 ? "" : "s"} running or idle. Let them finish (or end them in the Command Center) before retiring it — retiring now would leave live work pointing at a row every governance surface filters out.`,
      }
    }

    const { data: archived, error: archErr } = await svc
      .from("managed_agents")
      .update({ archived_at: nowIso, updated_at: nowIso })
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_kind", agentKind)
      .is("archived_at", null)
      .select("id")
    if (archErr) return { ok: false, error: archErr.message }
    // COUNTED (§3): an UPDATE that matched nothing resolves exactly like one that
    // worked. Zero rows here means the tenant predicate refused or another writer got
    // there first — a failure the broker must be told about, not a silent success.
    if (!archived || archived.length === 0) {
      return { ok: false, error: "Nothing was retired — the manager may have been retired already, or the write was refused." }
    }
    await auditManagerLifecycle(svc, ctx, archived, agentKind, { archived_at: null }, { archived_at: nowIso }, "manager.retired")
    revalidatePath("/dashboard/admin/manager-trust")
    return { ok: true, updated: archived.length }
  }

  // RESTORE. The partial unique index means a live row of the same kind blocks this —
  // and it can genuinely exist, because a dispatch after the retirement respawns the
  // kind. Checked first so the broker gets a sentence instead of a 23505, and the
  // write's own error is still read in case the race lands between the two.
  const { data: live, error: liveErr } = await svc
    .from("managed_agents")
    .select("id")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("agent_kind", agentKind)
    .is("archived_at", null)
    .limit(1)
  if (liveErr) return { ok: false, error: liveErr.message }
  if (live && live.length > 0) {
    return { ok: false, error: "This manager is already running again — it was respawned after it was retired, so there is nothing to restore." }
  }

  // Only the MOST RECENTLY archived row comes back: restoring several at once would
  // put two live rows of one kind under a partial unique index that forbids exactly that.
  const { data: newest, error: newestErr } = await svc
    .from("managed_agents")
    .select("id, archived_at")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("agent_kind", agentKind)
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (newestErr) return { ok: false, error: newestErr.message }
  if (!newest) return { ok: false, error: "There is no retired row for this manager to restore." }

  const { data: restored, error: restoreErr } = await svc
    .from("managed_agents")
    .update({ archived_at: null, updated_at: nowIso })
    .eq("id", (newest as { id: string }).id)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")
  if (restoreErr) return { ok: false, error: restoreErr.message }
  if (!restored || restored.length === 0) {
    return { ok: false, error: "Nothing was restored — the row may have been restored already, or the write was refused." }
  }
  await auditManagerLifecycle(
    svc, ctx, restored, agentKind,
    { archived_at: (newest as { archived_at: string }).archived_at }, { archived_at: null }, "manager.restored",
  )
  revalidatePath("/dashboard/admin/manager-trust")
  return { ok: true, updated: restored.length }
}

/**
 * The audit row for a retirement or a restore — the same audit_log idiom
 * completeRegionalConventionReview uses below, through sentinelWrite, because a
 * LOST governance row is exactly the kind of write that must not fail silently.
 * Never blocks the operation: the flip already landed and was counted.
 */
async function auditManagerLifecycle(
  svc: ReturnType<typeof createServiceClient>,
  ctx: Awaited<ReturnType<typeof getAgentContext>>,
  rows: Array<{ id: unknown }>,
  agentKind: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  action: "manager.retired" | "manager.restored",
): Promise<void> {
  const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
  for (const r of rows) {
    await sentinelWrite(svc, svc.from("audit_log").insert({
      user_id: ctx.userId,
      action,
      entity_type: "managed_agent",
      entity_id: r.id as string,
      before,
      after: { ...after, agent_kind: agentKind, brokerage_id: ctx.brokerageId, compliance_relevant: true },
    }), { table: "audit_log", flow: "manager_lifecycle", brokerageId: ctx.brokerageId ?? null })
  }
}

// ── LEARNED ADJUSTMENTS — human oversight of what the managers LEARNED ───────────────────────
// The Manager Learning Loop writes outcome-derived adjustments (e.g. financing_risk_sensitivity,
// offer_posture) that change behavior. These give the broker VISIBILITY into every learned
// signal and a one-click VETO — enforced at the single getLearnedAdjustment chokepoint, so a
// veto instantly disables that learned behavior across every consumer.

/** List every learned adjustment for the caller's brokerage (value + rationale + veto state). */
export async function getLearnedAdjustmentsForBrokerage(): Promise<
  { ok: true; rows: import("@/lib/managers/learning-loop").LearnedAdjustmentView[] } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
  const { listLearnedAdjustments } = await import("@/lib/managers/learning-loop")
  const rows = await listLearnedAdjustments(ctx.brokerageId)
  return { ok: true, rows }
}

/** Broker veto (or un-veto) a learned adjustment — the human off-switch over the learning loop. */
export async function vetoLearnedAdjustment(
  key: string,
  vetoed: boolean,
): Promise<{ ok: true; vetoed: boolean } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden — only a broker or admin can veto a learned adjustment" }
  }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
  if (!key?.trim()) return { ok: false, error: "Missing adjustment key" }
  const { setLearnedAdjustmentVeto } = await import("@/lib/managers/learning-loop")
  const r = await setLearnedAdjustmentVeto(ctx.brokerageId, key, vetoed)
  revalidatePath("/dashboard/admin/manager-trust")
  return r.ok ? { ok: true, vetoed: r.vetoed } : { ok: false, error: "Failed to update veto" }
}

// ── CROSS-MANAGEMENT (round 34) — referrals + standing reviews on the governance surface ──────
// "Managers should be working together and can cross manage": the manager-trust page shows the
// DECLARED collaboration map (pure registry import in the client), every cross_manager_referral's
// lifecycle (who asked whom, for what, state, and what the receiving manager did), and the Finance
// Manager's standing yearly regional-convention review with its audit-ledger-derived due state.

export interface CrossManagerReferralView {
  id: string
  from: string
  fromLabel: string
  to: string
  toLabel: string
  /** MANAGER_COLLABORATIONS key the referral traveled (from payload.collab_domain). */
  domain: string | null
  domainLabel: string | null
  ask: string
  status: "open" | "consumed" | "expired"
  /** What the receiving manager did (consumed_action) — includes governed refusals. */
  action: string | null
  createdAt: string
  consumedAt: string | null
  /** DELIBERATION (round 35) — the argued positions + winner + why + dissent persisted
   *  on this referral's own payload (lib/managers/deliberation.ts); null when the
   *  domain wasn't deliberative or no deliberation ran. */
  deliberation: import("@/lib/managers/deliberation").DeliberationRecord | null
}

/** The last 90 days of cross-manager referrals for the caller's brokerage, newest first. */
export async function getCrossManagerReferrals(): Promise<
  { ok: true; referrals: CrossManagerReferralView[] } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  const { MANAGER_COLLABORATIONS } = await import("@/lib/kernel/manager-registry")
  const { parseDeliberation } = await import("@/lib/managers/deliberation")
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("manager_signals")
    .select("id, from_manager, to_manager, payload, message, status, consumed_action, consumed_at, created_at")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("signal_type", "cross_manager_referral")
    .gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) return { ok: false, error: error.message }

  const referrals: CrossManagerReferralView[] = ((data ?? []) as Array<Record<string, any>>).map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>
    const domainKey = typeof payload.collab_domain === "string" ? payload.collab_domain : null
    const domain = domainKey ? MANAGER_COLLABORATIONS[domainKey] : undefined
    const from = String(r.from_manager)
    const to = String(r.to_manager)
    return {
      id: String(r.id),
      from,
      fromLabel: (MANAGERS as Record<string, { label: string }>)[from]?.label ?? from,
      to,
      toLabel: (MANAGERS as Record<string, { label: string }>)[to]?.label ?? to,
      domain: domainKey,
      domainLabel: domain?.label ?? null,
      ask: (typeof payload.ask === "string" && payload.ask.trim()) || String(r.message ?? ""),
      status: (r.status === "consumed" || r.status === "expired" ? r.status : "open") as CrossManagerReferralView["status"],
      action: (r.consumed_action as string | null) ?? null,
      createdAt: String(r.created_at),
      consumedAt: (r.consumed_at as string | null) ?? null,
      deliberation: parseDeliberation(payload),
    }
  })
  return { ok: true, referrals }
}

// ── THE PRINCIPAL'S CALL (round 36) — the human can weigh in on a finished
// deliberation: override the argued winner WITH a stated reason. Recorded on the SAME
// payload record (payload.deliberation.override, via recordPrincipalOverride →
// sentinelWrite), never a parallel ledger; teamwork metrics count the overrides.

export async function overrideDeliberationWinner(
  referralId: string,
  winner: string,
  reason: string,
): Promise<
  { ok: true; record: import("@/lib/managers/deliberation").DeliberationRecord } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  // Overriding the argued winner is a broker/admin governance decision (not team_lead).
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden — only a broker or admin can record the principal's call" }
  }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
  if (!referralId?.trim()) return { ok: false, error: "Missing referral id" }
  if (!reason?.trim()) return { ok: false, error: "A principal's call requires a stated reason" }

  const { recordPrincipalOverride } = await import("@/lib/managers/deliberation")
  const r = await recordPrincipalOverride({
    brokerageId: ctx.brokerageId,
    signalId: referralId,
    winner,
    reason,
    by: ctx.userId ?? null,
  }, createServiceClient())
  if (!r.ok) return r
  revalidatePath("/dashboard/admin/manager-trust")
  return { ok: true, record: r.record }
}

// ── TEAMWORK METRICS (round 35) — the compact card on the governance surface: the
// referral + deliberation ledgers rolled up per period (pure rollup, no new table).

export async function getTeamworkMetrics(): Promise<
  { ok: true; metrics: import("@/lib/managers/teamwork-metrics").TeamworkMetrics } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
  const { loadTeamworkMetrics } = await import("@/lib/managers/teamwork-metrics")
  const metrics = await loadTeamworkMetrics(ctx.brokerageId, { days: 90 }, createServiceClient())
  return { ok: true, metrics }
}

export interface StandingReviewView {
  key: string
  ownerLabel: string
  ownerAccent: string
  label: string
  target: string
  what: string
  sources: string[]
  status: "due" | "overdue" | "scheduled"
  dueAt: string | null
  lastCompletedAt: string | null
  summary: string
}

/** The Finance Manager's standing yearly regional-convention review, due state derived
 *  purely from the latest completion row on the audit ledger (no parallel state). */
export async function getStandingReviews(): Promise<
  { ok: true; reviews: StandingReviewView[] } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  const { REGIONAL_CONVENTION_REVIEW, assessStandingReview } = await import("@/lib/managers/regional-convention-review")
  const svc = createServiceClient()
  const { data: last } = await svc
    .from("audit_log")
    .select("created_at")
    .eq("action", REGIONAL_CONVENTION_REVIEW.auditAction)
    .eq("entity_type", REGIONAL_CONVENTION_REVIEW.auditEntityType)
    .eq("entity_id", ctx.brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const assessment = assessStandingReview(REGIONAL_CONVENTION_REVIEW, (last as { created_at?: string } | null)?.created_at ?? null)
  const owner = MANAGERS[REGIONAL_CONVENTION_REVIEW.owner]
  return {
    ok: true,
    reviews: [{
      key: REGIONAL_CONVENTION_REVIEW.key,
      ownerLabel: owner.label,
      ownerAccent: owner.accent,
      label: REGIONAL_CONVENTION_REVIEW.label,
      target: REGIONAL_CONVENTION_REVIEW.target,
      what: REGIONAL_CONVENTION_REVIEW.what,
      sources: REGIONAL_CONVENTION_REVIEW.sources,
      status: assessment.status,
      dueAt: assessment.dueAt,
      lastCompletedAt: assessment.lastCompletedAt,
      summary: assessment.summary,
    }],
  }
}

/**
 * Complete the yearly regional-convention review — a broker/admin (the Finance
 * Manager's supervising principal) attests the model was re-verified against the
 * published sources. Lands on audit_log (the settings-actions idiom), which is BOTH
 * the completion ledger the due-state derives from AND the tenant audit surface's
 * feed — one write, no parallel state. Checked via sentinelWrite (a lost completion
 * row would silently re-flag the review as overdue).
 */
export async function completeRegionalConventionReview(
  notes?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden — completing a standing review is a broker/admin attestation" }
  }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  const { REGIONAL_CONVENTION_REVIEW } = await import("@/lib/managers/regional-convention-review")
  const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
  const svc = createServiceClient()
  const landed = await sentinelWrite(svc, svc.from("audit_log").insert({
    user_id: ctx.userId,
    action: REGIONAL_CONVENTION_REVIEW.auditAction,
    entity_type: REGIONAL_CONVENTION_REVIEW.auditEntityType,
    entity_id: ctx.brokerageId,
    before: null,
    after: {
      review_key: REGIONAL_CONVENTION_REVIEW.key,
      target: REGIONAL_CONVENTION_REVIEW.target,
      sources_checked: REGIONAL_CONVENTION_REVIEW.sources,
      notes: (notes ?? "").trim().slice(0, 500) || null,
      compliance_relevant: true,
    },
  }), { table: "audit_log", flow: "regional_convention_review", brokerageId: ctx.brokerageId })
  if (!landed) return { ok: false, error: "Could not record the review completion — see the self-heal ledger" }
  revalidatePath("/dashboard/admin/manager-trust")
  return { ok: true }
}
