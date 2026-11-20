// lib/billing/brokerage-fee-charges.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE SCHEDULED BROKERAGE-FEE RUN — server-only. Moved here unchanged from app/actions/brokerage-fees.ts (wave 154), where it
// was an export of a "use server" file: a public HTTP endpoint with no session that wrote charges for every tenant through a
// service client. The ONE caller is the cron route (app/api/cron/generate-brokerage-fee-charges/route.ts, verifyCronAuth).
// Nothing about amounts, cadence, the once-per-period UNIQUE guard or the ledger evidence changed in the move.
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type FeeCadence = "monthly" | "quarterly" | "annual" | "per_transaction" | "one_time"

/**
 * Generate this period's charges for all active fee types.
 * Idempotent via the (agent_id, fee_type_id, period_start) UNIQUE constraint.
 * Designed to run from a Vercel cron / Supabase scheduled function monthly.
 */
export async function generatePeriodicCharges(): Promise<{
  success: boolean
  generated: number
  error?: string
}> {
  const svc = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)

  // Pull all active fee types (across all brokerages — system run)
  const { data: feeTypes } = await svc
    .from("brokerage_fee_types")
    .select("*")
    .eq("is_active", true)

  if (!feeTypes?.length) return { success: true, generated: 0 }

  let inserted = 0
  for (const ft of feeTypes) {
    // Determine period_start for this cadence
    const periodStart = computePeriodStart(ft.cadence, today)
    if (!periodStart) continue
    // one_time fee — skip if already charged
    if (ft.cadence === "one_time") {
      const { data: existing } = await svc
        .from("agent_fee_charges")
        .select("id")
        .eq("fee_type_id", ft.id)
        .limit(1)
      if (existing?.length) continue
    }

    // Determine which agents this applies to
    const agentIds = await resolveAgentsForFeeType(ft, svc)

    // EVIDENCE (wave 154, lane 154A3 — coverage-ledger gap row 8). Each fee type's period run is recorded on
    // agent_action_ledger (who: finance_manager on the schedule; what: how many charges landed, how many were already there,
    // how many the database REFUSED). Recording-only claim — no idempotency key: the (agent_id, fee_type_id, period_start)
    // UNIQUE stays the once-guard, so a ledger that cannot record never blocks or changes a charge. No amount, schedule or
    // charge rule changed. A refusal other than the duplicate (23505) used to be counted as a silent skip; it is now counted.
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const run = await withActionLedger<{ inserted: number; duplicates: number; refused: number; lastError: string | null }>(
      {
        brokerageId: ft.brokerage_id,
        action: "finance.fee_charges.generate",
        actor: { type: "manager", managerKey: "finance_manager" },
        subject: { type: "brokerage_fee_type", id: ft.id, ref: periodStart },
        reasonCode: "UNSPECIFIED",
        reasonDetail: `scheduled ${ft.cadence} fee charges for period ${periodStart} (${agentIds.length} agent(s) on the schedule)`,
        riskClass: "FINANCIAL",
        systemSource: "brokerage_fee_schedule",
        // THE DECISION OWNER, DERIVABLE (wave 155, lane 155B2 — wave 154 gap row 8, owner Q2). Nothing charged changed: the rule
        // that ALREADY decided these charges is named — the brokerage's own fee schedule row (brokerage_fee_types: is_active,
        // cadence → computePeriodStart, applies_to → resolveAgentsForFeeType, amount / currency), versioned by its updated_at.
        // NOT consulted today, recorded as-is for the owner (no guess added): start_date / end_date on the schedule row, and any
        // platform halt switch (none exists for this run).
        detail: {
          fee_type_id: ft.id, period_start: periodStart, amount: ft.amount, currency: ft.currency, agents: agentIds.length,
          decided_by: "brokerage_fee_types schedule (computePeriodStart+resolveAgentsForFeeType)",
          policy_version: `brokerage_fee_types:${ft.id}@${ft.updated_at ?? "unknown"}`,
          decision_basis: { is_active: ft.is_active === true, cadence: ft.cadence, applies_to: ft.applies_to, period_end: computePeriodEnd(ft.cadence, periodStart), due_date: computeDueDate(periodStart), schedule_start_date: ft.start_date ?? null, schedule_end_date: ft.end_date ?? null },
        },
      },
      async () => {
        const out = { inserted: 0, duplicates: 0, refused: 0, lastError: null as string | null }
        for (const agentId of agentIds) {
          const { error } = await svc
            .from("agent_fee_charges")
            .insert({
              brokerage_id: ft.brokerage_id,
              agent_id: agentId,
              fee_type_id: ft.id,
              period_start: periodStart,
              period_end: computePeriodEnd(ft.cadence, periodStart),
              amount: ft.amount,
              currency: ft.currency,
              status: "open",
              due_date: computeDueDate(periodStart),
            })
          if (!error) out.inserted++
          else if ((error as { code?: string }).code === "23505") out.duplicates++ // already charged this period — the once-guard
          else { out.refused++; out.lastError = error.message }
        }
        return out
      },
      {
        settle: (r) => r.refused > 0
          ? { status: "failed", outcome: `charges:${r.inserted},dup:${r.duplicates},refused:${r.refused}`, error: r.lastError }
          : { status: "executed", outcome: `charges:${r.inserted},dup:${r.duplicates}` },
        // Recording-only: with no key a claim degrades to unledgered and runs; a non-acting claim (only reachable if a key is
        // ever added) is reported as nothing charged, never as success.
        replay: (claim) => ({ inserted: 0, duplicates: 0, refused: 0, lastError: claim.kind === "refused" ? claim.error : null }),
      },
      { client: svc as never },
    )
    inserted += run.inserted
    if (run.refused > 0) console.error(`[generatePeriodicCharges] fee type ${ft.id}: ${run.refused} charge insert(s) refused — ${run.lastError}`)
  }

  return { success: true, generated: inserted }
}

