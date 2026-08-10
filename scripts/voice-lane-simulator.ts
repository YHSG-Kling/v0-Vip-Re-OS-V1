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
import { OUTBOUND_CALL_GATE_ORDER } from "../lib/voice/outbound-call-gates"
import { relayConfigured, twimlConnectRelay, parseRelayFrame, relaySpeak, relayEnd, parseRelayPlanRequest, composePacingRule } from "../lib/voice/conversation-relay"
import { validateA2pProfile, nextA2pStep, describeA2pState } from "../lib/voice/a2p-registration"
import { rollupVoiceActivity, composeVoiceActivityBrief } from "../lib/kernel/call-intelligence"
import { extractAddressHints, composeInventoryBlock, DISCUSSABLE_STAGES } from "../lib/voice/reception-inventory"
import { isAnalyzableCall } from "../lib/voice/call-analysis"
import { rollupDraftQuality, composeDraftQualityBrief } from "../lib/kernel/draft-quality"
import { composeOvernightDigest } from "../lib/kernel/overnight-digest"
import { resolveProductBrand, DEFAULT_PRODUCT_BRAND } from "../lib/platform/product-brand"
import { buildPlatformReceptionPrompt as buildPlatformPromptForBrandCheck } from "../lib/voice/platform-reception"
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
  const rsvp = parseTurnPlan('{"say":"You are on the list!","action":"rsvp","address":"12 Oak St"}')
  check("rsvp parsed with the listing address; address-less rsvp degrades to continue (garbage never RSVPs)",
    rsvp.action.kind === "rsvp" && (rsvp.action as any).address === "12 Oak St"
    && parseTurnPlan('{"say":"ok","action":"rsvp"}').action.kind === "say")
  const sl = parseTurnPlan('{"say":"The team will prepare a real valuation.","action":"seller_lead","address":"44 Elm Ave"}')
  check("seller_lead parsed (address optional — a hand-raise without one still routes)",
    sl.action.kind === "seller_lead" && (sl.action as any).address === "44 Elm Ave"
    && (parseTurnPlan('{"say":"ok","action":"seller_lead"}').action as any).address === null)
  check("TURN_INSTRUCTIONS pin the new actions: rsvp only on a spoken yes; seller_lead never quotes a value",
    TURN_INSTRUCTIONS.includes('"rsvp"') && TURN_INSTRUCTIONS.includes("seller_lead") && TURN_INSTRUCTIONS.includes("Never quote a value"))
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
  check("Conversational Intelligence attaches via TwiML attribute ONLY when a service sid is configured (env-gated, never fabricated)",
    twimlConnectRelay("wss://r.example/relay", "hi", undefined, "GA0123456789abcdef0123456789abcdef").includes('intelligenceService="GA0123456789abcdef0123456789abcdef"')
    && !twimlConnectRelay("wss://r.example/relay", "hi").includes("intelligenceService"))
  check("plan-request validation rejects partial bodies", parseRelayPlanRequest({ callSid: "CA1", to: "+1", from: "+2", utterance: "hi" }) !== null
    && parseRelayPlanRequest({ callSid: "", to: "+1", from: "+2", utterance: "hi" }) === null && parseRelayPlanRequest(null) === null)
  check("BARGE-IN pacing: interrupts counted (default 0, capped) → escalating shorten-your-replies rule; silent at zero",
    parseRelayPlanRequest({ callSid: "CA1", to: "+1", from: "+2", utterance: "hi" })!.interrupts === 0
    && parseRelayPlanRequest({ callSid: "CA1", to: "+1", from: "+2", utterance: "hi", interrupts: 99 })!.interrupts === 20
    && composePacingRule(0) === "" && composePacingRule(1).includes("ONE short sentence") && composePacingRule(3).includes("interrupted 3 times"))
}

