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
import { registerHooks } from "node:module"
import { memSupabase, type Row } from "./in-memory-supabase"
import { blankComments, stripComments, blankStrings } from "./strip-comments"

// WAVE 153 (153F) §E: the lead-touch governor resolves the ISA settings through `./resolve-isa-settings` (a service client). Only THAT
// relative import from lib/ai-isa/lead-action-plan.ts is replaced — by the settings §E supplies (default: unreadable, exactly what the
// real resolver answers without credentials). Every other importer of the resolver is untouched.
registerHooks({
  resolve(spec: string, ctx: { parentURL?: string }, next: (s: string, c: unknown) => unknown) {
    if (spec === "./resolve-isa-settings" && /\/lib\/ai-isa\/lead-action-plan\.ts$/.test(ctx.parentURL ?? "")) {
      return { url: `data:text/javascript,${encodeURIComponent("export const resolveIsaSettingsResult = async () => globalThis.__153F_isa ?? { status: 'unreadable', ownerType: 'brokerage', ownerId: null, detail: 'no settings supplied' }")}`, shortCircuit: true }
    }
    return next(spec, ctx)
  },
} as never)

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
  "lib/ai-isa/settings-types.ts#touch_interval_days": { kind: "carried", owner: "lane 152I (row 86 — partly routed)", reason: "the RELEASE of every due lead touch now passes arbitratePlannedTouch (planner lead_touch_release, lib/ai-isa/lead-action-plan.ts releaseDueLeadTouches — release now or a bounded wait); the interval still bounds when planNextLeadTouch may AUTHOR the next step — wave 153 (lane 153F): an EARLY touch on fresh lead activity is authored inside the interval (planLeadTouchCore, FRESH_ACTIVITY_MARGIN_MS); the interval remains guidance for a quiet lead" },
  "app/dashboard/isa/campaigns/components/CreateCampaignDrawer.tsx#DEFAULT_TOUCH_INTERVAL": { kind: "carried", owner: "lane 149C (Still open 1)", reason: "the UI default of the same touch_interval_days setting" },
  "lib/kernel/strategy-library.ts#cadenceDays": { kind: "carried", owner: "lane 149C (Still open 2)", reason: "strategy-library step cadence — wave 153 (lane 153H, 153H-7): read only by adaptStrategy (an adapted field) and the Campaign Orchestrator's planning-brief text; no timer, cron or sender reads it (the mission deadline uses horizonDays) and an enrolled Contact's steps go through the step executor, which asks arbitratePlannedTouch for every step after the first; the brief's wording is the remaining text fix" },
  // CLOSED (wave 150, lane 150SZ — wave-149 §4 C-3): creative-playbooks `sendAfterMinutes` removed; the playbook proposes order only and
  // the dispatch-time arbiter door is the bundle dispatcher owner's (lane 150SZ notes, Outside-lane). The bundle builder default below stays carried.
  "app/settings/campaign-bundles/client.tsx#send_after_minutes": { kind: "carried", owner: "campaign_orchestrator (wave 153, lane 153I — row 71 CLOSED)", reason: "the stored column only; nothing reads it for timing — lib/direct-mail/orchestrate-bundle-send.ts persists each later item as a follow-on and arbitratePlannedTouch times it at the drain (app/api/cron/queue-drain)" },
  // CLOSED (wave 150, lane 150SZ — wave-149 §4 C-4): section-drip `DEFAULT_DRIP_WINDOW_DAYS` removed; deliverDueSections asks the arbiter
  // (arbitrateSectionDelivery → arbitrateFollowUp) before each part after the first; proven by scripts/lifetime-relationship-guard.ts.
}
/** Files whose constants are the arbiter's POLICY (it reads them as guidance, inside the judgment). */
const POLICY_FILES = new Set(["lib/ai-isa/followup-policy.ts"])
/** Names that are not schedules at all (counters, research cadences) — each with why. */
const NOT_A_SCHEDULE: Record<string, string> = {
  outreachLast30Days: "a COUNT of past outreach (a reading), not a schedule",
  cadenceMinutes: "lib/intent/movement-source-*: how often a PUBLIC DATASET is polled (research) — never a touch to a person (lane H's)",
  updateCadenceDays: "lib/lead-pipeline/freshness.ts FRESHNESS_POLICIES (wave 151, lane 151C): how often a HELD provider record may be RE-VERIFIED (a re-read interval that bounds provider spend — pre-pull-dedup / the planner read it) — never a touch to a person; any contact is the arbiter's",
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
    const lap = code("lib/ai-isa/lead-action-plan.ts")
    const releaseBody = lap.slice(lap.indexOf("export async function releaseDueLeadTouches"))
    const ORDER_ARB = /arbitratePlannedTouch\(supabase,\s*\{[\s\S]{0,200}planner:\s*"lead_touch_release"/
    const ORDER_SEND = /approveClientMessage\(messageId/
    const arbAt = releaseBody.search(ORDER_ARB), sendAt = releaseBody.search(ORDER_SEND)
    check("row 86 · releaseDueLeadTouches asks the arbiter (planner lead_touch_release) BEFORE the sender releases a due lead touch, and an arbiter wait skips the send", arbAt > 0 && sendAt > arbAt && /arb\.choice\s*===\s*"wait"[\s\S]{0,600}continue/.test(releaseBody))
    const fixture = 'x\napproveClientMessage(messageId, null)\n arbitratePlannedTouch(supabase, { planner: "lead_touch_release" })'
    check("row 86 · POSITIVE CONTROL: the order finder refuses a release that sends before it asks", !(fixture.search(ORDER_ARB) > 0 && fixture.search(ORDER_SEND) > fixture.search(ORDER_ARB)) && fixture.search(ORDER_ARB) > 0)
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

  {
    // WAVE 152 (lane 152I — convergence row 73): the review ask at a verified closing passes the arbiter's planner door.
    const ra = await import("../lib/reputation/review-ask")
    const TX = "tx-ra-1", AG = "ag-ra-1", BUYER = "c-ra-b", SELLER = "c-ra-s", GOOGLE = "https://g.page/r/CabcdEfgh123/review"
    const closeDate = new Date(NOW.getTime() - 6 * 86_400_000).toISOString().slice(0, 10)
    const world = (seed: Row[] = []) => db({
      transactions: [{ id: TX, brokerage_id: B1, agent_id: AG, status: "closed", close_date: closeDate, deal_type: "dual", contact_id: BUYER, buyer_contact_id: BUYER, seller_contact_id: SELLER }],
      brokerage_settings: [{ id: "s1", brokerage_id: B1, review_request_delay_days: 3, settings: { reputation_profiles: { google: { url: GOOGLE } } } }],
      contacts: [BUYER, SELLER].map((id) => ({ id, brokerage_id: B1, first_name: "Pat", last_name: "Lee", email: `${id}@example.test`, phone: null, preferred_channel: null, tcpa_consent: false, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, dnc_status: false })),
      agents: [{ id: AG, brokerage_id: B1, user_id: U1 }], review_requests: seed,
    })
    const R = { drafts: 0, sends: 0, notes: [] as string[] }
    const deps = (decide: Decide | null) => ({
      now: () => NOW,
      draft: async (svc: any, input: any) => { R.drafts++; const id = `rr-${R.drafts}`; svc.tables.review_requests.push({ id, brokerage_id: input.brokerageId, contact_id: input.contactId, status: "pending", sent_at: null, created_at: NOW.toISOString() }); return { success: true, reviewRequestId: id, message: `Hi Pat — an honest review of your experience would mean a lot: ${GOOGLE}`, data: { subject: "How was your experience?" } } },
      dispatchEmail: async () => { R.sends++; return { success: true, messageId: `m${R.sends}` } },
      dispatchSms: async () => { R.sends++; return { success: true, messageId: `s${R.sends}` } },
      emit: async () => ({}),
      notifyAgent: async (_s: unknown, a: { type: string }) => { R.notes.push(a.type) },
      notifyBrokerageAdmins: async () => ({}),
      ...(decide ? { arbitrate: (svc: any, a: any) => arb.arbitratePlannedTouch(svc, { brokerageId: a.brokerageId, planner: "review_ask", subject: { type: "contact", id: a.contactId }, now: a.now, options: [{ id: "ask_now", kind: "communication", channels: ["email"], why: ["due"] }, { id: "agent_asks", kind: "agent_intervention", channels: ["human_task"], why: ["personal"] }], planned: "ask_now", moment: { key: "review_ask_at_close", intent: "ask" }, policy }, { decide: decide as never }) } : {}),
    })
    const reset = () => { R.drafts = 0; R.sends = 0; R.notes.length = 0 }
    reset()
    const w1 = world()
    const held = await ra.askForReviewAtClose(w1 as never, { brokerageId: B1, transactionId: TX }, deps(says("wait", { waitHours: 24 })) as never)
    check("row 73 · the arbiter may HOLD the review ask a bounded time: nothing drafted (no spend), nothing sent, the result says until when", held.results.length === 2 && held.results.every((r) => r.status === "skipped" && r.reason === "arbiter_wait" && !!r.dueAt) && R.drafts === 0 && R.sends === 0, JSON.stringify(held.results))
    check("row 73 · …and each decision is ledgered under the review_ask planner (followup.decision.*, LAW 5)", (w1.tables.agent_action_ledger ?? []).filter((r) => String(r.action).startsWith("followup.decision.") && r.system_source === "review_ask").length === 2, JSON.stringify((w1.tables.agent_action_ledger ?? []).map((r) => [r.action, r.system_source])))
    reset()
    const handoff = await ra.askForReviewAtClose(world() as never, { brokerageId: B1, transactionId: TX }, deps(says("agent_asks")) as never)
    check("row 73 · the arbiter may hand the ask to the AGENT: a ready draft is staged + the agent is told; nothing goes to the client", handoff.results.every((r) => r.status === "staged" && r.why === "arbiter_handoff") && R.sends === 0 && R.drafts === 2 && R.notes.filter((t) => t === "review_request_ready").length === 2, JSON.stringify(handoff.results))
    reset()
    const down = await ra.askForReviewAtClose(world() as never, { brokerageId: B1, transactionId: TX }, deps(outage) as never)
    check("row 73 · model down → the planner's verdict stands: the ask goes now (a review is ALWAYS asked at closing)", down.results.every((r) => r.status === "sent") && R.sends === 2, JSON.stringify(down.results))
    reset()
    const offMenu = await ra.askForReviewAtClose(world() as never, { brokerageId: B1, transactionId: TX }, deps(says("send_a_gift_card")) as never)
    check("row 73 · ADVERSE: an option off the closed menu (an incentive) is refused → the planner's ask, nothing else", offMenu.results.every((r) => r.status === "sent") && R.sends === 2)
    reset()
    const dupWorld = world([{ id: "rr-old", brokerage_id: B1, contact_id: BUYER, status: "sent", sent_at: NOW.toISOString(), created_at: NOW.toISOString() }])
    const rec = recorder(says("ask_now"))
    const dup = await ra.askForReviewAtClose(dupWorld as never, { brokerageId: B1, transactionId: TX }, deps(rec.d) as never)
    check("row 73 · ADVERSE: an already-asked client never reaches the arbiter (deterministic duplicate gate first) — one model question, for the other client only", dup.results.some((r) => r.status === "skipped" && r.reason === "already_asked") && rec.calls.length === 1, `${rec.calls.length} model calls · ${JSON.stringify(dup.results.map((r) => r.status))}`)
    const raSrc = code("lib/reputation/review-ask.ts")
    check("row 73 · the production default asks a model only inside the application server (NEXT_RUNTIME), so a simulator never calls one by accident", /!process\.env\.NEXT_RUNTIME/.test(raSrc) && /planner:\s*"review_ask"/.test(raSrc))
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

  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("E · wave 153 (153F, owner ruling 13) — a live turn is never held for a planning call; hard stops hold; one conversation owner; per-Contact timing; the early lead touch")
  {
    const arb = await import("../lib/ai-isa/followup-arbiter")
    const responder = await import("../lib/communications/inbound-responder")
    const lap = await import("../lib/ai-isa/lead-action-plan")
    const { DEFAULT_FOLLOWUP_POLICY } = await import("../lib/ai-isa/followup-policy")
    const { DEFAULT_AISA_SETTINGS } = await import("../lib/ai-isa/settings-types")
    const policy = { ...DEFAULT_FOLLOWUP_POLICY, arbiter: { ...DEFAULT_FOLLOWUP_POLICY.arbiter, enabled: true, minConfidence: 0.3 } }
    const EB = "e1e1e1e1-0000-4000-8000-000000000001", EA = "e2e2e2e2-0000-4000-8000-000000000001", EU = "e3e3e3e3-0000-4000-8000-000000000001"
    const K1 = "e4e4e4e4-0000-4000-8000-000000000001", K2 = "e4e4e4e4-0000-4000-8000-000000000002", K3 = "e4e4e4e4-0000-4000-8000-000000000003"
    const NOWE = new Date()
    const ago = (m: number) => new Date(NOWE.getTime() - m * 60_000).toISOString()
    const world = (extra: Record<string, Row[]> = {}) => memSupabase({
      brokerages: [{ id: EB }],
      contacts: [
        { id: K1, brokerage_id: EB, agent_id: EA, first_name: "Dana", dnc_status: false, ai_outreach_paused: false, source: "website", created_at: "2026-01-01T00:00:00Z" },
        { id: K2, brokerage_id: EB, agent_id: EA, first_name: "Riley", dnc_status: true, ai_outreach_paused: false, source: "website", created_at: "2026-01-01T00:00:00Z" },
        { id: K3, brokerage_id: EB, agent_id: EA, first_name: "Sam", dnc_status: false, ai_outreach_paused: false, source: "website", created_at: "2026-01-01T00:00:00Z" },
      ],
      agents: [{ id: EA, brokerage_id: EB, user_id: EU, is_active: true }],
      conversations: [{ id: "cv-1", brokerage_id: EB, contact_id: K1, agent_id: EA }, { id: "cv-2", brokerage_id: EB, contact_id: K2, agent_id: EA }, { id: "cv-3", brokerage_id: EB, contact_id: K3, agent_id: EA }],
      messages: [], agent_action_ledger: [], activities: [], ai_message_drafts: [], notifications: [],
      ...extra,
    }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    type Decide = (a: { brokerageId: string; system: string; prompt: string }) => Promise<Record<string, unknown>>
    const mk = (o: { decide?: Decide; sendError?: string | null } = {}) => {
      const calls = { decide: 0, prompts: [] as string[], sent: [] as Array<Record<string, unknown>>, coach: 0, route: 0 }
      const deps = {
        policy, now: NOWE,
        decide: (async (a: { brokerageId: string; system: string; prompt: string }) => { calls.decide++; calls.prompts.push(a.prompt); return o.decide ? o.decide(a) : { optionId: "reply", channel: null, format: null, waitHours: null, rationale: "A question the team can answer in the thread now.", evidence: ["intent"], confidence: 0.9 } }) as never,
        autonomy: async () => ({ allowed: true, reason: null }),
        customer360For: async () => ({ ok: true, view: { fields: {} } }),
        compose: async () => ({ text: "Saturday at 11 works — I'll confirm the showing with you shortly." }),
        safety: () => [],
        sendSms: async (p: Record<string, unknown>) => { calls.sent.push(p); return o.sendError ? { sent: false, error: o.sendError } : { sent: true, providerRef: `SM-${calls.sent.length}`, messageId: `m-${calls.sent.length}` } },
        replyCoach: async () => { calls.coach++; return { success: true, draftId: "draft-1" } },
        routeToAgent: (async () => { calls.route++; return true }) as never,
      }
      return { calls, deps }
    }
    let n = 0
    const req = (o: Record<string, unknown> = {}) => ({ brokerageId: EB, contactId: K1, conversationId: "cv-1", recordId: `rec-e-${++n}`, channel: "sms", provider: "twilio", surface: "sms", body: "Can we see it Saturday at 11?", isPublic: false, threadRef: null, intent: { primary: "schedule_showing", confidence: 86, urgency: "medium" }, receivedAt: NOWE.toISOString(), ...o }) as never
    const ledgerOf = (db: ReturnType<typeof world>, recId: string) => (db.tables.agent_action_ledger ?? []).find((r) => r.action === "inbound.message.respond" && r.detail?.record_id === recId)

    // E1 · the FAST path: an inbound inquiry is answered with no planning call
    { const db = world(); const { calls, deps } = mk(); const q = req() as any
      const r = await responder.respondToInboundCommunication(db, q, deps)
      const row = ledgerOf(db, q.recordId)
      check("E1 · INBOUND INQUIRY → the acknowledgment is DISPATCHED (through the SMS chokepoint seam) with NO planning call — the arbiter's own deterministic fast decision", r.action === "reply_sent" && calls.sent.length === 1 && calls.decide === 0 && r.decision?.path === "fast" && r.decision?.source === "deterministic", JSON.stringify({ action: r.action, reason: r.reason }))
      check("E1 · …evidenced: the decision row carries the turn's path and the MEASURED decision time (decided_in_ms, wall clock)", row?.detail?.turn?.path === "fast" && typeof row?.detail?.decided_in_ms === "number" && row.detail.decided_in_ms >= 0 && row.detail.decided_in_ms < 2_000, JSON.stringify(row?.detail?.turn ?? null)) }
    // E2 · a LIVE exchange (we answered minutes ago) keeps flowing without the planner
    { const db = world({ messages: [{ id: "m-prev", brokerage_id: EB, contact_id: K1, conversation_id: "cv-1", direction: "outbound", sender_type: "ai", type: "sms", created_at: ago(4) }] }); const { calls, deps } = mk(); const q = req({ intent: { primary: "general_question", confidence: 81, urgency: "low" }, body: "Does it have a garage?" }) as any
      const r = await responder.respondToInboundCommunication(db, q, deps)
      check("E2 · a LIVE exchange (our reply 4 min ago) → the next routine turn is answered at once, no planning call, `live` on the evidence", r.action === "reply_sent" && calls.decide === 0 && ledgerOf(db, q.recordId)?.detail?.turn?.live === true) }
    // E3 · real ambiguity still reaches the arbiter's judgment (positive control: the fast path is not a bypass of the arbiter)
    { const db = world(); const { calls, deps } = mk(); const r = await responder.respondToInboundCommunication(db, req({ intent: { primary: "question", confidence: 80, urgency: "medium" } }), deps)
      check("E3 · POSITIVE CONTROL: a message the classifier could not NAME is the arbiter's call — the model is asked once, inside its budget (path deliberate)", calls.decide === 1 && r.decision?.path === "deliberate" && typeof r.decision?.latencyMs === "number" && r.action === "reply_sent") }
    // E4 · the model is slow → bounded budget, safe fallback (a PERSON for an unreadable message), never a hang
    {
      const late = { optionId: "reply", channel: null, format: null, waitHours: null, rationale: "Late answer that must be ignored entirely.", evidence: ["moment"], confidence: 0.99 }
      const facts = { subject: "contact" as const, relationship: { type: "contact", persona: null, hasAssignedAgent: true }, intent: null, history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null }, journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null }, preferences: [], fatigueRisk: null, localHour: null, moment: { key: "inbound_sms", intent: "test", daysSinceOpen: 0 }, blindSpots: [] }
      const replyOpt = { id: "reply", kind: "communication" as const, channels: ["sms" as const], why: ["answer"] }
      const humanOpt = { id: "notify_human", kind: "agent_intervention" as const, channels: ["human_task" as const], why: ["a person"] }
      const t0 = Date.now()
      const d = await arb.arbitrateFollowUp({ brokerageId: EB, facts, menu: { menu: [replyOpt, humanOpt], locked: null }, planned: humanOpt, policy, latencyBudgetMs: 40 }, { decide: () => new Promise((res) => setTimeout(() => res(late), 400)) })
      const took = Date.now() - t0
      check("E4 · the model did not answer inside its budget (40 ms) → the planner's SAFE verdict answers at once (a person), the budget named, the late answer discarded", d.optionId === "notify_human" && d.source === "deterministic" && /latency budget/.test(d.fallbackReason ?? "") && took < 300 && (d.latencyMs ?? 0) >= 35, `${took}ms ${d.fallbackReason}`)
      const quick = await arb.arbitrateFollowUp({ brokerageId: EB, facts, menu: { menu: [replyOpt, humanOpt], locked: null }, planned: humanOpt, policy, latencyBudgetMs: 500 }, { decide: () => new Promise((res) => setTimeout(() => res(late), 5)) })
      check("E4 · POSITIVE CONTROL: a model that answers inside the budget is honoured (source ai, latency measured)", quick.source === "ai" && quick.optionId === "reply" && typeof quick.latencyMs === "number" && quick.latencyMs < 500)
      check("E4 · the ceilings: a waiting person (interactive) and a first touch are bounded tighter than a sweep's planned touch", arb.ARBITER_LATENCY_BUDGET_MS.interactive <= arb.ARBITER_LATENCY_BUDGET_MS.planned && arb.ARBITER_LATENCY_BUDGET_MS.speed_to_lead <= arb.ARBITER_LATENCY_BUDGET_MS.planned)
      const db = world(); const { calls, deps } = mk({ decide: () => new Promise(() => undefined) })
      const s0 = Date.now()
      const r = await responder.respondToInboundCommunication(db, req({ intent: null, body: "hmm ok so what about that thing" }), deps)
      const rt = Date.now() - s0
      check("E4 · MODEL TIMEOUT on a live inbound: the responder answers inside the interactive budget with the SAFE fallback — an unreadable message goes to a PERSON, nothing is sent unattended", r.action === "human_task" && calls.sent.length === 0 && calls.decide === 1 && rt < arb.ARBITER_LATENCY_BUDGET_MS.interactive + 1_500 && /latency budget/.test(r.decision?.fallbackReason ?? ""), `${rt}ms ${r.action} ${r.decision?.fallbackReason}`)
    }
    // E5 · the deterministic hard stops still apply on the fast path
    { const db = world(); const { calls, deps } = mk(); const r = await responder.respondToInboundCommunication(db, req({ contactId: K2, conversationId: "cv-2" }), deps)
      check("E5 · DNC: a do-not-contact person's routine message → a PERSON decides; nothing sent, no model asked", r.action === "human_task" && calls.sent.length === 0 && calls.decide === 0) }
    { const db = world(); const { calls, deps } = mk(); const r = await responder.respondToInboundCommunication(db, req({ intent: { primary: "unsubscribe", confidence: 90, urgency: "high" }, body: "please stop texting me" }), deps)
      check("E5 · STOP: a request to stop → no automated answer at all (the opt-out door owns it)", r.action === "no_response" && calls.sent.length === 0 && calls.decide === 0) }
    { const db = world(); const { calls, deps } = mk({ sendError: "Outbound blocked: quiet_hours" }); const r = await responder.respondToInboundCommunication(db, req(), deps)
      check("E5 · QUIET HOURS: the fast path decided, the SMS chokepoint refused → nothing left; a person gets the draft with the reason", r.action === "reply_proposed" && /quiet_hours/.test(r.reason) && calls.coach === 1 && calls.decide === 0) }
    { const db = world(); const { calls, deps } = mk({ sendError: "Outbound blocked: no TCPA consent on file" }); const r = await responder.respondToInboundCommunication(db, req(), deps)
      check("E5 · MISSING CONSENT: the chokepoint's consent gate refuses → a person gets the draft (the fast path never bypasses consent)", r.action === "reply_proposed" && /TCPA consent/.test(r.reason) && calls.coach === 1) }
    // E6 · a request for a person is a deterministic stop and makes the thread the person's
    { const db = world(); const { calls, deps } = mk()
      const q1 = req({ body: "Can I talk to a real person please?", intent: { primary: "general_question", confidence: 84, urgency: "medium" } }) as any
      const r1 = await responder.respondToInboundCommunication(db, q1, deps)
      const marker = ledgerOf(db, q1.recordId)?.detail?.conversation_owner
      check("E6 · HUMAN HANDOFF REQUEST → a person is handed it now (task), the AI does not answer, the model is never asked", r1.action === "human_task" && calls.sent.length === 0 && calls.decide === 0 && calls.route === 1)
      check("E6 · …and the thread is stamped the person's (owner human, a reason, a bounded future `until` — at least an hour, at most the replay window) on the decision row", marker?.owner === "human" && marker?.reason === "handoff_requested" && Date.parse(marker?.until ?? "") >= NOWE.getTime() + 3_600_000 && Date.parse(marker?.until ?? "") <= NOWE.getTime() + 7 * 86_400_000, JSON.stringify(marker ?? null))
      const r2 = await responder.respondToInboundCommunication(db, req(), deps)
      check("E6 · ONE CONVERSATION OWNER: their next routine message is NOT answered by the AI while the person owns the thread", r2.action === "human_task" && calls.sent.length === 0 && /owns this conversation/.test(r2.reason), r2.reason)
      const r3 = await responder.respondToInboundCommunication(db, req({ contactId: K3, conversationId: "cv-3" }), deps)
      check("E6 · POSITIVE CONTROL: another person's routine message in the same tenant is answered (the ownership is per person)", r3.action === "reply_sent" && calls.sent.length === 1) }
    // E7 · an agent typing in the thread → no duplicate AI reply
    { const db = world({ messages: [{ id: "m-agent", brokerage_id: EB, contact_id: K1, conversation_id: "cv-1", direction: "outbound", type: "sms", body: "Hi Dana, checking on Saturday for you now", created_at: ago(5) }] }); const { calls, deps } = mk()
      const r = await responder.respondToInboundCommunication(db, req(), deps)
      check("E7 · HUMAN ENGAGED: the agent wrote in this thread 5 min ago → the AI stays silent (one owner), the agent has the task", r.action === "human_task" && calls.sent.length === 0 && /wrote in this conversation/.test(r.reason), r.reason) }
    { const db = world({ messages: [{ id: "m-ai", brokerage_id: EB, contact_id: K1, conversation_id: "cv-1", direction: "outbound", sender_type: "ai", type: "sms", created_at: ago(5) }] }); const { calls, deps } = mk()
      const r = await responder.respondToInboundCommunication(db, req(), deps)
      check("E7 · POSITIVE CONTROL: the AI's OWN reply 5 min ago is not a human in the thread — the turn is answered", r.action === "reply_sent" && calls.sent.length === 1) }
    { const db = world({ messages: [{ id: "m-agent-old", brokerage_id: EB, contact_id: K1, conversation_id: "cv-1", direction: "outbound", type: "sms", created_at: ago(6 * 60) }] }); const { calls, deps } = mk()
      const r = await responder.respondToInboundCommunication(db, req(), deps)
      check("E7 · …and an agent message older than the engaged window no longer silences the AI", r.action === "reply_sent" && calls.sent.length === 1) }

    // E8 · per-Contact timing at the planner door — two people, two answers (even on a model outage)
    {
      const T = new Date("2026-11-14T15:00:00Z") // 10:00 in America/New_York
      const tAgo = (h: number) => new Date(T.getTime() - h * 3_600_000).toISOString()
      const P1 = "e5e5e5e5-0000-4000-8000-000000000001", P2 = "e5e5e5e5-0000-4000-8000-000000000002", P3 = "e5e5e5e5-0000-4000-8000-000000000003", P4 = "e5e5e5e5-0000-4000-8000-000000000004", P5 = "e5e5e5e5-0000-4000-8000-000000000005"
      const w = memSupabase({
        contacts: [
          { id: P1, brokerage_id: EB }, { id: P2, brokerage_id: EB }, { id: P3, brokerage_id: EB, preferred_contact_time: "evenings", time_zone: "America/New_York" }, { id: P4, brokerage_id: EB }, { id: P5, brokerage_id: EB },
        ],
        buyer_fatigue_scores: [{ id: "f1", brokerage_id: EB, contact_id: P1, risk_level: "high", last_calculated_at: tAgo(2) }],
        messages: [
          { id: "p2-out", brokerage_id: EB, contact_id: P2, direction: "outbound", sender_type: "ai", created_at: tAgo(30) },
          { id: "p2-in", brokerage_id: EB, contact_id: P2, direction: "inbound", created_at: tAgo(3) },
        ],
        agent_action_ledger: [{ id: "own-1", brokerage_id: EB, subject_type: "contact", subject_id: P5, action: "inbound.message.respond", created_at: tAgo(1), detail: { conversation_owner: { owner: "human", reason: "handoff_requested", until: new Date(T.getTime() + 5 * 3_600_000).toISOString() } } }],
      }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
      const options = [{ id: "written_note", kind: "communication" as const, channels: ["email" as const], why: ["a home they saved changed"] }]
      const ask = (id: string, decide: Decide) => arb.arbitratePlannedTouch(w as never, { brokerageId: EB, planner: "saved_home_nudge", subject: { type: "contact", id }, now: T, options, planned: "written_note", moment: { key: "saved_home_new_match", intent: "a new match" }, policy }, { decide: decide as never })
      const outage: Decide = async () => { throw new Error("provider 503") }
      const [a1, a2, a3, a4] = [await ask(P1, outage), await ask(P2, outage), await ask(P3, outage), await ask(P4, outage)]
      check("E8 · PER-CONTACT TIMING on an OUTAGE: fatigue high → a bounded ease-off for the tenant's own floor; replied after our touch → the touch now; asked for evenings at 10:00 their time → wait 7h for the window; no signals → the planner's verdict",
        a1.choice === "wait" && a1.decision.waitHours === policy.guardrails.minHoursBetweenTouches && a2.choice === "written_note" && a3.choice === "wait" && a3.decision.waitHours === 7 && a4.choice === "written_note",
        JSON.stringify([a1, a2, a3, a4].map((x) => [x.choice, x.decision.waitHours])))
      const rec = (): { calls: string[]; d: Decide } => { const calls: string[] = []; return { calls, d: async (x) => { calls.push(x.prompt); return { optionId: "written_note", channel: "email", format: null, waitHours: null, rationale: "The evidence says now is a fine moment for a useful note.", evidence: ["moment"], confidence: 0.8 } } } }
      const r1 = rec(), r2 = rec(), r3 = rec(), r4 = rec()
      await ask(P1, r1.d); await ask(P2, r2.d); await ask(P3, r3.d); await ask(P4, r4.d)
      check("E8 · …and the MODEL sees each person's own timing evidence (fatigue / they are waiting on us / the window they asked for and their local hour) — four different prompts, not one",
        /"fatigueRisk":"high"/.test(r1.calls[0] ?? "") && /"urgency":"high"/.test(r2.calls[0] ?? "") && /"key":"preferred_contact_time","value":"evenings"/.test(r3.calls[0] ?? "") && /"localHour":10/.test(r3.calls[0] ?? "") && !/"fatigueRisk":"high"|"urgency":"high"/.test(r4.calls[0] ?? "") && new Set([r1, r2, r3, r4].map((r) => r.calls[0])).size === 4)
      const r5 = rec(); const a5 = await ask(P5, r5.d)
      const held = (w.tables.agent_action_ledger ?? []).find((r) => r.subject_id === P5 && String(r.action).startsWith("followup.decision."))
      check("E8 · ONE CONVERSATION OWNER at the planner door: a person owns P5's conversation → the planned touch is HELD with no model call, ledgered with the timing reading",
        a5.choice === "wait" && a5.decision.fallbackReason === "human_owns_conversation" && r5.calls.length === 0 && held?.detail?.timing?.verdict === "human_owns" && (a5.decision.waitHours ?? 0) >= 1, JSON.stringify(a5.decision))
    }

    // E9 · row 86's remaining step — the EARLY lead touch on fresh activity (the interval is guidance, the floor is deterministic)
    {
      const T = new Date("2026-11-14T15:00:00Z")
      const h = (x: number) => new Date(T.getTime() - x * 3_600_000)
      const base = { now: T, settings: { ...DEFAULT_AISA_SETTINGS, touch_interval_days: 3 }, touchesSoFar: 1, lastChannel: "email", channelsAlreadyStaged: [] as never[], emailUsable: true, mailingVerified: true, reelReady: false, lifecycleState: null }
      const quiet = lap.planNextLeadTouch({ ...base, lastTouchAt: h(60), lastLeadActivityAt: null })
      const active = lap.planNextLeadTouch({ ...base, lastTouchAt: h(60), lastLeadActivityAt: h(10) })
      const before = lap.planNextLeadTouch({ ...base, lastTouchAt: h(60), lastLeadActivityAt: h(70) })
      const inFloor = lap.planNextLeadTouch({ ...base, lastTouchAt: h(24), lastLeadActivityAt: h(2) })
      check("E9 · a QUIET lead inside touch_interval_days waits (interval_not_elapsed) — the interval still guides", quiet.code === "interval_not_elapsed")
      check("E9 · FRESH ACTIVITY (the lead wrote 10h ago, after our touch 60h ago) → the next step is authored EARLY, the reason says so", active.code === "due" && /EARLY on fresh activity/.test(active.reason) && !!active.step, active.reason)
      check("E9 · POSITIVE CONTROL: activity from BEFORE our last touch is not fresh — the interval holds", before.code === "interval_not_elapsed")
      check("E9 · THE FLOOR IS DETERMINISTIC: fresh activity inside the tenant's fatigue floor still waits — due when the floor ends, never earlier", inFloor.code === "interval_not_elapsed" && /fatigue floor/.test(inFloor.reason) && inFloor.dueAt?.getTime() === h(24).getTime() + DEFAULT_FOLLOWUP_POLICY.guardrails.minHoursBetweenTouches * 3_600_000, inFloor.reason)
      const replay = lap.planFromDecisionInput(lap.decisionInputSnapshot({ subject: "lead", plan: { ...base, lastTouchAt: h(60), lastLeadActivityAt: h(10) } }))
      check("E9 · REPLAYABLE: the decision snapshot carries the activity it read, so the replay harness reproduces the early verdict", replay?.code === "due" && /EARLY/.test(replay?.reason ?? ""))
      const lapSrc = code("lib/ai-isa/lead-action-plan.ts")
      check("E9 · WIRED: the plan sweep reads the lead's own newest inbound (lead_conversation_history, direction inbound) and hands it to the planner", /from\("lead_conversation_history"\)[\s\S]{0,260}\.eq\("direction", "inbound"\)/.test(lapSrc) && /lastLeadActivityAt,\s*\n\s*context:/.test(lapSrc))
    }

    // E10 · a reply while a touch is queued → the queued touch is re-evaluated by a person, never released on its schedule
    {
      const T = new Date()
      const h = (x: number) => new Date(T.getTime() - x * 3_600_000).toISOString()
      const L1 = "e6e6e6e6-0000-4000-8000-000000000001", L2 = "e6e6e6e6-0000-4000-8000-000000000002"
      ;(globalThis as { __153F_isa?: unknown }).__153F_isa = { status: "resolved", settings: { ...DEFAULT_AISA_SETTINGS, enabled: true, require_broker_approval: false, lead_allowed_channels: ["email", "direct_mail"] }, owner: { ownerType: "brokerage", ownerId: EB } }
      const w = memSupabase({
        agent_client_messages: [
          { id: "acm-1", brokerage_id: EB, audience: "lead", status: "proposed", recipient_lead_id: L1, recipient_contact_id: null, channel: "email", subject: "s", body: "b", proposed_at: h(3) },
          { id: "acm-2", brokerage_id: EB, audience: "lead", status: "proposed", recipient_lead_id: L2, recipient_contact_id: null, channel: "email", subject: "s", body: "b", proposed_at: h(3) },
        ],
        lead_conversation_history: [
          { id: "lch-1", brokerage_id: EB, lead_id: L1, direction: "inbound", occurred_at: h(1) },
          { id: "lch-2", brokerage_id: EB, lead_id: L2, direction: "inbound", occurred_at: h(5) },
        ],
        leads: [{ id: L2, brokerage_id: EB, agent_id: null, contact_id: null, is_active: true, ai_outreach_paused: true, email: "l2@x.example", email_verified: true }],
      }, { uuidIds: true })
      const out = await lap.releaseDueLeadTouches({ brokerageId: EB, supabase: w, now: T })
      const d1 = out.decisions.find((d) => d.messageId === "acm-1"), d2 = out.decisions.find((d) => d.messageId === "acm-2")
      ;(globalThis as { __153F_isa?: unknown }).__153F_isa = undefined
      check("E10 · REPLY WHILE QUEUED: the lead wrote AFTER the touch was drafted → it is NOT released on its schedule; staged for a person with the reply named",
        !!d1?.supersededByReply && d1.mode === "stage_for_approval" && out.sent === 0 && w.tables.agent_client_messages.find((m) => m.id === "acm-1")?.status === "proposed", JSON.stringify(d1 ?? out.warnings))
      check("E10 · POSITIVE CONTROL: a reply from BEFORE the draft does not supersede it (that proposal goes on to the usual re-checks — here the pause stops it)", !!d2 && !d2.supersededByReply && /ai_outreach_paused/.test(d2.reason), JSON.stringify(d2 ?? null))
    }

    // E11 · no fake "typing", no artificial delay
    {
      const files = ["lib/ai-isa/followup-arbiter.ts", "lib/communications/inbound-responder.ts", "lib/communications/inbound-reply-executors.ts", "lib/social/inbound-social.ts", "lib/ai-isa/speed-to-lead.ts"]
      const TYPING = /\b(?:is|are|was)\s+typing\b|typing\s*(?:\.\.\.|…)/i
      check("E11 · NO FAKE TYPING: no tenant- or customer-facing string in the live-conversation path claims someone is typing", files.every((f) => !TYPING.test(stripComments(raw(f)))))
      check("E11 · POSITIVE CONTROL: the typing finder sees a planted claim", TYPING.test(`const s = "Dana is typing…"`))
      const DELAY = /\bsetTimeout\s*\(|\bsleep\s*\(|\bdelay\s*\(/
      check("E11 · NO ARTIFICIAL DELAY: the responder carries no timer at all, and the arbiter's ONLY timer is the latency-budget race", !DELAY.test(blankStrings(stripComments(raw("lib/communications/inbound-responder.ts")))) && (blankStrings(stripComments(raw("lib/ai-isa/followup-arbiter.ts"))).match(/\bsetTimeout\s*\(/g) ?? []).length === 1 && /function decideWithinBudget[\s\S]{0,700}setTimeout\(/.test(stripComments(raw("lib/ai-isa/followup-arbiter.ts"))))
      check("E11 · POSITIVE CONTROL: the delay finder sees a planted pause", DELAY.test("await new Promise((r) => setTimeout(r, 1500))"))
    }
  }

  console.log("\n BLIND SPOTS (§E, wave 153): the fast path is proven on the SMS lane with the chokepoint as a seam (test:egress-send-guard owns dispatchSms's own gates); a human typing in the thread is read from messages rows — app/actions/ai-auto-response.ts is excluded by type and both it and the open-house instant greeting (lib/open-house/instant-greeting.ts) now stamp sender_type 'ai' (wave 153 integrator, 153F/153H outside requests); any OTHER automated writer that omits sender_type reads as a person for 30 minutes (the safe side: a person answers); the voice channel's live-call ownership is not read here; the ownership marker lives on the responder's decision row (the planner door holds only planners that offered a wait); the lead-touch re-evaluation is proven with the ISA settings resolver stubbed to an auto-send tenant.")
  console.log("\n BLIND SPOTS: the census is LEXICAL — a schedule spelled without an outbound word or a time unit in its name (e.g. `const X = 7` used as days), a schedule stored in a DB row (campaign_sequence_steps.delay_days, strategy cadenceDays, ai_isa_settings.touch_interval_days — the bundle's send_after_minutes is no longer read for timing since wave 153 lane 153I) or computed inline (`7 * 86_400_000` next to a send) is NOT seen; the step executor's arbiter hold is proven on stripped source (executeSequenceStep builds its own service client); the model is stubbed (the briefs are asserted by section); dispatchEmail / dispatchSms gates are seams here (test:egress-send-guard owns them); the inbound → completion hop is opened directly (the responder's own proof, test:inbound-sms-arbiter / test:unattended-answer, drives C13); no live soak.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(` failed: ${failures.join(" | ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
