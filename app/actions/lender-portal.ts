// ─── LENDER MILESTONES (visible to lender portal) ────────────────────────────
// No "use server" directive here — this file re-exports a plain const so it can
// be imported by both Server Components and Client Components without error.
//
// TOMBSTONE: the literal five-name array that stood here, and its verbatim twin
// in the "use server" sibling, are both gone. SURVIVOR:
// lib/lenders/visible-milestones.ts:25 — one list, imported by the display
// (app/portal/lender/[transactionId]/page.tsx) and by the query that filters on
// it (app/actions/lender-portal-actions.ts). This path still exports the name,
// so every existing importer resolves unchanged.
export { LENDER_VISIBLE_MILESTONES } from "@/lib/lenders/visible-milestones"

// Re-export all server actions from the dedicated "use server" module so that
// existing imports of "@/app/actions/lender-portal" continue to resolve.
export {
  getLenderTransactionDetail,
  uploadLenderDocument,
  issueClearToClose,
  flagLenderIssue,
  updateLenderLoanStatus,
} from "@/app/actions/lender-portal-actions"
