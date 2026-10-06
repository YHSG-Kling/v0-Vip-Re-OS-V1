// lib/kernel/procurement.ts
//
// MARKETPLACE PROCUREMENT INTELLIGENCE (wave 107, lane 107B). Owner: "Don't build if capability is
// already present, only improve." So this module OWNS NO NEW RAIL — it is the decision layer over the
// marketplace survivors, in the owner's order:
//
//   Listing Concierge need (photography for a listing — lib/orchestrator/internal.ts handleListingSigned)
//     → eligible vendors      category (toVendorCategory) + territory (vendorGeoVerdict, the m551 rule the
//                             trg_vendor_bookings_service_area trigger re-checks on insert) + standing
//                             (vendors.status, vendor_subscriptions.status, the rating-governance floor)
//     → ranked               rankVendorsForRequest — PURE, deterministic, per-factor score + reason
//                             (availability, price, quality, SLA via computeVendorSla, history, preference)
//     → recommendation       the vendor_bookings row itself in status 'requested' (m723) — the
//                             PROCUREMENT_REQUEST object, never a parallel table
//     → AGENT APPROVAL       the existing approval queue: proposeClientMessage (entity 'vendor_booking');
//                             approveClientMessage / rejectClientMessage call back into this module
//     → book                 the existing booking writer updateVendorBookingStatus (requested → booked)
//     → payment              the existing per-job rail: vendor_invoices.booking_id → vendor_earnings →
//                             vendor_payouts (app/actions/vendor-payments.ts) — read here, never re-written
//     → completion           updateVendorBookingStatus (→ completed)
//     → review               vendor_bookings.agent_rating → recalculateVendorRatingsCore → vendor_ratings,
//                             which the QUALITY factor reads on the next request (the loop closes)
//
// AUTONOMY: tenant policy key `procurement_autonomy` (brokerage_settings.settings, versioned by
// lib/kernel/tenant-policy.ts) = { enabled, max_auto_approve_usd, allowed_service_categories }. DEFAULT OFF
// — recommendation only. When on, a purchase whose price is known, ≤ the cap, within an allowed category
// books without a human, ledgered with the policy ref. Unknown price never auto-books (fail closed).
//
// Evidence: every step runs under withActionLedger (who / why / policy / what happened) and emits an
// auditOnly kernel event. Vendors see only their own requests + quotes (vendorProcurementView, gated by
// requireVendorActor at the door). Tenant from the SESSION / the verified event, never a body.

import type { createServiceClient } from "@/lib/supabase/service"
import { toVendorCategory } from "@/lib/kernel/vendor-categories"
import { computeVendorSla, SLA_BREACH_PCT } from "@/lib/kernel/vendor-sla"
import { blendedAvg, computeRatingHealth, MIN_SAMPLE } from "@/lib/kernel/vendor-rating-governance"
import { vendorGeoVerdict, type VendorCoverageRow } from "@/lib/vendors/vendor-service-area"

type Svc = ReturnType<typeof createServiceClient>

// ── THE REQUEST OBJECT — where each owner field lives (m723 header is the schema mirror) ──────────
/** @proofSeam the owner's thirteen PROCUREMENT_REQUEST fields mapped onto survivor columns — the proof
 *  asserts every field names a real home; nothing in the product needs the map at runtime. */
export const PROCUREMENT_REQUEST_FIELDS = Object.freeze({
  service: "vendor_bookings.service_type",
  property: "vendor_bookings.listing_id | transaction_id | contact_id",
  territory: "vendor_bookings.territory",
  needed_by: "vendor_bookings.needed_by",
  budget: "vendor_bookings.budget",
  requirements: "vendor_bookings.requirements",
  preferred_vendors: "vendor_bookings.preferred_vendor_ids",
  quotes: "vendor_booking_quotes",
  selected_vendor: "vendor_bookings.vendor_id",
  approval: "vendor_bookings.approval_status (+ approval_message_id → agent_client_messages)",
  payment: "vendor_invoices.booking_id → vendor_earnings → vendor_payouts",
  completion: "vendor_bookings.status = completed / completed_at",
  review: "vendor_bookings.agent_rating → vendor_ratings",
} as const)

export const PROCUREMENT_FACTORS = ["availability", "price", "quality", "sla", "history", "preference"] as const
export type ProcurementFactor = (typeof PROCUREMENT_FACTORS)[number]
/** Weights sum to 1. Eligibility EXCLUDES; these RANK. */
export const PROCUREMENT_FACTOR_WEIGHTS: Readonly<Record<ProcurementFactor, number>> = Object.freeze({
  availability: 0.2, price: 0.2, quality: 0.2, sla: 0.15, history: 0.15, preference: 0.1,
})
const NEUTRAL = 0.5
export const PROCUREMENT_SOURCE = "procurement"
export const PROCUREMENT_AUTONOMY_POLICY_KEY = "procurement_autonomy"

