/**
 * app/api/cron/director-reel-render/route.ts
 *
 * THE MISSING EXECUTION HALF of the Video Director. The Asset Manager DIRECTS (commissionVideo stages
 * an ai_video_projects row at status='queued' with the composition + intro/outro/QR props),
 * but nothing ever rendered those rows — so every Director-commissioned reel (buyer welcome, the
 * situational reels, the seller-conversion reel) died at staging and the asset_manager →
 * campaign_orchestrator handoff never fired. This worker EXECUTES the direction:
 *
 *   avatar reels  → resolve the agent's avatar + ElevenLabs voice → submit the D-ID talking head
 *                   (submitOnly) → status='generating' + target_composition_id. poll-did-videos then
 *                   completes it and hands the avatar to the Remotion composition (bookends + QR).
 *   non-avatar    → enqueue the Remotion composition render directly (no D-ID).
 *   no presenter  → park the reel + notify the agent to finish their avatar/voice setup (graceful).
 *
 * On the FINAL composite completion, render-composition publishes contact_outreach_ready → the
 * Campaign Orchestrator delivers the gated 1:1 to the client. One reel per tick (serialized — D-ID +
 * Remotion are memory-heavy on a single function instance). CRON_SECRET auth. Never throws the loop.
 */
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface ReelRow {
  id: string
  brokerage_id: string | null
  agent_id: string | null
  contact_id: string | null
  script_content: string | null
  provider_metadata: Record<string, unknown> | null
  video_metadata: Record<string, unknown> | null
}

