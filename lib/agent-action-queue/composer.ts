/**
 * Agent Action Queue Composer — Sprint 6.
 *
 * The kernel's morning ranking. Every actionable signal the agent has
 * accumulated across the system gets normalized into a single queue
 * scored by:
 *
 *   priority = impact·0.4 + urgency·0.3 + confidence·0.2 + effort·0.1
 *
 * Each component is 0–100. Higher priority = surface higher.
 *
 * Sources (live, all RLS-gated by brokerage):
 *
 *   1. portal_event_stream         — open agent_action_required rows
 *      from the live event stream (Sprint 5)
 *   2. proactive_interventions     — open deal-health interventions
 *      (Deal Health Radar)
 *   3. listing_health_interventions— open listing-health interventions
 *      (Listing Health Radar)
 *   4. lifetime_customer_npv_scores— contacts whose next_touchpoint_due
 *      is within the next 7 days (NPV Ranker — Sprint 3)
 *
 * Brokerage Intelligence "adopt this pattern" insights and Income
 * Forecast deltas are strategic, not per-item actionable, and live on
 * their own widgets — keep the queue tight.
 *
 * Composition is on-the-fly (no snapshot table). Each agent has ≤ ~100
 * items max in practice, and freshness > caching. Dispositions go
 * through the existing dispositionPortalEventAction (Sprint 5) for the
 * portal_event_stream rows; for the other sources the queue links to
 * the canonical surface to resolve (intervention panel, contact CRM).
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

// ─── Types ────────────────────────────────────────────────────────────────

export type ActionSource =
  | "portal_event"
  | "deal_health"
  | "listing_health"
  | "lifetime_npv"

export type ActionSeverity = "low" | "medium" | "high" | "critical" | "celebration"

export interface AgentActionItem {
  /** Source-scoped UUID (portal_event_stream.id / proactive_interventions.id / etc.) */
  id:                  string
  source:              ActionSource
  /** Label the agent reads first (5–8 words). */
  title:               string
  /** Optional supporting context (1 sentence). */
  detail:              string | null
  /** UUIDs the queue card can deep-link with. */
  contactId:           string | null
  contactName:         string | null
  transactionId:       string | null
  listingId:           string | null
  /** $ impact attribution (rounded). NULL when not quantifiable. */
  impactDollars:       number | null
  /** Severity from the source row. */
  severity:            ActionSeverity
  /** Computed urgency score 0–100. */
  urgencyScore:        number
  /** Computed impact score 0–100. */
  impactScore:         number
  /** Computed confidence score 0–100. */
  confidenceScore:     number
  /** Computed effort score 0–100 (HIGHER = less effort to clear). */
  effortScore:         number
  /** Final priority score 0–100. */
  priority:            number
  /** ISO datetime of when this surfaced (drives "n days ago" badge). */
  surfacedAt:          string
  /** Whether dispositionPortalEventAction can handle this directly. */
  hasInlineDisposition: boolean
  /** Deep-link to the surface that resolves this (when no inline disposition). */
  resolveHref:         string | null
}

// ─── Scoring helpers ──────────────────────────────────────────────────────

const SEVERITY_URGENCY: Record<ActionSeverity, number> = {
  critical:    100,
  high:        80,
  medium:      55,
  low:         30,
  celebration: 25,
}

function severityImpactMultiplier(s: ActionSeverity): number {
  return s === "critical" ? 1.0
       : s === "high"     ? 0.7
       : s === "medium"   ? 0.4
       : s === "low"      ? 0.2
       : 0.1
}

function daysBetween(from: string | null, to: Date = new Date()): number {
  if (!from) return 9999
  const diff = (to.getTime() - new Date(from).getTime()) / 86_400_000
  return Math.round(diff)
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n))
}

function dollarsToImpact(n: number): number {
  // log-scale $ → 0..100. $0=0, $1k=14, $10k=28, $100k=42, $1M=56
  if (n <= 0) return 0
  return clamp(Math.log10(Math.max(n, 1)) * 14, 0, 100)
}