// ── FACTS ────────────────────────────────────────────────────────────────────────────────────────
export interface ProcurementCandidateFacts {
  vendorId: string
  name: string
  category: string | null
  status: string | null
  /** vendors.platform_vendor_id — null = a local bench row the tenant added for its own market. */
  platformVendorId: string | null
  turnaroundDays: number | null
  /** vendor_subscriptions.status for THIS brokerage, null = no subscription row. */
  subscriptionStatus: string | null
  coverage: VendorCoverageRow[]
  benchLicense: { expiry?: string | null; verified_at?: string | null } | null
  rating: { avgAgent: number | null; avgClient: number | null; sample: number; oneStars: number } | null
  /** This brokerage's history with the vendor (same service category). */
  history: { completed: number; noShows: number; costs: number[] }
  sla: { slaPct: number; total: number } | null
  quote: { amount: number; availableOn: string | null; status: string } | null
}

export interface ProcurementRequestFacts {
  serviceCategory: string | null
  jobState: string | null
  jobZip: string | null
  neededBy: string | null
  budget: number | null
  preferredVendorIds: string[]
  now: string
  candidates: ProcurementCandidateFacts[]
  blindSpots: string[]
}

export interface RankedVendor {
  vendorId: string
  name: string
  total: number
  /** The price the ranking judged (quote, else this vendor's median history for the category). */
  price: number | null
  factors: Record<ProcurementFactor, { score: number; reason: string }>
  why: string
}

export interface VendorRanking {
  ranked: RankedVendor[]
  excluded: Array<{ vendorId: string; name: string; reason: string }>
  blindSpots: string[]
  weights: Readonly<Record<ProcurementFactor, number>>
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const round3 = (n: number) => Math.round(n * 1000) / 1000
const dayMs = 86_400_000

/** PURE: is this vendor eligible at all? null = eligible, else the named reason. */
function procurementEligibility(f: ProcurementRequestFacts, c: ProcurementCandidateFacts): string | null {
  if (!f.serviceCategory) return "service has no vendor category"
  if (c.category !== f.serviceCategory) return `category ${c.category ?? "none"} ≠ ${f.serviceCategory}`
  if (c.status && ["pending", "inactive", "archived"].includes(c.status)) return `vendor status ${c.status}`
  // A MARKETPLACE vendor (platform identity) needs an ACTIVE subscription with this brokerage; a local
  // bench row the tenant added itself has no subscription to hold (lib/vendors/vendor-money-directions.ts).
  if (c.platformVendorId && c.subscriptionStatus !== "active") return `marketplace subscription ${c.subscriptionStatus ?? "absent"}`
  const geo = vendorGeoVerdict({
    resolved: true, tradeCategory: f.serviceCategory, jobState: f.jobState, jobZip: f.jobZip,
    localBenchRow: !c.platformVendorId, coverage: c.coverage,
    tenantAreas: f.jobState ? [{ state: f.jobState, zipCode: null }] : [], benchLicense: c.benchLicense,
  }, Date.parse(f.now))
  if (!geo.ok) return `territory: ${geo.reason}`
  if (c.rating) {
    const health = computeRatingHealth({ avgAgentRating: c.rating.avgAgent, avgClientRating: c.rating.avgClient, sampleSize: c.rating.sample, oneStarCount: c.rating.oneStars })
    if (health.suppressed) return `quality floor: ${health.reasons[0] ?? "suppressed"}`
  }
  return null
}

/**
 * PURE + DETERMINISTIC: rank the eligible vendors for one request. Every factor carries a score in
 * [0,1] and a reason; a factor with no evidence scores NEUTRAL and says so (never a silent promotion).
 * @proofSeam scripts/procurement-guard.ts asserts per-factor reasons, determinism and the positive-control flip directly.
 */
export function rankVendorsForRequest(f: ProcurementRequestFacts): VendorRanking {
  const excluded: VendorRanking["excluded"] = []
  const eligible: ProcurementCandidateFacts[] = []
  for (const c of f.candidates) {
    const why = procurementEligibility(f, c)
    if (why) excluded.push({ vendorId: c.vendorId, name: c.name, reason: why })
    else eligible.push(c)
  }
  const priceOf = (c: ProcurementCandidateFacts): number | null =>
    c.quote && c.quote.status !== "withdrawn" && c.quote.status !== "declined" ? c.quote.amount : median(c.history.costs)
  const knownPrices = eligible.map(priceOf).filter((p): p is number => p != null)
  const cheapest = knownPrices.length ? Math.min(...knownPrices) : null
  const preferred = new Set(f.preferredVendorIds)
  const neededMs = f.neededBy ? Date.parse(f.neededBy) : null
  const nowMs = Date.parse(f.now)

  const ranked: RankedVendor[] = eligible.map((c) => {
    const factors = {} as RankedVendor["factors"]
    // availability — a quote's date, else today + committed turnaround, against needed_by
    if (neededMs == null) factors.availability = { score: NEUTRAL, reason: "no needed-by date — availability not judged" }
    else {
      const earliest = c.quote?.availableOn ? Date.parse(c.quote.availableOn) : c.turnaroundDays != null ? nowMs + c.turnaroundDays * dayMs : null
      if (earliest == null) factors.availability = { score: NEUTRAL, reason: "no quote date or committed turnaround" }
      else if (earliest <= neededMs) factors.availability = { score: c.quote?.availableOn ? 1 : 0.8, reason: c.quote?.availableOn ? `quoted available ${c.quote.availableOn} (needed by ${f.neededBy})` : `turnaround ${c.turnaroundDays}d meets needed-by ${f.neededBy}` }
      else factors.availability = { score: 0.1, reason: `earliest ${new Date(earliest).toISOString().slice(0, 10)} misses needed-by ${f.neededBy}` }
    }
    // price — against the budget when there is one, else against the cheapest known
    const price = priceOf(c)
    if (price == null) factors.price = { score: NEUTRAL, reason: "no quote and no price history" }
    else if (f.budget != null && f.budget > 0) {
      factors.price = price > f.budget
        ? { score: 0, reason: `$${price} over the $${f.budget} budget` }
        : { score: round3(1 - 0.5 * (price / f.budget)), reason: `$${price} within the $${f.budget} budget${c.quote ? " (quoted)" : " (history median)"}` }
    } else factors.price = { score: cheapest && price > 0 ? round3(cheapest / price) : 1, reason: `$${price}${c.quote ? " quoted" : " history median"} vs cheapest $${cheapest}` }
    // quality — the review rollup (vendor_ratings), the loop the review step closes
    const avg = c.rating ? blendedAvg(c.rating.avgAgent, c.rating.avgClient) : null
    factors.quality = avg == null
      ? { score: NEUTRAL, reason: "no ratings yet" }
      : { score: round3(avg / 5), reason: `${avg}★ over ${c.rating!.sample} rated booking(s)${c.rating!.sample < MIN_SAMPLE ? " — thin sample" : ""}` }
    // sla — on-time history incl. no-shows (computeVendorSla)
    factors.sla = !c.sla || c.sla.total === 0
      ? { score: NEUTRAL, reason: "no completed history — unproven, not bad" }
      : { score: round3(c.sla.slaPct / 100), reason: `${c.sla.slaPct}% on time over ${c.sla.total}${c.sla.slaPct < SLA_BREACH_PCT ? " — SLA breach" : ""}` }
    // history with THIS brokerage
    factors.history = c.history.completed === 0
      ? { score: 0, reason: "no completed jobs with this brokerage" }
      : { score: round3(Math.min(1, c.history.completed / 5)), reason: `${c.history.completed} completed job(s) with this brokerage` }
    // preference — the request's preferred_vendors
    factors.preference = preferred.has(c.vendorId) ? { score: 1, reason: "named a preferred vendor on the request" } : { score: 0, reason: "not named preferred" }
    const total = round3(PROCUREMENT_FACTORS.reduce((s, k) => s + PROCUREMENT_FACTOR_WEIGHTS[k] * factors[k].score, 0))
    const top = [...PROCUREMENT_FACTORS].sort((a, b) => PROCUREMENT_FACTOR_WEIGHTS[b] * factors[b].score - PROCUREMENT_FACTOR_WEIGHTS[a] * factors[a].score).slice(0, 2)
    return { vendorId: c.vendorId, name: c.name, total, price, factors, why: top.map((k) => `${k}: ${factors[k].reason}`).join("; ") }
  })
  ranked.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.vendorId.localeCompare(b.vendorId))
  const blindSpots = [...f.blindSpots]
  if (eligible.length === 0) blindSpots.push(`no eligible vendor (${excluded.length} excluded)`)
  return { ranked, excluded, blindSpots, weights: PROCUREMENT_FACTOR_WEIGHTS }
}