export async function GET(request: Request) {
  const unauthorized = verifyCronAuth(request)
  if (unauthorized) return unauthorized

  const svc = createServiceClient()
  const ranAt = new Date().toISOString()

  // 0. THE WATCHDOG (wave 87, lane 87D). No video row may sit in 'queued' /
  //    'generating' forever: every tick drives the ONE stale-workflow reaper
  //    (lib/video/video-pipeline-reaper.ts) for the tenants holding a row past
  //    its threshold — a stalled render is written 'failed' + error_message and
  //    its agent is told. The daily reaper-net pass stays; this is the cadence.
  const { sweepStuckVideoRenders } = await import("@/lib/video/video-pipeline-reaper")
  const watchdog = await sweepStuckVideoRenders(svc)
  if (watchdog.error) console.error("[director-reel-render] stuck-render watchdog:", watchdog.error)

  // 1. Find Director-commissioned staged reels (video_metadata.director_key marks commissionVideo's
  //    rows; requested_via='asset_manager' confirms the Director rail). Oldest first.
  const { data: rows } = await svc.from("ai_video_projects")
    .select("id, brokerage_id, agent_id, contact_id, script_content, provider_metadata, video_metadata")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(20)
  const candidates = ((rows ?? []) as ReelRow[]).filter((r) => {
    const vm = (r.video_metadata ?? {}) as Record<string, unknown>
    return !!vm.director_key && !!(r.provider_metadata as any)?.composition_id
  })
  if (candidates.length === 0) {
    return NextResponse.json({ ran_at: ranAt, processed: 0, watchdog })
  }

  const row = candidates[0]

  // 2. Claim atomically (queued → generating) so a concurrent tick can't double-submit.
  const { data: claimed } = await svc.from("ai_video_projects")
    .update({ status: "generating", updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "queued")
    .select("id").maybeSingle()
  if (!claimed) {
    return NextResponse.json({ ran_at: ranAt, processed: 0, note: "row already claimed" })
  }

  const meta = (row.provider_metadata ?? {}) as Record<string, any>
  const vmeta = (row.video_metadata ?? {}) as Record<string, any>
  const compositionId: string = meta.composition_id
  const inputProps: Record<string, unknown> = (meta.input_props ?? {}) as Record<string, unknown>
  const needsAvatar: boolean = !!vmeta.needs_avatar
  // ai_video_projects.agent_id is agents-class since m366, but everything below
  // this line — the presenter/voice lookup, the D-ID submit, notifications.user_id,
  // remotion_composition_renders.agent_user_id — speaks the OWNER'S USERS id. One
  // resolve here rather than one per hand-off. A null resolve on a non-null
  // agent_id means the agents row is gone; the reel is failed, never re-pointed at
  // the other id space.
  const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
  const agentUserId: string | null = row.agent_id
    ? await resolveAgentRecordToUserId(row.agent_id)
    : null
  if (row.agent_id && !agentUserId) {
    await fail(svc, row.id, `no users row behind agents.id=${row.agent_id} — reel cannot be attributed`)
    return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "failed_agent_unresolved" })
  }
  const brokerageId: string | null = row.brokerage_id

  try {
    if (needsAvatar) {
      // ── Avatar reel → submit the D-ID talking head, then let poll-did-videos drive completion ──
      const script = (row.script_content ?? "").trim()
      if (!script) {
        await fail(svc, row.id, "no narration script on the staged reel")
        return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "failed_no_script" })
      }
      if (!agentUserId || !brokerageId) {
        await fail(svc, row.id, "missing agent or brokerage on the staged reel")
        return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "failed_no_owner" })
      }

      const { resolveAgentPresenterMedia } = await import("@/lib/video/presenter-media")
      const { resolveVideoVoiceId } = await import("@/lib/video/module-voice")
      const presenter = await resolveAgentPresenterMedia({ agentUserId, brokerageId }, svc)
      // VOICE BY AUDIENCE — an agent-facing module (video_metadata.voice === 'assistant') renders in the
      // brokerage's assistant voice; a contact-facing one keeps the agent's own cloned voice.
      const renderVoiceId = await resolveVideoVoiceId(
        { voiceKind: (vmeta.voice as "agent_own" | "assistant" | undefined) ?? null, presenterVoiceId: presenter.voiceId, brokerageId }, svc,
      )
      if (!presenter.canRender) {
        // GRACEFUL DEGRADE — the agent hasn't finished their avatar setup. Park + notify them.
        await svc.from("ai_video_projects")
          .update({ status: "awaiting_presenter_setup", error_message: "agent has no D-ID avatar configured", updated_at: new Date().toISOString() })
          .eq("id", row.id)
        await sentinelWrite(svc, svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: brokerageId, type: "avatar_setup_needed",
          title: "Finish your avatar to unlock AI videos",
          body: "Your AI team is ready to make personal videos for your clients — set up your avatar + voice in Settings → Voice & Avatar to turn them on.",
          entity_type: "video_project", entity_id: row.id, priority: "medium", is_read: false,
        }), { table: "notifications", flow: "route_notify", brokerageId: brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
        return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "awaiting_presenter_setup" })
      }

      const { generateVideo } = await import("@/lib/did")
      const r = await generateVideo({
        script,
        voiceId: renderVoiceId ?? undefined,
        actorId: presenter.actorId,
        avatarImageUrl: presenter.avatarImageUrl,
        agentUserId, brokerageId,
        // SENTIMENT-FROM-CONTENT: the situation decides the performance
        // (celebratory for wins, steady for analysis); the agent's configured
        // expression wins when they set one explicitly.
        expression: presenter.expression ?? (await import("@/lib/video/video-director")).sentimentForSituation((vmeta.situation_kind as any) ?? "explainer"),
        submitOnly: true,
      })
      if (r.status === "error" || !r.videoId) {
        await fail(svc, row.id, r.note ?? "D-ID submit failed")
        return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "did_submit_failed" })
      }

      // Stamp the talk id + the avatar→composition handoff. poll-did-videos polls this 'generating'
      // job; on completion enqueueAvatarCompositionForProject reads target_composition_id and wires
      // the avatar URL into the Remotion composition (entity_type='video_project' threads the project
      // id to render-composition so the FINAL composite publishes contact_outreach_ready).
      //
      // WAVE 87 — THE STAMP IS READ. It was a bare await: a refused UPDATE
      // resolved, the D-ID job was paid for and unlinked, and the row sat in
      // 'generating' with no provider_job_id for the poller to chase — stranded
      // until a reaper noticed. Now a refusal writes the terminal status with
      // the talk id (so the job can be reattached), and the tick says so.
      const { error: stampErr } = await svc.from("ai_video_projects")
        .update({
          status: "generating",
          provider_job_id: r.videoId,
          provider_status: "processing",
          provider_metadata: {
            ...meta,
            provider: "did",
            // Engine RECORDED at submit (talks = V2 photo, expressives = V4);
            // the poll cron keys off this — never guessed from id shapes.
            mode: r.engine === "expressives" ? "expressive" : (meta.mode ?? null),
            // The performance actually submitted (agent override or the
            // situation's sentiment) — the flywheel's outcome dimension.
            expression_used: presenter.expression ?? (vmeta.sentiment as string | undefined) ?? null,
            talk_id: r.videoId,
            target_composition_id: compositionId,
            input_props: inputProps,
            entity_type: "video_project",
            entity_id: row.id,
          },
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
      if (stampErr) {
        await fail(svc, row.id, `D-ID job ${r.videoId} submitted but the handoff stamp was refused (${stampErr.message}) — reattach the talk id to finish it`)
        return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "did_stamp_refused", talk_id: r.videoId })
      }
      return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "did_submitted", talk_id: r.videoId })
    }

    // ── Non-avatar reel → enqueue the Remotion composition render directly (no D-ID) ──
    //
    // WAVE 87 (lane 87D) — THE VOICEOVER HOST SPEAKS. A Director reel planned on
    // the VOICEOVER host (no D-ID twin: the topic runner's voiceover_explainer,
    // and render-from-approval's fallback) was enqueued with NO narration: the
    // composition plays `voiceoverUrl` and nothing staged one, so the "voiceover
    // video" rendered as kinetic text over music. The narration is synthesized
    // HERE, once, through the ONE primitive (prepareReelVoiceover: the agent's
    // own voice → the brokerage assistant's → stock, the narration cache, the
    // vendor budget gate), the body is re-sized to the MEASURED narration
    // (spokenSecondsProps — the section-narration-orchestrator pattern) and the
    // captions are word-synced from the alignment. What is spoken: the staged
    // narrationScript (an approved script, verbatim), or — for a described
    // (custom) reel — its captionScript, which IS its script. A situational reel
    // that staged only a hook caption is left as it was.
    const staged = await stageVoiceoverNarration(svc, {
      compositionId, inputProps, brokerageId, agentUserId,
      situationKind: ((vmeta.situation as { kind?: string } | undefined)?.kind) ?? null,
      renderKey: row.id,
    })
    if (staged.note) console.warn(`[director-reel-render] ${row.id}: ${staged.note}`)
    const renderRow = {
      brokerage_id: brokerageId,
      composition_id: compositionId,
      agent_user_id: agentUserId,
      entity_type: "video_project",
      entity_id: row.id,
      render_status: "queued",
      input_props: staged.props,
      ...(staged.voiced ? { used_voiceover: true } : {}),
      scope_type: "agent",
      scope_id: agentUserId,
      requested_via: "cron",
      is_published: false,
    }
    const { error: rqErr } = await svc.from("remotion_composition_renders").insert(renderRow)
    if (rqErr) {
      await fail(svc, row.id, `composition enqueue failed: ${rqErr.message}`)
      return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "enqueue_failed" })
    }
    // status stays 'generating' — the composition-render-queue cron drains the queued row.
    return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "composition_enqueued" })
  } catch (e) {
    await fail(svc, row.id, (e as Error).message)
    return NextResponse.json({ ran_at: ranAt, processed: 1, render_id: row.id, result: "error", error: (e as Error).message }, { status: 500 })
  }
}

