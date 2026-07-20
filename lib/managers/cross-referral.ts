/**
 * lib/managers/cross-referral.ts
 *
 * CROSS-MANAGER REFERRALS (round 34 — "managers should be working together and can
 * cross manage"). The raise side of the first-class governed referral:
 *
 *   raiseCrossManagerReferral() — a manager's sweep found something in a PEER's domain
 *     and raises it INTO that domain over the EXISTING bus (publishManagerSignal,
 *     signal_type 'cross_manager_referral'). Validation is the registry's DECLARED
 *     collaboration map (MANAGER_COLLABORATIONS): an edge no collaboration domain
 *     contains is refused HERE before it ever reaches the bus — and the shared
 *     receiving handler (lib/kernel/manager-signals.ts) re-checks on consumption, so
 *     neither end can free-lance an undeclared referral.
 *
 *   publishApprovalSlaReferrals() — the first live emitter: the Cron Manager
 *     (per-manager SLO owner) sweeps the approval-queue SLA telemetry
 *     (lib/kernel/approval-sla.ts, read-only over the canonical aggregator) and, for
 *     every kind whose oldest pending row is past the 48h breach line, refers the
 *     breach INTO the owning manager's domain (the approval_queue_slo collaboration).
 *     Recency-deduped per (to_manager, queue kind) over the bus ledger itself — a
 *     standing breach re-raises at most weekly, never every sweep. Runs from the
 *     manager-signals cron's publish phase (cron_manager-run, /api/cron/manager-signals).
 *
 * Publishing goes through publishManagerSignal (its insert is error-checked and
 * returns { ok } — no silent .then loss); nothing here sends anything to a client.
 */

import { createServiceClient } from "@/lib/supabase/service"
import {
  MANAGERS, MANAGER_COLLABORATIONS, canRefer, type ManagerKey,
} from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** How long a consumed/expired referral for the same (to, queue-kind) suppresses a
 *  re-raise — a standing SLA breach nags weekly, not every 30-minute sweep. */
export const REFERRAL_RENAG_DAYS = 7

export interface CrossReferralInput {
  brokerageId: string
  fromManager: ManagerKey
  toManager: ManagerKey
  /** The declared collaboration domain this referral travels (MANAGER_COLLABORATIONS key). */
  collabDomain: string
  /** What the raising manager is asking the peer to do — plain language. */
  ask: string
  entityType?: string | null
  entityId?: string | null
  /** Extra payload facts (merged after the reserved collab_domain / ask keys). */
  payload?: Record<string, unknown>
}

/** PURE: is this referral allowed to travel? Both ends real + distinct, and the
 *  NAMED collaboration domain declares both managers. */
export function validateReferral(
  input: Pick<CrossReferralInput, "fromManager" | "toManager" | "collabDomain">,
): { ok: true } | { ok: false; reason: string } {
  const domain = MANAGER_COLLABORATIONS[input.collabDomain]
  if (!domain) return { ok: false, reason: `unknown collaboration domain '${input.collabDomain}'` }
  if (!canRefer(input.fromManager, input.toManager, input.collabDomain)) {
    return {
      ok: false,
      reason: `${input.fromManager} → ${input.toManager} is not a declared edge of '${input.collabDomain}' — cross-management only travels MANAGER_COLLABORATIONS`,
    }
  }
  return { ok: true }
}

/**
 * Raise a governed cross-manager referral on the bus. Refuses undeclared edges
 * before publishing. Returns the publish outcome (ok + signalId, or the refusal).
 */
