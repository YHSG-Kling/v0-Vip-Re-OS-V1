import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runLocalIntelSweep } from "@/lib/content-intel/local-intel"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * LOCAL-INTELLIGENCE cron (wave 144, lane 144G — owner ruling 14). Owner campaign_orchestrator.
 *
 * Per live tenant WITH an active territory (the ONE pull gate, resolveActivePullGate), once per UTC
 * day (the action ledger replays a second tick for free): territory events / civic notices /
 * business openings / development / market news through the registered web_search capability and
 * the owner-selected news provider, plus the tenant's own community-calendar feeds (robots.txt
 * first) → deterministic date / place / confidence / fair-housing screening → verified facts in
 * content_topic_bank (the one topic pool every content generator already reads). Platform-covered:
 * search spend books on the platform vendor ledger, never on the tenant's meter
 * (lib/content-intel/local-intel.ts).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "local-intel",
    cron_path: "/app/api/cron/local-intel/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context for local-intel" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  try {
    const result = await runLocalIntelSweep(createServiceClient())
    // A refused subscription / territory read is a FAILURE (the gate failed closed), never an idle day.
    if (/_query_failed$/.test(result.reason)) {
      await recordCronFailureAction({ context_id: contextId, error: new Error(`pull gate unreadable: ${result.reason} ${result.errors[0] ?? ""}`), stage: "pull-gate" }).catch(() => {})
      return NextResponse.json({ ok: false, ...result, errors: result.errors.length }, { status: 500 })
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.facts,
      metadata: { ...result, errors: result.errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, ...result, errors: result.errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