// ── AUTONOMY POLICY ──────────────────────────────────────────────────────────────────────────────
export interface ProcurementAutonomyPolicy { enabled: boolean; maxAutoApproveUsd: number; allowedServiceCategories: string[]; note?: string }
export const DEFAULT_PROCUREMENT_AUTONOMY: ProcurementAutonomyPolicy = Object.freeze({ enabled: false, maxAutoApproveUsd: 0, allowedServiceCategories: [] as string[] }) as ProcurementAutonomyPolicy

/** PURE: brokerage_settings.settings → the policy; anything malformed is the default (OFF).
 * @proofSeam scripts/procurement-guard.ts asserts the default-OFF and the category normalisation directly. */
export function resolveProcurementAutonomy(settings: unknown, note?: string): ProcurementAutonomyPolicy {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, any>)[PROCUREMENT_AUTONOMY_POLICY_KEY] : null
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PROCUREMENT_AUTONOMY, ...(note ? { note } : {}) }
  const cap = Number(raw.max_auto_approve_usd)
  const cats = Array.isArray(raw.allowed_service_categories) ? raw.allowed_service_categories.map((c: unknown) => toVendorCategory(String(c))).filter(Boolean) as string[] : []
  return { enabled: raw.enabled === true, maxAutoApproveUsd: Number.isFinite(cap) && cap > 0 ? cap : 0, allowedServiceCategories: cats }
}

