/**
 * lib/managers/deliberation.ts
 *
 * MANAGER DELIBERATION (round 35 — owner: "the managers should also argue a solution
 * and work through the reason why that solution is the best for the situation").
 * Cross-manager teamwork made VISIBLE and ARGUED: when a governed cross-manager
 * referral travels a collaboration domain the registry marks DELIBERATIVE
 * (MANAGER_COLLABORATIONS[*].deliberate — pricing disputes, budget rebalances,
 * compliance-vs-speed tradeoffs), the co-managers of that domain each ARGUE a
 * structured position:
 *
 *   { proposal, reasoning, risks[], evidence[] }
 *
 * Every position is GROUNDED: a per-manager fact loader reads the REAL rows that
 * manager stewards (listings for the concierge, saved-property demand for the
 * Shopping Agent, the commission pipeline for Finance, the compliance ledger for the
 * Officer, campaign CPL for Ads, …) and the model may cite ONLY those field-level
 * citations — anything it invents is filtered out (filterEvidenceToCitations), so an
 * argument can never stand on a fact that isn't in the tenant's own tables.
 *
 * THE REBUTTAL ROUND (round 36 — full build-out): when the argued positions directly
 * conflict (distinct proposals for the same situation), each manager gets EXACTLY ONE
 * bounded rebuttal — a cited pushback on the others' positions, grounded through the
 * SAME guard (rebuttal evidence is filtered to that manager's own real citations).
 * One round, never more (the code has no loop to escalate); an engine without a rebut
 * capability simply holds no rebuttal round — honestly recorded, never faked.
 *
 * A RESOLUTION pass then compares the positions (rebuttals included) against the
 * situation's facts, picks the winner WITH the stated why-this-beats-the-others, and
 * records honest DISSENT when a losing position had merit — the same
 * visible-disagreement idiom as the peer-review dissent rail
 * (lib/kernel/manager-dissent.ts), extended from one reviewer's objections to a full
 * argued debate.
 *
 * THE PRINCIPAL'S CALL (round 36): the human supervising principal can OVERRIDE the
 * argued winner with a stated reason — recorded on the SAME payload record
 * (applyPrincipalOverride / recordPrincipalOverride, persisted via sentinelWrite),
 * never a parallel ledger. The argued record stays intact underneath: the override
 * names its winner + reason + who + when, and effectiveWinner() resolves what
 * actually governs. Teamwork metrics count the overrides.
 *
 * LEDGER: the deliberation persists onto the EXISTING referral ledger — the
 * cross_manager_referral row on manager_signals itself (payload.deliberation), one
 * lifecycle per referral: open → deliberated → consumed-with-action. No new table.
 * The write rides sentinelWrite (a lost deliberation would silently hide the argument
 * from the governance surface).
 *
 * HONEST FALLBACK: positions ride the AI gateway (generateObjectRouted — routing,
 * fallback model, billing). If the gateway is unreachable the deliberation records
 * status 'unavailable' with the reason — NEVER canned arguments; the referral still
 * reaches the principals, just without argued positions.
 *
 * NOT server-only (simulator-driven, like the rest of the kernel/manager modules).
 */

import { createServiceClient } from "@/lib/supabase/service"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import {
  MANAGERS, MANAGER_COLLABORATIONS, type ManagerKey, type CollaborationDomain,
} from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** The honest refusal marker — a deliberation with an unreachable model records this. */
export const DELIBERATION_UNAVAILABLE = "deliberation unavailable"

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** One manager's grounding: real facts from the tables it stewards, each backed by a
 *  field-level citation string ("table.column=value (table.id=…)"). */
export interface ManagerBrief {
  manager: ManagerKey
  /** Human-readable domain facts (empty = honestly nothing in the window). */
  facts: string[]
  /** Field-level citations the position's evidence[] must be drawn from. */
  citations: string[]
}

/** One manager's bounded rebuttal of the OTHERS' positions (round 36) — cited from
 *  its OWN loader's real citations, same grounding guard as the position itself. */
export interface PositionRebuttal {
  /** The factual pushback on the other positions (empty note = no rebuttal held). */
  note: string
  /** Field-level citations — filtered to the rebutting manager's REAL citations. */
  evidence: string[]
}

/** One manager's argued position. */
export interface ManagerPosition {
  manager: ManagerKey
  proposal: string
  reasoning: string
  risks: string[]
  /** Field-level citations — filtered to the loader's REAL citations, never invented. */
  evidence: string[]
  /** The ONE bounded rebuttal round's cited pushback (absent/null = none argued). */
  rebuttal?: PositionRebuttal | null
}

export interface DeliberationDissent {
  manager: ManagerKey
  /** Why the losing position had merit — honest, on the record. */
  note: string
}

/** THE PRINCIPAL'S CALL (round 36) — the human's recorded override of the argued
 *  winner, on the SAME payload record. The argued record stays intact underneath. */
export interface DeliberationOverride {
  /** The position the principal picked instead — must be one that actually argued. */
  winner: ManagerKey
  /** The principal's stated reason — required; an unexplained override is refused. */
  reason: string
  /** users.id of the principal who made the call (null when unknown). */
  by: string | null
  at: string
}

