// lib/voice/reception-brain.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE RECEPTION BRAIN — engine-agnostic. One prompt + one turn-planner that any
// voice engine consumes: the Twilio-native lane (turn-based <Gather> → AI →
// TwiML, pure serverless) today, and whatever streams tomorrow. Extracted from
// the Vapi assistant builder so the OWNER'S migration (Twilio-first, Vapi
// sunset) swaps ENGINES, never brains: same identity, same legal preamble,
// same hour-aware behavior, same capability-gated actions.

import { withAiCallDisclosures } from "@/lib/communication/call-disclosures"
import { composeBusinessHoursRule, type InboundIdentity } from "@/lib/voice/inbound-number-binding"
import { buildQualificationPrompt } from "@/lib/ai-isa/qualification-playbook"
import type { BrandPlaybookContext } from "@/lib/ai-isa/brand-playbook-context"

/** `InboundIdentity.brand` is typed `unknown` so the identity-binding module
 *  never imports the AI-ISA playbook — this is the one narrowing site. */
function brandOf(id: InboundIdentity): BrandPlaybookContext | null | undefined {
  return id.brand as BrandPlaybookContext | null | undefined
}
import { PROSPECT_ROLES } from "@/lib/platform/growth-funnel"

/** PURE: the reception system prompt from the tenant's AI identity — shared by
 *  every engine. Mirrors the Vapi builder's rules exactly (one brain). */
export function buildReceptionPrompt(id: InboundIdentity): { name: string; firstMessage: string; systemPrompt: string } {
  const office = id.brokerageName ?? "the office"
  const who = id.agentName ? `${id.agentName}'s office at ${office}` : office
  const name = (id.assistantName ?? "Reception Assistant").slice(0, 40)
  const rawFirst = (id.welcomeMessage ?? `Thanks for calling ${who} — I'm ${name}, the AI assistant. How can I help you today?`).slice(0, 300)
  const firstMessage = withAiCallDisclosures(rawFirst, { recorded: true })
  const prohibited = (id.prohibitedLanguage ?? []).filter(Boolean).slice(0, 20)

  // TOMBSTONE (lane 74B) — the hand-rolled six-item job list ("(1) learn who
  // is calling… (5) if they mention selling… offer a real valuation and
  // capture their property address…") stood here. SURVIVOR:
  // lib/ai-isa/qualification-playbook.ts::buildQualificationPrompt
  // (CLAUDE.md §6). "(4) invite/RSVP an open house" is kept — it is specific
  // to this voice surface's live-inventory capability, not a qualification
  // goal.
  const systemPrompt = [
    `You are ${name}, the AI reception assistant answering inbound phone calls for ${who}.`,
    id.tone ? `Tone: ${id.tone}.` : "Tone: warm, professional, concise.",
    buildQualificationPrompt({ surface: "voice_reception", brand: brandOf(id) }),
    "Additionally: when the LIVE INVENTORY shows an upcoming open house that fits what they want, INVITE them and RSVP them on the spot if they say yes. If they mention selling or ask what their home is worth, never guess a number — offer to have the team prepare a real valuation.",
    "HARD RULES: Never give legal, lending, or tax advice — offer to have the agent follow up. Never discuss the demographics of any neighborhood or steer callers toward or away from areas (Fair Housing). Never invent property details, prices, or availability — if you don't know, say the agent will confirm. Never promise a commission rate or contract terms.",
    prohibited.length > 0 ? `Never use these phrases: ${prohibited.join("; ")}.` : "",
    composeBusinessHoursRule(id.answerMode, id.businessHours),
    "If the caller asks to stop being contacted, acknowledge it clearly and end politely — their request is recorded.",
    "If the caller asks whether you are an AI or a robot, confirm honestly and immediately — never pretend to be human.",
    "Keep answers short — this is a phone call, not an essay.",
  ].filter(Boolean).join("\n")

  return { name, firstMessage, systemPrompt }
}

