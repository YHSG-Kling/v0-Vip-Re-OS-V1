// lib/vendors/marketplace-earnings-capture.ts
//
// MARKETPLACE EARNINGS CAPTURE (finance_manager) — turns the marketplace's take-rate into a real,
// recurring income stream. Every COMPLETED vendor booking with a cost should earn the platform its fee;
// previously only a manual invoice did (and even that computed $0 from an id-mismatch bug). This sweeps
// completed bookings that don't yet have an earning and creates ONE vendor_earnings row each — gross =
// the booking cost, platform_fee = gross × the resolved take-rate, net = the vendor's payout — idempotent
// per booking (m260 booking_id + unique index). Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import { computeMarketplaceFee, resolveVendorRevenueShare } from "@/lib/vendors/marketplace-fee"

type Svc = ReturnType<typeof createServiceClient>

export interface MarketplaceCaptureResult { scanned: number; captured: number; platformRevenue: number }

/** Capture platform earnings for a brokerage's completed, un-earned bookings. */
export async function captureCompletedBookingEarnings(
  svc: Svc, params: { brokerageId: string },
): Promise<MarketplaceCaptureResult> {
  const out: MarketplaceCaptureResult = { scanned: 0, captured: 0, platformRevenue: 0 }

  // Completed bookings with a real cost. (A booking is the unit of marketplace activity; cost is the gross.)
  const { data: bookings } = await svc
    .from("vendor_bookings")
    .select("id, vendor_id, cost")
    .eq("brokerage_id", params.brokerageId).eq("status", "completed").not("cost", "is", null).gt("cost", 0).limit(2000)
  if (!bookings || bookings.length === 0) return out

  // Which of these already have an earning (idempotency — never double-charge a booking).
  const ids = (bookings as any[]).map((b) => b.id)
  const { data: existing } = await svc.from("vendor_earnings").select("booking_id").in("booking_id", ids)
  const earned = new Set(((existing ?? []) as any[]).map((e) => e.booking_id).filter(Boolean))

  for (const b of bookings as any[]) {
    out.scanned++
    if (earned.has(b.id)) continue
    const rate = await resolveVendorRevenueShare(svc, b.vendor_id)
    const fee = computeMarketplaceFee({ grossAmount: b.cost, takeRatePct: rate.pct })

    const { error } = await svc.from("vendor_earnings").insert({
      vendor_id: b.vendor_id, brokerage_id: params.brokerageId, booking_id: b.id,
      gross_amount: fee.gross, platform_fee: fee.platformFee, net_amount: fee.net, status: "pending",
    })
    // A unique-violation means a concurrent run already captured it — treat as success, not an error.
    if (!error) { out.captured++; out.platformRevenue += fee.platformFee }
  }
  return out
}

/** Autonomous: capture across every brokerage (rides the daily vendor-orchestration cron). */
export async function captureCompletedBookingEarningsAll(svc: Svc): Promise<{ brokerages: number; captured: number; platformRevenue: number }> {
  const out = { brokerages: 0, captured: 0, platformRevenue: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await captureCompletedBookingEarnings(svc, { brokerageId: b.id }); out.captured += r.captured; out.platformRevenue += r.platformRevenue } catch { /* keep going */ }
  }
  return out
}
