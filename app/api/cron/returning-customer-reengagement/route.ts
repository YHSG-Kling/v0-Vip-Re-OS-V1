import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runReturningCustomerReengagement } from "@/lib/kernel/returning-customer"

/**
 * RETURNING-CUSTOMER RE-ENGAGEMENT cron — closes the "lifetime" end of the arc. For each
 * brokerage, consumes pending CONTACT reactivation signals (signal_reactivations.contact_id,
 * fired e.g. by the inbound-intent classifier when a past client shows fresh intent) and, for
 * each that is a lifetime customer, proposes a memory-aware re-engagement from the right
 * manager: the Shopping Agent for a returning buyer, the Listing Concierge for a returning
 * seller — recalling their prior closed deal (role, price band, area, time since close).
 * Gated (proposes into the approval queue, never auto-sends), withdrawn excluded, idempotent
 * per (contact) within the dedupe window.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "returning-customer-reengagement",
    cron_path: "/app/api/cron/returning-customer-reengagement/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, proposed = 0, deduped = 0, skippedNotLifetime = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runReturningCustomerReengagement(b.id, {}, supabase)
        scanned += r.scanned; proposed += r.proposed; deduped += r.deduped; skippedNotLifetime += r.skippedNotLifetime
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: proposed,
      metadata: { scanned, proposed, deduped, skippedNotLifetime, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, proposed, deduped, skippedNotLifetime })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
