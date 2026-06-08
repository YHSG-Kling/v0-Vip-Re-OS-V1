import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { deliverDueSections } from "@/lib/listing-presentation/section-drip"
import { sweepPrelistingDeliveryGate } from "@/lib/listing-presentation/prelisting-delivery"

/**
 * app/api/cron/presentation-section-drip/route.ts
 *
 * Drives the seller-facing pre-listing drip in two phases each tick:
 *   1. GATE 2 sweep — for held presentations whose renders have settled, raise
 *      the RELEASE proposal into the Command Center (surfacing the finished
 *      videos + email) so a human can review and release.
 *   2. Deliver — for RELEASED presentations, deliver every due section (portal
 *      card + scheduled → delivered). Held presentations stay out of the drip.
 * Auth: CRON_SECRET.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  try {
    const gate = await sweepPrelistingDeliveryGate({ limit: 50 })
    const result = await deliverDueSections({ limit: 50 })
    return NextResponse.json({ ok: true, gate, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
