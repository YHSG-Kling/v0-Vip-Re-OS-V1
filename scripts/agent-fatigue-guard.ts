#!/usr/bin/env tsx
/**
 * scripts/agent-fatigue-guard.ts   (npm run test:agent-fatigue) — pure, no network, no DB.
 *
 * WAVE 89 (lane 89C). Owner, verbatim: "brokerages need agent fatigue signals so they can give the
 * support that they are lacking before they decide to leave." · "lifetime customers get regular
 * touches within their portal to keep them engaged." · "you should add any fields necessary if
 * their is a beneficial reason to add."
 *
 * EXISTING CAPABILITY EXTENDED (wave 88 NO-REWRITES): the agent retention radar
 * (lib/recruiting/retention-radar.ts → retention-score.ts → agent_retention_scores) is the one
 * agent-attrition signal; it gains eight fatigue signals, raw_signals + support_suggested (m674), a
 * support nudge and fatigue-specific support plays. Contact fatigue (lib/fatigue) gains lifetime
 * customers, brokerage-tunable weights and a fatigue-tempered over-touch cap.
 *
 *   A  one scorer, one radar — no second module; the five original signals still score alone
 *   B  the eight sub-scores at their documented cuts (positive + negative controls); the composite
 *      moves the right way; driving signals carry the ONE label spelling; weakFatigueSignals
 *   C  clientResponsiveness — inbound→outbound pairing per contact, median lag, unanswered past window
 *   D  the support library — every fatigue label maps to a support play; dedupe; the old plays unchanged
 *   E  radar wiring (stripped source) — raw_signals + support_suggested written; every new read
 *      error-read; identity classes; the nudge: threshold, never the agent, team lead, dedupe
 *   F  NEVER AGENT-FACING — the coaching adapter's agent report carries no retention support; the
 *      manager message does; the board and command center read support_suggested
 *   G  m674 as a RULE (two additive columns), the CHECK words the new filters use
 *   H  the fatigue-tempered cap (pure + wiring) and the lifetime cron's honest counting / channels
 *   I  registration + cross-cooperation edges
 *
 * Owner: recruiting_manager. Co-owners named in prose: data_steward (identity classes, m674 columns)
 * and deal_coordinator (the appointment ledger and pipeline stages).
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import type { RetentionSignals, AgentFatigueSignalKey } from "../lib/recruiting/retention-score"

// index.ts / fatigue-calculator import `server-only`; neutralise it BEFORE any dynamic import.
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not resolvable — nothing to shim */ }

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const code = (p: string) => blankStrings(stripComments(read(p)))
const stripped = (p: string) => stripComments(read(p))
const exists = (p: string) => { try { readFileSync(p); return true } catch { return false } }

const rs = await import("../lib/recruiting/retention-score")
const iv = await import("../lib/recruiting/retention-intervention")
const radar = await import("../lib/recruiting/retention-radar")
const board = await import("../lib/intelligence/retention-board")
const lc = await import("../lib/kernel/deconflict/lead-channel")
const { CHECK_VOCABULARIES } = await import("./check-vocabularies")

const base = (o: Partial<RetentionSignals> = {}): RetentionSignals =>
  ({ daysSinceActivity: 1, daysSinceClosing: 20, activePipeline: 3, onboardingPct: 100, tenureDays: 400, ...o })

// ── A ─────────────────────────────────────────────────────────────────────────
console.log("\n[A · one scorer, one radar — extended, not rewritten]")
check("no second agent-fatigue scorer or radar module exists (the retention radar IS the agent signal)",
  !exists("lib/recruiting/agent-fatigue.ts") && !exists("lib/fatigue/agent-fatigue.ts") && !exists("lib/kernel/agent-fatigue.ts"))
