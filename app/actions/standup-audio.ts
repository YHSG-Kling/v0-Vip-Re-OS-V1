"use server"

/**
 * Standup Audio — the broker HEARS their AI team's daily standup in their cloned
 * voice (or fallback): what each manager did overnight, what the reapers caught,
 * and what needs them. Reuses the same ElevenLabs path as the morning brief
 * (synthesizeSpeech → mp3 data URL the <audio> element plays directly).
 *
 * The "talk to your brokerage" differentiator, audio half. Always returns the
 * text too, so the UI shows the brief even when TTS is unavailable.
 */

import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { synthesizeSpeech, audioBufferToDataUrl } from "@/lib/voice/elevenlabs-tts"
import { resolveSelfVoice } from "@/lib/voice/voice-resolver"
import { elevenLabsModelForLane, withNaturalPauses } from "@/lib/video/realism-profile"
import { generateManagerStandup } from "@/lib/intelligence/manager-standup"
import { composeStandupScript } from "@/lib/intelligence/standup-narrative"

export interface StandupAudioResult {
  success: boolean
  /** The composed spoken text (always present on success, even if audio failed). */
  text?: string
  audioDataUrl?: string
  voiceUsed?: "agent_clone" | "agent_generic_choice" | "platform_fallback"
  error?: string
  /** true when the same audio was already generated (and paid for) today and was served again — no new charge. */
  replayed?: boolean
  /** true when the first audio could not be served again: the broker may ask for a NEW (budget-checked, receipted) one. */
  canRegenerate?: boolean
}

export async function generateStandupAudio(opts: { regenerate?: boolean } = {}): Promise<StandupAudioResult> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // ITS OWN RECEIPT (wave 156, lane 156S — the brief-audio pattern): the action runs inside ledgerSessionAction, and the
  // synthesis inside it is THE paid voice door (synthesizeSpeech → lib/vendor-governance/paid-egress.ts): the tenant's
  // vendor budget before ElevenLabs is reached, the characters booked only on success, and ONE charge per (broker, day,
  // exact script) — a repeated identical request replays its receipt instead of paying for the same audio twice.
  const brokerageId = ctx.brokerageId, userId = ctx.userId
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId, action: "standup.audio.generate", actor: { type: "user", userId }, subject: { type: "user", id: userId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { lane: "brief_narration" } }, async (): Promise<StandupAudioResult> => {
  const lines = await generateManagerStandup(brokerageId)
  const script = composeStandupScript(lines, { hour: new Date().getHours() })
  const { createHash } = await import("node:crypto")
  // A REPEAT returns the SAME audio (the voice door serves its stored copy — no provider call, no charge). Only when that copy
  // cannot be served does the broker get a plain message and the option to regenerate: a NEW key, so it is a new,
  // budget-checked, receipted call — never an unbilled second call, never a billed duplicate of the first.
  const scriptKey = `standup_audio:${brokerageId}:${userId}:${new Date().toISOString().slice(0, 10)}:${createHash("sha256").update(script).digest("hex").slice(0, 24)}${opts.regenerate ? `:regenerate:${Date.now()}` : ""}`

  // Resolve the broker's chosen voice (clone vs generic), same as the morning brief.
  const resolved = await resolveSelfVoice(userId)
  // MODEL + PACING through the ONE selector (lane 77C) — same lane as the
  // morning brief (app/actions/brief-audio.ts): a scripted, uninterruptible read.
  const modelId = elevenLabsModelForLane("brief_narration")
  const result = await synthesizeSpeech({
    text: withNaturalPauses(script, modelId),
    voiceId: resolved.voiceId,
    modelId,
    voiceSettings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    brokerageId,
    idempotencyKey: scriptKey,
  })

  if (result.errorCode === "replay_unavailable") {
    return { success: true, text: script, error: result.error, canRegenerate: true }
  }
  // TTS unavailable (no key / quota) → still hand back the text so the UI shows the brief.
  if (!result.success || !result.audioBuffer) {
    return { success: true, text: script, error: result.error ?? "TTS unavailable" }
  }

  return {
    success: true,
    text: script,
    audioDataUrl: audioBufferToDataUrl(result.audioBuffer),
    voiceUsed: resolved.source,
    ...(result.replayed ? { replayed: true } : {}),
  }
  }) as Promise<StandupAudioResult>
}
