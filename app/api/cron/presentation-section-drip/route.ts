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
 *   2. Deliver — for RELEASED presentations, deliver every due section on the
 *      channel its row asks for: a portal card, and/or ONE email carrying that
 *      section's reel as a clickable thumbnail (through dispatchEmail). Held
 *      presentations stay out of the drip.
 *
 * The response carries the per-channel counts (portalPosted / emailsSent /
 * emailsFailed / waitingOnReel) so a tick that delivered rows but sent no email
 * is visible from the cron log instead of reading as a clean run.
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
    // A read that was refused is a failed tick, not a quiet one — deliverDueSections
    // returns the message rather than throwing, so ok must reflect it.
    return NextResponse.json({ ok: !result.error, gate, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
