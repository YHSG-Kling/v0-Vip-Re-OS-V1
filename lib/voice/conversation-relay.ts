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
//
// ── WAVE 57: TTS PROVIDER (owner ruling, verbatim: "if voice between
// ── elevenlabs or twilio") ───────────────────────────────────────────────────
// RESEARCH (Exa, 2026-09-11): docs.twilio.com/voice/twiml/connect/
// conversationrelay and docs.twilio.com/voice/conversationrelay/
// voice-configuration — <ConversationRelay> takes `ttsProvider` ("Google" |
// "Amazon" | "ElevenLabs") and `voice`. ElevenLabs' own voice id is used
// directly; ElevenLabs-specific tuning rides IN the voice string itself, one
// hyphen-joined suffix: `<voiceId>-<model>-<speed>_<stability>_<similarity>`
// (docs' own worked example: "XrExE9yKIg1WjnnlVkGX-1.2_0.6_0.8" sets speed
// 1.2/stability 0.6/similarity 0.8; a model id can be inserted before the
// numbers — "ZF6FPAbjXT4488VcRRnw-flash_v2_5-1.2_1.0_1.0", from Twilio's own
// ElevenLabs-integration blog, 2025-05-29). Supported model suffixes:
// `flash_v2`, `turbo_v2_5`, `turbo_v2`, and the default `flash_v2_5` — the
// SAME model elevenLabsModelForLane("phone_realtime") already selects
// (lib/video/realism-profile.ts), so conversationRelayTtsAttrs derives the
// Twilio-format suffix from that ONE selector rather than a second hardcoded
// "flash_v2_5" string (§6). `elevenlabsTextNormalization` (on/auto/off,
// TwiML default "off") has a ConversationRelay-SPECIFIC quirk the direct
// ElevenLabs API does not share: "auto has the same effect as off for
// Conversation Relay voice calls" — so this file sets it to "on" explicitly
// (a real-estate call speaks prices/dates/addresses that need normalizing),
// rather than forwarding this repo's direct-API ELEVENLABS_TEXT_NORMALIZATION
// ("auto") which would silently mean OFF here.
//
// ElevenLabs is this repo's ONLY storable voice_provider (the live CHECK
// constraint — scripts/vendor-retirement-guard.ts: "voice_provider vocabulary
// is ElevenLabs only, matching the live CHECK") — so this is not a per-tenant
// choice to wire, only a missing WIRE: InboundIdentity.elevenlabsVoiceId was
// already resolved from ai_identity_profiles by lib/voice/twilio-voice.ts's
// resolveInboundContext, but nothing downstream ever read it — the phone
// lane spoke Twilio-native Google/Amazon voices regardless. The ONLY runtime
// fallback to Google is when ElevenLabs itself is unreachable (no
// ELEVENLABS_API_KEY) — never a vendor preference.

import { elevenLabsModelForLane, ELEVENLABS_REALISM_VOICE_SETTINGS } from "@/lib/video/realism-profile"

/** Platform STOCK ElevenLabs voice (Rachel) — the SAME id as FALLBACK_VOICE_ID
 *  in lib/voice/elevenlabs-tts.ts, duplicated here (established pattern —
 *  see lib/video/module-voice.ts's STOCK_VIDEO_VOICE_ID for the identical
 *  reasoning) because that module `import "server-only"`s and this one is
 *  imported by plain-tsx simulators (scripts/voice-lane-simulator.ts) that
 *  are not run inside Next's server runtime. */
const FALLBACK_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Is the streaming lane configured? (The transport switch — never a stub.) */
export function relayConfigured(env: { CONVERSATION_RELAY_WSS_URL?: string; RELAY_SHARED_SECRET?: string } = process.env as any): boolean {
  return !!(env.CONVERSATION_RELAY_WSS_URL ?? "").startsWith("wss://") && !!(env.RELAY_SHARED_SECRET ?? "").trim()
}

/** The pre-wave-57 default voice — kept as the ONE fallback literal (§6) so
 *  twimlConnectRelay's own default param and conversationRelayTtsAttrs' no-
 *  ElevenLabs-key fallback can never drift into two different spellings. */
export const DEFAULT_CONVERSATION_RELAY_GOOGLE_VOICE = "en-US-Journey-O"

export interface ConversationRelayTtsAttrs {
  ttsProvider: "ElevenLabs" | "Google"
  voice: string
  /** Present only when ttsProvider is "ElevenLabs" — Google has no such attribute. */
  elevenlabsTextNormalization?: "on"
}

/** speed multiplier inside the ElevenLabs voice-string suffix. 1.0 = ElevenLabs'
 *  own default (unchanged) — no research basis found to deviate for phone. */
const CONVERSATION_RELAY_ELEVENLABS_SPEED = 1.0

/** Strip the "eleven_" prefix — Twilio's ElevenLabs voice-string model suffix
 *  omits it ("flash_v2_5", not "eleven_flash_v2_5"). PURE. */
function twilioElevenLabsModelSuffix(modelId: string): string {
  return modelId.replace(/^eleven_/, "")
}

/**
 * conversationRelayTtsAttrs — PURE. The ttsProvider/voice[/elevenlabsText
 * Normalization] TwiML attributes for <ConversationRelay> — see the file
 * header for the full research. ElevenLabs (the resolved brokerage/team/
 * agent clone id, else the same stock ElevenLabs voice every other realism-
 * tuned caller falls back to — lib/voice/elevenlabs-tts.ts's FALLBACK_VOICE_ID,
 * never a second literal) when an ElevenLabs API key is configured; Twilio-
 * native Google otherwise — the ONE runtime fallback, gated on reachability,
 * never a vendor preference.
 */
