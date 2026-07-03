// lib/vendors/marketplace-fee.ts
//
// MARKETPLACE TAKE-RATE — the vendor marketplace's income stream. Every completed booking that flows
// through the platform earns a platform fee (the take-rate), split from the vendor's gross into a
// platform fee + the vendor's net payout. Two things were broken before this: (1) the fee was only ever
// computed on a MANUAL invoice, never on a real completed booking, and (2) that one path resolved the
// rate by matching a vendors.id against vendor_marketplace_profiles.id (different id spaces) so the
// platform fee was silently ALWAYS $0. This centralizes the rate resolution + the pure split so both the
// booking capture and the invoice path share one correct, non-zero source of truth.
//
// Rate precedence (first that applies): the vendor's negotiated revenue_share_percent on their
// marketplace profile → their default_revenue_share_percent → the PLATFORM DEFAULT take-rate. So the
// income stream is live from day one (platform default), and a vendor who negotiates a different share
// overrides it. Honest: a gross of 0 earns 0; a rate is clamped to [0, 100].

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Platform default marketplace take-rate (%). Applied when a vendor has no negotiated share on file.
 *  Deliberately lean for a broker-driven B2B marketplace — the brokerage brings the volume, the vendor
 *  keeps the lion's share, and the platform earns a fair clip on the trust + tooling it provides. */
export const PLATFORM_DEFAULT_TAKE_RATE_PCT = 10

export interface MarketplaceFee {
  gross: number
  platformFee: number
  net: number
  takeRatePct: number
}

/** PURE: split a gross booking amount into the platform fee + the vendor's net, at a take-rate %. */
export function computeMarketplaceFee(params: { grossAmount: number | null; takeRatePct: number | null }): MarketplaceFee {
  const gross = Math.max(0, Math.round(((params.grossAmount ?? 0)) * 100) / 100)
  const pct = Math.min(100, Math.max(0, params.takeRatePct ?? 0))
  const platformFee = Math.round(gross * (pct / 100) * 100) / 100
  const net = Math.round((gross - platformFee) * 100) / 100
  return { gross, platformFee, net, takeRatePct: pct }
}

export interface ResolvedRate { pct: number; source: "vendor_profile" | "platform_default" }

/**
 * Resolve the take-rate for a booking's vendor. Bridges the vendors.id (what a booking references) to the
 * vendor's marketplace profile through user_role_assignments (vendor_id ↔ user_id), reading the negotiated
 * or default share off the profile; falls back to the platform default when the vendor has no profile /
 * share on file. Best-effort — any lookup miss lands on the platform default (a live, honest rate).
 */
export async function resolveVendorRevenueShare(svc: Svc, vendorId: string): Promise<ResolvedRate> {
  try {
    const { data: link } = await svc
      .from("user_role_assignments").select("user_id").eq("vendor_id", vendorId).not("user_id", "is", null).limit(1).maybeSingle()
    const userId = (link as any)?.user_id ?? null
    if (userId) {
      const { data: profile } = await svc
        .from("vendor_marketplace_profiles").select("revenue_share_percent, default_revenue_share_percent").eq("user_id", userId).maybeSingle()
      const share = (profile as any)?.revenue_share_percent ?? (profile as any)?.default_revenue_share_percent ?? null
      if (share != null && Number(share) > 0) return { pct: Number(share), source: "vendor_profile" }
    }
  } catch { /* fall through to the platform default */ }
  return { pct: PLATFORM_DEFAULT_TAKE_RATE_PCT, source: "platform_default" }
}
