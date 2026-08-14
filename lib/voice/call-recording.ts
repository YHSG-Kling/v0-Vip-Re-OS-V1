// lib/voice/call-recording.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CALL-RECORDING PRODUCER — the writer `voice_calls.recording_url` never had.
//
// ── WHAT WAS ACTUALLY MISSING ────────────────────────────────────────────────
// Seven UI surfaces read `voice_calls.recording_url` and render a player or a
// link (app/dashboard/voice/review/[callId], /dashboard/voice,
// /dashboard/voice-intelligence, /dashboard/isa, the communications-intelligence
// VoiceTab, VoiceCallHistoryTable, IntelligenceClient). NOTHING in the repo ever
// wrote the column: no `<Record>`, no Record parameter on the dial, no
// RecordingStatusCallback. The players were real markup over a column that
// could not fill. This module is the missing half.
//
// ── THE POSTURE: OPT-IN PER BROKERAGE, DEFAULT OFF ───────────────────────────
// Recording is NOT switched on globally, for one reason that is not stylistic:
// eleven-to-thirteen states are ALL-PARTY consent, this product carries a TCPA
// surface, and a brokerage's own broker — not the platform — is the party who
// answers for a recorded conversation. So the flag lives per tenant on
// `brokerage_settings.settings.call_recording.enabled`, DEFAULT OFF, exactly the
// shape lib/kernel/self-book.ts and lib/kernel/vendor-orchestration.ts already
// use for opt-in governance (jsonb bag, no migration, no new table).
//
// ── THE COUPLING INVARIANT (why the disclosure question is settled here) ─────
// The uniform national posture in lib/communication/call-disclosures.ts already
// announces recording on EVERY live AI call — buildReceptionPrompt (inbound),
// buildOutboundPrompt (outbound), and buildPlatformReceptionPrompt all pass
// `{ recorded: true }` today. That announcement is deliberately hedged ("may be
// recorded"), which is the standard formula, and announcing on every call
// removes the per-state-lookup failure mode.
//
// So the honest rule is a SUPERSET relation, not an equality:
//
//     ANNOUNCED ⊇ RECORDED
//
// Announcing recording we do not perform is conservative and harms nobody.
// Recording without announcing is the actual legal harm. `disclosureCoversRecording`
// below states that invariant as a pure predicate so it can be asserted rather
// than hoped for.
//
// The ONE place the codebase violated the invariant was
// lib/voice/twilio-outbound.ts:composeVoicemailMessage, which hardcoded
// `{ recorded: false }` — with recording armed, an AMD voicemail leg IS captured
// by Twilio's Record parameter, so that message would have been the single
// spoken output claiming the call was not recorded while it was. That option is
// now REQUIRED and policy-derived; no call site can silently reinstate the lie.
//
// ── WHY THE STORED URL IS NOT THE URL THE BROWSER PLAYS ──────────────────────
// Twilio serves recording media from
// `api.twilio.com/2010-04-01/Accounts/<AccountSid>/Recordings/<RecordingSid>`
// behind HTTP Basic auth (account SID + auth token). A browser `<audio src>`
// pointed straight at it gets 401 — so simply landing the vendor URL in the
// column would have produced seven players that render and never play.
// Therefore:
//   · `voice_calls.recording_url` stores the VENDOR TRUTH (the api.twilio.com
//     URL). That is what lib/security/audio-source-allowlist.ts rule 3 admits
//     and what app/actions/ai-voice-transcription.ts must fetch.
//   · The BROWSER plays `recordingPlaybackPath(voiceCallId)` — a same-origin,
//     session-authenticated, tenant-scoped streaming proxy
//     (app/api/voice/recording/[callId]/route.ts) that resolves the tenant's own
//     Twilio credentials server-side. The auth token never reaches the client.
//
// THAT HELPER DOES NOT LIVE HERE. It lives alone in
// lib/voice/recording-playback-path.ts, because every player that needs it is a
// CLIENT component and this module is server-side — it reaches the connector
// gateway and reads brokerage settings. An identical copy used to be exported
// from here as well, and every consumer imported THAT one, so the client-safe
// module had zero importers while browser bundles pulled this file in for a
// string. The copy is gone; the client-safe module is the single survivor.

import { checkAudioSourceUrl, platformAudioHostRules } from "@/lib/security/audio-source-allowlist"
import { hasRecordingDisclosure } from "@/lib/communication/call-disclosures"

/** The jsonb key on `brokerage_settings.settings` that carries the opt-in. */
export const CALL_RECORDING_SETTINGS_KEY = "call_recording"

