/**
 * lib/listing-presentation/section-narration-orchestrator.ts
 *
 * Wave 39 — turns each section's AI script into the agent's spoken voice (and,
 * when available, their D-ID talking-head avatar) — then drops the result into
 * the queued section render so the dripped video narrates itself.
 *
 * GRACEFUL DEGRADATION is the whole point: a brokerage may have NO voice clone
 * and NO avatar yet. The pipeline must still produce a valid, branded video:
 *
 *   voice clone + avatar → avatar_narrated  (talking head + cloned voiceover)
 *   voice clone, no avatar → voice_only      (cloned voiceover + static-photo PIP)
 *   neither                → on_screen_only   (on-screen copy + static-photo PIP)
 *
 * planSectionNarrationJob() is pure (unit-tested — proves all three paths).
 * narratePresentationSections() executes it best-effort: ElevenLabs voice via
 * the metered gateway, audio uploaded to Blob and wired into the queued render's
 * input_props.voiceoverUrl; the avatar is requested via the existing D-ID →
 * Remotion handoff (target_composition_id). Never throws.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sectionNarrationBudget } from "@/lib/listing-presentation/section-narration"
import { fitNarrationToBudget } from "@/lib/video/script-structure"

export type NarrationMode = "avatar_narrated" | "voice_only" | "on_screen_only"
export interface NarrationPlan { voiceover: boolean; avatar: boolean; mode: NarrationMode }

/**
 * Pure: decide what a section's narration job should produce given what the
 * agent actually has. No script → nothing to say (on-screen only); no clone →
 * no voiceover; no avatar source → no talking head.
 */
export function planSectionNarrationJob(opts: {
  hasScript:       boolean
  hasVoiceClone:   boolean
  hasAvatarSource: boolean
}): NarrationPlan {
  const voiceover = opts.hasScript && opts.hasVoiceClone
  // An avatar talking head needs something to say — the cloned voiceover, or at
  // minimum the script (D-ID can voice it). No avatar source → static-photo PIP.
  const avatar = opts.hasAvatarSource && opts.hasScript
  const mode: NarrationMode = avatar ? "avatar_narrated" : voiceover ? "voice_only" : "on_screen_only"
  return { voiceover, avatar, mode }
}

export interface NarrateResult {
  sections:      number
  avatarNarrated: number
  voiceOnly:     number
  onScreenOnly:  number
  hasVoiceClone: boolean
  hasAvatarSource: boolean
}

/**
 * Synthesize voice (and request avatar) for every queued section render of a
 * presentation. Best-effort: a missing clone/avatar, missing keys, or a vendor
 * failure degrades the section to a lower mode — the video still renders.
 */