/** PURE: the OUTBOUND call prompt — the ISA lane on the Twilio engine. The
 *  objective is per-call (speed-to-lead, follow-up, re-engagement …); the hard
 *  rules are the same legal shield as reception, plus outbound-specific ones:
 *  instant opt-out honor and zero pressure (one ask, then respect the answer). */
export function buildOutboundPrompt(id: InboundIdentity, brief: {
  objective: string
  contactName?: string | null
  extraSystemPrompt?: string | null
}): { name: string; firstMessage: string; systemPrompt: string } {
  const office = id.brokerageName ?? "the office"
  const who = id.agentName ? `${id.agentName}'s office at ${office}` : office
  const name = (id.assistantName ?? "Assistant").slice(0, 40)
  const greet = brief.contactName ? `Hi ${brief.contactName} — ` : "Hi — "
  const rawFirst = `${greet}this is ${name} calling from ${who}.`
  const firstMessage = withAiCallDisclosures(rawFirst, { recorded: true })
  const prohibited = (id.prohibitedLanguage ?? []).filter(Boolean).slice(0, 20)

  const systemPrompt = [
    `You are ${name}, an AI assistant making an OUTBOUND phone call on behalf of ${who}.`,
    id.tone ? `Tone: ${id.tone}.` : "Tone: warm, professional, concise.",
    `THIS CALL'S OBJECTIVE: ${brief.objective.slice(0, 500)}`,
    brief.extraSystemPrompt ? brief.extraSystemPrompt.slice(0, 2000) : "",
    buildQualificationPrompt({ surface: "voice_outbound", brand: brandOf(id) }),
    "OUTBOUND RULES: You called THEM — respect their time. State why you're calling within the first two exchanges. One ask per call; if they decline, thank them and close — never pressure, never argue. If they say to stop calling or not to contact them, acknowledge it clearly, confirm it's recorded, and end the call immediately.",
    "HARD RULES: Never give legal, lending, or tax advice — offer to have the agent follow up. Never discuss the demographics of any neighborhood or steer callers toward or away from areas (Fair Housing). Never invent property details, prices, or availability — if you don't know, say the agent will confirm. Never promise a commission rate or contract terms.",
    prohibited.length > 0 ? `Never use these phrases: ${prohibited.join("; ")}.` : "",
    "If the person asks whether you are an AI or a robot, confirm honestly and immediately — never pretend to be human.",
    "If they want to book a time with the agent, use the book action once they've confirmed a specific date and time out loud. If they ask for the agent directly, offer to transfer.",
    "Keep answers short — this is a phone call, not an essay.",
  ].filter(Boolean).join("\n")

  return { name, firstMessage, systemPrompt }
}

// ── Turn planning (the Twilio turn-based lane) ────────────────────────────────