function ageToUrgency(daysAgo: number): number {
  // Newer = more urgent. >7d ago drops fast.
  if (daysAgo <= 0) return 100
  if (daysAgo <= 1) return 90
  if (daysAgo <= 3) return 75
  if (daysAgo <= 7) return 60
  if (daysAgo <= 14) return 40
  return 20
}

function dueInUrgency(daysFromNow: number): number {
  // Overdue or due today = max; future drops off
  if (daysFromNow <= 0) return 100
  if (daysFromNow <= 1) return 90
  if (daysFromNow <= 3) return 75
  if (daysFromNow <= 7) return 55
  if (daysFromNow <= 14) return 30
  return 15
}

function computePriority(item: Pick<AgentActionItem,
  "impactScore" | "urgencyScore" | "confidenceScore" | "effortScore">): number {
  return Math.round(
    item.impactScore     * 0.4 +
    item.urgencyScore    * 0.3 +
    item.confidenceScore * 0.2 +
    item.effortScore     * 0.1
  )
}

// ─── Source fetchers ──────────────────────────────────────────────────────

interface FetchInput {
  /** users.id — used by Sprint 5+ tables (portal_event_stream.agent_user_id,
   *  listing_health_interventions.agent_id, lifetime_customer_npv_scores.agent_id) */
  agentUserId: string
  /** agents.id — required for the legacy tables whose agent_id FK targets
   *  the agents table (transactions, listings, contacts). Resolved once
   *  in the composer and passed in. Can be null when user has no agents row. */
  agentsId:    string | null
  brokerageId: string
  limit?:      number
}

async function fetchPortalEventActions(
  supabase: SupabaseClient,
  input: FetchInput,
): Promise<AgentActionItem[]> {
  const { data } = await supabase
    .from("portal_event_stream")
    .select("id, contact_id, transaction_id, listing_id, event_type, agent_copy, agent_action_label, severity, occurred_at")
    .eq("agent_action_required", true)
    .eq("agent_action_status", "open")
    .eq("brokerage_id", input.brokerageId)
    .order("occurred_at", { ascending: false })
    .limit(input.limit ?? 30)

  const rows = (data ?? []) as Array<{
    id: string; contact_id: string; transaction_id: string | null; listing_id: string | null;
    event_type: string; agent_copy: string; agent_action_label: string | null;
    severity: ActionSeverity; occurred_at: string
  }>

  if (rows.length === 0) return []

  const contactNames = await hydrateContactNames(supabase, rows.map((r) => r.contact_id))
  const txnImpacts   = await hydrateTransactionImpacts(supabase, rows.map((r) => r.transaction_id))
  return rows.map((r) => {
    const sev = r.severity
    const ageDays = daysBetween(r.occurred_at)
    const impactDollars = r.transaction_id ? txnImpacts.get(r.transaction_id) ?? null : null
    const item: AgentActionItem = {
      id:                   r.id,
      source:               "portal_event",
      title:                r.agent_action_label ?? r.agent_copy.slice(0, 70),
      detail:               r.agent_action_label ? r.agent_copy : null,
      contactId:            r.contact_id,
      contactName:          contactNames.get(r.contact_id) ?? null,
      transactionId:        r.transaction_id,
      listingId:            r.listing_id,
      impactDollars,
      severity:             sev,
      urgencyScore:         clamp(SEVERITY_URGENCY[sev] * 0.6 + ageToUrgency(ageDays) * 0.4),
      impactScore:          impactDollars != null
                              ? clamp(dollarsToImpact(impactDollars) * (severityImpactMultiplier(sev) + 0.3))
                              : SEVERITY_URGENCY[sev] * 0.6,
      confidenceScore:      90,   // direct kernel event — high confidence
      effortScore:          90,   // 3-way disposition is 1 click
      priority:             0,
      surfacedAt:           r.occurred_at,
      hasInlineDisposition: true,
      resolveHref:          null,
    }
    item.priority = computePriority(item)
    return item
  })
}