export async function narratePresentationSections(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<NarrateResult> {
  const supabase = client ?? createServiceClient()
  const empty: NarrateResult = { sections: 0, avatarNarrated: 0, voiceOnly: 0, onScreenOnly: 0, hasVoiceClone: false, hasAvatarSource: false }

  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("brokerage_id, agent_user_id")
    .eq("id", presentationId)
    .maybeSingle()
  if (!pres?.brokerage_id) return empty

  // Resolve the agent's voice clone + avatar source (both optional).
  // pass 12: agent_voice_profiles.agent_id and agent_avatar_assets.agent_id FK
  // agents(id), but listing_presentations.agent_user_id is the USERS class —
  // resolve to agents.id first (as intro-video-reactor / did/index already do);
  // the raw filter matched nothing, silently degrading every section to on-screen.
  let voiceId: string | null = null
  let avatarSource: string | null = null
  if (pres.agent_user_id) {
    const { data: agentRow } = await supabase.from("agents")
      .select("id").eq("user_id", pres.agent_user_id).maybeSingle()
    const voiceAgentId = (agentRow as { id?: string } | null)?.id ?? null
    if (voiceAgentId) {
      const { data: vp } = await supabase.from("agent_voice_profiles")
        .select("elevenlabs_voice_id").eq("agent_id", voiceAgentId).maybeSingle()
      voiceId = (vp as { elevenlabs_voice_id?: string | null } | null)?.elevenlabs_voice_id ?? null
      const { data: av } = await supabase.from("agent_avatar_assets")
        .select("did_avatar_id").eq("agent_id", voiceAgentId).eq("status", "ready").eq("is_default", true).maybeSingle()
      avatarSource = (av as { did_avatar_id?: string | null } | null)?.did_avatar_id ?? null
    }
  }

  // Queued section renders carry the narration script in input_props.
  const { data: renders } = await supabase
    .from("remotion_composition_renders")
    .select("id, composition_id, agent_user_id, input_props")
    .eq("entity_type", "listing_presentation")
    .eq("entity_id", presentationId)
    .eq("render_status", "queued")
  const list = (renders ?? []) as Array<{ id: string; composition_id: string; agent_user_id: string | null; input_props: Record<string, unknown> | null }>

  const result: NarrateResult = { ...empty, sections: list.length, hasVoiceClone: !!voiceId, hasAvatarSource: !!avatarSource }

  for (const r of list) {
    const props = (r.input_props ?? {}) as Record<string, unknown>
    // THE LAST POINT BEFORE THE VOICE IS PAID FOR AND BAKED IN.
    // The script was written by section-render against THIS composition's word
    // budget — but these rows are read from the QUEUE, so a row enqueued before
    // that cap existed still carries an uncapped script, and the synthesized mp3
    // lands in input_props.voiceoverUrl: an <Audio> INSIDE the composition,
    // against a FIXED durationInFrames, which the m313 tpad does NOT rescue
    // (it pads only the different key, input_props.voiceover_url). So the budget
    // is re-derived from the composition THIS row actually renders on, and an
    // overrun is trimmed at a sentence boundary and logged rather than cut
    // mid-word. Idempotent: a script already within budget passes through
    // untouched, so this is a no-op for every row written after the cap.
    const rawScript = (props.narrationScript as string | undefined)?.trim() ?? ""
    const fit = fitNarrationToBudget(rawScript, sectionNarrationBudget(r.composition_id))
    if (fit.note) console.warn(`[section-narration-orchestrator] render ${r.id} — ${fit.note}`)
    const script = fit.script
    const plan = planSectionNarrationJob({ hasScript: !!script, hasVoiceClone: !!voiceId, hasAvatarSource: !!avatarSource })

    let voiceoverUrl: string | null = null
    if (plan.voiceover && voiceId) {
      try {
        const { synthesizeSpeech } = await import("@/lib/voice/elevenlabs-tts")
        const tts = await synthesizeSpeech({ text: script, voiceId, brokerageId: pres.brokerage_id })
        if (tts.success && tts.audioBuffer) {
          const { put } = await import("@vercel/blob")
          const up = await put(`narration/${pres.brokerage_id}/${r.id}.mp3`, tts.audioBuffer, { access: "public", contentType: "audio/mpeg" })
          voiceoverUrl = up.url
          // narrationScript is written back as the script that was ACTUALLY
          // spoken. Leaving the pre-trim text beside the trimmed audio would
          // make the row disagree with its own mp3, and this column is the only
          // record of what the voice said.
          await supabase.from("remotion_composition_renders")
            .update({ input_props: { ...props, narrationScript: script, voiceoverUrl }, used_voiceover: true })
            .eq("id", r.id)
        }
      } catch { /* voice synth is best-effort → falls back to on-screen */ }
    }

    if (plan.avatar && avatarSource) {
      // Request the D-ID talking head via the existing handoff: a project whose
      // provider_metadata.target_composition_id routes the finished avatar into
      // THIS render's input_props on completion. Best-effort.
      try {
        await supabase.from("ai_video_projects").insert({
          agent_id:    r.agent_user_id ?? pres.agent_user_id,
          brokerage_id: pres.brokerage_id,
          title:       `Section narration ${r.composition_id}`,
          status:      "draft",
          provider_metadata: {
            provider: "did", target_composition_id: r.composition_id,
            target_render_id: r.id, voiceover_url: voiceoverUrl, voice_id: voiceId,
            narration_script: script, did_avatar_id: avatarSource,
          },
        })
      } catch { /* avatar request best-effort → voice_only / on_screen */ }
    }

    if (plan.mode === "avatar_narrated") result.avatarNarrated++
    else if (plan.mode === "voice_only") result.voiceOnly++
    else result.onScreenOnly++
  }

  return result
}
