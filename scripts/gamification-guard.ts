#!/usr/bin/env tsx
/**
 * scripts/gamification-guard.ts   (npm run test:gamification)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves LAYER 6 — LIFECYCLE GAMIFICATION (wave 103, lane 103C): one award path,
 * one trigger (the event reactor), idempotent awards and badges, tiers on the
 * manager briefs, fatigue-aware pressure, and the wiring that makes each of those
 * true in the tree. Pure + in-memory client; no database, no credentials.
 *
 * PURE:   planLifecycleAwards (the rule table → once-keys), tierDistributionLine,
 *         isUnderStrain / strainedFromRows, anniversaryYearsOn.
 * MEMORY: awardAgentPointsOnce + awardLifecycleMilestones + awardBadgeToAgent against
 *         an in-memory supabase-shaped client — a replayed event lands ONCE.
 * WIRING: stripped-source census (scripts/strip-comments.ts) of every edge, each
 *         absence assertion with a positive control.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { stripComments } from "./strip-comments"
import { KernelEvent } from "../lib/kernel/events"
import {
  POINT_VALUES, LIFECYCLE_AWARD_RULES, planLifecycleAwards, awardAgentPointsOnce, isUuid, type LedgerCapableClient,
} from "../lib/gamification/award-points"
import { awardLifecycleMilestones, awardBadgeToAgent } from "../lib/gamification/lifecycle-awards"
import { tierDistributionLine } from "../lib/gamification/tiers"
import { isUnderStrain, strainedFromRows } from "../lib/gamification/strain"
import { anniversaryYearsOn, ANNIVERSARY_WINDOW_DAYS } from "../lib/gamification/work-anniversaries"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const src = (p: string) => stripComments(raw(p))

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const AGENT = U(1), AGENT2 = U(2), BRK = U(9), TX = U(10), TX_OLD = U(11), CONTACT = U(20), SHOWING = U(30), SESSION = U(40), BADGE = U(50)

// ─── PURE ─────────────────────────────────────────────────────────────────────
function pureLayer() {
  console.log("\n[rule table · pure]")
  const events = new Set<string>(Object.values(KernelEvent))
  check("every rule names a real KernelEvent", LIFECYCLE_AWARD_RULES.every((r) => events.has(r.event)))
  check("every rule's reason has a POINT_VALUE > 0", LIFECYCLE_AWARD_RULES.every((r) => (POINT_VALUES as Record<string, number>)[r.reason] > 0))
  const covered = (e: string) => LIFECYCLE_AWARD_RULES.some((r) => r.event === e)
  check("agent lifecycle covered: onboarding step + completion, certification, first contact, first appointment, close, CE, mentor, anniversary",
    [KernelEvent.USER_ONBOARDING_STEP_COMPLETED, KernelEvent.USER_ONBOARDING_COMPLETED, KernelEvent.CERTIFICATION_AWARDED, KernelEvent.CONTACT_CREATED,
     KernelEvent.ISA_APPOINTMENT_SCHEDULED, KernelEvent.TRANSACTION_CLOSED, KernelEvent.CE_COMPLETED, KernelEvent.MENTOR_SESSION_HELD, KernelEvent.AGENT_WORK_ANNIVERSARY].every(covered))
  check("customer lifecycle covered: kept anniversary touch, referral received + converted, repeat client",
    [KernelEvent.ANNIVERSARY_TRIGGERED, KernelEvent.REFERRAL_RECEIVED, KernelEvent.REFERRAL_CONVERTED].every(covered) &&
      LIFECYCLE_AWARD_RULES.some((r) => r.reason === "REPEAT_CLIENT_CLOSED" && r.when === "repeat_client"))

  const now = new Date("2026-10-05T12:00:00Z")
  const close = planLifecycleAwards(KernelEvent.TRANSACTION_CLOSED, { entityId: TX, now, repeatClient: false })
  check("a close plans LISTING_CLOSED (per transaction) + FIRST_CLOSE (first ever) and NOT the repeat award",
    close.some((p) => p.reason === "LISTING_CLOSED" && p.once.referenceId === TX) &&
      close.some((p) => p.reason === "FIRST_CLOSE" && !p.once.referenceId && !p.once.since) &&
      !close.some((p) => p.reason === "REPEAT_CLIENT_CLOSED"))
  check("a repeat-client close adds REPEAT_CLIENT_CLOSED (positive control)",
    planLifecycleAwards(KernelEvent.TRANSACTION_CLOSED, { entityId: TX, now, repeatClient: true }).some((p) => p.reason === "REPEAT_CLIENT_CLOSED"))
  check("a non-uuid onboarding stepId plans nothing (reference_id is uuid) — uuid stepId plans one",
    planLifecycleAwards(KernelEvent.USER_ONBOARDING_STEP_COMPLETED, { entityId: U(3), now, metadata: { stepId: "welcome" } }).length === 0 &&
      planLifecycleAwards(KernelEvent.USER_ONBOARDING_STEP_COMPLETED, { entityId: U(3), now, metadata: { stepId: U(4) } })[0]?.once.referenceId === U(4))
  const anniv = planLifecycleAwards(KernelEvent.AGENT_WORK_ANNIVERSARY, { entityId: AGENT, now })[0]
  check("a work anniversary is once per calendar year (since = Jan 1 UTC, no reference)",
    !!anniv && !anniv.once.referenceId && anniv.once.since?.toISOString() === "2026-01-01T00:00:00.000Z")
  const kept = planLifecycleAwards(KernelEvent.ANNIVERSARY_TRIGGERED, { entityId: CONTACT, now })[0]
  check("a kept client anniversary is once per contact per year (reference AND since)",
    !!kept && kept.once.referenceId === CONTACT && kept.once.since?.getUTCFullYear() === 2026)
  check("REFERRAL_RECEIVED keys on metadata.referral_id, not the contact it is emitted on",
    planLifecycleAwards(KernelEvent.REFERRAL_RECEIVED, { entityId: CONTACT, now, metadata: { referral_id: U(60) } })[0]?.once.referenceId === U(60))
  check("MENTOR_SESSION_HELD credits mentor AND mentee", planLifecycleAwards(KernelEvent.MENTOR_SESSION_HELD, { entityId: SESSION, now })[0]?.party === "mentor_and_mentee")
  check("an event with no rule plans nothing", planLifecycleAwards(KernelEvent.PRICE_DETERMINED, { entityId: TX, now }).length === 0)

  console.log("\n[tiers · pure]")
  check("tierDistributionLine orders highest rung first and omits unranked when a rung is reached", tierDistributionLine([12000, 3000, 3000, 100]) === "1 Gold · 2 Silver")
  check("an all-unranked roster reads as N Unranked; an empty roster reads —", tierDistributionLine([0, null, 20]) === "3 Unranked" && tierDistributionLine([]) === "—")

  console.log("\n[strain · pure — read from the radar's row, never re-derived]")
  check("at-risk composite → under strain", isUnderStrain({ composite_score: 30, signal_breakdown: null }))
  check("healthy composite + two weak fatigue signals (the radar's own keys) → under strain", isUnderStrain({ composite_score: 70, signal_breakdown: { response_lag: 0.2, overdue_tasks: 0.1, pipeline_drop: 0.9 } }))
  check("healthy composite + one weak signal → NOT under strain (positive control)", !isUnderStrain({ composite_score: 70, signal_breakdown: { response_lag: 0.2, pipeline_drop: 0.9 } }))
  check("a key the radar does not emit is ignored, not counted (positive control)", !isUnderStrain({ composite_score: 70, signal_breakdown: { replyLag: 0.1, overdueTasks: 0.1 } }))
  check("the newest row per agent wins", (() => {
    const s = strainedFromRows([
      { agent_id: AGENT, composite_score: 75, signal_breakdown: {}, score_date: "2026-10-05" },
      { agent_id: AGENT, composite_score: 10, signal_breakdown: {}, score_date: "2026-09-01" },
      { agent_id: AGENT2, composite_score: 10, signal_breakdown: {}, score_date: "2026-10-05" },
    ])
    return !s.has(AGENT) && s.has(AGENT2)
  })())

  console.log("\n[work anniversaries · pure]")
  const nowA = new Date("2026-10-05T12:00:00Z")
  check("an anniversary inside the window counts the whole years", anniversaryYearsOn("2024-10-03T09:00:00Z", nowA) === 2)
  check(`an anniversary older than ${ANNIVERSARY_WINDOW_DAYS} days is not this run's (positive control)`, anniversaryYearsOn("2024-09-20T09:00:00Z", nowA) === null)
  check("the first year never counts", anniversaryYearsOn("2026-10-03T09:00:00Z", nowA) === null)
  check("a window spanning New Year still finds last year's date (Dec 30 2025 = 2 years after Dec 30 2023)", anniversaryYearsOn("2023-12-30T00:00:00Z", new Date("2026-01-03T00:00:00Z")) === 2)
  check("garbage dates are null, never NaN years", anniversaryYearsOn("not a date", nowA) === null && anniversaryYearsOn(null, nowA) === null)
}

// ─── IN-MEMORY CLIENT ─────────────────────────────────────────────────────────
type Row = Record<string, any>
function memoryClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const t = (n: string) => (tables[n] ??= [])
  let rpcCalls = 0
  let refuseRead: string | null = null
  const matches = (row: Row, f: { kind: string; col?: string; val?: any; terms?: Array<[string, string, string]> }) => {
    switch (f.kind) {
      case "eq": return row[f.col!] === f.val
      case "neq": return row[f.col!] !== f.val
      case "in": return (f.val as any[]).includes(row[f.col!])
      case "gte": return String(row[f.col!] ?? "") >= String(f.val)
      case "or": return f.terms!.some(([c, op, v]) => (op === "is" && v === "null") ? row[c] == null : row[c] === v)
      default: return true
    }
  }
  function query(table: string) {
    const filters: any[] = []
    let limitN: number | null = null
    let inserted: Row[] | null = null
    let joinSel: string | null = null
    const run = () => {
      if (refuseRead === table) return { data: null, error: { message: `refused ${table}` } }
      const rows = (inserted ?? t(table)).filter((r) => filters.every((f) => matches(r, f)))
      const out = rows.map((r) => {
        if (joinSel && table === "agent_badges") {
          const b = t("gamification_badges").find((g) => g.id === r.badge_id)
          return { ...r, gamification_badges: b ? { badge_name: b.badge_name, badge_tier: b.badge_tier } : null }
        }
        return r
      })
      return { data: limitN ? out.slice(0, limitN) : out, error: null }
    }
    const api: any = {
      select(cols?: string) { joinSel = cols ?? null; return api },
      eq(col: string, val: any) { filters.push({ kind: "eq", col, val }); return api },
      neq(col: string, val: any) { filters.push({ kind: "neq", col, val }); return api },
      in(col: string, val: any[]) { filters.push({ kind: "in", col, val }); return api },
      gte(col: string, val: any) { filters.push({ kind: "gte", col, val }); return api },
      or(expr: string) { filters.push({ kind: "or", terms: expr.split(",").map((s) => { const [c, op, v] = s.split("."); return [c, op, v] as [string, string, string] }) }); return api },
      order() { return api },
      limit(n: number) { limitN = n; return api },
      insert(rows: Row | Row[]) {
        const list = (Array.isArray(rows) ? rows : [rows]).map((r, i) => ({ id: U(900 + t(table).length + i), created_at: new Date().toISOString(), ...r }))
        if (table === "agent_badges") {
          for (const r of list) if (t(table).some((x) => x.agent_id === r.agent_id && x.badge_id === r.badge_id)) {
            inserted = []; filters.push({ kind: "never" }); const err = { message: "duplicate key value violates unique constraint agent_badges_unique (23505)" }
            api.single = async () => ({ data: null, error: err }); api.then = (res: any) => res({ data: null, error: err }); return api
          }
        }
        t(table).push(...list); inserted = list; return api
      },
      maybeSingle: async () => { const r = run(); return { data: r.error ? null : (r.data![0] ?? null), error: r.error } },
      single: async () => { const r = run(); return { data: r.error ? null : (r.data![0] ?? null), error: r.error ?? (r.data!.length ? null : { message: "no rows" }) } },
      then(res: any) { return Promise.resolve(run()).then(res) },
    }
    return api
  }
  const client: LedgerCapableClient & { tables: Record<string, Row[]>; rpcCalls: () => number; refuse: (t: string | null) => void } = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls++
      if (fn !== "award_agent_points") return { data: null, error: { message: `unknown rpc ${fn}` } }
      const agent = t("agents").find((a) => a.id === args.p_agent_id)
      if (!agent) return { data: null, error: { message: "no agents row" } }
      agent.gamification_points = (agent.gamification_points ?? 0) + Number(args.p_points)
      const log = { id: U(700 + t("agent_points_log").length), agent_id: agent.id, brokerage_id: agent.brokerage_id, points: args.p_points, reason: args.p_reason, reference_type: args.p_reference_type, reference_id: args.p_reference_id, created_at: new Date().toISOString() }
      t("agent_points_log").push(log)
      return { data: { brokerage_id: agent.brokerage_id, points_added: args.p_points, new_total: agent.gamification_points, log_id: log.id }, error: null }
    },
    tables, rpcCalls: () => rpcCalls, refuse: (x) => { refuseRead = x },
  }
  return client
}

async function memoryLayer() {
  console.log("\n[awardAgentPointsOnce · in-memory — idempotent, fail closed]")
  const c = memoryClient({ agents: [{ id: AGENT, brokerage_id: BRK, user_id: U(5), gamification_points: 0 }, { id: AGENT2, brokerage_id: BRK, user_id: U(6), gamification_points: 0 }] })
  const first = await awardAgentPointsOnce(c, { agentId: AGENT, points: 50, reason: "SHOWING_COMPLETED", referenceType: "showing", once: { referenceId: SHOWING } })
  const second = await awardAgentPointsOnce(c, { agentId: AGENT, points: 50, reason: "SHOWING_COMPLETED", referenceType: "showing", once: { referenceId: SHOWING } })
  check("first award lands through the RPC; the identical second declines as alreadyAwarded; ONE ledger row",
    first.ok && !("alreadyAwarded" in first) && second.ok && "alreadyAwarded" in second && c.tables.agent_points_log.length === 1 && c.rpcCalls() === 1)
  const other = await awardAgentPointsOnce(c, { agentId: AGENT, points: 50, reason: "SHOWING_COMPLETED", referenceType: "showing", once: { referenceId: U(31) } })
  check("a different reference is a different award (positive control)", other.ok && !("alreadyAwarded" in other) && c.tables.agent_points_log.length === 2)
  const bad = await awardAgentPointsOnce(c, { agentId: AGENT, points: 10, reason: "X", once: { referenceId: "step-1" } })
  check("a non-uuid reference is refused before the RPC", !bad.ok && c.rpcCalls() === 2)
  c.refuse("agent_points_log")
  const refused = await awardAgentPointsOnce(c, { agentId: AGENT, points: 10, reason: "FIRST_CLOSE", once: {} })
  check("a refused ledger read withholds the award (fail closed), never double-awards", !refused.ok && /fail closed/.test((refused as any).error) && c.rpcCalls() === 2)
  c.refuse(null)

  console.log("\n[awardLifecycleMilestones · in-memory — the reactor hook]")
  const m = memoryClient({
    agents: [{ id: AGENT, brokerage_id: BRK, user_id: U(5), gamification_points: 0 }, { id: AGENT2, brokerage_id: BRK, user_id: U(6), gamification_points: 0 }],
    transactions: [
      { id: TX, brokerage_id: BRK, agent_id: AGENT, buyer_contact_id: CONTACT, seller_contact_id: null, status: "closed" },
      { id: TX_OLD, brokerage_id: BRK, agent_id: AGENT, buyer_contact_id: null, seller_contact_id: CONTACT, status: "funded" },
    ],
    gamification_badges: [{ id: BADGE, brokerage_id: null, badge_name: "First Close", badge_tier: "silver", trigger_event: "FIRST_CLOSE", is_active: true, required_points: 0 }],
  })
  const ev = { event: KernelEvent.SHOWING_COMPLETED, brokerageId: BRK, entityType: "showing", entityId: SHOWING, metadata: { agent_id: AGENT } }
  const r1 = await awardLifecycleMilestones(m, ev)
  const r2 = await awardLifecycleMilestones(m, ev)
  check("SHOWING_COMPLETED (agent_id in metadata) awards once; the replay lands nothing",
    r1.awarded.length === 1 && r1.awarded[0].reason === "SHOWING_COMPLETED" && r2.awarded.length === 0 && r2.alreadyAwarded === 1 &&
      m.tables.agent_points_log.filter((r) => r.reason === "SHOWING_COMPLETED").length === 1)
  const closeRes = await awardLifecycleMilestones(m, { event: KernelEvent.TRANSACTION_CLOSED, brokerageId: BRK, entityType: "transaction", entityId: TX, metadata: { close_date: "2026-10-05" } })
  const reasons = closeRes.awarded.map((a) => a.reason).sort()
  check("TRANSACTION_CLOSED resolves the agent from transactions.agent_id and awards LISTING_CLOSED + FIRST_CLOSE + REPEAT_CLIENT_CLOSED (prior close with the same contact)",
    JSON.stringify(reasons) === JSON.stringify(["FIRST_CLOSE", "LISTING_CLOSED", "REPEAT_CLIENT_CLOSED"]))
  check("the FIRST_CLOSE milestone badge landed once, with its evidence reason", m.tables.agent_badges.length === 1 && closeRes.badgesAwarded === 1 && /FIRST_CLOSE/.test(m.tables.agent_badges[0].awarded_reason))
  const closeAgain = await awardLifecycleMilestones(m, { event: KernelEvent.TRANSACTION_CLOSED, brokerageId: BRK, entityType: "transaction", entityId: TX, metadata: {} })
  check("replaying the close awards nothing and mints no second badge", closeAgain.awarded.length === 0 && m.tables.agent_badges.length === 1)
  const mentor = await awardLifecycleMilestones(m, { event: KernelEvent.MENTOR_SESSION_HELD, brokerageId: BRK, entityType: "mentor_session", entityId: SESSION, metadata: { mentor_agent_id: AGENT, mentee_agent_id: AGENT2 } })
  check("MENTOR_SESSION_HELD credits both parties, 75 each, once per session",
    mentor.awarded.length === 2 && mentor.awarded.every((a) => a.points === POINT_VALUES.MENTOR_SESSION_HELD) && new Set(mentor.awarded.map((a) => a.agentId)).size === 2)
  const noAgent = await awardLifecycleMilestones(m, { event: KernelEvent.CONTACT_CREATED, brokerageId: BRK, entityType: "contact", entityId: U(21), metadata: {} })
  check("an event whose agent cannot be resolved awards nothing and SAYS so", noAgent.awarded.length === 0 && noAgent.refused.length === 1)
  check("agents.id is the key — a users.id-only event resolves through agents.user_id", (await awardLifecycleMilestones(m, { event: KernelEvent.USER_ONBOARDING_COMPLETED, brokerageId: BRK, entityType: "user", entityId: U(6), metadata: {} })).awarded[0]?.agentId === AGENT2)
  const dup = await awardBadgeToAgent(m, { agentId: AGENT, badgeId: BADGE, reason: "again" })
  check("awardBadgeToAgent on an already-held badge reports alreadyAwarded (UNIQUE beneath the pre-read)", dup.ok && dup.alreadyAwarded === true && m.tables.agent_badges.length === 1)
  check("isUuid recognises the shapes the ledger admits", isUuid(TX) && !isUuid("abc") && !isUuid(null))
}

// ─── WIRING ───────────────────────────────────────────────────────────────────
function wiringLayer() {
  console.log("\n[wiring — stripped source, every absence with a positive control]")
  const reactor = src("lib/kernel/event-reactor.ts")
  const awardSrc = src("lib/gamification/award-points.ts")
  check("the event reactor calls awardLifecycleMilestones on every known event (THE one trigger)", /awardLifecycleMilestones\(svc,/.test(reactor) && /isKnownEvent\)\s*\{\s*try\s*\{\s*const \{ awardLifecycleMilestones \}/.test(reactor))
  check("positive control: the same call inside a comment is NOT a call", !/awardLifecycleMilestones\(/.test(stripComments("// awardLifecycleMilestones(svc, params)\nconst x = 1")))

  // ONE award path: the RPC is named in exactly one module.
  const all = listSources()
  const rpcSites = all.filter((f) => /rpc\(\s*"award_agent_points"/.test(src(f)))
  check(`award_agent_points RPC is called from award-points.ts only (${rpcSites.length} site)`, rpcSites.length === 1 && rpcSites[0] === "lib/gamification/award-points.ts")
  const badgeInserts = all.filter((f) => /from\(\s*"agent_badges"\s*\)\s*\.insert\(/.test(src(f)))
  const lifecycleSrc = src("lib/gamification/lifecycle-awards.ts")
  check(`agent_badges is inserted from lifecycle-awards.ts only (${badgeInserts.length} site) — app/actions/gamification.ts delegates`, badgeInserts.length === 1 && badgeInserts[0] === "lib/gamification/lifecycle-awards.ts" && /awardBadgeToAgent\(supabase, data\)/.test(src("app/actions/gamification.ts")))
  check("positive control: the finder sees an insert when one exists", /from\(\s*"agent_badges"\s*\)\s*\.insert\(/.test(lifecycleSrc))
  check("award-points.ts (imported by a Client Component) carries NO edge into the server-only emit graph; lifecycle-awards.ts carries it", !/lib\/kernel\/emit/.test(awardSrc) && /import\("@\/lib\/kernel\/emit"\)/.test(lifecycleSrc))

  // Call sites emit, they do not award.
  const showings = src("app/components/dashboard/listings/showings/confirmed-showings-list.tsx")
  const referrals = src("app/referrals/referrals-os-client.tsx")
  check("confirmed-showings-list no longer awards client-side; markShowingCompleted emits SHOWING_COMPLETED", !/awardPointsForAction/.test(showings) && /KernelEvent\.SHOWING_COMPLETED/.test(src("app/actions/seller-showings.ts")))
  check("referrals-os-client no longer awards client-side; createReferral emits REFERRAL_RECEIVED", !/awardPointsForAction/.test(referrals) && /KernelEvent\.REFERRAL_RECEIVED/.test(src("app/actions/referrals/referral-actions.ts")))
  check("positive control: the raw source still carries the tombstones that name the survivor", /awardPointsForAction/.test(raw("app/components/dashboard/listings/showings/confirmed-showings-list.tsx")))
  const actionMap = src("app/lib/gamification/award-on-action.ts")
  check("ACTION_MAP carries no key for a moment the reactor awards (showing_completed / deal_closed / referral_received)", !/showing_completed|deal_closed|referral_received/.test(actionMap) && /offer_submitted:/.test(actionMap))
  check("mentor-session emits MENTOR_SESSION_HELD and awards nothing itself", /KernelEvent\.MENTOR_SESSION_HELD/.test(src("app/actions/onboarding/mentor-session.ts")) && !/awardAgentPoints/.test(src("app/actions/onboarding/mentor-session.ts")))
  check("ce-provider emits CE_COMPLETED on a NEW completion row (inside the !existing branch)", /if \(!existing\) \{[\s\S]*?KernelEvent\.CE_COMPLETED/.test(src("app/actions/ce-provider.ts")))
  check("the weekly recruit-outreach cron runs runWorkAnniversariesAll (same cron as the leaderboard writer)", /runWorkAnniversariesAll\(supabase\)/.test(src("app/api/cron/recruit-outreach/route.ts")) && /runLeaderboardSnapshotAll\(supabase\)/.test(src("app/api/cron/recruit-outreach/route.ts")))
  const ev = src("lib/kernel/events.ts")
  check("KernelEvent carries the three new lifecycle members", /MENTOR_SESSION_HELD\s*=\s*'mentor_session_held'/.test(ev) && /CE_COMPLETED\s*=\s*'ce_completed'/.test(ev) && /AGENT_WORK_ANNIVERSARY\s*=\s*'agent_work_anniversary'/.test(ev))
  for (const name of ["MENTOR_SESSION_HELD", "CE_COMPLETED", "AGENT_WORK_ANNIVERSARY"]) {
    const emitters = all.filter((f) => !/lib\/kernel\/events\.ts|award-points\.ts|^scripts\//.test(f) && new RegExp(`KernelEvent\\.${name}\\b`).test(src(f)))
    check(`${name} has a real emitter (${emitters.join(", ") || "none"})`, emitters.length >= 1)
  }

  // Fatigue-aware pressure.
  const career = src("lib/recruiting/career-tier.ts")
  check("career-tier reads strainedAgentIds and stands the approach nudge down for a strained agent", /strainedAgentIds\(svc, params\.brokerageId\)/.test(career) && /if \(strained\.has\(a\.id\)\) \{ out\.strainSkipped\+\+; continue \}/.test(career))
  check("strain is READ from agent_retention_scores (the radar's row), never re-derived", /from\("agent_retention_scores"\)/.test(src("lib/gamification/strain.ts")) && /from "@\/lib\/recruiting\/retention-score"/.test(src("lib/gamification/strain.ts")) && !/from\("buyer_fatigue_scores"\)|calculateFatigue/.test(src("lib/gamification/strain.ts")))
  check("getAgentPointsAndTier returns underStrain and the Motivation rail renders support instead of a push", /underStrain,\s*\}/.test(src("app/actions/gamification.ts")) && /motivation-strain-notice/.test(src("app/dashboard/intelligence/components/os/motivation-rail.tsx")) && /underStrain=\{pointsData\.underStrain === true\}/.test(src("app/dashboard/intelligence/intelligence-os-client.tsx")))

  // Tiers on the briefs.
  check("broker and team-lead briefs carry a tier-distribution metric from the ONE ladder", /tierDistributionLine\(/.test(src("lib/intelligence/user-type-briefs/broker.ts")) && /label: "Agent tiers"/.test(src("lib/intelligence/user-type-briefs/broker.ts")) && /tierDistributionLine\(/.test(src("lib/intelligence/user-type-briefs/team-lead.ts")) && /label: "Team tiers"/.test(src("lib/intelligence/user-type-briefs/team-lead.ts")))
  check("no commission rule was touched", !/commission/i.test(awardSrc) && !/commission/i.test(src("lib/gamification/strain.ts")))

  // m705 — the catalog names only reasons the code awards.
  const m705 = raw("supabase/migrations/m705-lifecycle-milestone-badges.sql")
  const seeded = Array.from(m705.matchAll(/,\s*0,\s*'([A-Z_]+)',\s*true\)/g)).map((m) => m[1])
  const ruleReasons = new Set(LIFECYCLE_AWARD_RULES.map((r) => r.reason as string))
  check(`m705 seeds ${seeded.length} milestone badges and every trigger_event is a reason the reactor awards`, seeded.length >= 9 && seeded.every((s) => ruleReasons.has(s) && s in POINT_VALUES))
  check("m705 opens with a status header", /^-- ──/.test(m705))
  check("threshold badges and milestone badges never overlap: the threshold awarder filters to points_threshold", /trigger_event \?\? "points_threshold"\) === "points_threshold"/.test(src("app/actions/gamification.ts")))

  // Ownership + registration.
  const reg = src("lib/kernel/manager-registry.ts")
  check("MAINTENANCE_DOMAINS.lifecycle_gamification owned by recruiting_manager with named coOwners", /lifecycle_gamification:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:gamification",\s*coOwners:\s*\["data_steward",\s*"deal_coordinator"\]/.test(reg))
  const pkg = raw("package.json")
  // The RULE is "in the guard chain, after test:scrapers" — sibling wave proofs share that slot
  // (CLAUDE.md §2: assert the rule, not the waypoint).
  check("package.json wires test:gamification into the guard chain after test:scrapers", /"test:gamification":\s*"tsx scripts\/gamification-guard\.ts"/.test(pkg) && pkg.indexOf("npm run test:gamification") > pkg.indexOf("npm run test:scrapers") && pkg.indexOf("npm run test:scrapers") >= 0)
}

function listSources(): string[] {
  // --others: a file this lane added but has not yet committed must still be census-visible.
  return execSync("git ls-files --cached --others --exclude-standard 'app/**/*.ts' 'app/**/*.tsx' 'lib/**/*.ts' 'lib/**/*.tsx' 'scripts/*.ts'", { cwd: process.cwd(), encoding: "utf8" }).split("\n").filter(Boolean)
}

async function main() {
  pureLayer()
  await memoryLayer()
  wiringLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ GAMIFICATION_FAIL\n" + fails.map((f) => `   - ${f}`).join("\n")); process.exit(1) }
  console.log(" ✅ GAMIFICATION_OK")
}
main().catch((e) => { console.error(e); process.exit(1) })
