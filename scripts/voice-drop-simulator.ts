#!/usr/bin/env tsx
// scripts/voice-drop-simulator.ts   (npm run test:voice-drop)
// ─────────────────────────────────────────────────────────────────────────────
// WAVE 58 — THE AMD VOICE-DROP <Play> + THE RESOLVED-VOICE WIRE.
//
// Proves three things, each a real gap this wave closed (see
// lib/kernel/manager-registry.ts's voice_drop_realism entry for the full
// story):
//
//   1. renderVoiceDrop resolves the "voice_drop" lane to the NARRATION model
//      (eleven_v3, not the phone_realtime Flash model) and natural-pause
//      pacing actually applies to it — a voice drop is scripted and never
//      interrupted, unlike a live ConversationRelay turn.
//   2. OutboundCallBrief.elevenlabsVoiceId round-trips through
//      encodeOutboundBrief/decodeOutboundBrief (the wire buildCallContext's
//      resolved voice now rides from dial time to answer time) AND a
//      legacy/foreign note with no such field still decodes cleanly (backward
//      compatible — every pre-wave-58 caller keeps working).
//   3. SOURCE WIRING: the outbound answer webhook actually calls
//      renderVoiceDrop + twimlPlay behind an ELEVENLABS_API_KEY gate with a
//      <Say> fallback, uses the SAME transport-switch vocabulary as the
//      inbound lane for the human leg, and prefers the carried voice id over
//      the number's own cascade; the three buildCallContext callers actually
//      thread voiceConfig.voiceId through; the ringless-voicedrop rail's
//      duplicate synth was merged onto renderVoiceDrop with a tombstone
//      (§1); the internal voice-tts route lost its hand-rolled literal.
//
// NO LIVE ELEVENLABS CALL: renderVoiceDrop's network leg (synthesizeSpeech →
// ElevenLabs → hostRenderedMedia) needs a real API key and Supabase Storage
// credentials this lane does not hold — exactly the "never send real
// outbound" constraint. What is provable without a network call is proved:
// the PURE model/pacing selection, the PURE brief encode/decode contract, and
// the SOURCE wiring that the render call + its gate + its fallback actually
// exist at the right call sites.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"
import {
  elevenLabsModelForLane, withNaturalPauses, stripNaturalPauseMarkup,
  ELEVENLABS_NARRATION_MODEL_ID, ELEVENLABS_PHONE_MODEL_ID,
} from "../lib/video/realism-profile"
import { twimlPlay, twimlHangup } from "../lib/voice/reception-brain"
import { encodeOutboundBrief, decodeOutboundBrief } from "../lib/voice/twilio-outbound"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const check = (n: string, ok: boolean, d?: string) => { if (ok) { passed++; console.log(`  ✓ ${n}`) } else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: the \"voice_drop\" ElevenLabs lane ──")
{
  check("voice_drop resolves to the NARRATION model (eleven_v3), NOT the phone_realtime Flash model — a voice drop is scripted, never interrupted",
    elevenLabsModelForLane("voice_drop") === ELEVENLABS_NARRATION_MODEL_ID
    && elevenLabsModelForLane("voice_drop") !== ELEVENLABS_PHONE_MODEL_ID)
  check("voice_drop is the SAME model as the other narration lanes (avatar/reel) — one vocabulary, §6",
    elevenLabsModelForLane("voice_drop") === elevenLabsModelForLane("avatar_narration")
    && elevenLabsModelForLane("voice_drop") === elevenLabsModelForLane("reel_narration"))

  // POSITIVE CONTROL (§2): natural pauses actually insert on the voice_drop
  // model — proves withNaturalPauses' model-dispatch recognizes "voice_drop"'s
  // resolved model id rather than silently no-op'ing on an unrecognized lane.
  const script = "Hi, this is Ava calling from VIP Premier. I wanted to follow up on your home search.\n\nGive us a call back whenever works."
  const paced = withNaturalPauses(script, elevenLabsModelForLane("voice_drop"))
  check("POSITIVE CONTROL: pacing markup actually inserted for the voice_drop lane's resolved model",
    paced.includes("[short pause]") || paced.includes("[long pause]"))
  check("stripNaturalPauseMarkup is the exact inverse — no literal bracket text ever reaches a caption/transcript reader",
    !stripNaturalPauseMarkup(paced).includes("[") && stripNaturalPauseMarkup(paced).includes("Give us a call back"))
  // NEGATIVE CONTROL: the phone_realtime lane is untouched (no live-call script
  // in this repo needs pacing — composePacingRule already forces one short
  // sentence — and Flash/Turbo honor neither mechanism).
  check("NEGATIVE CONTROL: phone_realtime's model is left UNCHANGED by withNaturalPauses (no audio-tag / SSML-break mechanism confirmed there)",
    withNaturalPauses(script, elevenLabsModelForLane("phone_realtime")) === script)
}

