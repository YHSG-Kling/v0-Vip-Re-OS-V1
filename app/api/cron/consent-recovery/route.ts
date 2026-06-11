import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runConsentRecovery } from "@/lib/kernel/consent-recovery"

/**
 * CONSENT-RECOVERY cron (hourly) — the revoked-consent chain: fallback channel →
 * enrichment re-run → only then a respectful withdraw (Sphere, via the bus). Every
 * client-facing step goes through the gate; consent flags are read, never fabricated.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "consent-recovery",
    cron_path: "/app/api/cron/consent-recovery/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let reviewed = 0, fallbacks = 0, enrichments = 0, withdraws = 0

  try {
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const { data: rows, error } = await supabase
      .from("contacts").select("brokerage_id")
      .or(`opted_out_at.gte.${cutoff},email_unsubscribed_at.gte.${cutoff}`)
      .limit(2000)
    if (error) throw error
    const brokerages = Array.from(new Set(((rows ?? []) as Array<{ brokerage_id: string | null }>)
      .map((r) => r.brokerage_id).filter((b): b is string => !!b)))

    for (const brokerageId of brokerages) {
      try {
        const r = await runConsentRecovery(brokerageId, {}, supabase)
        reviewed += r.contactsReviewed; fallbacks += r.fallbacksProposed
        enrichments += r.enrichmentsQueued; withdraws += r.withdrawsSignaled
      } catch (e: any) { errors.push(`${brokerageId}: ${e?.message ?? String(e)}`) }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: reviewed,
      metadata: { reviewed, fallbacks, enrichments, withdraws, brokerages: brokerages.length, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, reviewed, fallbacks, enrichments, withdraws, brokerages: brokerages.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
