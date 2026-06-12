// lib/kernel/content-studio.ts
//
// THE CONTENT STUDIO — the Asset Manager's command surface that makes the AI
// creative team VISIBLE and approvable. The Video Director (lib/video/video-director.ts)
// STAGES every reel as a compliance-gated ai_video_projects row
// (status='remotion_pending', approval_status='pending_review') stamping the WHOLE
// creative decision into video_metadata: the chosen composition, target channels +
// aspect, the music mood, the format_source + the learned WHY, the hook A/B
// (experiment_id + variant_index + hook_angle), the outro QR (qr_code_id), and the
// sourced B-roll (broll_sourced_count). Without one place to SEE that, the agent
// approves video blind. This aggregator pulls the brokerage's Director-staged reels
// — pending review + recently approved — into one typed, grouped shape, each reel
// carrying its format/mood/hook/caption/why badges + the QR/B-roll flags, so the
// agent sees "here's what the creative team made, and WHY — approve it."
//
// Read-only aggregation. approveContentItem flips approval through the REAL existing
// approval path (app/actions/marketing-ai-approvals.ts approveMarketingAssetAction's
// flip: ai_video_projects.approval_status pending_review → approved, brokerage-scoped,
// service client) — it does NOT invent a new approval flow. NOT server-only (the
// simulator drives it end-to-end); never import from a client component. Zero mocks.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** The grouping bucket a reel lands in on the studio surface. */
export type ContentStudioGroup = "pending_review" | "approved"

/** The caption readiness of a reel — derived purely from the gated script + compliance.
 *  A reel with a gated hook/script can be captioned (sound-off burn-in via
 *  buildCaptionPlan); one without a script can't yet. */
export type CaptionState = "captioned" | "script_only" | "none"

/** One hook A/B variant surfaced under a reel (only present for experiment reels). */
export interface HookVariantView {
  videoProjectId: string
  variantIndex: number
  hookAngle: string
  hook: string
  /** True when format-learning has crowned this variant as the experiment winner. */
  isWinner: boolean
}

/** One Director-staged reel, shaped for the studio card. */
export interface ContentStudioItem {
  id: string
  group: ContentStudioGroup
  title: string
  /** The chosen Remotion composition id (video_metadata.composition_id). */
  composition: string | null
  /** The ai_video_projects.video_type (the situation taxonomy). */
  videoType: string | null
  /** Canvas aspect the cut targets (square/vertical/horizontal). */
  aspect: string | null
  /** The channels this format is sized + cut for. */
  targetChannels: string[]
  /** The background-music mood the Director assigned. */
  musicMood: string | null
  /** "default" expert rule kept, or a gated "learned" per-brokerage win. */
  formatSource: string | null
  /** The human-readable WHY behind the format choice (rides video_metadata.format_why). */
  formatWhy: string | null
  /** The hook A/B experiment id, when this reel is part of one. */
  experimentId: string | null
  /** This reel's own variant index within its experiment (if any). */
  variantIndex: number | null
  /** This reel's hook angle (curiosity/social_proof/urgency/value), if part of an A/B. */
  hookAngle: string | null
  /** "default" angle order, or a "learned" preferred angle. */
  hookSource: string | null
  /** The WHY behind the hook choice (rides video_metadata.hook_why). */
  hookWhy: string | null
  /** Caption readiness derived from the gated script + compliance. */
  captionState: CaptionState
  /** The compliance gate state stamped at staging. */
  complianceStatus: string | null
  /** QR ✓ — the outro carries a tracked QR (video_metadata.qr_code_id present). */
  hasQr: boolean
  /** B-roll ✓ — the Director sourced real lifestyle clips for this cut. */
  hasBroll: boolean
  /** How many B-roll clips the Director sourced from the scope cascade. */
  brollCount: number
  createdAt: string
}

export interface ContentStudioData {
  items: ContentStudioItem[]
  groups: Record<ContentStudioGroup, ContentStudioItem[]>
  /** Per-composition pending counts (the formats the team is making most). */
  byComposition: Record<string, number>
  /** The hook A/B experiments in play → their crowned-winner state. */
  experiments: Array<{
    experimentId: string
    variants: HookVariantView[]
    winnerVariantIndex: number | null
    winnerAngle: string | null
    /** The honest WHY from recommendHookWinner ("still testing" or a crowned win). */
    why: string
  }>
  pendingCount: number
  approvedCount: number
  total: number
}

// ── PURE shaping helpers (Layer-1 testable; no I/O) ──────────────────────────

/** PURE: derive a reel's caption readiness from its gated script + compliance state.
 *  A reel needs a script to be captioned; a script that cleared the gate is fully
 *  caption-ready; a script that hasn't cleared is script-only; no script → none. */
export function captionStateOf(
  scriptContent: string | null | undefined,
  complianceStatus: string | null | undefined,
): CaptionState {
  const hasScript = !!(scriptContent && scriptContent.trim())
  if (!hasScript) return "none"
  return complianceStatus === "passed" ? "captioned" : "script_only"
}

