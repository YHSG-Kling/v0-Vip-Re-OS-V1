import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { auditJourneyConformance } from "@/lib/journey-conformance/conformance-runner"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Journey-Conformance Audit — nightly cron.
 *
 * Finds contacts whose buyer-journey STAGE changed in the last day and replays each one's
 * transition history against the constitutional JOURNEY_PROGRESS_CONTRACT (legal order + the
 * financial-verification hard gate). Any illegal skip / bypassed gate (without an authorized
 * override) is escalated to the Command Center via the inter-manager bus. Read-only audit.
 *
 * The live-data proof that the AI team provably follows its own business process.
 */

const MAX_PER_RUN = 300
const LOOKBACK_HOURS = 24

export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "journey-conformance-audit",
    cron_path: "/app/api/cron/journey-conformance-audit/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  try {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString()
    const { data: events } = await svc.from("lifecycle_events")
      .select("entity_id, brokerage_id, metadata")
      .eq("entity_type", "contact").gte("created_at", since).limit(5000)

    // Distinct contacts that actually had a stage transition.
    const seen = new Set<string>()
    const targets: { contactId: string; brokerageId: string }[] = []
    for (const e of (events ?? []) as Record<string, any>[]) {
      if (e.metadata?.to_stage && e.entity_id && e.brokerage_id && !seen.has(e.entity_id)) {
        seen.add(e.entity_id)
        targets.push({ contactId: e.entity_id, brokerageId: e.brokerage_id })
      }
    }

    let audited = 0, violationsFound = 0, escalated = 0
    for (const t of targets.slice(0, MAX_PER_RUN)) {
      const r = await auditJourneyConformance(t.contactId, t.brokerageId, { escalate: true }, svc)
      audited++
      if (!r.compliant) violationsFound++
      if (r.escalated) escalated++
    }

    const summary = { candidates: targets.length, audited, violationsFound, escalated }
    await recordCronSuccessAction({ context_id: contextId, records_processed: audited, metadata: summary })
    return NextResponse.json({ message: "Journey conformance audit complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Journey conformance audit failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
