import { seedTransactionComplianceChecks as seedChecks } from '@/app/actions/transaction-compliance'

/**
 * Seeds transaction compliance checks when stage advances to INSPECTION.
 * This is a thin wrapper around the server action for use in lib code.
 */
export async function seedTransactionComplianceChecks(params: {
  transactionId: string
  brokerageId: string
  userId: string
}) {
  return seedChecks(params.transactionId, params.brokerageId)
}
