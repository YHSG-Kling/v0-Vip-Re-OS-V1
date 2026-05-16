/**
 * Pure constants + types for the title-portal. Lives outside the
 * "use server" action file so consumer pages/components can import
 * without RPC overhead and without triggering "Server Actions must be
 * async functions" / "Only async functions allowed" build errors.
 */

export const TITLE_VISIBLE_MILESTONES = [
  "title_search_ordered",
  "title_commitment_issued",
  "closing_scheduled",
  "closed",
  "funding_confirmed",
] as const

export const TITLE_STATUS_OPTIONS = [
  { value: "title_search", label: "Title Search in Progress" },
  { value: "commitment_issued", label: "Commitment Issued" },
  { value: "closing_ready", label: "Closing Ready" },
  { value: "closed", label: "Closed" },
] as const

export type TitleStatus = typeof TITLE_STATUS_OPTIONS[number]["value"]
