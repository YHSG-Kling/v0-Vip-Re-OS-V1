/**
 * lib/kernel/welcome-personal-video.ts
 *
 * "IS THERE A PERSONAL VIDEO FROM **THIS AGENT** I CAN PUT IN THE WELCOME?"
 *
 * OWNER RULING, verbatim: "the contact gets access to their portal so the
 * welcome package is getting an email from the assigned agent with portal
 * access and in the emila and in the portal a personal video from agent."
 *
 * ── THIS MODULE COMMISSIONS NOTHING ─────────────────────────────────────────
 *
 * The platform already has ONE avatar/video spine and this file deliberately
 * adds no second one. It only READS the spine's output:
 *
 *   · lib/video/intro-video-reactor.ts  — dispatchAssignmentIntroVideo, fired by
 *     the kernel on CONTACT_AGENT_ASSIGNED. Renders a D-ID talking head from the
 *     assigned agent's own avatar + cloned voice and files it as
 *     agent_intro_videos (m121, one row per contact × agent × trigger) linked to
 *     an ai_video_projects row.
 *   · lib/video/avatar-explainer.ts     — commissionAvatarExplainer, the Director
 *     rail's `avatar_explainer` lane (m274), same D-ID + ElevenLabs engine.
 *   · lib/video/playable-video.ts       — resolvePlayableVideo, THE one answer to
 *     "what is the playable URL for this finished video", across both engines,
 *     and the only place that knows a compliance-FAILED reel is not playable.
 *
 * So the welcome does not create a render, does not wait on one, and cannot
 * invent one. It asks whether a finished, compliant, customer-facing video from
 * the assigned agent EXISTS RIGHT NOW.
 *
 * ── WHY THE HONEST ANSWER IS USUALLY "none" AT FIRST TOUCH ──────────────────
 *
 * A D-ID render is asynchronous — minutes, and only after the agent has finished
 * Settings → Voice & Avatar. The welcome email goes out at capture. So on a
 * brand-new contact whose intro render was commissioned seconds ago, the honest
 * answer is `in_progress`, and on an agent who has never recorded an avatar it is
 * `none`. NEITHER of those is allowed to produce a placeholder: a "your video is
 * being prepared" block in an email signed by a named human implies that human
 * recorded something they did not. The welcome ships WITHOUT the video and says
 * nothing about video at all.
 *
 * ── ID CLASSES (m366) ───────────────────────────────────────────────────────
 *
 * `ai_video_projects.agent_id` and `agent_intro_videos.agent_id` are BOTH
 * agents(id) since m366 re-pointed the twenty stragglers off users(id). This
 * module therefore takes an `agentRecordId` (the value that sits on
 * `contacts.agent_id`) and never a users id. Passing a users id here would match
 * zero rows and report a perfectly-configured agent as having no video.
 *
 * PURE READS. No sends, no writes, never throws — a welcome must never fail
 * because a video lookup did.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/**
 * ai_video_projects.video_type values that are a PERSONAL PIECE TO CAMERA from
 * the agent — the only kinds that may stand in for "a personal video from your
 * agent". A listing tour or a market update is the agent's work, not the agent
 * introducing themselves, and putting one in a welcome would be a bait.
 *
 * Every value is drawn from the live `video_type` vocabulary
 * (scripts/check-vocabularies.ts) — 'avatar_explainer' arrived with m274.
 */
const PERSONAL_WELCOME_VIDEO_TYPES = [
  "agent_intro",
  "welcome",
  "avatar_explainer",
] as const

/** Where the clip came from — carried into the ledger so the claim is auditable. */
export type WelcomeVideoScope =
  /** Rendered FOR THIS CONTACT by the assignment-intro reactor. The best case. */
  | "contact_personal"
  /** The agent's own standing personal video (intro / welcome / explainer). */
  | "agent_personal"

export type WelcomePersonalVideo =
  | {
      state: "ready"
      videoUrl: string
      thumbnailUrl: string | null
      scope: WelcomeVideoScope
      videoProjectId: string
    }
  /** A render for this agent is genuinely in flight — send without it anyway. */
  | { state: "in_progress"; reason: string }
  /** Nothing playable exists. `reason` is always populated and is agent-actionable. */
  | { state: "none"; reason: string }

