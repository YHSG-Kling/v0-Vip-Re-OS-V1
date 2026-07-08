// scripts/voice-lane-simulator.ts   (npm run test:voice-lane)
// ─────────────────────────────────────────────────────────────────────────────
// TWILIO-NATIVE VOICE LANE — proves the engine swap keeps the brain: the
// reception prompt carries the SAME legal/Fair-Housing rules as the Vapi lane,
// the turn parser never crashes mid-call, transcript↔messages round-trips, the
// TwiML is well-formed, and the Twilio signature validates correctly.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildReceptionPrompt, buildOutboundPrompt, parseTurnPlan, transcriptToMessages, appendTranscript,
  twimlGatherTurn, twimlTransfer, twimlHangup, TURN_INSTRUCTIONS,
} from "../lib/voice/reception-brain"
import { encodeOutboundBrief, decodeOutboundBrief, composeVoicemailMessage } from "../lib/voice/twilio-outbound"
import { relayConfigured, twimlConnectRelay, parseRelayFrame, relaySpeak, relayEnd, parseRelayPlanRequest } from "../lib/voice/conversation-relay"
import { validateA2pProfile, nextA2pStep, describeA2pState } from "../lib/voice/a2p-registration"
import { rollupVoiceActivity, composeVoiceActivityBrief } from "../lib/kernel/call-intelligence"
import { computeTwilioSignature, validateTwilioSignature } from "../lib/voice/twilio-voice"
import {
  isPlatformNumber, composeTierLines, buildPlatformReceptionPrompt, parsePlatformTurnPlan, PLATFORM_TURN_INSTRUCTIONS,
} from "../lib/voice/platform-reception"
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

console.log("\n── PURE: the OUTBOUND lane (ISA calls off Vapi) ──")
{
  const identity = {
    assistantName: "Ava", welcomeMessage: null, tone: "warm",
    brokerageName: "VIP Premier", agentName: "Dana Kling",
    prohibitedLanguage: ["guaranteed sale"], elevenlabsVoiceId: null, forwardNumber: null,
    answerMode: null, businessHours: null,
  }
  const p = buildOutboundPrompt(identity, { objective: "Follow up on their showing request for 12 Oak St.", contactName: "Jordan" })
  check("outbound opener: personalized + SAME legal preamble (AI disclosure + recording)",
    p.firstMessage.includes("Jordan") && /\bAI\b/i.test(p.firstMessage) && /recorded/i.test(p.firstMessage))
  check("objective threaded; outbound-specific rules: instant opt-out honor + zero pressure",
    p.systemPrompt.includes("12 Oak St") && p.systemPrompt.includes("stop calling") && p.systemPrompt.includes("never pressure"))
  check("SAME hard rules on outbound: Fair Housing + no invented prices + prohibited phrases + honest-AI confession",
    p.systemPrompt.includes("Fair Housing") && p.systemPrompt.includes("Never invent property details") && p.systemPrompt.includes("guaranteed sale") && p.systemPrompt.includes("confirm honestly and immediately"))

  const brief = { engine: "twilio" as const, objective: "Re-engage a cold buyer lead.", contactName: "Sam", firstMessage: null, systemPrompt: "PERSONA: speak like Dana." }
  const decoded = decodeOutboundBrief(encodeOutboundBrief(brief))
  check("call brief round-trips through ai_notes (the row IS the session)",
    decoded !== null && decoded.objective === brief.objective && decoded.systemPrompt === "PERSONA: speak like Dana.")
  check("legacy/foreign ai_notes decode to null (reception fallback, never a crash)",
    decodeOutboundBrief("engine:twilio") === null && decodeOutboundBrief(null) === null && decodeOutboundBrief('{"engine":"vapi"}') === null)
  const vm = composeVoicemailMessage(brief, "VIP Premier")
  check("machine answer → HONEST voicemail: identifies the AI + office, capped",
    /\bAI\b/i.test(vm) && vm.includes("VIP Premier") && vm.length <= 450)
}

