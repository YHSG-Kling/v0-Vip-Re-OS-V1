// scripts/arbiter-timing-guard.ts — `test:arbiter-timing` (wave 149, lane 149C; owner rulings 7 + 8, contract C29)
// ─────────────────────────────────────────────────────────────────────────────
// "Nothing fixed in communications. No fixed follow-up timetable, no funnel timeline — the arbiter or the manager decides
//  timing, channel and content from the situation." (ruling 7) · "The AI may answer when a human doesn't — through the
//  arbiter." (ruling 8)
//
//   §A THE CENSUS — no module carries a fixed outbound schedule. Every NAMED SCHEDULE CONSTANT (an identifier pairing an outbound
//      word — remind / follow-up / nurture / drip / cadence / touch / nudge / re-engage / outreach / invite / no-show / replay —
//      with a time unit, bound to a number or a numeric array), every `T-<n>d` literal and every send-weekday whitelist, in
//      COMMENT-BLANKED source (a tombstone is not a call site, CLAUDE.md §2) across lib/ app/ workflows/, is classified:
//        floor    — a cooldown / dedupe / grace / TTL / window / min / max: it STOPS or BOUNDS a send, never causes one;
//        policy   — followup_policy guidance the arbiter READS (arbitrateCadence / arbitratePlannedTouch) — "a policy the arbiter
//                   reads is not a defect" (preamble);
//        a named DISPOSITION (staff / platform recipients, obligations, or a carried item with its owner lane and reason);
//      anything else is a DEFECT and fails. Positive control: a planted `reminderDaysBefore = 7` is a defect; the same text in
//      a comment is not seen; a planted "T-7d" literal is seen.
//   §B THE ENTRY POINTS — the six planners lane 148Z named (+ the sequence step and the unattended answer) each pass ONE arbiter
//      door (ARBITER_PLANNER_ENTRY_POINTS), proven in stripped source with a positive control.
//   §C THE DECISIONS (in memory, model injected) — the spacing is guidance, not a gate; each planner's verdict is only the
//      fallback; the menu is closed; waits are bounded; every decision is ledgered.
//   §D THE LOOP — inbound → decision → action → outcome → next-best-action, as one loop on memSupabase.
// The summary line is `RESULT: N passed, M failed` (never the chain runner's own exit token).

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { memSupabase, type Row } from "./in-memory-supabase"
import { blankComments, stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))