console.log("\n── PURE: TwiML — <Play> the rendered clip, or <Say> the fallback ──")
{
  const p = twimlPlay("https://cdn.example.com/voice-drops/b1/CA123.mp3")
  check("twimlPlay: Response+Play+Hangup, the audio URL carried verbatim",
    p.includes("<Response>") && p.includes("<Play>") && p.includes("https://cdn.example.com/voice-drops/b1/CA123.mp3") && p.includes("<Hangup/>"))
  check("twimlPlay XML-escapes the URL (no injection via a hostile storage key)",
    twimlPlay('https://cdn.example.com/a&b<c>.mp3').includes("&amp;b&lt;c&gt;"))
  check("twimlHangup (the <Say> fallback) still exists and is what a failed/unconfigured render falls back to",
    twimlHangup("Sorry we missed you.").includes("<Say"))
}

console.log("\n── PURE: OutboundCallBrief carries the resolved voice, backward-compatible ──")
{
  const brief = {
    engine: "twilio" as const, objective: "Re-engage a cold buyer lead.",
    contactName: "Sam", firstMessage: null, systemPrompt: null,
    elevenlabsVoiceId: "el_voice_agent_clone_123",
  }
  const decoded = decodeOutboundBrief(encodeOutboundBrief(brief))
  check("elevenlabsVoiceId round-trips through ai_notes (the resolved buildCallContext voice rides dial-time → answer-time)",
    decoded !== null && decoded.elevenlabsVoiceId === "el_voice_agent_clone_123")
  const noVoice = decodeOutboundBrief(encodeOutboundBrief({ engine: "twilio", objective: "x" }))
  check("omitted elevenlabsVoiceId encodes/decodes to null (never a crash, never a silently-invented voice)",
    noVoice !== null && noVoice.elevenlabsVoiceId === null)
  // BACKWARD COMPAT: a pre-wave-58 row's ai_notes never had this key at all.
  const legacy = decodeOutboundBrief(JSON.stringify({ engine: "twilio", objective: "Legacy call, no voice field." }))
  check("BACKWARD COMPAT: a pre-wave-58 stored brief (no elevenlabsVoiceId key at all) still decodes, field reads null",
    legacy !== null && legacy.elevenlabsVoiceId === null)
}

