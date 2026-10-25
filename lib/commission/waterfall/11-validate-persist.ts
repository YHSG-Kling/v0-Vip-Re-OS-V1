import { createServiceClient } from '@/lib/supabase/service'
import { transitionLifecycle } from '@/lib/kernel/lifecycle'
import { isCommissionFinalized } from '@/lib/commission/finalization'
import { liveLedgerEntries } from '@/lib/commission/distribution-correction'
import { ensureAgentCapWindow } from '@/lib/commission/cap-resolver'
import { withActionLedger } from '@/lib/kernel/action-ledger'
import { sentinelWrite } from '@/lib/kernel/write-sentinel'
import { KernelEvent } from '@/lib/kernel/events'
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
  //
  // WAVE 143 (lane 143C) — GROSS ADJUSTMENTS ARE NOT DISTRIBUTIONS. A listing-agreement concession (stage 03) is
  // already NETTED into adjustedGrossCents; counting its signed row in the identity below double-counted it, so
  // EVERY deal carrying an active gross adjustment failed this validation (measured in memory at 21da8e4e:
  // "Gross: $11500, Distributed: $11000" for a $500 credit on $12,000). The persisted row would also have been
  // refused by the live DB (commission_distributions_calculated_amount_check: a negative `entry` row;
  // commission_distributions_rule_id_fkey: rule_id is a commission_rules id, the row carried a
  // commission_adjustments id). The concession's record stays commission_adjustments; this calculation cites it
  // in commission_calculations (breakdown_json / engine_inputs). The REFERRAL fee (stage 03b) IS a payout: it is
  // here, conserved, and funded by the deal.
  //
  // WAVE 144 (lane 144D): the ROYALTY (stage 10, owner ruling 7) is a payout to the brokerage under the agreement — it is
  // here, conserved, as its own row (distribution_type 'royalty'), never folded into the fees.
  const allDistributions = [
    ...(context.referralDistributions ?? []),
    ...context.agentAdjustments,
    ...context.brokerageAdjustments,
    ...context.teamDistributions,
    ...context.revenueShareDistributions,
    ...context.feeDistributions,
    ...(context.royaltyDistributions ?? []),
  ]
  // The commission the brokerage actually RECEIVES: the gross after any AGENT concession (a listing-agreement commission
  // reduction or an agent's approved credit to the buyer / seller — stage 03; owner ruling 4). A SELLER concession never
  // appears here: it is the seller's money to the buyer and never moves the commission. It is what the summary row, the CDA
  // and the statement-vs-contract comparison must foot to (equal to grossCommissionCents when no concession exists).
  const grossOfRecordCents = context.adjustedGrossCents
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
      gross_commission: centsToDollars(grossOfRecordCents),
      gross_adjustments: context.grossAdjustments,
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
  //
  // ONE SPELLING OF THE LOCK (§6, wave 27). This step used to read the lock
  // column off `transactions` itself — a second reader beside
  // lib/commission/finalization.ts:isCommissionFinalized, whose own header
  // already claimed "the waterfall engine consults isCommissionFinalized" while
  // nothing in the tree did. The helper is the survivor and this asks it; the
  // §3 error-read this step carried was ported onto the helper first, so the
  // refusal is still reported rather than silently read as "not finalized".
  //
  // IT COSTS A SECOND ROUND TRIP, deliberately. `close_date` is still needed
  // from the same table for the ledger insert below, so the two facts no longer
  // arrive in one read. One spelling of an immutability lock is worth one query
  // on a close-time calculation that already makes a dozen.
  const finalized = await isCommissionFinalized(supabase, context.transactionId)

  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .select('close_date')
    .eq('id', context.transactionId)
    .maybeSingle<{ close_date: string | null }>()
  // supabase-js RESOLVES refusals (§3). This read no longer decides the lock,
  // but it still decides the ledger row's close_date, and a refusal falling
  // through to "today" would date a deal wrong on the column
  // loadAgentCommissions ORDERS BY.
  if (txnErr) {
    console.error('[waterfall/validate-persist] transaction close-date read refused — the ledger row will fall back to today:', txnErr.message)
  }

  {
    if (finalized) {
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

  // WAVE 107 (lane 107A) — DETERMINISTIC RE-RUN = SAME LEDGER. The finalization lock above only
  // engages AFTER finalization; between the close-time calc and the CDA/CD lock a second 'final'
  // run (a CLOSED → reopen → CLOSED, a retry) inserted a SECOND distribution set — every residual
  // paid twice to the same (beneficiary, rule). A transaction that already carries LIVE posted
  // entries (liveLedgerEntries — voided rows excluded, so a fully voided deal re-posts) returns
  // that ledger instead. FAIL CLOSED: a refused read throws — an unprovable "no ledger yet" must
  // not write a second one.
  {
    const { data: postedRows, error: postedErr } = await supabase
      .from('commission_distributions')
      .select('id, commission_id, status, entry_type')
      .eq('transaction_id', context.transactionId)
      .eq('brokerage_id', context.brokerageId)
    if (postedErr) {
      throw new Error(`[commission-engine] Could not read the existing ledger before posting (re-run guard): ${postedErr.message}`)
    }
    const live = liveLedgerEntries((postedRows ?? []) as Array<{ id: string; commission_id: string | null; status: string | null; entry_type: string | null }>)
    if (live.length > 0) {
      const existingCommissionId = live.find((r) => r.commission_id)?.commission_id ?? null
      const { data: existing, error: existingErr } = existingCommissionId
        ? await supabase
            .from('agent_commissions')
            .select('id, gross_commission, net_to_agent, net_to_brokerage, total_fees')
            .eq('id', existingCommissionId)
            .eq('brokerage_id', context.brokerageId)
            .maybeSingle()
        : { data: null, error: null }
      if (existingErr) {
        throw new Error(`[commission-engine] Could not read the posted commission summary (re-run guard): ${existingErr.message}`)
      }
      const e = existing as { id: string; gross_commission: number | string | null; net_to_agent: number | string | null; net_to_brokerage: number | string | null; total_fees: number | string | null } | null
      return {
        success: true,
        commissionId: e?.id ?? existingCommissionId ?? undefined,
        gross_commission: e ? Number(e.gross_commission) : centsToDollars(grossOfRecordCents),
        net_to_agent: e ? Number(e.net_to_agent) : centsToDollars(context.agentFinalNetCents),
        net_to_brokerage: e ? Number(e.net_to_brokerage) : centsToDollars(context.brokerageFinalCents),
        cap_applied: context.capApplied,
        cap_status: context.capStatus,
        total_fees: e ? Number(e.total_fees ?? centsToDollars(context.totalFeesCents)) : centsToDollars(context.totalFeesCents),
      }
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

  // 0c. LINK THE REFERRAL TO THIS DEAL (wave 143, lane 143C) — compare-and-swap, BEFORE anything is posted, so one
  // referral can never pay on two closings (a second deal that read it unlinked finds the link taken and FAILS here
  // rather than booking the fee twice). A re-run that already carries the link matches it by its own transaction id.
  // Pre-m812 the column is absent: stage 03b then returned no link and this block is skipped (said, not silent).
  if (context.referralLink && !context.referralLink.alreadyLinked) {
    const { data: claimed, error: claimError } = await supabase
      .from('referrals')
      .update({ transaction_id: context.transactionId, updated_at: new Date().toISOString() })
      .eq('id', context.referralLink.referralId)
      .eq('brokerage_id', context.brokerageId)
      .is('transaction_id', null)
      .select('id')
    if (claimError) {
      throw new Error(`[commission-engine] referral ${context.referralLink.referralId} could not be linked to the deal: ${claimError.message}`)
    }
    if (!claimed || claimed.length !== 1) {
      throw new Error(
        `[commission-engine] referral ${context.referralLink.referralId} was linked to another closing while this one was calculated — ` +
        `recalculate so the fee is not paid twice`
      )
    }
  }

  // 0d. CLAIM THE CAP CYCLE (wave 144, lane 144D — owner ruling 9) BEFORE anything is posted. The cycle is the one
  // containing the DEAL's date (stage 07); a cycle with no ledger row is opened here (the anniversary restart); the counter
  // advances by COMPARE-AND-SWAP on the paid-to-date the deal was priced on, so two deals priced against the same remaining
  // cap cannot both cross it (the second fails and is recalculated). A posting failure below RELEASES the claim, so a retry
  // never counts the deal twice.
  const capClaim = await claimCapCycle(supabase, context)

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
      gross_commission: centsToDollars(grossOfRecordCents),
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
    await releaseCapClaim(supabase, capClaim)
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
      // WAVE 144 (lane 144D): an OUTSIDE referral payee (m850). Named only on the row that has one, so a deal without an
      // outside partner never names the column (pre-m850 a PGRST204 would refuse the WHOLE insert — CLAUDE.md §3).
      ...(dist.referral_partner_id ? { referral_partner_id: dist.referral_partner_id } : {}),
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

  const { data: insertedDistributions, error: distributionsError } = await supabase
    .from('commission_distributions')
    .insert(distributionRows)
    .select('id, distribution_type, agent_id')

  if (distributionsError) {
    await releaseCapClaim(supabase, capClaim)
    throw new Error(`[commission-engine] Failed to insert distributions: ${distributionsError.message}`)
  }

  // 2a. RESIDUAL LEDGER EVIDENCE (wave 107, lane 107A — LAW 5). The distribution insert above stays ONE
  // statement (conservation must land atomically), so each residual entry's evidence is claimed right after it:
  // one agent_action_ledger row per (transaction, beneficiary, rule) — idempotent on that key — then the
  // canonical COMMISSION_DISTRIBUTED event. Every residual is born 'pending' = HELD for the Finance Manager
  // (lib/kernel/financial.ts approveResidualEntry; payout sweeps skip it until approved).
  await recordResidualLedgerEvidence(supabase, {
    context,
    commissionId: commission.id as string,
    triggeredBy: triggeredBy ?? null,
    inserted: (insertedDistributions ?? []) as Array<{ id: string; distribution_type: string; agent_id: string | null }>,
  })

  // 2a'. THE CALCULATION'S OWN EVIDENCE (wave 143, lane 143C; LAW 5): which agreement priced this deal, on which
  // date, from which signed record, with which concessions and referral — frozen beside the ledger so "the
  // percentage we paid on" is provable after the fact, never reconstructed from today's profile.
  await recordCalculationEvidence(supabase, {
    context,
    commissionId: commission.id as string,
    triggeredBy: triggeredBy ?? null,
    distributions: allDistributions,
    grossOfRecordCents,
    capClaim,
  })

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
      const splitPercent = grossOfRecordCents > 0
        ? Math.min(100, Math.max(0, (context.agentFinalNetCents / grossOfRecordCents) * 100))
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
        gross_commission: centsToDollars(grossOfRecordCents),
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

  // 3. CAP TRACKING — advanced ONCE, by step 0d's compare-and-swap claim, before anything was posted (wave 144, lane 144D).
  // TOMBSTONE: the fetch → add → update that stood here read the window containing TODAY (not the deal's), ignored the
  // read's error, added dollar floats, and raced a concurrent deal. SURVIVOR: claimCapCycle below (this file).
  // AUTONOMOUS CAP-CRUSH MOMENT — if this calc is the one that CROSSED the cap, the Finance Manager celebrates the agent
  // (they keep 100% now) and hands the live proof to Recruiting on the bus. Best-effort, deduped per anniversary — never
  // blocks the calc.
  if (capClaim) {
    try {
      const { detectCapCrush, celebrateCapCrush } = await import('@/lib/finance/cap-crush')
      const { justCrossed } = detectCapCrush({ capAmount: capClaim.capAmountCents / 100, paidBefore: capClaim.paidBeforeCents / 100, paidAfter: capClaim.paidAfterCents / 100 })
      if (justCrossed) {
        await celebrateCapCrush(supabase, {
          agentId: context.agentId,
          brokerageId: context.brokerageId,
          capAmount: capClaim.capAmountCents / 100,
          capPaidToDate: capClaim.paidAfterCents / 100,
          anniversaryStart: capClaim.start,
        })
      }
    } catch (e) {
      console.error('[commission-engine] cap-crush celebration failed:', e)
    }
  }

  // 3b. Update TEAM cap tracking (m461) — read the active row, add, write back.
  // Deliberately the same fetch→add→update shape as the agent cap above, because
  // it is the same question one level down: what has this TEAM collected from
  // this agent in this anniversary year, and is it done collecting?
  if (context.teamCapTeamId && (context.teamAmountTowardsCap ?? 0) > 0) {
    // WAVE 144 (lane 144D): the DEAL's cycle — the same window stage 08 priced the team's take in (never today's).
    const teamNowDate = context.agreement?.asOf ?? new Date().toISOString().slice(0, 10)
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
      gross_commission:     centsToDollars(grossOfRecordCents),
      cap_applied:          context.capApplied,
      cap_status:           context.capStatus,
      team_cap_status:      context.teamCapStatus ?? 'n/a',
    },
  })

  return {
    success: true,
    commissionId: commission.id,
    gross_commission: centsToDollars(grossOfRecordCents),
    net_to_agent: centsToDollars(context.agentFinalNetCents),
    net_to_brokerage: centsToDollars(context.brokerageFinalCents),
    cap_applied: context.capApplied,
    cap_status: context.capStatus,
    team_cap_status: context.teamCapStatus ?? 'n/a',
    total_fees: centsToDollars(context.totalFeesCents),
    company_obligations: companyObligations,
    gross_adjustments: context.grossAdjustments,
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

/**
 * LAW 5 evidence for each residual ledger entry step 11 just posted (wave 107, 107A): who (the user whose
 * close triggered the calc, else the system), why (TRANSACTION_MILESTONE — the closing), what evidence (the
 * deterministic evaluation: rule key, relation, depth, terms, the close date the windows were judged on, graph
 * corroboration + findings), which tool (the commission engine), what happened (posted, pending finance
 * review). Idempotent per (transaction, beneficiary, rule) through the ledger's own key. Evidence never fails
 * the posted money: a refused claim is logged (the ledger row is the record; the distribution is the money).
 */
async function recordResidualLedgerEvidence(
  supabase: ReturnType<typeof createServiceClient>,
  input: {
    context: WaterfallContext
    commissionId: string
    triggeredBy: string | null
    inserted: Array<{ id: string; distribution_type: string; agent_id: string | null }>
  },
): Promise<void> {
  const evaluation = input.context.residualEvaluation
  if (!evaluation || evaluation.entries.length === 0) return
  const unclaimed = input.inserted.filter((r) => r.distribution_type === 'residual')
  const posted: Array<{ key: string; distributionId: string | null; beneficiaryAgentId: string; cents: number; rail: string }> = []
  for (const entry of evaluation.entries) {
    let distributionId: string | null = null
    if (entry.rail === 'in_deal') {
      const idx = unclaimed.findIndex((r) => r.agent_id === entry.beneficiaryAgentId)
      if (idx >= 0) distributionId = unclaimed.splice(idx, 1)[0].id
    }
    try {
      await withActionLedger<{ ok: boolean }>(
        {
          brokerageId: input.context.brokerageId,
          action: 'finance.residual.ledger_entry',
          actor: input.triggeredBy ? { type: 'user', userId: input.triggeredBy } : { type: 'system' },
          subject: { type: entry.rail === 'in_deal' ? 'commission_distribution' : 'company_books_obligation', id: distributionId, ref: input.context.transactionId },
          reasonCode: 'TRANSACTION_MILESTONE',
          reasonDetail: `${entry.relationshipType} residual (level ${entry.depth}) evaluated on the close date ${evaluation.evaluatedOn}`,
          idempotencyKey: entry.key,
          riskClass: 'FINANCIAL',
          systemSource: 'commission_engine',
          detail: {
            transaction_id: input.context.transactionId,
            commission_id: input.commissionId,
            beneficiary_agent_id: entry.beneficiaryAgentId,
            relationship_id: entry.relationshipId,
            relationship_type: entry.relationshipType,
            depth: entry.depth,
            cents: entry.cents,
            rail: entry.rail,
            source_of_funds: entry.sourceOfFunds,
            calculation_type: entry.calculationType,
            calculation_value: entry.calculationValue,
            evaluated_on: evaluation.evaluatedOn,
            evaluated_on_source: evaluation.evaluatedOnSource,
            corroborated_by: entry.corroboratedBy,
            graph_measured: evaluation.graphMeasured,
            findings: evaluation.findings,
            review: 'pending_finance_review',
          },
        },
        async () => ({ ok: true }),
        {
          settle: () => ({ status: 'executed', outcome: 'posted_pending_finance_review' }),
          replay: () => ({ ok: false }),
        },
        { client: supabase },
      )
    } catch (e) {
      console.error(`[commission-engine] residual evidence claim failed for ${entry.key}:`, e)
    }
    posted.push({ key: entry.key, distributionId, beneficiaryAgentId: entry.beneficiaryAgentId, cents: entry.cents, rail: entry.rail })
  }

  try {
    const { emitKernelEvent } = await import('@/lib/kernel/emit')
    const r = await emitKernelEvent({
      brokerageId: input.context.brokerageId,
      entityType: 'agent_commission',
      entityId: input.commissionId,
      event: KernelEvent.COMMISSION_DISTRIBUTED,
      actorUserId: input.triggeredBy,
      transactionId: input.context.transactionId,
      metadata: { change: 'residual_posted', evaluatedOn: evaluation.evaluatedOn, residuals: posted, review: 'pending_finance_review' },
      auditOnly: true,
      client: supabase,
    })
    if (r.error) console.error('[commission-engine] COMMISSION_DISTRIBUTED audit row refused:', r.error)
  } catch (e) {
    console.error('[commission-engine] COMMISSION_DISTRIBUTED emit threw:', e)
  }
}

/**
 * The calculation's own evidence (wave 143, lane 143C). Two writes, neither able to un-post the money:
 *   · commission_calculations — the FROZEN gross of record (total_commission = the adjusted gross the distributions
 *     foot to; lib/kernel/economic-graph.ts reads exactly this for its conservation check) with breakdown_json (the
 *     gross before concessions, the concessions, the referral deduction, the finals, the distributions by type) and
 *     engine_inputs (the agreement version / date / signed record / findings the deal was priced with). The live
 *     jsonb column engine_inputs existed with NO engine writer until now.
 *   · agent_action_ledger — one row per commission (idempotent on it): who triggered, why, what evidence, which tool.
 * Evidence never fails the posted money: a refused write is ledgered by the write sentinel / logged, and the
 * distributions remain the record (the deal is already posted when this runs).
 */
async function recordCalculationEvidence(
  supabase: ReturnType<typeof createServiceClient>,
  input: {
    context: WaterfallContext
    commissionId: string
    triggeredBy: string | null
    distributions: Array<{ distribution_type: string; calculated_amount: number }>
    grossOfRecordCents: number
    capClaim?: CapClaim | null
  },
): Promise<void> {
  const c = input.context
  const byType: Record<string, number> = {}
  for (const d of input.distributions) byType[d.distribution_type] = Math.round(((byType[d.distribution_type] ?? 0) + d.calculated_amount) * 100) / 100
  const agreement = c.agreement
  const engineInputs = {
    engine_version: CURRENT_ENGINE_VERSION,
    agreement: agreement
      ? {
          source: agreement.source,
          version_id: agreement.versionId,
          effective_from: agreement.effectiveFrom,
          as_of: agreement.asOf,
          as_of_source: agreement.asOfSource,
          signed_agreement: agreement.signedAgreement,
          signed_field_mismatches: agreement.signedFieldMismatches,
          findings: agreement.findings,
        }
      : null,
    team_agreement: c.teamAgreement ?? null,
    applied: { agent_split_percent: c.agentSplitPercent, gross_rate_decimal: c.grossRateDecimal, resolved_from: c.resolvedFrom },
    referral: { link: c.referralLink ?? null, deduction_cents: c.referralDeductionCents ?? 0, findings: c.referralFindings ?? [] },
    revenue_share_skipped: c.revenueShareSkipped ?? null,
    team_cap_status: c.teamCapStatus ?? 'n/a',
    // WAVE 144 (lane 144D, owner ruling 9): the cap cycle the deal was priced in and what it contributed, by type — the
    // record a refund / correction (lib/kernel/financial.ts) reads to move the cap ledger by what actually changed.
    cap: c.capCycle
      ? {
          tracking_id: input.capClaim?.trackingId ?? c.capCycle.trackingId,
          cycle_start: c.capCycle.start,
          cycle_end: c.capCycle.end,
          as_of: c.capCycle.asOf,
          cap_amount: centsToDollars(c.capCycle.capAmountCents),
          cap_source: c.capCycle.capSource,
          eligible: c.capCycle.eligible,
          paid_before: centsToDollars(c.capCycle.paidToDateCents),
          paid_after: input.capClaim ? centsToDollars(input.capClaim.paidAfterCents) : centsToDollars(c.capCycle.paidToDateCents),
          contributed_cents: c.amountTowardsCap,
          contributed_by_type_cents: c.capCycle.contributedByType,
          cap_status: c.capStatus,
          findings: c.capCycle.findings,
        }
      : null,
  }
  const breakdown = {
    gross_commission_before_adjustments: centsToDollars(c.grossCommissionCents),
    gross_adjustments: c.grossAdjustments.map((a) => ({ adjustment_id: a.rule_id ?? null, calculation_type: a.calculation_type, calculation_value: a.calculation_value ?? null, signed_amount: a.calculated_amount, notes: a.notes ?? null })),
    // WAVE 144 (lane 144D, owner ruling 4): every gross-level row as stage 03 judged it — agent, beneficiary, amount,
    // reason, approval, settlement treatment and ledger effect (applied / skipped / held, with the finding).
    agent_concessions: (c.concessions ?? []).map((x) => ({
      adjustment_id: x.adjustmentId,
      kind: x.kind,
      verdict: x.verdict,
      concession_agent_id: x.concessionAgentId,
      beneficiary: x.beneficiary,
      beneficiary_name: x.beneficiaryName,
      reason: x.reason,
      approval_status: x.approvalStatus,
      settlement_treatment: x.settlementTreatment,
      signed_amount: x.signedCents / 100,
      ledger_effect: x.ledgerEffect,
      finding: x.finding,
    })),
    adjusted_gross: centsToDollars(input.grossOfRecordCents),
    referral_deduction: centsToDollars(c.referralDeductionCents ?? 0),
    agent_final_net: centsToDollars(c.agentFinalNetCents),
    brokerage_final: centsToDollars(c.brokerageFinalCents),
    total_fees: centsToDollars(c.totalFeesCents),
    royalty: centsToDollars(c.royaltyCents ?? 0),
    distributions_by_type: byType,
  }
  await sentinelWrite(supabase, supabase.from('commission_calculations').insert({
    transaction_id: c.transactionId,
    brokerage_id: c.brokerageId,
    agent_id: c.agentId,
    total_commission: centsToDollars(input.grossOfRecordCents),
    breakdown_json: breakdown,
    engine_inputs: engineInputs,
    calculation_version: CURRENT_ENGINE_VERSION,
    calculated_at: new Date().toISOString(),
  }), {
    table: 'commission_calculations',
    flow: 'commission_calculation_snapshot',
    brokerageId: c.brokerageId,
    reason: 'audit snapshot of the agreement + concessions a posted calculation used: the distributions already landed and are the money; its loss is ledgered, never silent',
  })

  try {
    await withActionLedger<{ ok: boolean }>(
      {
        brokerageId: c.brokerageId,
        action: 'finance.commission.calculated',
        actor: input.triggeredBy ? { type: 'user', userId: input.triggeredBy } : { type: 'system' },
        subject: { type: 'agent_commission', id: input.commissionId, ref: c.transactionId },
        reasonCode: 'TRANSACTION_MILESTONE',
        reasonDetail: `commission calculated on the ${agreement?.asOfSource ?? 'unknown'} ${agreement?.asOf ?? ''} agreement (${agreement?.source ?? 'unresolved'})`,
        idempotencyKey: `commission-calc:${input.commissionId}`,
        riskClass: 'FINANCIAL',
        systemSource: 'commission_engine',
        detail: { transaction_id: c.transactionId, commission_id: input.commissionId, ...engineInputs, breakdown },
      },
      async () => ({ ok: true }),
      { settle: () => ({ status: 'executed', outcome: 'posted_pending_approval' }), replay: () => ({ ok: false }) },
      { client: supabase },
    )
  } catch (e) {
    console.error('[commission-engine] calculation evidence claim failed:', e)
  }
}

// ─── THE CAP CYCLE CLAIM (wave 144, lane 144D — owner ruling 9) ───────────────────────────────────────────────────

/** What step 0d moved on the cap ledger — kept so a posting failure can release it and the evidence can cite it. */
interface CapClaim {
  trackingId: string
  start: string
  capAmountCents: number
  paidBeforeCents: number
  paidAfterCents: number
}

/**
 * Advance the deal's cap cycle by what the deal contributed (context.amountTowardsCap — the split from stage 07 plus any
 * cap-eligible fee / royalty from stage 10), BEFORE the ledger is posted. Opens the cycle's window when none exists (the
 * anniversary restart — lib/commission/cap-resolver.ts ensureAgentCapWindow, judged on the DEAL's date with the agreement's
 * cap and anniversary), then COMPARE-AND-SWAPs on the paid-to-date the deal was priced on. FAILS CLOSED: a refused read or
 * write, or a counter that moved underneath this calculation, throws — nothing is posted on an unproved cap.
 */
async function claimCapCycle(
  supabase: ReturnType<typeof createServiceClient>,
  context: WaterfallContext,
): Promise<CapClaim | null> {
  const cycle = context.capCycle
  if (!cycle || context.amountTowardsCap <= 0) return null

  let trackingId = cycle.trackingId
  let paidRaw: number | string | null = cycle.paidToDateRaw
  if (!trackingId) {
    const seeded = await ensureAgentCapWindow(supabase as never, {
      agentId: context.agentId,
      brokerageId: context.brokerageId,
      today: cycle.asOf,
      explicitCapAmount: cycle.capAmountCents / 100,
      agreementAnniversaryDate: cycle.agreementAnniversaryDate,
    })
    if (!seeded.ok) throw new Error(`[commission-engine:cap] the deal's cap cycle (${cycle.start} → ${cycle.end}) could not be opened: ${seeded.error}`)
    if (!seeded.result.trackingId) throw new Error(`[commission-engine:cap] the deal's cap cycle was not opened (${seeded.result.outcome})`)
    trackingId = seeded.result.trackingId
    // A window that appeared between stage 07 and here was opened by a concurrent deal: the swap below is predicated on
    // the $0 this deal was priced on, so a counter that already moved refuses rather than double-counting.
    paidRaw = 0
  }

  const before = cycle.paidToDateCents
  const after = before + context.amountTowardsCap
  const base = supabase
    .from('agent_cap_tracking')
    .update({ cap_paid_to_date: after / 100, is_capped: after >= cycle.capAmountCents })
    .eq('id', trackingId)
    .eq('brokerage_id', context.brokerageId)
  const swap = paidRaw === null ? base.is('cap_paid_to_date', null) : base.eq('cap_paid_to_date', paidRaw)
  const { data: moved, error } = await swap.select('id')
  if (error) throw new Error(`[commission-engine:cap] the cap ledger could not be advanced: ${error.message}`)
  if (!moved || moved.length !== 1) {
    throw new Error(
      `[commission-engine:cap] the agent's cap ledger moved while this deal was calculated (another deal posted against the same cycle) — ` +
      `recalculate so the cap is not crossed twice`,
    )
  }
  return { trackingId, start: cycle.start, capAmountCents: cycle.capAmountCents, paidBeforeCents: before, paidAfterCents: after }
}

/** Undo step 0d after a posting failure (compare-and-swap on the value it wrote). A refused release is logged by name. */
async function releaseCapClaim(supabase: ReturnType<typeof createServiceClient>, claim: CapClaim | null): Promise<void> {
  if (!claim) return
  const { data, error } = await supabase
    .from('agent_cap_tracking')
    .update({ cap_paid_to_date: claim.paidBeforeCents / 100, is_capped: claim.paidBeforeCents >= claim.capAmountCents })
    .eq('id', claim.trackingId)
    .eq('cap_paid_to_date', claim.paidAfterCents / 100)
    .select('id')
  if (error || !data || data.length !== 1) {
    console.error(`[commission-engine:cap] the cap claim on ${claim.trackingId} could NOT be released after a posting failure (${error?.message ?? `${data?.length ?? 0} rows`}) — cap_paid_to_date is ahead by ${(claim.paidAfterCents - claim.paidBeforeCents) / 100}; a finance admin must correct it`)
  }
}
