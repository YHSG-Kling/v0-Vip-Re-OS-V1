import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { accrueCommissions, type AccrualSummary } from "@/lib/platform/affiliates"
import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { recordSelfHeal } from "@/lib/kernel/self-heal-ledger"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * MONTHLY AFFILIATE COMMISSION ACCRUAL.
 *
 * Accrues one affiliate_commission_events row per (referral, period) for every
 * active referral inside its commission window on a tenant with live MRR —
 * mrr_cents from v_platform_margin, the SAME source as the platform margin
 * board. UNIQUE(referral_id, period) makes re-runs idempotent, so running
 * late-month (after the view reflects the month's tier pricing) and re-running
 * on demand are both safe.
 *
 * GOVERNED-BUS OUTCOME (owner: "all changes need to be managed by the managers
 * who work together"): after accrual the run's outcome rides the manager bus as
 * 'affiliate_commission_accrued' (feed_only; registered in SIGNAL_REGISTRY) —
 * the Finance Manager (this cron's registered owner, CRON_MANAGER) announces
 * the money move to the Cron Manager. manager_signals is tenant-anchored
 * (brokerage_id NOT NULL), so the signal is published per REFERRED TENANT
 * (each accrual belongs to exactly one workspace), with the platform-run
 * summary (accrued count + total cents) carried in every payload. Idempotent
 * per commission-event id via the bus dedupe. Accrual errors ledger onto
 * self_heal_events (flow 'affiliate_commission_accrual'). Both are best-effort:
 * the accrual ledger itself is the source of truth.
 *
 * Schedule (monthly, 28th — a day every month has; vercel.json):
 *   { "path": "/api/cron/affiliate-commissions", "schedule": "0 6 28 * *" }
 *
 * NOT registered in lib/kernel/cron-dispatch.ts — the orchestrator wires the
 * scheduler entry.
 *
 * Optional override for backfills/re-runs: ?period=YYYY-MM (defaults to the
 * current UTC month).
 */

/** Best-effort: one feed_only bus signal per accrued (referral, period) event. */
async function publishAccrualSignals(summary: AccrualSummary): Promise<void> {
  try {
    const svc = createServiceClient()
    const { data: events } = await svc
      .from("affiliate_commission_events")
      .select("id, brokerage_id, commission_cents, mrr_cents")
      .eq("period", summary.period)
      .eq("status", "accrued")
      .limit(500)
    for (const evt of (events ?? []) as Array<{
      id: string; brokerage_id: string; commission_cents: number; mrr_cents: number
    }>) {
      if (!evt.brokerage_id) continue
      await publishManagerSignal({
        brokerageId: evt.brokerage_id,
        fromManager: "finance_manager",
        toManager: "cron_manager",
        signalType: "affiliate_commission_accrued",
        message:
          `Monthly affiliate accrual for ${summary.period}: $${(Number(evt.commission_cents) / 100).toFixed(2)} ` +
          `accrued to the platform's referral partner for this workspace (platform-funded — nothing is billed here). ` +
          `Run total: ${summary.accrued} new accrual${summary.accrued === 1 ? "" : "s"}, ` +
          `$${(summary.commissionCentsAccrued / 100).toFixed(2)}.`,
        entityType: "affiliate_commission_event",
        entityId: evt.id,
        payload: {
          period: summary.period,
          commission_cents: Number(evt.commission_cents) || 0,
          mrr_cents: Number(evt.mrr_cents) || 0,
          run_accrued_count: summary.accrued,
          run_commission_cents_accrued: summary.commissionCentsAccrued,
        },
      }, svc)
    }
  } catch (e) {
    // Visibility is best-effort — the accrual ledger already holds the truth.
    console.error("[cron/affiliate-commissions] bus publish failed:", e)
  }
}

/** Best-effort: ledger a failed/errored accrual run (flow 'affiliate_commission_accrual'). */
async function ledgerAccrualFailure(period: string | undefined, errors: string[]): Promise<void> {
  try {
    await recordSelfHeal(createServiceClient(), {
      brokerageId: null, // platform-level run
      domain: "data_flow",
      subject: "affiliate_commission_accrual",
      action: "accrue_commissions",
      outcome: "failed",
      detail: {
        flow: "affiliate_commission_accrual",
        period: period ?? null,
        errors: errors.slice(0, 5).map((e) => e.slice(0, 300)),
      },
    })
  } catch { /* the ledger is additive — never fail the cron response on it */ }
}

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const period = new URL(req.url).searchParams.get("period") ?? undefined
  try {
    const summary = await accrueCommissions(period)
    // Rail outcome onto the governed bus (feed_only, per referred tenant).
    if (summary.accrued > 0 || summary.alreadyAccrued > 0) {
      await publishAccrualSignals(summary)
    }
    if (summary.errors.length > 0) {
      await ledgerAccrualFailure(summary.period, summary.errors)
    }
    return NextResponse.json({ ok: summary.errors.length === 0, ...summary })
  } catch (err) {
    console.error("[cron/affiliate-commissions] failed:", err)
    await ledgerAccrualFailure(period, [err instanceof Error ? err.message : "Accrual failed"])
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Accrual failed" },
      { status: 500 },
    )
  }
}
