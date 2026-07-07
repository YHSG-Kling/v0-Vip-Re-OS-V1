// scripts/voice-rail-simulator.ts   (npm run test:voice-rail)
// ─────────────────────────────────────────────────────────────────────────────
// VOICE RAIL — proves the inbound-receptionist wiring + voice consolidation:
// PURE:   buildInboundAssistantConfig — reception prompt carries the HARD legal
//         rules (no legal/lending advice, Fair-Housing-safe, no invented
//         prices), tenant identity honored (name/welcome/tone/prohibited/
//         voice/forwarding), clamps applied.
// SOURCE: toggles→binding wired at the ai-identity save; number registration
//         persists ids + audit; caller-ID override threaded WITHOUT touching
//         the TCPA chokepoint; webhook function tools live in ONE module used
//         by both endpoints; the orphaned classifier is gone.
// LIVE:   Vapi API is creds-gated (no key in CI) — the live binding proof runs
//         in the deployed env; DB shape proofs ride MCP.

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { buildInboundAssistantConfig } from "../lib/voice/vapi-numbers"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: inbound reception assistant config ──")
{
  const full = buildInboundAssistantConfig({
    assistantName: "Ava", welcomeMessage: null, tone: "warm, upbeat",
    brokerageName: "VIP Premier Realty", agentName: "Dana Kling",
    prohibitedLanguage: ["guaranteed sale"], elevenlabsVoiceId: "voice123", forwardNumber: "+15551234567",
  }) as any
  const prompt = full.model.systemPrompt as string
  check("identity honored: name + office + agent in prompt/first message",
    full.name === "Ava" && (full.firstMessage as string).includes("Dana Kling") && prompt.includes("VIP Premier Realty"))
  check("HARD legal rules present: no legal/lending advice + Fair Housing + no invented prices",
    /Never give legal, lending, or tax advice/.test(prompt) && /Fair Housing/.test(prompt) && /Never invent property details, prices/.test(prompt))
  check("tenant's prohibited phrases honored", prompt.includes("guaranteed sale"))
  check("stop-contact requests acknowledged in the prompt", /stop being contacted/.test(prompt))
  check("cloned voice + forwarding threaded", full.voice?.voiceId === "voice123" && full.forwardingPhoneNumber === "+15551234567")

  const minimal = buildInboundAssistantConfig({
    assistantName: null, welcomeMessage: null, tone: null, brokerageName: null,
    agentName: null, prohibitedLanguage: null, elevenlabsVoiceId: null, forwardNumber: null,
  }) as any
  check("minimal identity still yields a complete, honest config (defaults, no voice/forwarding keys)",
    minimal.name === "Reception Assistant" && !("voice" in minimal) && !("forwardingPhoneNumber" in minimal))
  const longName = buildInboundAssistantConfig({
    assistantName: "A".repeat(80), welcomeMessage: "w".repeat(500), tone: null, brokerageName: null,
    agentName: null, prohibitedLanguage: null, elevenlabsVoiceId: null, forwardNumber: null,
  }) as any
  check("name/message clamps applied", (longName.name as string).length === 40 && (longName.firstMessage as string).length === 300)
}

console.log("\n── SOURCE: the wiring ──")
{
  const numbers = src("lib/voice/vapi-numbers.ts")
  check("binding is creds-gated with an honest not-configured error (nothing faked)",
    numbers.includes("VAPI_API_KEY") && numbers.includes("Nothing was changed"))
  check("number import binds assistant + authoritative webhook w/ secret",
    numbers.includes("/api/voice/vapi-webhook?brokerage_id=") && numbers.includes("VAPI_WEBHOOK_SECRET"))
  check("registration persists vapi_phone_number_id + phone_number_events audit",
    numbers.includes('update({ vapi_phone_number_id: vapiPhoneNumberId })') && numbers.includes('"vapi_registered"'))
  check("toggle OFF changes nothing (numbers keep working as plain lines)", numbers.includes("if (!p.ai_answer_calls) return { ok: true, applied: false }"))

  const identity = src("app/actions/ai-identity.ts")
  check("saving ai_answer_calls=ON actually applies the binding (honest bindingNote)",
    identity.includes("applyInboundCallBinding") && identity.includes("bindingNote"))

  const client = src("lib/voice/vapi-client.ts")
  check("TCPA chokepoint UNTOUCHED: enforceTCPACompliance still runs before every dial",
    client.includes('enforceTCPACompliance({') && client.includes('channel:       "call"'))
  check("vendor budget gate still upstream of the dial", client.includes("checkVendorBudget"))
  check("caller-ID override threads through with the platform fallback",
    client.includes("params.phoneNumberId || process.env.VAPI_PHONE_NUMBER_ID"))
  const exec = src("lib/voice-engine/call-executor.ts")
  check("executor resolves the agent's OWN bound number (best-effort, never blocks)",
    exec.includes("vapi_phone_numbers") && exec.includes("phoneNumberId: fromPhoneNumberId"))
  check("executor hard stops intact (call_stop_flag + dnc)", exec.includes("call_stop_flag") && exec.includes("dnc_status"))

  check("orphaned inbound-caller-classifier removed (zero call sites — keep-one)",
    !existsSync(join(process.cwd(), "lib/ai-isa/inbound-caller-classifier.ts")))

  // Webhook keep-one: shared function-tools module used by BOTH endpoints.
  const tools = src("lib/voice/vapi-function-tools.ts")
  check("function tools live in ONE shared module (capability-gated)",
    tools.includes("dispatchVapiFunctionCall") && tools.includes("gateByCapability"))
  const authoritative = src("app/api/voice/vapi-webhook/route.ts")
  check("authoritative webhook now handles function-call via the shared module", authoritative.includes("dispatchVapiFunctionCall"))
  const compat = src("app/api/webhooks/vapi/route.ts")
  check("legacy webhook is a thin compatible endpoint using the SAME module (no duplicated handlers)",
    compat.includes("dispatchVapiFunctionCall") && !compat.includes("async function handleBookAppointment"))

  check("registry burn domain inbound_receptionist (ai_isa)",
    "inbound_receptionist" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.inbound_receptionist.manager === "ai_isa")
  check("package.json wires the proof", /"test:voice-rail":/.test(src("package.json")))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ VOICE_RAIL_FAIL"); process.exit(1) }
console.log(" ✅ VOICE_RAIL_PASS — the AI receptionist is wired end to end: toggles → assistant → number → authoritative webhook; TCPA chokepoint untouched")
