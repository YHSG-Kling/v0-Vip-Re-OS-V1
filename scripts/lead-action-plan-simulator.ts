#!/usr/bin/env tsx
/**
 * scripts/lead-action-plan-simulator.ts   (npm run test:lead-action-plan)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEAD ACTION PLAN — pre-conversion, ISA-owned, gated by brokerage settings.
 *
 * OWNER RULING (2026-08-25), verbatim:
 *
 *   "make sure that there are automatic action plans for just leads which i
 *    belive we built for emails and direct mail and video emails which brokerage
 *    settings are use so the ai isa will automatically send. also ... we only
 *    sent content to leads and contacts that are personalized and situation,
 *    them first messaging."
 *
 * The thing this guard exists to stop is ONE failure: the AI ISA sending on a
 * brokerage's behalf without that brokerage's configured consent. Everything
 * below is either that assertion or the positive control that proves the
 * assertion can still fail.
 *
 * ── TWO-SIDED POSITIVE CONTROLS (CLAUDE.md §2) ──────────────────────────────
 * Every refusal is paired with the ACCEPT it must not swallow, and every accept
 * with the REFUSAL it must not become. A gate that refuses everything passes a
 * one-sided "X is refused" suite perfectly while being a worse bug than the one
 * being watched for — so `leadAutoSendVerdict` is exercised across the full
 * matrix, and each refusal is re-run with exactly the one field that caused it
 * flipped back.
 *
 * ── MUTATION TEST, RUN AND RECORDED ─────────────────────────────────────────
 * The settings gate was mutated to auto-send even when `require_broker_approval`
 * is true; this suite went RED on GATE-APPROVAL-REQUIRED and
 * GATE-APPROVAL-DEFAULT-IS-CLOSED. Restored and re-verified byte-identical
 * (sha256). The MUTATION-* checks below are the in-suite standing version of
 * that: they rebuild the gate's decision from an inverted rule and assert the
 * real gate disagrees, so a future edit that quietly loosens it cannot pass.
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED, AND WHY ──────────────────────────────
 * · NO PROVIDER IS EVER CALLED. The live layer proves the gate OPENED by reading
 *   `LeadTouchRelease.gate`, then lets the lead's own consent refuse the send —
 *   so a released touch is provable with zero email and zero Lob spend.
 * · The SENDER is not re-tested here. `approveClientMessage`'s lead branch (the
 *   CAN-SPAM gate, the direct-mail opt-out gate, the deliverable-address check,
 *   the "leads support email + direct mail only" refusal) is owned by
 *   scripts/lead-recipient-dispatch-simulator.ts (npm run test:lead-recipient).
 *   Asserting it twice would be two spellings of one rule (§6).
 * · The video script's compliance-FIRST writing prompt is owned by
 *   scripts/video-script-compliance-guard.ts. This suite asserts only that the
 *   lead reel is commissioned through that rail rather than around it.
 *
 * BLIND SPOT, stated beside the number: the source assertions read SEVEN files
 * by name. An eighth path that auto-released a lead touch its own way would not
 * be seen here — `test:no-orphan-actions`, `test:egress-send-guard` and
 * `test:outbound-sender` cover the general population.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
// lib/ai-isa/resolve-isa-settings.ts imports `server-only`, which throws outside a
// Server Component. Neutralize it in the require cache BEFORE importing anything
// that transitively pulls it (the established idiom in this repo).
import { createRequire } from "node:module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as never
} catch { /* server-only not resolvable — nothing to shim */ }

import { stripComments, blankStrings } from "./strip-comments"
import {
  LEAD_PLAN_STEPS,
  leadAutoSendVerdict,
  planNextLeadTouch,
  isPersonalizedForLead,
  wireChannelFor,
  nonActionRecordFor,
  type LeadSettingsResolution,
} from "../lib/ai-isa/lead-action-plan"
import { DEFAULT_AISA_SETTINGS, DEAD_END_OUTCOMES, canonicalDeadEnd, deadEndsFromLeadSources, type AIISASettings } from "../lib/ai-isa/settings-types"
import { pickLeadOutreachChannel, LEAD_ALLOWED_CHANNELS } from "../lib/ai-isa/lead-channel-policy"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import {
  scoreDecayedIntent, decayFactor, byIntentMomentumDesc, INTENT_SIGNAL_POLICY, STATED_TIMELINE_POLICY,
  leadIntentObservations,
  type IntentObservation,
} from "../lib/lead-intelligence/behavioral-summary"

