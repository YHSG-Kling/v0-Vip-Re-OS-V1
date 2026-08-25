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
 *
 * ── THIS MODULE OWNS BOTH ENDS OF THE `target_composition_id` CONTRACT ───────
 *
 * The key was READ here and WRITTEN in three unrelated places, each spelling the
 * request by hand. That is how the welcome/intro video came to be the one avatar
 * lane that never asked for its assembly: `lib/video/intro-video-reactor.ts`
 * wrote `provider_metadata` with the provider, the mode and the talk id and no
 * target, so `enqueueAvatarCompositionForProject` skipped it forever and the
 * deliverable stayed a bare D-ID talking head — no Remotion assembly, no brand
 * chrome. So the REQUEST side lives here too now, beside the read that consumes
 * it (§6, one vocabulary per function):
 *
 *   buildIntroCompositionRequest  — the request an avatar-led PERSONAL video
 *                                   stamps onto provider_metadata.
 *   declaresAvatarComposition     — "is a composite owed on this project?"
 *   resolveAvatarCompositeState   — has the assembly landed, is it still coming,
 *                                   or will it never arrive? (over the render row)
 *
 * WHY THE LAST TWO EXIST. The D-ID cut and the assembled cut land on the SAME
 * column: poll-did-videos writes `ai_video_projects.video_url` when the avatar
 * track finishes, and render-composition OVERWRITES it with the composite
 * minutes later. Every reader that waits on "video_url is populated" therefore
 * has a window in which it ships the un-assembled avatar track — which for the
 * welcome email is precisely the video the owner did not ask for. poll-did-videos
 * already deferred its own fan-out on this condition, inline; that inline test is
 * now this function, and the email backfill and lib/video/playable-video share it.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { missingContentProps } from "@/lib/remotion/content-contract"

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

/**
 * WHICH CUT BECOMES THE AVATAR TRACK — prefer the CLEAN (un-branded) D-ID
 * render. Load-bearing, and one line, so it is named rather than buried.
 *
 * poll-did-videos burns the brokerage attribution band into the D-ID output and
 * writes THAT to `ai_video_projects.video_url`, keeping the un-branded Supabase
 * copy at `provider_metadata.clean_video_url`. Remotion then applies the tenant's
 * chrome again — brand cover, caption strip, CTA + EHO outro. Feeding it the
 * branded cut would stack two attribution treatments on one video, which is the
 * defect this preference exists to prevent. The branded cut is the fallback only
 * when no clean copy was persisted, where a double band beats no video.
 *
 * PURE.
 */
