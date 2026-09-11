import { createServiceClient } from "@/lib/supabase/service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

/**
 * Commission Payment Tracker
 * Manages commission payment status transitions post-close
 */

export interface MarkCommissionPaidParams {
  commissionId: string
  brokerageId: string
  paidBy: string
  paidAt?: string
  paymentMethod?: string
  paymentReference?: string
  notes?: string
}

export interface MarkDistributionPaidParams {
  distributionId: string
  brokerageId: string
  paidBy: string
  paidAt?: string
  paymentMethod?: string
  paymentReference?: string
  notes?: string
}

/**
 * Recompute `agents.ytd_gci` / `ytd_transactions` from `agent_commissions`
 * for the current calendar year — the single writer for both columns.
 * SURVIVOR (§1, wave 56 dead-code sweep): app/actions/agents.ts used to
 * carry this same computation as `updateAgentYTDStats`, a non-exported
 * function nothing ever called (agents.ytd_gci/ytd_transactions were seeded
 * 0/0 at agent creation and never touched again despite being read live on
 * agent-360, admin stats, mentorship matching, the brokerage roster and the
 * CDA). Deleted there with a tombstone naming this file:line so every
 * markCommissionPaid caller gets the refresh instead of relying on one
 * caller to remember it. `agents.cap_progress` is DELIBERATELY not written
 * here — it was dropped in m463 (see the comment this function's predecessor
 * carried; `lib/commission/cap-resolver.ts` + `agent_cap_tracking` are the
 * one cap answer now).
 */