/** PURE: does this reel's video_metadata carry a tracked outro QR? */
export function hasQrOf(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false
  const id = meta.qr_code_id
  return typeof id === "string" && id.length > 0
}

/** PURE: how many B-roll clips did the Director source for this reel? Reads the
 *  Director's stamp (broll_sourced_count) with a fallback to the clip array length. */
export function brollCountOf(meta: Record<string, unknown> | null | undefined): number {
  if (!meta) return 0
  const n = meta.broll_sourced_count
  if (typeof n === "number" && n >= 0) return Math.floor(n)
  const clips = meta.broll_clips
  return Array.isArray(clips) ? clips.length : 0
}

/** PURE: map one raw ai_video_projects row → the studio item shape. */
export function shapeStudioItem(
  row: Record<string, unknown>,
  group: ContentStudioGroup,
): ContentStudioItem {
  const meta = (row.video_metadata as Record<string, unknown> | null) ?? null
  const m = meta ?? {}
  const channels = m.target_channels
  const brollCount = brollCountOf(meta)
  return {
    id: row.id as string,
    group,
    title: (row.title as string | null) ?? "(untitled reel)",
    composition: (m.composition_id as string | null) ?? null,
    videoType: (row.video_type as string | null) ?? null,
    aspect: (m.aspect as string | null) ?? null,
    targetChannels: Array.isArray(channels) ? (channels as string[]) : [],
    musicMood: (m.music_mood as string | null) ?? null,
    formatSource: (m.format_source as string | null) ?? null,
    formatWhy: (m.format_why as string | null) ?? null,
    experimentId: (m.experiment_id as string | null) ?? null,
    variantIndex: typeof m.variant_index === "number" ? (m.variant_index as number) : null,
    hookAngle: (m.hook_angle as string | null) ?? null,
    hookSource: (m.hook_source as string | null) ?? null,
    hookWhy: (m.hook_why as string | null) ?? null,
    captionState: captionStateOf(row.script_content as string | null, row.compliance_status as string | null),
    complianceStatus: (row.compliance_status as string | null) ?? null,
    hasQr: hasQrOf(meta),
    hasBroll: brollCount > 0,
    brollCount,
    createdAt: (row.created_at as string | null) ?? "",
  }
}

/** PURE: fold shaped items into the grouped studio data (groups, counts, by-composition).
 *  Experiments are layered on by the loader (they need format-learning's crowning). */
export function groupStudioItems(items: ContentStudioItem[]): Omit<ContentStudioData, "experiments"> {
  const groups: Record<ContentStudioGroup, ContentStudioItem[]> = { pending_review: [], approved: [] }
  const byComposition: Record<string, number> = {}
  for (const it of items) {
    groups[it.group].push(it)
    if (it.group === "pending_review" && it.composition) {
      byComposition[it.composition] = (byComposition[it.composition] ?? 0) + 1
    }
  }
  const sortDesc = (a: ContentStudioItem, b: ContentStudioItem) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
  groups.pending_review.sort(sortDesc)
  groups.approved.sort(sortDesc)
  const sorted = [...items].sort(sortDesc)
  return {
    items: sorted,
    groups,
    byComposition,
    pendingCount: groups.pending_review.length,
    approvedCount: groups.approved.length,
    total: items.length,
  }
}

// ── LIVE aggregation (read-only, tenant-scoped) ──────────────────────────────

/**
 * loadContentStudio — aggregate the brokerage's Director-staged reels into the
 * studio shape: pending_review (awaiting the agent's approve) + recently approved
 * (the proof the team's work is shipping). Each reel carries its full creative
 * decision (composition/aspect/channels/mood/format-why/hook/caption/QR/B-roll).
 *
 * Director-staged reels are identified by video_metadata.requested_via='asset_manager'
 * (the stamp commissionVideo + commissionVideoExperiment write) so the studio shows
 * the CREATIVE TEAM's reels, not arbitrary uploads. Hook A/B experiments are rolled
 * up with their crowned-winner state via format-learning's recommendHookWinner (the
 * SAME honest gate the Director uses) so the agent sees which opener is winning.
 */