function pickAvatarTrackUrl(
  providerMetadata: unknown,
  projectVideoUrl: string | null | undefined,
): string | null {
  const meta = (providerMetadata ?? {}) as Record<string, unknown>
  const clean = meta.clean_video_url
  if (typeof clean === "string" && clean.trim().length > 0) return clean
  return projectVideoUrl ?? null
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

  const avatarVideoUrl = pickAvatarTrackUrl(meta, project.video_url)
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

// ═══════════════════════════════════════════════════════════════════════════
// THE REQUEST SIDE — what a producer stamps onto provider_metadata so the
// handoff above will fire.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The composition an avatar-led PERSONAL video is assembled through.
 *
 * CHOSEN ON EVIDENCE, not invented. lib/video/finish-spec.ts classifies
 * `AgentTalkingHeadReel` as AVATAR_LED and says why in the file: "The talking
 * head is for PERSONAL messages (the agent speaking TO one person); explainers
 * + narrated slide decks use the CIRCLE avatar so the material stays the star."
 * A welcome video from the assigned agent to one newly-converted contact is
 * exactly that case. The composition is registered and active for every tier in
 * `remotion_compositions`, its Remotion entry has existed since Wave 39
 * (remotion/Root.tsx), and it already frames a D-ID avatar track in brokerage
 * chrome: brand cover → avatar video with a caption strip → CTA + EHO outro.
 * Nothing new was built for this; the intro lane simply never asked for it.
 *
 * Same constant shape as lib/agents/seller-update-reel-producer.ts
 * `SELLER_UPDATE_COMPOSITION` — one name per lane, one composition behind it.
 */
export const INTRO_VIDEO_COMPOSITION = "AgentTalkingHeadReel"

/**
 * The eyebrow and the call to action are FIXED TEMPLATE CHROME, not authored
 * copy. They say nothing about the recipient, so there is nothing for a fair
 * housing scan to find in them and nothing for a model to get wrong — which is
 * the point: §5 requires the spoken script to be compliance-first, and the way
 * to keep that true through the assembly step is for the assembly step to add no
 * new claims at all.
 */
const INTRO_HOOK = "MEET YOUR AGENT"
const INTRO_CTA  = "Reply to set up a time"

/**
 * The on-screen caption strip, cut VERBATIM from the script that already passed
 * `evaluateOutbound` (and, on a violation, the one redraft).
 *
 * NOT A SECOND DRAFT. The composition puts this sentence on screen while the
 * avatar speaks, so it is read by muted viewers as the message itself. Authoring
 * it separately would be a line of client-facing copy that no compliance gate
 * ever saw — the exact hole §5 exists to close. Taking the first sentence of the
 * gated script means the caption cannot say anything the script did not.
 *
 * PURE. The 12-word cap is the composition's own readability limit
 * (remotion/AgentTalkingHeadReel.tsx: "Capped to ~12 words for readability at
 * 1080px").
 */
function captionFromScript(script: string, maxWords = 12): string {
  const flat = (script ?? "").replace(/\s+/g, " ").trim()
  if (!flat) return ""
  const firstSentence = (flat.match(/^[^.!?]+[.!?]?/)?.[0] ?? flat).trim()
  const words = firstSentence.split(" ").filter(Boolean)
  const kept = words.slice(0, maxWords).join(" ").replace(/[\s.,;:—-]+$/, "")
  return words.length > maxWords ? `${kept}…` : kept
}

/** What a producer merges into `ai_video_projects.provider_metadata`. */
export interface IntroCompositionRequest {
  target_composition_id: string
  input_props: Record<string, unknown>
  /** Threads the composite back onto the PROJECT row — see below. */
  entity_type: "video_project"
  entity_id: string
}

export interface IntroCompositionParams {
  /** ai_video_projects.id. */
  projectId: string
  /** The COMPLIANCE-CLEAN script. The caption is cut from it, never redrafted. */
  script: string
  /** The agent's display name (resolveDirectorIdentity). Blank ⇒ no request. */
  agentName: string
  /** Cover/outro chip. Cosmetic — absence never blocks the request. */
  agentPhotoUrl?: string | null
  /** brandBlock() over the tenant's live brand rows. */
  brand?: Record<string, unknown> | null
}

/**
 * The composition request for a personal avatar video, or NULL when this render
 * would be refused anyway.
 *
 * WHY IT CAN RETURN NULL. render-composition runs `missingContentProps` as a
 * hard backstop and CANCELS any render whose required content props are absent,
 * because Remotion merges input props over each composition's Studio defaults —
 * an unstaged prop does not render blank, it renders the sample data as if it
 * were this client's. `AgentTalkingHeadReel` requires hook + agentName + caption.
 * So the producer asks the SAME question the renderer will ask, using the same
 * function, and simply does not request an assembly that cannot be honoured. The
 * D-ID cut then stands as the deliverable, which is honest; a request that is
 * guaranteed to be cancelled would instead park the welcome email behind a
 * composite that was never coming.
 *
 * `entity_type` / `entity_id` are not decoration. buildAvatarRenderRow copies
 * them onto the render row, and render-composition's runPostRenderCoordination
 * fires ONLY for `entity_type='video_project'` — that is the line that stamps the
 * finished composite onto `ai_video_projects.video_url`. Without it the assembled
 * video would land in `remotion_composition_renders.output_url` and nowhere the
 * welcome email or the portal card reads: a writer with no reader.
 *
 * PURE.
 */
export function buildIntroCompositionRequest(
  p: IntroCompositionParams,
): IntroCompositionRequest | null {
  if (!p.projectId) return null
  const input_props: Record<string, unknown> = {
    hook:      INTRO_HOOK,
    agentName: (p.agentName ?? "").trim(),
    caption:   captionFromScript(p.script ?? ""),
    ctaLabel:  INTRO_CTA,
    // avatarVideoUrl is deliberately ABSENT: enqueueAvatarCompositionForProject
    // merges it in on completion, preferring meta.clean_video_url so Remotion's
    // brand chrome is not stacked on top of the D-ID attribution band.
    agentPhotoUrl: p.agentPhotoUrl ?? null,
    ...(p.brand ? { brand: p.brand } : {}),
  }
  if (missingContentProps(INTRO_VIDEO_COMPOSITION, input_props).length > 0) return null
  return {
    target_composition_id: INTRO_VIDEO_COMPOSITION,
    input_props,
    entity_type: "video_project",
    entity_id:   p.projectId,
  }
}

/** The prop names `buildIntroCompositionRequest` could not supply — for the log
 *  line that explains a skipped assembly instead of leaving it silent. */
export function describeIntroCompositionGap(p: IntroCompositionParams): string[] {
  return missingContentProps(INTRO_VIDEO_COMPOSITION, {
    hook:      INTRO_HOOK,
    agentName: (p.agentName ?? "").trim(),
    caption:   captionFromScript(p.script ?? ""),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// IS A COMPOSITE OWED, AND HAS IT LANDED?
// ═══════════════════════════════════════════════════════════════════════════

/** Does this project owe an assembled cut? PURE. */
export function declaresAvatarComposition(providerMetadata: unknown): boolean {
  const meta = (providerMetadata ?? {}) as Record<string, unknown>
  const id = meta.target_composition_id
  return typeof id === "string" && id.trim().length > 0
}

/**
 * How long a reader waits for the assembly before shipping the avatar track.
 *
 * NOT A STYLE CHOICE. Waiting forever is the failure mode that matters here: if
 * the composition render is cancelled by the content contract, fails in ffmpeg,
 * or was never enqueued because the insert was refused, then "wait for the
 * composite" means the welcome email is never sent at all — worse than sending
 * the un-assembled cut. Every non-terminal state is therefore bounded, and the
 * bound is the same 2 hours the video pipeline's reaper already uses for a
 * render nobody picked up.
 */
export const COMPOSITE_WAIT_MS = 2 * 60 * 60 * 1000

export type AvatarCompositeState =
  /** No assembly was ever requested — the D-ID cut IS the deliverable. */
  | { state: "not_requested" }
  /** Still coming. A reader must NOT ship the avatar track yet. */
  | { state: "pending"; reason: string }
  /** The assembled cut exists. */
  | { state: "landed"; outputUrl: string | null }
  /** It will not arrive. Ship what exists, and say why. */
  | { state: "abandoned"; reason: string }

/** One `remotion_composition_renders` row, as much of it as the question needs. */
export interface CompositeRenderProbe {
  render_status: string | null
  output_url:    string | null
}

/**
 * PURE classifier — the whole decision, with no I/O, so both sides of it can be
 * proved without a database.
 *
 * `ageMs` is how long the avatar track has been sitting on the project
 * (`completed_at` → now). Null means "not established", which is treated as
 * fresh: a project whose D-ID job has not completed yet cannot have missed a
 * deadline.
 */
function classifyAvatarComposite(args: {
  declared: boolean
  render:   CompositeRenderProbe | null
  ageMs:    number | null
  waitMs?:  number
}): AvatarCompositeState {
  if (!args.declared) return { state: "not_requested" }
  const waitMs = args.waitMs ?? COMPOSITE_WAIT_MS
  const status = args.render?.render_status ?? null

  if (status === "succeeded") {
    return args.render?.output_url
      ? { state: "landed", outputUrl: args.render.output_url }
      : { state: "abandoned", reason: "the composition render succeeded with no output URL" }
  }
  if (status === "failed" || status === "cancelled") {
    return { state: "abandoned", reason: `the composition render is '${status}' — no assembled cut will arrive` }
  }

  const overdue = args.ageMs !== null && args.ageMs > waitMs
  if (overdue) {
    return {
      state:  "abandoned",
      reason: status
        ? `the composition render has been '${status}' for over ${Math.round(waitMs / 60000)} minutes`
        : `no composition render was ever enqueued within ${Math.round(waitMs / 60000)} minutes of the avatar track landing`,
    }
  }
  return {
    state:  "pending",
    reason: status
      ? `the Remotion assembly is '${status}'`
      : "the Remotion assembly has not been enqueued yet",
  }
}

/**
 * The same question against the live render row.
 *
 * supabase-js RESOLVES a refused read, so the read is destructured and a refusal
 * is carried into the classifier as "no render row" rather than swallowed. That
 * FAILS CLOSED in the direction that matters — a reader waits instead of
 * shipping the un-assembled cut — and it still self-heals, because the age bound
 * turns a permanently unreadable render into 'abandoned' rather than a stall.
 *
 * Costs nothing on a project that never asked for an assembly: the declaration
 * is checked before any query runs.
 */
export async function resolveAvatarCompositeState(
  project: { id: string; provider_metadata?: unknown; completed_at?: string | null },
  client?: ReturnType<typeof createServiceClient>,
  nowMs: number = Date.now(),
): Promise<AvatarCompositeState> {
  if (!declaresAvatarComposition(project.provider_metadata)) return { state: "not_requested" }

  const supabase = client ?? createServiceClient()
  const { data, error } = await supabase
    .from("remotion_composition_renders")
    .select("id, render_status, output_url, created_at")
    .eq("entity_type", "video_project")
    .eq("entity_id", project.id)
    .order("created_at", { ascending: false })
    .limit(5)

  const rows = (error ? [] : ((data ?? []) as CompositeRenderProbe[]))
  // A retry can leave more than one row. A SUCCEEDED one wins over a newer
  // queued one — the assembled cut exists either way.
  const render = rows.find((r) => r.render_status === "succeeded" && !!r.output_url) ?? rows[0] ?? null

  const completedMs = project.completed_at ? Date.parse(project.completed_at) : NaN
  const ageMs = Number.isFinite(completedMs) ? nowMs - completedMs : null

  const verdict = classifyAvatarComposite({ declared: true, render, ageMs })
  if (error && verdict.state === "pending") {
    return { state: "pending", reason: `${verdict.reason} (render row unreadable: ${error.message})` }
  }
  return verdict
}
