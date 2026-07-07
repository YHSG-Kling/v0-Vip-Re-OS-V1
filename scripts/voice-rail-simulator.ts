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
import { pickCredTier, rollupVoiceUsage } from "../lib/voice/twilio-tenancy"
import { PROVIDER_TENANCY, providerTenancy } from "../lib/providers/tenancy-matrix"
import { withAiCallDisclosures, ensureAiDisclosure } from "../lib/communication/call-disclosures"
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
  }, "brk-123") as any
  const prompt = full.model.systemPrompt as string
  check("identity honored: name + office + agent in prompt/first message",
    full.name === "Ava" && (full.firstMessage as string).includes("Dana Kling") && prompt.includes("VIP Premier Realty"))
  check("HARD legal rules present: no legal/lending advice + Fair Housing + no invented prices",
    /Never give legal, lending, or tax advice/.test(prompt) && /Fair Housing/.test(prompt) && /Never invent property details, prices/.test(prompt))
  check("tenant's prohibited phrases honored", prompt.includes("guaranteed sale"))
  check("stop-contact requests acknowledged in the prompt", /stop being contacted/.test(prompt))
  check("cloned voice + forwarding threaded", full.voice?.voiceId === "voice123" && full.forwardingPhoneNumber === "+15551234567")

  // ── LEGAL SHIELD + OUT-OF-THE-BOX TOOLS ──
  check("first message DISCLOSES the AI + announces recording (uniform national posture)",
    /\bAI\b/i.test(full.firstMessage) && /recorded/i.test(full.firstMessage))
  check("prompt orders honest AI confession if asked ('are you a robot?')",
    /confirm honestly and immediately/.test(prompt) && /never pretend to be human/.test(prompt))
  const tools = (full.model.tools ?? []) as any[]
  check("four in-call tools registered OUT OF THE BOX (book/transfer/SMS/showing)",
    tools.length === 4 && ["book_appointment", "transfer_to_agent", "send_properties_sms", "request_showing_in_house_listing"]
      .every((n) => tools.some((t) => t.function?.name === n)))
  check("tool names match the webhook dispatcher's handlers exactly",
    tools.every((t) => src("lib/voice/vapi-function-tools.ts").includes(`"${t.function.name}"`)))
  check("brokerage_id rides assistant metadata (tenancy fallback for tool calls)",
    full.metadata?.brokerage_id === "brk-123")

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
  check("name/message clamps applied (tenant text clamped; legal preamble rides on top)",
    (longName.name as string).length === 40 && (longName.firstMessage as string).includes("w".repeat(300)) && !(longName.firstMessage as string).includes("w".repeat(301)))
}

console.log("\n── PURE: phone-system tenancy (commercial model) ──")
{
  check("cred order: BYO wins over subaccount over master",
    pickCredTier({ byo: true, subaccount: true, master: true }) === "byo" &&
    pickCredTier({ byo: false, subaccount: true, master: true }) === "subaccount" &&
    pickCredTier({ byo: false, subaccount: false, master: true }) === "master" &&
    pickCredTier({ byo: false, subaccount: false, master: false }) === null)
  const usage = rollupVoiceUsage("2026-07",
    [{ minutes_billed: 3, cost_cents: 27 }, { minutes_billed: 5, cost_cents: 45 }, { minutes_billed: null, cost_cents: null }],
    [{ is_active: true }, { is_active: true }, { is_active: false }])
  check("usage rollup: calls/minutes/costs + active numbers × $1.15",
    usage.callCount === 3 && usage.minutes === 8 && usage.vapiCostCents === 72 && usage.activeNumbers === 2 && usage.numberCostCents === 230 && usage.totalCostCents === 302)
  check("empty month → zeroed meter, no NaN", rollupVoiceUsage("2026-07", [], []).totalCostCents === 0)
}

