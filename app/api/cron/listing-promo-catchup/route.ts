/**
 * Cron: listing-promo-catchup
 *
 * Hourly sweep over listings whose lifecycle_stage flipped to 'active' or status
 * flipped to 'closed' in the last 24h, dispatched through the CANONICAL
 * lifecycle-promo path (policy gate → compliance gate → listing_promo_videos →
 * the 8-platform social publisher, google_business included).
 *
 * Replaces /api/cron/gbp-auto-posts, which ran the same 24h window but posted a
 * bespoke template to Google Business Profile only, bypassing both gates. See
 * lib/marketing/listing-promo-catchup.ts for the full rationale.
 *
 * The canonical path is event-driven; this is the safety net for events that
 * never reached a reactor. Re-firing is idempotent — listing_promo_videos has
 * UNIQUE (listing_id, event_type).
 */

import { type NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { listingPromoCatchupCronTick } from "@/lib/marketing/listing-promo-catchup"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "listing-promo-catchup",
    cron_path: "/app/api/cron/listing-promo-catchup/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await listingPromoCatchupCronTick()
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.scanned,
      output_count: result.dispatched,
      metadata: {
        dispatched: result.dispatched,
        alreadyHandled: result.alreadyHandled,
        skipped: result.skipped,
        failed: result.failed,
      },
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json({ error: err.message ?? "Cron failed" }, { status: 500 })
  }
}