const scoreSrc = stripped("lib/recruiting/retention-score.ts")
check("computeRetentionScore is the ONE composite (defined once) and folds the fatigue sub-scores into its own parts list",
  (scoreSrc.match(/export function computeRetentionScore\(/g) ?? []).length === 1 && /for \(const f of agentFatigueSubScores\(sig\)\)/.test(scoreSrc))
const preWave = rs.computeRetentionScore(base())
check("with every fatigue input ABSENT the five original signals score alone (breakdown has exactly the pre-89 keys)",
  Object.keys(preWave.breakdown).sort().join(",") === "activity,onboarding,pipeline,production" && preWave.tier === "engaged", Object.keys(preWave.breakdown).join(","))
check("POSITIVE CONTROL: agentFatigueSubScores on absent inputs is all-null (never a fabricated zero)",
  rs.agentFatigueSubScores(base()).every((s) => s.sub === null) && rs.agentFatigueSubScores(base()).length === rs.AGENT_FATIGUE_SIGNAL_KEYS.length)

// ── B ─────────────────────────────────────────────────────────────────────────
console.log("\n[B · the eight sub-scores at their documented cuts]")
const sub = (o: Partial<RetentionSignals>, key: AgentFatigueSignalKey) => rs.agentFatigueSubScores(base(o)).find((s) => s.key === key)!.sub
const near = (a: number | null, b: number, eps = 0.02) => a !== null && Math.abs(a - b) <= eps
check("response_lag: a 1-hour reply ≈ 1; four days (2× the 48h window) → 0; 48h → 0.5",
  near(sub({ responseLagHours: 1 }, "response_lag"), 0.99) && sub({ responseLagHours: 96 }, "response_lag") === 0 && near(sub({ responseLagHours: rs.CLIENT_REPLY_WINDOW_HOURS }, "response_lag"), 0.5))
check("unanswered_clients: 0 → 1; 5 → 0; 2 → 0.6", sub({ unansweredClientMessages: 0 }, "unanswered_clients") === 1 && sub({ unansweredClientMessages: 5 }, "unanswered_clients") === 0 && near(sub({ unansweredClientMessages: 2 }, "unanswered_clients"), 0.6))
check(`missed_appointments: below the ${rs.FATIGUE_MIN_APPOINTMENTS}-appointment sample → NULL (honest); 4 with 2 missed → 0.5; 4 with 0 → 1`,
  sub({ appointments30d: 2, missedOrRescheduled30d: 2 }, "missed_appointments") === null && sub({ appointments30d: 4, missedOrRescheduled30d: 2 }, "missed_appointments") === 0.5
    && sub({ appointments30d: 4, missedOrRescheduled30d: 0 }, "missed_appointments") === 1)
check("activity_trend: 2 sessions vs 10 before → 0.2; growth caps at 1; nothing either fortnight → NULL; prior 0 & last 3 → 1",
  near(sub({ sessionsLast14d: 2, sessionsPrior14d: 10 }, "activity_trend"), 0.2) && sub({ sessionsLast14d: 20, sessionsPrior14d: 10 }, "activity_trend") === 1
    && sub({ sessionsLast14d: 0, sessionsPrior14d: 0 }, "activity_trend") === null && sub({ sessionsLast14d: 3, sessionsPrior14d: 0 }, "activity_trend") === 1)
check("overdue_tasks: 0 → 1; 10 → 0; 5 → 0.5", sub({ overdueTasks: 0 }, "overdue_tasks") === 1 && sub({ overdueTasks: 10 }, "overdue_tasks") === 0 && sub({ overdueTasks: 5 }, "overdue_tasks") === 0.5)
check("pipeline_drop: 4 → 2 is 0.5; held or grew → 1; no prior stored → NULL",
  sub({ activePipeline: 2, activePipelinePrior: 4 }, "pipeline_drop") === 0.5 && sub({ activePipeline: 5, activePipelinePrior: 4 }, "pipeline_drop") === 1 && sub({ activePipeline: 2 }, "pipeline_drop") === null)
check(`fatigued_book: ${rs.FATIGUED_BOOK_FULL_SHARE * 100}% of the book at high/critical → 0; 0 fatigued → 1; an empty book → NULL`,
  sub({ fatiguedContacts: 3, bookContacts: 10 }, "fatigued_book") === 0 && sub({ fatiguedContacts: 0, bookContacts: 10 }, "fatigued_book") === 1 && sub({ fatiguedContacts: 0, bookContacts: 0 }, "fatigued_book") === null)
check("book_transfers: one transfer away → 0; none → 1", sub({ bookTransfers90d: 1 }, "book_transfers") === 0 && sub({ bookTransfers90d: 0 }, "book_transfers") === 1)
const lit = rs.computeRetentionScore(base({ responseLagHours: 90, unansweredClientMessages: 5, overdueTasks: 10 }))
check("three lit fatigue signals pull a healthy agent's composite DOWN and name the signals (ONE label spelling)",
  lit.score < preWave.score && lit.drivingSignals.length === 3 && lit.drivingSignals.every((d) => Object.values(rs.AGENT_FATIGUE_LABELS).includes(d)), JSON.stringify(lit.drivingSignals))
check("...and a fine agent with the same inputs present but healthy scores as high as before (the signals cost nothing when clean)",
  rs.computeRetentionScore(base({ responseLagHours: 1, unansweredClientMessages: 0, overdueTasks: 0 })).score >= preWave.score - 1)
check("weakFatigueSignals counts ONLY the fatigue keys below 0.5 (a weak original signal does not count; absent keys do not count)",
  rs.weakFatigueSignals(lit.breakdown).length === 3 && rs.weakFatigueSignals(rs.computeRetentionScore(base({ daysSinceActivity: 60 })).breakdown).length === 0
    && rs.weakFatigueSignals(null).length === 0 && rs.SUPPORT_NUDGE_MIN_SIGNALS === 2)

// ── C ─────────────────────────────────────────────────────────────────────────
console.log("\n[C · clientResponsiveness — pairing per contact]")
const now = new Date("2026-09-29T12:00:00Z")
const h = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString()
const r1 = radar.clientResponsiveness([
  { contact_id: "c1", inbound: true, at: h(100) }, { contact_id: "c1", inbound: false, at: h(98) },   // 2h lag
  { contact_id: "c2", inbound: true, at: h(50) },  { contact_id: "c2", inbound: false, at: h(40) },   // 10h lag
  { contact_id: "c3", inbound: true, at: h(72) },                                                      // unanswered, past the window
  { contact_id: "c4", inbound: true, at: h(1) },                                                       // unanswered, inside the window
  { contact_id: "c5", inbound: false, at: h(30) }, { contact_id: "c5", inbound: true, at: h(20) },    // outbound BEFORE inbound: no pair; open past? no (20h < 48h)
], now)
check("median lag over the paired threads (2h, 10h → 6h); one thread unanswered past 48h (c3), the fresh one (c4) and the one inside the window (c5) not counted",
  r1.medianLagHours === 6 && r1.unanswered === 1, JSON.stringify(r1))
check("POSITIVE CONTROL: no inbound → no lag and nothing unanswered", JSON.stringify(radar.clientResponsiveness([{ contact_id: "c", inbound: false, at: h(5) }], now)) === JSON.stringify({ medianLagHours: null, unanswered: 0 }))
check("a null contact_id row is ignored (nothing to pair on)", radar.clientResponsiveness([{ contact_id: null, inbound: true, at: h(100) }], now).unanswered === 0)

// ── D ─────────────────────────────────────────────────────────────────────────
console.log("\n[D · the support library]")
const SUPPORT_KEYS = ["response_support", "inbox_support", "scheduling_support", "task_support", "activity_dropoff", "fatigued_book_support", "transfer_conversation"]
const labelKeys = Object.values(rs.AGENT_FATIGUE_LABELS).map((l) => iv.interventionKeyForDriver(l))
check("every fatigue label maps to a SUPPORT play the broker performs (the seven wave-89 plays, or the existing pipeline-unstick review for a shrinking pipeline) — never the generic holistic check-in",
  labelKeys.every((k) => SUPPORT_KEYS.includes(k) || k === "pipeline_unstick") && !labelKeys.includes("holistic_check_in"), labelKeys.join(","))
check("...eight labels reach eight DIFFERENT plays, and every wave-89 play is reached by a label (no orphan play)",
  new Set(labelKeys).size === rs.AGENT_FATIGUE_SIGNAL_KEYS.length && SUPPORT_KEYS.every((k) => labelKeys.includes(k as any)))
check("POSITIVE CONTROL: the original drivers still select their original plays",
  iv.interventionKeyForDriver("In a production drought") === "drought_support" && iv.interventionKeyForDriver("Low platform activity") === "re_engagement"
    && iv.interventionKeyForDriver("Stalled onboarding") === "onboarding_ramp" && iv.interventionKeyForDriver("Empty pipeline") === "pipeline_unstick" && iv.interventionKeyForDriver("") === "holistic_check_in")
const sup = iv.supportSuggestionsFor([rs.AGENT_FATIGUE_LABELS.response_lag, rs.AGENT_FATIGUE_LABELS.unanswered_clients, rs.AGENT_FATIGUE_LABELS.response_lag])
check("supportSuggestionsFor: one concrete broker action per driver, in driver order, deduped by play",
  sup.length === 2 && sup[0].key === "response_support" && sup[1].key === "inbox_support" && sup.every((s) => s.action.length > 20))
check("supportSuggestedLines is `driver: action` (what the radar stores); empty drivers → []",
  iv.supportSuggestedLines([rs.AGENT_FATIGUE_LABELS.overdue_tasks])[0].startsWith(`${rs.AGENT_FATIGUE_LABELS.overdue_tasks}: `) && iv.supportSuggestedLines([]).length === 0)
check("every support play is something the BROKER does (offers cover / the ISA / a TC / a conversation), never a productivity demand on the agent",
  SUPPORT_KEYS.every((k) => /ISA|TC|cover|together|conversation|check-in|reach out|allocate|triage/i.test(iv.selectRetentionIntervention([Object.values(rs.AGENT_FATIGUE_LABELS).find((l) => iv.interventionKeyForDriver(l) === k)!]).brokerAction)))
const copy = iv.buildSavePlayCopy({ agentName: "Sam", score: 31, drivers: [rs.AGENT_FATIGUE_LABELS.unanswered_clients] })
check("the fresh-breach save-play selects the fatigue play for a fatigue driver (the existing rail, tailored)", copy.interventionKey === "inbox_support" && /Sam/.test(copy.body))

// ── E ─────────────────────────────────────────────────────────────────────────
console.log("\n[E · radar wiring]")
const radarSrc = stripped("lib/recruiting/retention-radar.ts")
const radarCode = code("lib/recruiting/retention-radar.ts")
const gatherAt = radarSrc.indexOf("async function gatherFatigueSignals(")
const gather = radarSrc.slice(gatherAt, radarSrc.indexOf("\n}\n", gatherAt))
check("the five original reads are untouched (activity, closings, pipeline, onboarding, points — the retention-radar proof's own anchor)",
  /agent_assistant_sessions[\s\S]*?transactions[\s\S]*?agent_onboarding/.test(radarSrc) && /from\("agent_points_log"\)/.test(radarSrc))
for (const [table, keyed] of [["client_portal_messages", "agent_id"], ["messages", "agent_id"], ["calendar_events", "agent_user_id"], ["tasks", "assigned_to_agent_id"], ["buyer_fatigue_scores", "agent_id"], ["agent_book_transfers", "from_agent_id"], ["contacts", "agent_id"]] as const) {
  check(`fatigue read of ${table} is keyed on ${keyed} (identity class checked live 2026-09-29)`, new RegExp(`from\\("${table}"\\)[^\\n]*\\.eq\\("${keyed}", agent\\.(id|user_id)\\)`).test(gather))
}
check("calendar_events is keyed on agent.user_id (users.id) — never agents.id (§3 disjoint)", /from\("calendar_events"\)[^\n]*\.eq\("agent_user_id", agent\.user_id\)/.test(gather) && !/from\("calendar_events"\)[^\n]*agent\.id\)/.test(gather))
const refusedCalls = (gather.match(/refused\("/g) ?? []).length
check("every fatigue read destructures its error through `refused(...)` (≥ 9 reads, each read; a refusal leaves the signal absent)", refusedCalls >= 9 && /if \(err\) console\.error/.test(gather) && /return !!err/.test(gather), String(refusedCalls))
check("no inbound at all → unansweredClientMessages is NULL, not a perfect 0", /rows\.some\(\(x\) => x\.inbound\) \? r\.unanswered : null/.test(gather))
check("the pipeline-drop baseline is read back from the stored raw_signals (~30 days ago)", /from\("agent_retention_scores"\)\.select\("raw_signals"\)[^\n]*\.lte\("score_date", priorDate\)/.test(gather) && /activePipelinePrior/.test(gather))
const runAt = radarSrc.indexOf("export async function runRetentionRadar(")
const run = radarSrc.slice(runAt, radarSrc.indexOf("export async function draftSavePlaysForAtRiskAgents"))
check("the SAME upsert (one row per agent per day) now carries raw_signals + support_suggested (m674)",
  /from\("agent_retention_scores"\)\.upsert\(\{[\s\S]*?raw_signals: sig as any,\s*support_suggested: supportSuggested,[\s\S]*?onConflict: "agent_id,score_date"/.test(run))
check("the support nudge fires on LIT SIGNALS (≥ SUPPORT_NUDGE_MIN_SIGNALS) BEFORE the at-risk gate, so support comes before the score reads at-risk",
  /if \(litSignals\.length >= SUPPORT_NUDGE_MIN_SIGNALS\)/.test(run) && run.indexOf("litSignals.length >= SUPPORT_NUDGE_MIN_SIGNALS") < run.indexOf("if (!isAtRisk(rs.score)) continue"))
const nudgeAt = radarSrc.indexOf("async function nudgeSupport(")
const nudge = radarSrc.slice(nudgeAt, radarSrc.indexOf("\n}\n", nudgeAt))
check("NEVER AGENT-FACING: the nudge removes the agent's own user id from the recipients (a solo owner is never told about themselves)",
  /recipients\.delete\(p\.agent\.user_id\)/.test(nudge) && nudge.indexOf("recipients.delete(p.agent.user_id)") < nudge.indexOf("for (const userId of recipients)"))
check("POSITIVE CONTROL: the finder rejects a nudge that keeps the agent in the roster", !/recipients\.delete\(p\.agent\.user_id\)/.test(`const recipients = new Set(await resolveOrgRecipients(svc, p.brokerageId)); for (const userId of recipients) {}`))
check("the nudge reaches the broker/admin roster (tier-safe resolver) AND the agent's team lead (teams.team_lead_id — a users.id)",
  /resolveOrgRecipients\(svc, p\.brokerageId\)/.test(nudge) && /from\("teams"\)\.select\("team_lead_id"\)\.eq\("id", p\.agent\.team_id\)\.eq\("brokerage_id", p\.brokerageId\)/.test(nudge))
check("the nudge is one 'agent_support_suggested' notification per recipient, deduped by created_at, carrying the signals and the support lines",
  /type: "agent_support_suggested"/.test(nudge) && /\.eq\("type", "agent_support_suggested"\)[\s\S]{0,60}\.gte\("created_at", sinceDedupe\)/.test(nudge)
    && /if \(seenErr\)/.test(nudge) && /Suggested support: \$\{p\.support\.join/.test(nudge))
check("the radar selects team_id for the nudge and the cron reports supportNudged", /select\("id, user_id, team_id, created_at, users\(first_name, last_name\)"\)/.test(radarSrc)
  && /retention_support_nudged = ret\.supportNudged/.test(stripped("app/api/cron/compliance-monitoring/route.ts")))
check("no raw sentinel-less notification insert (every bell goes through sentinelWrite; the source read with strings intact — a blanked-string read would be blind here)",
  (radarSrc.match(/from\("notifications"\)\.insert\(/g) ?? []).length >= 2 && !/from\("notifications"\)\.insert\(/.test(radarSrc.replace(/sentinelWrite\(svc, svc\.from\("notifications"\)\.insert\(/g, "")))
check("POSITIVE CONTROL: the sentinel finder sees a bare insert", /from\("notifications"\)\.insert\(/.test(`await svc.from("notifications").insert({ user_id })`))
void radarCode

// ── F ─────────────────────────────────────────────────────────────────────────
console.log("\n[F · never agent-facing — the coaching digest and the board]")
const coachSrc = stripped("lib/kernel/agent-coaching.ts")
const adapterAt = coachSrc.indexOf("function briefToWeeklyReport(")
const adapter = coachSrc.slice(adapterAt, coachSrc.indexOf("\n}\n", adapterAt))
const renderAt = coachSrc.indexOf("function renderCoachingMessage(")
const render = coachSrc.slice(renderAt, coachSrc.indexOf("\n}\n", renderAt))
check("the AGENT's dashboard report (briefToWeeklyReport) carries NO retention support / tier / signals", !/retentionSupport|support_suggested|retention tier/.test(adapter))
check("the MANAGER message (renderCoachingMessage) carries the 'Support suggested (for you, not the agent…)' section", /stats\.retentionSupport/.test(render) && /Support suggested \(for you, not the agent/.test(render))
check("POSITIVE CONTROL: the adapter finder sees a leak", /retentionSupport/.test(`function briefToWeeklyReport(stats) { return { gaps: stats.retentionSupport.signals } }`))
check("composeCoachingBrief (the shared brief) does not read retentionSupport — the agent's leaks are about their BOOK, never their own risk",
  !/retentionSupport/.test(coachSrc.slice(coachSrc.indexOf("export function composeCoachingBrief("), coachSrc.indexOf("function renderCoachingMessage("))))
check("coaching reads the radar's latest row per agent (tier, driving_signals, support_suggested) tenant-pinned, error READ, absent on refusal",
  /from\("agent_retention_scores"\)\.select\("agent_id, tier, driving_signals, support_suggested, score_date"\)[\s\S]{0,80}\.eq\("brokerage_id", brokerageId\)\.in\("agent_id", agentIds\)/.test(coachSrc)
    && /if \(retentionErr\) console\.error/.test(coachSrc) && /retentionSupport: retentionErr \? undefined : retentionByAgent\.get\(a\.id\)/.test(coachSrc))
const boardRows = board.summarizeRetentionBoard([
  { agent_id: "a1", score_date: "2026-09-29", composite_score: 45, tier: "watch", score_trend: "declining", driving_signals: ["Slow to answer clients"], support_suggested: ["Slow to answer clients: Offer the ISA"] },
  { agent_id: "a2", score_date: "2026-09-29", composite_score: 90, tier: "engaged", score_trend: null, driving_signals: [] },
], new Map())
check("the retention board carries supportSuggested per agent (empty on a pre-89 row, never undefined)",
  boardRows.agents[0].supportSuggested.length === 1 && boardRows.agents[1].supportSuggested.length === 0)
check("the board's reader selects support_suggested and the Command Center renders it (broker/team-lead surface)",
  /support_suggested"\)/.test(stripped("lib/intelligence/retention-board.ts")) && /a\.supportSuggested/.test(stripped("app/dashboard/admin/command-center/command-center-client.tsx")))
check("no agent-facing surface reads support_suggested (only the board, coaching and the radar)",
  !/support_suggested/.test(stripped("app/dashboard/coaching/page.tsx")) && !exists("app/dashboard/agent/retention/page.tsx"))

// ── G ─────────────────────────────────────────────────────────────────────────
console.log("\n[G · m674 as a rule; CHECK words]")
const mig = exists("supabase/migrations/m674-agent-fatigue-signals-on-the-retention-score.sql") ? read("supabase/migrations/m674-agent-fatigue-signals-on-the-retention-score.sql") : ""
check("m674 adds exactly the two additive columns the radar writes (raw_signals jsonb, support_suggested text[] defaulted) — asserted as the RULE, not the applied/unapplied header",
  /alter table public\.agent_retention_scores/.test(mig) && /add column if not exists raw_signals jsonb/.test(mig) && /add column if not exists support_suggested text\[\] not null default '\{\}'::text\[\]/.test(mig)
    && !/drop column/.test(mig))
check("the transfer statuses the radar filters are the live CHECK's (agent_book_transfers.status)", ["active", "permanent"].every((s) => CHECK_VOCABULARIES.agent_book_transfers.status.includes(s)))
check("the fatigue risk words are the live CHECK's (buyer_fatigue_scores.risk_level) — in the radar's book read and the cap's steps",
  ["high", "critical"].every((s) => CHECK_VOCABULARIES.buyer_fatigue_scores.risk_level.includes(s)) && Object.keys(lc.FATIGUE_TIGHTENING_STEPS).every((s) => CHECK_VOCABULARIES.buyer_fatigue_scores.risk_level.includes(s)))
check("the radar's portal direction word is the live CHECK's (client_portal_messages 'client_to_agent')", CHECK_VOCABULARIES.client_portal_messages.direction.includes("client_to_agent") && /"client_to_agent"/.test(gather))

// ── H ─────────────────────────────────────────────────────────────────────────
console.log("\n[H · fatigue tempers the over-touch cap; the lifetime cadence]")
const T = lc.fatigueTemperedPolicy
check("high: one step — email 3/14d → 2/14d; sms 1/7d (already at the floor) → 1/14d (the window doubles instead)",
  JSON.stringify(T(lc.DEFAULT_DECONFLICT_POLICY.email, "high").policy) === JSON.stringify({ maxTouches: 2, windowDays: 14 })
    && JSON.stringify(T(lc.DEFAULT_DECONFLICT_POLICY.sms, "high").policy) === JSON.stringify({ maxTouches: 1, windowDays: 14 }) && T(lc.DEFAULT_DECONFLICT_POLICY.sms, "high").steps === 1)
check("critical: two steps — email → 1/14d; sms → 1/28d; mail 1/30d → 1/120d",
  JSON.stringify(T(lc.DEFAULT_DECONFLICT_POLICY.email, "critical").policy) === JSON.stringify({ maxTouches: 1, windowDays: 14 })
    && JSON.stringify(T(lc.DEFAULT_DECONFLICT_POLICY.sms, "critical").policy) === JSON.stringify({ maxTouches: 1, windowDays: 28 })
    && JSON.stringify(T(lc.DEFAULT_DECONFLICT_POLICY.mail, "critical").policy) === JSON.stringify({ maxTouches: 1, windowDays: 120 }))
check("POSITIVE CONTROL: fresh / moderate / no score row leave the base policy untouched (0 steps, no reason)",
  ["fresh", "moderate", null, undefined, "bogus"].every((r) => T(lc.DEFAULT_DECONFLICT_POLICY.email, r as any).steps === 0 && T(lc.DEFAULT_DECONFLICT_POLICY.email, r as any).reason === null))
check("a step never LOOSENS (maxTouches never rises, the window never shrinks)",
  (["email", "sms", "phone", "mail"] as const).every((ch) => { const b = lc.DEFAULT_DECONFLICT_POLICY[ch]; const t = T(b, "critical").policy; return t.maxTouches <= b.maxTouches && t.windowDays >= b.windowDays }))
const dc = stripped("lib/kernel/deconflict/index.ts")
const evalAt = dc.indexOf("export async function evaluateDeconflict(")
const evalFn = dc.slice(evalAt, dc.indexOf("\n}\n", evalAt))
check("evaluateDeconflict reads the contact's fatigue TENANT-PINNED with its error READ (base policy on refusal — a guardrail, not a consent gate) and tempers BEFORE the window",
  /from\("buyer_fatigue_scores"\)\.select\("risk_level"\)\s*\.eq\("brokerage_id", input\.brokerageId\)\.eq\("contact_id", input\.contactId\)\.maybeSingle\(\)/.test(evalFn)
    && /if \(fatigueErr\) console\.error/.test(evalFn) && evalFn.indexOf("fatigueTemperedPolicy(policy, fatigueRisk)") < evalFn.indexOf("const since  = new Date("))
check("the decision and the audit row say WHY (fatigueRisk / fatigueSteps; metadata on the suppression log)", /fatigueRisk,\s*fatigueSteps,/.test(evalFn) && /metadata:\s*fatigueSteps > 0 \? \{ fatigue_risk: fatigueRisk, fatigue_steps: fatigueSteps \} : null/.test(evalFn))
check("the learned cadence still tightens by the same one-touch step (fatigue's step mirrors it)", /Math\.max\(1, base\.maxTouches - 1\)/.test(stripped("lib/kernel/deconflict/cadence-policy.ts")) && JSON.stringify(lc.tightenPolicyStep({ maxTouches: 3, windowDays: 14 })) === JSON.stringify({ maxTouches: 2, windowDays: 14 }))
const cron = stripped("app/api/cron/lifetime-customer-touchpoints/route.ts")
check("the lifetime cron tempers through the SAME engine (evaluateDeconflict on the contact) — no second rule", /evaluateDeconflict\(\{ brokerageId, contactId, channel, systemSource \}\)/.test(cron) && !/buyer_fatigue_scores/.test(cron))
check("...and evaluates the channel the touch actually rides (birthday / referral ask = sms; anniversary = email)",
  /"sphere_birthday", "sms"\)/.test(cron) && /"sphere_referral_request", "sms"\)/.test(cron) && /channel: "email" \| "sms" = "email"/.test(cron))
check("...counts a gate-refused send as BLOCKED, never as a touch delivered (all three senders)", /blocked: 0,/.test(cron) && (cron.match(/countSend\("/g) ?? []).length === 3 && /results\.blocked\+\+/.test(cron))
check("POSITIVE CONTROL: the old shape (call, then unconditional ++) is what the finder rejects", !/countSend\(/.test(`await sendBirthdayMessage(contact.id, opts)\n results.birthdays++`))
check("...the referral window reads funded deals too (the ladder is closed → funded; the anniversary read already did)", /\.in\("status", \["closed", "funded"\]\)\s*\.in\("close_date"/.test(cron))

// ── I ─────────────────────────────────────────────────────────────────────────
console.log("\n[I · registration + cross-cooperation]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:agent-fatigue", pkg.scripts["test:agent-fatigue"] === "tsx scripts/agent-fatigue-guard.ts")
const guard = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers (ordering, never adjacency)", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:agent-fatigue") > guard.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS, canRefer } = await import("../lib/kernel/manager-registry")
const entry = Object.values(MAINTENANCE_DOMAINS).find((d: any) => d.proof === "test:agent-fatigue") as any
check("MAINTENANCE_DOMAINS owns it (recruiting_manager) with co-owners as STRUCTURE, each pair a licensed bus edge",
  !!entry && entry.manager === "recruiting_manager" && Array.isArray(entry.coOwners) && entry.coOwners.length >= 2 && entry.coOwners.every((c: string) => canRefer("recruiting_manager", c)), JSON.stringify(entry?.coOwners))
check("the entry's prose names the never-agent-facing rule and the support nudge", !!entry && /NEVER AGENT-FACING/.test(entry.what) && /SUPPORT NUDGE/.test(entry.what))

console.log(`\n  denominators: ${rs.AGENT_FATIGUE_SIGNAL_KEYS.length} fatigue signals · ${SUPPORT_KEYS.length} support plays · 7 keyed reads in gatherFatigueSignals (${refusedCalls} error-read sites) · 4 channels × 3 risk words on the cap · 3 lifetime senders`)
console.log("  blind spots: the radar's reads are proven by source shape and the pure terms, not executed against a DB (live had 0 agent_retention_scores / buyer_fatigue_scores / lifetime_customer_touchpoints rows on 2026-09-29); m674 is WRITTEN, NOT APPLIED — until applied the radar's upsert is refused whole (PGRST204) and sentinelWrite ledgers it; reply pairing sees client_portal_messages + messages only (an email reply that lands only in a mailbox is not seen); 'rescheduled' on calendar_events is written by seller-showings, so a buyer-side reschedule that never marks the event reads as kept; the activity trend is assistant sessions, not logins (no login ledger exists — users has no last_sign_in column); the pipeline-drop baseline needs a raw_signals row ≥30 days old, so it is null for the first month after m674; the support nudge reaches the broker roster and the team lead — an agent with no team and a solo shop get no nudge (their own id is removed), which is the owner's rule; weights are read per brokerage per sweep, so a change lands on the next run, not mid-run")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ AGENT_FATIGUE_PASS" : " ❌ AGENT_FATIGUE_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
