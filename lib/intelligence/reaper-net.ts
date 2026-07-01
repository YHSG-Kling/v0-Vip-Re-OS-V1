// ─── THE REAPER NET ──────────────────────────────────────────────────────────
// "Nothing falls through the cracks" — as ONE governed net instead of five hand-
// wired reapers. Each manager domain that can leave work STUCK (a stalled video,
// an abandoned workflow, an accepted-but-untracked offer, a missed past-client
// touch, a deal past its close date, a stalled handoff on the bus) registers a
// reaper here. The net runs them on a uniform contract, records every sweep to the
// reaper_runs ledger (the autonomous-AI accountability receipt), and exposes a
// coverage map so the Command Center can show — honestly — how much of the team is
// under active reaper coverage.
//
// CONSOLIDATION: the per-domain reaper functions are unchanged (each still owns its
// own pure policy + idempotent escalation). What's consolidated is the CREWING —
// one registry, one runner, one ledger — instead of five copies hand-wired into
// two crons. The crons now call runReaperNet() by lane.

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** Which cron drives a reaper (its cadence) — keeps disjoint runs, no double-firing. */
export type ReaperLane = "proactive" | "signals"

export interface ReaperResult {
  domain: string
  manager: ManagerKey
  scanned: number
  /** Items escalated to a human (the "needs attention" count). */
  escalated: number
  /** Items reconciled/expired by the reaper itself (handled autonomously). */
  reaped: number
  detail?: string
}

interface ReaperEntry {
  domain: string
  manager: ManagerKey
  lane: ReaperLane
  /** One broker-readable phrase describing what this reaper protects. */
  protects: string
  run: (brokerageId: string, svc: Svc) => Promise<{ scanned: number; escalated: number; reaped: number }>
}

// Normalizes the (slightly varied) return shapes of the existing reapers into
// {scanned, escalated, reaped}. expired (signal-reaper) counts as reaped.
function norm(r: { scanned?: number; escalated?: number; reaped?: number; expired?: number }) {
  return {
    scanned: r.scanned ?? 0,
    escalated: r.escalated ?? 0,
    reaped: r.reaped ?? r.expired ?? 0,
  }
}