export interface ResolveWelcomeVideoInput {
  brokerageId: string
  /** contacts.id — the person being welcomed. */
  contactId: string
  /** contacts.agent_id — an AGENTS id (m366). Never a users id. */
  agentRecordId: string
}

/**
 * The assigned agent's personal video for this welcome, or an honest "none".
 *
 * Precedence, most personal first:
 *   1. the assignment-intro clip rendered FOR THIS CONTACT (agent_intro_videos);
 *   2. the agent's most recent finished personal video (agent_intro / welcome /
 *      avatar_explainer), customer-facing;
 *   3. nothing — with the reason on the record.
 *
 * supabase-js RESOLVES a refused read, so every read below is destructured. A
 * refusal is reported as `none` with the refusal text — NOT silently merged with
 * "this agent has no video", because the two call for different fixes.
 */
export async function resolveWelcomePersonalVideo(
  svc: Svc,
  input: ResolveWelcomeVideoInput,
): Promise<WelcomePersonalVideo> {
  if (!input.agentRecordId) {
    return { state: "none", reason: "no assigned agent — there is nobody for the video to be from" }
  }

  const { resolvePlayableVideo } = await import("@/lib/video/playable-video")
  const reasons: string[] = []
  let pending: string | null = null

  // ── 1. THIS CONTACT'S OWN intro clip (the reactor's m121 ledger row) ────────
  const { data: introRow, error: introError } = await svc
    .from("agent_intro_videos")
    .select("id, video_project_id, status")
    .eq("brokerage_id", input.brokerageId)
    .eq("contact_id", input.contactId)
    .eq("agent_id", input.agentRecordId)
    .not("video_project_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
  if (introError) {
    reasons.push(`intro-video ledger unreadable: ${introError.message}`)
  } else {
    const projectId = (introRow?.[0]?.video_project_id as string | null) ?? null
    if (projectId) {
      const playable = await resolvePlayableVideo({ videoProjectId: projectId }, svc as any)
      if (playable.state === "ready") {
        return {
          state: "ready",
          videoUrl: playable.videoUrl,
          thumbnailUrl: playable.thumbnailUrl,
          scope: "contact_personal",
          videoProjectId: projectId,
        }
      }
      if (playable.state === "in_progress") {
        pending = "the agent's personal intro clip for this contact is still rendering"
      } else {
        reasons.push(playable.reason)
      }
    }
  }

  // ── 2. The agent's STANDING personal video ──────────────────────────────────
  // Newest first. `audience_type` is filtered to customer_facing so an internal
  // recruiting or training piece can never be mailed to a client.
  const { data: projects, error: projectError } = await svc
    .from("ai_video_projects")
    .select("id, status, video_url, compliance_status, video_type, created_at")
    .eq("brokerage_id", input.brokerageId)
    .eq("agent_id", input.agentRecordId)
    .eq("audience_type", "customer_facing")
    .in("video_type", PERSONAL_WELCOME_VIDEO_TYPES as unknown as string[])
    .not("video_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(5)
  if (projectError) {
    reasons.push(`agent video library unreadable: ${projectError.message}`)
  } else {
    for (const p of (projects ?? []) as Array<{ id: string }>) {
      const playable = await resolvePlayableVideo({ videoProjectId: p.id }, svc as any)
      if (playable.state === "ready") {
        return {
          state: "ready",
          videoUrl: playable.videoUrl,
          thumbnailUrl: playable.thumbnailUrl,
          scope: "agent_personal",
          videoProjectId: p.id,
        }
      }
      if (playable.state === "in_progress") pending = pending ?? "a personal video for this agent is still rendering"
      else reasons.push(playable.reason)
    }
  }

  if (pending) return { state: "in_progress", reason: pending }
  return {
    state: "none",
    reason: reasons.length
      ? reasons.join("; ")
      : "this agent has no finished personal video on file — record one in Video Studio (Settings → Voice & Avatar, then Video Studio → Avatar Explainer)",
  }
}
