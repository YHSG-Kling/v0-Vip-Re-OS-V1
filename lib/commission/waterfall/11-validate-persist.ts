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
  // Collect all distributions. context.companyObligations is DELIBERATELY not
  // here: an out-of-deal obligation is not an in-deal distribution (owner ruling
  // 2026-08-28 — post-cap the brokerage stops TAKING; what it still owes to PAY
  // comes from company books, not from this deal's gross), so it is neither
  // summed into the conservation identity below nor written to
  // commission_distributions — the deal's disbursement sweeps
  // (payment-tracker.markCommissionPaid by commission_id, reconcile-tracking's
  // orphan lock by transaction_id + NULL commission_id) mark every distribution
  // row paid when the DEAL pays, and a company-books payable is not paid by the
  // deal's disbursement. It is persisted below to company_books_obligations.
  const allDistributions = [
    ...context.grossAdjustments,
    ...context.agentAdjustments,
    ...context.brokerageAdjustments,
    ...context.teamDistributions,
    ...context.revenueShareDistributions,
    ...context.feeDistributions
  ]
  const companyObligations = context.companyObligations ?? []

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
      team_cap_status: context.teamCapStatus ?? 'n/a',
      total_fees: centsToDollars(context.totalFeesCents),
      company_obligations: companyObligations,
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

  // 0b. COMPANY-BOOKS OBLIGATIONS (owner ruling 2026-08-28) — brokerage-funded
  // shares this deal's company dollar could not fund (post-cap it is $0). These
  // are recorded on company_books_obligations (m577), the company payables
  // ledger, NOT on commission_distributions — see the note on allDistributions:
  // the deal's disbursement sweeps would falsely mark a company payable paid.
  //
  // FIRST, before the summary insert, so a refused write fails the calculation
  // BEFORE anything is persisted — never a half-recorded deal, and NEVER a
  // silently dropped obligation. Pre-apply (m577 written, not applied) the
  // insert is refused by PostgREST (missing table) and this THROWS naming the
  // migration: the closing fails loudly, exactly as the old overdraft refusal
  // did, until the integrator applies m577 — strictly no worse, and honest.
  //
  // IDEMPOTENT per transaction: a re-run (preview→final race, retry) replaces
  // this deal's still-PENDING obligation rows rather than double-booking; a row
  // already paid or voided is company payment history and is never touched.
  if (companyObligations.length > 0) {
    const { error: obligationClearError } = await supabase
      .from('company_books_obligations')
      .delete()
      .eq('transaction_id', context.transactionId)
      .eq('brokerage_id', context.brokerageId)
      .eq('status', 'pending')
      .select('id')
    // §3: supabase-js RESOLVES refusals — read the error. (Zero rows deleted is
    // the normal first run, not a failure: the caller's call, and here it is fine.)
    if (obligationClearError) {
      throw new Error(
        `[commission-engine] company_books_obligations clear refused (is m577 applied?): ${obligationClearError.message}`
      )
    }

    const { data: obligationRows, error: obligationError } = await supabase
      .from('company_books_obligations')
      .insert(companyObligations.map((o) => ({
        brokerage_id: context.brokerageId,
        transaction_id: context.transactionId,
        agent_id: o.agent_id,
        obligation_type: o.obligation_type,
        calculation_type: o.calculation_type,
        calculation_value: o.calculation_value ?? null,
        calculated_amount: o.calculated_amount,
        reason: o.reason,
        cap_status: context.capStatus,
        status: 'pending',
        calculation_version: CURRENT_ENGINE_VERSION,
        created_at: new Date().toISOString(),
      })))
      .select('id')
    // COUNTED (§3): an RLS refusal arrives as error:null + zero rows, which must
    // not read as "recorded".
    if (obligationError || !obligationRows || obligationRows.length !== companyObligations.length) {
      throw new Error(
        `[commission-engine] Failed to record ${companyObligations.length} company-books obligation(s) ` +
        `(post-cap brokerage-funded share — owner ruling 2026-08-28; table company_books_obligations, m577): ` +
        `${obligationError?.message ?? `${obligationRows?.length ?? 0} of ${companyObligations.length} rows landed`}`
      )
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
      // The try/catch around this block does NOT see a refused write: supabase-js
      // RESOLVES a constraint or RLS refusal as `{ error }` instead of throwing,
      // so the catch below has never once fired for the failure mode that
      // actually happens here. Read the error, or the agent's dashboard silently
      // shows $0 on a closed deal and only the leak reaper notices.
      const { error: bridgeError } = await supabase.from('agent_commissions').insert({
        transaction_id: context.transactionId,
        brokerage_id: context.brokerageId,
        agent_id: context.agentId,
        gross_commission: centsToDollars(context.grossCommissionCents),
        agent_split_percent: splitPercent,
        status: 'pending',
        close_date: new Date().toISOString(),
      })
      if (bridgeError) {
        console.error(
          `[commission-engine] agent_commissions dashboard-bridge insert REFUSED for transaction ${context.transactionId} — the agent's earnings dashboard will read $0 for this closed deal:`,
          bridgeError.message,
        )
      }
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

  // 3b. Update TEAM cap tracking (m461) — read the active row, add, write back.
  // Deliberately the same fetch→add→update shape as the agent cap above, because
  // it is the same question one level down: what has this TEAM collected from
  // this agent in this anniversary year, and is it done collecting?
  if (context.teamCapTeamId && (context.teamAmountTowardsCap ?? 0) > 0) {
    const teamNowDate = new Date().toISOString().slice(0, 10)
    // .maybeSingle() is safe over this date range because m461 put a UNIQUE index
    // on (team_id, agent_id, anniversary_start) — unlike agent_cap_tracking,
    // which has no such constraint and would throw here if two overlapping rows
    // ever appeared.
    const { data: teamCap, error: teamCapReadError } = await supabase
      .from('team_cap_tracking')
      .select('id, cap_amount, cap_paid_to_date')
      .eq('team_id', context.teamCapTeamId)
      .eq('agent_id', context.agentId)
      .eq('brokerage_id', context.brokerageId)
      .lte('anniversary_start', teamNowDate)
      .gte('anniversary_end', teamNowDate)
      .maybeSingle()

    if (teamCapReadError) {
      // FAIL LOUD, NOT SILENT. supabase-js resolves a failed query, so without
      // this check an unreadable ledger would look like "no row" and the counter
      // would just never advance — the team would collect its cut for ever while
      // the ledger claimed it had collected nothing.
      console.error('[commission-engine] team_cap_tracking read failed — counter NOT advanced:', teamCapReadError.message)
    } else if (teamCap) {
      // Add in CENTS, then convert once. The agent-cap block above adds the two
      // dollar floats directly; doing it in integer cents here keeps repeated
      // deals from accumulating float drift into a money column.
      const paidBeforeDollars = Number((teamCap as { cap_paid_to_date: number | string }).cap_paid_to_date)
      const capAmountDollars = Number((teamCap as { cap_amount: number | string }).cap_amount)
      const newPaidToDate = centsToDollars(
        dollarsToCents(paidBeforeDollars) + (context.teamAmountTowardsCap ?? 0),
      )
      const isCapped = newPaidToDate >= capAmountDollars

      const { error: teamCapWriteError } = await supabase
        .from('team_cap_tracking')
        .update({
          cap_paid_to_date: newPaidToDate,
          is_capped: isCapped,
          // team_cap_tracking HAS updated_at (agent_cap_tracking does not), so
          // the ledger can be audited for when it last moved.
          updated_at: new Date().toISOString(),
        })
        .eq('id', (teamCap as { id: string }).id)

      if (teamCapWriteError) {
        console.error('[commission-engine] team_cap_tracking update failed — counter NOT advanced:', teamCapWriteError.message)
      }

      // NO CAP-CRUSH CELEBRATION FOR THE TEAM CAP, deliberately.
      //
      // 1. It would BREAK the agent one. celebrateCapCrush dedupes on
      //    (brokerage_id, type='cap_crushed', entity_id=agentId) since the
      //    anniversary. Firing it here would use the same key, so whichever cap
      //    crossed first would suppress the other — an agent who later crushes
      //    their BROKERAGE cap would get no notification at all. Reusing the key
      //    silently deletes a working feature.
      // 2. The copy would be false. It says "you now keep 100% of your commission
      //    for the rest of your anniversary year." Reaching the TEAM ceiling means
      //    the agent stops paying their team lead — real good news, but they still
      //    pay the brokerage its split until the brokerage cap is met.
      // 3. The paired recruiting signal (agent_crushed_cap) is a retention proof
      //    about BROKERAGE cap economics — a broker reading it as team-cap news
      //    would be reading a different fact than the one that happened.
      //
      // A team-cap milestone may well deserve its own notification type and its
      // own copy. That is a new feature with its own ruling, not a side effect of
      // wiring a ledger — so this writes the counter and surfaces team_cap_status,
      // and nothing else.
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
      team_cap_status:      context.teamCapStatus ?? 'n/a',
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
    team_cap_status: context.teamCapStatus ?? 'n/a',
    total_fees: centsToDollars(context.totalFeesCents),
    company_obligations: companyObligations,
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