async function loadProcurementAutonomy(svc: Svc, brokerageId: string): Promise<ProcurementAutonomyPolicy> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return resolveProcurementAutonomy(null, `policy read refused: ${error.message} — recommendation only`)
  return resolveProcurementAutonomy((data as { settings?: unknown } | null)?.settings ?? null)
}

/** PURE: may THIS purchase book without a human? Every refusal is named.
 * @proofSeam scripts/procurement-guard.ts asserts the cap / category / unknown-price refusals directly. */
export function procurementAutonomyDecision(p: ProcurementAutonomyPolicy, purchase: { category: string | null; amountUsd: number | null }): { auto: boolean; reason: string } {
  if (!p.enabled) return { auto: false, reason: "procurement_autonomy off — recommendation only, agent approval required" }
  if (!purchase.category || !p.allowedServiceCategories.includes(purchase.category)) return { auto: false, reason: `category ${purchase.category ?? "unknown"} not in the policy's allowed categories` }
  if (purchase.amountUsd == null) return { auto: false, reason: "price unknown — never auto-books" }
  if (purchase.amountUsd > p.maxAutoApproveUsd) return { auto: false, reason: `$${purchase.amountUsd} over the $${p.maxAutoApproveUsd} auto-approve cap` }
  return { auto: true, reason: `$${purchase.amountUsd} ≤ $${p.maxAutoApproveUsd} cap, ${purchase.category} allowed` }
}

// ── READERS (one tenant only) ────────────────────────────────────────────────────────────────────
/** @proofSeam scripts/procurement-guard.ts reads the facts to show eligibility exclusions and the review → quality loop. */
export async function gatherProcurementFacts(svc: Svc, input: {
  brokerageId: string; serviceType: string; jobState: string | null; jobZip: string | null
  neededBy?: string | null; budget?: number | null; preferredVendorIds?: string[]; requestId?: string | null; now?: Date
}): Promise<ProcurementRequestFacts> {
  const now = input.now ?? new Date()
  const category = toVendorCategory(input.serviceType)
  const blindSpots: string[] = []
  const facts: ProcurementRequestFacts = {
    serviceCategory: category, jobState: input.jobState, jobZip: input.jobZip, neededBy: input.neededBy ?? null,
    budget: input.budget ?? null, preferredVendorIds: input.preferredVendorIds ?? [], now: now.toISOString(), candidates: [], blindSpots,
  }
  if (!category) { blindSpots.push(`service "${input.serviceType}" maps to no vendor category`); return facts }
  // The tenant's own bench only (global rows are another rail's surfacing question — a published blind spot).
  const { data: vendors, error: vErr } = await svc.from("vendors")
    .select("id, name, category, status, platform_vendor_id, estimated_turnaround_days, compliance_credentials")
    .eq("brokerage_id", input.brokerageId).eq("category", category).limit(200)
  if (vErr) { blindSpots.push(`vendors read refused: ${vErr.message}`); return facts }
  const rows = (vendors ?? []) as Array<Record<string, any>>
  if (rows.length === 0) return facts
  const ids = rows.map((v) => v.id as string)
  const pids = rows.map((v) => v.platform_vendor_id).filter(Boolean) as string[]
  const since = new Date(now.getTime() - 365 * dayMs).toISOString()
  const [subs, areas, ratings, hist, quotes] = await Promise.all([
    svc.from("vendor_subscriptions").select("vendor_id, status").eq("brokerage_id", input.brokerageId).in("vendor_id", ids),
    pids.length ? svc.from("vendor_service_areas").select("platform_vendor_id, state, zip_code, trade_category, status, license, notes").in("platform_vendor_id", pids) : Promise.resolve({ data: [], error: null }),
    svc.from("vendor_ratings").select("vendor_id, avg_agent_rating, avg_client_rating, total_bookings, one_star_count").eq("brokerage_id", input.brokerageId).in("vendor_id", ids),
    svc.from("vendor_bookings").select("vendor_id, service_type, scheduled_date, completed_at, status, cost").eq("brokerage_id", input.brokerageId).in("vendor_id", ids).gte("created_at", since).limit(2000),
    input.requestId ? svc.from("vendor_booking_quotes").select("vendor_id, amount, available_on, status").eq("brokerage_id", input.brokerageId).eq("booking_id", input.requestId) : Promise.resolve({ data: [], error: null }),
  ])
  for (const [name, r] of [["vendor_subscriptions", subs], ["vendor_service_areas", areas], ["vendor_ratings", ratings], ["vendor_bookings history", hist], ["vendor_booking_quotes", quotes]] as const) {
    if ((r as any).error) blindSpots.push(`${name} read refused: ${(r as any).error.message} — scored neutral`)
  }
  // A refused coverage read must not read as "declared nothing" — such a marketplace vendor is excluded honestly.
  const areasRefused = !!(areas as any).error
  const histRows = (((hist as any).data ?? []) as Array<Record<string, any>>).filter((b) => toVendorCategory(b.service_type) === category)
  const turnaround: Record<string, number> = {}
  for (const v of rows) turnaround[v.id] = v.estimated_turnaround_days ?? 1
  const sla = computeVendorSla(histRows as any, turnaround)
  for (const v of rows) {
    const sub = (((subs as any).data ?? []) as any[]).find((s) => s.vendor_id === v.id)
    const rating = (((ratings as any).data ?? []) as any[]).find((r) => r.vendor_id === v.id)
    const quote = (((quotes as any).data ?? []) as any[]).find((q) => q.vendor_id === v.id)
    const mine = histRows.filter((b) => b.vendor_id === v.id)
    facts.candidates.push({
      vendorId: v.id, name: v.name ?? v.id, category: v.category, status: v.status ?? null,
      platformVendorId: v.platform_vendor_id ?? null, turnaroundDays: v.estimated_turnaround_days ?? null,
      subscriptionStatus: sub?.status ?? null,
      coverage: areasRefused ? [] : ((((areas as any).data ?? []) as any[]).filter((a) => a.platform_vendor_id === v.platform_vendor_id)
        .map((a) => ({ state: a.state, zipCode: a.zip_code ?? null, tradeCategory: a.trade_category, status: a.status, license: a.license ?? null, notes: a.notes ?? null }))),
      benchLicense: (v.compliance_credentials as any)?.license ?? null,
      rating: rating ? { avgAgent: rating.avg_agent_rating ?? null, avgClient: rating.avg_client_rating ?? null, sample: rating.total_bookings ?? 0, oneStars: rating.one_star_count ?? 0 } : null,
      history: { completed: mine.filter((b) => b.status === "completed").length, noShows: mine.filter((b) => b.status === "no_show").length, costs: mine.filter((b) => b.status === "completed" && typeof b.cost === "number").map((b) => Number(b.cost)) },
      sla: sla[v.id] ? { slaPct: sla[v.id].slaPct, total: sla[v.id].total } : null,
      quote: quote ? { amount: Number(quote.amount), availableOn: quote.available_on ?? null, status: quote.status } : null,
    })
  }
  return facts
}

