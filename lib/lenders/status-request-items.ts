// lib/lenders/status-request-items.ts
// Shared catalog for the agent → loan-officer "request status update" feature, in a
// non-"use server" module so both the server action and the client UI import it (a
// "use server" file may only export async functions).

export const REQUESTABLE_ITEMS = [
  "appraisal_status",
  "underwriting_status",
  "conditions_outstanding",
  "clear_to_close_eta",
  "loan_commitment_letter",
] as const

export type RequestableItem = (typeof REQUESTABLE_ITEMS)[number]

export const ITEM_LABEL: Record<RequestableItem, string> = {
  appraisal_status: "appraisal status",
  underwriting_status: "underwriting status",
  conditions_outstanding: "outstanding conditions",
  clear_to_close_eta: "clear-to-close ETA",
  loan_commitment_letter: "loan commitment letter",
}