export async function syncAgentYtdStats(
  supabase: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<void> {
  const currentYear = new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  const { data: commissions } = await supabase
    .from("agent_commissions")
    .select("agent_commission")
    .eq("agent_id", agentId)
    .eq("status", "paid")
    .gte("close_date", startDate)
    .lte("close_date", endDate)

  const ytdGci = commissions?.reduce((sum, c) => sum + (c.agent_commission || 0), 0) || 0
  const ytdTransactions = commissions?.length || 0

  const { error: ytdError } = await supabase
    .from("agents")
    .update({
      ytd_gci: ytdGci,
      ytd_transactions: ytdTransactions,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
  // supabase-js RESOLVES a refusal (§3) — a swallowed one leaves the roster's YTD stale silently.
  if (ytdError) console.error("[payment-tracker] agents YTD sync refused:", ytdError.message)
}

/**
 * Mark entire commission as paid
 * Updates commissions.status and all related distributions
 */
export async function markCommissionPaid(
  params: MarkCommissionPaidParams
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()
  const paidAt = params.paidAt || new Date().toISOString()

  try {
    // 1. Update commission record
    // Real state columns only. Payment metadata (paid_by/method/reference/notes)
    // is captured in the kernel audit trail (lifecycle_events.metadata) below —
    // not duplicated as write-only columns on the commission row.
    // KEEP-ONE (m283/m284): agent_commissions is the one ledger.
    // Column translation: commissions.paid_date (DATE) -> paid_at (timestamptz).
    // `.select()`'d so `agentId` below never needs a second round-trip read of
    // the row this same statement just moved to 'paid' (CLAUDE.md §3: a
    // DELETE/UPDATE that matches nothing still resolves cleanly, so the row
    // actually returned is the only proof the tenant predicate matched).
    const { data: updatedCommission, error: commissionError } = await supabase
      .from('agent_commissions')
      .update({
        status: 'paid',
        paid_at: paidAt,
      })
      .eq('id', params.commissionId)
      .eq('brokerage_id', params.brokerageId)
      .select('agent_id')
      .maybeSingle()

    if (commissionError) {
      return { success: false, error: commissionError.message }
    }

    // 2. Update all related distributions
    const { error: distributionsError } = await supabase
      .from('commission_distributions')
      .update({
        status: 'paid',
        paid_at: paidAt, // commission_distributions.paid_at is timestamptz
      })
      .eq('commission_id', params.commissionId)
      .eq('brokerage_id', params.brokerageId)

    if (distributionsError) {
      return { success: false, error: distributionsError.message }
    }

    // 3. Log payment event via kernel
    await transitionLifecycle({
      brokerageId: params.brokerageId,
      entityType:  "financial",
      entityId:    params.commissionId,
      fromState:   "pending",
      toState:     "paid",
      actorUserId: params.paidBy,
      actorRole:   "broker",
      eventType:   "commission.paid",
      metadata:    { paid_at: paidAt, payment_method: params.paymentMethod ?? null, payment_reference: params.paymentReference ?? null, notes: params.notes ?? null },
    })

    // 4. Refresh the agent's ytd_gci/ytd_transactions from the ledger this
    // update just changed. BUILT under §1 (dead-code sweep, wave 56): this
    // recompute existed as app/actions/agents.ts:updateAgentYTDStats, a
    // non-exported function never called anywhere — agents.ytd_gci and
    // ytd_transactions are read live across agent-360, admin stats,
    // mentorship matching, the brokerage roster and the CDA
    // (app/dashboard/transactions/[id]/cda/page.tsx:113 already names this
    // exact writer as the intended source), so every one of those screens
    // was showing whatever was seeded at agent creation (0/0) forever. This
    // is the SURVIVOR — every markCommissionPaid caller now gets the refresh
    // for free instead of each needing its own follow-up call. The old copy
    // is deleted with a tombstone at app/actions/agents.ts naming this file:line.
    if (updatedCommission?.agent_id) {
      await syncAgentYtdStats(supabase, updatedCommission.agent_id)
    }

    return { success: true }
  } catch (error: any) {
    console.error('[v0] Error marking commission as paid:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Mark individual distribution as paid
 * For partial payment tracking
 */
export async function markDistributionPaid(
  params: MarkDistributionPaidParams
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()
  const paidAt = params.paidAt || new Date().toISOString()

  try {
    // Update distribution record
    const { error: distributionError } = await supabase
      .from('commission_distributions')
      .update({
        status: 'paid',
        paid_at: paidAt, // commission_distributions.paid_at is timestamptz
      })
      .eq('id', params.distributionId)
      .eq('brokerage_id', params.brokerageId)

    if (distributionError) {
      return { success: false, error: distributionError.message }
    }

    // Log payment event
    const { data: distribution } = await supabase
      .from('commission_distributions')
      .select('commission_id')
      .eq('id', params.distributionId)
      .single()

    if (distribution) {
      await transitionLifecycle({
        brokerageId: params.brokerageId,
        entityType:  "financial",
        entityId:    params.distributionId,
        fromState:   "pending",
        toState:     "paid",
        actorUserId: params.paidBy,
        actorRole:   "broker",
        eventType:   "distribution.paid",
        metadata:    { commission_id: distribution.commission_id, paid_at: paidAt, payment_method: params.paymentMethod ?? null, payment_reference: params.paymentReference ?? null, notes: params.notes ?? null },
      })
    }

    return { success: true }
  } catch (error: any) {
    console.error('[v0] Error marking distribution as paid:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Get commission payment status
 */
export async function getCommissionPaymentStatus(
  commissionId: string,
  brokerageId: string
): Promise<{
  success: boolean
  status?: 'pending' | 'paid' | 'cancelled'
  paid_at?: string
  distributions?: Array<{
    id: string
    distribution_type: string
    calculated_amount: number
    status: string
    paid_at?: string
  }>
  error?: string
}> {
  const supabase = createServiceClient()

  try {
    // KEEP-ONE (m283/m284): agent_commissions is the one ledger; paid_at is
    // already the native column name here, so no alias is needed.
    const { data: commission, error: commissionError } = await supabase
      .from('agent_commissions')
      .select('status, paid_at')
      .eq('id', commissionId)
      .eq('brokerage_id', brokerageId)
      .single()

    if (commissionError || !commission) {
      return { success: false, error: 'Commission not found' }
    }

    const { data: distributions, error: distributionsError } = await supabase
      .from('commission_distributions')
      .select('id, distribution_type, calculated_amount, status, paid_at')
      .eq('commission_id', commissionId)
      .eq('brokerage_id', brokerageId)

    if (distributionsError) {
      return { success: false, error: distributionsError.message }
    }

    return {
      success: true,
      status: commission.status,
      paid_at: commission.paid_at,
      distributions: distributions || []
    }
  } catch (error: any) {
    console.error('[v0] Error getting commission payment status:', error)
    return { success: false, error: error.message }
  }
}