// ── EVIDENCE ─────────────────────────────────────────────────────────────────────────────────────
async function ledgered<T extends { ok: boolean; error?: string }>(svc: Svc, ctx: {
  brokerageId: string; action: string; bookingId: string; actorUserId: string | null; reasonCode: string; reasonDetail: string
  policyKey?: string | null; riskClass: string; idempotencyKey: string; detail?: Record<string, unknown>
}, run: () => Promise<T>): Promise<T> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  let replayed = false
  const res = await withActionLedger<T>({
    brokerageId: ctx.brokerageId, action: ctx.action,
    actor: ctx.actorUserId ? { type: "user", userId: ctx.actorUserId } : { type: "manager", managerKey: "listing_concierge" },
    subject: { type: "vendor_booking", id: ctx.bookingId }, reasonCode: ctx.reasonCode, reasonDetail: ctx.reasonDetail.slice(0, 500),
    idempotencyKey: ctx.idempotencyKey, riskClass: ctx.riskClass, systemSource: PROCUREMENT_SOURCE,
    policyKey: ctx.policyKey ?? null, detail: ctx.detail ?? null,
  }, run, {
    settle: (r) => r.ok ? { status: "executed", outcome: ctx.action } : { status: "failed", outcome: "refused", error: r.error ?? null },
    replay: () => { replayed = true; return { ok: false, error: "__replay__" } as T },
  }, { client: svc as any })
  if (replayed) return { ok: false, error: "already done (ledger replay)" } as T
  return res
}

async function emit(svc: Svc, event: string, brokerageId: string, bookingId: string, metadata: Record<string, unknown>, actorUserId: string | null, listingId?: string | null) {
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({ event, brokerageId, entityType: "vendor_booking", entityId: bookingId, actorUserId, source: "system", metadata, auditOnly: true, client: svc as any, ...(listingId ? { listingId } : {}) })
  } catch { /* the ledger row is the consequential evidence */ }
}

// ── 1. REQUEST → RECOMMEND → (APPROVAL | AUTONOMOUS BOOK) ─────────────────────────────────────────
export interface RequestProcurementInput {
  /** The VERIFIED tenant (session / the event's brokerage) — never a body. */
  brokerageId: string
  serviceType: string
  listingId?: string | null
  transactionId?: string | null
  neededBy?: string | null
  budget?: number | null
  requirements?: Record<string, unknown>
  preferredVendorIds?: string[]
  /** users.id of the human asking (the listing agent); null = the concierge raised the need. */
  requestedByUserId?: string | null
  now?: Date
}
export type RequestProcurementResult =
  | { ok: true; bookingId: string; ranking: VendorRanking; approval: "pending" | "auto_approved"; autonomy: string; proposalId: string | null }
  | { ok: false; error: string; ranking?: VendorRanking }