console.log("\n── PURE: the PLATFORM scope (the app's own line) ──")
{
  check("platform number matched by digits, any formatting", isPlatformNumber("+1 (555) 000-1111", "+15550001111") && !isPlatformNumber("+15559998888", "+15550001111") && !isPlatformNumber("", "+15550001111") && !isPlatformNumber("+15550001111", ""))
  const lines = composeTierLines([
    { display_name: "Solo", monthly_price_cents: 9900, max_agents: 1, is_active: true },
    { display_name: "Brokerage", monthly_price_cents: 79900, max_agents: 50, is_active: true },
    { display_name: "Old", monthly_price_cents: 100, is_active: false },
  ])
  check("tier lines from LIVE plan rows: cents→dollars, seats, inactive excluded",
    lines.length === 2 && lines[0].includes("$99 per month") && lines[1].includes("$799 per month") && lines[1].includes("up to 50 agents"))
  check("zero tiers → honest 'team will follow up', never an invented price",
    composeTierLines([])[0].includes("Never invent a price"))

  const p = buildPlatformReceptionPrompt({ brandName: "VIP Agents", tagline: "The AI team", tierLines: lines, hasTransfer: false })
  check("SAME legal preamble: AI disclosure + recording announced on the platform line", /\bAI\b/i.test(p.firstMessage) && /recorded/i.test(p.firstMessage))
  check("brand + LIVE pricing threaded; honest-selling hard rules", p.systemPrompt.includes("VIP Agents") && p.systemPrompt.includes("$799 per month") && p.systemPrompt.includes("Never invent pricing") && p.systemPrompt.includes("confirm honestly and immediately"))
  check("no forward number → the prompt FORBIDS claiming a transfer", p.systemPrompt.includes("Never claim you can transfer"))
  check("forward number configured → transfer offered", buildPlatformReceptionPrompt({ brandName: "X", tagline: "t", tierLines: [], hasTransfer: true }).systemPrompt.includes("action 'transfer'"))

  const pr = parsePlatformTurnPlan('{"say":"Got it — the team will reach out.","action":"prospect","name":"Dana","email":"dana@broker.com","company":"Kling Group","role_interest":"brokerage","note":"Wants a demo"}')
  check("prospect action parsed with contact fields", pr.action.kind === "prospect" && (pr.action as any).name === "Dana" && (pr.action as any).email === "dana@broker.com" && (pr.action as any).roleInterest === "brokerage")
  const bad = parsePlatformTurnPlan('{"say":"ok","action":"prospect","email":"not-an-email","role_interest":"ceo"}')
  check("garbage email DROPPED (not stored) + unknown role normalized to the funnel CHECK list",
    bad.action.kind === "prospect" && (bad.action as any).email === null && (bad.action as any).roleInterest === "unknown")
  check("platform transfer/hangup/malformed all safe",
    parsePlatformTurnPlan('{"say":"Connecting.","action":"transfer"}').action.kind === "transfer"
    && parsePlatformTurnPlan('{"say":"Bye!","action":"hangup"}').action.kind === "hangup"
    && parsePlatformTurnPlan("no json here").action.kind === "say")
  check("PLATFORM_TURN_INSTRUCTIONS pin the prospect contract (caller ID already captured)",
    PLATFORM_TURN_INSTRUCTIONS.includes('"prospect"') && PLATFORM_TURN_INSTRUCTIONS.includes("caller ID"))
}

console.log("\n── PURE: ConversationRelay (the streaming transport) ──")
{
  check("relay is a SWITCH, never a stub: unconfigured env → Gather lane", !relayConfigured({}) && !relayConfigured({ CONVERSATION_RELAY_WSS_URL: "https://not-wss" as any, RELAY_SHARED_SECRET: "x" }) && relayConfigured({ CONVERSATION_RELAY_WSS_URL: "wss://relay.example/relay", RELAY_SHARED_SECRET: "s" }))
  const tw = twimlConnectRelay("wss://relay.example/relay", 'Hi — I\'m an AI & this call is recorded <ok>')
  check("relay TwiML: Connect+ConversationRelay, greeting XML-escaped (the SAME disclosed opener)",
    tw.includes("<Connect><ConversationRelay") && tw.includes("wss://relay.example/relay") && tw.includes("&amp;") && tw.includes("&lt;ok&gt;") && /welcomeGreeting=/.test(tw))
  check("frame parser: setup/prompt parsed; malformed → unknown (never a crash mid-call)",
    parseRelayFrame('{"type":"setup","callSid":"CA1","from":"+1555","to":"+1666"}').type === "setup"
    && (parseRelayFrame('{"type":"prompt","voicePrompt":"hi","last":true}') as any).voicePrompt === "hi"
    && parseRelayFrame("not json").type === "unknown" && parseRelayFrame('{"type":"???"}').type === "unknown")
  check("speak/end frames match Twilio's contract", JSON.parse(relaySpeak("Hello")).type === "text" && JSON.parse(relaySpeak("Hello")).last === true && JSON.parse(relayEnd()).type === "end")
  check("plan-request validation rejects partial bodies", parseRelayPlanRequest({ callSid: "CA1", to: "+1", from: "+2", utterance: "hi" }) !== null
    && parseRelayPlanRequest({ callSid: "", to: "+1", from: "+2", utterance: "hi" }) === null && parseRelayPlanRequest(null) === null)
}

