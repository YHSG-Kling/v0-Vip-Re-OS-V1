// lib/platform/trial-funnel.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELF-SERVE TRIAL FUNNEL resolution — server-only (service client), no "use
// server". The funnel rule is deliberately tiny and honest:
//
//   • Each tier's funnel snapshot = the NEWEST platform_config_snapshots row
//     whose payload.recommendedTier === that tier ("newest per tier wins" —
//     staff change what a self-serve signup gets by capturing a new snapshot,
//     no extra assignment table). No snapshot for a tier ⇒ the funnel still
//     works, the tenant just starts from unbranded defaults.
//   • Coupon validation reuses the ONE pure rule set in lib/platform/coupons
//     (validateCouponForRedemption) against the live platform_coupons row, so
//     the public funnel can never accept a code the superadmin rail would
//     refuse. Redemption itself is recorded by the signup action.
//
// The newest-per-tier rule is a PURE exported function so it is unit-testable
// and so server surfaces (get-started page, signup action) share one resolver.

import { createServiceClient } from "@/lib/supabase/service"
import { CANONICAL_TIERS } from "@/lib/billing/plan-catalog"
import {
  normalizeCouponCode,
  isValidCouponCode,
  validateCouponForRedemption,
  describeCoupon,
  type PlatformCoupon,
  type RedemptionFailReason,
} from "@/lib/platform/coupons"
import type { SnapshotPayload } from "@/lib/platform/config-snapshots"

type Svc = ReturnType<typeof createServiceClient>

/** The columns the funnel needs from platform_coupons (mirrors the superadmin action). */
const COUPON_COLS =
  "id, code, description, percent_off, amount_off_cents, duration, duration_months, applies_to_tier, max_redemptions, redeemed_count, expires_at, active, stripe_coupon_id"

// ── PURE: newest-snapshot-per-tier resolution ────────────────────────────────

export interface FunnelSnapshotCandidate {
  id: string
  recommendedTier: string | null
  createdAt: string
}

/**
 * PURE: resolve which snapshot is LIVE for each canonical tier — the newest
 * (created_at) row recommending that tier wins. Rows with no/unknown
 * recommendedTier never win. Input order does not matter.
 */
export function resolveNewestPerTier<T extends FunnelSnapshotCandidate>(rows: T[]): Map<string, T> {
  const byTier = new Map<string, T>()
  for (const r of rows) {
    if (!r.recommendedTier || !(CANONICAL_TIERS as readonly string[]).includes(r.recommendedTier)) continue
    const cur = byTier.get(r.recommendedTier)
    if (!cur || Date.parse(r.createdAt) > Date.parse(cur.createdAt)) byTier.set(r.recommendedTier, r)
  }
  return byTier
}

// ── Per-tier snapshot lookup ─────────────────────────────────────────────────

export interface FunnelSnapshot {
  id: string
  name: string
  createdAt: string
  payload: SnapshotPayload
}

/**
 * The snapshot a self-serve signup on `tier` gets: the NEWEST snapshot whose
 * payload.recommendedTier === tier. Returns null when no snapshot recommends
 * the tier (funnel still provisions — just unbranded defaults) or the tier is
 * not canonical.
 */
export async function snapshotForTier(tier: string, client?: Svc): Promise<FunnelSnapshot | null> {
  if (!(CANONICAL_TIERS as readonly string[]).includes(tier)) return null
  const svc = client ?? createServiceClient()
  const { data, error } = await svc
    .from("platform_config_snapshots")
    .select("id, name, payload, created_at")
    .eq("payload->>recommendedTier", tier)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return {
    id: (data as any).id,
    name: (data as any).name,
    createdAt: (data as any).created_at,
    payload: ((data as any).payload ?? {}) as SnapshotPayload,
  }
}

/** Lightweight per-tier row for UIs (no payload — never ship payloads to a public page). */
export interface FunnelTierSnapshotRef {
  id: string
  name: string
  createdAt: string
  tier: string
}

/**
 * All LIVE funnel snapshots keyed by tier (newest per tier wins) — what the
 * get-started page uses to attach the right snapshot id to each tier card and
 * what staff surfaces show as "this is what a self-serve signup gets".
 */
export async function liveFunnelSnapshots(client?: Svc): Promise<Record<string, FunnelTierSnapshotRef>> {
  const svc = client ?? createServiceClient()
  const { data, error } = await svc
    .from("platform_config_snapshots")
    .select("id, name, created_at, payload")
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) return {}
  const candidates = ((data ?? []) as any[]).map((s) => ({
    id: s.id as string,
    name: (s.name as string) ?? "(unnamed)",
    createdAt: s.created_at as string,
    recommendedTier: (((s.payload ?? {}) as SnapshotPayload).recommendedTier ?? null) as string | null,
  }))
  const winners = resolveNewestPerTier(candidates)
  const out: Record<string, FunnelTierSnapshotRef> = {}
  for (const [tier, row] of winners) out[tier] = { id: row.id, name: row.name, createdAt: row.createdAt, tier }
  return out
}

// ── Public coupon validation (read-only — redemption happens at signup) ──────

export type FunnelCouponCheck =
  | {
      ok: true
      couponId: string
      /** Normalized code (what the signup should submit). */
      code: string
      /** "20% off for 3 months" — pure describeCoupon output. */
      summary: string
      coupon: PlatformCoupon & { id: string }
    }
  | { ok: false; reason: RedemptionFailReason | "invalid_code" | "not_found"; message: string }

/**
 * Validate a coupon code for a prospective signup on `tier` against the live
 * platform_coupons row. Pure rules come from validateCouponForRedemption —
 * the same ones the superadmin redemption path enforces. Read-only: nothing
 * is redeemed here (the signup action records the redemption).
 */
export async function validateFunnelCoupon(code: string, tier: string, client?: Svc): Promise<FunnelCouponCheck> {
  const normalized = normalizeCouponCode(code)
  if (!isValidCouponCode(normalized)) {
    return { ok: false, reason: "invalid_code", message: "Codes are 3-32 characters: letters, numbers, '-' or '_'" }
  }
  const svc = client ?? createServiceClient()
  const { data, error } = await svc
    .from("platform_coupons")
    .select(COUPON_COLS)
    .eq("code", normalized)
    .maybeSingle()
  if (error) return { ok: false, reason: "not_found", message: `Couldn't check code ${normalized} — try again` }
  const coupon = data as unknown as (PlatformCoupon & { id: string }) | null
  if (!coupon) return { ok: false, reason: "not_found", message: `${normalized} isn't a current offer code` }

  // A prospect has no brokerage yet, so existingRedemption is always false —
  // the UNIQUE(coupon_id, brokerage_id) constraint still guards the real insert.
  const check = validateCouponForRedemption(coupon, { tier, now: new Date(), existingRedemption: false })
  if (!check.ok) return { ok: false, reason: check.reason, message: check.message }

  return { ok: true, couponId: coupon.id, code: normalized, summary: describeCoupon(coupon), coupon }
}