export async function requestProcurement(svc: Svc, input: RequestProcurementInput, opts: {
  /** Entitlement seam — default mayUseAndAfford('app.access'). Fail closed. */
  access?: (i: { brokerageId: string; client: Svc }) => Promise<{ allowed: boolean; reason: string }>
} = {}): Promise<RequestProcurementResult> {
  if (!input.brokerageId) return { ok: false, error: "tenant scope required" }
  const access = opts.access ?? (async (i) => {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    const d = await mayUseAndAfford({ brokerageId: i.brokerageId, capability: "app.access", client: i.client })
    return { allowed: d.allowed, reason: d.reason }
  })
  const gate = await access({ brokerageId: input.brokerageId, client: svc }).catch((e) => ({ allowed: false, reason: `entitlement check threw: ${(e as Error).message}` }))
  if (!gate.allowed) return { ok: false, error: `entitlement refused: ${gate.reason}` }

  // The property, tenant-scoped (a foreign listing is "not found", never a cross-tenant read).
  let jobState: string | null = null, jobZip: string | null = null
  if (input.listingId) {
    const { data: l, error } = await svc.from("listings").select("id, state, zip").eq("id", input.listingId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, error: `listing read refused: ${error.message}` }
    if (!l) return { ok: false, error: "listing not found in this brokerage" }
    jobState = (l as any).state ?? null; jobZip = (l as any).zip ?? null
  }
  const facts = await gatherProcurementFacts(svc, { ...input, jobState, jobZip })
  const ranking = rankVendorsForRequest(facts)
  const top = ranking.ranked[0]
  if (!top) return { ok: false, error: ranking.blindSpots.join("; ") || "no eligible vendor", ranking }

  const policy = await loadProcurementAutonomy(svc, input.brokerageId)
  const decision = procurementAutonomyDecision(policy, { category: facts.serviceCategory, amountUsd: top.price })
  let policyRef: string | null = null
  if (decision.auto) {
    const { resolvePolicyRef } = await import("@/lib/kernel/tenant-policy")
    policyRef = await resolvePolicyRef(svc, input.brokerageId, PROCUREMENT_AUTONOMY_POLICY_KEY).catch(() => PROCUREMENT_AUTONOMY_POLICY_KEY)
  }
  const recommendation = { ranked: ranking.ranked.slice(0, 5), excluded: ranking.excluded, blind_spots: ranking.blindSpots, weights: ranking.weights, autonomy: decision.reason }

  const { data: row, error: insErr } = await svc.from("vendor_bookings").insert({
    brokerage_id: input.brokerageId, vendor_id: top.vendorId, service_type: input.serviceType,
    listing_id: input.listingId ?? null, transaction_id: input.transactionId ?? null,
    needed_by: input.neededBy ?? null, budget: input.budget ?? null, requirements: input.requirements ?? {},
    preferred_vendor_ids: input.preferredVendorIds ?? [], territory: jobState ? { state: jobState, zip: jobZip } : null,
    recommendation, cost: top.price, status: "requested", request_origin: "agent",
    booked_by: input.requestedByUserId ?? null, approval_status: decision.auto ? "auto_approved" : "pending",
    approval_policy_ref: policyRef,
  }).select("id").single()
  if (insErr || !row) return { ok: false, error: `request write refused: ${insErr?.message ?? "no row"}`, ranking }
  const bookingId = (row as { id: string }).id

  const summary = `${input.serviceType}: recommend ${top.name} (score ${top.total}${top.price != null ? `, $${top.price}` : ""}) — ${top.why}`
  await ledgered(svc, {
    brokerageId: input.brokerageId, action: "vendor.procurement.recommend", bookingId, actorUserId: input.requestedByUserId ?? null,
    reasonCode: input.requestedByUserId ? "HUMAN_REQUESTED" : "STAFF_ALERT", reasonDetail: summary, riskClass: "READ",
    idempotencyKey: `procurement.recommend:${bookingId}`, detail: { ranked: ranking.ranked.length, excluded: ranking.excluded.length, autonomy: decision.reason },
  }, async () => ({ ok: true }))
  await emit(svc, "procurement.recommended", input.brokerageId, bookingId, { service_type: input.serviceType, vendor_id: top.vendorId, total: top.total, autonomy: decision.reason }, input.requestedByUserId ?? null, input.listingId)

  if (decision.auto) {
    const booked = await bookProcurement(svc, { brokerageId: input.brokerageId, bookingId, approverUserId: null, policyRef, autonomyReason: decision.reason })
    if (!booked.ok) return { ok: false, error: `autonomous booking refused: ${booked.error}`, ranking }
    return { ok: true, bookingId, ranking, approval: "auto_approved", autonomy: decision.reason, proposalId: null }
  }

  // AGENT APPROVAL — the existing approval queue (agent_client_messages, entity 'vendor_booking').
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const lines = ranking.ranked.slice(0, 3).map((r, i) => `${i + 1}. ${r.name} — score ${r.total}${r.price != null ? `, $${r.price}` : ""}: ${PROCUREMENT_FACTORS.map((k) => `${k} ${r.factors[k].score}`).join(", ")}`)
  const p = await proposeClientMessage({
    brokerageId: input.brokerageId, agentKind: "listing_concierge", entityType: "vendor_booking", entityId: bookingId,
    audience: "agent", channel: "portal",
    subject: `Approve ${input.serviceType}: ${top.name}${top.price != null ? ` ($${top.price})` : ""}`,
    body: [`Recommended vendor for ${input.serviceType}${input.neededBy ? ` (needed by ${input.neededBy})` : ""}:`, ...lines, "", "Approve to book the top pick; reject to decline the request."].join("\n"),
    rationale: `PROCUREMENT — ${summary}. ${decision.reason}.`,
  }, svc)
  if (!p.ok || !p.id) return { ok: false, error: `approval proposal refused: ${p.error ?? "no id"}`, ranking }
  const { error: linkErr } = await svc.from("vendor_bookings").update({ approval_message_id: p.id }).eq("id", bookingId).eq("brokerage_id", input.brokerageId)
  if (linkErr) return { ok: false, error: `approval link refused: ${linkErr.message}`, ranking }
  return { ok: true, bookingId, ranking, approval: "pending", autonomy: decision.reason, proposalId: p.id }
}

