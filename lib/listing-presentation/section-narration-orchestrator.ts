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

/** What an agent actually has to narrate with. Both halves are optional and
 *  independently absent — see the graceful-degradation table in the header. */
export interface AgentNarrationAssets {
  /** ElevenLabs voice id from agent_voice_profiles, or null. */
  voiceId: string | null
  /** D-ID avatar id from the agent's DEFAULT, READY avatar asset, or null. */
  avatarSource: string | null
  /**
   * The AGENTS-class id behind the user (agents.id — the row the two asset
   * lookups above are keyed by). Returned because the avatar request write
   * needs it: ai_video_projects.agent_id FKs agents(id)
   * (scripts/schema-fk-map.ts), and this function is the one place the
   * users→agents cross is already performed — a caller re-deriving it is the
   * §6 defect, and a caller writing the users-class id instead is a 23503
   * (the exact dormant bug fixed 2026-09-01: the insert below wrote
   * `agent_user_id` into that FK and only never fired because
   * agent_avatar_assets held zero live rows).
   */
  agentRecordId: string | null
}

/**
 * Resolve the agent's voice clone + avatar source. ONE spelling (§6).
 *
 * ── THE IDENTITY-CLASS TRAP THIS FUNCTION EXISTS TO CONTAIN ────────────────
 * pass 12: `agent_voice_profiles.agent_id` and `agent_avatar_assets.agent_id`
 * both FK `agents(id)`, but every listing-presentation row carries
 * `agent_user_id`, which is the USERS class — and CLAUDE.md §3 records that
 * `agents.id` and `users.id` are DISJOINT. Filtering the asset tables by a user
 * id therefore matches NOTHING and reports it as "this agent has no clone",
 * which is byte-identical to the truth and silently degraded every section to
 * on-screen. The cross through `agents.user_id` is the fix, and it is written
 * ONCE here because the marketing-system resolver now needs the same answer for
 * a different reason: it must not promise a seller a video series in an agent's
 * cloned voice when that agent has no clone. Two callers deriving "does this
 * agent have a voice" from two hand-rolled queries is exactly the §6 defect —
 * one of them would eventually be written against `agent_user_id` again.
 */