async function fetchDealHealthActions(
  supabase: SupabaseClient,
  input: FetchInput,
): Promise<AgentActionItem[]> {
  const { data } = await supabase
    .from("proactive_interventions")
    .select("id, transaction_id, issue_detected, severity, ai_recommendation, created_at")
    .eq("resolved", false)
    .eq("brokerage_id", input.brokerageId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 20)

  const rows = (data ?? []) as Array<{
    id: string; transaction_id: string | null; issue_detected: string;
    severity: ActionSeverity; ai_recommendation: string | null; created_at: string
  }>
  if (rows.length === 0) return []

  // Filter to interventions where the agent owns the transaction.
  // transactions.agent_id FK → agents(id), not users(id) — so we must
  // use agentsId (resolved by getAgentActionQueue) for the equality.
  // When agentsId is null (caller has no agents row) we skip the deal-
  // health source entirely.
  if (!input.agentsId) return []
  const txnIds = rows.map((r) => r.transaction_id).filter(Boolean) as string[]
  const { data: txns } = await supabase
    .from("transactions")
    .select("id, agent_id, contact_id, property_address, estimated_commission, commission_amount")
    .in("id", txnIds)
    .eq("agent_id", input.agentsId)

  const txnInfo = new Map<string, { contactId: string | null; address: string | null; impact: number | null }>()
  for (const t of (txns ?? []) as Array<{ id: string; contact_id: string | null; property_address: string | null; estimated_commission: number | null; commission_amount: number | null }>) {
    txnInfo.set(t.id, {
      contactId: t.contact_id,
      address:   t.property_address,
      impact:    Number(t.commission_amount ?? t.estimated_commission ?? 0) || null,
    })
  }
  const contactIds = Array.from(txnInfo.values()).map((v) => v.contactId).filter(Boolean) as string[]
  const contactNames = await hydrateContactNames(supabase, contactIds)

  const out: AgentActionItem[] = []
  for (const r of rows) {
    if (!r.transaction_id || !txnInfo.has(r.transaction_id)) continue
    const info = txnInfo.get(r.transaction_id)!
    const sev = r.severity
    const ageDays = daysBetween(r.created_at)
    const impactDollars = info.impact ?? 0
    // For at-risk deals the impact is what's PROTECTED — full commission ×
    // severity-failure-likelihood. Higher severity = more $ literally at risk.
    const atRiskGci = impactDollars * severityImpactMultiplier(sev)
    const item: AgentActionItem = {
      id:                   r.id,
      source:               "deal_health",
      title:                r.issue_detected.slice(0, 80),
      detail:               r.ai_recommendation,
      contactId:            info.contactId,
      contactName:          info.contactId ? (contactNames.get(info.contactId) ?? null) : null,
      transactionId:        r.transaction_id,
      listingId:            null,
      impactDollars:        Math.round(atRiskGci),
      severity:             sev,
      urgencyScore:         clamp(SEVERITY_URGENCY[sev] * 0.7 + ageToUrgency(ageDays) * 0.3),
      impactScore:          clamp(dollarsToImpact(atRiskGci) * (severityImpactMultiplier(sev) + 0.3)),
      confidenceScore:      85,
      effortScore:          60,    // open the deal-health card, decide
      priority:             0,
      surfacedAt:           r.created_at,
      hasInlineDisposition: false,
      resolveHref:          `/dashboard/transactions/${r.transaction_id}`,
    }
    item.priority = computePriority(item)
    out.push(item)
  }
  return out
}