// ── 2. BOOK (the existing booking writer) ────────────────────────────────────────────────────────
async function bookProcurement(svc: Svc, a: { brokerageId: string; bookingId: string; approverUserId: string | null; policyRef: string | null; autonomyReason?: string }): Promise<{ ok: boolean; error?: string }> {
  const { updateVendorBookingStatus } = await import("@/lib/kernel/vendors")
  const human = !!a.approverUserId
  return ledgered(svc, {
    brokerageId: a.brokerageId, action: "vendor.procurement.book", bookingId: a.bookingId, actorUserId: a.approverUserId,
    reasonCode: human ? "HUMAN_REQUESTED" : "SERVICE_NOTICE",
    reasonDetail: human ? "agent approved the procurement recommendation" : `booked under procurement_autonomy: ${a.autonomyReason ?? ""}`,
    policyKey: human ? null : PROCUREMENT_AUTONOMY_POLICY_KEY, riskClass: "FINANCIAL", idempotencyKey: `procurement.book:${a.bookingId}`,
  }, async () => {
    const r = await updateVendorBookingStatus({
      bookingId: a.bookingId, brokerageId: a.brokerageId, agentUserId: a.approverUserId, toStatus: "booked", client: svc,
      extra: { booked_at: new Date().toISOString(), approved_at: new Date().toISOString(), approved_by: a.approverUserId, approval_status: human ? "approved" : "auto_approved", ...(a.policyRef ? { approval_policy_ref: a.policyRef } : {}) },
    })
    if (r.success) await emit(svc, "procurement.booked", a.brokerageId, a.bookingId, { approval: human ? "agent" : "policy", policy_ref: a.policyRef }, a.approverUserId)
    return r.success ? { ok: true } : { ok: false, error: r.error }
  })
}

async function readRequest(svc: Svc, brokerageId: string, bookingId: string) {
  const { data, error } = await svc.from("vendor_bookings").select("id, status, approval_status, vendor_id, brokerage_id").eq("id", bookingId).eq("brokerage_id", brokerageId).maybeSingle()
  return { row: data as { id: string; status: string; approval_status: string | null; vendor_id: string } | null, error }
}

/** Called by approveClientMessage when the agent approves the procurement proposal. */
export async function approveProcurementRequest(svc: Svc, a: { brokerageId: string; bookingId: string; approverUserId: string | null }): Promise<{ ok: boolean; error?: string; notProcurement?: boolean }> {
  const { row, error } = await readRequest(svc, a.brokerageId, a.bookingId)
  if (error) return { ok: false, error: error.message }
  if (!row) return { ok: false, error: "request not found in this brokerage" }
  if (row.status !== "requested") return { ok: false, notProcurement: true, error: `status ${row.status}` }
  return bookProcurement(svc, { brokerageId: a.brokerageId, bookingId: a.bookingId, approverUserId: a.approverUserId, policyRef: null })
}

/** Called by rejectClientMessage — the agent said no: requested → cancelled, approval declined. */
export async function declineProcurementRequest(svc: Svc, a: { brokerageId: string; bookingId: string; approverUserId: string; reason: string | null }): Promise<{ ok: boolean; error?: string; notProcurement?: boolean }> {
  const { row, error } = await readRequest(svc, a.brokerageId, a.bookingId)
  if (error) return { ok: false, error: error.message }
  if (!row) return { ok: false, error: "request not found in this brokerage" }
  if (row.status !== "requested") return { ok: false, notProcurement: true, error: `status ${row.status}` }
  const { updateVendorBookingStatus } = await import("@/lib/kernel/vendors")
  return ledgered(svc, {
    brokerageId: a.brokerageId, action: "vendor.procurement.decline", bookingId: a.bookingId, actorUserId: a.approverUserId,
    reasonCode: "HUMAN_REQUESTED", reasonDetail: a.reason ?? "agent declined the recommendation", riskClass: "LOW_RISK_WRITE", idempotencyKey: `procurement.decline:${a.bookingId}`,
  }, async () => {
    const r = await updateVendorBookingStatus({ bookingId: a.bookingId, brokerageId: a.brokerageId, agentUserId: a.approverUserId, toStatus: "cancelled", client: svc, extra: { approval_status: "declined", approved_by: a.approverUserId, approved_at: new Date().toISOString() } })
    return r.success ? { ok: true } : { ok: false, error: r.error }
  })
}

