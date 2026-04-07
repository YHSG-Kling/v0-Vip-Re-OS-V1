// ─── LENDER MILESTONES (visible to lender portal) ────────────────────────────
// No "use server" directive here — this file exports a plain const so it can
// be imported by both Server Components and Client Components without error.
export const LENDER_VISIBLE_MILESTONES = [
  "appraisal_ordered",
  "appraisal_completed",
  "loan_approved",
  "clear_to_close",
  "clear_to_close_received",
] as const

// Re-export all server actions from the dedicated "use server" module so that
// existing imports of "@/app/actions/lender-portal" continue to resolve.
export {
  getLenderTransactionDetail,
  uploadLenderDocument,
  issueClearToClose,
  flagLenderIssue,
  updateLenderLoanStatus,
} from "@/app/actions/lender-portal-actions"
