// lib/kernel/exceptions-first.ts
//
// EXCEPTIONS-FIRST (wave 108, lane 108D — owner: "12,421 activities occurred overnight. You need to
// care about 6."). The Command Center's (lib/kernel/command-center.ts loadCommandCenter) RANKER: it
// does not read a new world, it RE-ORDERS what the survivors already know so the broker sees what
// needs attention first and everything the OS handled on its own collapses into COUNTS.
//
// SURVIVORS READ, none re-derived (each category names its reader in EXCEPTION_CATEGORIES):
//   · transactions at risk      → the brokerage twin's atRisk (deal_health_scores, calculateDealHealth)
//   · human intervention        → the Command Center's client decisions (tasks) + SLA-breached approvals
//   · agent capacity            → the twin's capacity (capacityFor — the one capacity answer)
//   · campaign overspend        → the Ads Manager (lib/ads/ad-manager.ts): its pause ("bleed") proposals
//                                 + loadCampaignOverruns (spend against daily_budget)
//   · compliance approvals      → the Command Center's compliance pre-flight + the twin's compliance risk
//   · billing anomalies         → the economic graph's reconciliation (summary drift / conservation)
//                                 + billing_invoices past due
//   · missions needing decision → lib/kernel/missions.ts activeMissionsFor (attention) + the 105B
//                                 controller verdicts (missionVerdictLines humanNeeded)
//   · OS health                 → the Exception Center (lib/kernel/exception-center.ts over
//                                 self_heal_events) + the Command Center heartbeat (cron_execution_logs)
//
// THE ACTIVITY COUNT is agent_action_ledger rows (every governed action — withActionLedger) in the
// window, COUNTED with its denominator stated; every counted row lands in exactly one "handled
// automatically" bucket (or the published `unbucketed` overflow) — nothing is hidden from the count.
// A reader that fails is PUBLISHED as refused (named in the headline), never rendered as "clear".
// Team scope: categories whose rows carry no team column are WITHHELD for a team (teams see only
// their own board) — said, never zeroed. Pure core + one async loader. Read-only.

export type ExceptionCategoryKey =
  | "transaction_at_risk" | "human_intervention" | "agent_capacity" | "campaign_overspend"
  | "compliance_approval" | "billing_anomaly" | "mission_decision" | "os_health"

export type ExceptionSeverity = "critical" | "high" | "medium"
export const SEVERITY_RANK: Readonly<Record<ExceptionSeverity, number>> = { critical: 0, high: 1, medium: 2 }

export interface ExceptionDoor { label: string; href: string }

export interface ExceptionCategorySpec {
  label: string
  /** The survivor that produces the rows — never this module. */
  reader: string
  /** The ONE action door for the category (an item may narrow it). */
  door: ExceptionDoor
  /** False → the reader's rows carry no team column: a TEAM scope withholds the category. */
  teamNarrowable: boolean
}

/** THE category table — order is the final tie-break in the ranking. */
export const EXCEPTION_CATEGORIES: Readonly<Record<ExceptionCategoryKey, ExceptionCategorySpec>> = {
  transaction_at_risk: { label: "Transactions at risk", reader: "brokerage twin atRisk[deal_health] (deal_health_scores · calculateDealHealth)", door: { label: "Open the at-risk deals", href: "/dashboard/transactions" }, teamNarrowable: true },
  human_intervention: { label: "Opportunities needing a human", reader: "Command Center clientDecisions (tasks · decision-signal rail) + SLA-breached approvals (evaluateApprovalSla)", door: { label: "Decide now", href: "/dashboard/admin/command-center#approval-queue" }, teamNarrowable: true },
  agent_capacity: { label: "Agent capacity problems", reader: "brokerage twin capacity (capacityFor · capacity-guardian bands)", door: { label: "Rebalance the book", href: "/dashboard/admin/agents" }, teamNarrowable: true },
  campaign_overspend: { label: "Campaign overspend", reader: "Ads Manager (lib/ads/ad-manager.ts) pause proposals + loadCampaignOverruns (ad_campaigns.daily_budget × ad_performance.spend)", door: { label: "Review ad spend", href: "/dashboard/campaigns/ads" }, teamNarrowable: true },
  compliance_approval: { label: "Compliance approvals required", reader: "Command Center compliancePreflight (manager-dissent) + brokerage twin atRisk[compliance] (compliance_flags)", door: { label: "Review compliance", href: "/dashboard/compliance" }, teamNarrowable: true },
  billing_anomaly: { label: "Billing anomalies", reader: "economic graph reconcileSummariesAgainstLedger (summary drift · conservation) + billing_invoices (open past due_date)", door: { label: "Open billing", href: "/dashboard/admin/billing" }, teamNarrowable: false },
  mission_decision: { label: "Missions needing a decision", reader: "missions activeMissionsFor (BLOCKED / APPROVAL_REQUIRED / ESCALATED) + mission-controller missionVerdictLines (humanNeeded)", door: { label: "Decide on the Missions card", href: "/dashboard/admin/command-center#missions" }, teamNarrowable: false },
  os_health: { label: "OS health incidents", reader: "Exception Center composeExceptionCenter (self_heal_events escalated) + heartbeat (cron_execution_logs failed / timeout)", door: { label: "Open the Exception Center", href: "/dashboard/brokerage#exception-center" }, teamNarrowable: false },
}
export const EXCEPTION_CATEGORY_ORDER = Object.keys(EXCEPTION_CATEGORIES) as ExceptionCategoryKey[]