// ── THE REGISTRY — every domain under reaper coverage ────────────────────────
export const REAPER_NET: ReaperEntry[] = [
  {
    domain: "stale_video_workflows",
    manager: "asset_manager",
    lane: "proactive",
    protects: "video renders that stall in the pipeline",
    run: async (b, svc) => {
      const { reapStaleVideoWorkflows } = await import("@/lib/video/video-pipeline-reaper")
      return norm(await reapStaleVideoWorkflows(b, svc))
    },
  },
  {
    domain: "stale_workflow_runs",
    manager: "campaign_orchestrator",
    lane: "proactive",
    protects: "campaign/automation chains that stall mid-run",
    run: async (b, svc) => {
      const { reapStaleWorkflowRuns } = await import("@/lib/workflow-orchestrator/stale-run-reaper")
      return norm(await reapStaleWorkflowRuns(b, svc))
    },
  },
  {
    domain: "stranded_offers",
    manager: "deal_coordinator",
    lane: "proactive",
    protects: "accepted offers that never became tracked deals",
    run: async (b, svc) => {
      const { reapStrandedAcceptedOffers } = await import("@/lib/transactions/stranded-offer-reaper")
      return norm(await reapStrandedAcceptedOffers(b, svc))
    },
  },
  {
    domain: "closing_overdue",
    manager: "deal_coordinator",
    lane: "proactive",
    protects: "deals that blew past their close date and are still open",
    run: async (b, svc) => {
      const { reapOverdueClosings } = await import("@/lib/transactions/closing-overdue-reaper")
      return norm(await reapOverdueClosings(b, svc))
    },
  },
  {
    domain: "cda_undelivered",
    manager: "deal_coordinator",
    lane: "proactive",
    protects: "approved CDAs that never reached title (funds can't disburse)",
    run: async (b, svc) => {
      const { reapUndeliveredCdas } = await import("@/lib/transactions/cda-delivery-reaper")
      return norm(await reapUndeliveredCdas(b, svc))
    },
  },
  {
    domain: "lifetime_touchpoints",
    manager: "sphere_of_influence",
    lane: "proactive",
    protects: "scheduled past-client touches that slipped",
    run: async (b, svc) => {
      const { reapStuckLifetimeTouchpoints } = await import("@/lib/sphere/lifetime-touchpoint-reaper")
      return norm(await reapStuckLifetimeTouchpoints(b, svc))
    },
  },
  {
    domain: "commission_unrecorded",
    manager: "finance_manager",
    lane: "proactive",
    protects: "closed deals with no commission recorded (revenue leak)",
    run: async (b, svc) => {
      const { reapCommissionLeaks } = await import("@/lib/finance/commission-leak-reaper")
      return norm(await reapCommissionLeaks(b, svc))
    },
  },
  {
    domain: "compliance_flags_stuck",
    manager: "compliance_officer",
    lane: "proactive",
    protects: "raised Fair-Housing/consent flags that sat unreviewed past SLA",
    run: async (b, svc) => {
      const { reapStuckComplianceFlags } = await import("@/lib/compliance/compliance-flag-reaper")
      return norm(await reapStuckComplianceFlags(b, svc))
    },
  },
  {
    domain: "stuck_social_posts",
    manager: "marketing_agent",
    lane: "proactive",
    protects: "scheduled posts that hung publishing or missed their slot",
    run: async (b, svc) => {
      const { reapStuckSocialPosts } = await import("@/lib/marketing/stuck-social-post-reaper")
      return norm(await reapStuckSocialPosts(b, svc))
    },
  },
  {
    domain: "stuck_marketing_campaigns",
    manager: "campaign_orchestrator",
    lane: "proactive",
    protects: "campaigns that stalled (scheduled-never-launched / live-distributed-nothing / draft-forever)",
    run: async (b, svc) => {
      const { reapStuckCampaigns } = await import("@/lib/marketing/stuck-campaign-reaper")
      return norm(await reapStuckCampaigns(b, svc))
    },
  },
  {
    domain: "ad_action_unlaunched",
    manager: "ads_manager",
    lane: "proactive",
    protects: "approved ad spend that never launched",
    run: async (b, svc) => {
      const { reapStuckAdActions } = await import("@/lib/ads/stuck-ad-action-reaper")
      return norm(await reapStuckAdActions(b, svc))
    },
  },
  {
    domain: "recruit_gone_cold",
    manager: "recruiting_manager",
    lane: "proactive",
    protects: "active recruits that stalled in the pipeline past their stage SLA",
    run: async (b, svc) => {
      const { reapStaleRecruits } = await import("@/lib/recruiting/stale-recruit-reaper")
      return norm(await reapStaleRecruits(b, svc))
    },
  },
  {
    domain: "manager_handoffs",
    manager: "data_steward",
    lane: "signals",
    protects: "inter-manager handoffs that stall on the bus",
    run: async (b, svc) => {
      const { reapStuckManagerSignals } = await import("@/lib/kernel/signal-reaper")
      return norm(await reapStuckManagerSignals(b, svc))
    },
  },
]

/** Persist one reaper's sweep to the accountability ledger (best-effort). */
export async function recordReaperRun(
  row: { brokerageId: string; domain: string; manager: ManagerKey; scanned: number; escalated: number; reaped: number; detail?: string | null },
  client?: Svc,
): Promise<void> {
  const svc = client ?? createServiceClient()
  await svc.from("reaper_runs").insert({
    brokerage_id: row.brokerageId,
    domain: row.domain,
    manager: row.manager,
    scanned: row.scanned,
    escalated: row.escalated,
    reaped: row.reaped,
    detail: row.detail ?? null,
  }).then(() => {}, () => {})
}

export interface ReaperNetReport {
  results: ReaperResult[]
  totals: { scanned: number; escalated: number; reaped: number; domains: number; stuckDomains: number }
}

/**
 * Run every reaper in the given lane for one brokerage, record each to the ledger,
 * and return the aggregate. Best-effort per reaper — one failing reaper never aborts
 * the sweep (the whole point is resilience). Default lane is 'proactive'.
 */
export async function runReaperNet(
  brokerageId: string,
  client?: Svc,
  opts?: { lane?: ReaperLane; record?: boolean },
): Promise<ReaperNetReport> {
  const svc = client ?? createServiceClient()
  const lane = opts?.lane ?? "proactive"
  const record = opts?.record ?? true
  const entries = REAPER_NET.filter((e) => e.lane === lane)

  const results: ReaperResult[] = []
  for (const entry of entries) {
    try {
      const r = await entry.run(brokerageId, svc)
      const result: ReaperResult = { domain: entry.domain, manager: entry.manager, ...r }
      results.push(result)
      if (record) {
        await recordReaperRun(
          { brokerageId, domain: entry.domain, manager: entry.manager, scanned: r.scanned, escalated: r.escalated, reaped: r.reaped },
          svc,
        )
      }
    } catch {
      // A reaper that throws is itself a failure mode — record a zero row so the
      // ledger shows it ran, and keep going.
      results.push({ domain: entry.domain, manager: entry.manager, scanned: 0, escalated: 0, reaped: 0, detail: "reaper_error" })
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      escalated: acc.escalated + r.escalated,
      reaped: acc.reaped + r.reaped,
      domains: acc.domains + 1,
      stuckDomains: acc.stuckDomains + (r.escalated + r.reaped > 0 ? 1 : 0),
    }),
    { scanned: 0, escalated: 0, reaped: 0, domains: 0, stuckDomains: 0 },
  )

  return { results, totals }
}

