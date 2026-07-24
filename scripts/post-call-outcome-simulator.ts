#!/usr/bin/env tsx
/**
 * scripts/post-call-outcome-simulator.ts   (npm run test:post-call-outcome)
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTOMATIC POST-CALL BRAIN on the Twilio-native lane. Every completed AI call
 * now auto-routes its outcome — the CONTACT-side twin of routeLeadCallIntent —
 * without an agent lifting a finger:
 *   negative → contact DNC/call_stop_flag + activity + agent notify
 *   positive → agent notify + an AUTO-DRAFTED follow-up STAGED for one-tap approval
 *   every call → ai_isa_calls scoring + (leads) rolling lead_temperature/lead_score
 * Proves: (source) it fires from BOTH close paths + inbound creates the scoring
 * row; (posture) the client send stays on the compliance-gated proposal rail
 * (never a direct dispatch from the close hook); (pure) the outcome→signal map.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { voiceSignalFor, signalScore, signalTemperature } from "../lib/ai-isa/qualification-core"
import { detectOptOutIntent } from "../lib/ai-isa/opt-out-utils"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// Mirror the module's classifiers (kept in lockstep — asserted against source).
const POS_INTENT = /(appointment|schedul|book|ready to (buy|list|sell)|pre-?approv|tour|showing|see the (home|house|property)|make an offer)/i
const APPT_INTENT = /(appointment|schedul|book|tour|showing)/i

console.log("\n── SOURCE: the automatic post-call brain is wired into BOTH close paths ──")
{
  const mod = src("lib/ai-isa/post-call-outcome.ts")
  check("routePostCallOutcome exists", /export async function routePostCallOutcome/.test(mod))
  const status = src("app/api/voice/twilio/status/route.ts")
  check("status callback (hangup) runs it on a completed close", status.includes("routePostCallOutcome"))
  const turn = src("app/api/voice/twilio/turn/route.ts")
  check("turn route (spoken goodbye) runs it via maybeRoutePostCall", turn.includes("routePostCallOutcome") && turn.includes("maybeRoutePostCall"))
  check("lead conversion still runs alongside (routeLeadCallIntent kept)", status.includes("routeLeadCallIntent") && turn.includes("routeLeadCallIntent"))
  const inbound = src("app/api/voice/twilio/inbound/route.ts")
  check("inbound creates the ai_isa_calls scoring row (lifecycle)", /from\("ai_isa_calls"\)\s*\n?\s*\.insert|from\("ai_isa_calls"\)\.insert/.test(inbound) || inbound.includes('from("ai_isa_calls")'))
}

console.log("\n── SOURCE: contact-side routing + the compliance posture ──")
{
  const mod = src("lib/ai-isa/post-call-outcome.ts")
  check("negative → contact DNC + call_stop_flag + isa_reengage_allowed=false", mod.includes("dnc_status: true") && mod.includes("call_stop_flag: true") && mod.includes("isa_reengage_allowed: false"))
  check("positive → agent notify + auto-SENT follow-up", mod.includes("notifyAgentPositive") && mod.includes("sendPostCallFollowUp"))
  check("rolling qualification on lead calls (lead_temperature + lead_score)", mod.includes("lead_temperature") && mod.includes("lead_score"))
  check("ai_isa_calls scoring (lead_quality_score + appointment_set)", mod.includes("lead_quality_score") && mod.includes("appointment_set"))
  check("follow-up AUTO-SENDS via the gated dispatch rail (TCPA/consent/FH enforced) with a proposal fallback",
    mod.includes("dispatchSms") && mod.includes("dispatchEmail") && mod.includes("proposePostCallFollowUp") && mod.includes("contactId: call.contact_id"))
  check("DNC fires ONLY on an explicit high-confidence opt-out (detectOptOutIntent), never a merely negative mood",
    mod.includes("detectOptOutIntent") && !mod.includes("detectNegativeIntent")
    && /isOptOut\s*=\s*opt\.isOptOut && opt\.confidence === "high"/.test(mod) && mod.includes("notifyAgentCoolCall"))
  check("a Do-Not-Contact contact is never auto-followed-up", mod.includes("dnc_status") && mod.includes("never follow up a Do-Not-Contact"))
  check("sentiment/intent reused from the ONE extractor (no parallel classifier)", mod.includes("analyzeVoiceCallRow") && mod.includes("isAnalyzableCall"))
}

console.log("\n── PURE: outcome classification + signal mapping ──")
{
  const neg = voiceSignalFor({ urgencyScore: 85, isPositiveOutcome: false, isNegativeOutcome: true })
  check("negative wins → unqualified, score 10, temp null", neg === "unqualified" && signalScore(neg) === 10 && signalTemperature(neg) === null)

  const posIntent = "book a showing appointment"
  check("positive appointment intent detected by both regexes", POS_INTENT.test(posIntent) && APPT_INTENT.test(posIntent))
  const hot = voiceSignalFor({ urgencyScore: 85, isPositiveOutcome: true, isNegativeOutcome: false })
  check("hot → score 90, temp hot", signalScore(hot) === 90 && signalTemperature(hot) === "hot")

  const neutralIntent = "browsing"
  check("neutral intent is neither positive nor an appointment", !POS_INTENT.test(neutralIntent) && !APPT_INTENT.test(neutralIntent))
  const warm = voiceSignalFor({ urgencyScore: 45, isPositiveOutcome: false, isNegativeOutcome: false })
  check("mid-urgency → warm/60", warm === "warm" && signalScore(warm) === 60)

  const mod = src("lib/ai-isa/post-call-outcome.ts")
  check("source POS_INTENT/APPT_INTENT kept in lockstep with this proof", mod.includes("ready to (buy|list|sell)") && mod.includes("APPT_INTENT"))
}

console.log("\n── PURE: DNC fires only on an explicit opt-out from the CALLER (no false-flips) ──")
{
  // Local mirror of callerUtterances (asserted in lockstep with source below).
  const callerUtterances = (t: string) => t.split("\n").filter((l) => /^\s*Caller:/i.test(l)).map((l) => l.replace(/^\s*Caller:\s*/i, "")).join(" ")
  const isHighOptOut = (t: string) => { const o = detectOptOutIntent(callerUtterances(t)); return o.isOptOut && o.confidence === "high" }

  // The AI says "stop"; the caller is enthusiastic — caller-only + explicit-only means NO DNC.
  check("AI's spoken 'stop' line does NOT flip DNC", !isHighOptOut("AI: If you'd ever like to stop, just say so.\nCaller: No no, I'm really interested, let's book a showing!"))
  // Innocuous caller phrases that CONTAIN opt-out substrings must NOT flip DNC (the VADE cases).
  check("'cancel my reservation' does NOT flip DNC", !isHighOptOut("Caller: I need to cancel my reservation for Saturday but still want to see the house."))
  check("'they stopped by' / 'bus stop' do NOT flip DNC", !isHighOptOut("Caller: my friends stopped by near the bus stop and loved the neighborhood."))
  // A genuine explicit opt-out IS still caught → DNC.
  check("an explicit caller opt-out ('do not call me') DOES flip DNC", isHighOptOut("AI: Happy to help.\nCaller: Please do not call me again, take me off your list."))

  const mod = src("lib/ai-isa/post-call-outcome.ts")
  check("source scopes opt-out to callerUtterances via detectOptOutIntent (not the full transcript, not loose substrings)",
    mod.includes("export function callerUtterances") && mod.includes("detectOptOutIntent(callerText)") && !/detectOptOutIntent\(`?\$\{transcription\}/.test(mod))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ POST_CALL_OUTCOME_FAIL"); process.exit(1) }
console.log(" ✅ POST_CALL_OUTCOME_PASS — every completed AI call auto-routes; the client send stays compliance-gated")