export interface ExceptionEvidence {
  table: string
  filter: string
  count: number
  /** The producer of the rows (never this module). */
  via: string
  /** The first ids backing the item (bounded) — a reviewer can open them. */
  ids?: string[]
}

export interface ExceptionItem {
  /** Stable key (category + discriminator) — the final ranking tie-break. */
  key: string
  category: ExceptionCategoryKey
  severity: ExceptionSeverity
  title: string
  /** Why this is an exception and not something the OS handles. */
  why: string
  /** How many underlying rows this item stands for. */
  count: number
  /** Money behind the item (cents) when the rows carry it; null otherwise. */
  exposureCents: number | null
  /** The oldest waiting instant (ISO) when known — older outranks newer at equal severity. */
  oldestAt: string | null
  evidence: ExceptionEvidence
  door: ExceptionDoor
}

export interface RankedException extends ExceptionItem { rank: number }

export type CategoryReading =
  | { status: "published"; items: ExceptionItem[]; blindSpot?: string | null }
  | { status: "refused"; reason: string }
  | { status: "withheld"; reason: string }

export type ScopeKind = "brokerage" | "team" | "narrow"

export interface ActivityBucket {
  key: string
  label: string
  count: number
  byStatus: Record<string, number>
}

export type ActivityCount =
  | {
      status: "counted"
      total: number
      windowStart: string
      windowEnd: string
      windowSource: WindowSource
      /** What the total is a count OF — published beside the number. */
      denominator: string
      buckets: ActivityBucket[]
      /** Rows counted in `total` but beyond the bucketing read's cap — published, never dropped. */
      unbucketed: number
      blindSpots: string[]
    }
  | { status: "refused"; reason: string; windowStart: string; windowEnd: string; windowSource: WindowSource; denominator: string }

export type WindowSource = "last_visit" | "last_action" | "default_24h" | "clamped_min" | "clamped_max"

export interface ExceptionsFirstView {
  headline: string
  scope: ScopeKind
  activity: ActivityCount
  exceptions: RankedException[]
  categories: Array<{ key: ExceptionCategoryKey; label: string; reader: string; status: CategoryReading["status"]; count: number; reason: string | null; blindSpot: string | null; door: ExceptionDoor }>
  /** Counts of what the OS handled on its own — the same rows as activity.total, never fewer. */
  handledAutomatically: { total: number | null; buckets: ActivityBucket[]; unbucketed: number }
}

// ─── Pure core ───────────────────────────────────────────────────────────────

/** The window floor/ceiling around "since your last visit" (the viewer's last recorded action). */
export const WINDOW_MIN_HOURS = 12
export const WINDOW_MAX_DAYS = 7
export const DEFAULT_WINDOW_HOURS = 24

/** Pure: the activity window — since the viewer's last DASHBOARD VISIT (users.last_dashboard_visit_at,
 *  wave 137 — basis "last_visit") or, before the first recorded visit / an unapplied m741, their last
 *  recorded ledger action (the 108D proxy — basis "last_action"); clamped to [12h, 7d]; nothing recorded →
 *  the last 24 hours. The source is published with the number.
 * @proofSeam exported so scripts/exceptions-first-guard.ts asserts it directly. */
export function resolveActivityWindow(now: Date, lastActionAt: string | null, basis: "last_visit" | "last_action" = "last_action"): { start: string; source: WindowSource } {
  const t = now.getTime()
  if (!lastActionAt || Number.isNaN(Date.parse(lastActionAt))) return { start: new Date(t - DEFAULT_WINDOW_HOURS * 3_600_000).toISOString(), source: "default_24h" }
  const last = Date.parse(lastActionAt)
  if (last > t - WINDOW_MIN_HOURS * 3_600_000) return { start: new Date(t - WINDOW_MIN_HOURS * 3_600_000).toISOString(), source: "clamped_min" }
  if (last < t - WINDOW_MAX_DAYS * 86_400_000) return { start: new Date(t - WINDOW_MAX_DAYS * 86_400_000).toISOString(), source: "clamped_max" }
  return { start: new Date(last).toISOString(), source: basis }
}

/**
 * THE WRITER of users.last_dashboard_visit_at (wave 137, owner-approved "a real last-visit timestamp column
 * + writer"). Called by the Command Center page AFTER loadCommandCenter has read the previous visit, with the
 * SESSION user's id (never a body value). Tenant-pinned when the viewer has a brokerage. A refused write
 * (e.g. m741 not applied) is returned, never thrown — the page still renders; the window then keeps reading
 * the ledger proxy, which is the published source. `.select()` counts the row (a write that matched
 * nothing is reported as such, CLAUDE.md §3).
 */
export async function recordDashboardVisit(svc: any, input: { userId: string; brokerageId: string; now?: Date }): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  if (!input.userId) return { ok: false, error: "no session user" }
  // The SESSION user's own row, pinned to the session tenant UNCONDITIONALLY — a missing tenant refuses
  // (fail closed) rather than decaying to "any tenant" (CLAUDE.md §4).
  if (!input.brokerageId) return { ok: false, error: "no session tenant" }
  const { data, error } = await svc.from("users").update({ last_dashboard_visit_at: (input.now ?? new Date()).toISOString() }).eq("id", input.userId).eq("brokerage_id", input.brokerageId).select("id")
  if (error) return { ok: false, error: error.message ?? "refused" }
  const updated = Array.isArray(data) ? data.length : 0
  return updated === 1 ? { ok: true, updated } : { ok: false, error: `last-visit write matched ${updated} row(s)` }
}