export async function resolveAgentNarrationAssets(
  supabase: ReturnType<typeof createServiceClient>,
  agentUserId: string | null | undefined,
): Promise<AgentNarrationAssets> {
  const none: AgentNarrationAssets = { voiceId: null, avatarSource: null, agentRecordId: null }
  if (!agentUserId) return none

  const { data: agentRow, error: agentError } = await supabase
    .from("agents").select("id").eq("user_id", agentUserId).maybeSingle()
  // §3 — supabase-js RESOLVES refusals. A refused read is NOT "no such agent";
  // reporting it as absent assets is the honest degrade, but it must be visible.
  if (agentError) {
    console.warn(`[section-narration-orchestrator] could not resolve agent for user ${agentUserId}: ${agentError.message}`)
    return none
  }
  const agentId = (agentRow as { id?: string } | null)?.id ?? null
  if (!agentId) return none

  const [vp, av] = await Promise.all([
    supabase.from("agent_voice_profiles").select("elevenlabs_voice_id").eq("agent_id", agentId).maybeSingle(),
    supabase.from("agent_avatar_assets").select("did_avatar_id")
      .eq("agent_id", agentId).eq("status", "ready").eq("is_default", true).maybeSingle(),
  ])
  if (vp.error) console.warn(`[section-narration-orchestrator] voice profile read refused: ${vp.error.message}`)
  if (av.error) console.warn(`[section-narration-orchestrator] avatar asset read refused: ${av.error.message}`)

  return {
    voiceId:      (vp.data as { elevenlabs_voice_id?: string | null } | null)?.elevenlabs_voice_id ?? null,
    avatarSource: (av.data as { did_avatar_id?: string | null } | null)?.did_avatar_id ?? null,
    agentRecordId: agentId,
  }
}

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
  /** D-ID talking-head jobs actually SUBMITTED and linked to a pollable row. */
  avatarSubmitted: number
  /**
   * Sections that planned an avatar and did not get one, with the reason.
   *
   * `avatarNarrated` counts the PLAN; this counts the OUTCOME, and the two used
   * to be conflated because nothing ever submitted anything — the plan was the
   * only number there was, and it reported a talking head for every section of
   * a lane that has never produced one.
   */
  avatarSkipped: Array<{ renderId: string; reason: string }>
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
  const empty: NarrateResult = { sections: 0, avatarNarrated: 0, voiceOnly: 0, onScreenOnly: 0, hasVoiceClone: false, hasAvatarSource: false, avatarSubmitted: 0, avatarSkipped: [] }

  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("brokerage_id, agent_user_id")
    .eq("id", presentationId)
    .maybeSingle()
  if (!pres?.brokerage_id) return empty

  // Resolve the agent's voice clone + avatar source (both optional). The cross
  // from the USERS class to agents.id, and the reason it is mandatory, live in
  // resolveAgentNarrationAssets above — ONE spelling, shared with the
  // marketing-system resolver (§6).
  const { voiceId, avatarSource, agentRecordId } = await resolveAgentNarrationAssets(supabase, pres.agent_user_id)

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

    // ── ONE VOICE, NOT TWO ────────────────────────────────────────────────────
    // `plan.voiceover` and `plan.avatar` are independently true when the agent
    // has BOTH a clone and an avatar — which is the normal, fully-configured
    // case — and this branch used to synthesize the mp3 anyway and stage it on
    // `input_props.voiceoverUrl`. ListingSectionReel plays that as a bare
    // `<Audio src=…>` (remotion/ListingSectionReel.tsx:63) while the D-ID track
    // arrives as an UNMUTED `<Video src={avatarVideoUrl}>` inside the slide
    // (remotion/ListingPresentationSlide.tsx:324) — so the finished section
    // would have spoken the same sentence twice, over itself. It never happened
    // only because the avatar was never submitted; lighting the lane is what
    // makes it reachable, so it is closed in the same change.
    //
    // The avatar carries the audio, and in the agent's OWN cloned voice: the
    // ElevenLabs voice id goes to D-ID at submit time. So the separate
    // synthesis is not merely redundant, it is a second ElevenLabs charge for
    // audio nobody should hear. `planSectionNarrationJob` already ranks the
    // modes this way (avatar wins over voice_only) and is left untouched — the
    // fix belongs in the consumer, which is what disagreed with the plan.
    const synthesizeVoiceover = plan.voiceover && !plan.avatar

    let voiceoverUrl: string | null = null
    if (synthesizeVoiceover && voiceId) {
      try {
        const { synthesizeSpeech } = await import("@/lib/voice/elevenlabs-tts")
        const tts = await synthesizeSpeech({ text: script, voiceId, brokerageId: pres.brokerage_id })
        if (tts.success && tts.audioBuffer) {
          // Was @vercel/blob's put(). Survivor:
          // lib/remotion/media-host.ts#hostRenderedMedia → `video-assets`, the
          // bucket the Remotion workers already fetch narration from by URL.
          const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
          voiceoverUrl = await hostRenderedMedia(
            supabase,
            `narration/${pres.brokerage_id}/${r.id}.mp3`,
            tts.audioBuffer,
            "audio/mpeg",
          )
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

    if (plan.avatar && avatarSource && agentRecordId) {
      // ── THE LANE WAS DARK, AND THIS IS WHERE IT STOPPED ────────────────────
      // This block used to INSERT the request at status='draft' with no
      // provider_job_id and no D-ID submit anywhere in the tree.
      // poll-did-videos adopts only (status='generating' AND provider_job_id IS
      // NOT NULL AND provider_metadata->>provider='did'); director-reel-render
      // adopts only (status='queued' AND video_metadata.director_key AND
      // provider_metadata.composition_id). The row matched NEITHER, so it sat
      // forever — a writer with no reader — and every narrated presentation
      // section has shipped as the static-photo PIP since the lane was built,
      // while this function reported `avatarNarrated` for each one.
      //
      // The submit now happens, through the ONE shared path
      // (lib/video/avatar-track-submit.ts) the seller-update and buyer-
      // consultation lanes also call. On completion,
      // enqueueAvatarCompositionForProject reads target_render_id and merges
      // the avatar into THIS staged row (or repoints the section at a fresh
      // avatar-led render when the staged one is already terminal) — a reader
      // that, until now, had never once executed because nothing upstream ever
      // reached it.
      //
      // The SCRIPT is written back first: `fitNarrationToBudget` may have
      // trimmed it, and the avatar is about to speak the trimmed text, so the
      // row must not keep the untrimmed version as its record of what was said.
      // In voice_only mode the synthesis branch above already did this.
      if (!synthesizeVoiceover && script && script !== rawScript) {
        const { error: sErr } = await supabase.from("remotion_composition_renders")
          .update({ input_props: { ...props, narrationScript: script } })
          .eq("id", r.id)
        if (sErr) console.warn(`[section-narration-orchestrator] trimmed-script write-back refused for render ${r.id}: ${sErr.message}`)
      }

      const { submitAvatarTrack } = await import("@/lib/video/avatar-track-submit")
      const sub = await submitAvatarTrack(supabase, {
        brokerageId: pres.brokerage_id,
        // AGENTS-class id (ai_video_projects.agent_id → agents.id,
        // scripts/schema-fk-map.ts). WAS `r.agent_user_id ?? pres.agent_user_id`
        // — a USERS-class id, disjoint from agents.id (§3), so the moment any
        // agent had a ready avatar every request here would have been refused
        // with 23503. resolveAgentNarrationAssets already performs the
        // users→agents cross for its asset lookups; agentRecordId is that same
        // answer, returned instead of re-derived.
        agentRecordId,
        agentUserId:    pres.agent_user_id ?? null,
        script,
        targetRenderId: r.id,
        title:          `Section narration ${r.composition_id}`,
        // An admitted value of the live video_type CHECK (m119, added for
        // exactly this: chapter videos riding the same completion pipeline).
        videoType:       "presentation_chapter",
        videoTypeIntent: "listing_presentation_section",
        request: {
          target_composition_id: r.composition_id,
          // The STAGED row's own props, so the orchestrator's fallback path can
          // seed a replacement render with the real slide instead of the
          // composition's Studio sample data.
          input_props: { ...props, narrationScript: script },
          entity_type: "listing_presentation",
          entity_id:   presentationId,
        },
        // Deliberately omitted: in avatar mode no separate mp3 exists (see the
        // one-voice-not-two note above), so there is nothing to merge and
        // nothing that could double up on the avatar's own audio.
      })
      if (sub.submitted) result.avatarSubmitted++
      else {
        console.warn(`[section-narration-orchestrator] render ${r.id} ships as the photo PIP — ${sub.reason}`)
        result.avatarSkipped.push({ renderId: r.id, reason: sub.reason })
      }
    }

    if (plan.mode === "avatar_narrated") result.avatarNarrated++
    else if (plan.mode === "voice_only") result.voiceOnly++
    else result.onScreenOnly++
  }

  return result
}