console.log("\n── PURE: A2P 10DLC step machine ──")
{
  const bad = validateA2pProfile({ legalName: "Kling Realty", ein: "12-34567" })
  check("profile validation: honest missing list + EIN must be 9 digits + REQUIRED legal URLs (June 30 2026 carrier rule)",
    !bad.ok && (bad as any).missing.includes("Business website") && (bad as any).missing.some((m: string) => m.includes("9 digits"))
    && (bad as any).missing.includes("Privacy policy URL") && (bad as any).missing.includes("Terms & conditions URL"))
  const good = validateA2pProfile({
    legalName: "Kling Realty LLC", ein: "12-3456789", website: "https://kling.example",
    street: "1 Main St", city: "Austin", region: "TX", postalCode: "78701",
    contactFirstName: "D", contactLastName: "K", contactEmail: "d@kling.example", contactPhone: "+15125550100",
    privacyPolicyUrl: "https://kling.example/privacy", termsUrl: "https://kling.example/terms",
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
    { direction: "inbound", call_type: "ai_inbound", status: "completed", outcome: "completed" },
    { direction: "inbound", call_type: "ai_inbound", status: "completed", outcome: "completed" },
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

console.log("\n── PURE: inventory-aware reception ──")
{
  const hints = extractAddressHints("I'm calling about 12 Oak Street, is it still available?")
  check("address hints extracted (number + street)", hints.includes("12") && hints.some((h) => /oak street/i.test(h)))
  const block = composeInventoryBlock([
    { address: "12 Oak St", city: "Austin", list_price: 450000, bedrooms: 3, bathrooms: 2, sqft: 1850, property_type: "single_family", open_house_event_date: "2026-07-12" },
    { address: null, city: null, list_price: 1, bedrooms: null, bathrooms: null, sqft: null, property_type: null, open_house_event_date: null },
  ])
  check("inventory block: real facts (price/beds/open house) + the SCOPED no-invention rule; address-less rows dropped",
    block.includes("$450,000") && block.includes("3bd") && block.includes("open house 2026-07-12") && block.includes("never invent details") && !block.includes("null"))
  check("empty inventory → empty block (the original refusal rule stands)", composeInventoryBlock([]) === "")
  check("discussable stages use the CANONICAL lifecycle vocabulary (live-verified UPPERCASE; UNDER_CONTRACT excluded — never spoken as available)",
    DISCUSSABLE_STAGES.includes("MLS_ACTIVE" as any) && DISCUSSABLE_STAGES.includes("COMING_SOON_ACTIVE" as any)
    && !(DISCUSSABLE_STAGES as readonly string[]).includes("UNDER_CONTRACT") && DISCUSSABLE_STAGES.every((s) => s === s.toUpperCase()))
}

console.log("\n── PURE: voice intelligence sweep ──")
{
  const good = { status: "completed", transcription: "AI: Thanks for calling — I'm an AI assistant and this call may be recorded. How can I help?\nCaller: I want to see 12 Oak St this weekend, we're pre-approved and moving fast." }
  check("analyzable: completed + a real caller line", isAnalyzableCall(good, false))
  check("greeting-only / short / non-completed / already-analyzed all skipped",
    !isAnalyzableCall({ status: "completed", transcription: "AI: Thanks for calling — I'm an AI assistant. How can I help you today, and what brings you in?" }, false)
    && !isAnalyzableCall({ status: "in_progress", transcription: good.transcription }, false)
    && !isAnalyzableCall(good, true))
}

console.log("\n── PURE: draft-quality flywheel ──")
{
  const q = rollupDraftQuality([
    { status: "accepted", edit_delta: { changed: false }, channel: "sms" },
    { status: "accepted", edit_delta: { changed: true, pct_changed: 30 }, channel: "sms" },
    { status: "dismissed", edit_delta: null, channel: "sms" },
    { status: "pending", edit_delta: null, channel: "email" },
  ])
  check("flywheel fold: drafted/accepted/untouched/dismissed/avg-edit", q.drafted === 4 && q.accepted === 2 && q.sentUntouched === 1 && q.dismissed === 1 && q.avgEditPct === 15)
  check("brief speaks adoption + the learning line", composeDraftQualityBrief(q).includes("drafted 4 replies") && composeDraftQualityBrief(q).includes("1 of them untouched") && composeDraftQualityBrief(q).includes("15%"))
  check("nothing drafted → empty (never pads)", composeDraftQualityBrief(rollupDraftQuality([])) === "")
}

console.log("\n── PURE: the overnight digest ──")
{
  const busy = composeOvernightDigest({ callsAnswered: 3, bookings: 1, rsvps: 2, sellerLeads: 1, hotCallbacks: 1, textsReceived: 4 })
  check("busy night narrated: calls, texts, bookings, RSVPs + seller/hot-call action lines",
    busy.includes("answered 3 calls") && busy.includes("took 4 texts") && busy.includes("booked 1 appointment")
    && busy.includes("RSVP'd 2 guests") && busy.includes("what their home is worth") && busy.includes("same-day callback"))
  check("silent night → empty string (the digest never pads)",
    composeOvernightDigest({ callsAnswered: 0, bookings: 0, rsvps: 0, sellerLeads: 0, hotCallbacks: 0, textsReceived: 0 }) === "")
}

console.log("\n── PURE: no hardcoded copy — the platform pitch/greeting are SETTINGS ──")
{
  const custom = resolveProductBrand({ voicePitch: "the operating system for winning brokerages", receptionGreeting: "Curious about the platform, or need a hand with your account?" })
  check("product_brand carries voicePitch + receptionGreeting with defaults", DEFAULT_PRODUCT_BRAND.voicePitch.length > 20 && custom.voicePitch === "the operating system for winning brokerages")
  const p = buildPlatformPromptForBrandCheck({ brandName: "VIP Agents", tagline: "t", tierLines: [], hasTransfer: false, voicePitch: custom.voicePitch, receptionGreeting: custom.receptionGreeting })
  check("the platform prompt SPEAKS the settings, not hardcoded copy",
    p.systemPrompt.includes("the operating system for winning brokerages") && p.firstMessage.includes("Curious about the platform"))
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
  const binding = src("lib/voice/inbound-number-binding.ts")
  check("binding is Twilio-ONLY (VAPI retired — no VOICE_ENGINE flag, no vapi assistant/number-import)",
    binding.includes("bindNumberToTwilioLane") && !binding.includes("VOICE_ENGINE") && !binding.includes("registerNumberWithVapi"))
  const bind = src("lib/voice/twilio-voice.ts")
  check("bind sets VoiceUrl via the TENANT's creds — no vendor assistant object",
    bind.includes("VoiceUrl") && bind.includes("resolveTenantTwilioCreds") && bind.includes("IncomingPhoneNumbers/"))
  const matrix = src("lib/providers/tenancy-matrix.ts")
  check("matrix: vapi = RETIRED, twilio-native is the single voice lane", matrix.includes("RETIRED voice lane") && matrix.includes("fully replaced by Twilio-native"))
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
  // ASSERT THE CONSTRUCT, NOT THE SPELLING. This used to read
  // `indexOf("enforceTCPACompliance") < indexOf("callConnector")` in THIS file,
  // which broke the moment the gates were correctly consolidated into
  // lib/voice/outbound-call-gates.ts (wave 8). What must hold is: the executor
  // runs the whole gate stack before it dials, and the stack really contains
  // the TCPA and budget gates — both checked against the exported gate list.
  check("OUTBOUND: the gate stack runs BEFORE the Twilio dial",
    outboundLib.indexOf("runOutboundCallGates") >= 0
    && outboundLib.indexOf("runOutboundCallGates") < outboundLib.indexOf("callConnector"))
  check("OUTBOUND: that stack still contains the TCPA chokepoint + the vendor budget ceiling",
    OUTBOUND_CALL_GATE_ORDER.includes("tcpa") && OUTBOUND_CALL_GATE_ORDER.includes("vendor_budget"))
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
  check("callers place through the Twilio lane (VAPI retired — no flag branch): call-executor + AI-ISA",
    src("lib/voice-engine/call-executor.ts").includes("placeOutboundAiCall") && src("lib/application/ai-isa.ts").includes("placeOutboundAiCall")
    && !src("lib/voice-engine/call-executor.ts").includes("VOICE_ENGINE"))

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
  check("A2P CONTRACT-VERIFIED (Twilio docs, July 2026): SECONDARY profile policy RNdfbf… (not the Starter RN806dd…); MessageSamples is an ARRAY of 2; legal URLs + SubscriberOptIn/AgeGated/DirectLending + OptInMessage/Keywords on the campaign",
    a2pLib.includes("RNdfbf3fae0e1107f8aded0e7cead80bf5") && !a2pLib.includes('= "RN806dd6cd175f314e1f96a9727ee271f4"')
    && a2pLib.includes("MessageSamples: [") && a2pLib.includes("PrivacyPolicyUrl: profile.privacyPolicyUrl")
    && a2pLib.includes("TermsAndConditionsUrl") && a2pLib.includes("SubscriberOptIn: true") && a2pLib.includes("OptInKeywords"))
  check("A2P: campaign review polled by the campaign's OWN sid + Mock-brand test path (BrandRegistrations Mock=true) for pre-production verification",
    a2pLib.includes("Compliance/Usa2p/${state.campaign_sid}") && a2pLib.includes("Mock: true"))
  check("GATEWAY: form arrays serialize as REPEATED keys (Twilio array params) — comma-joined would be rejected",
    src("lib/agentic-os/connector-gateway.ts").includes("Array.isArray(v)) for (const item of v) p.append(k"))
  check("BARGE-IN wired end-to-end: companion counts interrupt frames → plan request → composePacingRule threaded into every scope's prompt",
    src("tools/relay-companion/server.mjs").includes('frame?.type === "interrupt"') && src("tools/relay-companion/server.mjs").includes("interrupts")
    && src("app/api/voice/relay/plan/route.ts").includes("composePacingRule(req.interrupts)"))
  // ── Conversational Intelligence merge + mock verify + portal inventory ──
  const ciRoute = src("app/api/voice/twilio/intelligence/route.ts")
  check("CI WEBHOOK: token-gated (timing-safe, 404 silent) + our sweep's fields always WIN (merge fills only empty summary/sentiment; operators ride intent_signals)",
    ciRoute.includes("timingSafeEqual") && ciRoute.includes('"not found"')
    && ciRoute.includes("!(call as any).summary") && ciRoute.includes("intent_signals"))
  check("A2P MOCK VERIFY: providers-gated one-click action (Mock=true chain) + audited + card on the connectors page",
    (() => { const a = src("app/actions/superadmin/a2p-verify.ts"); return a.includes('platformStaffCan(role, "providers")') && a.includes("mock: true") && a.includes("superadmin_audit_log") })()
    && src("app/dashboard/superadmin/connectors/page.tsx").includes("A2pVerifyCard"))
  check("VOICE INTEGRITY: CNAM + SHAKEN/STIR appended to the SAME step machine state (twilio_a2p jsonb, no new tables) — gated on campaign approval, Twilio-published policy SIDs, statuses POLLED never assumed",
    a2pLib.includes("RNf3db3cd1fe25fcfd3c3ded065c8fea53") && a2pLib.includes("RN7a97559effdf62d00f4298208492a5ea")
    && a2pLib.includes("cnam_information") && a2pLib.includes("a2pCampaignApproved(state)")
    && a2pLib.includes("ChannelEndpointAssignments") && a2pLib.includes("cnam_trust_product_sid"))
  check("VOICE INTEGRITY: mock leaves bundles in Twilio's real 'draft' status (never a fabricated approval) + errors kept SEPARATE from last_error so the stall detector stays honest",
    a2pLib.includes('{ sid: tpSid, status: "draft" }') && a2pLib.includes("voice_integrity_error") && !a2pLib.includes('cnam_status = "twilio-approved"'))
  check("VOICE INTEGRITY: providers-gated + audited register button on the A2P board (per-tenant cell, board idiom)",
    (() => { const a = src("app/dashboard/superadmin/a2p/actions.ts"); return a.includes('platformStaffCan(role, "providers")') && a.includes("superadmin_audit_log") && a.includes("runVoiceIntegrityRegistration") })()
    && src("app/dashboard/superadmin/a2p/page.tsx").includes("VoiceIntegrityCell"))
  check("PORTAL CHAT gains the SAME live-inventory facts (additive: buyers only, share-freely exception stated, read failure never breaks the chat)",
    (() => { const p = src("app/api/portal/ai-chat/route.ts"); return p.includes("loadInventoryContext") && p.includes("portalView !== 'seller'") && p.includes("share freely") })())
  // ── Reception autonomous actions + readiness + compliance watch ──
  const voiceLib = src("lib/voice/twilio-voice.ts")
  check("RSVP action: matches a real listing → next scheduled open house → idempotent RSVP (source ai_reception, l34-s01) + agent heads-up; BOTH transports route it",
    voiceLib.includes("rsvpOpenHouseFromCall") && voiceLib.includes('"ai_reception"') && voiceLib.includes('from("open_house_rsvp_tracking")')
    && turn.includes("rsvpOpenHouseFromCall") && src("app/api/voice/relay/plan/route.ts").includes("rsvpOpenHouseFromCall")
    && src("scripts/l34-s01-rsvp-source-ai-reception.sql").includes("ai_reception"))
  check("SELLER LEAD action: gated CMA proposal on the canonical rail, deduped per call ([SELLER_LEAD]); the AI never quotes a value; BOTH transports route it",
    voiceLib.includes("proposeSellerLeadFromCall") && voiceLib.includes("[SELLER_LEAD]")
    && turn.includes("proposeSellerLeadFromCall") && src("app/api/voice/relay/plan/route.ts").includes("proposeSellerLeadFromCall"))
  check("reception prompt INVITES to open houses from live inventory + never guesses a home value",
    src("lib/voice/reception-brain.ts").includes("INVITE them and RSVP them") && src("lib/voice/reception-brain.ts").includes("never guess a number"))
  check("CONFIRMATION TEXTING: booking + RSVP each send a transactional card via the ONE gated sendSMS (DNC/quiet-hours enforced inside; best-effort)",
    voiceLib.includes("textCallConfirmation") && voiceLib.includes("transactional: true")
    && voiceLib.includes("Reply R to reschedule") && voiceLib.includes("on the list for the open house"))
  check("OVERNIGHT DIGEST: morning cron registered + per-agent dedupe-per-day + counts trace to ledgers",
    src("lib/kernel/cron-dispatch.ts").includes("/api/cron/overnight-digest")
    && src("app/api/cron/overnight-digest/route.ts").includes("runOvernightDigest")
    && src("lib/kernel/overnight-digest.ts").includes("overnight_ai_digest") && src("lib/kernel/overnight-digest.ts").includes("[SELLER_LEAD]"))
  const readiness = src("lib/platform/go-live-readiness.ts")
  check("GO-LIVE READINESS: live probes per domain (Twilio master + line binding, SendGrid, Stripe live/test, ElevenLabs, D-ID, storage, DB, cron, A2P) — never env-presence-only for vendors",
    readiness.includes("Accounts/${sid}.json") && readiness.includes("IncomingPhoneNumbers.json") && readiness.includes("/v3/scopes")
    && readiness.includes("/v1/balance") && readiness.includes("livemode") && readiness.includes("/v1/user") && readiness.includes("/credits")
    && readiness.includes('"twilio_a2p"'))
  check("GO-LIVE READINESS: providers-gated + audited action, card on the connectors page, required-vs-optional go/no-go rollup",
    src("app/actions/superadmin/go-live-readiness.ts").includes('platformStaffCan(role, "providers")')
    && src("app/dashboard/superadmin/connectors/page.tsx").includes("GoLiveCard") && readiness.includes("rollupReadiness"))
  check("CI COMPLIANCE WATCH: watch-named operator hits (true/high-probability only) → immutable compliance_events + compliance-owner alerts",
    ciRoute.includes("fair.?housing") && ciRoute.includes('from("compliance_events")') && ciRoute.includes("call_compliance_watch"))
  check("URGENCY ROUTING: a hot call (≥ threshold) proposes ONE gated same-day callback on the proposal rail, deduped per call — nothing auto-dials",
    src("lib/voice/call-analysis.ts").includes("URGENT_CALLBACK_THRESHOLD") && src("lib/voice/call-analysis.ts").includes("proposeClientMessage")
    && src("lib/voice/call-analysis.ts").includes("[HOT_CALL]") && src("lib/voice/call-analysis.ts").includes("callbacksProposed"))
  check("A2P: broker-gated tenant actions + the phone-settings card wired",
    src("app/actions/a2p-registration.ts").includes("isBrokerRole") && src("app/dashboard/admin/phone-settings/phone-settings-client.tsx").includes("A2pRegistrationCard"))

  // ── Approved build 3: voice week-in-review ──
  check("WEEK-IN-REVIEW: the Monday brief speaks the voice lane's WORK (loadVoiceActivity threaded next to the coaching intel)",
    src("lib/kernel/week-in-review.ts").includes("voiceActivityBrief") && src("lib/kernel/week-in-review.ts").includes("loadVoiceActivity"))
  // ── Approved builds: intelligence sweep + inventory + flywheel ──
  check("VOICE INTEL: hourly cron registered + sweep idempotent by voice_call_id + agent_id carries the USER id the reader filters by",
    src("lib/kernel/cron-dispatch.ts").includes("/api/cron/voice-call-analysis")
    && src("app/api/cron/voice-call-analysis/route.ts").includes("sweepVoiceCallIntelligence")
    && src("lib/voice/call-analysis.ts").includes("voice_call_id") && src("lib/voice/call-analysis.ts").includes("agentUserId"))
  check("VOICE INTEL: the manual analyzer's sentiment now maps to the live CHECK vocabulary (very_* was silently dropped)",
    src("app/actions/ai-voice-transcription.ts").includes('replace(/^very_/, "")'))
  check("INVENTORY: reception answers from LIVE listings — planReceptionTurn injects loadInventoryContext; BOTH transports pass svc",
    src("lib/voice/twilio-voice.ts").includes("loadInventoryContext")
    && turn.includes("planReceptionTurn(ctx, transcript, speech, svc)")
    && src("app/api/voice/relay/plan/route.ts").includes("planReceptionTurn(ctx, transcript, req.utterance, svc"))
  check("SETTINGS CASCADE: identity resolution walks agent → TEAM → brokerage (nothing hardcoded, brand flows all the way down)",
    src("lib/voice/twilio-voice.ts").includes('"team"') && src("lib/voice/twilio-voice.ts").includes("team_id"))
  check("FLYWHEEL: the Monday brief threads the draft-quality line (loadDraftQuality beside voice activity + call intel)",
    src("lib/kernel/week-in-review.ts").includes("draftQualityBrief") && src("lib/kernel/week-in-review.ts").includes("loadDraftQuality"))
  check("registry burn domains: voice_intelligence_sweep + inventory_aware_reception + draft_quality_flywheel (ai_isa)",
    ["voice_intelligence_sweep", "inventory_aware_reception", "draft_quality_flywheel"]
      .every((k) => k in MAINTENANCE_DOMAINS && (MAINTENANCE_DOMAINS as any)[k].manager === "ai_isa"))
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