export interface LedgerActivityRow { actor_type: string | null; actor_manager_key: string | null; status: string | null }

/** Pure: every counted ledger row lands in exactly ONE bucket — people (actor_type user), a manager
 *  (actor_manager_key), or the actor type itself; rows beyond the read cap are `unbucketed`, so
 *  Σ buckets + unbucketed === total ALWAYS (nothing auto-handled is hidden from the count).
 * @proofSeam exported so scripts/exceptions-first-guard.ts asserts it directly. */
export function bucketActivity(rows: LedgerActivityRow[], total: number, managerLabel: (key: string) => string | null = () => null): { buckets: ActivityBucket[]; unbucketed: number } {
  const map = new Map<string, ActivityBucket>()
  const counted = rows.slice(0, Math.max(0, total))
  for (const r of counted) {
    const key = r.actor_type === "user" ? "people" : (r.actor_manager_key || r.actor_type || "unattributed")
    const label = key === "people" ? "Done by people" : key === "unattributed" ? "Unattributed" : (managerLabel(key) ?? key.replace(/_/g, " "))
    const b = map.get(key) ?? { key, label, count: 0, byStatus: {} }
    b.count += 1
    const s = r.status || "unknown"
    b.byStatus[s] = (b.byStatus[s] ?? 0) + 1
    map.set(key, b)
  }
  const buckets = [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  return { buckets, unbucketed: Math.max(0, total - counted.length) }
}

/** Pure, deterministic: severity → money behind it → rows behind it → oldest waiting → category
 *  order → key. The same inputs in any order produce the same ranking.
 * @proofSeam exported so scripts/exceptions-first-guard.ts asserts it directly. */
export function rankExceptions(items: ExceptionItem[]): RankedException[] {
  const catIdx = (k: ExceptionCategoryKey) => EXCEPTION_CATEGORY_ORDER.indexOf(k)
  return [...items].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (b.exposureCents ?? -1) - (a.exposureCents ?? -1)
    || b.count - a.count
    || (a.oldestAt ?? "￿").localeCompare(b.oldestAt ?? "￿")
    || catIdx(a.category) - catIdx(b.category)
    || a.key.localeCompare(b.key),
  ).map((x, i) => ({ ...x, rank: i + 1 }))
}

const fmt = (n: number) => n.toLocaleString("en-US")

/** Pure: the sentence the page leads with. A refused count or category is NAMED — never zero.
 * @proofSeam exported so scripts/exceptions-first-guard.ts asserts it directly. */
export function exceptionsHeadline(activity: ActivityCount, exceptionCount: number, refusedLabels: string[]): string {
  const when = activity.windowSource === "default_24h" ? "in the last 24 hours" : "since your last visit"
  const first = activity.status === "counted"
    ? `${fmt(activity.total)} ${activity.total === 1 ? "activity" : "activities"} occurred ${when}.`
    : `Activity ${when} could not be counted (${activity.reason}).`
  const second = `You need to care about ${fmt(exceptionCount)}.`
  const third = refusedLabels.length > 0
    ? ` ${refusedLabels.length === 1 ? "1 category" : `${refusedLabels.length} categories`} could not be read — ${refusedLabels.join(", ")} — and ${refusedLabels.length === 1 ? "is" : "are"} NOT counted as clear.`
    : ""
  return `${first} ${second}${third}`
}

/** Pure: fold the activity count + every category reading into the page's view. Every category
 *  in EXCEPTION_CATEGORIES appears (a missing reading is published as refused, never dropped).
 * @proofSeam exported so scripts/exceptions-first-guard.ts asserts it directly. */
export function composeExceptionsFirst(input: { scope: ScopeKind; activity: ActivityCount; readings: Partial<Record<ExceptionCategoryKey, CategoryReading>> }): ExceptionsFirstView {
  const items: ExceptionItem[] = []
  const categories: ExceptionsFirstView["categories"] = []
  const refused: string[] = []
  for (const key of EXCEPTION_CATEGORY_ORDER) {
    const spec = EXCEPTION_CATEGORIES[key]
    const r: CategoryReading = input.readings[key] ?? { status: "refused", reason: "no reading was produced" }
    if (r.status === "published") items.push(...r.items.map((i) => ({ ...i, category: key })))
    if (r.status === "refused") refused.push(spec.label.toLowerCase())
    categories.push({
      key, label: spec.label, reader: spec.reader, status: r.status,
      count: r.status === "published" ? r.items.length : 0,
      reason: r.status === "published" ? null : r.reason,
      blindSpot: r.status === "published" ? (r.blindSpot ?? null) : null,
      door: spec.door,
    })
  }
  const exceptions = rankExceptions(items)
  const a = input.activity
  return {
    headline: exceptionsHeadline(a, exceptions.length, refused),
    scope: input.scope,
    activity: a,
    exceptions,
    categories,
    handledAutomatically: a.status === "counted"
      ? { total: a.total, buckets: a.buckets, unbucketed: a.unbucketed }
      : { total: null, buckets: [], unbucketed: 0 },
  }
}