export async function raiseCrossManagerReferral(
  input: CrossReferralInput, client?: Svc,
): Promise<{ ok: boolean; signalId?: string; reason?: string }> {
  const valid = validateReferral(input)
  if (!valid.ok) return { ok: false, reason: valid.reason }
  const supabase = client ?? createServiceClient()
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const fromLabel = MANAGERS[input.fromManager]?.label ?? input.fromManager
  return publishManagerSignal({
    brokerageId: input.brokerageId,
    fromManager: input.fromManager,
    toManager: input.toManager,
    signalType: "cross_manager_referral",
    message: `${fromLabel} referral (${MANAGER_COLLABORATIONS[input.collabDomain].label}): ${input.ask}`.slice(0, 500),
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payload: { ...(input.payload ?? {}), collab_domain: input.collabDomain, ask: input.ask },
  }, supabase)
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRST LIVE EMITTER — the approval-queue SLA sweep.
// ─────────────────────────────────────────────────────────────────────────────

/** The probes that find CANDIDATE brokerages cheaply: any tenant carrying at least
 *  one pending approval row older than the breach line, per the aggregator's own
 *  source tables + filters (mirrored read-only — the aggregator stays untouched). */
const BREACH_CANDIDATE_PROBES: Array<{
  table: string
  apply: (q: any, cutoffIso: string) => any
}> = [
  { table: "newsletter_campaigns",   apply: (q, c) => q.in("approval_status", ["pending", "pending_review"]).lt("created_at", c) },
  { table: "email_campaigns",        apply: (q, c) => q.eq("approval_status", "pending").lt("created_at", c) },
  { table: "ad_creative_variations", apply: (q, c) => q.eq("approval_status", "draft").lt("created_at", c) },
  { table: "video_snippets",         apply: (q, c) => q.eq("approval_status", "pending").lt("created_at", c) },
  { table: "blog_posts",             apply: (q, c) => q.eq("publish_status", "draft").lt("created_at", c) },
  { table: "podcast_episodes",       apply: (q, c) => q.eq("approval_status", "pending_review").lt("created_at", c) },
  { table: "ai_video_projects",      apply: (q, c) => q.eq("approval_status", "pending_review").lt("created_at", c) },
  { table: "offers",                 apply: (q, c) => q.eq("status", "pending").lt("created_at", c) },
  { table: "property_alerts",        apply: (q, c) => q.eq("is_active", false).in("source", ["voice_conversation", "text_conversation"]).lt("created_at", c) },
  { table: "approval_items",         apply: (q, c) => q.eq("status", "pending").lt("submitted_at", c) },
]

/** Bound per sweep — the cron runs every 30 min; a giant fleet drains over a few runs. */
const MAX_BROKERAGES_PER_SWEEP = 25

export interface SlaReferralSweepResult {
  candidates: number
  published: number
  skippedRecent: number
  errors: string[]
}

/**
 * The Cron Manager's SLA sweep: find tenants with >48h-old pending approvals, compute
 * the REAL per-kind telemetry through the canonical aggregator, and refer every
 * breached kind into its owning manager's domain (approval_queue_slo edge). One
 * referral per (owner, kind) per RENAG window, deduped against the bus ledger itself
 * (payload.queue_kind), so a standing breach never spams the inbox.
 */
export async function publishApprovalSlaReferrals(client?: Svc): Promise<SlaReferralSweepResult> {
  const svc = client ?? createServiceClient()
  const result: SlaReferralSweepResult = { candidates: 0, published: 0, skippedRecent: 0, errors: [] }
  const { APPROVAL_SLA_BREACH_HOURS, loadApprovalSla, slaBreaches } = await import("@/lib/kernel/approval-sla")
  const cutoffIso = new Date(Date.now() - APPROVAL_SLA_BREACH_HOURS * 3_600_000).toISOString()

  // 1) Candidate tenants — cheap per-table probes for stale pending rows.
  const candidateIds = new Set<string>()
  for (const probe of BREACH_CANDIDATE_PROBES) {
    try {
      const { data } = await probe.apply(svc.from(probe.table).select("brokerage_id"), cutoffIso).limit(500)
      for (const row of (data ?? []) as Array<{ brokerage_id: string | null }>) {
        if (row.brokerage_id) candidateIds.add(row.brokerage_id)
      }
    } catch (e) {
      result.errors.push(`${probe.table}: ${e instanceof Error ? e.message : "probe failed"}`)
    }
  }
  const candidates = Array.from(candidateIds).slice(0, MAX_BROKERAGES_PER_SWEEP)
  result.candidates = candidates.length
  if (candidates.length === 0) return result

  const renagCutoffIso = new Date(Date.now() - REFERRAL_RENAG_DAYS * 86_400_000).toISOString()

  // 2) Per candidate: the REAL telemetry (canonical aggregator), then one governed
  //    referral per breached kind, recency-deduped over the bus ledger.
  for (const brokerageId of candidates) {
    try {
      const breaches = slaBreaches(await loadApprovalSla(brokerageId, null))
      for (const b of breaches) {
        if (b.owner === "cron_manager") continue // never self-refer (from === to is invalid anyway)
        const { data: recent } = await svc
          .from("manager_signals")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("signal_type", "cross_manager_referral")
          .eq("to_manager", b.owner)
          .contains("payload", { queue_kind: b.kind })
          .gte("created_at", renagCutoffIso)
          .limit(1)
          .maybeSingle()
        if (recent) { result.skippedRecent += 1; continue }
        const res = await raiseCrossManagerReferral({
          brokerageId,
          fromManager: "cron_manager",
          toManager: b.owner,
          collabDomain: "approval_queue_slo",
          ask: `${b.breached} ${b.label.toLowerCase()} approval${b.breached === 1 ? "" : "s"} pending past the ${APPROVAL_SLA_BREACH_HOURS}h SLA (oldest ${b.oldestHours}h, ${b.pending} pending total). Clear the queue or surface the blocker — the gate only works when a human actually reviews.`,
          payload: {
            queue_kind: b.kind,
            pending: b.pending,
            breached: b.breached,
            oldest_hours: b.oldestHours,
            avg_hours: b.avgHours,
          },
        }, svc)
        if (res.ok) result.published += 1
        else if (res.reason) result.errors.push(`${brokerageId}/${b.kind}: ${res.reason}`)
      }
    } catch (e) {
      result.errors.push(`${brokerageId}: ${e instanceof Error ? e.message : "sweep failed"}`)
    }
  }
  return result
}
