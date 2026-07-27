import { createServiceClient } from '@/lib/supabase/service'
import { transitionLifecycle } from '@/lib/kernel/lifecycle'
import { centsToDollars, dollarsToCents } from '../utils'
import { CURRENT_ENGINE_VERSION } from '../types'
import type { WaterfallContext, CommissionCalculationResult } from '../types'

// Helper functions
const sumCents = (amounts: number[]): number => amounts.reduce((a, b) => a + b, 0)

const validateWaterfall = (grossCents: number, distributedCents: number) => {
  const difference = grossCents - distributedCents
  const valid = Math.abs(difference) <= 1 // Allow 1 cent rounding difference
  return { valid, difference }
}

/**
 * STEP 11: Validate & Persist
 * Validate totals match and persist to database
 * ONLY THIS STEP UPDATES DATABASE
 */
export async function validateAndPersist(
  context: WaterfallContext,
  calculationMode: 'preview' | 'final',
  triggeredBy?: string | null
): Promise<CommissionCalculationResult> {
  // Collect all distributions
  const allDistributions = [
    ...context.grossAdjustments,
    ...context.agentAdjustments,
    ...context.brokerageAdjustments,
    ...context.teamDistributions,
    ...context.revenueShareDistributions,
    ...context.feeDistributions
  ]

  // Validate waterfall
  const totalDistributedCents = sumCents([
    ...allDistributions.map(d => dollarsToCents(d.calculated_amount)),
    context.agentFinalNetCents,
    context.brokerageFinalCents
  ])
  
  const validation = validateWaterfall(context.adjustedGrossCents, totalDistributedCents)

  if (!validation.valid) {
    throw new Error(
      `[commission-engine] Waterfall validation failed. ` +
      `Gross: $${centsToDollars(context.adjustedGrossCents)}, ` +
      `Distributed: $${centsToDollars(totalDistributedCents)}, ` +
      `Difference: ${validation.difference} cents`
    )
  }

  // Preview mode - don't persist, return result
  if (calculationMode === 'preview') {
    return {
      success: true,
      preview: true,
      gross_commission: centsToDollars(context.grossCommissionCents),
      net_to_agent: centsToDollars(context.agentFinalNetCents),
      net_to_brokerage: centsToDollars(context.brokerageFinalCents),
      cap_applied: context.capApplied,
      cap_status: context.capStatus,
      total_fees: centsToDollars(context.totalFeesCents),
      distributions: [
        ...allDistributions,
        {
          distribution_type: 'agent',
          agent_id: context.agentId,
          calculation_type: 'flat',
          calculated_amount: centsToDollars(context.agentFinalNetCents),
          source_of_funds: 'brokerage',
          cap_applied: context.capApplied,
          cap_status: context.capStatus
        },
        {
          distribution_type: 'brokerage',
          calculation_type: 'flat',
          calculated_amount: centsToDollars(context.brokerageFinalCents),
          source_of_funds: 'brokerage'
        }
      ]
    }
  }

  // Final mode - persist to database
  const supabase = createServiceClient()

  // FINALIZATION LOCK (owner rule): once a transaction's commission is finalized
  // (broker-signed CDA or uploaded final CD), it is IMMUTABLE — never re-persist it.
  // Return the locked commission instead of inserting a second summary row (this is
  // also what stops the duplicate-commissions-row bug on a re-run). The lock is set
  // AFTER the close-time calc, so the first/authoritative calc is never blocked.
  const { data: txn } = await supabase
    .from('transactions')
    .select('commission_finalized_at, close_date')
    .eq('id', context.transactionId)
    .maybeSingle<{ commission_finalized_at: string | null; close_date: string | null }>()

  {
    if (txn?.commission_finalized_at) {
      // KEEP-ONE (m283/m284): agent_commissions is the one commission ledger.
      // net_to_agent/net_to_brokerage are the post-fee waterfall results — the
      // generated agent_commission/brokerage_commission columns are the pre-fee
      // split, so read the net columns back, not the generated ones.
      const { data: locked } = await supabase
        .from('agent_commissions')
        .select('id, gross_commission, net_to_agent, net_to_brokerage, total_fees')
        .eq('transaction_id', context.transactionId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (locked) {
        return {
          success: true,
          commissionId: (locked as { id: string }).id,
          gross_commission: Number((locked as any).gross_commission),
          net_to_agent: Number((locked as any).net_to_agent),
          net_to_brokerage: Number((locked as any).net_to_brokerage),
          cap_applied: context.capApplied,
          cap_status: context.capStatus,
          total_fees: Number((locked as any).total_fees ?? centsToDollars(context.totalFeesCents)),
        }
      }
      // Finalized but no stored commission (shouldn't happen) — persist once so the
      // locked deal still has its ledger rather than nothing.
    }
  }

  // 1. Insert the summary row into the one commission ledger.
  // KEEP-ONE (m283/m284): agent_commissions absorbed the `commissions` twin.
  // agent_commission/brokerage_commission there are GENERATED from
  // gross_commission * agent_split_percent — they cannot be written, and they
  // describe the PRE-fee split. The waterfall's post-fee results belong in
  // net_to_agent / net_to_brokerage / total_fees (the columns m283 ported over).
  const { data: commission, error: commissionError } = await supabase
    .from('agent_commissions')
    .insert({
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      agent_id: context.agentId,
      gross_commission: centsToDollars(context.grossCommissionCents),
      agent_split_percent: context.agentSplitPercent,
      net_to_agent: centsToDollars(context.agentFinalNetCents),
      net_to_brokerage: centsToDollars(context.brokerageFinalCents),
      total_fees: centsToDollars(context.totalFeesCents),
      cap_applied: context.capApplied,
      // close_date is NOT NULL on the ledger; fall back to today when the deal
      // has no recorded close (a preview-then-finalize race, not a normal path).
      close_date: txn?.close_date ?? new Date().toISOString().slice(0, 10),
      status: 'pending',
      calculation_version: CURRENT_ENGINE_VERSION,
      created_at: new Date().toISOString()
    })
    .select()
    .single()

  if (commissionError || !commission) {
    throw new Error(`[commission-engine] Failed to insert commission summary: ${commissionError?.message}`)
  }

  // 2. Insert detailed distributions
  const distributionRows = [
    ...allDistributions.map(dist => ({
      commission_id: commission.id,
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      distribution_type: dist.distribution_type,
      agent_id: dist.agent_id,
      team_id: dist.team_id,
      calculation_type: dist.calculation_type,
      calculation_value: dist.calculation_value,
      calculated_amount: dist.calculated_amount,
      source_of_funds: dist.source_of_funds,
      cap_applied: dist.cap_applied || false,
      cap_status: dist.cap_status || 'n/a',
      rule_id: dist.rule_id,
      calculation_version: CURRENT_ENGINE_VERSION,
      status: 'pending',
      created_at: new Date().toISOString()
    })),
    {
      commission_id: commission.id,
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      distribution_type: 'agent',
      agent_id: context.agentId,
      calculation_type: 'flat',
      calculated_amount: centsToDollars(context.agentFinalNetCents),
      source_of_funds: 'brokerage',
      cap_applied: context.capApplied,
      cap_status: context.capStatus,
      calculation_version: CURRENT_ENGINE_VERSION,
      status: 'pending',
      created_at: new Date().toISOString()
    },
    {
      commission_id: commission.id,
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      distribution_type: 'brokerage',
      calculation_type: 'flat',
      calculated_amount: centsToDollars(context.brokerageFinalCents),
      source_of_funds: 'brokerage',
      cap_applied: false,
      cap_status: 'n/a',
      calculation_version: CURRENT_ENGINE_VERSION,
      status: 'pending',
      created_at: new Date().toISOString()
    }
  ]

  const { error: distributionsError } = await supabase
    .from('commission_distributions')
    .insert(distributionRows)

  if (distributionsError) {
    throw new Error(`[commission-engine] Failed to insert distributions: ${distributionsError.message}`)
  }

  // 2b. BRIDGE TO THE DASHBOARD/LIFECYCLE TABLE. The agent's earnings P&L dashboard
  // (app/dashboard/financials/reports) reads `agent_commissions`, NOT the engine's
  // `commissions` summary — so without this write a CLOSED deal's computed commission
  // is invisible to the agent (shows $0) until someone manually re-enters it. Mirror
  // the engine's numbers into agent_commissions (status 'pending', the start of the
  // pending→approved→paid lifecycle). Idempotent per transaction so a manual entry or
  // a calc re-run never double-counts; best-effort so a bridge failure never breaks the
  // primary calc — the commission-leak reaper is the safety net that catches any miss.
  try {
    const { data: existingDash } = await supabase
      .from('agent_commissions')
      .select('id')
      .eq('transaction_id', context.transactionId)
      .limit(1)
    if (!existingDash || existingDash.length === 0) {
      // agent_commission & brokerage_commission are GENERATED columns
      // (gross_commission × agent_split_percent). We can only set the inputs —
      // so derive the split that reproduces the engine's exact agent net:
      // gross × (agentNet/gross) = agentNet. Cap at [0,100] for safety.
      const splitPercent = context.grossCommissionCents > 0
        ? Math.min(100, Math.max(0, (context.agentFinalNetCents / context.grossCommissionCents) * 100))
        : 0
      await supabase.from('agent_commissions').insert({
        transaction_id: context.transactionId,
        brokerage_id: context.brokerageId,
        agent_id: context.agentId,
        gross_commission: centsToDollars(context.grossCommissionCents),
        agent_split_percent: splitPercent,
        status: 'pending',
        close_date: new Date().toISOString(),
      })
    }
  } catch (e) {
    console.error('[commission-engine] agent_commissions dashboard-bridge insert failed:', e)
  }

  // 3. Update cap tracking (fetch → add → update)
  if (context.capApplied || context.amountTowardsCap > 0) {
    // agent_cap_tracking has no is_active/updated_at — the active row is the one whose
    // anniversary window contains today.
    const nowDate = new Date().toISOString().slice(0, 10)
    const { data: capTracking } = await supabase
      .from('agent_cap_tracking')
      .select('*')
      .eq('agent_id', context.agentId)
      .eq('brokerage_id', context.brokerageId)
      .lte('anniversary_start', nowDate)
      .gte('anniversary_end', nowDate)
      .single()

    if (capTracking) {
      const newPaidToDate = capTracking.cap_paid_to_date + centsToDollars(context.amountTowardsCap)
      const isCapped = newPaidToDate >= capTracking.cap_amount

      await supabase
        .from('agent_cap_tracking')
        .update({
          cap_paid_to_date: newPaidToDate,
          is_capped: isCapped
        })
        .eq('id', capTracking.id)

      // AUTONOMOUS CAP-CRUSH MOMENT — if this calc is the one that CROSSED the cap, the Finance Manager
      // celebrates the agent (they keep 100% now) and hands the live proof to Recruiting on the bus.
      // Best-effort, deduped per anniversary — never blocks the calc.
      try {
        const { detectCapCrush, celebrateCapCrush } = await import('@/lib/finance/cap-crush')
        const { justCrossed } = detectCapCrush({ capAmount: capTracking.cap_amount, paidBefore: capTracking.cap_paid_to_date, paidAfter: newPaidToDate })
        if (justCrossed) {
          await celebrateCapCrush(supabase, {
            agentId: context.agentId,
            brokerageId: context.brokerageId,
            capAmount: capTracking.cap_amount,
            capPaidToDate: newPaidToDate,
            anniversaryStart: (capTracking as { anniversary_start?: string | null }).anniversary_start ?? null,
          })
        }
      } catch (e) {
        console.error('[commission-engine] cap-crush celebration failed:', e)
      }
    }
  }

  // 4. Log lifecycle event via kernel
  await transitionLifecycle({
    brokerageId: context.brokerageId,
    entityType:  "financial",
    entityId:    commission.id,
    fromState:   "pending",
    toState:     "calculated",
    actorUserId: triggeredBy ?? '',
    actorRole:   "agent",
    eventType:   "commission.calculated",
    metadata:    {
      transaction_id:       context.transactionId,
      calculation_version:  CURRENT_ENGINE_VERSION,
      resolved_from:        context.resolvedFrom,
      gross_commission:     centsToDollars(context.grossCommissionCents),
      cap_applied:          context.capApplied,
      cap_status:           context.capStatus,
    },
  })

  return {
    success: true,
    commissionId: commission.id,
    gross_commission: centsToDollars(context.grossCommissionCents),
    net_to_agent: centsToDollars(context.agentFinalNetCents),
    net_to_brokerage: centsToDollars(context.brokerageFinalCents),
    cap_applied: context.capApplied,
    cap_status: context.capStatus,
    total_fees: centsToDollars(context.totalFeesCents),
      distributions: distributionRows.map(d => ({
      distribution_type: (d as any).distribution_type as any,
      agent_id: (d as any).agent_id,
      team_id: (d as any).team_id,
      calculation_type: (d as any).calculation_type,
      calculation_value: (d as any).calculation_value,
      calculated_amount: (d as any).calculated_amount,
      source_of_funds: (d as any).source_of_funds as any,
      cap_applied: (d as any).cap_applied,
      cap_status: (d as any).cap_status,
      rule_id: (d as any).rule_id,
    })) as import('../types').DistributionRecord[]
  }
}
