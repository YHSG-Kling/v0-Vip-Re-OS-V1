import { createServiceClient } from '@/lib/supabase/service'

/**
 * Transaction compliance check rules seeded at INSPECTION stage.
 * These are inserted into compliance_checklists for tracking.
 */
const INSPECTION_COMPLIANCE_CHECKS = [
  { check_name: 'Inspection Period Disclosed', category: 'disclosure', required: true },
  { check_name: 'Lead Paint Disclosure', category: 'disclosure', required: true },
  { check_name: 'HOA Documents Delivered', category: 'hoa', required: false },
  { check_name: 'Property Disclosure Signed', category: 'disclosure', required: true },
  { check_name: 'Earnest Money Receipt Confirmed', category: 'escrow', required: true },
  { check_name: 'TRID Timing Verified', category: 'trid', required: true },
]

export async function seedTransactionComplianceChecks(params: {
  transactionId: string
  brokerageId: string
  userId: string
}) {
  const supabase = createServiceClient()

  // Check for existing checks to avoid duplicates
  const { data: existing } = await supabase
    .from('compliance_checklists')
    .select('check_name')
    .eq('transaction_id', params.transactionId)
    .in('check_name', INSPECTION_COMPLIANCE_CHECKS.map(c => c.check_name))

  const existingNames = new Set((existing ?? []).map((r: { check_name: string }) => r.check_name))

  const rows = INSPECTION_COMPLIANCE_CHECKS
    .filter(c => !existingNames.has(c.check_name))
    .map(check => ({
      transaction_id:    params.transactionId,
      brokerage_id:      params.brokerageId,
      check_name:        check.check_name,
      category:          check.category,
      required:          check.required,
      compliance_status: 'pending',
      created_by:        params.userId,
    }))

  if (!rows.length) return { success: true, inserted: 0 }

  const { error } = await supabase.from('compliance_checklists').insert(rows)
  if (error) throw error

  return { success: true, inserted: rows.length }
}
