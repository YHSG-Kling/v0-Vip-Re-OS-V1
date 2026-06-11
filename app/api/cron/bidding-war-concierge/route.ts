import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runBiddingWarConcierge } from "@/lib/kernel/bidding-war-concierge"

/**
 * BIDDING-WAR CONCIERGE cron (every 2h via the dispatcher) — for each of OUR buyers with a
 * pre-acceptance offer on an OUTSIDE listing (a likely multiple-offer situation), the bench
 * convenes the buyer-side competitive play: the Shopping Agent's escalation-strategy brief
 * (agent-gated), a buyer-voice "highest-and-best" cover-letter DRAFT for the buyer to approve,
 * and a rapport/availability note to the outside listing agent (a draft our agent can send).
 * Nothing sends; one bundle per offer; idempotent.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "bidding-war-concierge",
    cron_path: "/app/api/cron/bidding-war-concierge/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let bundles = 0, briefs = 0, letters = 0, notes = 0, signals = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runBiddingWarConcierge(b.id, {}, supabase)
        bundles += r.bundles; briefs += r.escalationBriefs; letters += r.coverLetters
        notes += r.outsideAgentNotes; signals += r.signalsPublished
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: bundles,
      metadata: { bundles, briefs, letters, notes, signals, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, bundles, briefs, letters, notes, signals })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
