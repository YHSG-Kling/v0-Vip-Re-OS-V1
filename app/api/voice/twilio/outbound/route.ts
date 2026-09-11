import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, validateTwilioSignature } from "@/lib/voice/twilio-voice"
import { buildOutboundPrompt, twimlGatherTurn, twimlHangup, twimlPlay, appendTranscript } from "@/lib/voice/reception-brain"
import { decodeOutboundBrief, composeVoicemailMessage } from "@/lib/voice/twilio-outbound"
import { relayConfigured, twimlConnectRelay, conversationRelayTtsAttrs } from "@/lib/voice/conversation-relay"

export const dynamic = "force-dynamic"

const xml = (body: string, status = 200) => new NextResponse(body, { status, headers: { "Content-Type": "text/xml" } })

/**
 * TRANSPORT SWITCH for the human-answered leg — mirrors
 * app/api/voice/twilio/inbound/route.ts's own `answerTwiml` exactly (§6: one
 * vocabulary for "how does a call transport pick its voice", not a second
 * spelling for the outbound direction): ConversationRelay (streaming,
 * ElevenLabs-capable) when the companion is configured, else the serverless
 * <Gather><Say> lane. `elevenlabsVoiceId` prefers the call's OWN resolved
 * voice (OutboundCallBrief — buildCallContext's voiceConfig, wave 58) over the
 * number's generic ai_identity_profiles cascade, falling back to that cascade
 * when the call carries none (every pre-wave-58 caller). conversationRelayTtsAttrs
 * itself is the <Say>-when-no-ElevenLabs-key fallback: no key → Twilio-native
 * Google voice on the SAME relay transport when relay is configured at all,
 * and no relay configured at all → this function's own <Gather><Say> branch.
 */
const answerOutboundTwiml = (opener: string, turnUrl: string, elevenlabsVoiceId?: string | null) => {
  if (!relayConfigured()) return twimlGatherTurn(opener, turnUrl)
  const tts = conversationRelayTtsAttrs(elevenlabsVoiceId)
  return twimlConnectRelay(
    process.env.CONVERSATION_RELAY_WSS_URL!,
    opener,
    tts.voice,
    process.env.TWILIO_INTELLIGENCE_SERVICE_SID,
    tts.ttsProvider,
    tts.elevenlabsTextNormalization,
  )
}