// ─── Category builders (pure, over what the survivors already produced) ──────

type Twin = import("@/lib/kernel/brokerage-twin").BrokerageTwin
type CcAction = import("@/lib/kernel/command-center").CommandCenterAction
type CcDecision = import("@/lib/kernel/command-center").ClientDecisionLine

const doorOf = (k: ExceptionCategoryKey, href?: string): ExceptionDoor => ({ label: EXCEPTION_CATEGORIES[k].door.label, href: href ?? EXCEPTION_CATEGORIES[k].door.href })
const oldest = (xs: Array<string | null | undefined>): string | null => xs.filter((x): x is string => !!x).sort()[0] ?? null

/** Twin risk entries of `kind` → items. `watch` is monitoring the OS does — not an exception. */
function twinRiskItems(twin: Twin, kind: "deal_health" | "compliance", category: ExceptionCategoryKey): ExceptionItem[] {
  return twin.atRisk.filter((r) => r.kind === kind && r.severity !== "watch" && r.count > 0).map((r) => ({
    key: `${category}:${kind}:${r.severity}`, category, severity: r.severity === "critical" ? "critical" : "high",
    title: r.headline, why: `The twin judged ${r.count} row${r.count === 1 ? "" : "s"} ${r.severity.replace("_", " ")} — the OS flags, a human saves.`,
    count: r.count, exposureCents: r.exposureCents, oldestAt: null,
    evidence: { table: r.evidence.table, filter: r.evidence.filter, count: r.evidence.count, via: r.evidence.via, ids: r.evidence.ids?.slice(0, 10) },
    door: doorOf(category),
  }))
}

/** Over / at-capacity agents (capacityFor bands without headroom) → items.
 * @proofSeam exported so scripts/exceptions-first-guard.ts asserts it directly. */
export function capacityItems(twin: Twin): ExceptionItem[] {
  const out: ExceptionItem[] = []
  for (const band of ["over", "at_capacity"] as const) {
    const agents = twin.capacity.perAgent.filter((a) => a.band === band)
    if (agents.length === 0) continue
    out.push({
      key: `agent_capacity:${band}`, category: "agent_capacity", severity: band === "over" ? "high" : "medium",
      title: `${agents.length} agent${agents.length === 1 ? " is" : "s are"} ${band === "over" ? "over capacity" : "at capacity"}`,
      why: `capacityFor reads ${band.replace("_", " ")} (load ≥ the tier ceiling ${twin.capacity.maxLoad}) — new work cannot land on ${agents.length === 1 ? "this book" : "these books"} without a rebalance.`,
      count: agents.length, exposureCents: null, oldestAt: null,
      evidence: { table: twin.capacity.evidence.table, filter: `${twin.capacity.evidence.filter} · band=${band}`, count: agents.length, via: twin.capacity.evidence.via, ids: agents.map((a) => a.agentId).slice(0, 10) },
      door: doorOf("agent_capacity"),
    })
  }
  if (twin.capacity.unscored > 0) {
    out.push({
      key: "agent_capacity:unscored", category: "agent_capacity", severity: "medium",
      title: `${twin.capacity.unscored} agent${twin.capacity.unscored === 1 ? "" : "s"} could not be capacity-scored`,
      why: "A refused capacity read is never counted as available — check before routing work to them.",
      count: twin.capacity.unscored, exposureCents: null, oldestAt: null,
      evidence: { table: twin.capacity.evidence.table, filter: "unscored", count: twin.capacity.unscored, via: twin.capacity.evidence.via },
      door: doorOf("agent_capacity"),
    })
  }
  return out
}

/** Client decisions waiting (overdue → high) + approvals past SLA (not compliance-held).
 * @proofSeam exported so scripts/exceptions-first-guard.ts asserts it directly. */
export function humanInterventionItems(decisions: CcDecision[], actions: CcAction[], now: Date): ExceptionItem[] {
  const out: ExceptionItem[] = []
  const today = now.toISOString().slice(0, 10)
  const overdue = decisions.filter((d) => d.dueDate && d.dueDate.slice(0, 10) < today)
  const waiting = decisions.filter((d) => !overdue.includes(d))
  for (const [sev, set] of [["high", overdue], ["medium", waiting]] as const) {
    if (set.length === 0) continue
    out.push({
      key: `human_intervention:decisions:${sev}`, category: "human_intervention", severity: sev,
      title: `${set.length} client decision${set.length === 1 ? "" : "s"} ${sev === "high" ? "past due" : "awaiting you"}`,
      why: "A seller accepted, a lender posted conditions or a vendor filed a request — only a human can execute it.",
      count: set.length, exposureCents: null, oldestAt: oldest(set.map((d) => d.createdAt)),
      evidence: { table: "tasks", filter: `status=pending · source in client decision sources${sev === "high" ? " · due_date < today" : ""}`, count: set.length, via: "decision-signal rail (loadCommandCenter clientDecisions)", ids: set.map((d) => d.id).slice(0, 10) },
      door: { label: "Execute the decision", href: set[0].transactionId ? `/dashboard/transactions/${set[0].transactionId}` : EXCEPTION_CATEGORIES.human_intervention.door.href },
    })
  }
  const breached = actions.filter((a) => a.slaLevel === "breached" && (!a.compliance || a.compliance.status === "clear"))
  if (breached.length > 0) {
    out.push({
      key: "human_intervention:sla_breached", category: "human_intervention", severity: "high",
      title: `${breached.length} approval${breached.length === 1 ? "" : "s"} past the SLA`,
      why: "The managers drafted it; nothing reaches a client until a human releases it, and the SLA is already breached.",
      count: breached.length, exposureCents: null, oldestAt: oldest(breached.map((a) => a.proposedAt)),
      evidence: { table: "approval queues (agent_client_messages · marketing/asset/ad actions · content)", filter: "status=proposed · slaLevel=breached", count: breached.length, via: "evaluateApprovalSla (loadCommandCenter pendingActions)", ids: breached.map((a) => a.id).slice(0, 10) },
      door: doorOf("human_intervention"),
    })
  }
  return out
}