async function fail(svc: ReturnType<typeof createServiceClient>, id: string, reason: string) {
  // WAVE 87 — the terminal stamp is READ: a refused write left the row claimed
  // at 'generating' with nothing chasing it. The watchdog (step 0) is the
  // backstop for exactly that; this says so in the log instead of trusting it.
  const { error } = await svc.from("ai_video_projects")
    .update({ status: "failed", error_message: reason.slice(0, 800), updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) console.error(`[director-reel-render] terminal stamp refused for ${id} (${error.message}) — the stuck-render watchdog will reap it; reason was: ${reason.slice(0, 200)}`)
}

/**
 * The voiceover host's narration (wave 87). Returns the props to enqueue —
 * unchanged when the composition plays no in-frame voiceover, one is already
 * staged, the plan is not voiceover-hosted, or there is nothing to say. A
 * synthesis that returns nothing ships the reel on its captions (the standing
 * best-effort rule) and the reason is RETURNED, never swallowed.
 */
async function stageVoiceoverNarration(
  svc: ReturnType<typeof createServiceClient>,
  a: { compositionId: string; inputProps: Record<string, unknown>; brokerageId: string | null; agentUserId: string | null; situationKind: string | null; renderKey: string },
): Promise<{ props: Record<string, unknown>; voiced: boolean; note: string | null }> {
  const props = a.inputProps
  const { consumesVoiceover, isSupplied } = await import("@/lib/remotion/content-contract")
  if (!consumesVoiceover(a.compositionId) || isSupplied(props.voiceoverUrl) || isSupplied(props.voiceover_url)) return { props, voiced: false, note: null }
  const plan = props.bodyVisualPlan as { host?: string } | undefined
  if (plan?.host !== "voiceover") return { props, voiced: false, note: null }
  const narration = typeof props.narrationScript === "string" && props.narrationScript.trim()
    ? props.narrationScript.trim()
    : a.situationKind === "custom" && typeof props.captionScript === "string" ? props.captionScript.trim() : ""
  if (!narration) return { props, voiced: false, note: null }
  if (!a.brokerageId) return { props, voiced: false, note: "voiceover host with no brokerage — narration not synthesized" }
  try {
    const { resolveAgentPresenterMedia } = await import("@/lib/video/presenter-media")
    const { resolveVideoVoiceId } = await import("@/lib/video/module-voice")
    const presenter = a.agentUserId ? await resolveAgentPresenterMedia({ agentUserId: a.agentUserId, brokerageId: a.brokerageId }, svc) : null
    const voiceId = await resolveVideoVoiceId({ voiceKind: "agent_own", presenterVoiceId: presenter?.voiceId ?? null, brokerageId: a.brokerageId }, svc)
    const { prepareReelVoiceover } = await import("@/lib/video/reel-voiceover")
    const vo = await prepareReelVoiceover({ brokerageId: a.brokerageId, narration, voiceId, renderKey: a.renderKey })
    if (!vo) return { props, voiced: false, note: "voiceover host: prepareReelVoiceover returned no clip (no voice, budget gate, synthesis or hosting) — the reel ships on its captions" }
    const { spokenSecondsProps, planDurationForProps } = await import("@/lib/video/duration-model")
    const { geometryFor } = await import("@/lib/remotion/composition-geometry")
    const { buildCaptionPlan } = await import("@/lib/video/caption-plan")
    const spoken = spokenSecondsProps({ measuredSeconds: vo.durationSeconds ?? null, narration, compositionId: a.compositionId })
    const next: Record<string, unknown> = { ...props, narrationScript: narration, voiceoverUrl: vo.url, ...spoken }
    const geo = geometryFor(a.compositionId)
    if (geo && vo.alignment) {
      const planned = planDurationForProps(a.compositionId, next)
      const cues = buildCaptionPlan(vo.alignment, planned.durationInFrames, geo.fps, { maxWordsPerCue: 4 }).cues
      if (cues.length > 0) next.captionsCues = cues
    }
    return { props: next, voiced: true, note: null }
  } catch (e) {
    return { props, voiced: false, note: `voiceover host: narration failed (${(e as Error).message}) — the reel ships on its captions` }
  }
}
