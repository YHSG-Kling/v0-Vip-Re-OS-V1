// lib/voice/conversation-relay.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATIONRELAY — Twilio's newest conversational-voice transport (real-time
// streaming STT/TTS over one WebSocket; sub-second turn latency vs the
// <Gather> lane's post-utterance round-trip). ARCHITECTURE FACT: a
// ConversationRelay session is a PERSISTENT WebSocket, which pure Vercel
// functions cannot host — so the split is: ALL BRAINS AND GATES STAY IN THIS
// APP (the secret-gated /api/voice/relay/plan endpoint runs the same scope
// resolution, prompts, TCPA/opt-out honor, booking/prospect side-effects as
// the turn webhook), and a THIN COMPANION relay server (tools/relay-companion,
// ~90 lines, deploy anywhere that holds a socket) just moves text between
// Twilio and that endpoint. Engine-agnostic by design: the same reception/
// outbound/platform brains serve BOTH transports — set
// CONVERSATION_RELAY_WSS_URL and inbound answers upgrade to streaming; unset
// it and the serverless <Gather> lane keeps working. No stub: with the env
// absent this module is simply not selected.
//
// Protocol (Twilio → server): {type:"setup", callSid, from, to, customParameters}
//   then {type:"prompt", voicePrompt, last} per caller utterance,
//   {type:"interrupt"...}, {type:"dtmf"...}, {type:"error"...}.
// (Server → Twilio): {type:"text", token, last} to speak,
//   {type:"end"} (with optional handoffData) to end the session.

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Is the streaming lane configured? (The transport switch — never a stub.) */
export function relayConfigured(env: { CONVERSATION_RELAY_WSS_URL?: string; RELAY_SHARED_SECRET?: string } = process.env as any): boolean {
  return !!(env.CONVERSATION_RELAY_WSS_URL ?? "").startsWith("wss://") && !!(env.RELAY_SHARED_SECRET ?? "").trim()
}

/** PURE: TwiML that hands the call to the relay companion. The welcome
 *  greeting carries the SAME disclosed first message as the Gather lane —
 *  the legal shield is transport-independent. */
export function twimlConnectRelay(wssUrl: string, welcomeGreeting: string, voice = "en-US-Journey-O"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay url="${xmlEscape(wssUrl)}" welcomeGreeting="${xmlEscape(welcomeGreeting.slice(0, 500))}" voice="${xmlEscape(voice)}" dtmfDetection="true" interruptible="true"/></Connect></Response>`
}

// ── Companion-side protocol (pure — unit-tested here, executed by the relay) ─

export type RelayInbound =
  | { type: "setup"; callSid: string; from: string; to: string }
  | { type: "prompt"; voicePrompt: string; last: boolean }
  | { type: "interrupt" }
  | { type: "dtmf"; digit: string }
  | { type: "error"; description: string }
  | { type: "unknown" }

/** PURE: parse one relay WebSocket frame — malformed frames become 'unknown',
 *  never a crash mid-call. */
export function parseRelayFrame(raw: string): RelayInbound {
  try {
    const p = JSON.parse(raw)
    if (p?.type === "setup" && typeof p.callSid === "string") {
      return { type: "setup", callSid: p.callSid, from: String(p.from ?? ""), to: String(p.to ?? "") }
    }
    if (p?.type === "prompt" && typeof p.voicePrompt === "string") {
      return { type: "prompt", voicePrompt: p.voicePrompt, last: p.last !== false }
    }
    if (p?.type === "interrupt") return { type: "interrupt" }
    if (p?.type === "dtmf") return { type: "dtmf", digit: String(p.digit ?? "") }
    if (p?.type === "error") return { type: "error", description: String(p.description ?? "") }
    return { type: "unknown" }
  } catch {
    return { type: "unknown" }
  }
}

/** PURE: the speak frame. */
export function relaySpeak(text: string): string {
  return JSON.stringify({ type: "text", token: text.slice(0, 1000), last: true })
}

/** PURE: the end frame (optionally carrying handoff context Twilio returns on the action URL). */
export function relayEnd(handoffData?: Record<string, unknown>): string {
  return JSON.stringify(handoffData ? { type: "end", handoffData: JSON.stringify(handoffData) } : { type: "end" })
}

// ── The plan-endpoint contract (companion → app) ─────────────────────────────

export interface RelayPlanRequest {
  callSid: string
  to: string
  from: string
  utterance: string
}

export interface RelayPlanResponse {
  say: string
  /** true → the companion sends relayEnd after speaking. */
  endSession: boolean
  /** set → the app has already re-pointed the live call (REST) to dial a human. */
  transferred?: boolean
}

/** PURE: validate the companion's plan request body. */
export function parseRelayPlanRequest(body: any): RelayPlanRequest | null {
  if (!body || typeof body !== "object") return null
  const callSid = String(body.callSid ?? "").trim()
  const to = String(body.to ?? "").trim()
  const from = String(body.from ?? "").trim()
  const utterance = String(body.utterance ?? "").trim()
  if (!callSid || !to || !from || !utterance) return null
  return { callSid, to, from, utterance: utterance.slice(0, 2000) }
}
