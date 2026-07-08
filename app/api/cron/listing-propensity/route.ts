import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runListingPropensity } from "@/lib/kernel/listing-propensity"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Listing Propensity Cron (weekly) — deterministic ready-to-list scoring over
 * OWNED ledgers (home-value checks, equity, sell-intent calls, hand-raises)
 * → ONE gated brief per agent on the proposal rail, deduped per ISO week.
 * The Fello counter: their enrichment answers who might move; our loop also
 * answers it AND closes it.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "listing-propensity",
    cron_path: "/app/api/cron/listing-propensity/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await runListingPropensity(createServiceClient())
    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.briefsProposed, metadata: summary as any })
    return NextResponse.json({ message: "Listing propensity complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Propensity run failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
