/**
 * lib/direct-mail/render-letter-audio.ts
 *
 * Wave 38 — TTS rendering for direct-mail letters. The letter still
 * lands in the recipient's physical mailbox via Lob (the Wave 36
 * orchestrate-send path is unchanged); this module produces a
 * companion mp3 narrated in the AGENT'S CLONED ElevenLabs voice and
 * surfaces it on the contact's portal. Same brand, same words —
 * different sensory channel.
 *
 * Why this matters in real estate AI: every competitor (Moxi, Rave,
 * BoldTrail) ships postcard + email + maybe SMS. None of them gives
 * the contact the agent's actual voice reading the letter as a
 * portal asset. It's a quiet differentiator: the same listing-prep
 * letter the seller got in the mail this morning is also a 90-second
 * audio they can listen to on a dog walk. Higher engagement signal
 * for the bandit, stronger relationship.
 *
 * Compliance: TCPA does NOT apply — this is asynchronous portal
 * content the contact opted into by being a brokerage customer.
 * No phone egress; no opt-in record changes.
 *
 * Cost model: ElevenLabs charges per character. A typical letter is
 * 600-900 chars → ~$0.03 per render at the consumer tier. The
 * synthesizeSpeech helper already enforces the vendor budget gate.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"

export interface RenderLetterAudioArgs {
  campaignId: string
}

export interface RenderLetterAudioResult {
  ok:         boolean
  campaignId: string
  audioUrl?:  string
  voiceId?:   string
  skipped?:   "not_letter" | "already_rendered" | "no_voice" | "no_agent" | "no_copy" | "no_recipient"
  error?:     string
}

/**
 * Render the audio version of a single direct-mail letter campaign.
 * Idempotent — re-running on a row that already has tts_audio_url is
 * a no-op. The cron drains the backlog; the orchestrator calls this
 * directly on fresh dispatches.
 */
export async function renderLetterAudio(
  args: RenderLetterAudioArgs,
): Promise<RenderLetterAudioResult> {
  const svc = createServiceClient()

  const { data: campaignRow } = await svc.from("direct_mail_campaigns")
    .select("id, brokerage_id, contact_id, agent_id, copy_text, piece_type, tts_audio_url")
    .eq("id", args.campaignId)
    .maybeSingle()
  const c = campaignRow as {
    id: string
    brokerage_id: string | null
    contact_id: string | null
    agent_id: string | null
    copy_text: string | null
    piece_type: string | null
    tts_audio_url: string | null
  } | null

  if (!c)                              return { ok: false, campaignId: args.campaignId, error: "campaign_not_found" }
  if (c.piece_type !== "letter")       return { ok: true,  campaignId: args.campaignId, skipped: "not_letter" }
  if (c.tts_audio_url)                 return { ok: true,  campaignId: args.campaignId, skipped: "already_rendered", audioUrl: c.tts_audio_url }
  if (!c.copy_text?.trim())            return { ok: true,  campaignId: args.campaignId, skipped: "no_copy" }
  if (!c.brokerage_id || !c.agent_id)  return { ok: true,  campaignId: args.campaignId, skipped: "no_agent" }

  // direct_mail_campaigns.agent_id FKs to agents(id) — verified via
  // Supabase MCP. Same flavor agent_voice_profiles.agent_id uses, so
  // we can query straight through without a resolver hop.
  const { data: vp } = await svc.from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("agent_id", c.agent_id)
    .maybeSingle()
  const voiceId = (vp?.elevenlabs_voice_id as string | null) ?? null
  if (!voiceId) {
    return { ok: true, campaignId: args.campaignId, skipped: "no_voice" }
  }

  // Synthesize. The letter's copy_text already has the variable
  // interpolation baked in (orchestrate-send.ts ran the interpolator
  // before storing). No second pass needed.
  const synth = await synthesizeSpeech({
    text:        c.copy_text,
    voiceId,
    brokerageId: c.brokerage_id,
    voiceSettings: {
      // Letters are read-aloud-as-personal-correspondence — lean toward
      // warmth + stability over expressiveness (compared to the more
      // animated voicedrop / podcast presets).
      stability:        0.6,
      similarity_boost: 0.85,
      style:            0.25,
      use_speaker_boost: true,
    },
  })
  if (!synth.success || !synth.audioBuffer) {
    return { ok: false, campaignId: args.campaignId, error: synth.error ?? `synth_${synth.errorCode ?? "unknown"}` }
  }

  // Upload to Vercel Blob — public so the portal can stream without
  // signed URLs. The file path is per-brokerage scoped + suffixed
  // with the campaign id so re-renders overwrite the same key.
  const { put } = await import("@vercel/blob")
  const uploaded = await put(
    `letter-audio/${c.brokerage_id}/${c.id}.mp3`,
    synth.audioBuffer,
    { access: "public", contentType: "audio/mpeg" },
  )
  const audioUrl = uploaded.url

  // Stamp the campaign row.
  const { error: stampErr } = await svc.from("direct_mail_campaigns")
    .update({ tts_audio_url: audioUrl, tts_voice_id: voiceId })
    .eq("id", c.id)
  if (stampErr) {
    return { ok: false, campaignId: args.campaignId, audioUrl, voiceId, error: stampErr.message }
  }

  // Surface on the contact's portal — but only when there IS a contact
  // (some letters go to leads or anonymous addresses).
  //
  // portal_event_stream.agent_user_id FKs to users(id), while
  // direct_mail_campaigns.agent_id is the agents.id flavor. Resolve
  // through the canonical helper before insert.
  if (c.contact_id) {
    const agentUserId = await resolveAgentRecordToUserId(c.agent_id)
    if (agentUserId) {
      await svc.from("portal_event_stream").insert({
        brokerage_id:   c.brokerage_id,
        contact_id:     c.contact_id,
        agent_user_id:  agentUserId,
        event_type:     "letter_audio_ready",
        customer_copy:  "Your agent recorded an audio version of the letter — tap to listen.",
        customer_icon:  "headphones",
        agent_copy:     "Letter TTS audio rendered and surfaced on the contact's portal.",
        severity:       "normal",
        metadata:       { campaign_id: c.id, audio_url: audioUrl, voice_id: voiceId },
      })
    }
  }

  return { ok: true, campaignId: args.campaignId, audioUrl, voiceId }
}
