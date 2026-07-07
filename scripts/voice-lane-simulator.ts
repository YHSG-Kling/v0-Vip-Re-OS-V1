// scripts/voice-lane-simulator.ts   (npm run test:voice-lane)
// ─────────────────────────────────────────────────────────────────────────────
// TWILIO-NATIVE VOICE LANE — proves the engine swap keeps the brain: the
// reception prompt carries the SAME legal/Fair-Housing rules as the Vapi lane,
// the turn parser never crashes mid-call, transcript↔messages round-trips, the
// TwiML is well-formed, and the Twilio signature validates correctly.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildReceptionPrompt, parseTurnPlan, transcriptToMessages, appendTranscript,
  twimlGatherTurn, twimlTransfer, twimlHangup, TURN_INSTRUCTIONS,
} from "../lib/voice/reception-brain"
import { computeTwilioSignature, validateTwilioSignature } from "../lib/voice/twilio-voice"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const check = (n: string, ok: boolean, d?: string) => { if (ok) { passed++; console.log(`  ✓ ${n}`) } else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: the shared reception brain ──")
{
  const r = buildReceptionPrompt({
    assistantName: "Ava", welcomeMessage: null, tone: "warm",
    brokerageName: "VIP Premier", agentName: "Dana Kling",
    prohibitedLanguage: ["guaranteed sale"], elevenlabsVoiceId: null, forwardNumber: "+15551234567",
    answerMode: "after_hours", businessHours: { timezone: "America/Chicago", start: "09:00", end: "18:00", days: [1,2,3,4,5] },
  })
  check("identity in prompt + first message", r.name === "Ava" && r.firstMessage.includes("Dana Kling") && r.systemPrompt.includes("VIP Premier"))
  check("SAME legal preamble as Vapi lane: AI disclosure + recording announced", /\bAI\b/i.test(r.firstMessage) && /recorded/i.test(r.firstMessage))
  check("SAME hard rules: no legal/lending advice + Fair Housing + no invented prices",
    /Never give legal, lending, or tax advice/.test(r.systemPrompt) && /Fair Housing/.test(r.systemPrompt) && /Never invent property details/.test(r.systemPrompt))
  check("honest-confession + prohibited phrases + hour-aware rule threaded",
    r.systemPrompt.includes("confirm honestly and immediately") && r.systemPrompt.includes("guaranteed sale") && r.systemPrompt.includes("OFFICE HOURS"))
}

console.log("\n── PURE: turn planning (never crashes mid-call) ──")
{
  check("clean continue", (() => { const p = parseTurnPlan('{"say":"How can I help?","action":"continue"}'); return p.say.includes("help") && p.action.kind === "say" })())
  check("transfer parsed", parseTurnPlan('{"say":"Connecting you now.","action":"transfer"}').action.kind === "transfer")
  const book = parseTurnPlan('{"say":"Booked!","action":"book","date_time":"2026-07-10T15:00:00Z"}')
  check("book requires a valid ISO date_time (normalized)", book.action.kind === "book" && new Date((book.action as any).dateTime).getTime() === new Date("2026-07-10T15:00:00Z").getTime())
  check("book with a bad date degrades to continue (never books garbage)", parseTurnPlan('{"say":"ok","action":"book","date_time":"whenever"}').action.kind === "say")
  check("hangup parsed", parseTurnPlan('{"say":"Take care!","action":"hangup"}').action.kind === "hangup")
  check("malformed JSON → safe clarifier, action continue (no mid-call crash)",
    (() => { const p = parseTurnPlan("the model rambled without json"); return p.action.kind === "say" && p.say.includes("say that once more") })())
  check("empty say → safe fallback", parseTurnPlan('{"action":"continue"}').say.length > 0)
  check("TURN_INSTRUCTIONS pin the JSON contract", TURN_INSTRUCTIONS.includes('"action"') && TURN_INSTRUCTIONS.includes("book"))
}

console.log("\n── PURE: transcript is the serverless session ──")
{
  const t1 = appendTranscript(null, null, "Hi, this is Ava.")
  const t2 = appendTranscript(t1, "I want to see 12 Oak St", "Great — when works for you?")
  const msgs = transcriptToMessages(t2)
  check("transcript rebuilds to alternating messages", msgs.length === 3 && msgs[0].role === "assistant" && msgs[1].role === "user" && msgs[1].content.includes("12 Oak St"))
  check("history capped for long calls", transcriptToMessages(Array.from({ length: 60 }, (_, i) => `${i % 2 ? "Caller" : "AI"}: line ${i}`).join("\n")).length <= 24)
}

console.log("\n── PURE: TwiML well-formed + XML-safe ──")
{
  const g = twimlGatherTurn('Say "hi" & <smile>', "https://app.example/api/voice/twilio/turn")
  check("gather: Response+Gather+Say, speech input, action url", g.includes("<Response>") && g.includes('<Gather input="speech"') && g.includes("/api/voice/twilio/turn"))
  check("gather escapes XML-special chars (no injection)", g.includes("&quot;hi&quot;") && g.includes("&amp;") && g.includes("&lt;smile&gt;") && !g.includes("<smile>"))
  check("transfer dials the human", twimlTransfer("One moment.", "+15551234567").includes("<Dial>+15551234567</Dial>"))
  check("hangup ends the call", twimlHangup("Bye!").includes("<Hangup/>"))
}

console.log("\n── PURE: Twilio signature ──")
{
  const token = "sim_auth_token"
  const url = "https://app.example/api/voice/twilio/inbound"
  const params = { To: "+15550001111", From: "+15552223333", CallSid: "CA123" }
  const sig = computeTwilioSignature(token, url, params)
  check("valid signature accepted", validateTwilioSignature(token, url, params, sig))
  check("tampered params rejected", !validateTwilioSignature(token, url, { ...params, From: "+19998887777" }, sig))
  check("wrong token rejected", !validateTwilioSignature("other_token", url, params, sig))
  check("missing signature rejected", !validateTwilioSignature(token, url, params, null))
}

console.log("\n── SOURCE: wiring ──")
{
  const inbound = src("app/api/voice/twilio/inbound/route.ts")
  check("inbound: signature-validated + opens the SHARED voice_calls ledger + speaks the legal preamble",
    inbound.includes("validateTwilioSignature") && inbound.includes('from("voice_calls")') && inbound.includes("buildReceptionPrompt"))
  check("inbound: caller becomes a consented contact (calling in IS consent)", inbound.includes("captureContact") && inbound.includes('source: "inbound_call"'))
  const turn = src("app/api/voice/twilio/turn/route.ts")
  check("turn: book → real scheduled showing on the SAME rails; transfer → Dial; hangup → complete",
    turn.includes('from("showings")') && turn.includes("twimlTransfer") && turn.includes("finishCall"))
  const binding = src("lib/voice/vapi-numbers.ts")
  check("binding DEFAULTS to the Twilio lane; VOICE_ENGINE=vapi is legacy-only",
    binding.includes('process.env.VOICE_ENGINE === "vapi" ? "vapi" : "twilio"') && binding.includes("bindNumberToTwilioLane"))
  const bind = src("lib/voice/twilio-voice.ts")
  check("bind sets VoiceUrl via the TENANT's creds — no vendor assistant object",
    bind.includes("VoiceUrl") && bind.includes("resolveTenantTwilioCreds") && bind.includes("IncomingPhoneNumbers/"))
  const matrix = src("lib/providers/tenancy-matrix.ts")
  check("matrix: vapi = LEGACY, twilio-native default (no new vapi)", matrix.includes("LEGACY voice lane") && matrix.includes("VOICE_ENGINE=vapi"))
  check("registry burn domain twilio_voice_lane (ai_isa)",
    "twilio_voice_lane" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.twilio_voice_lane.manager === "ai_isa")
  check("rentcast MCP fixes: rental long-term path + range params", src("lib/property/rentcast.ts").includes("/listings/rental/long-term") && src("lib/property/rentcast.ts").includes("MCP-verified contract"))
  check("package.json wires the proof", /"test:voice-lane":/.test(src("package.json")))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ VOICE_LANE_FAIL"); process.exit(1) }
console.log(" ✅ VOICE_LANE_PASS — conversational reception on pure Twilio; the brain is engine-agnostic, the legal shield intact")
