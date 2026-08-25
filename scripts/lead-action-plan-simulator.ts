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
  type LeadSettingsResolution,
} from "../lib/ai-isa/lead-action-plan"
import { DEFAULT_AISA_SETTINGS, type AIISASettings } from "../lib/ai-isa/settings-types"
import { pickLeadOutreachChannel, LEAD_ALLOWED_CHANNELS } from "../lib/ai-isa/lead-channel-policy"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

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
check("NO-SECOND-SEQUENCER: the generic step executor still restricts leads to email/direct_mail",
  /!contactId\s*&&\s*step\.channel\s*!==/.test(stepExec))
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