export interface CallRecordingPolicy {
  /** Is call recording armed for this brokerage? Default false. */
  enabled: boolean
  /** Why the policy reads the way it does — carried into logs so an operator
   *  asking "why is there no recording" gets an answer, not a shrug. */
  reason: string
}

/** The default every unknown / unreadable / unconfigured path resolves to.
 *  FAILS CLOSED TOWARD NOT RECORDING: a refused settings read must never be
 *  read as "sure, record them". */
export const CALL_RECORDING_OFF: CallRecordingPolicy = {
  enabled: false,
  reason: "call recording is not enabled for this brokerage (brokerage_settings.settings.call_recording.enabled)",
}

/**
 * PURE: read the opt-in out of a `brokerage_settings.settings` jsonb bag.
 * Accepts both the nested object form (`{ call_recording: { enabled: true } }`)
 * and the bare boolean (`{ call_recording: true }`), matching the tolerance
 * lib/kernel/vendor-orchestration.ts:readStagingEnabled established.
 */
export function readCallRecordingPolicy(settings: unknown): CallRecordingPolicy {
  if (!settings || typeof settings !== "object") return CALL_RECORDING_OFF
  const raw = (settings as Record<string, unknown>)[CALL_RECORDING_SETTINGS_KEY]
  const flag =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).enabled
      : raw
  const enabled = flag === true || flag === "true" || flag === 1
  return enabled
    ? { enabled: true, reason: "brokerage opted in to call recording (brokerage_settings.settings.call_recording.enabled)" }
    : CALL_RECORDING_OFF
}

/**
 * Resolve the brokerage's recording posture.
 *
 * supabase-js RESOLVES a refused query — `const { data }` alone would read
 * "permission denied" as "no settings row", which here would silently mean
 * "recording off". That happens to be the SAFE direction, but a silent wrong
 * answer is still a wrong answer, so the error is destructured, logged, and
 * named in the reason.
 */
export async function resolveCallRecordingPolicy(
  svc: any,
  brokerageId: string,
): Promise<CallRecordingPolicy> {
  const { data, error } = await svc
    .from("brokerage_settings")
    .select("settings")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (error) {
    console.error(
      `[call-recording] brokerage_settings read REFUSED for brokerage ${brokerageId} — treating recording as OFF (not as "no opt-in"): ${error.message}`,
    )
    return {
      enabled: false,
      reason: `brokerage_settings could not be read (${error.message}) — recording stays off rather than guessed`,
    }
  }
  return readCallRecordingPolicy((data as { settings?: unknown } | null)?.settings)
}

/**
 * PURE — THE COUPLING INVARIANT, as a predicate.
 *
 *   disclosureCoversRecording(spokenFirstMessage, policy)
 *
 * is true when the message announces recording OR recording is not armed. It is
 * false in exactly one situation: the call is being recorded and nothing spoken
 * said so. That is the state this module exists to make unreachable.
 */
export function disclosureCoversRecording(
  spokenMessage: string,
  policy: CallRecordingPolicy,
): boolean {
  return !policy.enabled || hasRecordingDisclosure(spokenMessage)
}