function computePeriodStart(cadence: FeeCadence, today: string): string | null {
  const d = new Date(today + "T00:00:00Z")
  switch (cadence) {
    case "monthly":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
        .toISOString().slice(0, 10)
    case "quarterly":
      return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1))
        .toISOString().slice(0, 10)
    case "annual":
      return new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10)
    case "one_time":
      return today
    case "per_transaction":
      return null  // generated per-transaction event, not by cron
  }
  return null
}

function computePeriodEnd(cadence: FeeCadence, periodStart: string): string | null {
  const d = new Date(periodStart + "T00:00:00Z")
  switch (cadence) {
    case "monthly":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
        .toISOString().slice(0, 10)
    case "quarterly":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0))
        .toISOString().slice(0, 10)
    case "annual":
      return new Date(Date.UTC(d.getUTCFullYear(), 11, 31)).toISOString().slice(0, 10)
    default:
      return null
  }
}

function computeDueDate(periodStart: string): string {
  const d = new Date(periodStart + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + 14)
  return d.toISOString().slice(0, 10)
}

async function resolveAgentsForFeeType(ft: any, svc: ReturnType<typeof createServiceClient>): Promise<string[]> {
  if (ft.applies_to === "all_agents") {
    const { data } = await svc
      .from("agents")
      .select("id")
      .eq("brokerage_id", ft.brokerage_id)
    return (data ?? []).map((r: any) => r.id)
  }
  if (ft.applies_to === "specific_agents") {
    const { data } = await svc
      .from("agent_fee_assignments")
      .select("agent_id")
      .eq("fee_type_id", ft.id)
      .eq("is_active", true)
    return (data ?? []).map((r: any) => r.agent_id)
  }
  if (ft.applies_to === "team" && ft.applies_to_team) {
    const { data } = await svc
      .from("agents")
      .select("id")
      .eq("brokerage_id", ft.brokerage_id)
      .eq("team_id", ft.applies_to_team)
    return (data ?? []).map((r: any) => r.id)
  }
  if (ft.applies_to === "role" && ft.applies_to_role) {
    const { data: users } = await svc
      .from("users")
      .select("id")
      .eq("brokerage_id", ft.brokerage_id)
      .eq("user_type", ft.applies_to_role)
    const userIds = (users ?? []).map((u: any) => u.id)
    if (!userIds.length) return []
    const { data: agents } = await svc
      .from("agents")
      .select("id")
      // tenant anchor (scope burn-down): userIds already came from this brokerage's
      // users, but the agents rows themselves must also belong to the fee's brokerage.
      .eq("brokerage_id", ft.brokerage_id)
      .in("user_id", userIds)
    return (agents ?? []).map((a: any) => a.id)
  }
  return []
}
