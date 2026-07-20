import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction, recordCronStartAction, recordCronSuccessAction, recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runIntentCampaign } from "@/lib/kernel/intent-campaign"
import { activeSubscriberBrokerageIds } from "@/lib/lead-pipeline/subscription-gate"

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth
  const ctx = await createCronRunContextAction({ cron_name: "intent-campaign", cron_path: "/app/api/cron/intent-campaign/route.ts" })
  if (!ctx.success || !ctx.data) return NextResponse.json({ error: "ctx" }, { status: 500 })
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})
  const supabase = createServiceClient()
  const errors: string[] = []
  const agg: Record<string, number> = {}
  try {
    // ACTIVE-TENANT GATE (owner canonical): this campaign scrapes BatchData
    // motivated-seller counts + Exa buyer intent per market — only tenants with
    // a live (active/trialing) subscription may be scraped for. Churned/past_due
    // tenants are skipped; no tenants → honest no-op.
    const { data: subs } = await supabase.from("subscriptions").select("brokerage_id, status")
    const activeIds = activeSubscriberBrokerageIds((subs ?? []) as Array<{ brokerage_id: string | null; status: string | null }>)
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    const activeRows = ((rows ?? []) as Array<{ id: string }>).filter((b) => activeIds.has(b.id))
    if (activeRows.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { no_op_reason: "no_active_subscribers" } }).catch(() => {})
      return NextResponse.json({ ok: true, no_op_reason: "no_active_subscribers" })
    }
    for (const b of activeRows) {
      try {
        const r = await runIntentCampaign(b.id, {}, supabase) as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(r)) if (typeof v === "number") agg[k] = (agg[k] ?? 0) + v
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({ context_id: contextId, records_processed: agg["markets"] ?? 0, metadata: { ...agg, errors: errors.slice(0, 10) } }).catch(() => {})
    return NextResponse.json({ ok: true, ...agg })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
