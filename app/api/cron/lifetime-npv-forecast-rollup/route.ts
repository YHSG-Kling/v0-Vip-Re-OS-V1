import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { scoreContactNpv } from "@/lib/lifetime-customer-npv/scorer"
import { computeIncomeForecastForAgent } from "@/lib/income-forecast/forecaster"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Daily Lifetime-NPV + Income-Forecast rollup
 *
 * Order matters:
 *   1. Score every closed/sphere contact's NPV (writes
 *      lifetime_customer_npv_scores rows used by both this cron AND the
 *      sphere panel)
 *   2. For each agent, compute an Income Forecast snapshot — which pulls
 *      the NPV scores we just wrote to derive the sphere-referral
 *      expected value, then adds it to the pipeline weighted forecast.
 *
 * GET = scheduled run (CRON_SECRET).
 * POST = admin-triggered one-brokerage or one-agent rerun.
 */

const LIFETIME_CONTACT_TYPES = ["past_client", "lifetime_customer", "sphere"]

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "lifetime-npv-forecast-rollup",
    cron_path: "/app/api/cron/lifetime-npv-forecast-rollup/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  const summary = {
    brokerages_processed: 0,
    contacts_scored:      0,
    forecast_snapshots:   0,
    errors:               0,
  }

  try {
    const { data: brokerages } = await svc.from("brokerages").select("id").is("deleted_at", null)

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      summary.brokerages_processed += 1

      // Step 1 — score every lifetime/sphere contact in this brokerage
      const { data: contacts } = await svc
        .from("contacts")
        .select("id")
        .eq("brokerage_id", b.id)
        .in("contact_type", LIFETIME_CONTACT_TYPES)
        .is("deleted_at", null)

      for (const c of (contacts ?? []) as Array<{ id: string }>) {
        try {
          await scoreContactNpv({ contactId: c.id, brokerageId: b.id })
          summary.contacts_scored += 1
        } catch (e) {
          console.error(`[lifetime-npv-rollup] contact ${c.id}:`, e)
          summary.errors += 1
        }
      }

      // Step 2 — income forecast per agent (now that NPV is current)
      const { data: agents } = await svc
        .from("users")
        .select("id")
        .eq("brokerage_id", b.id)
        .eq("user_type", "agent")

      for (const a of (agents ?? []) as Array<{ id: string }>) {
        try {
          await computeIncomeForecastForAgent({ agentId: a.id, brokerageId: b.id })
          summary.forecast_snapshots += 1
        } catch (e) {
          console.error(`[lifetime-npv-rollup] agent forecast ${a.id}:`, e)
          summary.errors += 1
        }
      }
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.contacts_scored + summary.forecast_snapshots,
      metadata:          summary,
    })
    return NextResponse.json({ message: "Lifetime NPV + Forecast rollup complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Rollup failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const { brokerage_id, agent_id, contact_id } = await request.json() as {
      brokerage_id: string
      agent_id?:    string
      contact_id?:  string
    }
    if (!brokerage_id) return NextResponse.json({ error: "brokerage_id required" }, { status: 400 })

    if (contact_id) {
      const npv = await scoreContactNpv({ contactId: contact_id, brokerageId: brokerage_id })
      return NextResponse.json({ success: true, npv })
    }
    if (agent_id) {
      const forecast = await computeIncomeForecastForAgent({ agentId: agent_id, brokerageId: brokerage_id })
      return NextResponse.json({ success: true, forecast })
    }
    return NextResponse.json({ error: "agent_id or contact_id required" }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Rerun failed" }, { status: 500 })
  }
}
