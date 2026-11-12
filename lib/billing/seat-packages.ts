// lib/billing/seat-packages.ts
// ─────────────────────────────────────────────────────────────────────────────
// STRIPE IS THE CATALOGUE SOURCE, AND THE SUBSCRIPTION ITEMS ARE THE TENANT'S
// TRUTH (wave 79A, owner verbatim 2026-09-23: "subscriptions will be setup in
// stripe so they sync"). PURE derivations only — no Stripe client, no
// database — so the webhook, the daily reconcile and the superadmin sync
// action all read a Stripe subscription or price list the SAME way, and the
// proof (scripts/seat-packages-guard.ts) drives them with fixtures.
//
// THE MODEL, in Stripe's own terms (docs.stripe.com/billing/subscriptions/
// quantities, per-seat-pricing): one subscription, two licensed items —
//   · the PLAN item: the tier's price (subscription_tiers.stripe_price_id or,
//     on the custom tier, a tenant-specific price), quantity 1
//   · the SEAT item: the tier's seat-package price
//     (subscription_tiers.stripe_seat_price_id), quantity = packages bought,
//     `seat_package_size` seats per unit
// A quantity change on the seat item prorates (create_prorations) — the
// tenant pays for the remainder of the period, exactly what adding a seat
// mid-month should cost.
//
// PRICE → TIER MAPPING is by price metadata, which the publish action already
// writes (`tier_name`) and which the superadmin sets on a seat price in the
// Stripe dashboard: `kind = seat_package`, `seat_package_size = <n>`. A price
// with no tier_name is reported as unmatched, never guessed.

import { CANONICAL_TIERS, type CanonicalTierName } from "./plan-catalog"
import { toStoredSubscriptionStatus } from "./stripe-status"
import type { NormalizedStripeSub } from "./subscription-activation"

// ── Shapes the Stripe SDK objects are narrowed to (so fixtures can be small) ──

export interface StripeItemFacts {
  id: string
  priceId: string
  quantity: number
  /** price.metadata as Stripe returns it */
  metadata?: Record<string, string> | null
}

export interface StripePriceFactsForCatalog {
  id: string
  active: boolean
  unitAmount: number | null
  currency: string | null
  interval: "month" | "year" | string | null
  usageType: "licensed" | "metered" | string | null
  metadata: Record<string, string>
  productName: string | null
  productMetadata: Record<string, string>
  /** price.transform_quantity.divide_by — Stripe's "per package of N" knob. */
  transformDivideBy: number | null
}

/** The catalogue columns a derivation needs — one row per tier. */
export interface TierSeatLink {
  id: string
  tier_name: string
  stripe_price_id: string | null
  stripe_seat_price_id: string | null
  seat_package_size: number | null
}

/** Narrow a Stripe subscription's items to the facts above. Tolerates the
 *  SDK's string-or-object `price` and a missing quantity (Stripe omits it on
 *  metered items — which are never seat items here). */
export function itemFactsOf(sub: { items?: { data?: any[] } | null } | null | undefined): StripeItemFacts[] {
  const data = sub?.items?.data ?? []
  const out: StripeItemFacts[] = []
  for (const it of data) {
    const price = it?.price
    const priceId = typeof price === "string" ? price : price?.id
    if (!it?.id || !priceId) continue
    out.push({
      id: String(it.id),
      priceId: String(priceId),
      quantity: Number.isFinite(Number(it.quantity)) ? Math.max(0, Math.floor(Number(it.quantity))) : 0,
      metadata: typeof price === "object" && price?.metadata ? price.metadata : null,
    })
  }
  return out
}

// ── The tenant's seat state, derived from the items ─────────────────────────

export interface DerivedSeatState {
  /** subscription_tiers.id the plan item resolves to; null when no item matches. */
  tierId: string | null
  tierName: CanonicalTierName | null
  /** The plan item's price (what the tenant is actually charged for the plan). */
  basePriceId: string | null
  /** The seat-package item, when present. */
  seatItemId: string | null
  seatPackages: number
  extraSeats: number
  /** Items that matched neither a plan price nor a seat price (reported, never silently dropped). */
  unmatchedPriceIds: string[]
  /** How the tier was found — an audit fact, not a branch for callers. */
  tierSource: "plan_item" | "price_metadata" | "none"
}