/** PURE: the absolute webhook URL Twilio posts recording status to. */
export function recordingCallbackUrl(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/$/, "")}/api/voice/twilio/recording`
}

/**
 * PURE: the extra Twilio form parameters that arm recording on a dial
 * (POST /Calls.json). Returns an EMPTY object when the brokerage has not opted
 * in — so the caller spreads it unconditionally and a non-opted tenant's dial
 * body is byte-identical to what it was before this module existed.
 *
 *   RecordingChannels "dual"  — caller and callee on separate channels, which is
 *                               what makes speaker-attributed transcription
 *                               possible downstream.
 *   RecordingTrack    "both"  — record both directions, not just the inbound leg.
 *   ...CallbackEvent          — "completed absent": we want to hear about a
 *                               recording that produced NO audio too, so the
 *                               webhook can log the absence instead of the row
 *                               silently never getting a URL.
 */
export function recordingDialParams(
  policy: CallRecordingPolicy,
  appBaseUrl: string,
): Record<string, string> {
  if (!policy.enabled) return {}
  return {
    Record: "true",
    RecordingChannels: "dual",
    RecordingTrack: "both",
    RecordingStatusCallback: recordingCallbackUrl(appBaseUrl),
    RecordingStatusCallbackMethod: "POST",
    RecordingStatusCallbackEvent: "completed absent",
  }
}

export type RecordingCallbackParse =
  | {
      ok: true
      callSid: string
      recordingSid: string
      /** The vendor URL, normalized to an explicit `.mp3` — see normalizeRecordingUrl. */
      recordingUrl: string
      durationSeconds: number | null
    }
  | { ok: false; reason: string }

/**
 * PURE: normalize Twilio's `RecordingUrl` to an explicit media format.
 *
 * Twilio posts an EXTENSIONLESS resource URL. Fetched bare it negotiates to WAV;
 * with `.mp3` it serves mp3. Both the browser proxy and
 * app/actions/ai-voice-transcription.ts fetch whatever is in the column, so the
 * column must name ONE format rather than leave it to content negotiation —
 * otherwise "what is in recording_url" is a different file depending on who asks.
 * mp3 is chosen: an order of magnitude smaller over the wire and playable by
 * every browser `<audio>` implementation.
 */
export function normalizeRecordingUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  return /\.(mp3|wav)$/i.test(trimmed) ? trimmed : `${trimmed}.mp3`
}

/**
 * PURE: validate + parse a Twilio RecordingStatusCallback body.
 *
 * The URL is checked against THE SAME host allowlist the transcription action
 * uses to decide what it may fetch (lib/security/audio-source-allowlist.ts).
 * That is deliberate and load-bearing: this webhook is the only writer of a
 * column that a LATER server-side fetch dereferences, so an attacker-controlled
 * or merely surprising RecordingUrl must be refused at the WRITE, not only at
 * the read. Writing a host the reader would refuse would produce a row whose
 * player and whose transcription both fail with no explanation.
 */
export function parseRecordingCallback(
  params: Record<string, string>,
  rules = platformAudioHostRules(),
): RecordingCallbackParse {
  const callSid = (params.CallSid ?? "").trim()
  const status = (params.RecordingStatus ?? "").trim().toLowerCase()
  const recordingSid = (params.RecordingSid ?? "").trim()
  const rawUrl = (params.RecordingUrl ?? "").trim()

  if (!callSid) return { ok: false, reason: "callback carried no CallSid" }
  if (status === "absent") {
    return { ok: false, reason: `Twilio reported RecordingStatus=absent for call ${callSid} — the call produced no audio; nothing to store` }
  }
  if (status !== "completed") {
    return { ok: false, reason: `RecordingStatus="${status || "(missing)"}" is not a terminal completed recording — ignored` }
  }
  if (!rawUrl) return { ok: false, reason: `completed recording for call ${callSid} carried no RecordingUrl` }

  const recordingUrl = normalizeRecordingUrl(rawUrl)
  const verdict = checkAudioSourceUrl(recordingUrl, rules)
  if (!verdict.allowed) {
    return {
      ok: false,
      reason: `RecordingUrl refused by the audio-source allowlist (${verdict.reason}): ${verdict.detail} — refusing to store a URL the transcription reader would refuse to fetch`,
    }
  }

  const durationRaw = Number.parseInt(params.RecordingDuration ?? "", 10)
  return {
    ok: true,
    callSid,
    recordingSid,
    recordingUrl,
    durationSeconds: Number.isFinite(durationRaw) ? durationRaw : null,
  }
}

/**
 * Arm recording on an ALREADY-LIVE call.
 *
 * The outbound lane arms recording at dial time (a Record parameter on
 * POST /Calls.json — free, no extra round trip). The INBOUND lane cannot: its
 * answer is TwiML, and `<Gather>` has no record attribute — `<Record>` is a
 * blocking single-shot verb that would replace the conversation rather than
 * capture it. Twilio's supported way to record a `<Gather>`-driven inbound call
 * is to create a Recording resource against the live call, which is this.
 *
 * Costs ONE Twilio round trip on the answer path, and only for a brokerage that
 * opted in. Returns honestly — a failure is a call that is NOT being recorded,
 * and the caller logs it rather than assuming success.
 */
export async function startCallRecording(
  svc: any,
  brokerageId: string,
  callSid: string,
  appBaseUrl: string,
): Promise<{ ok: true; recordingSid: string | null } | { ok: false; error: string }> {
  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, brokerageId)
  if (!creds) return { ok: false, error: "Twilio not configured for this tenant — the call is NOT being recorded" }

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ sid?: string }>({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/Calls/${encodeURIComponent(callSid)}/Recordings.json`,
    method: "POST",
    bodyType: "form",
    body: {
      RecordingChannels: "dual",
      RecordingTrack: "both",
      RecordingStatusCallback: recordingCallbackUrl(appBaseUrl),
      RecordingStatusCallbackMethod: "POST",
      RecordingStatusCallbackEvent: "completed absent",
    },
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
  if (!res.ok) {
    return { ok: false, error: `Twilio start-recording failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }
  }
  return { ok: true, recordingSid: res.data?.sid ?? null }
}
