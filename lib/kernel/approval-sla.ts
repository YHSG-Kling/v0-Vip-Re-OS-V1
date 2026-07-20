/**
 * lib/kernel/approval-sla.ts
 *
 * Pure approval-SLA evaluation, shared by the Command Center loader and the
 * content-approval source registry. A proposed action / pending item that sits
 * unactioned past the breach window escalates so a human steps in instead of it
 * silently rotting. Deadline-aware: customer-facing items (a release vs the
 * seller's appointment, a post vs its scheduled slot) also escalate as the
 * deadline nears — but escalation only ever HOLDS; nothing auto-fires.
 *
 * Lives in its own module (not command-center.ts) so the registry can import it
 * without a cycle. Defaults: due at 12h age, breached at 24h age; deadline mode
 * due at 48h-to-deadline, breached at 24h-to-deadline.
 */
export type ApprovalSlaLevel = "ok" | "due" | "breached"

export function evaluateApprovalSla(
  proposedAt: string | null,
  now: Date = new Date(),
  opts: { dueHours?: number; breachHours?: number; deadlineIso?: string | null; dueBeforeHours?: number; breachBeforeHours?: number } = {},
): { ageHours: number; level: ApprovalSlaLevel } {
  const dueHours = opts.dueHours ?? 12
  const breachHours = opts.breachHours ?? 24
  if (!proposedAt) return { ageHours: 0, level: "ok" }
  const ageMs = now.getTime() - new Date(proposedAt).getTime()
  const ageHours = Math.max(0, Math.round((ageMs / 3_600_000) * 10) / 10)
  let level: ApprovalSlaLevel = ageHours >= breachHours ? "breached" : ageHours >= dueHours ? "due" : "ok"

  if (opts.deadlineIso) {
    const hoursToDeadline = (new Date(opts.deadlineIso).getTime() - now.getTime()) / 3_600_000
    const breachBefore = opts.breachBeforeHours ?? 24
    const dueBefore = opts.dueBeforeHours ?? 48
    const dl: ApprovalSlaLevel = hoursToDeadline <= breachBefore ? "breached" : hoursToDeadline <= dueBefore ? "due" : "ok"
    const rank: Record<ApprovalSlaLevel, number> = { breached: 0, due: 1, ok: 2 }
    if (rank[dl] < rank[level]) level = dl
  }
  return { ageHours, level }
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL-QUEUE SLA TELEMETRY (round 34, owner-approved recommendation) — how
// long are approvals SITTING, per kind? A pending approval is a human gate doing
// its job; a queue kind nobody has cleared for two days is a stalled loop. This
// section folds the rows the canonical aggregator already returns into per-kind
// AGING — a READ-ONLY layer over lib/kernel/approval-queue-aggregator.ts (never
// edited, never re-queried in parallel: one source of truth for what is pending).
//
// HONEST THRESHOLDS (aggregate, distinct from the per-item evaluator above):
//   · warning at 24h — a business day without review
//   · breach  at 48h — flagged as chips in the broker Exception Center, and the
//     Cron Manager (per-manager SLO owner) raises a governed
//     cross_manager_referral INTO the owning manager's domain
//     (lib/managers/cross-referral.ts, the approval_queue_slo collaboration).
// Ages come from each row's own created_at; zero pending rows → zero telemetry
// rows (never padded). Pure compute exported directly (simulator-friendly); the
// loader imports the server-only aggregator lazily.
// ─────────────────────────────────────────────────────────────────────────────

import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import type { ApprovalSource, UnifiedApprovalItem } from "@/lib/kernel/approval-queue-aggregator"

/** A business day without review — worth a look. */
export const APPROVAL_SLA_WARN_HOURS = 24
/** Two days unreviewed — Exception Center chip turns red + bus referral raised. */
export const APPROVAL_SLA_BREACH_HOURS = 48

/** Owning manager per approval kind — QUEUE_MANAGER + table stewardship restated
 *  for the SLA rail (the aggregator itself is manager-agnostic). This is the
 *  approval_queue_slo collaboration domain's edge set. */
export const APPROVAL_KIND_MANAGER: Record<ApprovalSource, ManagerKey> = {
  newsletter:     "campaign_orchestrator", // QUEUE_MANAGER.newsletter + newsletter_campaigns steward
  email:          "campaign_orchestrator", // email_campaigns steward
  ad_creative:    "ads_manager",           // QUEUE_MANAGER.ad_creative + ad_creative_variations steward
  video_snippet:  "asset_manager",         // video_snippets steward
  blog:           "campaign_orchestrator", // QUEUE_MANAGER.blog + blog_posts steward
  podcast:        "campaign_orchestrator", // QUEUE_MANAGER.podcast + podcast_episodes steward
  video:          "asset_manager",         // ai_video_projects steward
  offer:          "shopping_agent",        // offers steward (the buyer-side offer table)
  property_alert: "shopping_agent",        // property_alerts steward
  legacy:         "data_steward",          // approval_items steward
}

export const APPROVAL_KIND_LABEL: Record<ApprovalSource, string> = {
  newsletter:     "Newsletters",
  email:          "Email campaigns",
  ad_creative:    "Ad creatives",
  video_snippet:  "Video snippets",
  blog:           "Blog drafts",
  podcast:        "Podcast episodes",
  video:          "Video renders",
  offer:          "Offers",
  property_alert: "Alert proposals",
  legacy:         "Legacy approvals",
}

export type ApprovalSlaStatus = "ok" | "warning" | "breach"

export interface ApprovalKindSla {
  kind: ApprovalSource
  label: string
  owner: ManagerKey
  ownerLabel: string
  /** Rows currently pending for this kind. */
  pending: number
  /** Age of the OLDEST pending row, in whole hours. */
  oldestHours: number
  /** Mean pending age, in whole hours. */
  avgHours: number
  /** Rows older than the warn threshold (includes breached rows). */
  aging: number
  /** Rows older than the breach threshold. */
  breached: number
  status: ApprovalSlaStatus
}

/** PURE: classify one age (hours) against the aggregate thresholds. */
export function classifyApprovalAge(hours: number): ApprovalSlaStatus {
  if (hours >= APPROVAL_SLA_BREACH_HOURS) return "breach"
  if (hours >= APPROVAL_SLA_WARN_HOURS) return "warning"
  return "ok"
}

/**
 * PURE: fold the aggregator's unified rows into per-kind aging telemetry,
 * worst-first. Kinds with nothing pending produce NO row (honest — never padded).
 */
export function computeApprovalSla(
  items: Array<Pick<UnifiedApprovalItem, "type" | "created_at">>,
  now: Date = new Date(),
): ApprovalKindSla[] {
  const nowMs = now.getTime()
  const byKind = new Map<ApprovalSource, number[]>()
  for (const item of items) {
    const created = new Date(item.created_at).getTime()
    if (!Number.isFinite(created)) continue
    const hours = Math.max(0, (nowMs - created) / 3_600_000)
    const arr = byKind.get(item.type) ?? []
    arr.push(hours)
    byKind.set(item.type, arr)
  }
  const rows: ApprovalKindSla[] = []
  for (const [kind, ages] of byKind.entries()) {
    if (ages.length === 0) continue
    const oldest = Math.max(...ages)
    const owner = APPROVAL_KIND_MANAGER[kind] ?? "data_steward"
    rows.push({
      kind,
      label: APPROVAL_KIND_LABEL[kind] ?? kind,
      owner,
      ownerLabel: MANAGERS[owner]?.label ?? owner,
      pending: ages.length,
      oldestHours: Math.floor(oldest),
      avgHours: Math.floor(ages.reduce((s, a) => s + a, 0) / ages.length),
      aging: ages.filter((a) => a >= APPROVAL_SLA_WARN_HOURS).length,
      breached: ages.filter((a) => a >= APPROVAL_SLA_BREACH_HOURS).length,
      status: classifyApprovalAge(oldest),
    })
  }
  // Worst first: breach > warning > ok, then oldest age descending.
  const rank: Record<ApprovalSlaStatus, number> = { breach: 0, warning: 1, ok: 2 }
  return rows.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.oldestHours - a.oldestHours))
}

/** PURE: just the kinds in breach (the referral sweep's input). */
export function slaBreaches(rows: ApprovalKindSla[]): ApprovalKindSla[] {
  return rows.filter((r) => r.status === "breach")
}

/**
 * Load the live telemetry for one brokerage — the aggregator's rows (the ONE
 * pending-approvals source), folded by the pure computer. agentScopeId narrows to
 * an agent's own queue exactly as the /approvals page does; null = brokerage-wide.
 * The aggregator is imported lazily (it is server-only; the pure layer is not).
 */
export async function loadApprovalSla(
  brokerageId: string,
  agentScopeId: string | null = null,
  now: Date = new Date(),
): Promise<ApprovalKindSla[]> {
  const { aggregatePendingApprovals } = await import("@/lib/kernel/approval-queue-aggregator")
  const items = await aggregatePendingApprovals(brokerageId, agentScopeId)
  return computeApprovalSla(items, now)
}