/**
 * PURE: read the tenant's tier and purchased seats OFF the Stripe items.
 *   1. an item whose price is a tier's stripe_price_id        → the tier
 *   2. else an item whose price metadata.tier_name is canonical
 *      and metadata.kind ≠ seat_package                        → the tier
 *   3. an item whose price is a tier's stripe_seat_price_id    → seat packages
 *      (quantity × that tier's seat_package_size; the SEAT tier must be the
 *      plan tier — a seat pack from another tier is reported unmatched)
 * Nothing is inferred from a bare amount.
 */
export function deriveSubscriptionSeatState(items: StripeItemFacts[], tiers: TierSeatLink[]): DerivedSeatState {
  const byPlanPrice = new Map<string, TierSeatLink>()
  const bySeatPrice = new Map<string, TierSeatLink>()
  const byName = new Map<string, TierSeatLink>()
  for (const t of tiers) {
    if (t.stripe_price_id) byPlanPrice.set(t.stripe_price_id, t)
    if (t.stripe_seat_price_id) bySeatPrice.set(t.stripe_seat_price_id, t)
    byName.set(t.tier_name, t)
  }
  const isCanonical = (n: string | null | undefined): n is CanonicalTierName => !!n && (CANONICAL_TIERS as readonly string[]).includes(n)

  let plan: { tier: TierSeatLink; priceId: string; source: "plan_item" | "price_metadata" } | null = null
  const seatItems: Array<{ item: StripeItemFacts; tier: TierSeatLink }> = []
  const unmatched: string[] = []

  for (const it of items) {
    const seatTier = bySeatPrice.get(it.priceId)
    if (seatTier) { seatItems.push({ item: it, tier: seatTier }); continue }
    const planTier = byPlanPrice.get(it.priceId)
    if (planTier) { if (!plan) plan = { tier: planTier, priceId: it.priceId, source: "plan_item" }; else unmatched.push(it.priceId); continue }
    const kind = (it.metadata?.kind ?? "").trim()
    const name = (it.metadata?.tier_name ?? "").trim()
    if (kind !== "seat_package" && isCanonical(name) && byName.has(name)) {
      if (!plan) plan = { tier: byName.get(name)!, priceId: it.priceId, source: "price_metadata" }
      else unmatched.push(it.priceId)
      continue
    }
    unmatched.push(it.priceId)
  }

  let seatItemId: string | null = null
  let seatPackages = 0
  let extraSeats = 0
  for (const s of seatItems) {
    // A seat pack belongs to the plan it was sold on. One matching seat item
    // is the rule; a second (or one from another tier) is reported.
    if (plan && s.tier.id === plan.tier.id && !seatItemId) {
      seatItemId = s.item.id
      seatPackages = s.item.quantity
      const size = Number(s.tier.seat_package_size)
      extraSeats = Number.isInteger(size) && size >= 1 ? seatPackages * size : 0
    } else {
      unmatched.push(s.item.priceId)
    }
  }

  return {
    tierId: plan?.tier.id ?? null,
    tierName: plan && isCanonical(plan.tier.tier_name) ? plan.tier.tier_name : null,
    basePriceId: plan?.priceId ?? null,
    seatItemId,
    seatPackages,
    extraSeats,
    unmatchedPriceIds: unmatched,
    tierSource: plan?.source ?? "none",
  }
}

// ── The ONE normalizer for a Stripe subscription (merged from the webhook) ──
//
// TOMBSTONE: app/api/billing/webhook/route.ts carried a private `normalizeSub`
// with exactly this shape. The daily reconcile needs the same reading, so the
// function moved HERE (the survivor) and the route imports it; the seat facts
// ride on the same object so the webhook and the reconcile cannot disagree
// about what a Stripe subscription says.