console.log("\n── PURE: A2P 10DLC step machine ──")
{
  const bad = validateA2pProfile({ legalName: "Kling Realty", ein: "12-34567" })
  check("profile validation: honest missing list + EIN must be 9 digits", !bad.ok && (bad as any).missing.includes("Business website") && (bad as any).missing.some((m: string) => m.includes("9 digits")))
  const good = validateA2pProfile({
    legalName: "Kling Realty LLC", ein: "12-3456789", website: "https://kling.example",
    street: "1 Main St", city: "Austin", region: "TX", postalCode: "78701",
    contactFirstName: "D", contactLastName: "K", contactEmail: "d@kling.example", contactPhone: "+15125550100",
  })
  check("complete profile normalizes (EIN digits-only, default use-case supplied)", good.ok && (good as any).value.ein === "123456789" && (good as any).value.useCaseDescription.length > 10)
  check("step machine resumes in order and finishes",
    nextA2pStep({}) === "customer_profile"
    && nextA2pStep({ customer_profile_sid: "BU1" }) === "trust_product"
    && nextA2pStep({ customer_profile_sid: "BU1", trust_product_sid: "BU2", brand_sid: "BN1" }) === "messaging_service"
    && nextA2pStep({ customer_profile_sid: "BU1", trust_product_sid: "BU2", brand_sid: "BN1", messaging_service_sid: "MG1", number_attached: true, campaign_sid: "QE1" }) === "done")
  check("status lines honest: pending review vs FAILED verbatim",
    describeA2pState({ customer_profile_sid: "BU1", trust_product_sid: "BU2", brand_sid: "BN1", messaging_service_sid: "MG1", number_attached: true, campaign_sid: "QE1", campaign_status: "PENDING" }).includes("under carrier review")
    && describeA2pState({ customer_profile_sid: "BU1", trust_product_sid: "BU2", brand_sid: "BN1", messaging_service_sid: "MG1", number_attached: true, campaign_sid: "QE1", campaign_status: "FAILED", last_error: "brand mismatch" }).includes("brand mismatch"))
}

console.log("\n── PURE: voice-lane activity → the Monday brief ──")
{
  const v = rollupVoiceActivity([
    { direction: "inbound", call_type: "vapi_inbound", status: "completed", outcome: "completed" },
    { direction: "inbound", call_type: "vapi_inbound", status: "completed", outcome: "completed" },
    { direction: "outbound", call_type: "ai_isa_call", status: "completed", outcome: "completed" },
    { direction: "outbound", call_type: "ai_isa_call", status: "completed", outcome: "voicemail" },
    { direction: "outbound", call_type: "ai_isa_call", status: "completed", outcome: "no_answer" },
    { direction: "outbound", call_type: "ai_isa_call", status: "completed", outcome: "opt_out" },
  ], 1)
  check("activity fold: answered/connected/voicemail counted; no-answer excluded; opt-out separated",
    v.inboundAnswered === 2 && v.outboundConnected === 1 && v.voicemailsLeft === 1 && v.optOutsHonored === 1 && v.aiBookings === 1)
  const brief = composeVoiceActivityBrief(v)
  check("brief speaks the work + the compliance (opt-outs stated plainly)",
    brief.includes("answered 2 inbound calls") && brief.includes("booked 1 appointment") && brief.includes("honored and recorded"))
  check("silent week → empty string (the brief never pads)", composeVoiceActivityBrief(rollupVoiceActivity([], 0)) === "")
}