// ── §A machinery ──────────────────────────────────────────────────────────────────────────────────
const SUBJ = "(?:remind|follow_?up|nurture|drip|cadence|touch|nudge|reengag|re_engag|outreach|invite|invitation|no_?show|replay|send)"
const UNIT = "(?:days?|hours?|minutes?|offsets?|spacing|interval|before|after|weekdays)"
const NAMED = new RegExp(`\\b(\\w*${SUBJ}\\w*${UNIT}\\w*|\\w*${UNIT}\\w*${SUBJ}\\w*)\\s*[:=]\\s*(?:Object\\.freeze\\(\\s*)?(\\[\\s*-?\\d[\\d\\s,._]*\\]|-?\\d[\\d_.]*)`, "gi")
const WEEKDAYS = /\b(\w*(?:Send|send)_?[Ww]eekdays\w*)\s*[:=]\s*(?:Object\.freeze\(\s*)?\[\s*\d/g
const TMINUS = /["'`]T-\d+[dh]["'`]/g

interface Hit { file: string; line: number; name: string; text: string }
function scan(file: string, src: string): Hit[] {
  const blanked = blankComments(src)
  const out: Hit[] = []
  for (const re of [NAMED, WEEKDAYS, TMINUS]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(blanked))) {
      const line = blanked.slice(0, m.index).split("\n").length
      out.push({ file, line, name: (m[1] ?? m[0]).replace(/["'`]/g, ""), text: m[0].slice(0, 90) })
    }
  }
  return out
}

/** It stops or bounds a send — never causes one. */
const FLOOR_NAME = /(DEDUPE|COOLDOWN|GRACE|TTL|WINDOW|Window|_MIN_|^MIN_|_MIN$|MinHours|MIN_LEAD|_MAX_|^MAX_|_MAX$|Max[A-Z]|minHours|Last\d+Days|THRESHOLD|Threshold|LOOKBACK|Lookback|STALE|Stale)/

type Kind = "staff_internal" | "obligation" | "carried"
interface Disposition { kind: Kind; owner: string; reason: string }
/** Every named schedule constant that is neither a floor nor arbiter policy — each with WHY it is not a C29 defect, or who owns it. */
const DISPOSITIONS: Record<string, Disposition> = {
  // ── policy the arbiter reads lives in followup-policy.ts (classified by file, below) ──
  // ── staff / platform / vendor recipients: not a person the tenant serves (C29 governs touches to leads / contacts / clients) ──
  "lib/billing/stripe-subscription-ops.ts#TRIAL_REMINDER_DAYS": { kind: "staff_internal", owner: "platform billing", reason: "a platform subscriber's billing notice (the subscriber is the platform's customer), not a tenant's lead or contact" },
  "lib/billing/stripe-subscription-ops.ts#RENEWAL_REMINDER_DAYS": { kind: "staff_internal", owner: "platform billing", reason: "the renewal notice a subscription owes its payer — a billing obligation" },
  "lib/kernel/self-optimization.ts#DEADLINE_REMINDER_DEFAULT_HOURS": { kind: "staff_internal", owner: "deal_coordinator", reason: "a deadline reminder to STAFF; self-optimization tunes it from outcomes" },
  "lib/kernel/self-optimization.ts#DEADLINE_REMINDER_STEP_HOURS": { kind: "staff_internal", owner: "deal_coordinator", reason: "the tuner's step size for the staff deadline reminder" },
  "lib/kernel/signature-chase.ts#NUDGE_HOURS": { kind: "obligation", owner: "deal_coordinator", reason: "chasing a signature the transaction requires — a contractual obligation, never a marketing touch" },
  "lib/kernel/urgent-sla.ts#URGENT_NUDGE_MAX_HOURS": { kind: "staff_internal", owner: "operations", reason: "an SLA nudge to staff" },
  "lib/vendors/w9-vocab.ts#W9_REMINDER_PERIOD_DAYS": { kind: "obligation", owner: "finance_manager", reason: "a vendor's W-9 — a tax-document obligation to a vendor" },
  "lib/onboarding/subscriber-stall.ts#NUDGE_AFTER_DAYS": { kind: "staff_internal", owner: "platform onboarding", reason: "a platform subscriber's onboarding nudge (the platform funnel, not a tenant contact)" },
  "lib/communications/vendor-follow-up-cadence.ts#RE_REMIND_WITHIN_DAYS": { kind: "staff_internal", owner: "vendor_coordinator", reason: "a vendor task re-remind (vendors are tenant suppliers, not served persons)" },
  "app/api/cron/brokerage-intelligence-mine/route.ts#FOLLOWUP_DAYS": { kind: "staff_internal", owner: "data_steward", reason: "an internal intelligence-mining follow-up window for staff" },
  "lib/managers/regional-convention-review.ts#cadenceDays": { kind: "staff_internal", owner: "compliance_officer", reason: "a staff review cadence (no outbound touch)" },
  // ── obligations: the person asked for it, or the law / the deal requires it ──
  "lib/campaign-sequences/first-touch-coordination.ts#FIRST_TOUCH_DEFER_MINUTES": { kind: "obligation", owner: "lane 149C", reason: "the welcome step's re-ask interval while the ARBITER's speed-to-lead decides the first hello (ruling 16) — it defers TO the arbiter" },
  "lib/kernel/appointment-noshow-autopilot.ts#DEFAULT_REMINDER_WINDOW_HOURS": { kind: "obligation", owner: "deal_coordinator", reason: "a reminder for an appointment the person BOOKED — requested service" },
  "lib/transactions/cda-closing-policy.ts#CDA_DEADLINE_REMINDER_HOURS": { kind: "staff_internal", owner: "finance_manager", reason: "the CDA deadline reminder to staff (closing obligation)" },
  "lib/listings/relist-recovery.ts#FOLLOWUP_WINDOW_DAYS": { kind: "carried", owner: "listing_concierge", reason: "a detection window for expired listings (who is a candidate) — the touch goes through engageContact → arbitrateAndRecordExperience" },
  "lib/lead-pipeline/offer-rejection-recovery.ts#FOLLOWUP_WINDOW_HOURS": { kind: "carried", owner: "shopping_agent", reason: "a detection window after a rejected offer (who is a candidate); the recovery touch's arbitration is Still open (lane 149C notes)" },
  // ── CARRIED: a real outbound timetable that does not yet pass the arbiter — owner lane + the exact next step in the notes ──
  "lib/ai-isa/settings-types.ts#touch_interval_days": { kind: "carried", owner: "lane 149C (Still open 1)", reason: "planNextLeadTouch spaces lead touches by the broker's touch_interval_days (lib/ai-isa/lead-action-plan.ts releaseDueLeadTouches) — not yet routed through arbitratePlannedTouch" },
  "app/dashboard/isa/campaigns/components/CreateCampaignDrawer.tsx#DEFAULT_TOUCH_INTERVAL": { kind: "carried", owner: "lane 149C (Still open 1)", reason: "the UI default of the same touch_interval_days setting" },
  "lib/kernel/strategy-library.ts#cadenceDays": { kind: "carried", owner: "lane 149C (Still open 2)", reason: "strategy-library step cadence (activateStrategy delegations) — guidance the strategy engine schedules on; arbitration of each delegated touch is Still open" },
  // CLOSED (wave 150, lane 150SZ — wave-149 §4 C-3): creative-playbooks `sendAfterMinutes` removed; the playbook proposes order only and
  // the dispatch-time arbiter door is the bundle dispatcher owner's (lane 150SZ notes, Outside-lane). The bundle builder default below stays carried.
  "app/settings/campaign-bundles/client.tsx#send_after_minutes": { kind: "carried", owner: "campaign_orchestrator (Outside-lane 3)", reason: "the bundle builder's default offset (same setting)" },
  // CLOSED (wave 150, lane 150SZ — wave-149 §4 C-4): section-drip `DEFAULT_DRIP_WINDOW_DAYS` removed; deliverDueSections asks the arbiter
  // (arbitrateSectionDelivery → arbitrateFollowUp) before each part after the first; proven by scripts/lifetime-relationship-guard.ts.
}
/** Files whose constants are the arbiter's POLICY (it reads them as guidance, inside the judgment). */
const POLICY_FILES = new Set(["lib/ai-isa/followup-policy.ts"])
/** Names that are not schedules at all (counters, research cadences) — each with why. */
const NOT_A_SCHEDULE: Record<string, string> = {
  outreachLast30Days: "a COUNT of past outreach (a reading), not a schedule",
  cadenceMinutes: "lib/intent/movement-source-*: how often a PUBLIC DATASET is polled (research) — never a touch to a person (lane H's)",
}

function classify(h: Hit): { cls: "floor" | "policy" | "disposed" | "not_schedule" | "defect"; why: string } {
  if (POLICY_FILES.has(h.file)) return { cls: "policy", why: "followup_policy guidance the arbiter reads" }
  const bare = h.name
  if (NOT_A_SCHEDULE[bare]) return { cls: "not_schedule", why: NOT_A_SCHEDULE[bare] }
  const d = DISPOSITIONS[`${h.file}#${bare}`]
  if (d) return { cls: "disposed", why: `${d.kind} · ${d.owner} · ${d.reason}` }
  if (FLOOR_NAME.test(bare)) return { cls: "floor", why: "a floor / window / bound — it stops or bounds a send" }
  return { cls: "defect", why: "a fixed outbound schedule with no arbiter in front of it (C29)" }
}

function walk(dir: string, out: string[]) {
  let names: string[] = []
  try { names = readdirSync(join(ROOT, dir)) } catch { return }
  for (const n of names) {
    if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) continue
    const p = join(dir, n)
    const s = statSync(join(ROOT, p))
    if (s.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
}

// ── §C/§D fixtures ────────────────────────────────────────────────────────────────────────────────
const B1 = "11111111-1111-4111-8111-111111111111"
const C1 = "c1c1c1c1-0000-4000-8000-000000000001"
const L1 = "l1l1l1l1-0000-4000-8000-000000000001"
const U1 = "a2a2a2a2-0000-4000-8000-000000000002"
const NOW = new Date()
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()
const db = (extra: Record<string, Row[]> = {}) => memSupabase({
  brokerages: [{ id: B1 }], brokerage_settings: [], agent_action_ledger: [], manager_completions: [], notifications: [], activities: [],
  outcome_reconciliations: [], self_heal_events: [], platform_settings: [], connector_healing_proposals: [], smart_assistant_suggestions: [], ai_message_drafts: [],
  ...extra,
}, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], manager_completions: [["idempotency_key"]] } })

type Decide = (a: { brokerageId: string; system: string; prompt: string }) => Promise<Record<string, unknown>>
const says = (optionId: string, extra: Record<string, unknown> = {}): Decide => async () => ({ optionId, channel: null, format: null, waitHours: null, rationale: `The evidence supports ${optionId} for this person right now.`, evidence: ["moment"], confidence: 0.9, ...extra })
const outage: Decide = async () => { throw new Error("gateway down") }
const recorder = (inner: Decide) => { const calls: Array<{ system: string; prompt: string }> = []; const d: Decide = async (a) => { calls.push(a); return inner(a) }; return { d, calls } }

async function main() {
  // ══ §A ═══════════════════════════════════════════════════════════════════════════════════════════
  section("A · the census — no module carries a fixed outbound schedule (comment-blanked source)")
  {
    const planted = scan("fixture.ts", "export const reminderDaysBefore = 7\n")
    check("POSITIVE CONTROL: a planted `reminderDaysBefore = 7` is SEEN", planted.length === 1 && planted[0].name === "reminderDaysBefore", JSON.stringify(planted))
    check("POSITIVE CONTROL: …and classified a DEFECT (no arbiter in front of it)", planted.length === 1 && classify(planted[0]).cls === "defect")
    check("POSITIVE CONTROL: a planted numeric array (`REMINDER_OFFSETS_DAYS = [7, 3, 1]`) is seen and is a defect", (() => { const h = scan("fixture.ts", "const REMINDER_OFFSETS_DAYS = [7, 3, 1]\n"); return h.length === 1 && classify(h[0]).cls === "defect" })())
    check("POSITIVE CONTROL: a planted \"T-7d\" literal is seen", scan("fixture.ts", 'const k = "T-7d"\n').some((h) => h.name === "T-7d"))
    check("POSITIVE CONTROL: a planted send-weekday whitelist (`phase1SendWeekdays: [1, 3, 5]`) is seen", scan("fixture.ts", "const p = { phase1SendWeekdays: [1, 3, 5] }\n").length >= 1)
    check("A TOMBSTONE IS NOT A CALL SITE: the same planted constant inside a comment is NOT seen", scan("fixture.ts", "// TOMBSTONE: reminderDaysBefore = 7 lived here\n/* reminderDaysBefore = 7 */\n").length === 0)
    check("POSITIVE CONTROL: a cooldown floor (`REENGAGE_COOLDOWN_DAYS = 6`) is a floor, not a defect", (() => { const h = scan("fixture.ts", "const REENGAGE_COOLDOWN_DAYS = 6\n"); return h.length === 1 && classify(h[0]).cls === "floor" })())

    const files: string[] = []
    for (const d of ["lib", "app", "workflows"]) walk(d, files)
    const hits = files.flatMap((f) => scan(f, raw(f)))
    const byCls: Record<string, Hit[]> = {}
    for (const h of hits) (byCls[classify(h).cls] ??= []).push(h)
    const defects = byCls.defect ?? []
    console.log(`    census: ${files.length} files scanned (lib/ app/ workflows/, .ts/.tsx, __tests__ + .d.ts excluded) · ${hits.length} named schedule constants · floor ${(byCls.floor ?? []).length} · policy ${(byCls.policy ?? []).length} · disposed ${(byCls.disposed ?? []).length} · not-a-schedule ${(byCls.not_schedule ?? []).length} · DEFECT ${defects.length}`)
    const carried = Object.entries(DISPOSITIONS).filter(([, d]) => d.kind === "carried")
    console.log(`    carried (a real outbound timetable not yet arbitrated, each with its owner): ${carried.length} — ${carried.map(([k]) => k.split("#")[1]).join(", ")}`)
    check("the census is not blind: it found the arbiter's own spacing guidance (phase1SendWeekdays / phase2SpacingDays in followup-policy.ts)", (byCls.policy ?? []).some((h) => /phase1SendWeekdays|phase2SpacingDays/.test(h.name)))
    check("NO module carries an unclassified fixed outbound schedule (every hit is a floor, arbiter policy, or a named disposition)", defects.length === 0, defects.map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "))
    const stale = Object.keys(DISPOSITIONS).filter((k) => { const [f, n] = k.split("#"); return !hits.some((h) => h.file === f && h.name === n) })
    check("every disposition still names a live constant (a disposition for a removed constant is a waypoint — delete it)", stale.length === 0, stale.join(", "))
    check("no T-<n>d reminder table exists in event / magnet / funnel code (lane F's producers; C32 reminders via C29)", !hits.some((h) => /^T-\d+[dh]$/.test(h.name)))
  }

  // ══ §B ═══════════════════════════════════════════════════════════════════════════════════════════
  section("B · the six planner entry points (+ the sequence step, the unattended answer) pass ONE arbiter door")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const SIX = ["adaptive_reengagement", "next_best_touch", "stale_contact_detector", "saved_home_nudge", "ghost_escalation", "lead_nurture"] as const
  const table = arb.ARBITER_PLANNER_ENTRY_POINTS as Record<string, { planner: string; door: string; via: string }>
  check("the table names all six planners lane 148Z listed (143E-SO-03)", SIX.every((k) => !!table[k]), SIX.filter((k) => !table[k]).join(", "))
  const callsVia = (src: string, via: string) => new RegExp(`\\b${via}\\s*\\(`).test(src)
  check("POSITIVE CONTROL: the call finder sees a call and refuses a mention", callsVia("await arbitratePlannedTouch(svc, {", "arbitratePlannedTouch") && !callsVia("// arbitratePlannedTouch decides", "arbitratePlannedTouch") === true && !callsVia(stripComments("// await arbitratePlannedTouch(svc)"), "arbitratePlannedTouch"))
  for (const [key, e] of Object.entries(table)) {
    const door = code(e.door)
    check(`${key}: its door ${e.door} calls ${e.via}( in stripped source`, door.length > 0 && callsVia(door, e.via))
    const plannerBase = e.planner.replace(/^.*\//, "").replace(/\.ts$/, "")
    check(`${key}: the door reaches the planner (${plannerBase})`, e.planner === e.door || door.includes(plannerBase) || (key === "stale_contact_detector" && /detectAllEligibleContacts/.test(code("app/api/cron/stale-contact-monitor/route.ts")) && /initiateAIISAContactEngagement/.test(code("app/api/cron/stale-contact-monitor/route.ts"))) || (key === "sequence_step"))
  }
  {
    const gr = code("lib/ai-isa/ghost-reengagement.ts")
    check("ghost-reengagement no longer skips on the spacing alone (`if (!cadence.shouldSend)` gate removed — the arbiter decides)", !/if\s*\(\s*!cadence\.shouldSend\s*\)/.test(gr))
    check("POSITIVE CONTROL: the gate finder sees the old gate shape", /if\s*\(\s*!cadence\.shouldSend\s*\)/.test("if (!cadence.shouldSend) {"))
    check("ghost-reengagement hands the planners' proposals in (angles + newsletter) and uses the arbiter's angle", /proposals:\s*\{/.test(gr) && /angle:\s*chosenAngle/.test(gr) && /if\s*\(\s*newsletterChosen\s*\)/.test(gr))
    check("the ghost FYI fires only on the arbiter's call (decideGhostEscalation → esc.escalate)", /decideGhostEscalation\s*\(/.test(gr) && /if\s*\(\s*esc\.escalate\s*\)/.test(gr))
    const ms = code("lib/kernel/manager-signals.ts")
    check("routeSavedHomeNudge routes on the arbiter's decision (decideSavedHomeNudge)", /decideSavedHomeNudge\s*\(/.test(ms))
    const se = code("lib/campaign-sequences/step-executor.ts")
    check("the sequence step executor asks the arbiter before a due step and holds next_step_at on its wait", /planner:\s*"sequence_step"/.test(se) && /arb\.decision\.kind\s*===\s*"wait"/.test(se) && /next_step_at:\s*retryAt/.test(se))
    const ec = code("app/actions/ai-isa/engage-contact.ts")
    check("stale-contact candidates reach the arbiter (engageContact → arbitrateAndRecordExperience) and the arbiter's channel wins over next-best-touch", /arbitrateAndRecordExperience\s*\(/.test(ec) && /touchChannelForDecision\(arbiterDecision\)\s*\?\?\s*resolvedChannel/.test(ec))
  }

  // ══ §C ═══════════════════════════════════════════════════════════════════════════════════════════
  section("C · the spacing is guidance, the planner's verdict is the fallback, the menu is closed, waits are bounded")
  const { platformFollowupPolicy } = await import("../lib/ai-isa/followup-policy")
  const policy = platformFollowupPolicy()
  const cadenceIn = (over: { shouldSend: boolean; lastOut: number | null; lastAct: number | null; daysDeferred?: number }) => ({
    brokerageId: B1, policy,
    cadence: { shouldSend: over.shouldSend, phase: 2 as const, daysSinceStart: 20, reason: over.shouldSend ? "phase2_due" : "phase2_too_soon" },
    facts: { leadTemperature: "warm", leadScore: 55, timeline: "3-6_months", attempts: 3, hoursSinceLastOutreach: over.lastOut, hoursSinceLastActivity: over.lastAct, daysDeferred: over.daysDeferred ?? 0, source: "website", preferences: [] },
    proposals: { angles: { suggested: "market_timing", offered: ["life_context", "market_timing", "expertise", "soft_close"] }, newsletter: null },
  })
  {
    const r1 = recorder(says("send_now:expertise"))
    const quiet = await arb.arbitrateCadence(cadenceIn({ shouldSend: false, lastOut: 200, lastAct: 200 }), { decide: r1.d as never })
    check("not due + nothing new since the last touch → the guidance holds WITHOUT a model call (no evidence, nothing to judge)", !quiet.sendNow && r1.calls.length === 0 && /spacing guidance holds/.test(quiet.skippedReason ?? ""), quiet.skippedReason ?? "")
    const r2 = recorder(says("send_now:expertise"))
    const fresh = await arb.arbitrateCadence(cadenceIn({ shouldSend: false, lastOut: 200, lastAct: 5 }), { decide: r2.d as never })
    check("RULING 7: not due on the spacing, but the lead was active since our last touch → the ARBITER is asked and may answer now", r2.calls.length === 1 && fresh.sendNow && fresh.angle === "expertise", JSON.stringify({ s: fresh.sendNow, a: fresh.angle, why: fresh.skippedReason }))
    const down = await arb.arbitrateCadence(cadenceIn({ shouldSend: false, lastOut: 200, lastAct: 5 }), { decide: outage as never })
    check("…an outage on a not-due touch keeps the guidance's WAIT (never an early send)", !down.sendNow && down.decision?.source === "deterministic", JSON.stringify(down.decision?.fallbackReason))
    const due = await arb.arbitrateCadence(cadenceIn({ shouldSend: true, lastOut: 800, lastAct: 800 }), { decide: outage as never })
    check("a due touch with the model down → sends on the adaptive planner's SUGGESTED angle (its verdict is the fallback)", due.sendNow && due.angle === "market_timing")
    const held = await arb.arbitrateCadence(cadenceIn({ shouldSend: true, lastOut: 800, lastAct: 800 }), { decide: says("wait", { waitHours: 30 }) as never })
    check("a due touch may WAIT a bounded time on the arbiter's word", !held.sendNow && held.decision?.waitHours === 30)
    const r3 = recorder(says("wait", { waitHours: 30 }))
    const overdue = await arb.arbitrateCadence(cadenceIn({ shouldSend: true, lastOut: 800, lastAct: 800, daysDeferred: policy.arbiter.maxDeferDays }), { decide: r3.d as never })
    check("held maxDeferDays already → the wait is withdrawn (a person is never deferred forever)", overdue.sendNow && overdue.decision?.source === "deterministic" && !(overdue.decision?.menu ?? []).includes("wait"), JSON.stringify(overdue.decision?.menu))
    const floor = recorder(says("send_now:expertise"))
    const tooSoon = await arb.arbitrateCadence(cadenceIn({ shouldSend: true, lastOut: 2, lastAct: 1 }), { decide: floor.d as never })
    check("the fatigue floor is deterministic — inside it nothing is asked and nothing goes", !tooSoon.sendNow && floor.calls.length === 0 && /fatigue floor/.test(tooSoon.skippedReason ?? ""))
    const off = await arb.arbitrateCadence(cadenceIn({ shouldSend: true, lastOut: 800, lastAct: 800 }), { decide: says("send_now:not_an_angle") as never })
    check("the menu is closed: an angle off the menu is refused → the planner's suggestion stands", off.sendNow && off.angle === "market_timing" && off.decision?.source === "deterministic")
    const nl = await arb.arbitrateCadence({ ...cadenceIn({ shouldSend: true, lastOut: 2000, lastAct: 2000 }), proposals: { angles: null, newsletter: { suggested: true, reason: "newsletter (default order, rotated off email)" } } }, { decide: outage as never })
    check("next-best-touch's newsletter downshift is an OPTION; with the model down its pick stands (newsletter)", nl.sendNow && nl.newsletter === true)
    const nl2 = await arb.arbitrateCadence({ ...cadenceIn({ shouldSend: true, lastOut: 2000, lastAct: 2000 }), proposals: { angles: null, newsletter: { suggested: true, reason: "x" } } }, { decide: says("send_now") as never })
    check("…and the arbiter may choose a 1:1 note over it", nl2.sendNow && nl2.newsletter === false)
  }
  {
    const w = db()
    const opts = [{ id: "a", kind: "communication" as const, channels: ["email" as const], why: ["x"] }, { id: "b", kind: "agent_intervention" as const, channels: ["human_task" as const], why: ["y"] }]
    const base = { brokerageId: B1, planner: "saved_home_nudge" as const, subject: { type: "contact" as const, id: C1 }, now: NOW, options: opts, planned: "a", moment: { key: "k", intent: "i" }, policy }
    const off = await arb.arbitratePlannedTouch(w as never, base, { decide: says("z") as never })
    check("arbitratePlannedTouch: an option off the menu keeps the PLANNER's verdict", off.choice === "a" && off.decision.source === "deterministic")
    const ok = await arb.arbitratePlannedTouch(w as never, base, { decide: says("b") as never })
    check("arbitratePlannedTouch: the model's choice on the menu is honoured", ok.choice === "b" && ok.decision.source === "ai")
    check("every decision is ledgered (followup.decision.*, planner-scoped cycle)", ok.recorded && (w.tables.agent_action_ledger ?? []).some((r) => String(r.action).startsWith("followup.decision.") && String(r.idempotency_key ?? r.cycle ?? "").length > 0))
    const wait = await arb.arbitratePlannedTouch(w as never, { ...base, planner: "lead_nurture" }, { decide: says("wait", { waitHours: 12 }) as never })
    check("a bounded wait is offered and honoured", wait.choice === "wait" && wait.decision.waitHours === 12)
    const p1 = { ...policy, arbiter: { ...policy.arbiter, maxDeferDays: 1 } }
    const second = await arb.arbitratePlannedTouch(w as never, { ...base, planner: "lead_nurture", now: new Date(NOW.getTime() + 60_000), policy: p1 }, { decide: says("wait", { waitHours: 12 }) as never })
    check("…once the person was held policy.arbiter.maxDeferDays, the wait is withdrawn (the wait row bounds the next decision)", second.choice !== "wait" && !second.decision.menu.includes("wait"), JSON.stringify(second.decision.menu))
    const unreadable = memSupabase({ agent_action_ledger: [] }, { refuse: { agent_action_ledger: "permission denied" } })
    const blind = await arb.arbitratePlannedTouch(unreadable as never, { ...base, planner: "lead_nurture" }, { decide: says("wait", { waitHours: 12 }) as never, record: false })
    check("an unreadable wait history offers NO wait (fail closed)", blind.choice !== "wait" && !blind.decision.menu.includes("wait"))
  }
  {
    const sh = await import("../lib/ai-isa/saved-home-nudge")
    const uc = sh.classifySavedHomeNudge("under_contract")!
    const r = await sh.decideSavedHomeNudge(db() as never, { brokerageId: B1, contactId: C1, nudge: uc }, { decide: says("avatar_reel") as never })
    check("saved-home: under contract never offers a reel — the model asking for one is refused (owner ruling 2026-09-08 holds)", r.route === "written_note" && r.source === "deterministic")
    const pd = sh.classifySavedHomeNudge("price_drop")!
    const rec = recorder(says("wait", { waitHours: 24 }))
    const r2 = await sh.decideSavedHomeNudge(db() as never, { brokerageId: B1, contactId: C1, nudge: pd }, { decide: rec.d as never })
    check("saved-home: a time-critical change (price drop) is never held — no wait is offered", r2.route !== "hold" && !/"id":"wait"/.test(rec.calls[0]?.prompt ?? ""))
    const r3 = await sh.decideSavedHomeNudge(db() as never, { brokerageId: B1, contactId: C1, nudge: pd }, { decide: outage as never })
    check("saved-home: model down → the classifier's pick (a personal reel for a price drop)", r3.route === "avatar_reel")
    const r4 = await sh.decideSavedHomeNudge(db() as never, { brokerageId: B1, contactId: C1, nudge: sh.classifySavedHomeNudge("new_match")! }, { decide: says("agent") as never })
    check("saved-home: the arbiter may hand it to the agent", r4.route === "agent")
  }
  {
    const ge = await import("../lib/ai-isa/ghost-escalation")
    const keep = await ge.decideGhostEscalation(db() as never, { leadId: L1, brokerageId: B1, attempts: 9 }, { decide: says("continue_nurture") as never })
    check("ghost-escalation: the arbiter may let the quiet nurture continue (no FYI)", !keep.escalate && keep.source === "ai")
    const down = await ge.decideGhostEscalation(db() as never, { leadId: L1, brokerageId: B1, attempts: 9 }, { decide: outage as never })
    check("ghost-escalation: model down → the FYI is the fallback (escalate)", down.escalate && down.source === "deterministic")
  }
  {
    const ln = await import("../lib/ai-isa/lead-nurture")
    const w = db({ leads: [{ id: L1, brokerage_id: B1, ai_isa_owner: true, contact_id: null, first_name: "Sam", email: "sam@example.com", email_verified: true, email_opt_out: false, mailing_address: "1 Elm St", mailing_city: "Pace", mailing_state: "FL", mailing_zip: "32571", mailing_address_verified: true }] })
    const r = await ln.proposeLeadNurture({ brokerageId: B1, leadId: L1, agentUserId: U1, intentScore: 0.82 }, w as never, { decide: says("wait", { waitHours: 48 }) as never })
    check("lead-nurture: both channels are PERMITTED by verification, and the arbiter's bounded wait proposes NEITHER (nothing staged)", r.channels.email && r.channels.postcard && r.emailVideo === null && r.postcard === null && r.actions.some((a) => /arbiter \(ai\) chose wait/.test(a)), JSON.stringify(r.actions))
  }

  // ══ §D ═══════════════════════════════════════════════════════════════════════════════════════════
  section("D · the loop: inbound → decision → action → outcome → next-best-action (memSupabase)")
  {
    const ua = await import("../lib/communications/unattended-answer")
    const ct = await import("../lib/kernel/completion-tracking")
    const w = db({
      messages: [{ id: "m-1", brokerage_id: B1, direction: "inbound", conversation_id: "conv-1", contact_id: C1, body: "Any update on where we are with the house?", metadata: { channel: "email", subject: "Our closing" }, created_at: ago(300) }],
      contacts: [{ id: C1, brokerage_id: B1, first_name: "Dana", agent_id: "ag-1", dnc_status: false, ai_outreach_paused: false, source: "website", created_at: ago(60 * 24 * 30) }],
    })
    const schedule = async () => ({ scheduled: true })
    const engine = { emit: async () => ({ error: null }), propose: async () => ({ id: "p-1", error: null }) }
    // 1 · INBOUND: the email the client sent was handed to a person (C13 → C14 awaiting_human).
    const o = await ct.openCompletion(w as never, { brokerageId: B1, kind: "inbound_response", ownerManager: "ai_isa", subject: { type: "contact", id: C1 }, sourceRef: "inbound:m-1", what: "Answer the email that arrived", stage: "awaiting_human", expectedEvidence: ["human_action"], dueAt: ago(5), context: { record_id: "m-1", channel: "email", agent_user_id: U1, contact_id: C1 } }, { schedule })
    check("1 · inbound: the client's email opened an obligation waiting on a person", o.ok)
    const decided = recorder(says("answer_with_video"))
    const sent: Row[] = [], videos: Row[] = []
    const answerers = ua.unattendedAnswerers({
      now: NOW, decide: decided.d as never,
      facts: async () => ({ facts: [{ fact: "Their transaction for 12 Elm St is Pending (stage: appraisal).", source: "transactions:t-1" }], blindSpots: [] }),
      authority: async () => ({ allowed: true, reason: null }), safety: () => [],
      compose: async () => ({ object: { topic: "status" as const, answer: "Hi Dana — your purchase of 12 Elm St is in the appraisal stage. Your agent will follow up with anything new.", facts_used: [1], hands_back_to_agent: true, refuse: false, refuse_reason: null } }),
      sendEmail: async (p) => { sent.push(p as never); return { sent: true, providerRef: "EM-1", messageId: "out-1" } },
      sendSms: async () => { throw new Error("the text path must not be used for an email") },
      requestVideo: async (_s, p) => { videos.push(p as never); return { requested: true } },
      notify: async () => {},
    })
    // 2 · DECISION + 3 · ACTION: the window passed; the supervisor hands the stall to the answerer, which asks the ARBITER.
    const sup = await ct.superviseCompletion(w as never, { brokerageId: B1, completionId: o.ok ? o.completion.id : "", trigger: "workflow" }, { schedule, engine, notify: async () => ({ notified: 1 }), silentAnswerers: answerers })
    check("2 · decision: the ARBITER was asked how to answer, under its unattended brief", decided.calls.length === 1 && decided.calls[0].system === ua.ARBITER_UNATTENDED_SYSTEM && /answer_with_video/.test(decided.calls[0].prompt))
    check("3 · action: answered on the client's OWN channel (email — no longer text only) + the personal video update requested", sent.length === 1 && sent[0].subject === "Our closing" && videos.length === 1 && sup.verdict === "remediated", `${sup.verdict} ${sup.reason}`)
    const row = w.tables.manager_completions[0]
    check("…the arbiter's decision and the answer are both on the ledger (LAW 5)", (w.tables.agent_action_ledger ?? []).some((r) => String(r.action).startsWith("followup.decision.")) && (w.tables.agent_action_ledger ?? []).some((r) => r.action === "inbound.unattended.answer" && r.channel === "email"))
    // 4 · OUTCOME: the provider's delivery report closes the obligation on evidence.
    w.tables.outcome_reconciliations.push({ id: "or-1", brokerage_id: B1, channel: "email", provider_ref: "EM-1", verdict: "confirmed", provider_status: "delivered", provider_detail: null })
    const closed = await ct.onProviderTruth(w as never, { brokerageId: B1, providerRef: "EM-1", verdict: "confirmed" }, { schedule })
    check("4 · outcome: the delivery report closes the obligation (awaiting_delivery → closed)", row.provider_ref === "EM-1" && closed?.verdict === "closed" && w.tables.manager_completions[0].status === "closed", `${closed?.verdict}`)
    // 5 · NEXT-BEST-ACTION: the next touch for this person is the arbiter's again, and it reads what just happened.
    const next = recorder(says("wait", { waitHours: 48 }))
    const nba = await arb.arbitratePlannedTouch(w as never, { brokerageId: B1, planner: "saved_home_nudge", subject: { type: "contact", id: C1 }, now: new Date(NOW.getTime() + 3_600_000), options: [{ id: "written_note", kind: "communication", channels: ["email"], why: ["a home they saved changed"] }], planned: "written_note", moment: { key: "saved_home_new_match", intent: "a new match" }, history: { hoursSinceAnyTouch: 1, lastChannel: "email" }, policy }, { decide: next.d as never })
    check("5 · next-best-action: the following touch is the arbiter's decision over the fresh history (touched 1h ago → it may wait)", nba.choice === "wait" && /"hoursSinceAnyTouch":1/.test(next.calls[0]?.prompt ?? ""))
  }
  {
    const ua = await import("../lib/communications/unattended-answer")
    const SECTIONS = ["ROLE.", "BUSINESS CONTEXT.", "FACTS YOU MAY RELY ON", "THE DECISION YOU OWN", "ESCALATION RULE.", "COMPLIANCE BOUNDARY.", "OUTPUT CONTRACT."]
    check("the unattended decision brief is an expert, structured prompt (every section, a typed JSON contract; money / approval never reach it)", SECTIONS.every((s) => ua.ARBITER_UNATTENDED_SYSTEM.includes(s)) && /JSON/.test(ua.ARBITER_UNATTENDED_SYSTEM) && /Money, approvals, signatures, legal/.test(ua.ARBITER_UNATTENDED_SYSTEM))
  }

  console.log("\n BLIND SPOTS: the census is LEXICAL — a schedule spelled without an outbound word or a time unit in its name (e.g. `const X = 7` used as days), a schedule stored in a DB row (campaign_sequence_steps.delay_days, campaign bundle send_after_minutes, strategy cadenceDays, ai_isa_settings.touch_interval_days) or computed inline (`7 * 86_400_000` next to a send) is NOT seen; the step executor's arbiter hold is proven on stripped source (executeSequenceStep builds its own service client); the model is stubbed (the briefs are asserted by section); dispatchEmail / dispatchSms gates are seams here (test:egress-send-guard owns them); the inbound → completion hop is opened directly (the responder's own proof, test:inbound-sms-arbiter / test:unattended-answer, drives C13); no live soak.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(` failed: ${failures.join(" | ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