async function fetchListingHealthActions(
  supabase: SupabaseClient,
  input: FetchInput,
): Promise<AgentActionItem[]> {
  const { data } = await supabase
    .from("listing_health_interventions")
    .select("id, listing_id, agent_id, issue_detected, severity, ai_recommendation, category, created_at")
    .eq("resolved", false)
    .eq("agent_id", input.agentUserId)
    .eq("brokerage_id", input.brokerageId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 15)

  const rows = (data ?? []) as Array<{
    id: string; listing_id: string | null; issue_detected: string;
    severity: ActionSeverity; ai_recommendation: string | null;
    category: string | null; created_at: string
  }>
  if (rows.length === 0) return []

  const listingIds = rows.map((r) => r.listing_id).filter(Boolean) as string[]
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, list_price")
    .in("id", listingIds)
  const listingInfo = new Map<string, { address: string | null; impact: number | null }>()
  for (const l of (listings ?? []) as Array<{ id: string; address: string | null; list_price: number | null }>) {
    listingInfo.set(l.id, {
      address: l.address,
      impact:  l.list_price ? Math.round(Number(l.list_price) * 0.025) : null, // listing-side GCI proxy
    })
  }

  return rows.flatMap((r) => {
    if (!r.listing_id) return []
    const info = listingInfo.get(r.listing_id)
    const sev = r.severity
    const ageDays = daysBetween(r.created_at)
    const atRiskGci = (info?.impact ?? 0) * severityImpactMultiplier(sev)
    const item: AgentActionItem = {
      id:                   r.id,
      source:               "listing_health",
      title:                r.issue_detected.slice(0, 80),
      detail:               r.ai_recommendation,
      contactId:            null,
      contactName:          info?.address ?? null,
      transactionId:        null,
      listingId:            r.listing_id,
      impactDollars:        atRiskGci ? Math.round(atRiskGci) : null,
      severity:             sev,
      urgencyScore:         clamp(SEVERITY_URGENCY[sev] * 0.6 + ageToUrgency(ageDays) * 0.4),
      impactScore:          atRiskGci > 0
                              ? clamp(dollarsToImpact(atRiskGci) * (severityImpactMultiplier(sev) + 0.3))
                              : SEVERITY_URGENCY[sev] * 0.5,
      confidenceScore:      75,
      effortScore:          55,
      priority:             0,
      surfacedAt:           r.created_at,
      hasInlineDisposition: false,
      resolveHref:          `/dashboard/listings/${r.listing_id}/lifecycle`,
    }
    item.priority = computePriority(item)
    return [item]
  })
}

async function fetchNpvDueActions(
  supabase: SupabaseClient,
  input: FetchInput,
): Promise<AgentActionItem[]> {
  // NPV scores aren't deduped per contact in the source table — pull the
  // newest row per contact filtered to "due within 7 days" for this agent.
  const sevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  const { data } = await supabase
    .from("lifetime_customer_npv_scores")
    .select("id, contact_id, agent_id, npv_score, npv_dollars, tier, recommended_action, recommended_cadence, next_touchpoint_due, computed_at")
    .eq("agent_id", input.agentUserId)
    .eq("brokerage_id", input.brokerageId)
    .not("next_touchpoint_due", "is", null)
    .lte("next_touchpoint_due", sevenDays)
    .order("computed_at", { ascending: false })
    .limit(200)

  const rows = (data ?? []) as Array<{
    id: string; contact_id: string; npv_score: number; npv_dollars: number;
    tier: string; recommended_action: string | null; recommended_cadence: string | null;
    next_touchpoint_due: string; computed_at: string
  }>
  if (rows.length === 0) return []

  // Dedupe to latest snapshot per contact
  const latestByContact = new Map<string, typeof rows[number]>()
  for (const r of rows) {
    if (!latestByContact.has(r.contact_id)) latestByContact.set(r.contact_id, r)
  }
  const deduped = Array.from(latestByContact.values()).slice(0, input.limit ?? 15)

  const contactNames = await hydrateContactNames(supabase, deduped.map((r) => r.contact_id))

  return deduped.map((r) => {
    const dueDate = r.next_touchpoint_due
    const daysUntil = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86_400_000)
    const tier = r.tier as "platinum" | "gold" | "silver" | "bronze" | "dormant"
    const severity: ActionSeverity =
      daysUntil < -7 ? "high" : daysUntil < 0 ? "medium" : daysUntil <= 1 ? "high" : "low"

    const impactDollars = Math.round(Number(r.npv_dollars ?? 0))
    const item: AgentActionItem = {
      id:                   r.id,
      source:               "lifetime_npv",
      title:                `Touch ${contactNames.get(r.contact_id) ?? "lifetime customer"} (${tier})`,
      detail:               r.recommended_action,
      contactId:            r.contact_id,
      contactName:          contactNames.get(r.contact_id) ?? null,
      transactionId:        null,
      listingId:            null,
      impactDollars,
      severity,
      urgencyScore:         dueInUrgency(daysUntil),
      impactScore:          clamp(dollarsToImpact(impactDollars) + (tier === "platinum" ? 20 : tier === "gold" ? 10 : 0)),
      confidenceScore:      70,
      effortScore:          85,  // a touchpoint is easy
      priority:             0,
      surfacedAt:           r.computed_at,
      hasInlineDisposition: false,
      resolveHref:          `/crm?contact=${r.contact_id}`,
    }
    item.priority = computePriority(item)
    return item
  })
}

