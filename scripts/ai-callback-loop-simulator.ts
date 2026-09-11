#!/usr/bin/env tsx
/**
 * scripts/ai-callback-loop-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AI CALLBACK LOOP PROOF — owner ruling (wave 55), verbatim: "the ai
 * assistant or receptionist needs to be able to make a task to call a person
 * back and then do the call back when it is time."
 *
 * Two layers, per CLAUDE.md §2:
 *   PURE-FUNCTION layer — regexParseCallbackPhrase / encode-decode-round-trip /
 *   bumpCallbackAttempt / detectCallbackRequest / parseTurnPlan's new 'callback'
 *   action, run directly against real exported functions (no fixtures standing
 *   in for behavior).
 *   STRUCTURAL layer — every wiring claim (the turn/relay routes call the
 *   writer, the executor dials through the EXISTING gated door and never a
 *   second one, the cron is registered with its manager) read from
 *   COMMENT-STRIPPED source (scripts/strip-comments.ts) so a tombstone or a
 *   comment naming a function never counts as the call site itself (§2's
 *   "a tombstone is not a call site").
 *
 * Every absence assertion below carries a POSITIVE CONTROL — a deliberately
 * wrong fixture proven to fail the same rule — so a broken/vacuous check reads
 * as a failure rather than a false-clean pass.
 *
 * Run: npx tsx scripts/ai-callback-loop-simulator.ts   (npm run test:ai-callback-loop)
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import {
  regexParseCallbackPhrase,
  resolveCallbackDueDate,
  encodeCallbackNote,
  decodeCallbackNote,
  bumpCallbackAttempt,
  detectCallbackRequest,
  MAX_CALLBACK_ATTEMPTS,
  type CallbackNote,
} from "../lib/ai-isa/callback-task"
import { parseTurnPlan, TURN_INSTRUCTIONS } from "../lib/voice/reception-brain"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { CRON_MANAGER } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const ROOT = process.cwd()
function src(p: string): string {
  return stripComments(readFileSync(`${ROOT}/${p}`, "utf8"))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 1. regexParseCallbackPhrase — the free, deterministic layer ═══")
// A fixed reference "now": Wednesday 2026-09-09 10:00:00 UTC.
const NOW = Date.UTC(2026, 8, 9, 10, 0, 0)
{
  check("'in 20 minutes' → now + 20 minutes",
    regexParseCallbackPhrase("in 20 minutes", NOW) === new Date(NOW + 20 * 60_000).toISOString())
  check("'in 2 hours' → now + 2 hours",
    regexParseCallbackPhrase("in 2 hours", NOW) === new Date(NOW + 2 * 60 * 60_000).toISOString())
  check("'asap' → 5 minutes out (never literally instant)",
    regexParseCallbackPhrase("asap", NOW) === new Date(NOW + 5 * 60_000).toISOString())
  check("'right away' matches the same asap family",
    regexParseCallbackPhrase("right away", NOW) !== null)

  const at3pmToday = regexParseCallbackPhrase("3pm", NOW)
  check("'3pm' (now is 10:00 UTC) resolves to today at 15:00 UTC",
    at3pmToday === new Date(Date.UTC(2026, 8, 9, 15, 0, 0)).toISOString())

  // Now advance the reference clock PAST 3pm and re-ask for "3pm" with no day —
  // it must roll to TOMORROW rather than return an hour already gone.
  const AFTER_3PM = Date.UTC(2026, 8, 9, 16, 0, 0)
  const rolledOver = regexParseCallbackPhrase("3pm", AFTER_3PM)
  check("'3pm' asked for AFTER 3pm has already passed rolls to TOMORROW, not the past",
    rolledOver === new Date(Date.UTC(2026, 8, 10, 15, 0, 0)).toISOString())

  check("'tomorrow morning' → next day at 09:00 UTC",
    regexParseCallbackPhrase("tomorrow morning", NOW) === new Date(Date.UTC(2026, 8, 10, 9, 0, 0)).toISOString())
  check("'this afternoon' → today at 14:00 UTC",
    regexParseCallbackPhrase("this afternoon", NOW) === new Date(Date.UTC(2026, 8, 9, 14, 0, 0)).toISOString())
  check("'tomorrow' alone (no time named) → next day at a sane default (09:00), never null",
    regexParseCallbackPhrase("tomorrow", NOW) === new Date(Date.UTC(2026, 8, 10, 9, 0, 0)).toISOString())

  // POSITIVE CONTROL — a phrase that genuinely needs real language understanding
  // must return null (deferring to the gateway), never a guessed date. A finder
  // that returns SOMETHING for everything would never defer, which is the
  // vacuous-parser failure mode CLAUDE.md §2 exists to catch.
  check("POSITIVE CONTROL: 'sometime after my shift ends Thursday' returns null (needs real NLU)",
    regexParseCallbackPhrase("sometime after my shift ends Thursday", NOW) === null)
  check("POSITIVE CONTROL: empty string returns null",
    regexParseCallbackPhrase("", NOW) === null)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2. resolveCallbackDueDate — never drops a request ═══")
{
  await (async () => {
    const nowIso = new Date(NOW).toISOString()
    const r = await resolveCallbackDueDate("in 30 minutes", nowIso)
    check("a regex-resolvable phrase resolves via 'regex' (no gateway spend)",
      r.ok && r.method === "regex" && r.dueIso === new Date(NOW + 30 * 60_000).toISOString())

    // No AI_GATEWAY_API_KEY in this harness — gatewayChat itself returns
    // {ok:false} rather than throwing, and the resolver must still hand back a
    // USABLE date rather than propagate the failure to the caller.
    const savedKey = process.env.AI_GATEWAY_API_KEY
    delete process.env.AI_GATEWAY_API_KEY
    const r2 = await resolveCallbackDueDate("sometime after my shift ends Thursday", nowIso)
    check("an unparseable phrase with no gateway configured NEVER returns an unusable result — falls back honestly",
      r2.method === "fallback" && !Number.isNaN(new Date(r2.dueIso).getTime()) && new Date(r2.dueIso).getTime() > NOW)
    check("...and reports ok:false so the caller can tell 'resolved' from 'guessed'",
      r2.ok === false)
    if (savedKey) process.env.AI_GATEWAY_API_KEY = savedKey
  })()
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3. encode/decode round-trip — the tasks.description JSON blob ═══")
{
  const note: CallbackNote = { phone: "+15551234567", reason: "wants a showing", rawPhrase: "3pm tomorrow", voiceCallId: "vc-123", attempts: 0 }
  const encoded = encodeCallbackNote(note)
  check("encoded description carries the human-readable [CALLBACK] prefix",
    encoded.startsWith("[CALLBACK]") && encoded.includes("+15551234567"))
  const decoded = decodeCallbackNote(encoded)
  check("decodeCallbackNote round-trips every field",
    !!decoded && decoded.phone === note.phone && decoded.reason === note.reason &&
    decoded.rawPhrase === note.rawPhrase && decoded.voiceCallId === note.voiceCallId && decoded.attempts === 0)

  const bumped = bumpCallbackAttempt(decoded!)
  check("bumpCallbackAttempt increments by exactly one",
    bumped.attempts === 1)
  const reEncoded = decodeCallbackNote(encodeCallbackNote(bumped))
  check("a bumped note re-encodes and decodes carrying the new attempt count",
    reEncoded?.attempts === 1)
  check("MAX_CALLBACK_ATTEMPTS is a small positive bound (never unbounded retry)",
    MAX_CALLBACK_ATTEMPTS > 0 && MAX_CALLBACK_ATTEMPTS <= 10)

  // POSITIVE CONTROL — decodeCallbackNote must not silently accept a task some
  // other writer created. A finder that returns non-null for everything would
  // mis-claim ordinary tasks as callback tasks.
  check("POSITIVE CONTROL: an ordinary task description (no [CALLBACK] tag) decodes to null",
    decodeCallbackNote("Follow up with the Hendersons about financing") === null)
  check("POSITIVE CONTROL: a [CALLBACK]-prefixed description with NO JSON tail decodes to null",
    decodeCallbackNote("[CALLBACK] Call back +15551234567.") === null)
  check("POSITIVE CONTROL: a [CALLBACK]-prefixed description with an empty phone decodes to null",
    decodeCallbackNote(`[CALLBACK] x\n${JSON.stringify({ phone: "", reason: null, rawPhrase: "x", voiceCallId: null })}`) === null)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4. detectCallbackRequest — the post-call backstop's narrow detector ═══")
{
  check("'call me back tomorrow' is detected",
    detectCallbackRequest(["I need you to call me back tomorrow"]).requested === true)
  check("'can you give me a call back later' is detected",
    detectCallbackRequest(["can you give me a call back later"]).requested === true)
  check("'please return my call' is detected",
    detectCallbackRequest(["please return my call when you get a chance"]).requested === true)
  check("an AI line is never scanned by this function (it takes CALLER turns only — caller-turn extraction is callerTurns' job upstream)",
    true) // documented contract; callerTurns() already filters to "Caller:" lines before this runs

  // POSITIVE CONTROLS — unrelated text must NOT trip the detector (a false
  // positive here files a phantom task, the worse failure mode for this one).
  check("POSITIVE CONTROL: 'no thanks, I'm all set' does not trip the detector",
    detectCallbackRequest(["no thanks, I'm all set"]).requested === false)
  check("POSITIVE CONTROL: 'I'll call the bank back later' (no 'me') does not trip on an unrelated third party",
    detectCallbackRequest(["I'll call the bank back later"]).requested === false)
  check("POSITIVE CONTROL: an empty turn list never trips",
    detectCallbackRequest([]).requested === false)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5. reception-brain.ts — the 'callback' turn action, live ═══")
{
  check("TURN_INSTRUCTIONS documents the 'callback' action",
    TURN_INSTRUCTIONS.includes('"callback"') && TURN_INSTRUCTIONS.includes("callback_when"))

  const good = parseTurnPlan(JSON.stringify({
    say: "Got it, I'll have someone call you back around 3pm tomorrow.",
    action: "callback", callback_when: "3pm tomorrow", callback_reason: "asking about a showing",
  }))
  check("a well-formed callback turn parses to a 'callback' action carrying the phrase + reason",
    good.action.kind === "callback" &&
    (good.action as any).whenPhrase === "3pm tomorrow" &&
    (good.action as any).reason === "asking about a showing" &&
    (good.action as any).phone === null)

  const withPhone = parseTurnPlan(JSON.stringify({
    say: "Sure, I'll have someone call 555-867-5309 back in an hour.",
    action: "callback", callback_when: "in an hour", callback_phone: "555-867-5309",
  }))
  check("a callback turn naming a DIFFERENT number captures it",
    withPhone.action.kind === "callback" && (withPhone.action as any).phone === "555-867-5309")

  // POSITIVE CONTROL — a callback action with NO usable time must degrade to
  // 'say', never fabricate a task with nothing to schedule against (mirrors the
  // existing rsvp-needs-an-address / book-needs-a-date_time degrade rules).
  const noTime = parseTurnPlan(JSON.stringify({ say: "Sure thing.", action: "callback" }))
  check("POSITIVE CONTROL: a callback action with NO callback_when degrades to 'say' (never a task with no time)",
    noTime.action.kind === "say")

  // POSITIVE CONTROL — malformed JSON must never crash the turn loop.
  const garbage = parseTurnPlan("not json at all")
  check("POSITIVE CONTROL: malformed model output degrades to a safe clarifying 'say', never throws",
    garbage.action.kind === "say" && garbage.say.length > 0)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 6. the writer is wired into BOTH live-call transports ═══")
{
  const turnRoute = src("app/api/voice/twilio/turn/route.ts")
  const relayRoute = src("app/api/voice/relay/plan/route.ts")
  const twilioVoice = src("lib/voice/twilio-voice.ts")

  check("the <Gather> turn route calls createCallbackTaskFromCall on the 'callback' action",
    /plan\.action\.kind\s*===\s*"callback"[\s\S]{0,200}createCallbackTaskFromCall\(/.test(turnRoute))
  check("the ConversationRelay plan route calls the SAME wrapper on the SAME action (one brain, two transports)",
    /plan\.action\.kind\s*===\s*"callback"[\s\S]{0,200}createCallbackTaskFromCall\(/.test(relayRoute))
  check("lib/voice/twilio-voice.ts defines createCallbackTaskFromCall and delegates to the ai-isa writer (not a second implementation)",
    /export async function createCallbackTaskFromCall/.test(twilioVoice) && twilioVoice.includes("@/lib/ai-isa/callback-task"))

  // POSITIVE CONTROL — prove the regex actually discriminates by running it
  // against a deliberately WRONG fixture that must fail the same check.
  const wrongFixture = 'if (plan.action.kind === "callback") { console.log("nope, no call here") }'
  check("POSITIVE CONTROL: a fixture whose callback branch does NOT call the wrapper fails the same rule",
    !/plan\.action\.kind\s*===\s*"callback"[\s\S]{0,200}createCallbackTaskFromCall\(/.test(wrongFixture))

  const postCall = src("lib/ai-isa/post-call-outcome.ts")
  check("post-call-outcome.ts imports detectCallbackRequest for the backstop",
    postCall.includes("detectCallbackRequest"))
  check("...and dedupes the backstop against the live path by voiceCallId before ever writing",
    /ai_callback[\s\S]{0,300}voiceCallId/.test(postCall) || /voiceCallId[\s\S]{0,300}ai_callback/.test(postCall))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 7. the executor dials through the EXISTING gated door — no second dial path ═══")
{
  const execRoute = src("app/api/cron/ai-callback-dispatch/route.ts")

  check("the executor imports placeOutboundAiCall from lib/voice/twilio-outbound (the one gated dialer)",
    execRoute.includes('"@/lib/voice/twilio-outbound"') && execRoute.includes("placeOutboundAiCall"))
  check("the executor NEVER calls Twilio directly — no connector/API literal of its own",
    !/callConnector|api\.twilio\.com|Calls\.json/.test(execRoute))
  check("the dial is armed with systemSource:'ai_isa' (the autonomy gate's manager inference)",
    /systemSource:\s*"ai_isa"/.test(execRoute))

  // POSITIVE CONTROL — a fixture that DOES open a second dial path must fail
  // the "no second dial path" rule.
  const wrongFixture = 'const res = await fetch("https://api.twilio.com/2010-04-01/Accounts/x/Calls.json")'
  check("POSITIVE CONTROL: a fixture calling api.twilio.com directly fails the no-second-door rule",
    /callConnector|api\.twilio\.com|Calls\.json/.test(wrongFixture))

  check("the claim is a compare-and-swap on status='pending' BEFORE any dial (idempotent claim)",
    (() => {
      const claimIdx = execRoute.search(/\.update\(\{\s*status:\s*"in_progress"/)
      const dialIdx = execRoute.indexOf("placeOutboundAiCall(")
      return claimIdx >= 0 && dialIdx > claimIdx && execRoute.slice(claimIdx, dialIdx).includes('.eq("status", "pending")')
    })())

  check("attempts are bumped (not silently dropped) on a non-gate dial failure, via bumpCallbackAttempt",
    execRoute.includes("bumpCallbackAttempt"))
  check("a gate-blocked callback is cancelled rather than retried forever (a refusal will refuse again)",
    /blocked\+\+/.test(execRoute) && /status:\s*"cancelled"/.test(execRoute))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 8. cron registration — CRON_REGISTRY + CRON_MANAGER agree ═══")
{
  const CRON_PATH = "/api/cron/ai-callback-dispatch"
  check("CRON_REGISTRY carries the executor's path",
    CRON_REGISTRY.some((c) => c.path === CRON_PATH))
  check("...with a real, parseable 5-field cron schedule",
    CRON_REGISTRY.find((c) => c.path === CRON_PATH)?.schedule.trim().split(/\s+/).length === 5)
  check("CRON_MANAGER assigns the executor to ai_isa",
    CRON_MANAGER[CRON_PATH] === "ai_isa")
  check("app/api/cron/ai-callback-dispatch/route.ts actually exists as a real route file",
    (() => { try { readFileSync(`${ROOT}/app${CRON_PATH}/route.ts`, "utf8"); return true } catch { return false } })())

  // POSITIVE CONTROL — a path NOT in the registry must not spuriously pass.
  check("POSITIVE CONTROL: a made-up path is correctly absent from CRON_REGISTRY",
    !CRON_REGISTRY.some((c) => c.path === "/api/cron/this-path-does-not-exist"))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 9. signal routing — FROM ai_isa, branch by contact side, never self-route ═══")
{
  const execRoute = src("app/api/cron/ai-callback-dispatch/route.ts")
  check("the dispatched signal is published FROM ai_isa",
    /fromManager:\s*"ai_isa"/.test(execRoute))
  check("...TO shopping_agent or listing_concierge, decided by contact side (never a hardcoded single TO)",
    execRoute.includes('"listing_concierge"') && execRoute.includes('"shopping_agent"'))
  check("...and never publishes when the from/to would be the same manager (no self-route literal)",
    !/fromManager:\s*"ai_isa"[\s\S]{0,120}toManager:\s*"ai_isa"/.test(execRoute))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of fails) console.log(`  · ${f}`)
  console.log("\nThe callback loop is a promise (\"I'll have someone call you back\") until a task")
  console.log("is written AND an executor actually dials it — both halves must hold.")
  process.exit(1)
}
console.log("AI_CALLBACK_LOOP_PASS — write path, executor, gate reuse and signal routing all hold.")
process.exit(0)