let passed = 0, failed = 0
const failures: string[] = []
function check(id: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${id}`) }
  else { failed++; failures.push(id); console.log(`  ✗ ${id}${detail ? ` — ${detail}` : ""}`) }
}

const root = join(import.meta.dirname, "..")
/** Comments AND string literals blanked — a tombstone naming a survivor, or a
 *  fixture id inside a template literal, is NOT a call site (CLAUDE.md §2). */
const code = (rel: string) => blankStrings(stripComments(readFileSync(join(root, rel), "utf8")))
/** Comments blanked only — for the few assertions that must see a literal. */
const codeKeepStrings = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))

const settingsWith = (over: Partial<AIISASettings>): AIISASettings => ({ ...DEFAULT_AISA_SETTINGS, ...over })
const resolved = (over: Partial<AIISASettings>): LeadSettingsResolution =>
  ({ status: "resolved", settings: settingsWith(over) })
/** The settings a brokerage that HAS authorised auto-send would hold. */
const AUTHORISED: Partial<AIISASettings> = {
  enabled: true, require_broker_approval: false, lead_allowed_channels: ["email", "direct_mail"],
}

console.log("══════════════════════════════════════════════════════════════")
console.log(" LEAD ACTION PLAN — brokerage-settings-gated ISA auto-send")
console.log("══════════════════════════════════════════════════════════════")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 1. THE SETTINGS GATE: the full matrix, both sides ──")

check("GATE-AUTHORISED: ISA on + approval not required + channel allowed → auto_send",
  leadAutoSendVerdict({ resolution: resolved(AUTHORISED), channel: "email" }).mode === "auto_send")

check("GATE-AUTHORISED-DIRECT-MAIL (positive control): the same brokerage may also mail",
  leadAutoSendVerdict({ resolution: resolved(AUTHORISED), channel: "direct_mail" }).mode === "auto_send")

// THE RULING'S CENTRAL ASSERTION.
{
  const v = leadAutoSendVerdict({
    resolution: resolved({ ...AUTHORISED, require_broker_approval: true }), channel: "email",
  })
  check("GATE-APPROVAL-REQUIRED: require_broker_approval=true NEVER auto-sends",
    v.mode === "stage_for_approval" && v.code === "broker_approval_required", `${v.mode}/${v.code}`)
}
{
  const v = leadAutoSendVerdict({
    resolution: resolved({ ...AUTHORISED, enabled: false }), channel: "email",
  })
  check("GATE-ISA-DISABLED: is_active=false NEVER auto-sends, whatever else is set",
    v.mode === "stage_for_approval" && v.code === "isa_disabled", `${v.mode}/${v.code}`)
}
{
  const v = leadAutoSendVerdict({
    resolution: { status: "unreadable", detail: "PGRST301: JWT expired" }, channel: "email",
  })
  check("GATE-UNREADABLE-FAILS-CLOSED: a settings tier we could not READ never auto-sends (§4)",
    v.mode === "stage_for_approval" && v.code === "settings_unreadable", `${v.mode}/${v.code}`)
}
{
  const v = leadAutoSendVerdict({
    resolution: resolved({ ...AUTHORISED, lead_allowed_channels: ["email"] }), channel: "direct_mail",
  })
  check("GATE-CHANNEL-EXCLUDED: a channel the brokerage removed is staged, not sent",
    v.mode === "stage_for_approval" && v.code === "channel_not_allowed", `${v.mode}/${v.code}`)
  const control = leadAutoSendVerdict({
    resolution: resolved({ ...AUTHORISED, lead_allowed_channels: ["email"] }), channel: "email",
  })
  check("GATE-CHANNEL-EXCLUDED-CONTROL: …and the channel they KEPT still sends",
    control.mode === "auto_send", `${control.mode}/${control.code}`)
}

// THE DEFAULT. `ai_isa_settings.require_broker_approval` is NOT NULL DEFAULT TRUE
// live (migration 061), and DEFAULT_AISA_SETTINGS must agree — a brokerage with no
// row anywhere in the cascade must get a human in the loop, not a send.
check("GATE-APPROVAL-DEFAULT-IS-CLOSED: DEFAULT_AISA_SETTINGS requires broker approval",
  DEFAULT_AISA_SETTINGS.require_broker_approval === true)
{
  const v = leadAutoSendVerdict({ resolution: { status: "default", settings: DEFAULT_AISA_SETTINGS }, channel: "email" })
  check("GATE-NO-ROW-ANYWHERE-STAGES: 'nobody configured this' stages, never sends",
    v.mode === "stage_for_approval" && v.code === "broker_approval_required", `${v.mode}/${v.code}`)
}

// ORDERING. The reason a broker sees must be the most specific TRUE one — a
// disabled ISA that reports "channel not allowed" sends them to the wrong screen.
{
  const v = leadAutoSendVerdict({
    resolution: resolved({ enabled: false, require_broker_approval: true, lead_allowed_channels: [] }),
    channel: "email",
  })
  check("GATE-ORDER: master switch beats approval beats channel", v.code === "isa_disabled", v.code)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 2. MUTATION PROBES: prove the gate can still fail ──")

// The mutant: a gate that honours everything EXCEPT require_broker_approval. This
// is exactly the edit that was applied to the real file, run, and reverted. If the
// real gate ever agrees with this mutant on the approval case, the guard is blind.
// NOTE the `: string` annotations at the comparison sites below. Without them TS
// narrows `real` to its literal after the first conjunct and then flags
// `real !== mutant` as a dead comparison — which would tempt the next reader to
// DELETE the very assertion that makes this a mutation probe rather than two
// unrelated equality checks. The widening keeps the disagreement explicit.
function mutantIgnoringApproval(res: LeadSettingsResolution, channel: "email" | "direct_mail") {
  if (res.status === "unreadable") return "stage_for_approval"
  if (res.settings.enabled === false) return "stage_for_approval"
  const allowed = res.settings.lead_allowed_channels ?? []
  if (!allowed.includes(channel)) return "stage_for_approval"
  return "auto_send" // ← the mutation: require_broker_approval is not consulted
}
{
  const r = resolved({ ...AUTHORISED, require_broker_approval: true })
  const real: string = leadAutoSendVerdict({ resolution: r, channel: "email" }).mode
  const mutant: string = mutantIgnoringApproval(r, "email")
  check("MUTATION-APPROVAL: the real gate DISAGREES with a gate that ignores require_broker_approval",
    // `real !== mutant` STOOD HERE and TypeScript proved it dead (TS2367): the two
    // clauses above pin each side to a DIFFERENT literal, so the inequality is a
    // tautology. It read as a third, independent check and could never fail —
    // exactly the shape §2 calls a guard that cannot see what it judges. Pinning
    // both values is the stronger assertion; the disagreement follows from it.
    real === "stage_for_approval" && mutant === "auto_send", `real=${real} mutant=${mutant}`)
}
{
  // …and the mutant must AGREE everywhere else, or this probe proves nothing:
  // a probe that disagrees on every input cannot localise the defect.
  const r = resolved(AUTHORISED)
  check("MUTATION-PROBE-IS-LOCALISED (positive control): mutant and real agree when approval is not required",
    leadAutoSendVerdict({ resolution: r, channel: "email" }).mode === mutantIgnoringApproval(r, "email"))
}

// The second mutant: a gate that treats "unreadable" as "no row, use defaults".
// That is the §3 trap — supabase-js RESOLVES refusals — one hop up.
function mutantTreatingUnreadableAsDefault(res: LeadSettingsResolution, channel: "email" | "direct_mail") {
  const s = res.status === "unreadable" ? { ...DEFAULT_AISA_SETTINGS, require_broker_approval: false } : res.settings
  if (s.enabled === false) return "stage_for_approval"
  if (!(s.lead_allowed_channels ?? []).includes(channel)) return "stage_for_approval"
  return s.require_broker_approval !== false ? "stage_for_approval" : "auto_send"
}
{
  const r: LeadSettingsResolution = { status: "unreadable", detail: "read refused" }
  const real: string = leadAutoSendVerdict({ resolution: r, channel: "email" }).mode
  const mutant: string = mutantTreatingUnreadableAsDefault(r, "email")
  check("MUTATION-UNREADABLE: the real gate DISAGREES with a gate that reads a refusal as an absent row",
    // `real !== mutant` STOOD HERE and TypeScript proved it dead (TS2367): the two
    // clauses above pin each side to a DIFFERENT literal, so the inequality is a
    // tautology. It read as a third, independent check and could never fail —
    // exactly the shape §2 calls a guard that cannot see what it judges. Pinning
    // both values is the stronger assertion; the disagreement follows from it.
    real === "stage_for_approval" && mutant === "auto_send", `real=${real} mutant=${mutant}`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 3. THE PLAN: three channels, cadence, cap, consent ──")

check("PLAN-NAMES-THE-THREE-RULED-CHANNELS: email, video email, direct mail",
  LEAD_PLAN_STEPS.map((s) => s.channel).join(",") === "email,video_email,direct_mail")
check("PLAN-STEPS-ARE-ORDERED-1..N", LEAD_PLAN_STEPS.every((s, i) => s.order === i + 1))
check("PLAN-EVERY-STEP-NAMES-ITS-PRODUCER: nobody writes a second producer (§1)",
  LEAD_PLAN_STEPS.every((s) => s.producer.includes("/") && s.producer.length > 20))
check("PLAN-VIDEO-EMAIL-RIDES-EMAIL: a reel email is an email, not a new transport",
  wireChannelFor("video_email") === "email" && wireChannelFor("email") === "email" &&
  wireChannelFor("direct_mail") === "direct_mail")
check("PLAN-WIRE-CHANNELS-ARE-THE-CANONICAL-LEAD-SET (no SMS/phone/social)",
  LEAD_PLAN_STEPS.every((s) => (LEAD_ALLOWED_CHANNELS as readonly string[]).includes(wireChannelFor(s.channel))))

const planBase = {
  now: new Date("2026-08-25T12:00:00Z"),
  settings: settingsWith(AUTHORISED),
  touchesSoFar: 1,
  lastTouchAt: new Date("2026-08-01T12:00:00Z"),
  lastChannel: "email",
  channelsAlreadyStaged: ["email"] as const,
  emailUsable: true,
  mailingVerified: true,
  reelReady: true,
  lifecycleState: "unconsented" as string | null,
}

{
  const p = planNextLeadTouch({ ...planBase })
  check("PLAN-DUE: after touch 1, with a reel ready, a step is due",
    p.code === "due" && p.step !== null, `${p.code}: ${p.reason}`)
}
{
  const p = planNextLeadTouch({ ...planBase, touchesSoFar: 5 })
  check("PLAN-CAP: max_touches_lead is READ and stops the plan",
    p.code === "max_touches_reached", `${p.code}: ${p.reason}`)
  const control = planNextLeadTouch({ ...planBase, touchesSoFar: 4 })
  check("PLAN-CAP-CONTROL (positive control): one under the cap is still due", control.code === "due")
}
{
  const p = planNextLeadTouch({ ...planBase, lastTouchAt: new Date("2026-08-24T12:00:00Z") })
  check("PLAN-CADENCE: touch_interval_days is READ and holds the next touch",
    p.code === "interval_not_elapsed" && p.dueAt !== null, `${p.code}: ${p.reason}`)
  const control = planNextLeadTouch({
    ...planBase, lastTouchAt: new Date("2026-08-24T12:00:00Z"),
    settings: settingsWith({ ...AUTHORISED, touch_interval_days: 1 }),
  })
  check("PLAN-CADENCE-CONTROL (positive control): a shorter interval releases the same touch",
    control.code === "due", control.reason)
}
{
  const p = planNextLeadTouch({ ...planBase, lifecycleState: "representation" })
  check("PLAN-BLOCKED-LIFECYCLE: blocked_lifecycle_states is READ",
    p.code === "blocked_lifecycle", `${p.code}: ${p.reason}`)
  const control = planNextLeadTouch({ ...planBase, lifecycleState: "unconsented" })
  check("PLAN-BLOCKED-LIFECYCLE-CONTROL (positive control): an unblocked state proceeds",
    control.code === "due")
}
{
  const p = planNextLeadTouch({ ...planBase, emailUsable: false, mailingVerified: false })
  check("PLAN-NO-CHANNEL: nothing verified → no_permitted_channel, never a send anyway",
    p.code === "no_permitted_channel", `${p.code}: ${p.reason}`)
}
{
  // A lead with no reel must not be offered the video-email step: promising a
  // personal video and having none is the promise the first-touch email already
  // struggles to keep.
  const p = planNextLeadTouch({ ...planBase, reelReady: false, mailingVerified: false })
  check("PLAN-VIDEO-NEEDS-A-REEL: no reel → the video-email step is not selectable",
    p.code === "plan_complete" || p.channel !== "video_email", `${p.code}/${p.channel}`)
  const control = planNextLeadTouch({ ...planBase, reelReady: true, mailingVerified: false })
  check("PLAN-VIDEO-NEEDS-A-REEL-CONTROL (positive control): with a reel it IS selectable",
    control.code === "due" && control.channel === "video_email", `${control.code}/${control.channel}`)
}
{
  const p = planNextLeadTouch({
    ...planBase, settings: settingsWith({ ...AUTHORISED, lead_allowed_channels: ["email"] }),
    channelsAlreadyStaged: ["email", "video_email"],
  })
  check("PLAN-RESPECTS-lead_allowed_channels: direct mail removed by the broker is not planned",
    p.code === "plan_complete", `${p.code}: ${p.reason}`)
}
{
  // Consent narrows the plan; the plan never widens consent.
  const p = planNextLeadTouch({ ...planBase, emailUsable: false, channelsAlreadyStaged: [] })
  check("PLAN-CONSENT-NARROWS: an unverified email leaves only the mail step",
    p.code === "due" && p.channel === "direct_mail", `${p.code}/${p.channel}`)
  check("PLAN-AGREES-WITH-THE-CANONICAL-RULE (positive control): pickLeadOutreachChannel says the same",
    pickLeadOutreachChannel({ requestedChannel: "email", emailUsable: false, mailingVerified: true }) === "direct_mail")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 4. THEM-FIRST, PERSONALIZED, SITUATIONAL — the ruling as a floor ──")

const situational = {
  firstName: "Dana",
  situationFacts: ["3-bed ranch", "3-6_months", "relocating", "Tampa"],
}
check("PERSONAL-PASS: a body that names them AND their situation passes",
  isPersonalizedForLead({
    ...situational,
    body: "Hi Dana, you mentioned a 3-bed ranch — here is what is moving in that range.",
  }).ok)
check("PERSONAL-FAIL-NO-NAME: a body that never addresses them is a blast",
  isPersonalizedForLead({ ...situational, body: "Hello there — here is our monthly market roundup for everyone." }).ok === false)
check("PERSONAL-FAIL-NO-SITUATION: a body with their name and nothing of theirs is still a blast",
  isPersonalizedForLead({ ...situational, body: "Hi Dana, here is our monthly market roundup." }).ok === false)
check("PERSONAL-FAIL-NO-FACTS-ON-FILE: honest refusal when we know nothing about them",
  isPersonalizedForLead({ firstName: "Dana", situationFacts: [], body: "Hi Dana, hope you are well." }).ok === false)
check("PERSONAL-CONTROL-ONE-FACT-IS-ENOUGH (positive control): one real fact clears the floor",
  isPersonalizedForLead({ ...situational, body: "Hi Dana, Tampa inventory moved this week." }).ok)
check("PERSONAL-EMPTY-BODY-REFUSED", isPersonalizedForLead({ ...situational, body: "   " }).ok === false)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 5. THE WIRING: one resolver, one sender, one suppression rule ──")

const plan = code("lib/ai-isa/lead-action-plan.ts")
const resolver = code("lib/ai-isa/resolve-isa-settings.ts")
const resolverLiteral = codeKeepStrings("lib/ai-isa/resolve-isa-settings.ts")

check("WIRED-USES-THE-EXISTING-RESOLVER: resolveIsaSettingsResult, not a second cascade (§6)",
  /resolveIsaSettingsResult\s*\(/.test(plan) && !/from\(\s*ai_isa_settings/.test(plan) && !/ai_isa_settings/.test(plan))
check("WIRED-KEEPS-THE-THREE-STATE-ANSWER: the gate branches on unreadable, not on settings alone",
  /status\s*===\s*.unreadable./.test(plan) || /"unreadable"/.test(codeKeepStrings("lib/ai-isa/lead-action-plan.ts")))
check("WIRED-USES-THE-EXISTING-SENDER: approveClientMessage, never a raw dispatchEmail/dispatchDirectMail",
  /approveClientMessage\s*\(/.test(plan) && !/dispatchEmail\s*\(/.test(plan) && !/dispatchDirectMail\s*\(/.test(plan))
check("WIRED-NO-HUMAN-IS-FABRICATED: the auto-send approver is null, not a borrowed user id",
  /approveClientMessage\s*\(\s*messageId\s*,\s*null\s*,/.test(plan))
check("WIRED-USES-THE-CANONICAL-CHANNEL-RULE: pickLeadOutreachChannel + permittedLeadChannels",
  /pickLeadOutreachChannel\s*\(/.test(plan) && /permittedLeadChannels\s*\(/.test(plan))
check("WIRED-USES-THE-DESIGNATED-SUPPRESSION-READER: checkSuppression, no second consent rule",
  /checkSuppression\s*\(/.test(plan))
check("WIRED-USES-THE-EXISTING-TOUCH-CAP: checkMaxTouches",
  /checkMaxTouches\s*\(/.test(plan))
check("WIRED-USES-CONVERSION-FINALITY: a converted lead is never mailed as a lead",
  /conversionVerdictForRow\s*\(/.test(plan) && /excludeConvertedLeads\s*\(/.test(plan))
check("WIRED-RUNS-THE-CONTENT-GATE-ON-THE-REAL-BYTES: evaluateOutbound before release",
  /evaluateOutbound\s*\(/.test(plan))
check("WIRED-PERSONALIZATION-FLOOR-IS-ENFORCED-BEFORE-SEND (the ruling, not a comment)",
  /isPersonalizedForLead\s*\(/.test(plan))
check("WIRED-RE-ARMS-THE-EXISTING-PRODUCER: publishManagerSignal, not a new commissioner",
  /publishManagerSignal\s*\(/.test(plan) && !/commissionVideo\s*\(/.test(plan))

// The reader that did not exist. `require_broker_approval` was in the SELECT and
// was then dropped by the fold — assert the FOLD, not the SELECT.
check("RESOLVER-FOLDS-require_broker_approval: the column finally reaches a caller",
  /require_broker_approval:\s*\n?\s*row\.require_broker_approval/.test(resolverLiteral) ||
  /require_broker_approval:[\s\S]{0,200}row\.require_broker_approval/.test(resolverLiteral))
check("RESOLVER-WRITES-require_broker_approval: the column finally has a writer too",
  /require_broker_approval:\s*merged\.require_broker_approval/.test(resolverLiteral))
check("RESOLVER-COLUMN-BEATS-BLOB (positive control): the same shape is_active already uses",
  /row\.is_active\s*===\s*false/.test(resolver) && /row\.require_broker_approval\s*===\s*false/.test(resolver))

// A refused tier must still STOP the cascade rather than descend. The literal IS
// the assertion here, so it reads comment-stripped source with strings INTACT —
// blanking them would make this pass against a resolver that had lost the branch.
check("RESOLVER-STILL-STOPS-ON-UNREADABLE (regression control)",
  /read\.status\s*===\s*["']unreadable["']/.test(resolverLiteral) &&
  /return\s*\{\s*status:\s*["']unreadable["']/.test(resolverLiteral))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 6. THE SCHEDULER: registered, and not a duplicate ──")

const registered = CRON_REGISTRY.filter((e) => e.path.startsWith("/api/cron/lead-action-plan"))
check("CRON-REGISTERED: the loop is in CRON_REGISTRY (vercel.json runs one dispatcher)",
  registered.length === 1, `${registered.length} entries`)
check("CRON-SCHEDULE-IS-SANE: minutes-granular, not per-minute (the cadence it governs is DAYS)",
  registered.length === 1 && /^\*\/\d+ \* \* \* \*$/.test(registered[0].schedule) &&
  Number(registered[0].schedule.split(" ")[0].replace("*/", "")) >= 5, registered[0]?.schedule)

const cron = code("app/api/cron/lead-action-plan/route.ts")
check("CRON-AUTHED: verifyCronAuth gates the route",
  /verifyCronAuth\s*\(/.test(cron))
check("CRON-FAILURE-WIRED: recordCronFailureAction is CALLED, not merely imported",
  (cron.match(/recordCronFailureAction\s*\(/g) ?? []).length >= 2)
check("CRON-ADVANCE-BEFORE-RELEASE: a creative commissioned this tick cannot ship this tick",
  cron.indexOf("advanceLeadActionPlans") < cron.indexOf("releaseDueLeadTouches"))
check("CRON-PER-TENANT: the sweep is brokerage-scoped, never a global un-scoped read (§4)",
  /brokerageId:\s*brokerage\.id/.test(cron))

// NOT A SECOND SEQUENCER. The generic sequence engine
// (lib/campaign-sequences/step-executor.ts) keeps its lead restriction, and this
// lane does not touch it.
const stepExec = code("lib/campaign-sequences/step-executor.ts")
// Re-anchored to the RULE (wave 91, lane 91B): the restriction now asks the ONE lead-stage
// predicate (lead-channel-policy.ts::channelRefusalForRecipient) instead of a local
// `step.channel !== "email" && …` pair — either spelling is the restriction; its absence is not.
check("NO-SECOND-SEQUENCER: the generic step executor still restricts leads to email/direct_mail",
  /!contactId\s*&&\s*(step\.channel\s*!==|channelRefusalForRecipient\([^)]*step\.channel\))/.test(stepExec))
check("NO-SECOND-SEQUENCER-CONTROL (positive control): this lane never writes sequence_enrollments",
  !/sequence_enrollments/.test(plan))

// NOT THE AGENT PLAN. The contact-side plan is a different subject entirely.
const agentPlan = code("lib/agent-orchestration/action-plan-generator.ts")
check("NOT-THE-AGENT-PLAN: the contact-side generator is still contact-keyed and untouched",
  /generateAgentActionPlan\s*\(\s*\n?\s*contactId/.test(agentPlan) || /contactId:\s*string,/.test(agentPlan))
check("NOT-THE-AGENT-PLAN-CONTROL: this lane never imports the agent plan",
  !/agent-orchestration/.test(plan))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 7. VIDEO EMAIL: compliance-first, and 1:1 rather than broadcast ──")

// The signal NAMES are string literals, so they are asserted on comment-stripped
// source with strings intact; the CALL tokens are asserted on fully blanked source
// so a mention inside a comment or a fixture can never stand in for a call site.
const signals = code("lib/kernel/manager-signals.ts")
const signalsLiteral = codeKeepStrings("lib/kernel/manager-signals.ts")
check("VIDEO-LEAD-REEL-IS-COMMISSIONED-THROUGH-THE-DIRECTOR (compliance-first rail)",
  /["']asset_manager:lead_creative_handoff["']\s*:/.test(signalsLiteral) && /commissionVideo\s*\(/.test(signals))
check("VIDEO-LEAD-FOLLOWUP-IS-EMAIL-ONLY: a personalized lead reel is never broadcast",
  /["']campaign_orchestrator:lead_outreach_ready["']\s*:/.test(signalsLiteral) &&
  /recipientLeadId:\s*leadId,\s*audience:\s*["']lead["'][\s\S]{0,120}channel:\s*["']email["']/.test(signalsLiteral))
const aiCopy = codeKeepStrings("lib/kernel/ai-copy.ts")
check("VIDEO-COPY-IS-WRITTEN-COMPLIANCE-FIRST: Fair Housing is in the WRITING prompt, not only a post-hoc scan (§5)",
  /FAIR HOUSING/i.test(aiCopy) && /never reference or imply/i.test(aiCopy))
check("VIDEO-COPY-CONTROL (positive control): the same prompt forbids fabricating facts",
  /invent nothing/i.test(aiCopy))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 7b. LANE 97B: signal decay, intent velocity, next-best-action incl. WAIT / DO_NOTHING ──")
{
  const NOW = new Date("2026-10-02T12:00:00Z")
  const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
  const val = (d: number): IntentObservation => ({ type: "valuation_request", source: "valuation_requests", observedAt: ago(d) })

  // DECAY — an old valuation request decays below a fresh one; the half-life table is the rule.
  const fresh = scoreDecayedIntent([val(0)], NOW)
  const old = scoreDecayedIntent([val(21)], NOW)
  check("DECAY-OLD-BELOW-FRESH: a 21-day-old valuation request scores below a fresh one",
    old.score < fresh.score, `old=${old.score} fresh=${fresh.score}`)
  check("DECAY-HALF-LIFE-IS-THE-RULE: one half-life halves the factor (derived from the table, not pinned)",
    Math.abs(decayFactor(INTENT_SIGNAL_POLICY.valuation_request.halfLifeDays, INTENT_SIGNAL_POLICY.valuation_request.halfLifeDays) - 0.5) < 1e-9)
  check("DECAY-CONTROL (positive control): two equally fresh requests score EQUAL — the age is what moved it",
    scoreDecayedIntent([val(0)], NOW).score === fresh.score)
  check("DECAY-TIMELINE-BUCKETS-ONLY: the stated-timeline table is keyed by the live CHECK vocabulary, never 30/60/90",
    ["1-3_months", "3-6_months", "6-12_months"].every((k) => k in STATED_TIMELINE_POLICY)
      && !Object.keys(STATED_TIMELINE_POLICY).some((k) => /\b(30|60|90)\b/.test(k)))
  check("DECAY-EVIDENCE: the score lists which signal, its age and its contribution",
    fresh.evidence.length === 1 && fresh.evidence[0].type === "valuation_request" && fresh.evidence[0].ageDays === 0 && fresh.evidence[0].contribution > 0)

  // CORROBORATION — two independent sources lift confidence; two rows of one table do not.
  const oneSource = scoreDecayedIntent([val(0), val(1)], NOW)
  const twoSources = scoreDecayedIntent([val(0), { type: "listing_view", source: "lead_idx_property_interactions", observedAt: ago(0) }], NOW)
  check("CORROBORATION: ≥2 independent sources → medium confidence; two rows of ONE table stay low",
    twoSources.confidence === "medium" && oneSource.confidence === "low", `${twoSources.confidence}/${oneSource.confidence}`)

  // VELOCITY — accelerating moderate intent outranks declining high intent.
  const declining = scoreDecayedIntent([
    { type: "appointment_request", source: "valuation_requests", observedAt: ago(12) },
    { type: "valuation_request", source: "valuation_requests", observedAt: ago(9) },
    { type: "showing_request", source: "lead_idx_property_interactions", observedAt: ago(8) },
  ], NOW)
  const accelerating = scoreDecayedIntent([
    { type: "listing_view", source: "lead_idx_property_interactions", observedAt: ago(2) },
    { type: "saved_listing", source: "lead_idx_property_interactions", observedAt: ago(1) },
    { type: "listing_view", source: "external_behavior", observedAt: ago(0) },
    { type: "inbound_reply", source: "conversations", observedAt: ago(0) },
  ], NOW)
  check("VELOCITY-SIGNS: the high profile is falling, the moderate one rising",
    declining.trend === "falling" && accelerating.trend === "rising",
    `declining ${declining.score} v=${declining.velocityPerDay}; accelerating ${accelerating.score} v=${accelerating.velocityPerDay}`)
  check("VELOCITY-OUTRANKS: rising moderate intent outranks high-but-declining intent (current score alone would not)",
    declining.score > accelerating.score && [declining, accelerating].sort(byIntentMomentumDesc)[0] === accelerating,
    `scores ${declining.score}>${accelerating.score}; ranks ${declining.momentumRank} vs ${accelerating.momentumRank}`)
  {
    // POSITIVE CONTROL: the same high profile, FRESH, is not declining and wins.
    const freshHigh = scoreDecayedIntent([
      { type: "appointment_request", source: "valuation_requests", observedAt: ago(0) },
      { type: "valuation_request", source: "valuation_requests", observedAt: ago(0) },
      { type: "showing_request", source: "lead_idx_property_interactions", observedAt: ago(0) },
    ], NOW)
    check("VELOCITY-CONTROL (positive control): the same high profile when fresh outranks the moderate one",
      [freshHigh, accelerating].sort(byIntentMomentumDesc)[0] === freshHigh, `${freshHigh.momentumRank} vs ${accelerating.momentumRank}`)
  }

  // NEXT-BEST-ACTION — wait / do_nothing / reasons-not-to-act, policy in code.
  const nbaBase = { ...planBase, now: NOW, lastTouchAt: new Date("2026-09-01T12:00:00Z") }
  const due = planNextLeadTouch({ ...nbaBase, context: { intent: accelerating } })
  check("NBA-DUE-CONTROL (positive control): with nothing against it the plan SENDS, carrying intent evidence",
    due.action === "send_touch" && due.evidence.some((e) => e.kind === "intent") && due.priority === accelerating.momentumRank,
    `${due.action}/${due.reasonCode}`)
  const dnc = planNextLeadTouch({ ...nbaBase, context: { dncOrNoConsent: true } })
  check("NBA-DNC-EMAIL-MAIL-ONLY: DNC / no consent restricts the channel to email or direct mail, with its reason",
    dnc.reasonsNotToAct.some((r) => r.code === "channel_restricted_no_consent" && !r.blocking)
      && (dnc.action === "do_nothing" || (dnc.channel !== null && ["email", "direct_mail"].includes(wireChannelFor(dnc.channel)))),
    `${dnc.action}/${dnc.channel}`)
  const dncNoChannel = planNextLeadTouch({ ...nbaBase, emailUsable: false, mailingVerified: false, context: { dncOrNoConsent: true } })
  check("NBA-DNC-NO-CHANNEL: DNC with neither email nor mail verified → DO_NOTHING with its reason",
    dncNoChannel.action === "do_nothing" && dncNoChannel.reasonCode === "no_permitted_channel"
      && dncNoChannel.reasonsNotToAct.some((r) => r.code === "channel_restricted_no_consent"))
  // NEGATIVE INTELLIGENCE (wave 98, lane 98C) — ONE dead-end vocabulary, read by the reasons-not-to-act.
  {
    const live = ["opt_out", "explicit_opt_out", "do_not_call", "wrong_person", "not_ready_now", "representation", "bad_contact_data", "not_interested", "wrong_number"]
    check("DEAD-END-VOCAB: every live spelling maps onto one of the seven canonical dead ends",
      live.every((v) => (DEAD_END_OUTCOMES as readonly string[]).includes(canonicalDeadEnd(v) ?? "")), live.filter((v) => !canonicalDeadEnd(v)).join(","))
    check("DEAD-END-VOCAB-CONTROL (positive control): a non-dead-end (no_answer, disqualified, appointment_set) is NOT mapped",
      ["no_answer", "disqualified", "appointment_set"].every((v) => canonicalDeadEnd(v) === null))
    check("DEAD-END-DEFAULT-CANONICAL: the default suppress_on_outcomes uses only canonical spellings (do_not_call merged onto do_not_contact)",
      DEFAULT_AISA_SETTINGS.suppress_on_outcomes.every((o) => canonicalDeadEnd(o) === o))
    const ev = deadEndsFromLeadSources({
      isaOutcomes: [{ outcome: "wrong_number", created_at: "2026-09-20T00:00:00Z" }, { outcome: "no_answer", created_at: "2026-09-21T00:00:00Z" }],
      callOutcomes: [{ outcome: "opt_out", created_at: "2026-09-22T00:00:00Z" }],
      qualificationSummary: "[AI qualification] already represented by an agent: yes\n[AI qualification] timeline: 3-6",
      longTermNurtureUntil: "2026-12-01T00:00:00Z",
    })
    check("DEAD-END-SOURCES: each existing writer's record is read onto the vocabulary (ISA outcome, call outcome, qualification line, nurture date)",
      ["wrong_number", "do_not_contact", "already_represented", "postponed"].every((o) => ev.some((e) => e.outcome === o)) && ev.length === 4, ev.map((e) => e.outcome).join(","))
    check("DEAD-END-SOURCES-NEWEST-LINE: a later 'already represented … no' clears an earlier yes",
      deadEndsFromLeadSources({ qualificationSummary: "already represented by an agent: yes\nalready represented by an agent: no" }).length === 0)
    const wrong = planNextLeadTouch({ ...nbaBase, context: { deadEnds: [{ outcome: "wrong_number", at: NOW, source: "proof" }] } })
    check("NBA-DEAD-END: a suppressed dead end (default settings) → DO_NOTHING, reason dead_end", wrong.action === "do_nothing" && wrong.reasonCode === "dead_end", wrong.reasonCode)
    const weighed = planNextLeadTouch({ ...nbaBase, context: { deadEnds: [{ outcome: "property_sold", at: NOW, source: "proof" }], suppressOnOutcomes: ["not_interested"] } })
    check("NBA-DEAD-END-WEIGHED (positive control): a dead end the tenant does NOT suppress is weighed, not decisive — the plan still sends",
      weighed.action === "send_touch" && weighed.reasonsNotToAct.some((r) => r.code === "dead_end" && !r.blocking), weighed.reasonCode)
    const repr = planNextLeadTouch({ ...nbaBase, context: { callbackRequested: true, deadEnds: [{ outcome: "already_represented", at: null, source: "proof" }], suppressOnOutcomes: [] } })
    check("NBA-DEAD-END-TERMINAL: already_represented blocks whatever the settings say, and outranks a callback", repr.action === "do_nothing" && repr.reasonCode === "dead_end", repr.reasonCode)
    const legacy = planNextLeadTouch({ ...nbaBase, context: { deadEnds: [{ outcome: "do_not_contact", at: NOW, source: "proof" }], suppressOnOutcomes: ["do_not_call"] } })
    check("NBA-DEAD-END-LEGACY-SPELLING: a stored legacy setting ('do_not_call') still suppresses its canonical dead end", legacy.action === "do_nothing")
    const later = planNextLeadTouch({ ...nbaBase, context: { deadEnds: [{ outcome: "postponed", at: null, until: new Date("2026-12-01T00:00:00Z"), source: "proof" }] } })
    check("NBA-POSTPONED: postponed → WAIT until the requested date", later.action === "wait" && later.reasonCode === "postponed" && later.dueAt?.toISOString() === "2026-12-01T00:00:00.000Z", later.reasonCode)
    const lapsed = planNextLeadTouch({ ...nbaBase, context: { deadEnds: [{ outcome: "postponed", at: null, until: new Date("2026-01-01T00:00:00Z"), source: "proof" }] } })
    check("NBA-POSTPONED-LAPSED (positive control): a postponement whose date has passed no longer holds", lapsed.action === "send_touch", lapsed.reasonCode)
    const sweep = stripComments(readFileSync(join(root, "lib/ai-isa/lead-action-plan.ts"), "utf8"))
    check("WIRED: the lead sweep reads the dead ends (ai_isa_activities + voice_calls, batched) and passes them + the tenant's suppress_on_outcomes to the plan",
      /from\("ai_isa_activities"\)[\s\S]{0,200}outcome_recorded/.test(sweep) && /from\("voice_calls"\)/.test(sweep)
        && /deadEnds: deadEndsFromLeadSources\(/.test(sweep) && /suppressOnOutcomes: settings\.suppress_on_outcomes/.test(sweep))
    const page = stripComments(readFileSync(join(root, "app/dashboard/ai-isa/settings/page.tsx"), "utf8"))
    check("WIRED: the settings page offers the ONE vocabulary (no retyped outcome list)", /OUTCOME_OPTIONS = SUPPRESSIBLE_DEAD_ENDS/.test(page))
  }
  const waitInterval = planNextLeadTouch({ ...nbaBase, lastTouchAt: new Date("2026-10-01T12:00:00Z") })
  check("NBA-WAIT: inside the cadence interval the action is WAIT with a due time",
    waitInterval.action === "wait" && waitInterval.dueAt !== null, waitInterval.reasonCode)
  const appt = planNextLeadTouch({ ...nbaBase, context: { appointmentAt: new Date("2026-10-04T15:00:00Z") } })
  check("NBA-APPOINTMENT: an appointment on the calendar → WAIT until it",
    appt.action === "wait" && appt.reasonCode === "appointment_scheduled" && appt.dueAt?.toISOString() === "2026-10-04T15:00:00.000Z")
  const agent = planNextLeadTouch({ ...nbaBase, context: { lastAgentTouchAt: new Date("2026-09-30T12:00:00Z") } })
  check("NBA-AGENT-HANDLING: an agent touch inside the window → DO_NOTHING (the human owns it)",
    agent.action === "do_nothing" && agent.reasonCode === "agent_handling")
  const fatigue = planNextLeadTouch({ ...nbaBase, context: { lastAnyTouchAt: new Date("2026-10-02T00:00:00Z") } })
  check("NBA-FATIGUE: any touch inside the fatigue window → WAIT", fatigue.action === "wait" && fatigue.reasonCode === "recently_contacted")
  const quiet = planNextLeadTouch({ ...nbaBase, context: { recipientLocalHour: 22 } })
  const quietOk = planNextLeadTouch({ ...nbaBase, context: { recipientLocalHour: 10 } })
  check("NBA-QUIET-HOURS: 22:00 local → WAIT; 10:00 local (positive control) → SEND",
    quiet.action === "wait" && quiet.reasonCode === "quiet_hours" && quietOk.action === "send_touch")
  const dup = planNextLeadTouch({ ...nbaBase, context: { duplicateOf: "lead-survivor", callbackRequested: true } })
  check("NBA-DUPLICATE: a duplicate is DO_NOTHING even when it asked for a callback — the survivor is worked",
    dup.action === "do_nothing" && dup.reasonCode === "duplicate")
  const cb = planNextLeadTouch({ ...nbaBase, lastTouchAt: new Date("2026-10-02T10:00:00Z"), context: { callbackRequested: true, lastAnyTouchAt: new Date("2026-10-02T10:00:00Z") } })
  check("NBA-CALLBACK-CONVERTS: a callback is positive intent → CONVERT, outranking cadence and fatigue (owner ruling)",
    cb.action === "convert" && cb.reasonCode === "convert_on_callback")
  const low = planNextLeadTouch({ ...nbaBase, context: { intent: oneSource } })
  check("NBA-LOW-CONFIDENCE-RECORDED: low confidence is weighed and recorded but does not by itself stop a due nurture touch",
    low.action === "send_touch" && low.reasonsNotToAct.some((r) => r.code === "low_confidence" && !r.blocking))
  const paused = planNextLeadTouch({ ...nbaBase, context: { outreachPaused: true, callbackRequested: true } })
  check("NBA-PAUSED: a human pause → DO_NOTHING (the AI never overrides the human)", paused.action === "do_nothing" && paused.reasonCode === "outreach_paused")

  // WIRING — the sweep passes the context, and DNC no longer silently skips the lead.
  const lap = code("lib/ai-isa/lead-action-plan.ts")
  check("NBA-WIRED: advanceLeadActionPlans passes a NextBestAction context to the plan",
    /planNextLeadTouch\(\{[\s\S]{0,1600}context:\s*\{[\s\S]{0,400}duplicateOf[\s\S]{0,200}outreachPaused[\s\S]{0,200}dncOrNoConsent/.test(lap))
  check("NBA-DNC-NOT-A-SILENT-SKIP: the sweep no longer drops a DNC lead before the plan sees it",
    !/dnc_status\s*===\s*true\)\s*\{[\s\S]{0,120}continue/.test(lap))
  check("NBA-DNC-SCAN-CONTROL (positive control): the skip regex recognises the retired shape",
    /dnc_status\s*===\s*true\)\s*\{[\s\S]{0,120}continue/.test("if (lead.ai_outreach_paused === true || lead.dnc_status === true) { out.skipped.push(x); continue }"))
  const bs = code("lib/lead-intelligence/behavioral-summary.ts")
  check("DECAY-WIRED: the behavioural fold IS the decayed score (one number, not two)",
    /behavioralIntentScore\s*=\s*decayedIntent\.score/.test(bs) && !/perSourceMax/.test(bs))
}

console.log("\n── 7c. LANE 98B: NBA verdicts → the action ledger; intent for UNCONVERTED leads ──")
{
  const B98 = "11111111-1111-4111-8111-111111111111"
  const L98 = "33333333-3333-4333-8333-333333333333"
  const now98 = new Date("2026-08-10T12:00:00Z")
  // do_nothing — a human paused the AI
  const paused = planNextLeadTouch({ ...planBase, now: now98, context: { outreachPaused: true } })
  const rec = nonActionRecordFor(paused, { brokerageId: B98, leadId: L98, now: now98 })
  check("NBA-LEDGER-DO-NOTHING: a do_nothing verdict becomes a recordNonAction context with NO_ACTION_NEEDED",
    paused.action === "do_nothing" && rec?.decision === "do_nothing" && rec?.reasonCode === "NO_ACTION_NEEDED" && rec?.subject.id === L98)
  check("NBA-LEDGER-REASONS: every reason-not-to-act rides in detail, with the plan's own code",
    Array.isArray((rec?.detail as { reasons_not_to_act?: unknown[] } | undefined)?.reasons_not_to_act) &&
    ((rec?.detail as { reasons_not_to_act: Array<{ code: string }> }).reasons_not_to_act.some((r) => r.code === "outreach_paused")) &&
    (rec?.detail as { plan_code?: string }).plan_code === "outreach_paused")
  check("NBA-LEDGER-CYCLE: one row per lead per verdict per UTC day (deterministic cycle)", rec?.cycle === "outreach_paused:2026-08-10")
  // wait — fatigue window
  const fatigued = planNextLeadTouch({ ...planBase, now: now98, context: { lastAnyTouchAt: new Date(now98.getTime() - 3_600_000) } })
  const wrec = nonActionRecordFor(fatigued, { brokerageId: B98, leadId: L98, now: now98 })
  check("NBA-LEDGER-WAIT: a wait verdict → WAIT_COOLDOWN with its until", fatigued.action === "wait" && wrec?.decision === "wait" && wrec?.reasonCode === "WAIT_COOLDOWN" && !!wrec?.until)
  // POSITIVE CONTROL — an ACTING verdict records no non-action
  const due = planNextLeadTouch({ ...planBase, now: now98 })
  check("NBA-LEDGER-CONTROL: a send_touch verdict records NO non-action (null)", due.action === "send_touch" && nonActionRecordFor(due, { brokerageId: B98, leadId: L98, now: now98 }) === null)
  // The sweep is wired to record it
  const sweep = stripComments(readFileSync(join(process.cwd(), "lib/ai-isa/lead-action-plan.ts"), "utf8"))
  const adv = sweep.slice(sweep.indexOf("export async function advanceLeadActionPlans"))
  check("NBA-LEDGER-WIRED: advanceLeadActionPlans records every non-action BEFORE skipping the lead",
    /const nonAction = nonActionRecordFor\(plan,/.test(adv) && /recordNonAction\(nonAction/.test(adv) &&
    adv.indexOf("recordNonAction(nonAction") < adv.indexOf("out.skipped.push({ leadId, code: plan.code"))

  // INTENT for an UNCONVERTED lead — lead-keyed rows only
  const obs = leadIntentObservations({
    replies: [{ replied_at: "2026-08-09T18:00:00Z" }, { replied_at: null }],
    timeline: "1-3_months",
  })
  check("LEAD-INTENT-MAP: replies and the stated timeline become observations (a null reply is not one; timeline age unknown)",
    obs.length === 2 && obs.filter((o) => o.type === "inbound_reply").length === 1 && obs.some((o) => o.type === "stated_timeline" && o.observedAt === null))
  const sweepSrc = stripComments(readFileSync(join(process.cwd(), "lib/lead-intelligence/behavioral-summary.ts"), "utf8"))
  const leadFn = sweepSrc.slice(sweepSrc.indexOf("export async function buildLeadDecayedIntent"))
  check("LEAD-INTENT-NO-WRITERLESS-READ: the lead reader does not read lead_idx_property_interactions (no lead-class writer by owner ruling)",
    leadFn.length > 0 && !/lead_idx_property_interactions/.test(leadFn) && /\.from\("isa_outreach_log"\)/.test(leadFn))
  const intent = scoreDecayedIntent(obs, now98)
  const withIntent = planNextLeadTouch({ ...planBase, now: now98, context: { intent } })
  check("LEAD-INTENT-FED: a lead with lead-keyed rows gets a non-zero priority from its decayed intent", intent.score > 0 && withIntent.priority === intent.momentumRank && withIntent.priority !== 0)
  check("LEAD-INTENT-CONTROL: no lead-keyed rows → no observations (the plan decides on cadence alone)",
    leadIntentObservations({ replies: [], timeline: null }).length === 0 && planNextLeadTouch({ ...planBase, now: now98 }).priority === 0)
  check("LEAD-INTENT-WIRED: the sweep feeds buildLeadDecayedIntent into the plan's context",
    /intent:\s*\(await buildLeadDecayedIntent\(supabase, input\.brokerageId,/.test(adv) && /duplicate_of_contact_id,[^"]*\btimeline\b[^"]*"/.test(adv))
}

console.log("\n── 8. LIVE LAYER (creds-gated): the gate opens and closes, with ZERO spend ──")

const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)

if (!hasCreds) {
  console.log("  ⏭  Skipped — SUPABASE creds not set. (The PURE gate above is the load-bearing half;")
  console.log("     the live layer proves the same verdicts against real rows and cleans up after itself.)")
} else {
  const { createServiceClient } = await import("../lib/supabase/service")
  const { releaseDueLeadTouches } = await import("../lib/ai-isa/lead-action-plan")
  const svc = createServiceClient()
  const uuid = () => (globalThis.crypto ?? _require("node:crypto").webcrypto).randomUUID()

  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) {
    console.log("  ⏭  Skipped — need a real brokerage row.")
  } else {
    const brokerageId = (brokerage as { id: string }).id
    const leadId = uuid()
    let messageId: string | null = null
    let settingsRowId: string | null = null
    let hadSettingsRow = false

    // BEFORE-COUNTS. Cleanup is proven by returning these to their starting values.
    const countLeads = async () =>
      (await svc.from("leads").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)).count ?? 0
    const countMsgs = async () =>
      (await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)).count ?? 0
    const countSettings = async () =>
      (await svc.from("ai_isa_settings").select("id", { count: "exact", head: true })).count ?? 0
    const leadsBefore = await countLeads()
    const msgsBefore = await countMsgs()
    const settingsBefore = await countSettings()

    try {
      // THE SEED. The email is deliberately NOT verified: `pickLeadOutreachChannel`
      // then refuses the email rail, so the governor can prove the SETTINGS GATE
      // opened (decision.gate === "authorised") while no provider is ever called.
      // Zero email sent, zero Lob spend, against a real row.
      const { error: leadErr } = await svc.from("leads").insert({
        id: leadId, brokerage_id: brokerageId,
        first_name: "ZZTest", last_name: "LeadActionPlan",
        email: "zz.leadactionplan@example.invalid",
        email_verified: false, email_opt_out: false,
        mailing_address_verified: false,
        is_active: true, ai_isa_owner: true, lifecycle_state: "unconsented",
      })
      check("LIVE-SEED-LEAD", !leadErr, leadErr?.message)

      const { proposeClientMessage } = await import("../lib/agents/agent-client-messages")
      const prop = await proposeClientMessage({
        brokerageId, agentKind: "ai_isa", entityType: "lead", entityId: leadId,
        recipientLeadId: leadId, audience: "lead", channel: "email",
        subject: "ZZTest lead action plan probe",
        body: "Hi ZZTest, about the 3-bed ranch you mentioned — no pressure at all.",
        rationale: "lead-action-plan simulator probe",
      }, svc)
      messageId = prop.id ?? null
      check("LIVE-SEED-PROPOSAL", prop.ok && !!messageId, prop.error)

      // (a) NO SETTINGS ROW ANYWHERE → the default closes the gate.
      const closed = await releaseDueLeadTouches({ brokerageId, leadId, supabase: svc })
      const closedDecision = closed.decisions[0]
      check("LIVE-GATE-CLOSED-BY-DEFAULT: with no settings row the touch is STAGED",
        closed.examined === 1 && closed.sent === 0 && closed.staged === 1 &&
        closedDecision?.gate === "broker_approval_required",
        JSON.stringify(closed.decisions))

      const { data: stillProposed } = await svc.from("agent_client_messages")
        .select("status").eq("id", messageId ?? "").maybeSingle()
      check("LIVE-GATE-CLOSED-LEAVES-IT-FOR-A-HUMAN: status is still 'proposed', not dropped",
        (stillProposed as { status?: string } | null)?.status === "proposed",
        JSON.stringify(stillProposed))

      // (b) THE BROKERAGE AUTHORISES IT → the gate OPENS. The lead's own
      // verification then refuses the send, so nothing is dispatched.
      const { data: existing } = await svc.from("ai_isa_settings")
        .select("id").eq("owner_type", "brokerage").eq("brokerage_id", brokerageId).maybeSingle()
      hadSettingsRow = !!existing
      const { writeIsaSettings } = await import("../lib/ai-isa/resolve-isa-settings")
      const wrote = await writeIsaSettings({
        owner: { ownerType: "brokerage", ownerId: brokerageId },
        brokerageId,
        updates: { enabled: true, require_broker_approval: false, lead_allowed_channels: ["email", "direct_mail"] },
      })
      check("LIVE-SETTINGS-WRITE: require_broker_approval finally HAS a writer", wrote.success, wrote.error)
      if (!hadSettingsRow) {
        const { data: made } = await svc.from("ai_isa_settings")
          .select("id").eq("owner_type", "brokerage").eq("brokerage_id", brokerageId).maybeSingle()
        settingsRowId = (made as { id?: string } | null)?.id ?? null
      }

      const { data: readBack } = await svc.from("ai_isa_settings")
        .select("require_broker_approval").eq("owner_type", "brokerage").eq("brokerage_id", brokerageId).maybeSingle()
      check("LIVE-SETTINGS-COLUMN-NOT-ONLY-BLOB: the COLUMN itself is false, not just the jsonb",
        (readBack as { require_broker_approval?: boolean } | null)?.require_broker_approval === false,
        JSON.stringify(readBack))

      const opened = await releaseDueLeadTouches({ brokerageId, leadId, supabase: svc })
      const openedDecision = opened.decisions[0]
      check("LIVE-GATE-OPENS: the settings gate answers 'authorised' once the brokerage says so",
        openedDecision?.gate === "authorised", JSON.stringify(opened.decisions))
      check("LIVE-CONSENT-STILL-REFUSES: an unverified email is NOT sent even with auto-send on",
        opened.sent === 0 && openedDecision?.mode === "stage_for_approval" &&
        /pickLeadOutreachChannel/.test(openedDecision?.reason ?? ""),
        JSON.stringify(opened.decisions))

      const { data: afterOpen } = await svc.from("agent_client_messages")
        .select("status, sent_at").eq("id", messageId ?? "").maybeSingle()
      check("LIVE-NOTHING-WAS-SENT: the row never left 'proposed' and has no sent_at",
        (afterOpen as { status?: string; sent_at?: string | null } | null)?.status === "proposed" &&
        !(afterOpen as { sent_at?: string | null } | null)?.sent_at,
        JSON.stringify(afterOpen))
    } finally {
      // CLEANUP, and PROVE it. A DELETE that matches nothing resolves exactly like
      // one that worked (CLAUDE.md §3), so the counts are re-read rather than the
      // absence of an error being trusted.
      if (messageId) await svc.from("agent_client_messages").delete().eq("id", messageId)
      await svc.from("leads").delete().eq("id", leadId)
      if (settingsRowId) await svc.from("ai_isa_settings").delete().eq("id", settingsRowId)
      else if (hadSettingsRow) {
        // The brokerage already had a row before this run. Restoring the DEFAULT is
        // the safe direction: an auto-send switch left ON by a test is the exact
        // failure this suite exists to prevent.
        const { writeIsaSettings } = await import("../lib/ai-isa/resolve-isa-settings")
        await writeIsaSettings({
          owner: { ownerType: "brokerage", ownerId: brokerageId },
          brokerageId,
          updates: { require_broker_approval: true },
        })
      }

      const leadsAfter = await countLeads()
      const msgsAfter = await countMsgs()
      const settingsAfter = await countSettings()
      check(`LIVE-CLEANUP-LEADS: ${leadsBefore} → ${leadsAfter}`, leadsAfter === leadsBefore)
      check(`LIVE-CLEANUP-MESSAGES: ${msgsBefore} → ${msgsAfter}`, msgsAfter === msgsBefore)
      check(`LIVE-CLEANUP-SETTINGS: ${settingsBefore} → ${settingsAfter}`, settingsAfter === settingsBefore)
    }
  }
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(` FAILED: ${failures.join(", ")}`)
  console.log(" ❌ LEAD_ACTION_PLAN_FAIL")
  process.exit(1)
}
console.log(" ✅ LEAD_ACTION_PLAN_PASS — the AI ISA sends on a lead's three channels only when the brokerage said it may")