export function normalizeStripeSubscription(
  s: any,
  seat?: DerivedSeatState | null,
  fallbackTierId?: string | null,
): NormalizedStripeSub {
  return {
    stripeSubscriptionId: String(s.id),
    stripeCustomerId: typeof s.customer === "string" ? s.customer : (s.customer?.id ?? null),
    // The ITEMS say which tier the tenant is billed for; metadata.tier_id is
    // the fallback for a subscription minted before prices were linked.
    tierId: seat?.tierId ?? fallbackTierId ?? s.metadata?.tier_id ?? null,
    status: toStoredSubscriptionStatus(s.status),
    currentPeriodStart: s.current_period_start ?? s.items?.data?.[0]?.current_period_start ?? null,
    currentPeriodEnd: s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null,
    trialEnd: s.trial_end ?? null,
    cancelAt: s.cancel_at ?? null,
    ...(seat
      ? {
          stripePriceId: seat.basePriceId,
          stripeSeatItemId: seat.seatItemId,
          seatPackages: seat.seatPackages,
          extraSeats: seat.extraSeats,
        }
      : {}),
  }
}

// ── The catalogue, from Stripe's price list ─────────────────────────────────

export interface TierCatalogPatch {
  tierName: CanonicalTierName
  patch: {
    stripe_price_id?: string
    monthly_price_cents?: number
    annual_price_cents?: number
    stripe_seat_price_id?: string
    seat_package_price_cents?: number
    seat_package_size?: number
  }
}

export interface CatalogFromStripe {
  patches: TierCatalogPatch[]
  /** Active recurring prices the mapping could not place (no tier_name, unknown tier, metered…). */
  unmatched: Array<{ priceId: string; reason: string }>
  /** Tiers with no plan price in Stripe at all — reported so a "synced" catalogue is never read as complete. */
  tiersWithoutPlanPrice: CanonicalTierName[]
}

/**
 * PURE: Stripe → subscription_tiers patches. Only ACTIVE, LICENSED, RECURRING
 * prices in USD are considered. A price is a PLAN price when metadata.kind is
 * absent or 'plan'; a SEAT price when metadata.kind = 'seat_package' — its
 * package size comes from metadata.seat_package_size, else
 * transform_quantity.divide_by, else 1 seat per unit. Monthly plan prices
 * become stripe_price_id + monthly_price_cents; yearly ones annual_price_cents
 * (the subscription's base item is the monthly price — the same interval rule
 * comparePlanPriceToStripe uses). When Stripe holds several prices for one
 * slot, the NEWEST wins (callers pass prices newest-first, as Stripe lists them).
 */
