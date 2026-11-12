import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runBrandListeningSweep } from "@/lib/competitive-intel/brand-listening"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * BRAND-LISTENING cron (wave 139H) — the Brand24 concepts on the competitive-intel survivors.
 * Registered in lib/kernel/cron-dispatch.ts CRON_REGISTRY; owner campaign_orchestrator
 * (CRON_MANAGER, lib/kernel/manager-registry.ts).
 *
 * Per live tenant, once per UTC day (the action ledger replays a second tick for free):
 * subjects derived from the tenant's own rows → mention capture through the web_search
 * capability (dedup on brand_mentions (brokerage_id, url_key)) → one bounded sentiment call
 * (AI Gateway, platform-paid) → volume-spike / negative / compliance manager signals →
 * discussion topics into content_topic_bank → AI insights onto ad_insights. Platform-covered:
 * booked on the platform ledgers, never on the tenant's meter (lib/competitive-intel/brand-listening.ts).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "brand-listening",
    cron_path: "/app/api/cron/brand-listening/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context for brand-listening" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  try {
    const result = await runBrandListeningSweep(createServiceClient())
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.mentions + result.signals + result.topics,
      metadata: { ...result, errors: result.errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, ...result, errors: result.errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
