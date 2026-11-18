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
  POINT_EARNING_ACTIONS, isoWeekStartUtc,
} from "../lib/gamification/award-points"
import { AWARD_CENSUS } from "../lib/gamification/award-census"
import { REFERRAL_TERMINAL_WON } from "../lib/referrals/referral-status"
import { awardLifecycleMilestones, awardBadgeToAgent } from "../lib/gamification/lifecycle-awards"
import { tierDistributionLine, tierForPoints } from "../lib/gamification/tiers"
import { isUnderStrain, strainedFromRows } from "../lib/gamification/strain"
import { anniversaryYearsOn, ANNIVERSARY_WINDOW_DAYS, anniversaryStartDate } from "../lib/gamification/work-anniversaries"

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
  // RE-ASSERTED (wave 154, lane 154E): REFERRAL_RECEIVED left the covered list ON PURPOSE — createReferral is a seat typing
  // its own record (the fabricated-achievement shape). The referral earns on its evidenced OUTCOME; a client review is added.
  check("customer lifecycle covered: kept anniversary touch, referral converted (evidenced), client review, repeat client — and a bare referral entry is NOT",
    [KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT, KernelEvent.REFERRAL_CONVERTED, KernelEvent.REVIEW_RECEIVED].every(covered) && !covered(KernelEvent.REFERRAL_RECEIVED) &&
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
  const kept = planLifecycleAwards(KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT, { entityId: CONTACT, now })[0]
  check("a kept client touch (LIFETIME_CUSTOMER_TOUCHPOINT_SENT — the touch itself, wave 104) is once per contact per year (reference AND since)",
    !!kept && kept.reason === "LIFETIME_TOUCHPOINT_KEPT" && kept.once.referenceId === CONTACT && kept.once.since?.getUTCFullYear() === 2026)
  check("POSITIVE CONTROL: ANNIVERSARY_TRIGGERED (a calendar date, not a kept touch) plans nothing any more", planLifecycleAwards(KernelEvent.ANNIVERSARY_TRIGGERED, { entityId: CONTACT, now }).length === 0)
  const sellerLifetime = planLifecycleAwards(KernelEvent.LIFETIME_CUSTOMER, { entityId: CONTACT, now, metadata: { side: "seller", agent_id: AGENT } })
  check("LIFETIME_CUSTOMER with metadata.side 'seller' plans SELLER_LIFETIME_TRANSITION once per contact (wave 104: the seller transition emits, the reactor awards)",
    sellerLifetime.length === 1 && sellerLifetime[0].reason === "SELLER_LIFETIME_TRANSITION" && sellerLifetime[0].once.referenceId === CONTACT)
  check("POSITIVE CONTROL: the buyer-side LIFETIME_CUSTOMER (no seller side) plans nothing — the seller award never leaks onto a buyer",
    planLifecycleAwards(KernelEvent.LIFETIME_CUSTOMER, { entityId: CONTACT, now, metadata: { side: "buyer" } }).length === 0 && planLifecycleAwards(KernelEvent.LIFETIME_CUSTOMER, { entityId: CONTACT, now }).length === 0)
  // RE-ASSERTED (wave 154, lane 154E): the referral award moved from the self-typed record onto the evidenced close.
  check("REFERRAL_RECEIVED (a seat-typed referral record) plans NOTHING", planLifecycleAwards(KernelEvent.REFERRAL_RECEIVED, { entityId: CONTACT, now, metadata: { referral_id: U(60) } }).length === 0)
  check("REFERRAL_CONVERTED without server-found evidence plans nothing; with it, keys on the EVIDENCE transaction (not the referral)",
    planLifecycleAwards(KernelEvent.REFERRAL_CONVERTED, { entityId: U(60), now }).length === 0 &&
      planLifecycleAwards(KernelEvent.REFERRAL_CONVERTED, { entityId: U(60), now, referralEvidenceTransactionId: TX })[0]?.once.referenceId === TX)
  const mentorPlan = planLifecycleAwards(KernelEvent.MENTOR_SESSION_HELD, { entityId: SESSION, now, metadata: { relationship_id: U(70) } })[0]
  check("MENTOR_SESSION_HELD credits mentor AND mentee once per PAIRING per ISO week (Monday 00:00 UTC) — not per session row",
    mentorPlan?.party === "mentor_and_mentee" && mentorPlan.once.referenceId === U(70) && mentorPlan.once.since?.toISOString() === "2026-10-05T00:00:00.000Z" &&
      planLifecycleAwards(KernelEvent.MENTOR_SESSION_HELD, { entityId: SESSION, now }).length === 0)
  check("isoWeekStartUtc: a Sunday belongs to the week that began the previous Monday", isoWeekStartUtc(new Date("2026-10-11T23:00:00Z")).toISOString() === "2026-10-05T00:00:00.000Z")
  const review = (rating: number | null) => planLifecycleAwards(KernelEvent.REVIEW_RECEIVED, { entityId: U(80), entityType: "agent_review", now, metadata: { rating, contact_id: CONTACT } })
  check("REVIEW_RECEIVED: a 5-star or a testimonial (no rating) plans CLIENT_REVIEW_RECEIVED once per client per year; a 2-star plans nothing",
    review(5)[0]?.reason === "CLIENT_REVIEW_RECEIVED" && review(5)[0]?.once.referenceId === CONTACT && review(null).length === 1 && review(2).length === 0)
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
  // WAVE 154 (154E): m968's award_agent_points_once — "present" (the lock + re-read inside one synchronous step, as the
  // advisory lock makes it) or "missing" (PGRST202: the pre-m968 database, where the app's read-then-write fallback runs).
  let onceRpc: "present" | "missing" = "present"
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
  // award_agent_points — THE writer (rpcCalls counts its invocations, direct or delegated from the once-RPC).
  const writer = (args: Record<string, unknown>) => {
    rpcCalls++
    const agent = t("agents").find((a) => a.id === args.p_agent_id)
    if (!agent) return { data: null, error: { message: "no agents row" } }
    agent.gamification_points = (agent.gamification_points ?? 0) + Number(args.p_points)
    const log = { id: U(700 + t("agent_points_log").length), agent_id: agent.id, brokerage_id: agent.brokerage_id, points: args.p_points, reason: args.p_reason, reference_type: args.p_reference_type, reference_id: args.p_reference_id, created_at: new Date().toISOString() }
    t("agent_points_log").push(log)
    return { data: { brokerage_id: agent.brokerage_id, points_added: args.p_points, new_total: agent.gamification_points, log_id: log.id } as any, error: null }
  }
  const client: LedgerCapableClient & { tables: Record<string, Row[]>; rpcCalls: () => number; refuse: (t: string | null) => void; setOnceRpc: (m: "present" | "missing") => void } = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "award_agent_points") return writer(args)
      if (fn === "award_agent_points_once") {
        if (onceRpc === "missing") return { data: null, error: { message: "Could not find the function public.award_agent_points_once", code: "PGRST202" } as any }
        if (refuseRead === "agent_points_log") return { data: null, error: { message: "refused agent_points_log" } }
        // No await between the read and the write — the advisory lock's guarantee, modelled.
        const since = args.p_since ? String(args.p_since) : null
        const standing = t("agent_points_log").some((r) => r.agent_id === args.p_agent_id && r.reason === args.p_reason &&
          (args.p_reference_id == null || r.reference_id === args.p_reference_id) && (since == null || String(r.created_at) >= since))
        if (standing) return { data: { already_awarded: true, agent_id: args.p_agent_id }, error: null }
        const w = writer(args)
        return w.error ? w : { data: { ...w.data, already_awarded: false }, error: null }
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } }
    },
    tables, rpcCalls: () => rpcCalls, refuse: (x) => { refuseRead = x }, setOnceRpc: (m) => { onceRpc = m },
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
  const mentor = await awardLifecycleMilestones(m, { event: KernelEvent.MENTOR_SESSION_HELD, brokerageId: BRK, entityType: "mentor_session", entityId: SESSION, metadata: { mentor_agent_id: AGENT, mentee_agent_id: AGENT2, relationship_id: U(70) } })
  const mentorSecond = await awardLifecycleMilestones(m, { event: KernelEvent.MENTOR_SESSION_HELD, brokerageId: BRK, entityType: "mentor_session", entityId: U(41), metadata: { mentor_agent_id: AGENT, mentee_agent_id: AGENT2, relationship_id: U(70) } })
  // RE-ASSERTED (wave 154): "once per session" was once per CLICK (every log inserted a new session row). The rule now: a
  // second session on the same pairing in the same week lands nothing.
  check("MENTOR_SESSION_HELD credits both parties, 75 each; a second session row on the same pairing this week lands nothing",
    mentor.awarded.length === 2 && mentor.awarded.every((a) => a.points === POINT_VALUES.MENTOR_SESSION_HELD) && new Set(mentor.awarded.map((a) => a.agentId)).size === 2 &&
      mentorSecond.awarded.length === 0 && mentorSecond.alreadyAwarded === 2)
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
  // WAVE 153 (lane 153I): the private wrapper the old check pinned (`awardBadgeToAgent(supabase, data)`) was retired with the
  // threshold loop it served; the RULE is unchanged — one insert site, and the action module DELEGATES (now to the stored-total
  // threshold awarder) rather than writing agent_badges itself.
  // RE-ASSERTED (wave 154, lane 154E): m968 takes agent_badges writes from session seats, so the delegation runs on the service
  // client — the rule is unchanged (one insert site, the action delegates) plus: the tenant handed down is the SESSION's.
  check(`agent_badges is inserted from lifecycle-awards.ts only (${badgeInserts.length} site) — app/actions/gamification.ts delegates with the SESSION tenant`, badgeInserts.length === 1 && badgeInserts[0] === "lib/gamification/lifecycle-awards.ts" && /awardThresholdBadges\(createServiceClient\(\), \{ agentId, brokerageId: caller\.brokerageId \}\)/.test(src("app/actions/gamification.ts")) && !/from\(\s*"agent_badges"\s*\)\s*\.insert/.test(src("app/actions/gamification.ts")))
  check("positive control: the finder sees an insert when one exists", /from\(\s*"agent_badges"\s*\)\s*\.insert\(/.test(lifecycleSrc))
  check("award-points.ts (imported by a Client Component) carries NO edge into the server-only emit graph; lifecycle-awards.ts carries it", !/lib\/kernel\/emit/.test(awardSrc) && /import\("@\/lib\/kernel\/emit"\)/.test(lifecycleSrc))

  // Call sites emit, they do not award.
  const showings = src("app/components/dashboard/listings/showings/confirmed-showings-list.tsx")
  const referrals = src("app/referrals/referrals-os-client.tsx")
  check("confirmed-showings-list no longer awards client-side; markShowingCompleted emits SHOWING_COMPLETED", !/awardPointsForAction/.test(showings) && /KernelEvent\.SHOWING_COMPLETED/.test(src("app/actions/seller-showings.ts")))
  check("referrals-os-client no longer awards client-side; createReferral emits REFERRAL_RECEIVED", !/awardPointsForAction/.test(referrals) && /KernelEvent\.REFERRAL_RECEIVED/.test(src("app/actions/referrals/referral-actions.ts")))
  check("positive control: the raw source still carries the tombstones that name the survivor", /awardPointsForAction/.test(raw("app/components/dashboard/listings/showings/confirmed-showings-list.tsx")))
  // WAVE 153 (lane 153I): the old check required `offer_submitted:` to STAY in app/lib/gamification/award-on-action.ts's
  // ACTION_MAP (a waypoint). That module — a public "use server" door awarding on a click — is retired; its last three keys
  // moved onto verified moments (OFFER_SUBMITTED, SOCIAL_POST_PUBLISHED) or were dropped (a review-request DRAFT is not a
  // review). The RULE it served is asserted in [verified outcomes only] below: no client-callable award door exists.
  check("no product source (app/, lib/) imports the retired client award door (app/lib/gamification/award-on-action.ts)", !all.filter((f) => !f.startsWith("scripts/")).some((f) => /from\s+["']@\/app\/lib\/gamification\/award-on-action["']/.test(src(f))))
  check("mentor-session emits MENTOR_SESSION_HELD and awards nothing itself", /KernelEvent\.MENTOR_SESSION_HELD/.test(src("app/actions/onboarding/mentor-session.ts")) && !/awardAgentPoints/.test(src("app/actions/onboarding/mentor-session.ts")))
  check("ce-provider emits CE_COMPLETED on a NEW completion row (inside the !existing branch)", /if \(!existing\) \{[\s\S]*?KernelEvent\.CE_COMPLETED/.test(src("app/actions/ce-provider.ts")))
  check("the weekly recruit-outreach cron runs runWorkAnniversariesAll (same cron as the leaderboard writer)", /runWorkAnniversariesAll\(supabase\)/.test(src("app/api/cron/recruit-outreach/route.ts")) && /runLeaderboardSnapshotAll\(supabase\)/.test(src("app/api/cron/recruit-outreach/route.ts")))
  const ev = src("lib/kernel/events.ts")
  check("KernelEvent carries the three new lifecycle members", /MENTOR_SESSION_HELD\s*=\s*'mentor_session_held'/.test(ev) && /CE_COMPLETED\s*=\s*'ce_completed'/.test(ev) && /AGENT_WORK_ANNIVERSARY\s*=\s*'agent_work_anniversary'/.test(ev))
  for (const name of ["MENTOR_SESSION_HELD", "CE_COMPLETED", "AGENT_WORK_ANNIVERSARY"]) {
    const emitters = all.filter((f) => !/lib\/kernel\/events\.ts|award-points\.ts|^scripts\//.test(f) && new RegExp(`KernelEvent\\.${name}\\b`).test(src(f)))
    check(`${name} has a real emitter (${emitters.join(", ") || "none"})`, emitters.length >= 1)
  }

  // WAVE 104 (lane 104E) — the wave-103 remainders closed on survivors.
  const ledger = src("lib/sphere/lifetime-touchpoint-ledger.ts")
  check("lifetime touches: ONE sent-row writer + ONE LIFETIME_CUSTOMER_TOUCHPOINT_SENT emit (lib/sphere/lifetime-touchpoint-ledger.ts), metadata.agent_id for the reactor's acting-agent resolution",
    (ledger.match(/from\("lifetime_customer_touchpoints"\)/g) ?? []).length === 1 && /KernelEvent\.LIFETIME_CUSTOMER_TOUCHPOINT_SENT/.test(ledger) && /agent_id: p\.agentId/.test(ledger) && /if \(error\) return \{ ok: false/.test(ledger))
  const touchActions = ["app/actions/lifetime-customer-touchpoints.ts", "app/actions/lifetime-customers.ts"]
  // RULE, not a count (wave 143E retired the day-3/day-30 referral sender onto the review engine): EVERY exported sender in
  // the touchpoints action file records through recordLifetimeTouchpointSent, none inserts a sent row itself.
  const senderCount = (src("app/actions/lifetime-customer-touchpoints.ts").match(/^export async function send\w+\(/gm) ?? []).length
  check(`the former sent-row inserters (${senderCount} exported senders + the manual log + the market update) call recordLifetimeTouchpointSent and insert no sent row themselves (stripped source)`,
    touchActions.every((f) => !/from\("lifetime_customer_touchpoints"\)\s*\.insert/.test(src(f))) && senderCount >= 2 && (src("app/actions/lifetime-customer-touchpoints.ts").match(/recordLifetimeTouchpointSent\(/g) ?? []).length === senderCount && (src("app/actions/lifetime-customers.ts").match(/recordLifetimeTouchpointSent\(/g) ?? []).length === 2)
  // Wave 142 (lane 142C): the scheduled-row writer moved from the close command onto the ONE lifetime writer (promoteDealContactsToLifetime).
  check("POSITIVE CONTROL: the scheduled-row writer (lib/kernel/lifetime-conversion.ts promoteDealContactsToLifetime, status 'scheduled' on conversion — not a send) still inserts and is NOT routed through the sent ledger", /from\("lifetime_customer_touchpoints"\)\.insert\(rows\)/.test(src("lib/kernel/lifetime-conversion.ts")) && !/from\("lifetime_customer_touchpoints"\)\.insert\(/.test(src("lib/kernel/transactions.ts")))
  const sellerSrc = src("lib/application/listing-lifecycle.ts")
  const sellerFn = sellerSrc.slice(sellerSrc.indexOf("export async function handleSellerToLifetimeTransition("), sellerSrc.indexOf("export async function advanceListingStageService("))
  check("handleSellerToLifetimeTransition emits LIFETIME_CUSTOMER (side 'seller', metadata.agent_id) and awards nothing itself", /KernelEvent\.LIFETIME_CUSTOMER,/.test(sellerFn) && /side: "seller", agent_id: agentRecordId/.test(sellerFn) && !/awardAgentPoints/.test(sellerFn))
  const onboardingSrc = src("lib/kernel/agent-onboarding.ts")
  check("agent-onboarding emits ONBOARDING_COMPLETED on the false→true completion edge (entity agent_onboarding) and awards nothing itself", /if \(isComplete && !wasAlreadyComplete\) \{[\s\S]*?KernelEvent\.ONBOARDING_COMPLETED/.test(onboardingSrc) && /entityType: "agent_onboarding"/.test(onboardingSrc) && !/awardAgentPoints/.test(onboardingSrc))
  // RE-ASSERTED (wave 154, lane 154E): the challenge prize now goes through awardAgentPointsOnce (it re-paid on a failed
  // "ended" stamp). The rule is unchanged — exactly these two domain call sites award, through the ONE module.
  const remaining = ["app/actions/contact-reassignment.ts", "lib/recruiting/challenge-runner.ts"].filter((f) => /awardAgentPoints(?:Once)?\(/.test(src(f)))
  check("exactly two domain call-site awards remain (CONTACT_ASSIGNED: A→B→A repeats; CHALLENGE_PRIZE: data-driven points, now ONCE per challenge per winner)", remaining.length === 2 && /awardAgentPointsOnce\(svc, \{[\s\S]*?once: \{ referenceId: c\.id \}/.test(src("lib/recruiting/challenge-runner.ts")) && !/awardAgentPoints\(/.test(src("lib/application/listing-lifecycle.ts")) && !/awardAgentPoints\(/.test(src("lib/kernel/agent-onboarding.ts")))
  // RE-ASSERTED (wave 146, lane 146I): the old pin was the literal select("id, created_at, anniversary_date") — a waypoint the
  // agreement-sourced start date (agents.start_date, m858, wave 145 contract C6) had to move. The RULE: the start date of
  // record wins, then the seat stamp, then created_at, and the roster read selects every column the rule reads (derived).
  {
    const ann = src("lib/gamification/work-anniversaries.ts")
    const cols = (ann.match(/ANNIVERSARY_ROSTER_COLUMNS\s*=\s*"([^"]+)"/)?.[1] ?? "").split(",").map((c) => c.trim())
    const ruleReads = ["start_date", "anniversary_date", "created_at"]
    check("anniversaries count from the executed agreement's start date (agents.start_date), else the seat stamp, else created_at — and the roster read selects every column the rule reads (POSITIVE CONTROL: a list missing start_date is caught)",
      anniversaryStartDate({ created_at: "2024-01-01", anniversary_date: "2023-06-01", start_date: "2022-03-15" }) === "2022-03-15"
      && anniversaryStartDate({ created_at: "2024-01-01", anniversary_date: "2023-06-01", start_date: null }) === "2023-06-01"
      && anniversaryStartDate({ created_at: "2024-01-01", anniversary_date: null }) === "2024-01-01"
      && ruleReads.every((c) => cols.includes(c)) && /\.select\(ANNIVERSARY_ROSTER_COLUMNS\)/.test(ann)
      && !ruleReads.every((c) => ["id", "created_at", "anniversary_date"].includes(c)))
  }
  // The doors are derived (the files that still INSERT an agents row); wave 140F converged the recruiting
  // route onto lib/kernel/users.ts, so a converged door drops out instead of failing a pinned list.
  const seatDoors = ["lib/kernel/users.ts", "app/actions/agents.ts", "app/api/recruiting/provision-agent/route.ts"].filter((f) => /from\("agents"\)[\s\S]{0,400}?\.(insert|upsert)\(/.test(src(f)))
  check(`every agents-row provisioning door stamps anniversary_date (the writer the column lacked) — doors: ${seatDoors.join(", ")}`, seatDoors.length >= 2 && seatDoors.every((f) => /anniversary_date: new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(src(f))))
  check("POSITIVE CONTROL: the stamp finder does not match a file that only READS the column", !/anniversary_date: new Date\(\)/.test(src("lib/gamification/work-anniversaries.ts")))

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
  // WAVE 153 (lane 153I): the threshold awarder moved to lifecycle-awards.ts awardThresholdBadges — the rule follows it.
  check("threshold badges and milestone badges never overlap: the threshold awarder filters to points_threshold", /trigger_event \?\? "points_threshold"\) === "points_threshold"/.test(src("lib/gamification/lifecycle-awards.ts")) && /export async function awardThresholdBadges/.test(src("lib/gamification/lifecycle-awards.ts")))

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

// ─── WAVE 153 (lane 153I) — VERIFIED OUTCOMES ONLY ────────────────────────────
// Owner ruling 17 ("check that the gamification system works properly") + directive I4 ("credit from real verified outcomes;
// avoid reward farming or double points on event retries"). Measured at 34124d98: two PUBLIC "use server" exports awarded on
// a click — app/actions/gamification.ts addPoints(agentId, ANY POINT_VALUES reason) and app/lib/gamification/award-on-action.ts
// awardPointsForAction — and m484's RPC admits an agent crediting itself, so a seat could farm FIRST_CLOSE in a loop; the
// public checkAndAwardBadges awarded threshold badges against a caller-supplied total; /dashboard/motivation advertised points
// for four actions nothing awarded; reactor awards (closings, showings) never reached the threshold badges at all.
async function verifiedOutcomesLayer() {
  console.log("\n[wave 153 · verified outcomes only — no farming door, no double award, no promise nothing keeps]")
  const now = new Date("2026-11-14T12:00:00Z")
  // Pure: the two moments the client awards moved onto.
  const offer = planLifecycleAwards(KernelEvent.OFFER_SUBMITTED, { entityId: CONTACT, now, entityType: "buyer_lifecycle" })
  check("OFFER_SUBMITTED on the buyer lifecycle plans OFFER_SUBMITTED once per buyer contact", offer.length === 1 && offer[0].reason === "OFFER_SUBMITTED" && offer[0].once.referenceId === CONTACT)
  const pubPost = planLifecycleAwards(KernelEvent.SOCIAL_POST_PUBLISHED, { entityId: U(60), now, entityType: "social_post" })
  check("the publisher's SOCIAL_POST_PUBLISHED (entity social_post) plans SOCIAL_POST_PUBLISHED once per post", pubPost.length === 1 && pubPost[0].once.referenceId === U(60))
  const draft = planLifecycleAwards(KernelEvent.SOCIAL_POST_PUBLISHED, { entityId: U(61), now, entityType: "ai_generated_content" })
  check("ADVERSE: the same event emitted for a generated DRAFT (entity ai_generated_content) earns nothing", draft.length === 0)
  check("ADVERSE: an emitter that names no entity type earns nothing on an entity-keyed rule", planLifecycleAwards(KernelEvent.SOCIAL_POST_PUBLISHED, { entityId: U(62), now }).length === 0)

  // Memory: a double event lands once; the threshold badge rides the STORED total.
  const POST = U(63), TBADGE = U(51)
  const m = memoryClient({
    agents: [{ id: AGENT, brokerage_id: BRK, user_id: U(5), gamification_points: 90 }, { id: AGENT2, brokerage_id: BRK, user_id: U(6), gamification_points: 0 }],
    social_posts: [{ id: POST, brokerage_id: BRK, agent_id: null, user_id: U(6) }],
    contacts: [{ id: CONTACT, brokerage_id: BRK, agent_id: AGENT }],
    gamification_badges: [{ id: TBADGE, brokerage_id: null, badge_name: "Century", badge_tier: "bronze", trigger_event: "points_threshold", is_active: true, required_points: 100 }],
  })
  const p1 = await awardLifecycleMilestones(m, { event: KernelEvent.SOCIAL_POST_PUBLISHED, brokerageId: BRK, entityType: "social_post", entityId: POST, metadata: { platform: "facebook" } })
  const p2 = await awardLifecycleMilestones(m, { event: KernelEvent.SOCIAL_POST_PUBLISHED, brokerageId: BRK, entityType: "social_post", entityId: POST, metadata: { platform: "facebook" } })
  check("a published post with no agent_id resolves its author through social_posts.user_id → agents.user_id and awards ONCE; the double event lands nothing",
    p1.awarded.length === 1 && p1.awarded[0].agentId === AGENT2 && p1.awarded[0].points === POINT_VALUES.SOCIAL_POST_PUBLISHED && p2.awarded.length === 0 && p2.alreadyAwarded === 1)
  const o1 = await awardLifecycleMilestones(m, { event: KernelEvent.OFFER_SUBMITTED, brokerageId: BRK, entityType: "buyer_lifecycle", entityId: CONTACT })
  check("OFFER_SUBMITTED credits the buyer's agent (contacts.agent_id) and crosses 100 → the threshold badge lands from the STORED total",
    o1.awarded.length === 1 && o1.awarded[0].agentId === AGENT && o1.badgesAwarded === 1 && m.tables.agent_badges.some((b) => b.badge_id === TBADGE && b.agent_id === AGENT))
  const o2 = await awardLifecycleMilestones(m, { event: KernelEvent.OFFER_SUBMITTED, brokerageId: BRK, entityType: "buyer_lifecycle", entityId: CONTACT })
  check("ADVERSE: the buyer's stage re-entered (a retried / repeated OFFER_SUBMITTED) awards nothing and mints no second badge",
    o2.awarded.length === 0 && m.tables.agent_badges.filter((b) => b.badge_id === TBADGE).length === 1)
  const { awardThresholdBadges } = await import("../lib/gamification/lifecycle-awards")
  const low = await awardThresholdBadges(m, { agentId: AGENT2 })
  check("ADVERSE: an agent whose stored total is below the bar gets no threshold badge (the total is read, never handed in)", low.awarded.length === 0 && !m.tables.agent_badges.some((b) => b.agent_id === AGENT2 && b.badge_id === TBADGE))

  // Census: no client-callable award door remains.
  const all = listSources()
  const useServer = all.filter((f) => f.startsWith("app/") && /^\s*["']use server["']/.test(raw(f)))
  const AWARD_CALL = /awardAgentPoints(Once)?\s*\(/
  const exportedAwarders = useServer.filter((f) => /export\s+async\s+function\s+\w+/.test(src(f)) && AWARD_CALL.test(src(f)))
  // Each remaining award inside a public module is decided by the SERVER on a verified fact, never on the caller's say-so.
  const SERVER_VERIFIED: Record<string, string> = {
    "app/actions/contact-reassignment.ts": "CONTACT_ASSIGNED after the reassignment itself is authorized and written (no canonical event exists — wave 103 blind spot)",
    "app/actions/challenges.ts": "challenge prizes awarded by the scorer on a challenge that ENDED",
    // WAVE 154 (154E): the ONE correction door — tenant admin minus team_lead / compliance_officer, never self, a reason,
    // a once-key, withActionLedger audit (proved in awardPathLayer). Not a self-award: the caller's own record is refused.
    "app/actions/gamification.ts": "correctAgentPoints — an audited admin correction on the same ledger, never to the caller's own record",
  }
  const unexpected = exportedAwarders.filter((f) => !SERVER_VERIFIED[f])
  check(`no "use server" module awards points on a caller's say-so (${exportedAwarders.length} award site(s) inside public modules, each server-verified: ${exportedAwarders.join(", ") || "none"})`, unexpected.length === 0)
  check("POSITIVE CONTROL: the census sees an award call inside a public export, and not inside a comment", AWARD_CALL.test(stripComments("export async function x() { await awardAgentPoints(db, {}) }")) && !AWARD_CALL.test(stripComments("// awardAgentPoints(db, {})\nexport async function y() {}")))
  check("POSITIVE CONTROL: the retired-door import finder sees a real import", /from\s+["']@\/app\/lib\/gamification\/award-on-action["']/.test('import { awardPointsForAction } from "@/app/lib/gamification/award-on-action"'))
  const gam = src("app/actions/gamification.ts")
  // RE-ASSERTED (wave 154, lane 154E): the module may now hold ONE award call — inside the gated correctAgentPoints. Every
  // other export (the reads, checkAndAwardBadges) still calls no award wrapper.
  const gamOutsideCorrection = gam.replace(/export async function correctAgentPoints[\s\S]*?\n\}(?=\n|$)/, "")
  check("app/actions/gamification.ts exports no addPoints and calls no award wrapper outside the gated correctAgentPoints", !/export\s+async\s+function\s+addPoints\b/.test(gam) && !AWARD_CALL.test(gamOutsideCorrection) && gamOutsideCorrection !== gam)
  check("checkAndAwardBadges ignores a caller-supplied total (the argument is never read; awardThresholdBadges reads agents.gamification_points)",
    /export async function checkAndAwardBadges\(agentId: string, _currentPoints\?: number\)/.test(gam) && (gam.match(/_currentPoints/g) ?? []).length === 1 && /select\("id, brokerage_id, gamification_points"\)/.test(src("lib/gamification/lifecycle-awards.ts")))

  // The surface promises only what is awarded.
  const { POINT_EARNING_ACTIONS } = await import("../lib/gamification/award-points")
  const ruleReasons = new Set(LIFECYCLE_AWARD_RULES.map((r) => r.reason as string))
  check(`every action /dashboard/motivation advertises has a live award rule (${POINT_EARNING_ACTIONS.length} advertised)`, POINT_EARNING_ACTIONS.length > 0 && POINT_EARNING_ACTIONS.every((a) => ruleReasons.has(a.reason)))
  check("POSITIVE CONTROL: the label catalogue still names an unawarded action (training), so the filter is doing work", /reason: "TRAINING_COMPLETED"/.test(src("lib/gamification/award-points.ts")) && !ruleReasons.has("TRAINING_COMPLETED") && !POINT_EARNING_ACTIONS.some((a) => a.reason === "TRAINING_COMPLETED"))
}

// ─── WAVE 154 (lane 154E) — THE AWARD PATH, END TO END (all SIMULATED) ────────
// The owner: "why is the gamification award function retired? that function needs to work." This layer prints the award
// table DERIVED from the code (census × live rules × advertised list × emitters found in stripped source) and proves
// directive E5 against the in-memory client.

const STATE = { WORKING: "WORKING", NOT_SHOWN: "EARNABLE BUT NOT SHOWN", NOT_WIRED: "EMITTER NOT WIRED", NO_EMITTER: "NO EMITTER", LIE: "ADVERTISED BUT UNEARNABLE" } as const

function onceKeyOf(reason: string): string {
  const rules = LIFECYCLE_AWARD_RULES.filter((r) => r.reason === reason)
  if (rules.length === 0) return "—"
  return [...new Set(rules.map((r) => `${r.scope}${r.referenceFrom && r.referenceFrom !== "entity" ? `(${r.referenceFrom})` : r.scope.startsWith("per_reference") ? "(entity)" : ""}`))].join(" | ")
}

function awardTableLayer() {
  console.log("\n[THE AWARD TABLE — derived from LIFECYCLE_AWARD_RULES × AWARD_CENSUS × POINT_EARNING_ACTIONS × stripped source]")
  const advertised = new Set(POINT_EARNING_ACTIONS.map((a) => a.reason as string))
  const ruled = new Set(LIFECYCLE_AWARD_RULES.map((r) => r.reason as string))
  const reasons = [...Object.keys(POINT_VALUES), "CHALLENGE_PRIZE", "ADMIN_ADJUSTMENT"]
  check("every POINT_VALUES reason (and the two data-driven call-site reasons) has exactly one census row",
    reasons.every((r) => AWARD_CENSUS.filter((c) => c.reason === r).length === 1) && AWARD_CENSUS.length === reasons.length)
  const rows: string[][] = []
  const states: Record<string, string> = {}
  for (const reason of reasons) {
    const c = AWARD_CENSUS.find((x) => x.reason === reason)!
    const found = c.emitters.map((e) => { try { return src(e.file).includes(e.token) } catch { return false } })
    const emittersOk = c.emitters.length > 0 && found.every(Boolean)
    const earnable = (c.path === "reactor" && ruled.has(reason)) || c.path === "call_site"
    let state: string
    if (advertised.has(reason) && !(earnable && emittersOk)) state = STATE.LIE
    else if (earnable && emittersOk) state = advertised.has(reason) ? STATE.WORKING : STATE.NOT_SHOWN
    else if (!earnable && c.emitters.length > 0) state = STATE.NOT_WIRED
    else state = STATE.NO_EMITTER
    states[reason] = state
    if (earnable && !emittersOk) check(`${reason}: an award path exists but its emitter is gone (${c.emitters.map((e, i) => `${e.file}${found[i] ? "" : " MISSING"}`).join(", ")})`, false)
    if (c.path === "reactor" && !ruled.has(reason) && c.trust !== "self_attested" && c.trust !== "none") check(`${reason}: census says reactor-awarded but no LIFECYCLE_AWARD_RULES row grants it`, false)
    rows.push([reason, String((POINT_VALUES as Record<string, number>)[reason] ?? "data"), state, c.trust, onceKeyOf(reason), c.agent, c.emitters.map((e) => e.file).join(" + ") || "—", c.ownerDecision ? "OWNER" : ""])
  }
  const widths = [26, 5, 24, 16, 46]
  for (const r of rows) console.log(`  ${r.slice(0, 5).map((x, i) => x.padEnd(widths[i])).join(" ")} ${r[7]}\n      agent: ${r[5]}\n      emitter: ${r[6]}`)
  console.log("  every row: tenant = the agents row's brokerage (derived inside award_agent_points, never accepted) · write = award_agent_points_once →")
  console.log("  award_agent_points (agents.gamification_points += p, one agent_points_log row, one transaction) · milestone badge = catalog row whose")
  console.log("  trigger_event names the reason + threshold badges on the stored total · boards = runLeaderboardSnapshotAll (weekly cron) · UI =")
  console.log("  /dashboard/motivation (getAgentPointsAndTier, getAgentPointsHistory, getAgentBadges, getLeaderboard) · retry = once-key (replay lands")
  console.log("  nothing) · revocation = an ADMIN_ADJUSTMENT on the same ledger (correctAgentPoints); no row is ever edited or deleted by a seat")
  const count = (s: string) => Object.values(states).filter((x) => x === s).length
  console.log(`  totals: ${STATE.WORKING} ${count(STATE.WORKING)} · ${STATE.NOT_SHOWN} ${count(STATE.NOT_SHOWN)} · ${STATE.NOT_WIRED} ${count(STATE.NOT_WIRED)} · ${STATE.NO_EMITTER} ${count(STATE.NO_EMITTER)} · ${STATE.LIE} ${count(STATE.LIE)} (of ${reasons.length})`)
  check("no reason is ADVERTISED BUT UNEARNABLE", count(STATE.LIE) === 0)
  check("every advertised reason is a reactor award on a VERIFIED outcome (never a booking, never a seat's own assertion)",
    POINT_EARNING_ACTIONS.every((a) => AWARD_CENSUS.some((c) => c.reason === a.reason && c.path === "reactor" && c.trust === "verified_outcome")))
  check("every EMITTER NOT WIRED reason is self-attested and carries an owner decision (an event exists, deliberately unrewarded)",
    Object.entries(states).filter(([, s]) => s === STATE.NOT_WIRED).every(([r]) => { const c = AWARD_CENSUS.find((x) => x.reason === r)!; return c.trust === "self_attested" && !!c.ownerDecision }))
  check("the verified showing and the education milestones are advertised with their POINT_VALUES (SHOWING_COMPLETED, CERTIFICATION_EARNED, CE_COMPLETED)",
    ["SHOWING_COMPLETED", "CERTIFICATION_EARNED", "CE_COMPLETED"].every((r) => advertised.has(r)))
  check("unimplemented / untrusted reasons are NOT advertised: TRAINING_COMPLETED, OPEN_HOUSE_HOSTED, VENDOR_REVIEW_WRITTEN, FOLLOWUP_SENT, REFERRAL_CREATED, FIRST_APPOINTMENT",
    ["TRAINING_COMPLETED", "OPEN_HOUSE_HOSTED", "VENDOR_REVIEW_WRITTEN", "FOLLOWUP_SENT", "REFERRAL_CREATED", "FIRST_APPOINTMENT"].every((r) => !advertised.has(r)))
  // POSITIVE CONTROL: those reasons ARE in the label list — the derived filter is what keeps them off the page.
  const awardSrc = src("lib/gamification/award-points.ts")
  check("POSITIVE CONTROL: TRAINING_COMPLETED / OPEN_HOUSE_HOSTED still carry labels — the census filter, not a missing label, hides them",
    /reason: "TRAINING_COMPLETED", label:/.test(awardSrc) && /reason: "OPEN_HOUSE_HOSTED", label:/.test(awardSrc))
  check("POSITIVE CONTROL: the emitter finder reports a token that is not there", !src("lib/gamification/award-points.ts").includes("KernelEvent.NOT_A_REAL_EVENT_154E"))
  check("the Motivation page renders exactly POINT_EARNING_ACTIONS with POINT_VALUES (one list, one number)",
    /POINT_EARNING_ACTIONS\.map\(\(a\) =>/.test(src("app/dashboard/motivation/motivation-client.tsx")) && /POINT_VALUES\[a\.reason\]/.test(src("app/dashboard/motivation/motivation-client.tsx")))
}

/** Every "use server" module whose stripped source reaches an award writer. */
function serverAwardDoors(files: Array<{ path: string; text: string }>): string[] {
  return files.filter((f) => /^\s*["']use server["']/.test(f.text) && /awardAgentPoints(?:Once)?\(|rpc\(\s*["']award_agent_points/.test(stripComments(f.text))).map((f) => f.path)
}

async function awardPathLayer() {
  console.log("\n[E5 · a trusted close, replay / webhook / concurrent workers, the self-award refusal — SIMULATED]")
  const BADGE_T = U(51)
  const seed = () => ({
    agents: [{ id: AGENT, brokerage_id: BRK, user_id: U(5), gamification_points: 0 }, { id: AGENT2, brokerage_id: BRK, user_id: U(6), gamification_points: 0 },
      { id: U(3), brokerage_id: U(8), user_id: U(7), gamification_points: 0 }],
    transactions: [{ id: TX, brokerage_id: BRK, agent_id: AGENT, buyer_contact_id: CONTACT, seller_contact_id: null, status: "closed" }],
    gamification_badges: [
      { id: BADGE, brokerage_id: null, badge_name: "First Close", badge_tier: "silver", trigger_event: "FIRST_CLOSE", is_active: true, required_points: 0 },
      { id: BADGE_T, brokerage_id: null, badge_name: "Bronze", badge_tier: "bronze", trigger_event: "points_threshold", is_active: true, required_points: 300 },
    ],
  })
  const ledgerAgrees = (c: ReturnType<typeof memoryClient>) => c.tables.agents.every((a) =>
    (a.gamification_points ?? 0) === (c.tables.agent_points_log ?? []).filter((l) => l.agent_id === a.id).reduce((s, l) => s + Number(l.points), 0))

  // 1. A REAL trusted close.
  const m = memoryClient(seed())
  const close = { event: KernelEvent.TRANSACTION_CLOSED, brokerageId: BRK, entityType: "transaction", entityId: TX, metadata: { close_date: "2026-11-18" } }
  const r = await awardLifecycleMilestones(m, close)
  const agentRow = m.tables.agents.find((a) => a.id === AGENT)!
  check(`a trusted TRANSACTION_CLOSED awards LISTING_CLOSED ${POINT_VALUES.LISTING_CLOSED} + FIRST_CLOSE ${POINT_VALUES.FIRST_CLOSE}; total ${agentRow.gamification_points} = ledger sum; FIRST_CLOSE badge + the 300-point threshold badge once each`,
    JSON.stringify(r.awarded.map((a) => a.reason).sort()) === JSON.stringify(["FIRST_CLOSE", "LISTING_CLOSED"]) &&
      agentRow.gamification_points === POINT_VALUES.LISTING_CLOSED + POINT_VALUES.FIRST_CLOSE && ledgerAgrees(m) &&
      m.tables.agent_badges.filter((b) => b.badge_id === BADGE).length === 1 && m.tables.agent_badges.filter((b) => b.badge_id === BADGE_T).length === 1)
  check("agent_badges joins gamification_badges (every awarded badge_id is a catalog id, stamped with the agent's tenant)",
    m.tables.agent_badges.every((b) => m.tables.gamification_badges.some((g) => g.id === b.badge_id) && b.brokerage_id === BRK))

  // 2. Replay, a repeated webhook, concurrent workers.
  const replay = await awardLifecycleMilestones(m, close)
  check("a replayed close lands nothing (2 alreadyAwarded), mints no badge, total unchanged", replay.awarded.length === 0 && replay.alreadyAwarded === 2 && agentRow.gamification_points === 350 && m.tables.agent_badges.length === 2)
  const ce = { event: KernelEvent.CE_COMPLETED, brokerageId: BRK, entityType: "agent_ce_completion", entityId: U(90), metadata: { agent_id: AGENT2 } }
  const w1 = await awardLifecycleMilestones(m, ce); const w2 = await awardLifecycleMilestones(m, ce)
  check("a repeated CE provider webhook for the same completion awards once", w1.awarded.length === 1 && w2.awarded.length === 0 && m.tables.agent_points_log.filter((l) => l.reason === "CE_COMPLETED").length === 1)
  const fresh = memoryClient(seed())
  const triple = await Promise.all([1, 2, 3].map(() => awardLifecycleMilestones(fresh, close)))
  check(`three concurrent workers on one close award once (award_agent_points_once present): ${fresh.tables.agent_points_log.length} ledger rows`,
    fresh.tables.agent_points_log.length === 2 && triple.reduce((s, x) => s + x.awarded.length, 0) === 2 && ledgerAgrees(fresh))
  // NEGATIVE CONTROL — the base: without m968 the read-then-write fallback lets concurrent twins both land.
  const base = memoryClient(seed()); base.setOnceRpc("missing")
  await Promise.all([1, 2].map(() => awardAgentPointsOnce(base, { agentId: AGENT, points: 100, reason: "LISTING_CLOSED", once: { referenceId: TX } })))
  check(`NEGATIVE CONTROL (base behavior): with award_agent_points_once missing, two concurrent awards BOTH land (${base.tables.agent_points_log.length} rows) — the race m968 closes`, base.tables.agent_points_log.length === 2)
  const seq = memoryClient(seed()); seq.setOnceRpc("missing")
  await awardAgentPointsOnce(seq, { agentId: AGENT, points: 100, reason: "LISTING_CLOSED", once: { referenceId: TX } })
  const seq2 = await awardAgentPointsOnce(seq, { agentId: AGENT, points: 100, reason: "LISTING_CLOSED", once: { referenceId: TX } })
  check("the pre-m968 fallback still declines a SEQUENTIAL replay (said aloud, not silent)", seq.tables.agent_points_log.length === 1 && seq2.ok && "alreadyAwarded" in seq2)

  // 3. Self-submitted FIRST_CLOSE with no evidence.
  const forged = await awardLifecycleMilestones(memoryClient(seed()), { event: KernelEvent.TRANSACTION_CLOSED, brokerageId: BRK, entityType: "transaction", entityId: U(99), metadata: {} })
  check("a FIRST_CLOSE claimed on a transaction that does not exist in the tenant awards nothing and says why", forged.awarded.length === 0 && forged.refused.some((x) => /FIRST_CLOSE: no agents\.id/.test(x)))
  const crossTenant = await awardLifecycleMilestones(memoryClient(seed()), { event: KernelEvent.TRANSACTION_CLOSED, brokerageId: U(8), entityType: "transaction", entityId: TX, metadata: {} })
  check("the same close named under ANOTHER tenant awards nothing (resolution is tenant-scoped)", crossTenant.awarded.length === 0)
  const files = listSources().filter((f) => f.startsWith("app/") || f.startsWith("lib/")).map((p) => ({ path: p, text: raw(p) }))
  const doors = serverAwardDoors(files).sort()
  check(`"use server" modules that reach an award writer are exactly the two gated ones (${doors.join(", ")}) — the admin correction and the admin reassignment`,
    JSON.stringify(doors) === JSON.stringify(["app/actions/contact-reassignment.ts", "app/actions/gamification.ts"]))
  check("POSITIVE CONTROL: the door finder flags a client-callable award (the retired addPoints shape)",
    serverAwardDoors([{ path: "specimen.ts", text: `"use server"\nexport async function addPoints(agentId: string) { return awardAgentPoints(db, { agentId, points: 250, reason: "FIRST_CLOSE" }) }` }]).length === 1 &&
      serverAwardDoors([{ path: "specimen.ts", text: `"use server"\n// awardAgentPoints(db, {...}) — a tombstone\nexport async function x() {}` }]).length === 0)
  const g = src("app/actions/gamification.ts")
  check("the retired door stays retired: no `export async function addPoints` and no app/lib/gamification/award-on-action.ts",
    !/export\s+async\s+function\s+addPoints\b/.test(g) && !listSources().includes("app/lib/gamification/award-on-action.ts"))
  const mig = raw("supabase/migrations/m968-gamification-awards-come-from-the-server-only.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  check("m968 closes the DATABASE door the owner's question was really about: award_agent_points EXECUTE revoked from authenticated; the once-award refuses any session; no session ledger INSERT; badges read-only to seats; the total trigger-held",
    /revoke execute on function public\.award_agent_points\(uuid, integer, text, text, uuid\) from anon, authenticated/.test(mig) &&
      /if auth\.uid\(\) is not null then\s+raise exception 'award_agent_points_once/.test(mig) &&
      /drop policy if exists agent_points_log_insert/.test(mig) && /drop policy if exists agent_badges_tenant on/.test(mig) && /for select to authenticated using/.test(mig) &&
      /before insert or update of gamification_points on public\.agents/.test(mig))
  check("POSITIVE CONTROL: the m484 grant m968 revokes is still in the history (the finder reads the real statement)",
    /grant execute on function public\.award_agent_points\(uuid, integer, text, text, uuid\) to authenticated/.test(raw("supabase/migrations/m484-a-board-read-in-one-vocabulary-and-written-in-another-can-never-show-a-row.sql")))

  console.log("\n[E3 · recovered paths — referral outcome, client review, mentor pairing — SIMULATED]")
  const REF = U(60), REF2 = U(61), REVIEW = U(80)
  const rc = memoryClient({ ...seed(), referrals: [{ id: REF, brokerage_id: BRK, agent_id: AGENT2, status: REFERRAL_TERMINAL_WON, transaction_id: null, referred_contact_id: U(22) }],
    agent_reviews: [{ id: REVIEW, brokerage_id: BRK, agent_id: AGENT }] })
  const noEvidence = await awardLifecycleMilestones(rc, { event: KernelEvent.REFERRAL_CONVERTED, brokerageId: BRK, entityType: "referral", entityId: REF, metadata: {} })
  check("a referral marked won with NO closed transaction behind it awards nothing and says so", noEvidence.awarded.length === 0 && noEvidence.refused.some((x) => /no closed transaction evidences/.test(x)))
  rc.tables.transactions.push({ id: TX_OLD, brokerage_id: BRK, agent_id: AGENT, buyer_contact_id: U(22), seller_contact_id: null, status: "closed" })
  const lateClose = await awardLifecycleMilestones(rc, { event: KernelEvent.TRANSACTION_CLOSED, brokerageId: BRK, entityType: "transaction", entityId: TX_OLD, metadata: {} })
  check("the referred contact's deal closing pays the WON referral's agent REFERRAL_CONVERTED once, keyed on that transaction",
    lateClose.awarded.some((a) => a.agentId === AGENT2 && a.reason === "REFERRAL_CONVERTED") && rc.tables.agent_points_log.some((l) => l.reason === "REFERRAL_CONVERTED" && l.reference_id === TX_OLD))
  rc.tables.referrals.push({ id: REF2, brokerage_id: BRK, agent_id: AGENT2, status: REFERRAL_TERMINAL_WON, transaction_id: TX_OLD, referred_contact_id: null })
  const again = await awardLifecycleMilestones(rc, { event: KernelEvent.REFERRAL_CONVERTED, brokerageId: BRK, entityType: "referral", entityId: REF2, metadata: {} })
  check("a SECOND referral record naming the same closed deal earns nothing more (one award per transaction per agent)",
    again.awarded.length === 0 && rc.tables.agent_points_log.filter((l) => l.reason === "REFERRAL_CONVERTED").length === 1)
  const rv = (contact: string, rating: number | null, id = REVIEW) => awardLifecycleMilestones(rc, { event: KernelEvent.REVIEW_RECEIVED, brokerageId: BRK, entityType: "agent_review", entityId: id, metadata: { rating, contact_id: contact } })
  const rv1 = await rv(CONTACT, 5); const rv2 = await rv(CONTACT, null); const rvLow = await rv(U(23), 2)
  check(`a client's 5-star review pays agent_reviews.agent_id ${POINT_VALUES.CLIENT_REVIEW_RECEIVED} once; the same client's next testimonial this year lands nothing; a 2-star earns nothing`,
    rv1.awarded.length === 1 && rv1.awarded[0].agentId === AGENT && rv2.awarded.length === 0 && rvLow.awarded.length === 0)
  check("every agent's stored total equals SUM(agent_points_log.points) after every scenario above", ledgerAgrees(rc) && ledgerAgrees(m) && ledgerAgrees(fresh))

  console.log("\n[E3/E4 · the admin correction, the mentor gate, the board scope, the read keys — stripped source + SIMULATED ledger]")
  const corr = U(95)
  const adj1 = await awardAgentPointsOnce(m, { agentId: AGENT, points: -50, reason: "ADMIN_ADJUSTMENT", referenceType: "points_correction", once: { referenceId: corr } })
  const adj2 = await awardAgentPointsOnce(m, { agentId: AGENT, points: -50, reason: "ADMIN_ADJUSTMENT", referenceType: "points_correction", once: { referenceId: corr } })
  check("an admin correction (−50) lands once on the SAME ledger; a double submit with the same correctionId lands nothing; total = ledger sum",
    adj1.ok && !("alreadyAwarded" in adj1) && adj2.ok && "alreadyAwarded" in adj2 && agentRow.gamification_points === 300 && ledgerAgrees(m))
  const corrFn = (g.match(/export async function correctAgentPoints[\s\S]*?\n\}(?=\n|$)/) ?? [""])[0]
  check("correctAgentPoints: session tenant (requireCaller), admin gate (resolveTenantAdmin / platform staff) minus team_lead + compliance_officer, never self, a reason, the once-key, withActionLedger audit, reconciliation",
    /requireCaller\(\)/.test(corrFn) && /resolveTenantAdmin\(/.test(corrFn) && /isPlatformStaffIdentity\(/.test(corrFn) && /"team_lead" \|\| userType === "compliance_officer"/.test(corrFn) &&
      /cannot correct your own points/.test(corrFn) && /reason\.length < 10/.test(corrFn) && /\.eq\("brokerage_id", caller\.brokerageId\)/.test(corrFn) &&
      /withActionLedger<Out>\(/.test(corrFn) && /once: \{ referenceId: input\.correctionId \}/.test(corrFn) && /reconciled:/.test(corrFn) && !/\.update\(\s*\{\s*gamification_points/.test(corrFn))
  const ms = src("app/actions/onboarding/mentor-session.ts")
  const logFn = (ms.match(/export async function logMentorSession[\s\S]*?\n\}(?=\n|$)/) ?? [""])[0]
  check("logMentorSession: session tenant, an ACTIVE agent_mentor_relationships pairing in it, the caller a party or tenant admin, relationship_id server-derived into the event",
    /requireCaller\(\)/.test(logFn) && /from\("agent_mentor_relationships"\)[\s\S]*?\.eq\("brokerage_id", brokerageId\)[\s\S]*?\.eq\("status", "active"\)/.test(logFn) &&
      /resolveTenantAdmin\(/.test(logFn) && /relationship_id: pairing\.id,/.test(logFn) && /relationship_id: pairing\.id, session_type/.test(logFn) && !/brokerage_id \?\? null/.test(logFn))
  const lb = (g.match(/export async function getLeaderboard[\s\S]*?\n\}(?=\n|$)/) ?? [""])[0]
  check("getLeaderboard: tenant from the SESSION users row; team = the viewer's own team or the team they LEAD (resolveLedTeamId on the session user); no caller-named team or tenant",
    /\.from\("users"\)[\s\S]*?\.eq\("id", user\.id\)/.test(lb) && /\.eq\("brokerage_id", profile\.brokerage_id\)/.test(lb) && /resolveLedTeamId\(supabase as any, user\.id\)/.test(lb) &&
      /query = query\.eq\("team_id", teamId\)/.test(lb) && !/options\.(teamId|brokerageId|team)\b/.test(lb))
  check("POSITIVE CONTROL: the scope finder would see a caller-named team", /options\.(teamId|brokerageId|team)\b/.test("query.eq('team_id', options.teamId)"))
  // Tier and board read the SAME column; the UI reads only keys the readers return.
  check("tier (getAgentPointsAndTier) and board (lifetimePoints) both read agents.gamification_points; the Motivation page reads points + currentTierId",
    /select\("id, gamification_points/.test(g) && /lifetimePoints: Number\(a\?\.gamification_points\)/.test(g) && /pointsResult\.points, tierId: pointsResult\.currentTierId/.test(src("app/dashboard/motivation/motivation-client.tsx")))
  check("tier for the simulated balance is one answer everywhere (tierForPoints(300) on both reads)", tierForPoints(agentRow.gamification_points) === tierForPoints(300))
  const rowKeys = new Set(((raw("lib/gamification/leaderboard-vocabulary.ts").match(/export interface LeaderboardRow \{([\s\S]*?)\n\}/) ?? ["", ""])[1].match(/^\s*(\w+)\s*:/gm) ?? []).map((k) => k.replace(/[\s:]/g, "")))
  const boardBlock = (src("app/dashboard/motivation/motivation-client.tsx").match(/<TableRow key=\{entry\.agentId\}[\s\S]*?<\/TableRow>/) ?? [""])[0]
  const uiKeys = [...new Set((boardBlock.match(/entry\.(\w+)/g) ?? []).map((k) => k.slice(6)))]
  check(`every board key the Motivation page reads (${uiKeys.join(", ")}) is a LeaderboardRow key the reader returns`, uiKeys.length >= 4 && uiKeys.every((k) => rowKeys.has(k)))
  check("POSITIVE CONTROL: the key finder rejects a key the reader does not return", !rowKeys.has("points") && rowKeys.has("score"))
  check("game mechanics never write compensation: no award module writes commissions / splits / recruiting payouts",
    ["lib/gamification/award-points.ts", "lib/gamification/lifecycle-awards.ts", "lib/gamification/award-census.ts"].every((f) => !/from\("(commission[a-z_]*|agent_splits|recruiting_payouts|revenue_share[a-z_]*)"\)/.test(src(f))))
  check("fatigue-aware protection stands: getAgentPointsAndTier still reads strain and returns underStrain", /isAgentUnderStrain\(supabase, agentId\)/.test(g) && /underStrain,/.test(g))
}

async function main() {
  pureLayer()
  await memoryLayer()
  wiringLayer()
  awardTableLayer()
  await awardPathLayer()
  await verifiedOutcomesLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ GAMIFICATION_FAIL\n" + fails.map((f) => `   - ${f}`).join("\n")); process.exit(1) }
  console.log(" ✅ GAMIFICATION_OK")
}
main().catch((e) => { console.error(e); process.exit(1) })
