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
 * A RESOLUTION pass then compares the positions against the situation's facts, picks
 * the winner WITH the stated why-this-beats-the-others, and records honest DISSENT
 * when a losing position had merit — the same visible-disagreement idiom as the
 * peer-review dissent rail (lib/kernel/manager-dissent.ts), extended from one
 * reviewer's objections to a full argued debate.
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

/** One manager's argued position. */
export interface ManagerPosition {
  manager: ManagerKey
  proposal: string
  reasoning: string
  risks: string[]
  /** Field-level citations — filtered to the loader's REAL citations, never invented. */
  evidence: string[]
}

export interface DeliberationDissent {
  manager: ManagerKey
  /** Why the losing position had merit — honest, on the record. */
  note: string
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

/** PURE: the consumed-action / feed one-liner for a finished deliberation. */
export function summarizeDeliberation(record: DeliberationRecord): string {
  const domainLabel = MANAGER_COLLABORATIONS[record.domain]?.label ?? record.domain
  if (record.status === "unavailable" || !record.winner || !record.resolution) {
    return `${DELIBERATION_UNAVAILABLE} for '${domainLabel}' — ${record.unavailableReason ?? "the model could not be reached"}; the referral was surfaced to the principals without argued positions (no canned arguments were substituted)`
  }
  const winnerLabel = MANAGERS[record.winner]?.label ?? record.winner
  const others = record.positions.filter((p) => p.manager !== record.winner).map((p) => MANAGERS[p.manager]?.label ?? p.manager)
  let line = `deliberated '${domainLabel}' — ${record.positions.length} positions argued` +
    (others.length > 0 ? ` (${[winnerLabel, ...others].join(" vs ")})` : "") +
    `; ${winnerLabel}'s proposal won: ${record.resolution}`
  if (record.dissent) {
    const dLabel = MANAGERS[record.dissent.manager]?.label ?? record.dissent.manager
    line += ` — DISSENT on the record from ${dLabel}: ${record.dissent.note}`
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
    .eq("brokerage_id", ctx.brokerageId).in("status", ["active", "under_contract", "closing"]).is("deleted_at", null).limit(200)
  const facts: string[] = [], citations: string[] = []
  const openRows = (open ?? []) as any[]
  if (openRows.length > 0) {
    const weighted = forecastGci(0, toPipeline(openRows), new Date()).weightedPipeline
    facts.push(`${openRows.length} open deal${openRows.length === 1 ? "" : "s"} carrying ${usd(weighted)} probability-weighted gross commission`)
    citations.push(`transactions.open_count=${openRows.length} weighted_gci=${Math.round(weighted)} (transactions.brokerage_id=${ctx.brokerageId})`)
    const scoped = ctx.entityType === "transaction" && ctx.entityId ? openRows.find((t) => t.id === ctx.entityId) : null
    if (scoped) citations.push(`transactions.estimated_commission=${Math.round(dealCommission(scoped))} (transactions.id=${scoped.id})`)
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
    async resolve(input) {
      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { z } = await import("zod")
      const positionsText = input.positions.map((p) =>
        `--- ${MANAGERS[p.manager]?.label ?? p.manager} (key: ${p.manager}) ---\n` +
        `Proposal: ${p.proposal}\nReasoning: ${p.reasoning}\nRisks: ${p.risks.join("; ") || "none stated"}\n` +
        `Evidence: ${p.evidence.join(" | ") || "none"}`,
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
      ...base, status: "resolved", positions,
      winner: res.winner, resolution: String(res.why ?? "").slice(0, 900), dissent,
      unavailableReason: null,
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