// ── 3. QUOTES (vendor side — the door gates with requireVendorActor first) ────────────────────────
/** A vendor quotes on a request it is a candidate for. `actor` is requireVendorActor's VERIFIED context. */
export async function submitProcurementQuote(svc: Svc, actor: { vendorId: string; brokerageId: string; userId: string }, q: { bookingId: string; amount: number; availableOn?: string | null; notes?: string | null }): Promise<{ ok: boolean; error?: string; quoteId?: string }> {
  if (!(q.amount >= 0)) return { ok: false, error: "amount must be ≥ 0" }
  const { data: b, error } = await svc.from("vendor_bookings").select("id, status, vendor_id, recommendation").eq("id", q.bookingId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, error: error.message }
  const row = b as { status: string; vendor_id: string; recommendation: { ranked?: Array<{ vendorId: string }> } | null } | null
  const candidate = !!row && (row.vendor_id === actor.vendorId || (row.recommendation?.ranked ?? []).some((r) => r.vendorId === actor.vendorId))
  if (!row || !candidate) return { ok: false, error: "request not found in your scope" }
  if (row.status !== "requested") return { ok: false, error: `request is ${row.status} — quotes are closed` }
  const { data: ins, error: qErr } = await svc.from("vendor_booking_quotes").upsert({
    brokerage_id: actor.brokerageId, booking_id: q.bookingId, vendor_id: actor.vendorId, amount: q.amount,
    available_on: q.availableOn ?? null, notes: q.notes ?? null, status: "submitted", updated_at: new Date().toISOString(),
  }, { onConflict: "booking_id,vendor_id" }).select("id")
  if (qErr || !ins || (ins as unknown[]).length === 0) return { ok: false, error: `quote refused: ${qErr?.message ?? "no row"}` }
  await emit(svc, "procurement.quoted", actor.brokerageId, q.bookingId, { vendor_id: actor.vendorId, amount: q.amount }, actor.userId)
  return { ok: true, quoteId: (ins as Array<{ id: string }>)[0].id }
}

/** What a vendor may see: the requests it is the pick or a candidate for, and ONLY its own quotes. */
export async function vendorProcurementView(svc: Svc, actor: { vendorId: string; brokerageId: string }): Promise<{ ok: boolean; error?: string; requests: Array<{ id: string; service_type: string; status: string; needed_by: string | null; requirements: unknown; myQuote: { amount: number; available_on: string | null; status: string } | null }> }> {
  const { data, error } = await svc.from("vendor_bookings").select("id, service_type, status, needed_by, requirements, vendor_id, recommendation").eq("brokerage_id", actor.brokerageId).eq("status", "requested").limit(200)
  if (error) return { ok: false, error: error.message, requests: [] }
  const mine = ((data ?? []) as any[]).filter((r) => r.vendor_id === actor.vendorId || (r.recommendation?.ranked ?? []).some((c: any) => c.vendorId === actor.vendorId))
  const { data: qs, error: qErr } = await svc.from("vendor_booking_quotes").select("booking_id, amount, available_on, status").eq("brokerage_id", actor.brokerageId).eq("vendor_id", actor.vendorId)
  if (qErr) return { ok: false, error: qErr.message, requests: [] }
  // Budget, competitors, scores and other vendors' quotes never leave this function.
  return { ok: true, requests: mine.map((r) => {
    const q = ((qs ?? []) as any[]).find((x) => x.booking_id === r.id)
    return { id: r.id, service_type: r.service_type, status: r.status, needed_by: r.needed_by ?? null, requirements: r.requirements ?? {}, myQuote: q ? { amount: Number(q.amount), available_on: q.available_on ?? null, status: q.status } : null }
  }) }
}

// ── 4. COMPLETION → PAYMENT → REVIEW: THE SURVIVORS, NOT A SECOND DOOR ───────────────────────────
// Once booked, a procurement request is an ordinary vendor_booking, so it rides the doors that already
// exist — none is duplicated here (this lane's draft had completeProcurement / reviewProcurement /
// loadProcurementRequest; deleted before landing — second spellings of these, with no product caller):
//   completion  app/actions/vendor-marketplace.ts markBookingComplete (the vendor jobs surface) and
//               lib/kernel/vendors.ts updateVendorBookingStatus (→ completed, completed_at)
//   payment     app/actions/vendor-payments.ts createVendorInvoice (vendor_invoices.booking_id) →
//               markInvoicePaid → vendor_earnings → initiateVendorPayout (vendor_payouts)
//   review      app/actions/vendor-marketplace.ts rateVendorBooking / app/actions/contact-vendor-booking.ts
//               rateVendorBookingAsClient → vendor_bookings.agent_rating | client_rating →
//               lib/vendor-marketplace/vendor-ratings.ts recalculateVendorRatingsCore → vendor_ratings,
//               which gatherProcurementFacts reads as the QUALITY factor on the next request (the loop).
