// lib/kernel/vendor-sla.ts
//
// VENDOR SLA — the SINGLE source of truth for "how reliable is this vendor." on-time % = completed by
// (scheduled_date + the vendor's committed turnaround). Previously this math lived ONLY inline in the
// VendorSlaPanel UI (ephemeral, un-reusable, drift-prone). Extracted here so the panel AND the no-show
// autopilot compute reliability the same way. Pure — no I/O.

export interface SlaBooking {
  vendor_id: string
  scheduled_date: string | null
  completed_at: string | null
}

export interface VendorSlaStat {
  total: number
  onTime: number
  /** on-time percentage, 0..100. 100 when there's no completed history yet (no evidence of failure). */
  slaPct: number
}

/** Below this on-time % a vendor is in SLA breach (auto-demote / stop preferring). */
export const SLA_BREACH_PCT = 75
/** At/above this a vendor is SLA-compliant. */
export const SLA_COMPLIANT_PCT = 90

/**
 * PURE: per-vendor SLA from completed bookings. A booking counts when it has both a scheduled_date and a
 * completed_at; it's on-time when completed by scheduled_date + the vendor's committed turnaround days
 * (default 1). Vendors with no completed history get slaPct 100 (unproven ≠ bad — honest).
 */
export function computeVendorSla(
  bookings: SlaBooking[],
  turnaroundDaysByVendor: Record<string, number>,
): Record<string, VendorSlaStat> {
  const by: Record<string, { total: number; onTime: number }> = {}
  for (const b of bookings) {
    if (!b.completed_at || !b.scheduled_date) continue
    const vid = b.vendor_id
    if (!by[vid]) by[vid] = { total: 0, onTime: 0 }
    by[vid].total++
    const due = new Date(b.scheduled_date)
    due.setDate(due.getDate() + (turnaroundDaysByVendor[vid] ?? 1))
    if (new Date(b.completed_at) <= due) by[vid].onTime++
  }
  const out: Record<string, VendorSlaStat> = {}
  for (const [vid, s] of Object.entries(by)) {
    out[vid] = { total: s.total, onTime: s.onTime, slaPct: s.total > 0 ? Math.round((s.onTime / s.total) * 100) : 100 }
  }
  return out
}

/** Bucket a vendor's SLA % into the compliant / warning / breach tiers (shared by the panel + autopilot). */
export function slaTier(slaPct: number): "compliant" | "warning" | "breach" {
  if (slaPct >= SLA_COMPLIANT_PCT) return "compliant"
  if (slaPct >= SLA_BREACH_PCT) return "warning"
  return "breach"
}
