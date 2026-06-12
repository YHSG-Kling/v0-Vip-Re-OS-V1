// lib/kernel/video-coordination.ts
//
// VIDEO COORDINATION — turning a finished render into a coordinated TEAM deliverable
// on the inter-manager signal bus. Until now seven video pipelines each finished in
// isolation: a render completed, the agent got a "video ready" notification, and that
// was it. No manager picked it up; distribution + promotion were left to polling crons.
//
// This is the FAST coordinated path. When the Asset Manager (media & brand library)
// finishes a render it announces it on the bus:
//
//   render completed  → asset_manager → campaign_orchestrator:video_ready   (ALWAYS)
//                     → asset_manager → ads_manager:video_ready             (promotable kinds only)
//   render failed     → asset_manager → campaign_orchestrator:video_compliance_failed
//
// The addressed managers consume by proposing GOVERNED, GATED deliverables (a social
// distribution draft pending approval; a paid-promotion action proposed into the ads
// queue; an escalation so a failure is never invisible). Nothing auto-publishes, nothing
// auto-spends. Every signal is deduped per ai_video_project so re-polling the same
// finished render never re-signals — the publish is idempotent and coexists with the
// existing polling crons (listing-promo-social-publish etc.) as a safety net: whichever
// acts first wins, the other no-ops.
//
// NOT server-only (like manager-signals.ts / command-center.ts) so the simulator drives
// it end-to-end. Only ever writes through a caller-supplied/service client.

import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

type Svc = ReturnType<typeof createServiceClient>

/**
 * The lifecycle "kind" of a finished render lives on ai_video_projects.video_metadata
 * .promo_event_type (set by the listing-promo pipeline) — video_type is the canonical
 * vendor/category column ("listing_promo", "market_update", …) and is NOT the lifecycle
 * kind. The promo_event_type is the buyer-facing lifecycle moment the reel was cut for.
 */
export type VideoKind = string | null

/** The lifecycle kinds worth paid promotion — high-intent, time-sensitive moments. */
export const PROMOTABLE_VIDEO_KINDS = ["just_listed", "just_sold", "open_house"] as const

/** Pure: is this lifecycle kind worth proposing PAID promotion (Ads Manager)? */
export function isPromotableVideoKind(kind: VideoKind): boolean {
  if (!kind) return false
  // open_house covers the announce + reminder variants of the same lifecycle moment.
  const normalized = kind === "open_house_announce" || kind === "open_house_reminder" ? "open_house" : kind
  return (PROMOTABLE_VIDEO_KINDS as readonly string[]).includes(normalized)
}

/** A target manager a video_ready signal routes to. */
export type VideoTargetManager = "campaign_orchestrator" | "ads_manager"

/**
 * Pure routing: which managers should a FINISHED render of this kind reach?
 * Campaign Orchestrator ALWAYS (every video deserves coordinated distribution);
 * Ads Manager only for promotable kinds (paid spend is reserved for high-intent moments).
 */
export function videoReadyTargets(kind: VideoKind): VideoTargetManager[] {
  const targets: VideoTargetManager[] = ["campaign_orchestrator"]
  if (isPromotableVideoKind(kind)) targets.push("ads_manager")
  return targets
}

/**
 * Resolve a project's lifecycle kind from its row. Prefers video_metadata.promo_event_type
 * (the lifecycle moment); falls back to video_type only when the lifecycle kind is absent.
 */
export function resolveVideoKind(row: {
  video_metadata?: Record<string, unknown> | null
  video_type?: string | null
}): VideoKind {
  const metaKind = (row.video_metadata as { promo_event_type?: string } | null | undefined)?.promo_event_type
  return metaKind ?? row.video_type ?? null
}

interface ProjectRow {
  id: string
  brokerage_id: string | null
  agent_id: string | null
  listing_id: string | null
  marketing_campaign_id: string | null
  status: string | null
  video_url: string | null
  video_type: string | null
  video_metadata: Record<string, unknown> | null
  title: string | null
  error_message: string | null
}