/** Pre-flight holds on outbound copy: blocked → critical, advisory → medium. */
function compliancePreflightItems(actions: CcAction[]): ExceptionItem[] {
  const out: ExceptionItem[] = []
  for (const [status, sev] of [["blocked", "critical"], ["advisory", "medium"]] as const) {
    const set = actions.filter((a) => a.compliance?.status === status)
    if (set.length === 0) continue
    out.push({
      key: `compliance_approval:preflight:${status}`, category: "compliance_approval", severity: sev,
      title: `${set.length} draft${set.length === 1 ? "" : "s"} ${status === "blocked" ? "blocked" : "flagged"} by the Compliance Officer pre-flight`,
      why: status === "blocked" ? "A hard compliance finding (consent / fair housing) — it cannot go out as written." : "An advisory finding — a human decides before release.",
      count: set.length, exposureCents: null, oldestAt: oldest(set.map((a) => a.proposedAt)),
      evidence: { table: "approval queues", filter: `compliance.status=${status}`, count: set.length, via: "compliancePreflight (lib/kernel/manager-dissent.ts)", ids: set.map((a) => a.id).slice(0, 10) },
      door: doorOf("compliance_approval", EXCEPTION_CATEGORIES.human_intervention.door.href),
    })
  }
  return out
}

/** Ads Manager pause proposals (real spend, no / bad leads) + pacing overruns. */
function overspendItems(actions: CcAction[], overruns: Array<{ campaignId: string; name: string | null; spend: number; budget: number; ratio: number }>): ExceptionItem[] {
  const out: ExceptionItem[] = []
  const bleed = actions.filter((a) => a.queue === "ads" && a.actionType === "pause_ad_campaign")
  if (bleed.length > 0) {
    out.push({
      key: "campaign_overspend:bleed", category: "campaign_overspend", severity: "high",
      title: `${bleed.length} campaign${bleed.length === 1 ? "" : "s"} spending without results — pause proposed`,
      why: "The Ads Manager judged real spend with no leads or a cost-per-lead past the limit; money keeps moving until a human approves the pause.",
      count: bleed.length, exposureCents: null, oldestAt: oldest(bleed.map((a) => a.proposedAt)),
      evidence: { table: "ad_manager_actions", filter: "action_type=pause_ad_campaign · status=proposed", count: bleed.length, via: "evaluateAdPerformance (lib/ads/ad-manager.ts)", ids: bleed.map((a) => a.id).slice(0, 10) },
      door: doorOf("campaign_overspend", EXCEPTION_CATEGORIES.human_intervention.door.href),
    })
  }
  if (overruns.length > 0) {
    const over = overruns.reduce((s, o) => s + Math.max(0, o.spend - o.budget), 0)
    const worst = Math.max(...overruns.map((o) => o.ratio))
    out.push({
      key: "campaign_overspend:pacing", category: "campaign_overspend", severity: worst >= 1.5 ? "high" : "medium",
      title: `${overruns.length} campaign${overruns.length === 1 ? "" : "s"} over budget — $${Math.round(over).toLocaleString("en-US")} past the daily-budget pace`,
      why: `Reported spend exceeds daily_budget × the spend window by more than the tolerance (worst ${Math.round(worst * 100)}% of budget).`,
      count: overruns.length, exposureCents: Math.round(over * 100), oldestAt: null,
      evidence: { table: "ad_campaigns × ad_performance", filter: "status in (live, launching) · latest spend > daily_budget × window × (1 + tolerance)", count: overruns.length, via: "loadCampaignOverruns (lib/ads/ad-manager.ts)", ids: overruns.map((o) => o.campaignId).slice(0, 10) },
      door: doorOf("campaign_overspend"),
    })
  }
  return out
}