/**
 * TWILIO VOICE — OUTBOUND ANSWER. Fires when an outbound AI call connects.
 * The tenant is resolved by the FROM number (ours); the session is the
 * voice_calls row placed at dial time (by CallSid), whose ai_notes carries the
 * call brief. A machine answer gets a realistic PRE-RENDERED voicemail
 * (renderVoiceDrop, wave 58) when ElevenLabs is configured — the same honest
 * script <Play>ed instead of read by Twilio-native <Say> — falling back to
 * the honest TTS <Say> voicemail otherwise; a human gets the opener on the
 * SAME transport switch the inbound lane uses (ConversationRelay when
 * configured, else <Gather> → /turn).
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const svc = createServiceClient()
  const from = params.From ?? "" // OUR number on an outbound leg
  const callSid = params.CallSid ?? ""
  const answeredBy = (params.AnsweredBy ?? "").toLowerCase()

  const ctx = await resolveInboundContext(svc, from)
  if (!ctx) return xml(twimlHangup("Sorry, something went wrong. Goodbye."))

  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twilio/outbound`
  if (!validateTwilioSignature(ctx.authToken, url, params, request.headers.get("x-twilio-signature"))) {
    return new NextResponse("invalid signature", { status: 403 })
  }

  const { data: call } = await svc.from("voice_calls").select("id, ai_notes, transcription")
    .eq("vendor_call_id", callSid).maybeSingle()
  const brief = decodeOutboundBrief((call as any)?.ai_notes)
  if (!call || !brief) {
    // No session row / foreign call — never improvise an unscripted AI call.
    return xml(twimlHangup("Sorry, this call can't continue. Goodbye."))
  }

  // Machine answered → honest voicemail, ledger closed as voicemail.
  // The recording announcement in that voicemail is DERIVED from the brokerage's
  // actual recording posture, never hardcoded: Twilio's Record parameter (armed
  // at dial time in lib/voice/twilio-outbound.ts) captures this AMD leg too, so
  // a fixed `recorded: false` here would be the one spoken line in the system
  // that contradicts what is actually happening. See lib/voice/call-recording.ts.
  const { resolveCallRecordingPolicy, disclosureCoversRecording } = await import("@/lib/voice/call-recording")
  const recordingPolicy = await resolveCallRecordingPolicy(svc, ctx.brokerageId)

  if (answeredBy.startsWith("machine")) {
    const vm = composeVoicemailMessage(brief, ctx.identity.brokerageName, { recorded: recordingPolicy.enabled })

    // WAVE 58 — the AMD voice-drop <Play>. Same honest, disclosure-compliant
    // script as the <Say> fallback (ONE vocabulary for "what does this
    // voicemail say" — §6); only the DELIVERY upgrades to a pre-rendered
    // ElevenLabs clip when the platform is configured for it. This rides the
    // EXISTING outbound door (this is the ONE outbound-answer webhook every
    // placeOutboundAiCall dial — AI-ISA re-engagement, ai_call sequence steps,
    // the initiate-call action — already answers through), never a second
    // dial path: "autonomous option" (owner ruling) means it runs on its own
    // whenever ElevenLabs is reachable, not a manual per-step toggle.
    let playUrl: string | null = null
    if ((process.env.ELEVENLABS_API_KEY ?? "").trim()) {
      try {
        const { renderVoiceDrop } = await import("@/lib/voice/render-voice-drop")
        const rendered = await renderVoiceDrop({
          script: vm,
          voiceId: brief.elevenlabsVoiceId ?? ctx.identity.elevenlabsVoiceId,
          brokerageId: ctx.brokerageId,
          storageKeyHint: callSid,
        })
        if (rendered.ok) playUrl = rendered.audioUrl
        else console.error(`[voice/outbound] AMD voice-drop render failed for CallSid ${callSid}, falling back to <Say>: ${rendered.error}`)
      } catch (e: any) {
        console.error(`[voice/outbound] AMD voice-drop render threw for CallSid ${callSid}, falling back to <Say>:`, e?.message ?? e)
      }
    }

    // RECORDED IN voice_calls: the transcript already carries the spoken
    // words (unchanged whichever delivery ran); ai_notes gains the rendered
    // clip's URL so the call record shows WHICH voicemail was actually
    // played, without inventing a new column (no migration needed — this
    // lane cannot apply one). A parse failure on the stored brief JSON keeps
    // the original ai_notes rather than losing the dial-time brief.
    let mergedAiNotes = (call as any).ai_notes ?? null
    if (playUrl) {
      try {
        mergedAiNotes = JSON.stringify({ ...JSON.parse(mergedAiNotes ?? "{}"), voicemail_audio_url: playUrl })
      } catch { /* keep the original ai_notes — the dial-time brief must not be lost */ }
    }
    await svc.from("voice_calls").update({
      status: "completed", outcome: "voicemail", ended_at: new Date().toISOString(),
      transcription: appendTranscript(null, null, vm),
      ai_notes: mergedAiNotes,
    }).eq("id", (call as any).id).then(undefined, () => {})
    return xml(playUrl ? twimlPlay(playUrl) : twimlHangup(vm))
  }

  const { firstMessage } = buildOutboundPrompt(ctx.identity, {
    objective: brief.objective, contactName: brief.contactName, extraSystemPrompt: brief.systemPrompt,
  })
  let opener = brief.firstMessage ? appendDisclosedOpener(brief.firstMessage, firstMessage) : firstMessage
  // THE COUPLING INVARIANT, ENFORCED where the words meet the wire (not just stated):
  // a recorded call whose spoken opener never announced recording is the one state
  // lib/voice/call-recording.ts exists to make unreachable. Composition already
  // guarantees ANNOUNCED ⊇ RECORDED today; this predicate keeps a future opener
  // change from silently breaking that guarantee.
  if (!disclosureCoversRecording(opener, recordingPolicy)) {
    const { RECORDING_DISCLOSURE } = await import("@/lib/communication/call-disclosures")
    opener = `${RECORDING_DISCLOSURE}${opener}`.slice(0, 550)
  }
  await svc.from("voice_calls").update({
    status: "in_progress",
    transcription: appendTranscript((call as any).transcription, null, opener),
  }).eq("id", (call as any).id).then(undefined, () => {})

  return xml(answerOutboundTwiml(opener, url.replace(/\/outbound$/, "/turn"), brief.elevenlabsVoiceId ?? ctx.identity.elevenlabsVoiceId))
}

/** A custom opener still leads with the legally-disclosed line — the brief's
 *  text follows it, never replaces it. */
function appendDisclosedOpener(custom: string, disclosed: string): string {
  return `${disclosed} ${custom}`.slice(0, 550)
}