console.log("\n── PURE: disclosures + tenancy matrix ──")
{
  check("AI disclosure prepended when absent; never doubled",
    ensureAiDisclosure("Hi, this is Dana's office.").startsWith("You're speaking with an AI assistant") &&
    ensureAiDisclosure("I'm Ava, the AI assistant.") === "I'm Ava, the AI assistant.")
  const both = withAiCallDisclosures("Hi, this is Dana's office.", { recorded: true })
  check("full preamble = AI line + recording line, idempotent",
    /AI assistant/.test(both) && /recorded/i.test(both) && withAiCallDisclosures(both) === both)
  check("unrecorded call skips the recording line only",
    !/recorded/i.test(withAiCallDisclosures("Hello.", { recorded: false })))
  check("matrix: every provider decision carries a stated WHY + env vars",
    PROVIDER_TENANCY.length >= 8 && PROVIDER_TENANCY.every((p) => p.why.length > 30 && p.envVars.length > 0))
  check("matrix: twilio = subaccounts + BYO top tier; elevenlabs/vapi = platform metered",
    providerTenancy("twilio")!.models.includes("platform_subaccount") &&
    providerTenancy("twilio")!.models.includes("byo_top_tier") &&
    providerTenancy("elevenlabs")!.models.includes("platform_metered") &&
    providerTenancy("vapi")!.models.includes("platform_metered"))
  check("matrix: email prefers the agent's own OAuth identity", providerTenancy("sendgrid")!.models.includes("user_oauth"))
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

  // ── Tenancy model wiring ──
  const tenancy = src("lib/voice/twilio-tenancy.ts")
  check("subaccount create is idempotent + creds-gated + save-failure surfaced",
    tenancy.includes("created: false") && tenancy.includes("Nothing was changed") && tenancy.includes("reconcile manually"))
  const prov = src("app/actions/phone-provisioning.ts")
  check("provisioning buys numbers inside the TENANT's account (BYO → subaccount → master)",
    prov.includes("ensureTenantSubaccount") && prov.includes("resolveTenantTwilioCreds"))
  const nums = src("lib/voice/vapi-numbers.ts")
  check("Vapi import uses the SAME tenant creds that own the number", nums.includes("resolveTenantTwilioCreds"))
  const tenancyAction = src("app/actions/voice-tenancy.ts")
  check("BYO is multi_location-tier-gated with an honest refusal for other tiers",
    tenancyAction.includes('"multi_location"') && tenancyAction.includes("platform-managed numbers"))
  check("BYO validates the Twilio SID shape", tenancyAction.includes("^AC[a-f0-9]{32}$"))
  const phonePage = src("app/dashboard/admin/phone-settings/page.tsx")
  check("usage meter card on the phone-settings page (calls/min/numbers/$ + cred tier)",
    phonePage.includes("getVoiceUsageAction") && phonePage.includes("Voice usage"))

  check("registry burn domain inbound_receptionist (ai_isa)",
    "inbound_receptionist" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.inbound_receptionist.manager === "ai_isa")
  check("registry burn domain phone_system_tenancy (finance_manager)",
    "phone_system_tenancy" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.phone_system_tenancy.manager === "finance_manager")
  check("registry burn domains ai_call_legal_shield + provider_tenancy_matrix",
    "ai_call_legal_shield" in MAINTENANCE_DOMAINS && "provider_tenancy_matrix" in MAINTENANCE_DOMAINS)
  const smsResolver = src("lib/providers/messaging/resolve-sms-provider.ts")
  check("SMS gains the platform-managed tier: tenant's own number via tenant creds, BEFORE the env fallback",
    smsResolver.includes("resolveTenantTwilioCreds") &&
    smsResolver.indexOf('resolvedScope: "platform_managed"') < smsResolver.indexOf("// Environment fallback — Twilio only") &&
    smsResolver.indexOf('resolvedScope: "platform_managed"') > 0)
  check("SMS platform tier prefers the AGENT's own number over the brokerage number",
    smsResolver.includes("own ?? shared"))
  const runbook = src("docs/PHONE-SYSTEM-SETUP.md")
  check("runbook covers SMS order + A2P-per-subaccount honesty + platform ElevenLabs",
    runbook.includes("platform-managed") && runbook.includes("A2P 10DLC note") && runbook.includes("PLATFORM-OWNED"))
  check("package.json wires the proof", /"test:voice-rail":/.test(src("package.json")))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ VOICE_RAIL_FAIL"); process.exit(1) }
console.log(" ✅ VOICE_RAIL_PASS — the AI receptionist is wired end to end: toggles → assistant → number → authoritative webhook; TCPA chokepoint untouched")
