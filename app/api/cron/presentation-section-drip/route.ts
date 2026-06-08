import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { deliverDueSections } from "@/lib/listing-presentation/section-drip"

/**
 * app/api/cron/presentation-section-drip/route.ts
 *
 * Drives the seller-facing pre-listing drip: each tick, delivers every
 * presentation_sections row whose scheduled_for has arrived (posts a seller
 * portal card + advances scheduled → delivered). Thin wrapper over
 * deliverDueSections so the logic stays unit-testable. Auth: CRON_SECRET.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  try {
    const result = await deliverDueSections({ limit: 50 })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