export type VoiceTurnAction =
  | { kind: "say" }                                     // keep talking
  | { kind: "transfer" }                                // dial the human
  | { kind: "book"; dateTime: string }                  // book appointment/showing
  | { kind: "rsvp"; address: string }                   // RSVP the caller to an open house
  | { kind: "seller_lead"; address: string | null }     // "what's my home worth" → gated CMA
  // Owner ruling (wave 55): "the ai assistant or receptionist needs to be able
  // to make a task to call a person back and then do the call back when it is
  // time." The prompt already instructs the AI to capture a callback number
  // (rule 1 above); this is the ACTION that turns "I'll have someone call you
  // back at 3pm" into a real tasks row. `whenPhrase` is the caller's own words
  // for the time ("3pm", "tomorrow morning") — kept as spoken text because the
  // model already has to fabricate an ISO timestamp for `book` without knowing
  // the tenant's timezone; resolveCallbackDueDate (lib/ai-isa/callback-task.ts)
  // does the real parsing downstream (regex first, the AI gateway as fallback)
  // against the calendar day the call was PLACED on, which this turn-planner
  // does not know either. `phone` is set ONLY when the caller gave a DIFFERENT
  // number than the one they're calling from ("call me back at 555-..."); null
  // means "this number, the one on this call".
  | { kind: "callback"; phone: string | null; whenPhrase: string; reason: string | null }
  // Lane 75D — ONE voice-receptionist engine (owner, wave 75: "make sure that
  // there aren't 2 different ai agents that handle ai voice receptionists").
  // The PLATFORM deployment's own capture action, merged onto this SAME
  // VoiceTurnAction union (TOMBSTONE: lib/voice/platform-reception.ts's
  // standalone PlatformTurnAction/PlatformTurnPlan — see planReceptionTurn in
  // lib/voice/twilio-voice.ts, the deployment-branching entrypoint). A tenant
  // call never produces this action; a platform call never produces
  // book/rsvp/seller_lead/callback — the shared PARSER below accepts the
  // union of both deployments' vocabularies, and each deployment's own
  // TURN_INSTRUCTIONS only ever asks the model for the subset it can act on.
  | { kind: "prospect"; name: string | null; email: string | null; company: string | null; roleInterest: string; note: string | null }
  | { kind: "hangup" }                                  // caller done

// TOMBSTONE (lane 73E, 2026-09-18): lane 73B's closed VOICE_TOOL_NAMES enum +
// VoiceToolRequest + parseVoiceToolRequest + VoiceTurnPlan.toolRequest — a
// hand-rolled "ask for a tool in your JSON, executor parses the field, runs
// AT MOST ONE call, re-plans once" protocol bolted on top of this file's
// JSON-plan engine — are RETIRED. The capability now lives natively:
// lib/voice/twilio-voice.ts's `planTurnWithPrompt` passes the SAME
// persona-scoped registry (lib/ai-isa/batchdata-isa-tools.ts, narrowed to the
// same property-only subset that enum used to name — VOICE_TOOL_ALLOWLIST
// below, now just a plain string-name allowlist with no JSON-schema duty)
// straight into `generateTextRouted({ tools, maxSteps: 3, abortSignal })` —
// real AI-SDK multi-step tool-calling, the model choosing whether/how many
// times to call, the SDK folding each result into its own context, no manual
// re-prompt. See docs/ai-agent-tool-surfaces-2026-09.md §4. `toolRequest` was
// never read by any route (app/api/voice/twilio/turn, app/api/voice/relay/
// plan only ever read `.say`/`.action`), so its removal from VoiceTurnPlan
// does not touch the OUTPUT CONTRACT those routes consume.
export const VOICE_TOOL_ALLOWLIST = [
  "lookup_property",
  "comparable_property_preview",
  "comparable_property_count",
  "verify_address",
] as const
// Un-exported (lane 75D, opposite-missing census round 20): the last
// importer (lib/voice/twilio-voice.ts's cast on the selectToolsForPersona
// result) was removed when planTurnWithPrompt was refactored to merge the
// free capture bundle in — nothing imports this any more. Module-private
// until a real importer needs it again (CLAUDE.md §1: un-export rather than
// delete a type that still documents the allowlist's own shape).
type VoiceToolName = (typeof VOICE_TOOL_ALLOWLIST)[number]

export interface VoiceTurnPlan {
  say: string
  action: VoiceTurnAction
}

