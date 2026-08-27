import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runQuarterlyTaxConcierge } from "@/lib/finance/quarterly-tax-concierge"

/**
 * AUTONOMOUS QUARTERLY-TAX CONCIERGE cron (daily) — the Finance Manager acting. As an IRS estimated-
 * tax due date approaches, it computes each agent's exact estimated payment from their REAL YTD income
 * and proactively reminds them (amount + due date). No-op on days outside the ~12-day window before a
 * due date. Idempotent (one reminder per agent per quarter). Agent-owned — works for a solo agent
 * regardless of whether their brokerage is on the platform.
 *
 * TENANT OPTION (m574): only brokerages with tax_assistance_enabled = true are processed — the
 * broker (or the solo-tier owner) flips it in Settings → Commission & Offerings.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "quarterly-tax-concierge",
    cron_path: "/app/api/cron/quarterly-tax-concierge/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let agents = 0, reminders = 0
  let dueQuarter: string | null = null

  try {
    // TENANT OPTION (m574): tax assistance is opt-in per brokerage — the same fail-closed filter
    // shape the farm-mail cron uses (`.eq("farm_mail_enabled", true)`). A tenant that never enabled
    // it gets no reminders; m574 backfilled true for brokerages already using the tax tools.
    const { data: rows, error } = await supabase
      .from("brokerages")
      .select("id")
      .eq("tax_assistance_enabled", true)
      .limit(1000)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runQuarterlyTaxConcierge(b.id, supabase)
        agents += r.agentsConsidered; reminders += r.remindersSent
        if (r.dueQuarter) dueQuarter = r.dueQuarter
        if (r.errors.length) errors.push(...r.errors.slice(0, 3).map((e) => `${b.id}: ${e}`))
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: reminders,
      metadata: { agents, reminders, dueQuarter, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, agents, reminders, dueQuarter })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