/** Ledger drift / conservation failures (critical — money disagrees with the ledger) + overdue invoices. */
function billingItems(econ: { summaryDrifts: number; conservationFailures: number; measured: boolean } | null, overdue: Array<{ id: string; amount_cents: number | null; due_date: string | null }>): ExceptionItem[] {
  const out: ExceptionItem[] = []
  if (econ && (econ.summaryDrifts > 0 || econ.conservationFailures > 0)) {
    const n = econ.summaryDrifts + econ.conservationFailures
    out.push({
      key: "billing_anomaly:ledger_drift", category: "billing_anomaly", severity: "critical",
      title: `${n} money figure${n === 1 ? "" : "s"} disagree${n === 1 ? "s" : ""} with the ledger`,
      why: `${econ.summaryDrifts} summary drift${econ.summaryDrifts === 1 ? "" : "s"} · ${econ.conservationFailures} conservation failure${econ.conservationFailures === 1 ? "" : "s"} — a financial discrepancy halts for the Finance Manager and a human; the OS never auto-corrects money.`,
      count: n, exposureCents: null, oldestAt: null,
      evidence: { table: "commission ledger vs summaries", filter: "reconcileSummariesAgainstLedger drifts + graph conservationFailures", count: n, via: "lib/kernel/economic-graph.ts + lib/commission/reconcile-tracking.ts" },
      door: doorOf("billing_anomaly", "/dashboard/financials"),
    })
  }
  if (overdue.length > 0) {
    const cents = overdue.reduce((s, i) => s + (Number(i.amount_cents) || 0), 0)
    out.push({
      key: "billing_anomaly:invoice_overdue", category: "billing_anomaly", severity: "high",
      title: `${overdue.length} subscription invoice${overdue.length === 1 ? "" : "s"} open past due`,
      why: "An open invoice past its due date starts the past-due clock on the subscription.",
      count: overdue.length, exposureCents: cents, oldestAt: oldest(overdue.map((i) => i.due_date)),
      evidence: { table: "billing_invoices", filter: "status=open · due_date < today", count: overdue.length, via: "Stripe invoice webhook (billing_invoices writer)", ids: overdue.map((i) => i.id).slice(0, 10) },
      door: doorOf("billing_anomaly"),
    })
  }
  return out
}

/** Missions the OS cannot move without a human (attention states) + controller verdicts asking for one. */
function missionItems(attention: Array<{ id: string; objective: string; state: string; state_changed_at?: string | null }>, verdictHumanNeeded: Array<{ id: string; line: string }>): ExceptionItem[] {
  const out: ExceptionItem[] = []
  for (const [state, sev] of [["APPROVAL_REQUIRED", "high"], ["ESCALATED", "high"], ["BLOCKED", "medium"]] as const) {
    const set = attention.filter((m) => m.state === state)
    if (set.length === 0) continue
    out.push({
      key: `mission_decision:${state}`, category: "mission_decision", severity: sev,
      title: `${set.length} mission${set.length === 1 ? "" : "s"} ${state.toLowerCase().replace("_", " ")} — "${set[0].objective.slice(0, 80)}"${set.length > 1 ? ` +${set.length - 1}` : ""}`,
      why: "The mission runtime cannot move this objective without a human decision.",
      count: set.length, exposureCents: null, oldestAt: oldest(set.map((m) => m.state_changed_at ?? null)),
      evidence: { table: "missions", filter: `state=${state}`, count: set.length, via: "activeMissionsFor (lib/kernel/missions.ts)", ids: set.map((m) => m.id).slice(0, 10) },
      door: doorOf("mission_decision"),
    })
  }
  if (verdictHumanNeeded.length > 0) {
    out.push({
      key: "mission_decision:controller", category: "mission_decision", severity: "medium",
      title: `${verdictHumanNeeded.length} running mission${verdictHumanNeeded.length === 1 ? "" : "s"} the controller says need${verdictHumanNeeded.length === 1 ? "s" : ""} you — ${verdictHumanNeeded[0].line.slice(0, 90)}`,
      why: "The Mission Controller's verdict flags human intervention (budget, authority, disagreement or a stall).",
      count: verdictHumanNeeded.length, exposureCents: null, oldestAt: null,
      evidence: { table: "missions", filter: "active · verdict.humanNeeded", count: verdictHumanNeeded.length, via: "missionVerdictLines (lib/kernel/mission-controller.ts)", ids: verdictHumanNeeded.map((v) => v.id).slice(0, 10) },
      door: doorOf("mission_decision"),
    })
  }
  return out
}

/** Exceptions the OS declined to repair + scheduled loops that failed in the window. */
function osHealthItems(open: Array<{ eventId: string; describes: string; at: string }>, cron: Array<{ cronName: string; status: string | null; startedAt: string | null }>): ExceptionItem[] {
  const out: ExceptionItem[] = []
  if (open.length > 0) {
    out.push({
      key: "os_health:self_heal_escalated", category: "os_health", severity: "high",
      title: `${open.length} issue${open.length === 1 ? "" : "s"} the OS declined to repair — ${open[0].describes}`,
      why: "Self-heal escalated instead of fixing (unsafe to repair automatically) — a human retries, resolves or dismisses.",
      count: open.length, exposureCents: null, oldestAt: oldest(open.map((o) => o.at)),
      evidence: { table: "self_heal_events", filter: "domain=data_flow · outcome=escalated · no later closer", count: open.length, via: "composeExceptionCenter (lib/kernel/exception-center.ts)", ids: open.map((o) => o.eventId).slice(0, 10) },
      door: doorOf("os_health"),
    })
  }
  const failed = cron.filter((c) => c.status === "failed" || c.status === "timeout")
  if (failed.length > 0) {
    out.push({
      key: "os_health:cron_failed", category: "os_health", severity: "medium",
      title: `${failed.length} scheduled loop${failed.length === 1 ? "" : "s"} failed on the last run — ${failed.slice(0, 3).map((c) => c.cronName).join(", ")}`,
      why: "A loop the OS runs for this tenant did not complete; its work is not happening until it does.",
      count: failed.length, exposureCents: null, oldestAt: oldest(failed.map((c) => c.startedAt)),
      evidence: { table: "cron_execution_logs", filter: "latest run per loop · status in (failed, timeout)", count: failed.length, via: "cron-logging (Command Center heartbeat)" },
      door: doorOf("os_health", "/dashboard/admin/cron-health"),
    })
  }
  return out
}