console.log("\n── SOURCE: wiring ──")
{
  const inbound = src("app/api/voice/twilio/inbound/route.ts")
  check("inbound: signature-validated + opens the SHARED voice_calls ledger + speaks the legal preamble",
    inbound.includes("validateTwilioSignature") && inbound.includes('from("voice_calls")') && inbound.includes("buildReceptionPrompt"))
  check("inbound: caller becomes a consented contact (calling in IS consent)", inbound.includes("captureContact") && inbound.includes('source: "inbound_call"'))
  const turn = src("app/api/voice/twilio/turn/route.ts")
  check("turn: book → real scheduled showing on the SAME rails (via the shared bookShowingFromCall); transfer → Dial; hangup → complete",
    turn.includes("bookShowingFromCall") && turn.includes("twimlTransfer") && turn.includes("finishCall")
    && src("lib/voice/twilio-voice.ts").includes('from("showings")'))
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
  check("PLATFORM scope: inbound + turn routes branch by the platform's own number; ledger is platform_reception_calls",
    inbound.includes("isPlatformNumber") && inbound.includes('from("platform_reception_calls")')
    && turn.includes("isPlatformNumber") && turn.includes("finishPlatformCall"))
  check("PLATFORM scope: prospect hand-raise lands in the EXISTING growth funnel (capturePhoneProspect → platform_prospects)",
    turn.includes("capturePhoneProspect") && src("lib/voice/platform-reception.ts").includes('from("platform_prospects")')
    && src("lib/voice/platform-reception.ts").includes('"phone:reception"'))
  check("PLATFORM scope: nothing about the product hardcoded — brand from platform_settings, pricing from subscription_tiers",
    src("lib/voice/platform-reception.ts").includes("loadProductBrand") && src("lib/voice/platform-reception.ts").includes('from("subscription_tiers")'))
  check("PLATFORM bind action: providers-gated + audited, master account, VoiceUrl → the shared inbound webhook",
    (() => { const a = src("app/actions/superadmin/platform-reception.ts"); return a.includes('platformStaffCan(role, "providers")') && a.includes("VoiceUrl") && a.includes("superadmin_audit_log") })())
  check("registry burn domain platform_reception (data_steward)",
    "platform_reception" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.platform_reception.manager === "data_steward")

  // ── OUTBOUND lane wiring ──
  const outboundLib = src("lib/voice/twilio-outbound.ts")
  check("OUTBOUND: TCPA chokepoint + budget gate run BEFORE the Twilio dial (fails closed)",
    outboundLib.indexOf("enforceTCPACompliance") < outboundLib.indexOf("callConnector")
    && outboundLib.includes("checkVendorBudget") && outboundLib.includes('estimatePlatformVendorCost("twilio_voice"'))
  check("OUTBOUND: machine detection + status callback registered at dial time",
    outboundLib.includes('MachineDetection: "Enable"') && outboundLib.includes("/api/voice/twilio/status"))
  const outboundRoute = src("app/api/voice/twilio/outbound/route.ts")
  check("OUTBOUND answer webhook: signature-validated; machine → HONEST voicemail + ledger closed; human → the shared turn loop",
    outboundRoute.includes("validateTwilioSignature") && outboundRoute.includes("composeVoicemailMessage") && outboundRoute.includes("twimlGatherTurn"))
  check("turn route serves BOTH directions (outbound resolves the tenant by OUR From number) + deterministic opt-out honor via the canonical writer",
    turn.includes("outboundLeg") && turn.includes("detectOptOutIntent") && turn.includes("processOptOut") && turn.includes('"inbound_call"'))
  const statusRoute = src("app/api/voice/twilio/status/route.ts")
  check("status callback closes BOTH ledgers (voice_calls + platform_reception_calls) — no in_progress-forever rows",
    statusRoute.includes('from("voice_calls")') && statusRoute.includes('from("platform_reception_calls")') && statusRoute.includes("validateTwilioSignature"))
  check("callers default to the Twilio lane (VOICE_ENGINE=vapi legacy-only): call-executor + AI-ISA",
    src("lib/voice-engine/call-executor.ts").includes("placeOutboundAiCall") && src("lib/application/ai-isa.ts").includes("placeOutboundAiCall"))

  // ── INBOUND SMS → unified inbox wiring ──
  const smsLib = src("lib/voice/sms-inbound.ts")
  check("SMS: lands in the UNIFIED INBOX messages row (unread) + agent heads-up; idempotent by MessageSid",
    smsLib.includes('from("messages")') && smsLib.includes('status: "unread"') && smsLib.includes("message_sid"))
  check("SMS: unknown texter → consented contact assigned to the number's agent (texting in IS consent)",
    smsLib.includes("captureContact") && smsLib.includes('"inbound_sms"'))
  const routerLib = src("lib/providers/inbound-router.ts")
  check("SMS: per-tenant signature tokens (subaccounts sign with their OWN token) + WhatsApp surface on the same webhook",
    routerLib.includes("twilioTokenResolver") && routerLib.includes("whatsapp:"))
  const inboundProviders = src("app/api/providers/inbound/route.ts")
  check("SMS: ONE ingress consolidated — tenant by the CALLED number, inbox record + capture folded into the EXISTING opt-out/kernel route",
    inboundProviders.includes("resolveTenantByOwnNumber") && inboundProviders.includes("recordInboundMessage") && inboundProviders.includes("captureTextingContact"))
  check("binding registers SmsUrl → the existing provider ingress + StatusCallback", bind.includes("/api/providers/inbound") && bind.includes("/api/voice/twilio/status"))
  check("KEEP-ONE: every messages writer resolves the NOT-NULL conversation thread via the canonical helper (latent silent-fail fixed in inbox reply, compliance override, open-house greeting)",
    ["lib/kernel/communications.ts", "app/actions/inbox.ts", "app/actions/workflows.ts", "lib/open-house/instant-greeting.ts", "lib/voice/sms-inbound.ts"]
      .every((f) => src(f).includes("ensureConversationForContact")))

  // ── Approved build 1: proactive reply drafts ──
  check("PROACTIVE DRAFTS: inbound text fires the EXISTING reply-coach rail (ai_message_drafts lifecycle — no parallel draft store); nothing auto-sends",
    src("lib/voice/sms-inbound.ts").includes("generateAIReplyDraft") && inboundProviders.includes("draftProactiveReply"))

  // ── Approved build 4: ConversationRelay ──
  check("RELAY: inbound answers via the transport switch (relayConfigured → ConversationRelay; else Gather) at BOTH scopes",
    inbound.includes("answerTwiml") && inbound.includes("relayConfigured") && inbound.includes("twimlConnectRelay"))
  const relayPlan = src("app/api/voice/relay/plan/route.ts")
  check("RELAY plan endpoint: timing-safe shared secret + the SAME planners/actors as the turn webhook (zero drift by construction)",
    relayPlan.includes("timingSafeEqual") && relayPlan.includes("planReceptionTurn") && relayPlan.includes("planPlatformReceptionTurn")
    && relayPlan.includes("bookShowingFromCall") && relayPlan.includes("processOptOut") && relayPlan.includes("capturePhoneProspect"))
  check("RELAY: human transfer executes SERVER-SIDE (live-call REST redirect) — the companion never holds Twilio creds",
    relayPlan.includes("redirectLiveCallToDial") && (() => { const c = src("tools/relay-companion/server.mjs"); return c.includes("x-relay-secret") && c.includes("/api/voice/relay/plan") && !c.includes("TWILIO_AUTH_TOKEN") })())
  check("KEEP-ONE: both transports book through the ONE bookShowingFromCall", turn.includes("bookShowingFromCall") && relayPlan.includes("bookShowingFromCall"))

  // ── Approved build 2: A2P 10DLC ──
  const a2pLib = src("lib/voice/a2p-registration.ts")
  check("A2P: resumable step machine — persisted sids on platform_credentials 'twilio_a2p', async reviews POLLED never assumed",
    a2pLib.includes('"twilio_a2p"') && a2pLib.includes("BrandRegistrations") && a2pLib.includes("Compliance/Usa2p") && a2pLib.includes("brand_status"))
  check("A2P: broker-gated tenant actions + the phone-settings card wired",
    src("app/actions/a2p-registration.ts").includes("isBrokerRole") && src("app/dashboard/admin/phone-settings/phone-settings-client.tsx").includes("A2pRegistrationCard"))

  // ── Approved build 3: voice week-in-review ──
  check("WEEK-IN-REVIEW: the Monday brief speaks the voice lane's WORK (loadVoiceActivity threaded next to the coaching intel)",
    src("lib/kernel/week-in-review.ts").includes("voiceActivityBrief") && src("lib/kernel/week-in-review.ts").includes("loadVoiceActivity"))
  check("registry burn domains: conversation_relay_lane (ai_isa) + a2p_auto_registration (compliance_officer)",
    "conversation_relay_lane" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.conversation_relay_lane.manager === "ai_isa"
    && "a2p_auto_registration" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.a2p_auto_registration.manager === "compliance_officer")
  check("registry burn domains: twilio_outbound_lane + sms_unified_inbox (ai_isa)",
    "twilio_outbound_lane" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.twilio_outbound_lane.manager === "ai_isa"
    && "sms_unified_inbox" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.sms_unified_inbox.manager === "ai_isa")
  check("rentcast MCP fixes: rental long-term path + range params", src("lib/property/rentcast.ts").includes("/listings/rental/long-term") && src("lib/property/rentcast.ts").includes("MCP-verified contract"))
  check("package.json wires the proof", /"test:voice-lane":/.test(src("package.json")))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ VOICE_LANE_FAIL"); process.exit(1) }
console.log(" ✅ VOICE_LANE_PASS — conversational reception on pure Twilio; the brain is engine-agnostic, the legal shield intact")
