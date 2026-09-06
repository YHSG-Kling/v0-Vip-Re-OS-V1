// lib/lenders/visible-milestones.ts
//
// THE ONE LIST OF MILESTONES A LENDER MAY SEE.
//
// This vocabulary was spelled TWICE, verbatim: once as an exported const at
// app/actions/lender-portal.ts:4 (which the lender portal page imports) and once
// as a module-private const in the "use server" sibling
// app/actions/lender-portal-actions.ts, which is the copy the query actually
// filters by (`.in("milestone_name", …)`). Two copies of one entitlement list is
// the defect CLAUDE.md §6 names: add a sixth milestone to the display list and
// the query keeps returning five, so the portal renders a step the server will
// never populate — an entitlement boundary that disagrees with itself.
//
// It lives HERE, in a leaf with no imports, rather than in either of those two
// files, because they already re-export each other: app/actions/lender-portal.ts
// re-exports the action module's server actions, so having the action module
// import the const back from it would close an import cycle through a
// `"use server"` barrel. A leaf both sides import has no cycle to close.
//
// app/actions/lender-portal.ts still EXPORTS this name, as a re-export, so every
// existing `import { LENDER_VISIBLE_MILESTONES } from "@/app/actions/lender-portal"`
// resolves unchanged.

/** The transaction_milestones.milestone_name values the lender portal exposes. */
export const LENDER_VISIBLE_MILESTONES = [
  "appraisal_ordered",
  "appraisal_completed",
  "loan_approved",
  "clear_to_close",
  "clear_to_close_received",
] as const