export interface DeliberationRecord {
  /** MANAGER_COLLABORATIONS key the argument ran on. */
  domain: string
  status: "resolved" | "unavailable"
  positions: ManagerPosition[]
  winner: ManagerKey | null
  /** The stated why-this-beats-the-others (null when unavailable). */
  resolution: string | null
  dissent: DeliberationDissent | null
  /** Honest reason when status === 'unavailable'. */
  unavailableReason: string | null
  deliberatedAt: string
  /** True when the ONE bounded rebuttal round ran (positions directly conflicted and
   *  the engine could rebut). Absent on pre-round-36 records — treated as false. */
  rebuttalHeld?: boolean
  /** The principal's recorded call (round 36) — null/absent until a human overrides. */
  override?: DeliberationOverride | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (simulator-tested)
// ─────────────────────────────────────────────────────────────────────────────

/** PURE: does this collaboration domain escalate referrals to a full deliberation? */
export function isDeliberativeDomain(domainKey: string | null | undefined): boolean {
  return !!domainKey && MANAGER_COLLABORATIONS[domainKey]?.deliberate === true
}

/** Every deliberative collaboration domain (governance surface / sim). PURE. */
export function deliberativeDomains(): CollaborationDomain[] {
  return Object.values(MANAGER_COLLABORATIONS).filter((d) => d.deliberate === true)
}

/**
 * PURE — the GROUNDING GUARD: a position's evidence may only contain the loader's
 * REAL citations. Model-claimed evidence that matches no citation is dropped; if
 * nothing survives, the position falls back to the first real citations (still the
 * tenant's own data) — an argument can never stand on an invented fact.
 */
export function filterEvidenceToCitations(evidence: string[], citations: string[]): string[] {
  const real = new Set(citations.map((c) => c.trim()))
  const kept = evidence.map((e) => e.trim()).filter((e) => real.has(e))
  if (kept.length > 0) return Array.from(new Set(kept)).slice(0, 6)
  return citations.slice(0, 3)
}

/** PURE: a resolution winner must be one of the managers who actually argued. */
export function validResolutionWinner(winner: string, positions: ManagerPosition[]): winner is ManagerKey {
  return winner in MANAGERS && positions.some((p) => p.manager === winner)
}

/**
 * PURE: do the argued positions DIRECTLY CONFLICT — i.e. is there anything to rebut?
 * Two or more managers proposing materially different solutions is a direct conflict;
 * unanimous (or single-position) deliberations hold no rebuttal round — there is
 * nothing to argue against.
 */
export function positionsDirectlyConflict(positions: ManagerPosition[]): boolean {
  if (positions.length < 2) return false
  const normalized = new Set(positions.map((p) => p.proposal.trim().toLowerCase().replace(/\s+/g, " ")))
  return normalized.size > 1
}

/**
 * PURE — THE PRINCIPAL'S CALL: apply a human override onto a finished deliberation.
 * Refused honestly when the record isn't a resolved argument, when the named winner
 * never argued, or when no reason is stated (an unexplained override is not
 * governance). Re-overriding replaces the previous call (the latest human decision
 * is the decision of record). Returns a NEW record — never mutates the input.
 */
export function applyPrincipalOverride(
  record: DeliberationRecord,
  call: { winner: string; reason: string; by?: string | null; now?: Date },
): { ok: true; record: DeliberationRecord } | { ok: false; error: string } {
  if (record.status !== "resolved" || !record.winner) {
    return { ok: false, error: "only a resolved deliberation can take a principal's call — this one recorded no argued positions" }
  }
  const reason = call.reason.trim()
  if (!reason) return { ok: false, error: "a principal's call requires a stated reason — an unexplained override is refused" }
  if (!validResolutionWinner(call.winner, record.positions)) {
    return { ok: false, error: `'${call.winner}' never argued a position in this deliberation — the call must pick one of the argued positions` }
  }
  return {
    ok: true,
    record: {
      ...record,
      override: {
        winner: call.winner,
        reason: reason.slice(0, 500),
        by: call.by ?? null,
        at: (call.now ?? new Date()).toISOString(),
      },
    },
  }
}

/** PURE: what actually governs — the principal's call when recorded, else the argued winner. */
export function effectiveWinner(record: DeliberationRecord): ManagerKey | null {
  return record.override?.winner ?? record.winner
}

/** PURE: the consumed-action / feed one-liner for a finished deliberation. */
export function summarizeDeliberation(record: DeliberationRecord): string {
  const domainLabel = MANAGER_COLLABORATIONS[record.domain]?.label ?? record.domain
  if (record.status === "unavailable" || !record.winner || !record.resolution) {
    return `${DELIBERATION_UNAVAILABLE} for '${domainLabel}' — ${record.unavailableReason ?? "the model could not be reached"}; the referral was surfaced to the principals without argued positions (no canned arguments were substituted)`
  }
  const winnerLabel = MANAGERS[record.winner]?.label ?? record.winner
  const others = record.positions.filter((p) => p.manager !== record.winner).map((p) => MANAGERS[p.manager]?.label ?? p.manager)
  const rebuttals = record.positions.filter((p) => p.rebuttal?.note).length
  let line = `deliberated '${domainLabel}' — ${record.positions.length} positions argued` +
    (others.length > 0 ? ` (${[winnerLabel, ...others].join(" vs ")})` : "") +
    (record.rebuttalHeld ? `, one rebuttal round held (${rebuttals} cited rebuttal${rebuttals === 1 ? "" : "s"})` : "") +
    `; ${winnerLabel}'s proposal won: ${record.resolution}`
  if (record.dissent) {
    const dLabel = MANAGERS[record.dissent.manager]?.label ?? record.dissent.manager
    line += ` — DISSENT on the record from ${dLabel}: ${record.dissent.note}`
  }
  if (record.override) {
    const oLabel = MANAGERS[record.override.winner]?.label ?? record.override.winner
    line += ` — PRINCIPAL'S CALL: the human overrode the argued winner, picking ${oLabel} (${record.override.reason})`
  }
  return line.slice(0, 900)
}

/** PURE: read a persisted deliberation back off a referral's payload (null = none). */
export function parseDeliberation(payload: Record<string, unknown> | null | undefined): DeliberationRecord | null {
  const d = (payload ?? {})["deliberation"] as Record<string, unknown> | undefined
  if (!d || typeof d !== "object") return null
  if (d.status !== "resolved" && d.status !== "unavailable") return null
  if (!Array.isArray(d.positions) || typeof d.domain !== "string") return null
  return d as unknown as DeliberationRecord
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-MANAGER FACT LOADERS — each position is fed the ACTUAL data its manager
// stewards, through the same tables/pure-math the existing rails already read
// (approval-sla, commission-forecaster, compliance-ledger, ad-outcome-loop shapes).
// Read-only, brokerage-scoped, bounded. An empty tenant yields honest empty facts.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReferralContext {
  brokerageId: string
  ask: string
  entityType: string | null
  entityId: string | null
}

type FactLoader = (svc: Svc, ctx: ReferralContext) => Promise<{ facts: string[]; citations: string[] }>

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`

/** Seller side: the listing(s) in dispute — price, market time, showings, walkaway. */
const loadListingConciergeFacts: FactLoader = async (svc, ctx) => {
  const base = () => svc.from("listings")
    .select("id, address, list_price, status, showing_count, listing_date, last_price_change_at, seller_walkaway_price")
    .eq("brokerage_id", ctx.brokerageId).is("deleted_at", null)
  const { data } = ctx.entityType === "listing" && ctx.entityId
    ? await base().eq("id", ctx.entityId)
    : await base().in("status", ["active", "coming_soon", "pending"]).order("created_at", { ascending: false }).limit(3)
  const facts: string[] = [], citations: string[] = []
  for (const l of (data ?? []) as any[]) {
    const dom = l.listing_date ? Math.max(0, Math.round((Date.now() - new Date(l.listing_date).getTime()) / 86_400_000)) : null
    facts.push(`${l.address ?? "listing"} — list price ${l.list_price != null ? usd(Number(l.list_price)) : "unset"}, status ${l.status}${dom !== null ? `, ${dom} days on market` : ""}${l.showing_count != null ? `, ${l.showing_count} showings` : ""}${l.last_price_change_at ? `, last price change ${String(l.last_price_change_at).slice(0, 10)}` : ""}`)
    if (l.list_price != null) citations.push(`listings.list_price=${l.list_price} (listings.id=${l.id})`)
    if (l.showing_count != null) citations.push(`listings.showing_count=${l.showing_count} (listings.id=${l.id})`)
    if (dom !== null) citations.push(`listings.listing_date=${String(l.listing_date).slice(0, 10)} (listings.id=${l.id})`)
    if (l.seller_walkaway_price != null) citations.push(`listings.seller_walkaway_price=${l.seller_walkaway_price} (listings.id=${l.id})`)
  }
  return { facts, citations }
}

/** Buyer side: the demand evidence — saves, active alerts, live offers. */
const loadShoppingAgentFacts: FactLoader = async (svc, ctx) => {
  const listingScoped = ctx.entityType === "listing" && ctx.entityId
  const [{ data: saves }, { count: alerts }, { data: offers }] = await Promise.all([
    (listingScoped
      ? svc.from("saved_properties").select("id, interest_level").eq("brokerage_id", ctx.brokerageId).eq("listing_id", ctx.entityId!)
      : svc.from("saved_properties").select("id, interest_level").eq("brokerage_id", ctx.brokerageId)
    ).limit(500),
    svc.from("property_alerts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", ctx.brokerageId).eq("is_active", true),
    (listingScoped
      ? svc.from("offers").select("id, offer_price, status").eq("brokerage_id", ctx.brokerageId).eq("listing_id", ctx.entityId!)
      : svc.from("offers").select("id, offer_price, status").eq("brokerage_id", ctx.brokerageId)
    ).in("status", ["pending", "submitted", "countered"]).limit(50),
  ])
  const facts: string[] = [], citations: string[] = []
  const saveRows = (saves ?? []) as any[]
  const hot = saveRows.filter((s) => s.interest_level === "high" || s.interest_level === "hot").length
  if (saveRows.length > 0) {
    facts.push(`${saveRows.length} buyer save${saveRows.length === 1 ? "" : "s"}${listingScoped ? " on this listing" : ""}${hot > 0 ? ` (${hot} high-interest)` : ""}`)
    citations.push(`saved_properties.count=${saveRows.length}${listingScoped ? ` (saved_properties.listing_id=${ctx.entityId})` : ` (saved_properties.brokerage_id=${ctx.brokerageId})`}`)
  }
  if ((alerts ?? 0) > 0) {
    facts.push(`${alerts} active buyer property alert${alerts === 1 ? "" : "s"} watching the market`)
    citations.push(`property_alerts.is_active=true count=${alerts} (property_alerts.brokerage_id=${ctx.brokerageId})`)
  }
  const offerRows = (offers ?? []) as any[]
  if (offerRows.length > 0) {
    const top = Math.max(...offerRows.map((o) => Number(o.offer_price) || 0))
    facts.push(`${offerRows.length} live offer${offerRows.length === 1 ? "" : "s"}${top > 0 ? `, best ${usd(top)}` : ""}`)
    for (const o of offerRows.slice(0, 3)) {
      if (o.offer_price != null) citations.push(`offers.offer_price=${o.offer_price} (offers.id=${o.id})`)
    }
  }
  return { facts, citations }
}

/** Post-acceptance: the deal(s) in flight — stage, deadlines, health. */
const loadDealCoordinatorFacts: FactLoader = async (svc, ctx) => {
  const base = () => svc.from("transactions")
    .select("id, deal_name, status, stage, close_date, estimated_close_date, inspection_deadline, financing_deadline, health_status, purchase_price")
    .eq("brokerage_id", ctx.brokerageId).is("deleted_at", null)
  const { data } = ctx.entityType === "transaction" && ctx.entityId
    ? await base().eq("id", ctx.entityId)
    : await base().not("status", "in", '("closed","cancelled")').order("created_at", { ascending: false }).limit(3)
  const facts: string[] = [], citations: string[] = []
  for (const t of (data ?? []) as any[]) {
    const close = t.close_date ?? t.estimated_close_date
    facts.push(`${t.deal_name ?? "deal"} — status ${t.status}${t.stage ? `, stage ${t.stage}` : ""}${close ? `, closing ${String(close).slice(0, 10)}` : ""}${t.health_status ? `, health ${t.health_status}` : ""}`)
    citations.push(`transactions.status=${t.status} (transactions.id=${t.id})`)
    if (close) citations.push(`transactions.${t.close_date ? "close_date" : "estimated_close_date"}=${String(close).slice(0, 10)} (transactions.id=${t.id})`)
    if (t.health_status) citations.push(`transactions.health_status=${t.health_status} (transactions.id=${t.id})`)
    if (t.financing_deadline) citations.push(`transactions.financing_deadline=${String(t.financing_deadline).slice(0, 10)} (transactions.id=${t.id})`)
  }
  return { facts, citations }
}

/** Back-office money: the weighted pipeline (the forecaster's OWN pure math) + unpaid commissions. */
const loadFinanceManagerFacts: FactLoader = async (svc, ctx) => {
  const { toPipeline, forecastGci, dealCommission } = await import("@/lib/kernel/commission-forecaster")
  // Grounded ONLY in tables with live writers: transactions carries the pipeline.
  // (commission_records has no runtime writer — the writerless-read sweep rejects
  // grounding an argument in a dead table, so unpaid-commission detail is omitted
  // until that ledger earns a real writer.)
  const { data: open } = await svc.from("transactions")
    .select("id, deal_name, property_address, estimated_commission, commission_amount, commission_percentage, purchase_price, win_probability, stage, estimated_close_date, close_date")
    .eq("brokerage_id", ctx.brokerageId).in("status", [...TRANSACTION_STATUSES_OPEN]).is("deleted_at", null).limit(200)
  const facts: string[] = [], citations: string[] = []
  const openRows = (open ?? []) as any[]
  if (openRows.length > 0) {
    const weighted = forecastGci(0, toPipeline(openRows), new Date()).weightedPipeline
    facts.push(`${openRows.length} open deal${openRows.length === 1 ? "" : "s"} carrying ${usd(weighted)} probability-weighted gross commission`)
    citations.push(`transactions.open_count=${openRows.length} weighted_gci=${Math.round(weighted)} (transactions.brokerage_id=${ctx.brokerageId})`)
    const scoped = ctx.entityType === "transaction" && ctx.entityId ? openRows.find((t) => t.id === ctx.entityId) : null
    if (scoped) citations.push(`transactions.estimated_commission=${Math.round(dealCommission(scoped))} (transactions.id=${scoped.id})`)
  }
  // COMMISSION ECONOMICS (round 36 — grounds the recruiting-offer argument): the live
  // split/cap policy of record — agent_commission_profiles (written at provisioning)
  // and agent_cap_tracking (advanced by the commission engine on every disbursement).
  const [{ data: profiles }, { data: caps }] = await Promise.all([
    svc.from("agent_commission_profiles").select("agent_id, split_percent, cap_amount")
      .eq("brokerage_id", ctx.brokerageId).eq("is_active", true).limit(200),
    svc.from("agent_cap_tracking").select("agent_id, cap_amount, cap_paid_to_date, is_capped")
      .eq("brokerage_id", ctx.brokerageId).limit(200),
  ])
  const profRows = (profiles ?? []) as any[]
  const withSplit = profRows.filter((p) => p.split_percent != null)
  if (withSplit.length > 0) {
    const avgSplit = Math.round((withSplit.reduce((s, p) => s + Number(p.split_percent), 0) / withSplit.length) * 10) / 10
    facts.push(`${profRows.length} active commission profile${profRows.length === 1 ? "" : "s"} — average split ${avgSplit}% to the agent`)
    citations.push(`agent_commission_profiles.avg_split_percent=${avgSplit} count=${profRows.length} (agent_commission_profiles.brokerage_id=${ctx.brokerageId})`)
  }
  const capRows = (caps ?? []) as any[]
  if (capRows.length > 0) {
    const capped = capRows.filter((c) => c.is_capped === true).length
    facts.push(`${capRows.length} agent${capRows.length === 1 ? "" : "s"} on cap tracking${capped > 0 ? ` — ${capped} already capped this anniversary year` : ""}`)
    citations.push(`agent_cap_tracking.count=${capRows.length} capped=${capped} (agent_cap_tracking.brokerage_id=${ctx.brokerageId})`)
  }
  return { facts, citations }
}

/** Regulatory exposure: open compliance flags + the pre-flight ledger's last 30 days. */
const loadComplianceOfficerFacts: FactLoader = async (svc, ctx) => {
  const { PREFLIGHT_GATE, summarizeComplianceLedger } = await import("@/lib/kernel/compliance-ledger")
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const [{ data: flags }, { data: events }] = await Promise.all([
    svc.from("compliance_flags").select("id, violation_type, severity, status")
      .eq("brokerage_id", ctx.brokerageId).neq("status", "resolved").limit(100),
    svc.from("compliance_events").select("severity, allowed, details")
      .eq("brokerage_id", ctx.brokerageId).eq("gate_name", PREFLIGHT_GATE).gte("created_at", since).limit(2000),
  ])
  const facts: string[] = [], citations: string[] = []
  const flagRows = (flags ?? []) as any[]
  if (flagRows.length > 0) {
    const high = flagRows.filter((f) => f.severity === "high" || f.severity === "critical").length
    facts.push(`${flagRows.length} open compliance flag${flagRows.length === 1 ? "" : "s"}${high > 0 ? ` (${high} high/critical)` : ""}`)
    for (const f of flagRows.slice(0, 3)) citations.push(`compliance_flags.violation_type=${f.violation_type} severity=${f.severity} (compliance_flags.id=${f.id})`)
  }
  const led = summarizeComplianceLedger((events ?? []) as any[])
  if (led.total > 0) {
    facts.push(`${led.total} outbound decisions pre-flighted in 30d — ${led.advisory} advisory, ${led.blocked} blocked`)
    citations.push(`compliance_events.gate_name=compliance_preflight total=${led.total} blocked=${led.blocked} (compliance_events.brokerage_id=${ctx.brokerageId})`)
  }
  return { facts, citations }
}

/** Organic side: what the brand's own posts actually did in the last 30 days. */
const loadMarketingAgentFacts: FactLoader = async (svc, ctx) => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await svc.from("social_posts")
    .select("id, platform, post_type, status, approval_status, published_at, engagement_data")
    .eq("brokerage_id", ctx.brokerageId).gte("created_at", since).limit(300)
  const rows = (data ?? []) as any[]
  const facts: string[] = [], citations: string[] = []
  const published = rows.filter((r) => r.status === "published" || r.published_at)
  if (published.length > 0) {
    const byPlatform = new Map<string, number>()
    for (const p of published) byPlatform.set(p.platform ?? "unknown", (byPlatform.get(p.platform ?? "unknown") ?? 0) + 1)
    const top = [...byPlatform.entries()].sort((a, b) => b[1] - a[1])[0]
    facts.push(`${published.length} organic post${published.length === 1 ? "" : "s"} published in 30d${top ? `, most on ${top[0]} (${top[1]})` : ""}`)
    citations.push(`social_posts.published_count_30d=${published.length} (social_posts.brokerage_id=${ctx.brokerageId})`)
    const withEng = published.find((p) => p.engagement_data && Object.keys(p.engagement_data as object).length > 0)
    if (withEng) citations.push(`social_posts.engagement_data=${JSON.stringify(withEng.engagement_data).slice(0, 120)} (social_posts.id=${withEng.id})`)
  }
  const pending = rows.filter((r) => r.approval_status === "pending" || r.status === "pending_approval").length
  if (pending > 0) {
    facts.push(`${pending} post${pending === 1 ? "" : "s"} waiting in the approval queue`)
    citations.push(`social_posts.pending_count=${pending} (social_posts.brokerage_id=${ctx.brokerageId})`)
  }
  return { facts, citations }
}

/** Paid side: live campaign spend / leads / CPL — the ad-outcome-loop's own shape. */
const loadAdsManagerFacts: FactLoader = async (svc, ctx) => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: campaigns } = await svc.from("ad_campaigns")
    .select("id, campaign_name, status, daily_budget")
    .eq("brokerage_id", ctx.brokerageId).in("status", ["live", "active"]).limit(10)
  const facts: string[] = [], citations: string[] = []
  for (const c of (campaigns ?? []) as any[]) {
    const { data: perf } = await svc.from("ad_performance")
      .select("spend, leads").eq("ad_campaign_id", c.id).gte("captured_at", since).limit(200)
    const spend = ((perf ?? []) as any[]).reduce((s, p) => s + (Number(p.spend) || 0), 0)
    const leads = ((perf ?? []) as any[]).reduce((s, p) => s + (Number(p.leads) || 0), 0)
    const cpl = leads > 0 ? spend / leads : null
    facts.push(`"${c.campaign_name ?? "campaign"}" (${c.status}) — ${usd(spend)} spend, ${leads} lead${leads === 1 ? "" : "s"} in 30d${cpl !== null ? `, ${usd(cpl)}/lead` : spend > 0 ? ", zero leads" : ""}`)
    citations.push(`ad_performance.spend_30d=${Math.round(spend)} leads=${leads} (ad_campaigns.id=${c.id})`)
    if (c.daily_budget != null) citations.push(`ad_campaigns.daily_budget=${c.daily_budget} (ad_campaigns.id=${c.id})`)
  }
  return { facts, citations }
}

/** Operations: the approval-queue SLA telemetry (the canonical aggregator). */
const loadCronManagerFacts: FactLoader = async (svc, ctx) => {
  const { loadApprovalSla, slaBreaches } = await import("@/lib/kernel/approval-sla")
  const rows = await loadApprovalSla(ctx.brokerageId, null)
  const breaches = slaBreaches(rows)
  const facts: string[] = [], citations: string[] = []
  for (const b of breaches.slice(0, 5)) {
    facts.push(`${b.label}: ${b.breached} past the SLA (oldest ${b.oldestHours}h, ${b.pending} pending)`)
    citations.push(`approval_sla.kind=${b.kind} breached=${b.breached} oldest_hours=${b.oldestHours} (owner=${b.owner})`)
  }
  return { facts, citations }
}

/** Lead-side conversion evidence: fresh leads + what the ISA's qualification ledger
 *  actually says about them — the AI ISA's seat in the lead-quality budget argument.
 *  Round 41: when the dispute names a CONTACT (the sequence_touch_cadence edge), the
 *  ISA also argues from its OWN outreach ledger for that contact (isa_outreach_log) —
 *  the cadence evidence that consumed the attention window. */
const loadAiIsaFacts: FactLoader = async (svc, ctx) => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  // ── Contact-cadence seat (sequence_touch_cadence, round 41) ──
  if (ctx.entityType === "contact" && ctx.entityId) {
    const facts: string[] = [], citations: string[] = []
    const { data: touches } = await svc.from("isa_outreach_log")
      .select("id, channel, status, replied_at")
      .eq("brokerage_id", ctx.brokerageId).eq("contact_id", ctx.entityId)
      .gte("created_at", since).limit(200)
    const rows = (touches ?? []) as any[]
    if (rows.length > 0) {
      const byChannel = new Map<string, number>()
      for (const t of rows) byChannel.set(t.channel ?? "unknown", (byChannel.get(t.channel ?? "unknown") ?? 0) + 1)
      const replied = rows.filter((t) => t.replied_at != null).length
      facts.push(`${rows.length} ISA touch${rows.length === 1 ? "" : "es"} on this contact in 30d (${[...byChannel.entries()].map(([c, n]) => `${n} ${c}`).join(", ")})${replied > 0 ? ` — ${replied} got a reply` : ""}`)
      citations.push(`isa_outreach_log.count_30d=${rows.length} (isa_outreach_log.contact_id=${ctx.entityId})`)
      if (replied > 0) citations.push(`isa_outreach_log.replied_30d=${replied} (isa_outreach_log.contact_id=${ctx.entityId})`)
    }
    return { facts, citations }
  }
  const [{ data: leadRows }, { data: qualRows }] = await Promise.all([
    svc.from("leads").select("id, source, lifecycle_state")
      .eq("brokerage_id", ctx.brokerageId).gte("created_at", since).limit(1000),
    svc.from("ai_isa_qualifications").select("id, qualification_result")
      .eq("brokerage_id", ctx.brokerageId).gte("qualified_at", since).limit(1000),
  ])
  const facts: string[] = [], citations: string[] = []
  const leads = (leadRows ?? []) as any[]
  if (leads.length > 0) {
    const bySource = new Map<string, number>()
    for (const l of leads) bySource.set(l.source ?? "unknown", (bySource.get(l.source ?? "unknown") ?? 0) + 1)
    const top = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
    facts.push(`${leads.length} new lead${leads.length === 1 ? "" : "s"} in 30d${top.length ? ` (top sources: ${top.map(([s, n]) => `${s} ${n}`).join(", ")})` : ""}`)
    citations.push(`leads.count_30d=${leads.length} (leads.brokerage_id=${ctx.brokerageId})`)
    if (top[0]) citations.push(`leads.top_source_30d=${top[0][0]} count=${top[0][1]} (leads.brokerage_id=${ctx.brokerageId})`)
  }
  const quals = (qualRows ?? []) as any[]
  if (quals.length > 0) {
    const qualified = quals.filter((q) => q.qualification_result === "qualified" || q.qualification_result === "appointment_set").length
    facts.push(`${quals.length} ISA qualification pass${quals.length === 1 ? "" : "es"} in 30d — ${qualified} qualified/appointment-set, ${quals.length - qualified} not`)
    citations.push(`ai_isa_qualifications.qualified_30d=${qualified} total=${quals.length} (ai_isa_qualifications.brokerage_id=${ctx.brokerageId})`)
  }
  return { facts, citations }
}

/** Talent pipeline: the live recruits funnel — the Recruiting Manager's seat in the
 *  offer-terms argument (who's on the table, at what volume, from where). */
const loadRecruitingManagerFacts: FactLoader = async (svc, ctx) => {
  const { data } = await svc.from("recruits")
    .select("id, first_name, last_name, status, annual_volume, years_experience, current_brokerage")
    .eq("brokerage_id", ctx.brokerageId)
    .in("status", ["prospect", "contacted", "interviewing", "offer_extended"])
    .limit(200)
  const rows = (data ?? []) as any[]
  const facts: string[] = [], citations: string[] = []
  if (rows.length > 0) {
    const byStatus = new Map<string, number>()
    for (const r of rows) byStatus.set(r.status ?? "unknown", (byStatus.get(r.status ?? "unknown") ?? 0) + 1)
    facts.push(`${rows.length} live recruit${rows.length === 1 ? "" : "s"} in the pipeline (${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(", ")})`)
    citations.push(`recruits.pipeline_count=${rows.length} (recruits.brokerage_id=${ctx.brokerageId})`)
  }
  const scoped = ctx.entityType === "recruit" && ctx.entityId ? rows.find((r) => r.id === ctx.entityId) : null
  const detail = scoped ?? rows.find((r) => r.status === "offer_extended") ?? null
  if (detail) {
    const name = [detail.first_name, detail.last_name].filter(Boolean).join(" ").trim() || "candidate"
    facts.push(`${name} — status ${detail.status}${detail.annual_volume != null ? `, ${usd(Number(detail.annual_volume))} annual volume` : ""}${detail.years_experience != null ? `, ${detail.years_experience} yrs experience` : ""}${detail.current_brokerage ? `, currently at ${detail.current_brokerage}` : ""}`)
    citations.push(`recruits.status=${detail.status} (recruits.id=${detail.id})`)
    if (detail.annual_volume != null) citations.push(`recruits.annual_volume=${detail.annual_volume} (recruits.id=${detail.id})`)
    if (detail.years_experience != null) citations.push(`recruits.years_experience=${detail.years_experience} (recruits.id=${detail.id})`)
  }
  return { facts, citations }
}

/** The vendor book: the jobs on the referred transaction + what the ratings ledger
 *  actually says about those vendors — the Data Steward's seat in the vendor-pick
 *  argument (stewarded tables: vendors, vendor_jobs, vendor_ratings). Round 38:
 *  when the referral is an ASSIGNMENT-POLICY dispute (entityType 'assignment_rule',
 *  the assignment_policy_outcomes edge) the Steward instead argues from the config
 *  it stewards — the live assignment_rules book (name/type/priority/rotation). */
const loadDataStewardFacts: FactLoader = async (svc, ctx) => {
  // ── Assignment-policy seat (assignment_policy_outcomes, round 38) ──
  if (ctx.entityType === "assignment_rule") {
    const facts: string[] = [], citations: string[] = []
    const { data: rules } = await svc.from("assignment_rules")
      .select("id, name, rule_type, priority, is_active, times_triggered, agent_ids, team_id")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .limit(10)
    for (const r of (rules ?? []) as any[]) {
      const pool = Array.isArray(r.agent_ids) ? r.agent_ids.length : 0
      facts.push(`rule "${r.name ?? r.id}" — ${r.rule_type}, priority ${r.priority}, fired ${r.times_triggered ?? 0} time${(r.times_triggered ?? 0) === 1 ? "" : "s"}${pool > 0 ? `, ${pool} agent${pool === 1 ? "" : "s"} in the pool` : r.team_id ? ", team-scoped pool" : ""}${r.id === ctx.entityId ? " (the rule under challenge)" : ""}`)
      citations.push(`assignment_rules.rule_type=${r.rule_type} priority=${r.priority} times_triggered=${r.times_triggered ?? 0} (assignment_rules.id=${r.id})`)
    }
    return { facts, citations }
  }

  const facts: string[] = [], citations: string[] = []
  let vendorIds: string[] = []
  if (ctx.entityType === "transaction" && ctx.entityId) {
    const { data: jobs } = await svc.from("vendor_jobs")
      .select("id, vendor_id, status, job_title")
      .eq("transaction_id", ctx.entityId).limit(20)
    for (const j of (jobs ?? []) as any[]) {
      facts.push(`job "${j.job_title ?? "vendor job"}" — status ${j.status}`)
      citations.push(`vendor_jobs.status=${j.status} (vendor_jobs.id=${j.id})`)
      if (j.vendor_id) vendorIds.push(j.vendor_id)
    }
  }
  if (vendorIds.length === 0) {
    const { data: rated } = await svc.from("vendor_ratings").select("vendor_id")
      .eq("brokerage_id", ctx.brokerageId).limit(10)
    vendorIds = ((rated ?? []) as any[]).map((r) => r.vendor_id).filter(Boolean)
  }
  if (vendorIds.length > 0) {
    const { data: ratings } = await svc.from("vendor_ratings")
      .select("vendor_id, avg_agent_rating, avg_client_rating, total_bookings")
      .eq("brokerage_id", ctx.brokerageId).in("vendor_id", Array.from(new Set(vendorIds)).slice(0, 10)).limit(10)
    for (const r of (ratings ?? []) as any[]) {
      facts.push(`vendor ${r.vendor_id} track record — agents rate ${r.avg_agent_rating ?? "unrated"}, clients ${r.avg_client_rating ?? "unrated"}, ${r.total_bookings ?? 0} booking${(r.total_bookings ?? 0) === 1 ? "" : "s"}`)
      citations.push(`vendor_ratings.avg_agent_rating=${r.avg_agent_rating ?? "null"} avg_client_rating=${r.avg_client_rating ?? "null"} total_bookings=${r.total_bookings ?? 0} (vendor_ratings.vendor_id=${r.vendor_id})`)
    }
  }
  return { facts, citations }
}

/** The referral engine's ledger: the fee terms + history the Sphere argues from — its
 *  OWN stewarded table (referrals). Round 41, the referral_fee_economics seat: the
 *  referral in dispute (entityType 'referral') plus the brokerage's own agent-referral
 *  fee norms and what closed referrals actually paid. */
const loadSphereOfInfluenceFacts: FactLoader = async (svc, ctx) => {
  const facts: string[] = [], citations: string[] = []
  if (ctx.entityType === "referral" && ctx.entityId) {
    const { data: r } = await svc.from("referrals")
      .select("id, referral_fee_pct, status, referral_source, commission_amount, commission_potential, value_estimate")
      .eq("brokerage_id", ctx.brokerageId).eq("id", ctx.entityId).maybeSingle()
    const row = r as any
    if (row) {
      facts.push(`the referral in dispute — agreed fee ${row.referral_fee_pct != null ? `${row.referral_fee_pct}%` : "unset"}, status ${row.status}${row.value_estimate != null ? `, estimated deal value ${usd(Number(row.value_estimate))}` : ""}`)
      if (row.referral_fee_pct != null) citations.push(`referrals.referral_fee_pct=${row.referral_fee_pct} (referrals.id=${row.id})`)
      citations.push(`referrals.status=${row.status} (referrals.id=${row.id})`)
      if (row.value_estimate != null) citations.push(`referrals.value_estimate=${row.value_estimate} (referrals.id=${row.id})`)
    }
  }
  const { data: hist } = await svc.from("referrals")
    .select("id, referral_fee_pct, status, commission_amount")
    .eq("brokerage_id", ctx.brokerageId).eq("referral_source", "agent_referral").limit(200)
  const rows = (hist ?? []) as any[]
  const withFee = rows.filter((r) => r.referral_fee_pct != null)
  if (withFee.length > 0) {
    const avgFee = Math.round((withFee.reduce((s, r) => s + Number(r.referral_fee_pct), 0) / withFee.length) * 10) / 10
    const closed = rows.filter((r) => r.status === "closed")
    facts.push(`${rows.length} agent-to-agent referral${rows.length === 1 ? "" : "s"} on the ledger — average agreed fee ${avgFee}%${closed.length > 0 ? `, ${closed.length} closed` : ""}`)
    citations.push(`referrals.avg_fee_pct=${avgFee} count=${withFee.length} (referrals.brokerage_id=${ctx.brokerageId})`)
    const paid = closed.filter((r) => r.commission_amount != null)
    if (paid.length > 0) {
      const total = paid.reduce((s, r) => s + Number(r.commission_amount), 0)
      facts.push(`closed agent referrals recorded ${usd(total)} in referral commission`)
      citations.push(`referrals.closed_commission_total=${Math.round(total)} count=${paid.length} (referrals.brokerage_id=${ctx.brokerageId})`)
    }
  }
  return { facts, citations }
}

/** The sequence side of a contact's attention window: active enrollments + the shared
 *  touch ledger — the Orchestrator's OWN stewarded tables (sequence_enrollments,
 *  marketing_campaign_touchpoints). Round 41, the sequence_touch_cadence seat:
 *  contact-scoped when the dispute names one, brokerage-wide otherwise. */
const loadCampaignOrchestratorFacts: FactLoader = async (svc, ctx) => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const contactScoped = ctx.entityType === "contact" && !!ctx.entityId
  const facts: string[] = [], citations: string[] = []
  const enrollQ = svc.from("sequence_enrollments")
    .select("id, sequence_id, status, current_step, next_step_at")
    .eq("brokerage_id", ctx.brokerageId).eq("status", "active")
  const { data: enrolls } = contactScoped
    ? await enrollQ.eq("contact_id", ctx.entityId!).limit(20)
    : await enrollQ.limit(500)
  const enrollRows = (enrolls ?? []) as any[]
  if (enrollRows.length > 0) {
    facts.push(`${enrollRows.length} active sequence enrollment${enrollRows.length === 1 ? "" : "s"}${contactScoped ? " on this contact" : ""}${contactScoped && enrollRows[0]?.current_step != null ? ` (at step ${enrollRows[0].current_step})` : ""}`)
    citations.push(`sequence_enrollments.active_count=${enrollRows.length}${contactScoped ? ` (sequence_enrollments.contact_id=${ctx.entityId})` : ` (sequence_enrollments.brokerage_id=${ctx.brokerageId})`}`)
    if (contactScoped && enrollRows[0]?.current_step != null) {
      citations.push(`sequence_enrollments.current_step=${enrollRows[0].current_step} (sequence_enrollments.id=${enrollRows[0].id})`)
    }
  }
  const touchQ = svc.from("marketing_campaign_touchpoints")
    .select("id, channel").eq("brokerage_id", ctx.brokerageId).gte("created_at", since)
  const { data: touches } = contactScoped
    ? await touchQ.eq("contact_id", ctx.entityId!).limit(200)
    : await touchQ.limit(1000)
  const touchRows = (touches ?? []) as any[]
  if (touchRows.length > 0) {
    const byChannel = new Map<string, number>()
    for (const t of touchRows) byChannel.set(t.channel ?? "unknown", (byChannel.get(t.channel ?? "unknown") ?? 0) + 1)
    facts.push(`${touchRows.length} campaign touch${touchRows.length === 1 ? "" : "es"} on the shared ledger in 30d${contactScoped ? " for this contact" : ""} (${[...byChannel.entries()].map(([c, n]) => `${n} ${c}`).join(", ")})`)
    citations.push(`marketing_campaign_touchpoints.count_30d=${touchRows.length}${contactScoped ? ` (marketing_campaign_touchpoints.contact_id=${ctx.entityId})` : ` (marketing_campaign_touchpoints.brokerage_id=${ctx.brokerageId})`}`)
  }
  return { facts, citations }
}

/** Every manager that can sit at a deliberative table has a REAL loader; anyone else
 *  gets honest empties (never fabricated facts). Exported so the simulator proves a
 *  loader exists for every participant of every deliberative domain. */
export const MANAGER_FACT_LOADERS: Partial<Record<ManagerKey, FactLoader>> = {
  listing_concierge: loadListingConciergeFacts,
  shopping_agent: loadShoppingAgentFacts,
  deal_coordinator: loadDealCoordinatorFacts,
  finance_manager: loadFinanceManagerFacts,
  compliance_officer: loadComplianceOfficerFacts,
  marketing_agent: loadMarketingAgentFacts,
  ads_manager: loadAdsManagerFacts,
  cron_manager: loadCronManagerFacts,
  // Round 36 — the new deliberative seats, each grounded in ITS OWN stewarded tables.
  ai_isa: loadAiIsaFacts,
  recruiting_manager: loadRecruitingManagerFacts,
  data_steward: loadDataStewardFacts,
  // Round 41 — the last genuinely-arguable seats (no-noise audit: the managers left
  // without a loader — asset_manager — hold no deliberative seat, by documented verdict).
  sphere_of_influence: loadSphereOfInfluenceFacts,
  campaign_orchestrator: loadCampaignOrchestratorFacts,
}

/** Load one manager's grounded brief (empty facts when its tables are quiet — honest). */
export async function loadManagerBrief(
  manager: ManagerKey, ctx: ReferralContext, client?: Svc,
): Promise<ManagerBrief> {
  const svc = client ?? createServiceClient()
  const loader = MANAGER_FACT_LOADERS[manager]
  if (!loader) return { manager, facts: [], citations: [] }
  try {
    const { facts, citations } = await loader(svc, ctx)
    return { manager, facts: facts.slice(0, 8), citations: citations.slice(0, 12) }
  } catch {
    return { manager, facts: [], citations: [] }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE — argue + resolve. The default rides the AI gateway
// (generateObjectRouted: routing, fallback model, billing); the simulator injects a
// deterministic engine. Any engine failure → the deliberation records 'unavailable'.
// ─────────────────────────────────────────────────────────────────────────────

export interface ArgueInput {
  manager: ManagerKey
  domain: CollaborationDomain
  ask: string
  raisedBy: ManagerKey
  brief: ManagerBrief
  brokerageId: string
}

/** ONE bounded rebuttal turn (round 36): a manager reads the OTHERS' positions and may
 *  push back with cited evidence from its OWN brief — or honestly decline (null). */
export interface RebutInput {
  manager: ManagerKey
  domain: CollaborationDomain
  ask: string
  /** This manager's own argued position. */
  own: ManagerPosition
  /** The other managers' positions being rebutted. */
  others: ManagerPosition[]
  brief: ManagerBrief
  brokerageId: string
}

export interface ResolveInput {
  domain: CollaborationDomain
  ask: string
  positions: ManagerPosition[]
  /** The pooled situation facts (every brief's fact lines) the winner is judged against. */
  situationFacts: string[]
  brokerageId: string
}

export interface DeliberationEngine {
  argue: (input: ArgueInput) => Promise<{ proposal: string; reasoning: string; risks: string[]; evidence: string[] }>
  /** Optional ONE-round rebuttal capability. An engine without it holds no rebuttal
   *  round (recorded honestly) — the deliberation still resolves. */
  rebut?: (input: RebutInput) => Promise<{ rebuttal: string | null; evidence: string[] }>
  resolve: (input: ResolveInput) => Promise<{ winner: string; why: string; dissent: { manager: string; note: string } | null }>
}

/** The production engine — structured generation through the ONE gateway. */
export function gatewayEngine(): DeliberationEngine {
  return {
    async argue(input) {
      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { z } = await import("zod")
      const info = MANAGERS[input.manager]
      const factLines = input.brief.facts.length > 0
        ? input.brief.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")
        : "(no rows in your domain's tables for this window — say so honestly and argue from the situation alone)"
      const citationLines = input.brief.citations.length > 0
        ? input.brief.citations.map((c) => `- ${c}`).join("\n")
        : "(none)"
      const { object } = await generateObjectRouted({
        feature: "manager_deliberation",
        brokerageId: input.brokerageId,
        temperature: 0.2,
        maxTokens: 700,
        schema: z.object({
          proposal: z.string().min(1).describe("Your concrete recommended solution, one or two sentences."),
          reasoning: z.string().min(1).describe("Why this solution is best for the situation, argued from YOUR domain facts."),
          risks: z.array(z.string()).max(4).describe("What could go wrong if your solution is adopted."),
          evidence: z.array(z.string()).max(6).describe("Citations copied VERBATIM from the allowed citation list."),
        }),
        system:
          `You are the ${info.label}, the AI manager accountable for "${info.domain}" at a real-estate brokerage. ` +
          `A cross-manager referral needs the co-managers of "${input.domain.label}" to each argue a solution. ` +
          `Argue YOUR position from YOUR domain's real data only. evidence[] must contain ONLY strings copied verbatim ` +
          `from the allowed citation list — never invent a number, row, or citation.`,
        prompt:
          `SITUATION (raised by ${MANAGERS[input.raisedBy]?.label ?? input.raisedBy}): ${input.ask}\n\n` +
          `YOUR DOMAIN FACTS:\n${factLines}\n\n` +
          `ALLOWED CITATIONS (copy verbatim into evidence[]):\n${citationLines}\n\n` +
          `Argue the solution that best serves the brokerage from your seat, and be honest about its risks.`,
      })
      return object as { proposal: string; reasoning: string; risks: string[]; evidence: string[] }
    },
    async rebut(input) {
      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { z } = await import("zod")
      const info = MANAGERS[input.manager]
      const othersText = input.others.map((p) =>
        `--- ${MANAGERS[p.manager]?.label ?? p.manager} ---\nProposal: ${p.proposal}\nReasoning: ${p.reasoning}\nEvidence: ${p.evidence.join(" | ") || "none"}`,
      ).join("\n\n")
      const citationLines = input.brief.citations.length > 0
        ? input.brief.citations.map((c) => `- ${c}`).join("\n")
        : "(none)"
      const { object } = await generateObjectRouted({
        feature: "manager_deliberation",
        brokerageId: input.brokerageId,
        temperature: 0.2,
        maxTokens: 400,
        schema: z.object({
          rebuttal: z.string().nullable().describe("Your factual pushback on the other positions — or null when you have nothing factual to dispute. Never manufacture a disagreement."),
          evidence: z.array(z.string()).max(4).describe("Citations copied VERBATIM from your allowed citation list that back the rebuttal."),
        }),
        system:
          `You are the ${info.label} in a deliberation on "${input.domain.label}". This is the ONE bounded rebuttal ` +
          `round: read the other managers' positions and push back ONLY where your own domain's real data contradicts ` +
          `a factual claim they rely on. If nothing factual is in dispute, return null — an honest pass beats a ` +
          `manufactured argument. evidence[] must contain ONLY strings copied verbatim from your citation list.`,
        prompt:
          `SITUATION: ${input.ask}\n\nYOUR ARGUED POSITION:\nProposal: ${input.own.proposal}\nReasoning: ${input.own.reasoning}\n\n` +
          `THE OTHER POSITIONS:\n${othersText}\n\n` +
          `YOUR ALLOWED CITATIONS (copy verbatim into evidence[]):\n${citationLines}`,
      })
      return object as { rebuttal: string | null; evidence: string[] }
    },
    async resolve(input) {
      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { z } = await import("zod")
      const positionsText = input.positions.map((p) =>
        `--- ${MANAGERS[p.manager]?.label ?? p.manager} (key: ${p.manager}) ---\n` +
        `Proposal: ${p.proposal}\nReasoning: ${p.reasoning}\nRisks: ${p.risks.join("; ") || "none stated"}\n` +
        `Evidence: ${p.evidence.join(" | ") || "none"}` +
        (p.rebuttal?.note ? `\nRebuttal of the others (cited): ${p.rebuttal.note}` : ""),
      ).join("\n\n")
      const { object } = await generateObjectRouted({
        feature: "manager_deliberation",
        brokerageId: input.brokerageId,
        temperature: 0.1,
        maxTokens: 500,
        schema: z.object({
          winner: z.string().describe("The manager key (exactly as given) whose position best fits the situation's facts."),
          why: z.string().min(1).describe("Why this position beats each of the others, grounded in the facts."),
          dissent: z.object({
            manager: z.string().describe("The losing manager key whose position had real merit."),
            note: z.string().min(1).describe("The honest merit of the losing position, on the record."),
          }).nullable().describe("null when no losing position had real merit — do not fabricate dissent."),
        }),
        system:
          `You chair a deliberation between AI managers of a real-estate brokerage on "${input.domain.label}". ` +
          `Compare the argued positions against the situation's facts, pick the winner, and state WHY it beats the ` +
          `others. Record dissent ONLY when a losing position has genuine merit — honest, never ceremonial.`,
        prompt:
          `SITUATION: ${input.ask}\n\nSITUATION FACTS:\n${input.situationFacts.map((f) => `- ${f}`).join("\n") || "- (none loaded)"}\n\n` +
          `ARGUED POSITIONS:\n${positionsText}`,
      })
      return object as { winner: string; why: string; dissent: { manager: string; note: string } | null }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DELIBERATION ITSELF — pure of I/O given briefs + an engine (simulator-driven);
// runDeliberation wraps it with the real loaders and the ledger write.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hold the argument: every participant argues from its brief (grounding-filtered),
 * then the resolution pass picks the winner with the stated why + honest dissent.
 * ANY engine failure (unreachable gateway, junk winner) → status 'unavailable' with
 * the reason — never canned arguments.
 */
export async function deliberate(params: {
  domain: CollaborationDomain
  ask: string
  raisedBy: ManagerKey
  briefs: ManagerBrief[]
  brokerageId: string
  engine: DeliberationEngine
  now?: Date
}): Promise<DeliberationRecord> {
  const deliberatedAt = (params.now ?? new Date()).toISOString()
  const base = { domain: params.domain.key, deliberatedAt }
  try {
    const positions: ManagerPosition[] = []
    for (const brief of params.briefs) {
      const raw = await params.engine.argue({
        manager: brief.manager, domain: params.domain, ask: params.ask,
        raisedBy: params.raisedBy, brief, brokerageId: params.brokerageId,
      })
      positions.push({
        manager: brief.manager,
        proposal: String(raw.proposal ?? "").slice(0, 600),
        reasoning: String(raw.reasoning ?? "").slice(0, 1200),
        risks: (raw.risks ?? []).map((r) => String(r).slice(0, 300)).slice(0, 4),
        // THE GROUNDING GUARD — evidence is the loader's real citations, never invented.
        evidence: filterEvidenceToCitations((raw.evidence ?? []).map(String), brief.citations),
      })
    }

    // ── THE ONE BOUNDED REBUTTAL ROUND (round 36) — held ONLY when the positions
    // directly conflict AND the engine can rebut. A single pass over the positions
    // (no loop, no second round — the bound is structural), each rebuttal grounded
    // through the SAME guard against the rebutting manager's OWN citations. A manager
    // may honestly decline (null) — no manufactured disagreement. ──
    let rebuttalHeld = false
    if (params.engine.rebut && positionsDirectlyConflict(positions)) {
      rebuttalHeld = true
      for (let i = 0; i < positions.length; i++) {
        const own = positions[i]
        const brief = params.briefs.find((b) => b.manager === own.manager)
        if (!brief) continue
        const raw = await params.engine.rebut({
          manager: own.manager, domain: params.domain, ask: params.ask,
          own, others: positions.filter((_, j) => j !== i),
          brief, brokerageId: params.brokerageId,
        })
        const note = String(raw.rebuttal ?? "").trim()
        positions[i] = {
          ...own,
          rebuttal: note
            ? { note: note.slice(0, 600), evidence: filterEvidenceToCitations((raw.evidence ?? []).map(String), brief.citations) }
            : null,
        }
      }
    }

    const situationFacts = params.briefs.flatMap((b) => b.facts)
    const res = await params.engine.resolve({
      domain: params.domain, ask: params.ask, positions, situationFacts, brokerageId: params.brokerageId,
    })
    if (!validResolutionWinner(res.winner, positions)) {
      return {
        ...base, status: "unavailable", positions: [], winner: null, resolution: null, dissent: null,
        unavailableReason: `the model named '${res.winner}' as winner, which is not one of the argued positions`,
      }
    }
    // Dissent is recorded only when it is honest: a real LOSING participant with a note.
    let dissent: DeliberationDissent | null = null
    if (res.dissent && res.dissent.manager !== res.winner
      && positions.some((p) => p.manager === res.dissent!.manager)
      && String(res.dissent.note ?? "").trim().length > 0) {
      dissent = { manager: res.dissent.manager as ManagerKey, note: String(res.dissent.note).slice(0, 500) }
    }
    return {
      ...base, status: "resolved", positions, rebuttalHeld,
      winner: res.winner, resolution: String(res.why ?? "").slice(0, 900), dissent,
      unavailableReason: null, override: null,
    }
  } catch (e) {
    return {
      ...base, status: "unavailable", positions: [], winner: null, resolution: null, dissent: null,
      unavailableReason: (e instanceof Error ? e.message : "model unreachable").slice(0, 300),
    }
  }
}

export interface RunDeliberationInput {
  brokerageId: string
  /** MANAGER_COLLABORATIONS key the referral traveled — must be deliberative. */
  collabDomain: string
  ask: string
  fromManager: ManagerKey
  entityType?: string | null
  entityId?: string | null
  /** The referral's manager_signals row — the EXISTING ledger the record persists onto. */
  signalId?: string | null
  /** The referral row's current payload (for idempotent reuse + a lossless merge). */
  existingPayload?: Record<string, unknown> | null
}

/**
 * The full lifecycle around one referral: reuse an already-persisted record
 * (a retried handler never re-spends the gateway), else load every participant's
 * grounded brief, hold the argument, and persist the record onto the referral row
 * (payload.deliberation) via sentinelWrite. Returns null only for a non-deliberative
 * or unknown domain (the caller shouldn't have escalated).
 */
export async function runDeliberation(
  input: RunDeliberationInput, client?: Svc, engine?: DeliberationEngine,
): Promise<DeliberationRecord | null> {
  const domain = MANAGER_COLLABORATIONS[input.collabDomain]
  if (!domain || domain.deliberate !== true) return null

  // Idempotent reuse — the argument already happened; never re-argue on a retry.
  const existing = parseDeliberation(input.existingPayload)
  if (existing) return existing

  const svc = client ?? createServiceClient()
  const ctx: ReferralContext = {
    brokerageId: input.brokerageId, ask: input.ask,
    entityType: input.entityType ?? null, entityId: input.entityId ?? null,
  }
  const briefs = await Promise.all(domain.managers.map((m) => loadManagerBrief(m, ctx, svc)))
  const record = await deliberate({
    domain, ask: input.ask, raisedBy: input.fromManager, briefs,
    brokerageId: input.brokerageId, engine: engine ?? gatewayEngine(),
  })

  if (input.signalId) {
    const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
    await sentinelWrite(svc, svc.from("manager_signals")
      .update({ payload: { ...(input.existingPayload ?? {}), deliberation: record } })
      .eq("id", input.signalId), {
      table: "manager_signals", flow: "manager_deliberation", brokerageId: input.brokerageId,
    })
  }
  return record
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PRINCIPAL'S CALL — persistence (round 36). The admin action wraps this with
// auth; the simulator drives it directly. Same ledger (the referral row's own
// payload.deliberation), same sentinelWrite (a lost override would silently leave
// the argued winner governing against the human's stated decision).
// ─────────────────────────────────────────────────────────────────────────────

export async function recordPrincipalOverride(
  input: {
    brokerageId: string
    /** The referral's manager_signals row id — the ONE ledger the record lives on. */
    signalId: string
    winner: string
    reason: string
    by?: string | null
    now?: Date
  },
  client?: Svc,
): Promise<{ ok: true; record: DeliberationRecord } | { ok: false; error: string }> {
  const svc = client ?? createServiceClient()
  const { data: row } = await svc.from("manager_signals")
    .select("id, payload")
    .eq("id", input.signalId)
    .eq("brokerage_id", input.brokerageId)
    .eq("signal_type", "cross_manager_referral")
    .maybeSingle()
  if (!row) return { ok: false, error: "referral not found for this brokerage" }
  const payload = ((row as { payload: Record<string, unknown> | null }).payload ?? {}) as Record<string, unknown>
  const record = parseDeliberation(payload)
  if (!record) return { ok: false, error: "this referral holds no deliberation to override" }
  const applied = applyPrincipalOverride(record, {
    winner: input.winner, reason: input.reason, by: input.by ?? null, now: input.now,
  })
  if (!applied.ok) return applied
  const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
  const landed = await sentinelWrite(svc, svc.from("manager_signals")
    .update({ payload: { ...payload, deliberation: applied.record } })
    .eq("id", input.signalId), {
    table: "manager_signals", flow: "manager_deliberation_override", brokerageId: input.brokerageId,
  })
  if (!landed) return { ok: false, error: "could not record the principal's call — the loss is on the self-heal ledger" }
  return { ok: true, record: applied.record }
}
