// lib/transactions/milestone-auto-trigger.ts
// Automatically triggers milestone completion when specific documents are uploaded

import { completeMilestone } from '@/lib/transactions/milestone-service'

const DOC_TO_MILESTONE_MAP: Record<string, string> = {
  inspection_report:              'inspection_completed',
  appraisal_report:               'appraisal_completed',
  clear_to_close_letter:          'clear_to_close_received',
  closing_disclosure_agreement:   'cda_delivered',
  closing_disclosure:             'cd_uploaded',
  final_walkthrough:              'final_walkthrough_scheduled',
}

export async function triggerMilestoneFromDocument(params: {
  transactionId: string
  brokerageId:   string
  docType:       string
  uploadedBy:    string
}): Promise<{ success: boolean; triggered: boolean; milestoneName?: string }> {
  const milestoneName = DOC_TO_MILESTONE_MAP[params.docType]
  if (!milestoneName) return { success: true, triggered: false }

  await completeMilestone({
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    milestoneName,
    completedBy:   params.uploadedBy,
  })

  return { success: true, triggered: true, milestoneName }
}
