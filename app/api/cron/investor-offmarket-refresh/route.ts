import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { refreshInvestorOffMarketMatches } from "@/lib/buyer-search/investor-offmarket-runner"

/**
 * INVESTOR OFF-MARKET REFRESH cron (Shopping Agent, daily). Makes the investor deal finder AUTONOMOUS:
 * as the platform scrapes more off-market inventory (motivated-seller leads → contacts), each qualified
 * investor buyer's off-market match list is refreshed and their buyer-portal card updated — with zero
 * agent action. Nothing auto-sends; idempotent per investor (upsert + 24h portal dedupe).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "investor-offmarket-refresh",
    cron_path: "/app/api/cron/investor-offmarket-refresh/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  let investors = 0, matched = 0, portalCards = 0
  const errors: string[] = []

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await refreshInvestorOffMarketMatches(supabase, { brokerageId: b.id })
        investors += r.investors; matched += r.matched; portalCards += r.portalCards
      } catch (e) {
        errors.push(`${b.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: investors,
      output_count: matched,
      metadata: { investors, matched, portalCards, errorCount: errors.length },
    })
  } catch (e) {
    await recordCronFailureAction({ context_id: contextId, error: e instanceof Error ? e : String(e), stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  return NextResponse.json({ ok: true, investors, matched, portalCards, errorCount: errors.length })
}
