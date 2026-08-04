/**
 * lib/video/avatar-render-orchestrator.ts
 *
 * Wave 39 — closes the D-ID → Remotion broken link in the avatar/explainer loop.
 *
 * Before this, a D-ID talking-head video completed and its URL landed on
 * ai_video_projects.video_url, but NOTHING copied that URL into a Remotion
 * render's input_props — so AgentTalkingHeadReel / AgentExplainerReel always
 * fell back to a static photo. This orchestrator performs the handoff: when a
 * D-ID job that was requested as the avatar track for a composition completes,
 * it enqueues that composition render with the avatar URL wired into
 * input_props. The existing composition-render-queue cron then renders it, the
 * coordinator brands + uploads it, and it can be published to /v/[slug].
 *
 * The intent is declared at D-ID submit time via
 * ai_video_projects.provider_metadata.target_composition_id (+ optional
 * voiceover_url and input_props). Projects without a target are skipped, so
 * this is fully backward compatible.
 *
 * Not server-only: the pure row builder is unit-tested; the enqueue uses the
 * service client. Never import from a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"

export interface AvatarRenderRowParams {
  brokerageId:      string
  agentId:          string | null
  compositionId:    string
  avatarVideoUrl:   string
  voiceoverUrl?:    string | null
  extraInputProps?: Record<string, unknown>
  entityType?:      string | null
  entityId?:        string | null
}

/**
 * Pure: build the remotion_composition_renders insert payload for an avatar
 * composition. The avatar (and optional voiceover) URL is merged into
 * input_props over any caller-supplied props, and the used_* flags + scope are
 * set so the queue, coordinator, and tier gate all see a DID-avatar render.
 */
export function buildAvatarRenderRow(p: AvatarRenderRowParams): Record<string, unknown> {
  const voiceover = p.voiceoverUrl ?? null
  return {
    brokerage_id:    p.brokerageId,
    composition_id:  p.compositionId,
    agent_user_id:   p.agentId,
    entity_type:     p.entityType ?? null,
    entity_id:       p.entityId ?? null,
    used_did_avatar: true,
    used_voiceover:  !!voiceover,
    render_status:   "queued",
    input_props: {
      ...(p.extraInputProps ?? {}),
      avatarVideoUrl: p.avatarVideoUrl,
      voiceoverUrl:   voiceover,
    },
    scope_type:    "agent",
    scope_id:      p.agentId,
    // Enqueued from the poll-did-videos cron (requested_via allowlist:
    // asset_manager/ad_creator/cron/manual/api). The DID-avatar provenance is
    // carried by used_did_avatar + input_props.avatarVideoUrl.
    requested_via: "cron",
    is_published:  false,
  }
}

export type EnqueueResult =
  | { ok: true; renderId: string }
  | { ok: false; skipped: string }

/**
 * Read a completed D-ID project and, if it was requested as the avatar track
 * for a composition, enqueue that Remotion render with the avatar URL wired in.
 * Idempotent-ish: callers invoke it once on completion; a project without a
 * target_composition_id (or without a video URL) is skipped.
 */
export async function enqueueAvatarCompositionForProject(
  projectId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<EnqueueResult> {
  const supabase = client ?? createServiceClient()

  const { data: project } = await supabase
    .from("ai_video_projects")
    .select("id, brokerage_id, agent_id, video_url, provider_metadata")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) return { ok: false, skipped: "project not found" }

  const meta = (project.provider_metadata ?? {}) as Record<string, any>
  const compositionId = meta.target_composition_id as string | undefined
  if (!compositionId) return { ok: false, skipped: "no target_composition_id — not a composition request" }
  if (!project.brokerage_id) return { ok: false, skipped: "project has no brokerage_id" }

  // Prefer the CLEAN (un-branded) D-ID render as the avatar track — Remotion
  // applies its own brand chrome, so a pre-branded source would double-brand.
  const avatarVideoUrl = (meta.clean_video_url as string | null) ?? project.video_url
  if (!avatarVideoUrl) return { ok: false, skipped: "no avatar video URL on completed project" }

  // buildAvatarRenderRow fills remotion_composition_renders.agent_user_id (and
  // scope_id), which is users-class — /v/[slug] reads it straight into a users
  // lookup for the public page's agent attribution. ai_video_projects.agent_id is
  // agents-class since m366, so it crosses here. Null ⇒ the render is enqueued
  // unattributed rather than stamped with an id from the other space.
  // Client-agnostic resolver on purpose — this module declares itself "not
  // server-only" above, so it must never drag `server-only` into a bundle.
  const { resolveUserIdForAgentRecord } = await import("@/lib/kernel/agent-identity")
  const agentUserId = project.agent_id ? await resolveUserIdForAgentRecord(supabase, project.agent_id) : null
  if (project.agent_id && !agentUserId) {
    console.warn(`[avatar-render-orchestrator] no users row behind agents.id=${project.agent_id} (project ${projectId}) — render enqueued unattributed`)
  }

  const row = buildAvatarRenderRow({
    brokerageId:     project.brokerage_id,
    agentId:         agentUserId,
    compositionId,
    avatarVideoUrl,
    voiceoverUrl:    (meta.voiceover_url as string | null) ?? null,
    extraInputProps: (meta.input_props as Record<string, unknown>) ?? {},
    entityType:      (meta.entity_type as string | null) ?? null,
    entityId:        (meta.entity_id as string | null) ?? null,
  })

  const { data: inserted, error } = await supabase
    .from("remotion_composition_renders")
    .insert(row)
    .select("id")
    .single()
  if (error || !inserted) return { ok: false, skipped: `insert failed: ${error?.message ?? "unknown"}` }

  return { ok: true, renderId: (inserted as { id: string }).id }
}