console.log("\n── SOURCE: the AMD voice-drop is wired at the ONE outbound door, autonomous, never a second dial path ──")
{
  const renderLib = src("lib/voice/render-voice-drop.ts")
  check("renderVoiceDrop resolves its model via elevenLabsModelForLane(\"voice_drop\", …) and paces via withNaturalPauses — never a hand-rolled model literal",
    renderLib.includes('elevenLabsModelForLane("voice_drop")') && renderLib.includes("withNaturalPauses(script, modelId)"))
  check("renderVoiceDrop synthesizes via the ONE ElevenLabs primitive (synthesizeSpeech) and hosts via the ONE media host (hostRenderedMedia) — never a second connector call",
    renderLib.includes("synthesizeSpeech") && renderLib.includes("hostRenderedMedia"))
  check("renderVoiceDrop NEVER throws out of a bad render — every failure path returns { ok: false }",
    renderLib.includes("{ ok: false, error:") && !/\bthrow new Error/.test(renderLib.replace(/`renderVoiceDrop[^`]*`/g, "")))

  const outboundRoute = src("app/api/voice/twilio/outbound/route.ts")
  check("OUTBOUND ANSWER: AMD branch calls renderVoiceDrop, gated on ELEVENLABS_API_KEY, with <Say> (twimlHangup) as the fallback",
    outboundRoute.includes("renderVoiceDrop") && outboundRoute.includes("ELEVENLABS_API_KEY")
    && outboundRoute.includes("playUrl ? twimlPlay(playUrl) : twimlHangup(vm)"))
  check("OUTBOUND ANSWER: the SAME honest script (composeVoicemailMessage) feeds BOTH the <Play> render and the <Say> fallback — one vocabulary for what the voicemail says",
    (() => {
      const vmIdx = outboundRoute.indexOf("composeVoicemailMessage(brief")
      const renderIdx = outboundRoute.indexOf("renderVoiceDrop({")
      const scriptIdx = outboundRoute.indexOf("script: vm,")
      return vmIdx >= 0 && vmIdx < renderIdx && scriptIdx > renderIdx
    })())
  check("OUTBOUND ANSWER: the resolved call-specific voice (brief.elevenlabsVoiceId) is PREFERRED over the number's generic cascade (ctx.identity.elevenlabsVoiceId) for BOTH the render and the ConversationRelay leg",
    (outboundRoute.match(/brief\.elevenlabsVoiceId \?\? ctx\.identity\.elevenlabsVoiceId/g) ?? []).length >= 2)
  check("OUTBOUND ANSWER: recorded in voice_calls — ai_notes gains the rendered clip's URL, no new column/migration needed",
    outboundRoute.includes("voicemail_audio_url") && outboundRoute.includes('from("voice_calls")'))
  check("OUTBOUND ANSWER: the human leg reuses the SAME transport-switch vocabulary as inbound (relayConfigured / conversationRelayTtsAttrs / twimlConnectRelay), <Gather><Say> the fallback when unconfigured",
    outboundRoute.includes("relayConfigured") && outboundRoute.includes("conversationRelayTtsAttrs") && outboundRoute.includes("twimlConnectRelay") && outboundRoute.includes("twimlGatherTurn"))
  check("NEVER A SECOND DIAL DOOR: this is the ONE outbound-answer route — call-executor, the AI-ISA engage/initiate-engagement paths and the initiate-call action all place through placeOutboundAiCall, which is what answers here",
    src("lib/voice-engine/call-executor.ts").includes("placeOutboundAiCall")
    && src("app/actions/ai-isa/engage-contact.ts").includes("placeOutboundAiCall")
    && src("app/actions/ai-isa/initiate-engagement.ts").includes("placeOutboundAiCall")
    && src("app/api/voice/initiate-call/route.ts").includes("placeOutboundAiCall"))

  const twilioOutboundLib = src("lib/voice/twilio-outbound.ts")
  check("PlaceOutboundParams + the encodeOutboundBrief call site both carry elevenlabsVoiceId through to ai_notes",
    twilioOutboundLib.includes("elevenlabsVoiceId?: string | null") && twilioOutboundLib.includes("elevenlabsVoiceId: params.elevenlabsVoiceId ?? null"))

  // THE WIRE: buildCallContext's resolved voiceConfig actually reaches
  // placeOutboundAiCall at all three call sites — this was the hidden-wire
  // gap this wave closed (voiceConfig was computed and dropped everywhere).
  for (const f of ["app/api/voice/initiate-call/route.ts", "app/actions/ai-isa/engage-contact.ts", "app/actions/ai-isa/initiate-engagement.ts"]) {
    check(`WIRE: ${f} threads buildCallContext's voiceConfig.voiceId into placeOutboundAiCall (elevenlabsVoiceId), not just firstMessage/systemPrompt`,
      /elevenlabsVoiceId:\s*call(Ctx|Context)\.voiceConfig\?\.voiceId \?\? null/.test(src(f)))
  }

  // ORPHAN DOCTRINE (§1): the ringless-voicedrop rail's duplicate synth
  // merged onto renderVoiceDrop, tombstoned.
  const voicedropLib = src("lib/voicedrop/orchestrate-voicedrop-send.ts")
  check("ORPHAN §1 — DUPLICATE MERGED: the ringless-drop rail's synthVoicemail now calls the SURVIVOR renderVoiceDrop (not a second ElevenLabs+hostRenderedMedia implementation), tombstone present",
    voicedropLib.includes('await import("@/lib/voice/render-voice-drop")') && voicedropLib.includes("renderVoiceDrop(")
    && voicedropLib.includes("ORPHAN DOCTRINE (§1") && voicedropLib.includes("SURVIVOR"))
  {
    // Isolate synthVoicemail's OWN body (between its declaration and the next
    // top-level function) so this asserts the FUNCTION was rewritten, not
    // merely that the string "hostRenderedMedia" is absent from the whole file.
    // STRIPPED first (§2 — "a tombstone is not a call site"): the tombstone
    // comment ITSELF names hostRenderedMedia/renderVoiceDrop in prose, which
    // would make a raw-source scan see a call site that is actually a comment.
    const stripped = blankComments(voicedropLib)
    const bodyStart = stripped.indexOf("async function synthVoicemail")
    const bodyEnd = stripped.indexOf("export async function orchestrateVoicedropSend")
    const body = bodyStart >= 0 && bodyEnd > bodyStart ? stripped.slice(bodyStart, bodyEnd) : ""
    check("ORPHAN §1: synthVoicemail's OWN body (comments stripped) no longer hand-rolls ElevenLabs synth + hostRenderedMedia inline — it delegates to renderVoiceDrop",
      body.length > 0 && body.includes("renderVoiceDrop(") && !body.includes("hostRenderedMedia") && !body.includes('await import("@/lib/voice/elevenlabs-tts")'))
  }

  // Internal voice-tts route: no hand-rolled literal.
  const ttsRoute = src("app/api/internal/voice-tts/route.ts")
  check("app/api/internal/voice-tts/route.ts: model resolved via elevenLabsModelForLane(\"phone_realtime\") + ELEVENLABS_REALISM_VOICE_SETTINGS — no hand-rolled voiceSettings literal",
    ttsRoute.includes('elevenLabsModelForLane("phone_realtime")') && ttsRoute.includes("ELEVENLABS_REALISM_VOICE_SETTINGS")
    && !ttsRoute.includes("similarity_boost: 0.78"))

  // Step palette: the autonomous option is documented on the ai_call step, no
  // second channel/UI toggle invented.
  const palette = src("lib/workflow/step-palette.ts")
  check("STEP PALETTE: the ai_call step documents the autonomous voice-drop-on-machine-answer upgrade; no second channel added (voice_drop stays the ringless-drop channel, ai_call stays the live-call channel)",
    palette.includes('channel: "ai_call"') && /ai_call[\s\S]{0,1000}pre-rendered greeting/.test(palette))

  check("registry burn domain voice_drop_realism (ai_isa)",
    "voice_drop_realism" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.voice_drop_realism.manager === "ai_isa")
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ VOICE_DROP_FAIL"); process.exit(1) }
console.log(" ✅ VOICE_DROP_PASS — the AMD voicemail sounds like the agent, the resolved clone voice reaches the call, never a second dial door")
