"use server"

/**
 * Brief Audio — generates an ElevenLabs TTS reading of the user's morning
 * brief in their cloned voice (or fallback). Returns mp3 as a data URL the
 * <audio> element can play directly. Brief is short (~150-300 words) so the
 * payload stays under ~150kb base64.
 *
 * Vision moment: "agent opens this app in the morning, hears AI tell them
 * the three things that matter today" — this powers the audio half.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import {
  synthesizeSpeech,
  audioBufferToDataUrl,
} from "@/lib/voice/elevenlabs-tts"
import { resolveSelfVoice } from "@/lib/voice/voice-resolver"
import type { UserTypeBrief } from "@/lib/intelligence/user-type-briefs"

export interface BriefAudioResult {
  success: boolean
  audioDataUrl?: string
  voiceUsed?: "agent_clone" | "agent_generic_choice" | "platform_fallback"
  error?: string
}

/**
 * Generate audio for a brief. Returns a data URL (data:audio/mpeg;base64,...).
 * Caller plays it via <audio src={url} controls autoPlay />.
 */
export async function generateBriefAudio(params: {
  brief: UserTypeBrief
}): Promise<BriefAudioResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }

  // Build the spoken script from brief content
  const script = composeBriefScript(params.brief)
  if (!script) {
    return { success: false, error: "Nothing to read in brief" }
  }

  // Resolve voice via the kernel resolver — honors agent's voice_preference
  // (clone vs generic) so they hear what they chose in settings.
  if (!ctx.userId) {
    return { success: false, error: "No user context" }
  }
  const resolved = await resolveSelfVoice(ctx.userId)

  const result = await synthesizeSpeech({
    text: script,
    voiceId: resolved.voiceId,
    voiceSettings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
  })

  if (!result.success || !result.audioBuffer) {
    return {
      success: false,
      error: result.error ?? "TTS failed",
    }
  }

  return {
    success: true,
    audioDataUrl: audioBufferToDataUrl(result.audioBuffer),
    voiceUsed: resolved.source,
  }
}

// ---------------------------------------------------------------------------
// Script composer — turns brief data into natural spoken text
// ---------------------------------------------------------------------------

function composeBriefScript(brief: UserTypeBrief): string {
  const parts: string[] = []

  // Greeting based on time of day
  const hour = new Date().getHours()
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
  parts.push(`${greeting}. Here's your focus for today.`)

  // Summary
  if (brief.summary) {
    parts.push(brief.summary)
  }

  // Top 3 priorities — keep short, conversational
  if (brief.priorities.length > 0) {
    const top = brief.priorities.slice(0, 3)
    parts.push(
      top.length === 1
        ? "Your top priority:"
        : `Your top ${top.length} priorities:`
    )
    top.forEach((p, i) => {
      const lead = top.length === 1 ? "" : `${ordinal(i + 1)}, `
      parts.push(`${lead}${p.title}. ${stripMarkdown(p.body)}`)
    })
  }

  // Surface key metric trends, briefly
  if (brief.metrics.length > 0) {
    const noteworthy = brief.metrics.filter((m) => m.trend && m.trend !== "flat").slice(0, 2)
    if (noteworthy.length > 0) {
      const phrasing = noteworthy
        .map((m) => `${m.label} is ${m.trend === "up" ? "up" : "down"} at ${m.value}`)
        .join(" and ")
      parts.push(`Quick numbers — ${phrasing}.`)
    }
  }

  parts.push("Tap any priority to take action. Let's have a great day.")

  return parts.join(" ")
}

function ordinal(n: number): string {
  return ["First", "Second", "Third", "Fourth", "Fifth"][n - 1] ?? `Number ${n}`
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, ". ")
    .trim()
}