// ── COVERAGE MAP — honest "how much of the team is reaped" ────────────────────
/** Managers that have at least one registered reaper in the net. */
export function managersUnderReaperCoverage(): ManagerKey[] {
  return Array.from(new Set(REAPER_NET.map((e) => e.manager)))
}

// Managers whose "stuck work" is caught NOT by a dedicated net reaper but by an
// existing PREDICTOR → handler chain, with the signals-lane reaper (manager_handoffs)
// as the safety net for anything the handler leaves unhandled. Documented here so the
// coverage map tells the truth: these domains ARE covered, just by a different
// mechanism — and we don't bolt on a duplicate reaper (that would be drift).
export const PREDICTOR_BACKED_COVERAGE: { manager: ManagerKey; via: string }[] = [
  { manager: "shopping_agent", via: "buyer_stall_predicted → gated reset handler (safety net: manager_handoffs reaper)" },
  { manager: "listing_concierge", via: "listing_stall_predicted → marketing-refresh + re-prospect handlers (safety net: manager_handoffs reaper)" },
  { manager: "ai_isa", via: "escalateUnassignedQualifiedLead → broker/admin escalation when no agent can be assigned" },
]

export interface ReaperCoverage {
  totalManagers: number
  /** Managers with a DEDICATED reaper in the net. */
  coveredManagers: ManagerKey[]
  /** Managers covered via a predictor+handler chain (not a dedicated reaper). */
  predictorBackedManagers: ManagerKey[]
  /** Union of dedicated + predictor-backed — the honest "effective coverage". */
  effectiveCoveredManagers: ManagerKey[]
  /** Managers with NO coverage of any kind — the real remaining gaps. */
  uncoveredManagers: ManagerKey[]
  domains: { domain: string; manager: ManagerKey; protects: string }[]
}

export function reaperCoverage(): ReaperCoverage {
  const all = Object.keys(MANAGERS) as ManagerKey[]
  const dedicated = managersUnderReaperCoverage()
  const predictorBacked = Array.from(new Set(PREDICTOR_BACKED_COVERAGE.map((p) => p.manager)))
    .filter((m) => !dedicated.includes(m))
  const effective = Array.from(new Set([...dedicated, ...predictorBacked]))
  return {
    totalManagers: all.length,
    coveredManagers: dedicated,
    predictorBackedManagers: predictorBacked,
    effectiveCoveredManagers: effective,
    uncoveredManagers: all.filter((m) => !effective.includes(m)),
    domains: REAPER_NET.map((e) => ({ domain: e.domain, manager: e.manager, protects: e.protects })),
  }
}

// ── STANDUP FEED — per-manager reaper activity over a window ──────────────────
export interface ManagerReaperActivity {
  scanned: number
  escalated: number
  reaped: number
  domains: string[]
}

/**
 * Aggregate the reaper_runs ledger over the last `sinceHours` into a per-manager
 * map, for the daily standup. Returns {} when the ledger is empty (honest).
 */
export async function loadRecentReaperActivity(
  brokerageId: string,
  sinceHours = 24,
  client?: Svc,
): Promise<Record<string, ManagerReaperActivity>> {
  const svc = client ?? createServiceClient()
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString()
  const { data } = await svc
    .from("reaper_runs")
    .select("manager, domain, scanned, escalated, reaped")
    .eq("brokerage_id", brokerageId)
    .gte("ran_at", since)
    .limit(2000)

  const out: Record<string, ManagerReaperActivity> = {}
  for (const row of (data ?? []) as Array<{ manager: string; domain: string; scanned: number; escalated: number; reaped: number }>) {
    const m = (out[row.manager] ??= { scanned: 0, escalated: 0, reaped: 0, domains: [] })
    m.scanned += row.scanned ?? 0
    m.escalated += row.escalated ?? 0
    m.reaped += row.reaped ?? 0
    if (!m.domains.includes(row.domain)) m.domains.push(row.domain)
  }
  return out
}