/** The JSON contract the model must return each turn. */
export const TURN_INSTRUCTIONS = [
  "Respond with JSON ONLY, no prose around it:",
  '{ "say": "<what you speak next — one to three short sentences>",',
  '  "action": "continue" | "transfer" | "book" | "rsvp" | "seller_lead" | "callback" | "hangup",',
  '  "date_time": "<ISO 8601, ONLY when action is book>",',
  '  "address": "<the property address, ONLY when action is rsvp or seller_lead>",',
  '  "callback_phone": "<a DIFFERENT callback number the caller gave, ONLY when action is callback and they gave one other than the number they are calling from — otherwise omit>",',
  '  "callback_when": "<the caller\'s OWN words for when, ONLY when action is callback — e.g. \\"3pm today\\", \\"tomorrow morning\\", \\"in an hour\\". Never convert it yourself.>",',
  '  "callback_reason": "<one short phrase for why they want a call back, ONLY when action is callback>" }',
  "Rules: action 'transfer' when the caller asks for the agent / is urgent / office-hours rule says so.",
  "action 'book' ONLY after the caller has confirmed a specific date and time out loud.",
  "action 'rsvp' ONLY after the caller says yes to attending an open house from the LIVE INVENTORY list — include that listing's address.",
  "action 'seller_lead' when the caller asks what their home is worth or mentions selling — include their property address if they gave it. Never quote a value yourself; say the team will prepare a real valuation.",
  "action 'callback' when you have told the caller someone will call them back, OR they asked for a call back at a specific time — capture callback_when in their own words (never compute a date yourself) and confirm it back to them out loud in your 'say'.",
  "action 'hangup' when the caller says goodbye or the call is complete — say a warm close first.",
  "Otherwise action 'continue'.",
].join("\n")

// Lane 73E — appended to the prompt ONLY on turns where real AI-SDK tools are
// being offered (lib/voice/twilio-voice.ts::planTurnWithPrompt, when the
// call's persona-scoped registry has at least one property tool available).
// Native tool-calling replaces the old manual `tool_request` JSON field
// (TOMBSTONE above) — the model calls a REAL tool via the SDK's own
// function-calling protocol, not by naming one inside this JSON.
//
// Lane 75D — the SAME round also carries the free capture/follow-up bundle
// (lib/ai-isa/customer-context-tools.ts::buildCustomerFreeTools —
// get_my_context, search_our_listings, and once a contact/lead is linked:
// request_showing, schedule_callback, schedule_home_value_review,
// book_agent_appointment, send_matching_listings, record_qualification),
// the SAME bundle every chat surface (email/widget/portal/D-ID) already
// offers — so a live call captures exactly as much (owner, wave 75:
// "capturing as much useful information about that person for the os").
export const TOOL_TURN_GUIDANCE = [
  "You have live property-lookup tools available on this call. Call one ONLY when you need REAL data you don't already have (a specific address's details, comparable sales, or a comp count) — never guess, and never call a tool for something you can already answer.",
  // Lane 76A: this line named the RETIRED book_agent_appointment (tombstoned in
  // lib/ai-isa/customer-context-tools.ts) — a promise the model could not keep.
  // The names below are the REGISTERED ones (scripts/identity-class-tool-
  // context-guard.ts holds this string against the follow-up menu).
  "You ALSO have free tools for recording what you learn and offering follow-up — call record_qualification as SOON as you learn any of their intent/persona/property-they're-selling/seller-situation/buyer-criteria/timeline/financing (safe to call more than once as more comes up), and call ONE follow-up tool (schedule_callback, send_matching_listings, schedule_home_value_review, find_listing_appointment_slots then book_listing_appointment, request_showing, request_vendor_referral, or capture_referral) once you understand what they want, matching the FOLLOW-UP MENU above — never more than one, never a forced choice. get_listing_details answers a question about one of OUR listings for free.",
  "This is a LIVE phone call — the caller is waiting in silence while you work. Call at most a couple of tools per turn, and only when genuinely needed; do not call the same tool twice for the same thing.",
  "Once you have what you need (or decide no tool is needed), respond with your FINAL turn as the JSON object described above and NOTHING else — no further tool calls, no prose before or after the JSON.",
].join("\n")

