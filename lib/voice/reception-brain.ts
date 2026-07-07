// lib/voice/reception-brain.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE RECEPTION BRAIN — engine-agnostic. One prompt + one turn-planner that any
// voice engine consumes: the Twilio-native lane (turn-based <Gather> → AI →
// TwiML, pure serverless) today, and whatever streams tomorrow. Extracted from
// the Vapi assistant builder so the OWNER'S migration (Twilio-first, Vapi
// sunset) swaps ENGINES, never brains: same identity, same legal preamble,
// same hour-aware behavior, same capability-gated actions.

import { withAiCallDisclosures } from "@/lib/communication/call-disclosures"
import { composeBusinessHoursRule, type InboundIdentity } from "@/lib/voice/vapi-numbers"

/** PURE: the reception system prompt from the tenant's AI identity — shared by
 *  every engine. Mirrors the Vapi builder's rules exactly (one brain). */
export function buildReceptionPrompt(id: InboundIdentity): { name: string; firstMessage: string; systemPrompt: string } {
  const office = id.brokerageName ?? "the office"
  const who = id.agentName ? `${id.agentName}'s office at ${office}` : office
  const name = (id.assistantName ?? "Reception Assistant").slice(0, 40)
  const rawFirst = (id.welcomeMessage ?? `Thanks for calling ${who} — I'm ${name}, the AI assistant. How can I help you today?`).slice(0, 300)
  const firstMessage = withAiCallDisclosures(rawFirst, { recorded: true })
  const prohibited = (id.prohibitedLanguage ?? []).filter(Boolean).slice(0, 20)

  const systemPrompt = [
    `You are ${name}, the AI reception assistant answering inbound phone calls for ${who}.`,
    id.tone ? `Tone: ${id.tone}.` : "Tone: warm, professional, concise.",
    "Your job on every call: (1) learn who is calling and get a callback number; (2) find out what they need — buying, selling, a showing, or a question on a specific property; (3) offer to book an appointment or a showing; (4) if they ask for the agent directly or the matter is urgent, offer to transfer.",
    "HARD RULES: Never give legal, lending, or tax advice — offer to have the agent follow up. Never discuss the demographics of any neighborhood or steer callers toward or away from areas (Fair Housing). Never invent property details, prices, or availability — if you don't know, say the agent will confirm. Never promise a commission rate or contract terms.",
    prohibited.length > 0 ? `Never use these phrases: ${prohibited.join("; ")}.` : "",
    composeBusinessHoursRule(id.answerMode, id.businessHours),
    "If the caller asks to stop being contacted, acknowledge it clearly and end politely — their request is recorded.",
    "If the caller asks whether you are an AI or a robot, confirm honestly and immediately — never pretend to be human.",
    "Keep answers short — this is a phone call, not an essay.",
  ].filter(Boolean).join("\n")

  return { name, firstMessage, systemPrompt }
}

// ── Turn planning (the Twilio turn-based lane) ────────────────────────────────

export type VoiceTurnAction =
  | { kind: "say" }                                     // keep talking
  | { kind: "transfer" }                                // dial the human
  | { kind: "book"; dateTime: string }                  // book appointment/showing
  | { kind: "hangup" }                                  // caller done

export interface VoiceTurnPlan {
  say: string
  action: VoiceTurnAction
}

/** The JSON contract the model must return each turn. */
export const TURN_INSTRUCTIONS = [
  "Respond with JSON ONLY, no prose around it:",
  '{ "say": "<what you speak next — one to three short sentences>",',
  '  "action": "continue" | "transfer" | "book" | "hangup",',
  '  "date_time": "<ISO 8601, ONLY when action is book>" }',
  "Rules: action 'transfer' when the caller asks for the agent / is urgent / office-hours rule says so.",
  "action 'book' ONLY after the caller has confirmed a specific date and time out loud.",
  "action 'hangup' when the caller says goodbye or the call is complete — say a warm close first.",
  "Otherwise action 'continue'.",
].join("\n")

/** PURE: parse the model's turn output — malformed JSON degrades to a safe
 *  'continue' with a clarifying line, never a crash mid-call. */
export function parseTurnPlan(raw: string): VoiceTurnPlan {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error("no json")
    const p = JSON.parse(match[0]) as { say?: string; action?: string; date_time?: string }
    const say = (p.say ?? "").trim().slice(0, 600)
    if (!say) throw new Error("empty say")
    const a = (p.action ?? "continue").toLowerCase()
    if (a === "transfer") return { say, action: { kind: "transfer" } }
    if (a === "hangup") return { say, action: { kind: "hangup" } }
    if (a === "book" && p.date_time && !Number.isNaN(new Date(p.date_time).getTime())) {
      return { say, action: { kind: "book", dateTime: new Date(p.date_time).toISOString() } }
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
