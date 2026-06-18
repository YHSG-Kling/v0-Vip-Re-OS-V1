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
    const { error: commissionError } = await supabase
      .from('commissions')
      .update({
        status: 'paid',
        paid_date: paidAt.slice(0, 10), // commissions.paid_date is a DATE
      })
      .eq('id', params.commissionId)
      .eq('brokerage_id', params.brokerageId)

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
    const { data: commission, error: commissionError } = await supabase
      .from('commissions')
      .select('status, paid_at:paid_date')
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