// ── Platform-deployment turn contract (lane 75D — moved here from
// lib/voice/platform-reception.ts so BOTH deployments' instructions/guidance
// live beside the ONE VoiceTurnPlan/VoiceTurnAction contract and the ONE
// parser below; TOMBSTONE: platform-reception.ts's former
// PLATFORM_TURN_INSTRUCTIONS / PLATFORM_TOOL_TURN_GUIDANCE constants and its
// standalone parsePlatformTurnPlan — see this file's parseTurnPlan, which now
// accepts the union of both deployments' action vocabularies.) ─────────────
export const PLATFORM_TURN_INSTRUCTIONS = [
  "Respond with JSON ONLY, no prose around it:",
  '{ "say": "<what you speak next — one to three short sentences>",',
  '  "action": "continue" | "prospect" | "transfer" | "hangup",',
  '  "name": "<caller name, ONLY with action prospect>",',
  '  "email": "<caller email if they gave one, ONLY with action prospect>",',
  '  "company": "<their company/team if given, ONLY with action prospect>",',
  '  "role_interest": "solo_agent" | "team" | "brokerage" | "multi_location" | "unknown",',
  '  "note": "<one line on what they want, ONLY with action prospect>" }',
  "Rules: action 'prospect' once the caller has shared contact details and wants follow-up — their phone number is already captured from caller ID, so a name alone is enough.",
  "action 'transfer' ONLY for existing-customer support when a transfer is offered in your instructions.",
  "action 'hangup' when the caller says goodbye or the call is complete — say a warm close first.",
  "Otherwise action 'continue'.",
].join("\n")

export const PLATFORM_TOOL_TURN_GUIDANCE = [
  "You have a platform FAQ lookup tool available. Call it when the caller asks something factual about the product or how it works that isn't already covered by WHAT THE PRODUCT IS / CURRENT PLANS above — never guess, and never call it for something you can already answer from those.",
  "This is a LIVE phone call — call at most one or two times, only when genuinely needed.",
  "Once you have what you need (or decide no lookup is needed), respond with your FINAL turn as the JSON object described above and NOTHING else.",
].join("\n")

/** PURE: parse the model's turn output — malformed JSON degrades to a safe
 *  'continue' with a clarifying line, never a crash mid-call. Handles the
 *  UNION of both deployments' action vocabularies (lane 75D — the ONE parser
 *  both tenant and platform turns run through; a tenant deployment's own
 *  TURN_INSTRUCTIONS never asks for 'prospect' and vice versa, so in
 *  practice each deployment only ever produces its own subset here). */
export function parseTurnPlan(raw: string): VoiceTurnPlan {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("no json")
    const p = JSON.parse(match[0]) as {
      say?: string; action?: string; date_time?: string; address?: string
      callback_phone?: string; callback_when?: string; callback_reason?: string
      name?: string; email?: string; company?: string; role_interest?: string; note?: string
    }
    const say = (p.say ?? "").trim().slice(0, 600)
    if (!say) throw new Error("empty say")
    const a = (p.action ?? "continue").toLowerCase()
    if (a === "transfer") return { say, action: { kind: "transfer" } }
    if (a === "hangup") return { say, action: { kind: "hangup" } }
    if (a === "book" && p.date_time && !Number.isNaN(new Date(p.date_time).getTime())) {
      return { say, action: { kind: "book", dateTime: new Date(p.date_time).toISOString() } }
    }
    // rsvp needs a real address to match a listing; without one it degrades to
    // continue (the model is told to include it — garbage never RSVPs).
    if (a === "rsvp" && (p.address ?? "").trim().length >= 4) {
      return { say, action: { kind: "rsvp", address: (p.address as string).trim().slice(0, 200) } }
    }
    if (a === "seller_lead") {
      return { say, action: { kind: "seller_lead", address: (p.address ?? "").trim().slice(0, 200) || null } }
    }
    // callback needs a real WHEN — a caller-back promise with no time to act on
    // it is not a callback, it degrades to continue (never a task with no due
    // time; garbage never books a call the ISA will actually place).
    const whenPhrase = (p.callback_when ?? "").trim().slice(0, 120)
    if (a === "callback" && whenPhrase.length >= 2) {
      return {
        say,
        action: {
          kind: "callback",
          phone: (p.callback_phone ?? "").trim().slice(0, 30) || null,
          whenPhrase,
          reason: (p.callback_reason ?? "").trim().slice(0, 200) || null,
        },
      }
    }
    // PLATFORM deployment only (lane 75D merge — see PLATFORM_TURN_INSTRUCTIONS
    // above, formerly parsePlatformTurnPlan in lib/voice/platform-reception.ts).
    // A garbage email is dropped rather than stored; role_interest is
    // normalized to the growth funnel's own CHECK vocabulary, never a second
    // list (CLAUDE.md §6).
    if (a === "prospect") {
      const email = (p.email ?? "").trim().toLowerCase()
      const role = (p.role_interest ?? "unknown").trim().toLowerCase()
      return {
        say,
        action: {
          kind: "prospect",
          name: (p.name ?? "").trim().slice(0, 120) || null,
          email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 200) : null,
          company: (p.company ?? "").trim().slice(0, 160) || null,
          roleInterest: (PROSPECT_ROLES as readonly string[]).includes(role) ? role : "unknown",
          note: (p.note ?? "").trim().slice(0, 400) || null,
        },
      }
    }
    return { say, action: { kind: "say" } }
  } catch {
    return { say: "Sorry — could you say that once more?", action: { kind: "say" } }
  }
}