export interface PublishVideoCoordinationResult {
  ok: boolean
  reason?: string
  /** Signals published (or already-open/deduped) addressed to each manager. */
  published: VideoTargetManager[]
  /** True when a compliance-failed escalation signal was published. */
  escalated: boolean
}

/**
 * THE PUBLISHER — fires when a render reaches a terminal state. Idempotent per
 * ai_video_project (deduped on the bus per (to_manager, signal_type, entity_id)) so
 * re-polling a completed/failed project never re-signals.
 *
 *  - status='completed' (+ video_url) → campaign_orchestrator:video_ready (always)
 *                                       + ads_manager:video_ready (promotable kinds only)
 *  - status='failed'                  → campaign_orchestrator:video_compliance_failed
 *
 * Always tenant-scoped by brokerage_id. Never throws — a coordination failure must never
 * break the completion path (notifications, kernel events, storage) that calls it.
 */
export async function publishVideoCoordinationSignals(
  projectId: string,
  client?: Svc,
): Promise<PublishVideoCoordinationResult> {
  const supabase = client ?? createServiceClient()
  const published: VideoTargetManager[] = []

  try {
    const { data, error } = await supabase
      .from("ai_video_projects")
      .select("id, brokerage_id, agent_id, listing_id, marketing_campaign_id, status, video_url, video_type, video_metadata, title, error_message")
      .eq("id", projectId)
      .maybeSingle()
    if (error) return { ok: false, reason: error.message, published, escalated: false }
    const project = data as ProjectRow | null
    if (!project) return { ok: false, reason: "project not found", published, escalated: false }
    if (!project.brokerage_id) return { ok: false, reason: "project missing brokerage_id", published, escalated: false }

    const brokerageId = project.brokerage_id
    const kind = resolveVideoKind(project)
    const kindLabel = kind ?? "video"
    const titleLine = project.title ?? "a finished video"

    // ── Terminal: FAILED → compliance escalation (never invisible) ──
    if (project.status === "failed") {
      const res = await publishManagerSignal({
        brokerageId,
        fromManager: "asset_manager",
        toManager: "campaign_orchestrator",
        signalType: "video_compliance_failed",
        message: `Video render failed: "${titleLine}"${project.error_message ? ` — ${String(project.error_message).slice(0, 240)}` : ""}`,
        entityType: "video_project",
        entityId: project.id,
        payload: {
          video_type: project.video_type ?? null,
          kind,
          listing_id: project.listing_id,
          agent_id: project.agent_id,
          error_message: project.error_message ?? null,
        },
      }, supabase)
      return { ok: res.ok, reason: res.reason, published, escalated: res.ok }
    }

    // ── Terminal: COMPLETED → coordinated distribution + (promotable) paid promotion ──
    if (project.status !== "completed" || !project.video_url) {
      return { ok: false, reason: `not a terminal completed render (status=${project.status ?? "null"})`, published, escalated: false }
    }

    const targets = videoReadyTargets(kind)
    const basePayload = {
      video_type: project.video_type ?? null,
      kind,
      video_url: project.video_url,
      title: titleLine,
      listing_id: project.listing_id,
      agent_id: project.agent_id,
      marketing_campaign_id: project.marketing_campaign_id,
    }

    for (const toManager of targets) {
      const message =
        toManager === "campaign_orchestrator"
          ? `Finished ${kindLabel} render ready to distribute: "${titleLine}" — propose the coordinated multi-channel rollout.`
          : `Finished ${kindLabel} render is a promotable moment: "${titleLine}" — propose paid promotion before it goes stale.`
      const res = await publishManagerSignal({
        brokerageId,
        fromManager: "asset_manager",
        toManager,
        signalType: "video_ready",
        message,
        entityType: "video_project",
        entityId: project.id,
        payload: basePayload,
      }, supabase)
      if (res.ok) published.push(toManager)
    }

    return { ok: published.length > 0, published, escalated: false }
  } catch (e) {
    console.error(`[video-coordination] publish failed for project ${projectId}:`, e)
    return { ok: false, reason: (e as Error).message, published, escalated: false }
  }
}