// ─── Loader (the Command Center calls this with what it already holds) ───────

export interface ExceptionsFirstInput {
  brokerageId: string
  scope: ScopeKind
  teamId: string | null
  /** The viewer's users.id — "since your last visit" reads users.last_dashboard_visit_at (wave 137);
   *  before the first recorded visit it falls back to their last recorded ledger action. */
  viewerUserId: string | null
  /** Team scope: the entity ids the team owns (contacts + listings) — ledger rows are narrowed by subject. */
  scopedEntityIds: string[] | null
  now: Date
  twin: Twin | null
  pendingActions: CcAction[]
  clientDecisions: CcDecision[]
  economicGraph: { summaryDrifts: number; conservationFailures: number; measured: boolean } | null
  cronOwners: Array<{ cronName: string; status: string | null; startedAt: string | null }>
}

/** Rows the bucketing read fetches; the exact count is always the denominator. */
export const ACTIVITY_BUCKET_CAP = 5000
/** Team scope: subject ids sent in one filter (URL bound) — beyond it is a published blind spot. */
export const TEAM_SUBJECT_ID_CAP = 300

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function loadExceptionsFirst(svc: any, input: ExceptionsFirstInput): Promise<ExceptionsFirstView> {
  const { brokerageId, scope, now } = input
  const narrowed = scope !== "brokerage"

  // 1) THE ACTIVITY COUNT — window, then one exact-count read that also returns the bucketing rows.
  let lastActionAt: string | null = null
  let basis: "last_visit" | "last_action" = "last_action"
  if (input.viewerUserId) {
    // THE REAL LAST VISIT (wave 137): the column the Command Center page writes on every visit.
    const visit = await svc.from("users").select("last_dashboard_visit_at").eq("id", input.viewerUserId).eq("brokerage_id", brokerageId).limit(1)
    const visitAt = visit.error ? null : ((visit.data?.[0] as { last_dashboard_visit_at?: string | null } | undefined)?.last_dashboard_visit_at ?? null)
    if (visit.error) console.error(`[exceptions-first] last-visit column read refused (falls back to the ledger proxy): ${visit.error.message}`)
    if (visitAt) { lastActionAt = visitAt; basis = "last_visit" }
    else {
      const { data, error } = await svc.from("agent_action_ledger").select("created_at")
        .eq("brokerage_id", brokerageId).eq("actor_type", "user").eq("actor_user_id", input.viewerUserId)
        .order("created_at", { ascending: false }).limit(1)
      if (error) console.error(`[exceptions-first] last-action read refused: ${error.message}`)
      else lastActionAt = (data?.[0] as { created_at?: string } | undefined)?.created_at ?? null
    }
  }
  const win = resolveActivityWindow(now, lastActionAt, basis)
  const windowEnd = now.toISOString()
  const denominator = `agent_action_ledger rows (every governed action — withActionLedger) for this ${scope === "team" ? "team (subject in the team's contacts + listings)" : "brokerage"} created ${win.start.slice(0, 16).replace("T", " ")} → ${windowEnd.slice(0, 16).replace("T", " ")} UTC`
  let activity: ActivityCount
  if (scope === "narrow") {
    activity = { status: "refused", reason: "an office / agent scope carries no ledger narrowing yet", windowStart: win.start, windowEnd, windowSource: win.source, denominator }
  } else {
    const blindSpots: string[] = ["work that does not pass through withActionLedger (reads, unledgered cron passes) is not in the count"]
    let q = svc.from("agent_action_ledger").select("actor_type, actor_manager_key, status", { count: "exact" })
      .eq("brokerage_id", brokerageId).gte("created_at", win.start).lte("created_at", windowEnd)
    if (scope === "team") {
      const ids = (input.scopedEntityIds ?? []).slice(0, TEAM_SUBJECT_ID_CAP)
      if ((input.scopedEntityIds ?? []).length > TEAM_SUBJECT_ID_CAP) blindSpots.push(`the team owns ${input.scopedEntityIds!.length} entities; the ledger was narrowed by the first ${TEAM_SUBJECT_ID_CAP}`)
      blindSpots.push("team ledger rows whose subject is not a team contact / listing (e.g. agent-level actions) are not in the team count")
      q = q.in("subject_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
    }
    const { data, count, error } = await q.limit(ACTIVITY_BUCKET_CAP)
    if (error || count == null) {
      activity = { status: "refused", reason: error?.message ?? "the ledger returned no count", windowStart: win.start, windowEnd, windowSource: win.source, denominator }
    } else {
      const { MANAGERS } = await import("@/lib/kernel/manager-registry")
      const { buckets, unbucketed } = bucketActivity((data ?? []) as LedgerActivityRow[], count, (k) => (k in MANAGERS ? MANAGERS[k as keyof typeof MANAGERS].label : null))
      if (unbucketed > 0) blindSpots.push(`${unbucketed} rows beyond the ${ACTIVITY_BUCKET_CAP}-row bucketing read are counted but not bucketed`)
      activity = { status: "counted", total: count, windowStart: win.start, windowEnd, windowSource: win.source, denominator, buckets, unbucketed, blindSpots }
    }
  }

  // 2) THE CATEGORIES — each through its survivor; a throw / refusal is published as refused.
  const readings: Partial<Record<ExceptionCategoryKey, CategoryReading>> = {}
  const withheld = (k: ExceptionCategoryKey): CategoryReading | null => {
    if (scope === "team" && !EXCEPTION_CATEGORIES[k].teamNarrowable) return { status: "withheld", reason: "these rows carry no team column — teams see only their own board" }
    if (scope === "narrow") return { status: "withheld", reason: "an office / agent scope sees its own queue below, not the brokerage's exceptions" }
    return null
  }
  const run = async (k: ExceptionCategoryKey, fn: () => Promise<CategoryReading> | CategoryReading) => {
    const w = withheld(k)
    if (w) { readings[k] = w; return }
    try { readings[k] = await fn() } catch (e) { readings[k] = { status: "refused", reason: errMsg(e) } }
  }
  const twinOr = (k: ExceptionCategoryKey, f: (t: Twin) => ExceptionItem[]): CategoryReading =>
    input.twin ? { status: "published", items: f(input.twin), blindSpot: input.twin.blindSpots.length ? `twin blind spots: ${input.twin.blindSpots.slice(0, 2).join(" · ")}` : null }
      : { status: "refused", reason: "the brokerage twin was not built for this load" }

  await Promise.all([
    run("transaction_at_risk", () => twinOr("transaction_at_risk", (t) => twinRiskItems(t, "deal_health", "transaction_at_risk"))),
    run("human_intervention", () => ({ status: "published", items: humanInterventionItems(input.clientDecisions, input.pendingActions, now) })),
    run("agent_capacity", () => twinOr("agent_capacity", capacityItems)),
    run("compliance_approval", () => {
      const pre = compliancePreflightItems(input.pendingActions)
      return input.twin
        ? { status: "published", items: [...pre, ...twinRiskItems(input.twin, "compliance", "compliance_approval")] }
        : { status: "published", items: pre, blindSpot: "the twin was not built — open compliance_flags are not in this reading" }
    }),
    run("campaign_overspend", async () => {
      const { loadCampaignOverruns } = await import("@/lib/ads/ad-manager")
      const r = await loadCampaignOverruns(brokerageId, { teamId: scope === "team" ? input.teamId : null }, svc)
      if (!r.ok) return { status: "refused", reason: r.error }
      return { status: "published", items: overspendItems(input.pendingActions, r.overruns), blindSpot: r.blindSpot }
    }),
    run("billing_anomaly", async () => {
      const { data, error } = await svc.from("billing_invoices").select("id, amount_cents, due_date")
        .eq("brokerage_id", brokerageId).eq("status", "open").lt("due_date", now.toISOString().slice(0, 10)).limit(50)
      if (error) return { status: "refused", reason: `billing_invoices: ${error.message}` }
      return { status: "published", items: billingItems(input.economicGraph, (data ?? []) as any[]), blindSpot: input.economicGraph ? (input.economicGraph.measured ? null : "the economic graph was not fully measured") : "the economic graph was not read — ledger drift is not in this reading" }
    }),
    run("mission_decision", async () => {
      const { activeMissionsFor } = await import("@/lib/kernel/missions")
      const m = await activeMissionsFor(brokerageId, { limit: 200 }, svc)
      if (m.readRefused) return { status: "refused", reason: `missions: ${m.readRefused}` }
      let human: Array<{ id: string; line: string }> = []
      let blindSpot: string | null = null
      try {
        const attentionIds = new Set(m.attention.map((x) => x.id))
        const running = m.active.filter((x) => !attentionIds.has(x.id))
        if (running.length > 0) {
          const { missionVerdictLines } = await import("@/lib/kernel/mission-controller")
          const lines = await missionVerdictLines(brokerageId, running, svc)
          human = Object.entries(lines).filter(([, v]) => v.human.needed).map(([id, v]) => ({ id, line: v.line })).sort((a, b) => a.id.localeCompare(b.id))
        }
      } catch (e) { blindSpot = `controller verdicts unavailable (${errMsg(e)}) — running missions' human flags are not in this reading` }
      return { status: "published", items: missionItems(m.attention as any[], human), blindSpot }
    }),
    run("os_health", async () => {
      const { data, error } = await svc.from("self_heal_events").select("id, subject, action, outcome, detail, created_at")
        .eq("domain", "data_flow").eq("brokerage_id", brokerageId)
        .gte("created_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()).order("created_at", { ascending: true }).limit(1000)
      if (error) return { status: "refused", reason: `self_heal_events: ${error.message}` }
      const { composeExceptionCenter } = await import("@/lib/kernel/exception-center")
      const read = composeExceptionCenter(((data ?? []) as any[]).map((r) => ({ id: r.id, subject: r.subject, action: r.action ?? null, outcome: r.outcome, detail: r.detail ?? null, createdAt: r.created_at })))
      return { status: "published", items: osHealthItems(read.open, input.cronOwners), blindSpot: "provider / webhook / backlog incidents arrive here once the OS-health coordinator (wave 108C) publishes them" }
    }),
  ])

  return composeExceptionsFirst({ scope, activity, readings })
}