/** PURE: rebuild the model's message history from the running transcript
 *  (serverless: no in-memory session — the voice_calls row IS the state). */
export function transcriptToMessages(transcript: string | null | undefined): Array<{ role: "assistant" | "user"; content: string }> {
  const out: Array<{ role: "assistant" | "user"; content: string }> = []
  for (const line of (transcript ?? "").split("\n")) {
    const m = line.match(/^(AI|Caller):\s*(.+)$/)
    if (!m) continue
    out.push({ role: m[1] === "AI" ? "assistant" : "user", content: m[2] })
  }
  return out.slice(-24) // last 12 exchanges — plenty for a reception call
}

/** PURE: append one exchange to the running transcript. */
export function appendTranscript(transcript: string | null | undefined, caller: string | null, ai: string): string {
  const parts = [transcript?.trim() || null, caller ? `Caller: ${caller}` : null, `AI: ${ai}`].filter(Boolean)
  return parts.join("\n").slice(-20_000)
}

// ── TwiML composition (pure string builders — no SDK needed server-side) ─────

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** PURE: a speak-then-listen TwiML turn. */
export function twimlGatherTurn(say: string, actionUrl: string, voice = "Polly.Joanna-Neural"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" language="en-US"><Say voice="${voice}">${xmlEscape(say)}</Say></Gather><Say voice="${voice}">Are you still there?</Say><Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" language="en-US"/><Hangup/></Response>`
}

/** PURE: speak then transfer to the human. */
export function twimlTransfer(say: string, forwardNumber: string, voice = "Polly.Joanna-Neural"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}">${xmlEscape(say)}</Say><Dial>${xmlEscape(forwardNumber)}</Dial></Response>`
}

/** PURE: speak then end. */
export function twimlHangup(say: string, voice = "Polly.Joanna-Neural"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}">${xmlEscape(say)}</Say><Hangup/></Response>`
}

/** PURE: play a pre-rendered audio clip (a hostRenderedMedia public mp3 URL —
 *  Twilio's <Play> verb fetches it UNAUTHENTICATED, so it must be that public
 *  URL, never the tenant-scoped recording-playback proxy) then end the call.
 *  wave 58: the AMD-voicemail path plays a realistic ElevenLabs-rendered
 *  clip instead of Twilio-native <Say> when one was rendered — see
 *  lib/voice/render-voice-drop.ts and its caller in
 *  app/api/voice/twilio/outbound/route.ts. */
export function twimlPlay(audioUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${xmlEscape(audioUrl)}</Play><Hangup/></Response>`
}
