/**
 * GET /api/cron/contingency-scan
 *
 * Daily cron — scans every active transaction across the platform for
 * contingencies whose deadlines are within 3 days and that haven't been
 * removed. Posts a notification to each affected agent with one-tap
 * "Send removal addendum" action.
 *
 * Auth: Vercel cron secret OR Authorization: Bearer ${CRON_SECRET}.
 *
 * Schedule (vercel.json): "0 13 * * *"  (08:00 ET / 13:00 UTC)
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { scanContingenciesNearingDeadline } from "@/lib/workflow/intelligence/proactive-checks"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const findings = await scanContingenciesNearingDeadline({ withinDays: 3 })
  if (findings.length === 0) {
    return NextResponse.json({ scanned: 0, notified: 0 })
  }

  const svc = createServiceClient()
  let notified = 0

  for (const f of findings) {
    if (!f.agentUserId) continue

    // Resolve agent's user_id (transactions.agent_id is agents.id)
    const { data: agentRow } = await svc
      .from("agents").select("user_id, brokerage_id")
      .eq("id", f.agentUserId).maybeSingle()
    const agentUserId = agentRow?.user_id
    const brokerageId = agentRow?.brokerage_id
    if (!agentUserId || !brokerageId) continue

    // Idempotency — skip if a notification was already sent for this contingency this week
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { count: alreadyNotified } = await svc
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", agentUserId)
      .eq("entity_type", "transaction")
      .eq("entity_id", f.transactionId)
      .eq("type", `contingency_${f.contingencyType}_expiring`)
      .gte("created_at", since)

    if ((alreadyNotified ?? 0) > 0) continue

    await svc.from("notifications").insert({
      user_id: agentUserId,
      brokerage_id: brokerageId,
      type: `contingency_${f.contingencyType}_expiring`,
      title: `${f.contingencyType[0].toUpperCase() + f.contingencyType.slice(1)} contingency expiring in ${f.daysUntil} day${f.daysUntil === 1 ? "" : "s"}`,
      body: f.contractAddress
        ? `On ${f.contractAddress} — deadline is ${new Date(f.deadline).toLocaleDateString()}. One-tap to send a removal addendum.`
        : `Deadline ${new Date(f.deadline).toLocaleDateString()}. One-tap to send removal.`,
      priority: f.daysUntil <= 1 ? "high" : "normal",
      entity_type: "transaction",
      entity_id: f.transactionId,
      channel: "in_app",
    })
    notified++
  }

  return NextResponse.json({
    scanned: findings.length,
    notified,
  })
}
