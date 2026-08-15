import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calculateRevenueProtection } from "@/lib/revenue-protection/scorer"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Revenue Protection Rollup Cron
 *
 * Daily roll-up of the Revenue Protection Score per agent and per
 * brokerage. Produces one snapshot per (agent, quarterly) and one
 * (brokerage-wide, quarterly) per run. Latest snapshot powers the
 * hero card on the agent dashboard and the broker rollup widget.
 *
 * POST endpoint allows an admin-triggered on-demand rollup from the UI.
 */
export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "revenue-protection-rollup",
    cron_path: "/app/api/cron/revenue-protection-rollup/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  const summary = {
    brokerages_processed: 0,
    agents_processed:     0,
    snapshots_written:    0,
    errors:               0,
  }

  try {
    const { data: brokerages, error: brokeragesErr } = await svc
      .from("brokerages")
      .select("id")
      .is("deleted_at", null)
    if (brokeragesErr) throw new Error(brokeragesErr.message)

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      summary.brokerages_processed += 1
      try {
        // Brokerage-wide rollup
        await calculateRevenueProtection({
          agentId:      null,
          brokerageId:  b.id,
          snapshotType: "quarterly",
        })
        summary.snapshots_written += 1

        // Per-agent rollups
        const { data: agents } = await svc
          .from("users")
          .select("id")
          .eq("brokerage_id", b.id)
          .eq("user_type", "agent")

        for (const a of (agents ?? []) as Array<{ id: string }>) {
          try {
            await calculateRevenueProtection({
              agentId:      a.id,
              brokerageId:  b.id,
              snapshotType: "quarterly",
            })
            summary.agents_processed += 1
            summary.snapshots_written += 1
          } catch (e) {
            console.error(`[revenue-protection-rollup] agent ${a.id}:`, e)
            summary.errors += 1
          }
        }
      } catch (e) {
        console.error(`[revenue-protection-rollup] brokerage ${b.id}:`, e)
        summary.errors += 1
      }
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.snapshots_written,
      metadata:          summary,
    })
    return NextResponse.json({ message: "Revenue protection rollup complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Rollup failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST: admin-triggered rollup for one brokerage or agent. Auth same as GET.
 */
export async function POST(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth
  try {
    const { brokerage_id, agent_id, snapshot_type } = await request.json() as {
      brokerage_id?: string
      agent_id?: string
      snapshot_type?: "daily" | "weekly" | "monthly" | "quarterly" | "ytd" | "lifetime"
    }
    if (!brokerage_id) return NextResponse.json({ error: "brokerage_id required" }, { status: 400 })
    const result = await calculateRevenueProtection({
      agentId:      agent_id ?? null,
      brokerageId:  brokerage_id,
      snapshotType: snapshot_type ?? "quarterly",
    })
    return NextResponse.json({ success: true, result })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Rollup failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