export function catalogFromStripePrices(prices: StripePriceFactsForCatalog[]): CatalogFromStripe {
  const patches = new Map<CanonicalTierName, TierCatalogPatch["patch"]>()
  const unmatched: CatalogFromStripe["unmatched"] = []
  const isCanonical = (n: string): n is CanonicalTierName => (CANONICAL_TIERS as readonly string[]).includes(n)
  const seen = { plan_month: new Set<string>(), plan_year: new Set<string>(), seat: new Set<string>() }

  for (const p of prices) {
    if (!p.active) continue
    if (!p.interval) { unmatched.push({ priceId: p.id, reason: "not recurring" }); continue }
    if ((p.usageType ?? "licensed") !== "licensed") { unmatched.push({ priceId: p.id, reason: "metered price — seats are licensed" }); continue }
    if ((p.currency ?? "usd").toLowerCase() !== "usd") { unmatched.push({ priceId: p.id, reason: `currency ${p.currency}` }); continue }
    const tierName = (p.metadata.tier_name ?? p.productMetadata.tier_name ?? "").trim()
    if (!tierName) { unmatched.push({ priceId: p.id, reason: "no tier_name metadata" }); continue }
    if (!isCanonical(tierName)) { unmatched.push({ priceId: p.id, reason: `unknown tier '${tierName}'` }); continue }
    if (p.unitAmount == null || !Number.isInteger(p.unitAmount) || p.unitAmount < 0) { unmatched.push({ priceId: p.id, reason: "no unit_amount" }); continue }
    const kind = (p.metadata.kind ?? p.productMetadata.kind ?? "plan").trim()
    const cur = patches.get(tierName) ?? {}

    if (kind === "seat_package") {
      if (p.interval !== "month") { unmatched.push({ priceId: p.id, reason: "seat package must be monthly" }); continue }
      if (seen.seat.has(tierName)) { unmatched.push({ priceId: p.id, reason: `older seat price for ${tierName} (newest wins)` }); continue }
      seen.seat.add(tierName)
      const metaSize = Number(p.metadata.seat_package_size ?? p.productMetadata.seat_package_size)
      const size = Number.isInteger(metaSize) && metaSize >= 1 ? metaSize
        : (p.transformDivideBy && Number.isInteger(p.transformDivideBy) && p.transformDivideBy >= 1 ? p.transformDivideBy : 1)
      cur.stripe_seat_price_id = p.id
      cur.seat_package_price_cents = p.unitAmount
      cur.seat_package_size = size
    } else if (kind === "plan") {
      const slot = p.interval === "year" ? "plan_year" : "plan_month"
      if (seen[slot].has(tierName)) { unmatched.push({ priceId: p.id, reason: `older ${p.interval}ly plan price for ${tierName} (newest wins)` }); continue }
      seen[slot].add(tierName)
      if (p.interval === "year") cur.annual_price_cents = p.unitAmount
      else { cur.stripe_price_id = p.id; cur.monthly_price_cents = p.unitAmount }
    } else {
      unmatched.push({ priceId: p.id, reason: `unknown kind '${kind}'` })
      continue
    }
    patches.set(tierName, cur)
  }

  const tiersWithoutPlanPrice = CANONICAL_TIERS.filter((t) => !patches.get(t)?.stripe_price_id)
  return {
    patches: [...patches.entries()].map(([tierName, patch]) => ({ tierName, patch })),
    unmatched,
    tiersWithoutPlanPrice: [...tiersWithoutPlanPrice],
  }
}

/** Narrow a Stripe SDK price (with product expanded) to the catalogue facts. */
export function priceFactsOf(price: any): StripePriceFactsForCatalog {
  const product = typeof price?.product === "object" && price.product ? price.product : null
  return {
    id: String(price?.id ?? ""),
    active: price?.active !== false,
    unitAmount: typeof price?.unit_amount === "number" ? price.unit_amount : null,
    currency: price?.currency ?? null,
    interval: price?.recurring?.interval ?? null,
    usageType: price?.recurring?.usage_type ?? null,
    metadata: (price?.metadata ?? {}) as Record<string, string>,
    productName: product?.name ?? null,
    productMetadata: (product?.metadata ?? {}) as Record<string, string>,
    transformDivideBy: typeof price?.transform_quantity?.divide_by === "number" ? price.transform_quantity.divide_by : null,
  }
}

// ── Reconcile: what the DB row must become to match Stripe ──────────────────

export interface SeatRowFacts {
  tier_id: string | null
  seat_packages: number | null
  extra_seats: number | null
  stripe_seat_item_id: string | null
  stripe_price_id: string | null
}

/** PURE: the patch that makes a subscriptions row agree with the derived
 *  Stripe state, or null when it already does. A derivation with NO tier
 *  (no item matched) never nulls the row's tier — that is "we could not
 *  read", not "there is no plan". */
export function seatRowPatch(row: SeatRowFacts, derived: DerivedSeatState): Partial<SeatRowFacts> | null {
  const patch: Partial<SeatRowFacts> = {}
  if (derived.tierId && derived.tierId !== row.tier_id) patch.tier_id = derived.tierId
  if ((row.seat_packages ?? 0) !== derived.seatPackages) patch.seat_packages = derived.seatPackages
  if ((row.extra_seats ?? 0) !== derived.extraSeats) patch.extra_seats = derived.extraSeats
  if ((row.stripe_seat_item_id ?? null) !== derived.seatItemId) patch.stripe_seat_item_id = derived.seatItemId
  if (derived.basePriceId && derived.basePriceId !== row.stripe_price_id) patch.stripe_price_id = derived.basePriceId
  return Object.keys(patch).length === 0 ? null : patch
}
