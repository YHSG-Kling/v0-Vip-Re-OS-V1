import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { produceEducationDelivery } from "@/lib/agents/education-delivery-producer"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"

/**
 * Weekly EDUCATION DELIVERY sweep — push the next stage-matched lesson to active
 * clients through the gate. For every contact with an active (non-terminal) transaction,
 * the side-appropriate concierge proposes the best-matched, not-yet-delivered lesson.
 * Idempotent per (contact, module), so as clients advance milestones each run delivers
 * the next unlocked lesson without repeating.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "education-delivery",
    cron_path: "/app/api/cron/education-delivery/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let proposed = 0
  let scanned = 0

  try {
    // Clients with an active deal — collect the distinct contact ids per brokerage.
    const { data: txns, error } = await supabase
      .from("transactions")
      .select("brokerage_id, contact_id, buyer_contact_id, seller_contact_id")
      .in("status", [...TRANSACTION_STATUSES_OPEN])
      .limit(3000)
    if (error) throw error

    const seen = new Set<string>()
    const targets: Array<{ brokerageId: string; contactId: string }> = []
    for (const t of (txns ?? []) as Array<{ brokerage_id: string; contact_id: string | null; buyer_contact_id: string | null; seller_contact_id: string | null }>) {
      for (const cid of [t.contact_id, t.buyer_contact_id, t.seller_contact_id]) {
        if (!cid) continue
        const key = `${t.brokerage_id}:${cid}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ brokerageId: t.brokerage_id, contactId: cid })
      }
    }

    for (const tgt of targets) {
      scanned += 1
      try {
        const r = await produceEducationDelivery(tgt.brokerageId, tgt.contactId, supabase)
        if (r.proposed) proposed += 1
      } catch (e: any) {
        errors.push(`${tgt.contactId}: ${e?.message ?? String(e)}`)
      }
    }

    // CLIENT EDUCATION AUTHOR — ensure the persona/stage client modules the delivery above pushes
    // actually EXIST: author any missing "what happens now / what to do" module as a gated draft.
    let clientModulesAuthored = 0
    try {
      const { runClientEducationCurriculumAll } = await import("@/lib/education/client-education-curriculum")
      const ce = await runClientEducationCurriculumAll(supabase)
      clientModulesAuthored = ce.authored
    } catch (e: any) { errors.push(`client-education-author: ${e?.message ?? String(e)}`) }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: proposed,
      metadata: { proposed, scanned, clientModulesAuthored, errors: errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, proposed, scanned, clientModulesAuthored, errors: errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
