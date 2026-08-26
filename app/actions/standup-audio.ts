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
import { generateManagerStandup } from "@/lib/intelligence/manager-standup"
import { composeStandupScript } from "@/lib/intelligence/standup-narrative"

export interface StandupAudioResult {
  success: boolean
  /** The composed spoken text (always present on success, even if audio failed). */
  text?: string
  audioDataUrl?: string
  voiceUsed?: "agent_clone" | "agent_generic_choice" | "platform_fallback"
  error?: string
}

export async function generateStandupAudio(): Promise<StandupAudioResult> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const lines = await generateManagerStandup(ctx.brokerageId)
  const script = composeStandupScript(lines, { hour: new Date().getHours() })

  // Resolve the broker's chosen voice (clone vs generic), same as the morning brief.
  const resolved = await resolveSelfVoice(ctx.userId)
  const result = await synthesizeSpeech({
    text: script,
    voiceId: resolved.voiceId,
    voiceSettings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    brokerageId: ctx.brokerageId,
  })

  // TTS unavailable (no key / quota) → still hand back the text so the UI shows the brief.
  if (!result.success || !result.audioBuffer) {
    return { success: true, text: script, error: result.error ?? "TTS unavailable" }
  }

  return {
    success: true,
    text: script,
    audioDataUrl: audioBufferToDataUrl(result.audioBuffer),
    voiceUsed: resolved.source,
  }
}