export async function loadContentStudio(brokerageId: string, client?: Svc): Promise<ContentStudioData> {
  if (!brokerageId) {
    return {
      items: [], groups: { pending_review: [], approved: [] }, byComposition: {},
      experiments: [], pendingCount: 0, approvedCount: 0, total: 0,
    }
  }
  const supabase = client ?? createServiceClient()

  const SELECT = "id, title, video_type, script_content, compliance_status, approval_status, video_metadata, created_at"
  const [pendingRes, approvedRes] = await Promise.all([
    supabase.from("ai_video_projects")
      .select(SELECT)
      .eq("brokerage_id", brokerageId)
      .eq("approval_status", "pending_review")
      .eq("video_metadata->>requested_via", "asset_manager")
      .order("created_at", { ascending: false })
      .limit(200),
    // Recently approved — the proof the creative team's work is shipping.
    supabase.from("ai_video_projects")
      .select(SELECT)
      .eq("brokerage_id", brokerageId)
      .eq("approval_status", "approved")
      .eq("video_metadata->>requested_via", "asset_manager")
      .order("created_at", { ascending: false })
      .limit(50),
  ])

  const items: ContentStudioItem[] = []
  for (const r of (pendingRes.data ?? []) as Array<Record<string, unknown>>) items.push(shapeStudioItem(r, "pending_review"))
  for (const r of (approvedRes.data ?? []) as Array<Record<string, unknown>>) items.push(shapeStudioItem(r, "approved"))

  const grouped = groupStudioItems(items)

  // Roll up the hook A/B experiments in play with their crowned-winner state. We
  // ask format-learning's recommendHookWinner (the SAME honest sample+margin gate
  // the Director uses) which variant — if any — has won the first-3-seconds A/B.
  const experimentIds = Array.from(new Set(items.map((i) => i.experimentId).filter((x): x is string => !!x)))
  const experiments: ContentStudioData["experiments"] = []
  if (experimentIds.length > 0) {
    const { loadHookExperiment, recommendHookWinner } = await import("@/lib/video/format-learning")
    for (const experimentId of experimentIds) {
      let winnerVariantIndex: number | null = null
      let winnerAngle: string | null = null
      let why = "Still testing — not enough audience action to crown a hook winner yet."
      try {
        const scored = await loadHookExperiment(brokerageId, experimentId, supabase)
        const rec = recommendHookWinner(experimentId, scored)
        winnerVariantIndex = rec.winnerVariantIndex
        winnerAngle = rec.winnerAngle
        why = rec.why
      } catch (e) {
        // Crowning is an enhancement, never a gate — the variants still surface untagged.
        console.warn("[content-studio] hook winner read failed:", (e as Error).message)
      }
      const variants: HookVariantView[] = items
        .filter((i) => i.experimentId === experimentId)
        .map((i) => ({
          videoProjectId: i.id,
          variantIndex: i.variantIndex ?? 0,
          hookAngle: i.hookAngle ?? "curiosity",
          hook: i.title,
          isWinner: winnerVariantIndex !== null && i.variantIndex === winnerVariantIndex,
        }))
        .sort((a, b) => a.variantIndex - b.variantIndex)
      experiments.push({ experimentId, variants, winnerVariantIndex, winnerAngle, why })
    }
  }

  return { ...grouped, experiments }
}

export interface ApproveContentResult {
  ok: boolean
  note?: string
}

/**
 * approveContentItem — flip ONE Director-staged reel from pending_review → approved
 * through the REAL existing approval path. This is the exact same flip
 * approveMarketingAssetAction("video", id) performs in
 * app/actions/marketing-ai-approvals.ts: a brokerage-scoped service-client update of
 * ai_video_projects.approval_status, fenced on the current 'pending_review' state so a
 * double-approve is a no-op. We do NOT invent a new approval flow — once approved, the
 * existing render crons + video-coordination distribution gate carry the reel onward.
 *
 * Gated: the caller (the server action) auth/role-gates before this runs; here we
 * still fence on brokerage_id so a row from another tenant can never be flipped.
 */
export async function approveContentItem(
  brokerageId: string,
  videoProjectId: string,
  approverUserId: string,
  client?: Svc,
): Promise<ApproveContentResult> {
  if (!brokerageId || !videoProjectId) return { ok: false, note: "brokerageId + videoProjectId required" }
  const supabase = client ?? createServiceClient()

  // Mirror approveMarketingAssetAction: confirm the row belongs to this brokerage.
  const { data: row } = await supabase
    .from("ai_video_projects")
    .select("brokerage_id, approval_status")
    .eq("id", videoProjectId)
    .maybeSingle()
  if (!row) return { ok: false, note: "Reel not found." }
  if ((row as { brokerage_id: string }).brokerage_id !== brokerageId) return { ok: false, note: "Not authorized for this reel." }
  if ((row as { approval_status: string }).approval_status === "approved") {
    // Idempotent: already approved is a success no-op (mirrors the gate's intent).
    return { ok: true, note: "Already approved." }
  }

  // The REAL flip — exactly approveMarketingAssetAction's update, fenced on the
  // pending_review state + brokerage so it's brokerage-scoped and double-safe.
  const { data: updated } = await supabase
    .from("ai_video_projects")
    .update({ approval_status: "approved", approved_by: approverUserId, approved_at: new Date().toISOString() })
    .eq("id", videoProjectId)
    .eq("brokerage_id", brokerageId)
    .eq("approval_status", "pending_review")
    .select("id")
    .maybeSingle()

  return { ok: !!updated, note: updated ? undefined : "Couldn't approve — it may have changed state." }
}