// ─── Hydration helpers ────────────────────────────────────────────────────

async function hydrateContactNames(
  supabase: SupabaseClient,
  contactIds: (string | null)[],
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(contactIds.filter(Boolean) as string[]))
  if (ids.length === 0) return new Map()
  const { data } = await supabase
    .from("contacts")
    .select("id, first_name, last_name")
    .in("id", ids)
  const out = new Map<string, string>()
  for (const c of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
    const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim()
    if (name) out.set(c.id, name)
  }
  return out
}

async function hydrateTransactionImpacts(
  supabase: SupabaseClient,
  txnIds: (string | null)[],
): Promise<Map<string, number>> {
  const ids = Array.from(new Set(txnIds.filter(Boolean) as string[]))
  if (ids.length === 0) return new Map()
  const { data } = await supabase
    .from("transactions")
    .select("id, estimated_commission, commission_amount")
    .in("id", ids)
  const out = new Map<string, number>()
  for (const t of (data ?? []) as Array<{ id: string; estimated_commission: number | null; commission_amount: number | null }>) {
    const v = Number(t.commission_amount ?? t.estimated_commission ?? 0)
    if (v > 0) out.set(t.id, v)
  }
  return out
}

// ─── Public composer ──────────────────────────────────────────────────────

export interface ComposeInput {
  /** users.id of the calling agent. */
  agentUserId: string
  /** agents.id (resolved by caller from users.id → agents.user_id).
   *  Required to query transactions/listings (FKs target agents.id, not
   *  users.id). null = no agents row, deal-health source disabled. */
  agentsId:    string | null
  brokerageId: string
  /** Hard cap on the returned queue. Default 12. */
  limit?:      number
}

export interface ComposedQueue {
  items:           AgentActionItem[]
  totalImpactSum:  number    // Σ impactDollars across all items
  countBySource:   Record<ActionSource, number>
  generatedAt:     string
}

export async function composeAgentActionQueue(
  supabase: SupabaseClient,
  input: ComposeInput,
): Promise<ComposedQueue> {
  const limit = input.limit ?? 12

  // Pull all 4 sources in parallel. agentsId only needed by deal-health
  // (transactions.agent_id → agents.id FK); other sources use users.id
  // directly because they're Sprint 5+ tables with users.id FK targets.
  const baseInput = {
    agentUserId: input.agentUserId,
    agentsId:    input.agentsId,
    brokerageId: input.brokerageId,
  }
  const [portal, deal, listing, npv] = await Promise.all([
    fetchPortalEventActions(supabase, baseInput),
    fetchDealHealthActions(supabase,   baseInput),
    fetchListingHealthActions(supabase, baseInput),
    fetchNpvDueActions(supabase,       baseInput),
  ])

  // Union + sort by priority desc, cap to limit
  const allItems = [...portal, ...deal, ...listing, ...npv]
  allItems.sort((a, b) => b.priority - a.priority)
  const items = allItems.slice(0, limit)

  const totalImpactSum = items.reduce((s, i) => s + (i.impactDollars ?? 0), 0)
  const countBySource: Record<ActionSource, number> = {
    portal_event:   portal.length,
    deal_health:    deal.length,
    listing_health: listing.length,
    lifetime_npv:   npv.length,
  }

  return {
    items,
    totalImpactSum,
    countBySource,
    generatedAt: new Date().toISOString(),
  }
}