export function conversationRelayTtsAttrs(
  elevenlabsVoiceId: string | null | undefined,
  env: { ELEVENLABS_API_KEY?: string } = process.env as any,
): ConversationRelayTtsAttrs {
  if (!(env.ELEVENLABS_API_KEY ?? "").trim()) {
    return { ttsProvider: "Google", voice: DEFAULT_CONVERSATION_RELAY_GOOGLE_VOICE }
  }
  const voiceId = (elevenlabsVoiceId ?? "").trim() || FALLBACK_VOICE_ID
  const model = twilioElevenLabsModelSuffix(elevenLabsModelForLane("phone_realtime"))
  const { stability, similarity_boost: similarity } = ELEVENLABS_REALISM_VOICE_SETTINGS
  return {
    ttsProvider: "ElevenLabs",
    voice: `${voiceId}-${model}-${CONVERSATION_RELAY_ELEVENLABS_SPEED}_${stability}_${similarity}`,
    elevenlabsTextNormalization: "on",
  }
}

/** PURE: TwiML that hands the call to the relay companion. The welcome
 *  greeting carries the SAME disclosed first message as the Gather lane —
 *  the legal shield is transport-independent. An Intelligence Service sid
 *  (Twilio Conversational Intelligence) attaches native transcription +
 *  language operators to the session — env-gated, never fabricated.
 *  `ttsProvider`/`elevenlabsTextNormalization` are ADDITIVE and OPTIONAL — a
 *  caller that omits them (as every pre-wave-57 caller does) gets the exact
 *  same XML shape as before; pass conversationRelayTtsAttrs' output to opt a
 *  call into ElevenLabs. */
export function twimlConnectRelay(
  wssUrl: string,
  welcomeGreeting: string,
  voice = DEFAULT_CONVERSATION_RELAY_GOOGLE_VOICE,
  intelligenceServiceSid?: string | null,
  ttsProvider?: string | null,
  elevenlabsTextNormalization?: "on" | "off" | null,
): string {
  const intel = (intelligenceServiceSid ?? "").trim()
  const provider = (ttsProvider ?? "").trim()
  const norm = (elevenlabsTextNormalization ?? "").trim()
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay url="${xmlEscape(wssUrl)}" welcomeGreeting="${xmlEscape(welcomeGreeting.slice(0, 500))}" voice="${xmlEscape(voice)}"${provider ? ` ttsProvider="${xmlEscape(provider)}"` : ""}${norm ? ` elevenlabsTextNormalization="${xmlEscape(norm)}"` : ""} dtmfDetection="true" interruptible="true"${intel ? ` intelligenceService="${xmlEscape(intel)}"` : ""}/></Connect></Response>`
}

// ── Companion-side protocol (pure — unit-tested here, executed by the relay) ─
//
// NOT AN ORPHAN (wave 26, orphan-export ledger): parseRelayFrame / relaySpeak /
// relayEnd have no in-app caller BY CONSTRUCTION. The code that executes this
// protocol is tools/relay-companion/server.mjs (frames at :42-68) — a plain-JS
// process deployed wherever a WebSocket can be held, which cannot import this
// TS module. These three are the typed, unit-tested SPEC of that companion
// (scripts/voice-lane-simulator.ts:178-181); the .mjs is its executable twin.
// Change one, change both.

export type RelayInbound =
  | { type: "setup"; callSid: string; from: string; to: string }
  | { type: "prompt"; voicePrompt: string; last: boolean }
  | { type: "interrupt" }
  | { type: "dtmf"; digit: string }
  | { type: "error"; description: string }
  | { type: "unknown" }

/** PURE: parse one relay WebSocket frame — malformed frames become 'unknown',
 *  never a crash mid-call. */
/** @proofSeam typed spec for tools/relay-companion/server.mjs (plain JS, cannot import TS); see NOT AN ORPHAN note above */
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

/** PURE: the speak frame.
 *  @proofSeam typed spec for tools/relay-companion/server.mjs (plain JS, cannot import TS); see NOT AN ORPHAN note above */
export function relaySpeak(text: string): string {
  return JSON.stringify({ type: "text", token: text.slice(0, 1000), last: true })
}

/** PURE: the end frame (optionally carrying handoff context Twilio returns on the action URL).
 *  @proofSeam typed spec for tools/relay-companion/server.mjs (plain JS, cannot import TS); see NOT AN ORPHAN note above */
export function relayEnd(handoffData?: Record<string, unknown>): string {
  return JSON.stringify(handoffData ? { type: "end", handoffData: JSON.stringify(handoffData) } : { type: "end" })
}

// ── The plan-endpoint contract (companion → app) ─────────────────────────────

export interface RelayPlanRequest {
  callSid: string
  to: string
  from: string
  utterance: string
  /** How many times the caller has barged in over TTS this session — the
   *  companion counts {type:"interrupt"} frames; the brain paces to it. */
  interrupts: number
}

/** PURE: barge-in pacing — a caller who keeps talking over the AI wants
 *  SHORTER answers, not repeated ones. Empty at zero (no prompt noise). */
export function composePacingRule(interrupts: number): string {
  if (interrupts <= 0) return ""
  if (interrupts === 1) return "PACING: The caller just talked over you — they move fast. Answer in ONE short sentence, then stop and listen."
  return `PACING: The caller has interrupted ${interrupts} times — strip every reply to its shortest useful form (one short sentence, no preamble), and let them drive.`
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
  const interrupts = Number(body.interrupts)
  return { callSid, to, from, utterance: utterance.slice(0, 2000), interrupts: Number.isFinite(interrupts) && interrupts > 0 ? Math.min(Math.round(interrupts), 20) : 0 }
}
