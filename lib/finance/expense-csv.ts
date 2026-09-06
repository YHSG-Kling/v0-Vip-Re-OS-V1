/**
 * lib/finance/expense-csv.ts
 *
 * THE BUSINESS-EXPENSE CSV, AND THE RULE THAT NO CREDENTIAL RIDES IN IT.
 *
 * ── OWNER RULING, VERBATIM (finding #294) ────────────────────────────────────
 *
 *   "294 no credentials should be listed in csv."
 *
 * What that resolves: `business_expenses.receipt_url` holds a SIGNED URL into the
 * PRIVATE `receipts` bucket — minted by app/actions/financials.ts#attachExpenseReceipt
 * with `bucket: "receipts"`, `public: false`, `signedTtlSeconds: 60 * 60 * 24 * 365`.
 * A signed URL is a BEARER CREDENTIAL: the string alone fetches the file, for a
 * year, with no session and no gate. Writing it into a CSV does not *reference*
 * the credential, it IS the credential — and the file outlives the export. Mailed
 * to a bookkeeper, dropped in a shared drive, or attached to a support ticket, it
 * no longer answers to exportExpensesCSV's tenancy gate at all.
 *
 * ── WHAT REPLACES IT, AND WHY ────────────────────────────────────────────────
 *
 * The person exporting expenses for bookkeeping needs two things the URL was
 * carrying by accident: (1) does a receipt EXIST for this row (the deduction-
 * readiness question — "missing receipts" is already a counter in the product),
 * and (2) can I get back to it. So the column is replaced by TWO that carry no
 * credential:
 *
 *   · `Receipt`     — "on file" / "missing". The bookkeeping FACT, sortable and
 *                     filterable in a spreadsheet, which a URL never was.
 *   · `Expense ID`  — the row's own uuid. The locator: a signed-in user opens the
 *                     expense in the app and follows the receipt from there,
 *                     where the gate still applies. A uuid is not a credential —
 *                     it authorizes nothing; RLS (`business_expenses_tenant`)
 *                     still decides who may read the row.
 *
 * REJECTED — the storage object PATH. Two measured reasons, not taste. First,
 * `business_expenses` has exactly ONE receipt column (live schema: agent_id,
 * amount, brokerage_id, category, created_at, description, expense_date, id,
 * receipt_url, team_id) — there is no path column, so a path could only be parsed
 * back out of the URL. Second, that parse is unreliable by construction:
 * `receipt_url` is ALSO written straight from caller input by
 * app/actions/financials.ts#logScopedExpense (and was by the since-deleted
 * app/api/financial/expenses route — lane N3a 2026-09-01, tombstone in
 * scripts/opposite-missing-census.ts), so the column can hold any string at all,
 * not just a `receipts`-bucket signed URL. A column that is a path on some rows
 * and a stranger's URL on others is worse than no column. It also spells the
 * brokerage uuid and the bucket layout into a file that has left the building,
 * for a reader who has no storage console to use it with.
 *
 * REJECTED — an in-app deep link. It is the better idea and it does not exist to
 * link to yet: /dashboard/financials/expenses renders a list, ignores query
 * params, and pages at 100 rows, so a per-expense link would land nowhere in
 * particular; and lib/platform/site-url.ts#siteUrl() returns "" when neither
 * NEXT_PUBLIC_APP_URL nor VERCEL_URL is set, which would put a bare relative
 * fragment in a file whose whole point is being readable away from the app.
 * Building that route is a capability, not this fix. `Expense ID` is the honest
 * locator TODAY; when the deep link exists it replaces this column, and it is
 * still not a credential.
 *
 * REJECTED — re-signing short-lived at export time. A 15-minute URL is a smaller
 * credential, not an absent one, and the owner ruled on presence, not on TTL.
 *
 * ── WHY THIS LIVES HERE AND NOT IN THE SERVER ACTION ─────────────────────────
 *
 * app/actions/financials.ts is `"use server"`: every export in it is a public
 * HTTP endpoint and must be async (CLAUDE.md §4). A pure builder cannot live
 * there. Keeping it here is also what makes the absence PROVABLE — the simulator
 * runs the REAL builder over a row carrying a real-shaped 365-day signed URL and
 * asserts nothing bearer-shaped survives, with a positive control that the same
 * finder goes red on the pre-ruling column (CLAUDE.md §2).
 */

/** One row as the export reads it. Shaped to the live `business_expenses` columns. */
export interface ExpenseCsvInput {
  id?: string | null
  expense_date?: string | null
  category?: string | null
  description?: string | null
  amount?: number | string | null
  /**
   * PRESENCE ONLY. Never emitted — see the ruling above. It is accepted here so
   * the builder can answer "on file / missing" without the caller pre-deciding,
   * and so the credential has exactly ONE place it can be dropped.
   */
  receipt_url?: string | null
}

/**
 * The columns of the business-expense CSV.
 *
 * NOTE FOR WHOEVER COMES NEXT: "Receipt URL" was here and was REMOVED under the
 * owner's ruling "no credentials should be listed in csv". Do not add it back,
 * and do not add any other signed URL, share link or token column. If a reader
 * needs the receipt itself, they open `Expense ID` in the app while signed in —
 * that is where the gate lives.
 */
export const EXPENSE_CSV_HEADERS = [
  "Date",
  "Category",
  "Description",
  "Amount",
  "Receipt",
  "Expense ID",
] as const

/** The one vocabulary for the receipt-presence column (CLAUDE.md §6). */
export const RECEIPT_ON_FILE = "on file"
export const RECEIPT_MISSING = "missing"

/**
 * PURE: is there a receipt behind this row? Presence, never the value.
 * Whitespace-only is not a receipt — `logScopedExpense` trims to null, but the
 * deleted API route did not, and any legacy row may not have.
 *
 * ONE VOCABULARY (CLAUDE.md §6), AND THE SECOND SPELLING IT REPLACED. The CSV's
 * `Receipt` column and the deduction-readiness panel's "Missing Receipts" tile
 * are the SAME bookkeeping fact, and until this was wired they answered it
 * differently: the panel tested `e.receipt_url` for truthiness
 * (app/dashboard/financials/components/planning/deduction-readiness-panel.tsx),
 * so a row whose `receipt_url` is `"   "` counted as ON FILE there while the
 * export — which trims — printed "missing". An agent could read 100% receipt
 * completeness on the dashboard and mail their bookkeeper a CSV saying the same
 * row has none. Whitespace is reachable: `logScopedExpense` trims to null, but
 * the deleted app/api/financial/expenses route accepted an allowlisted
 * `receipt_url` untrimmed and any pre-trim legacy row is still in the table.
 * The panel now calls THIS.
 */
export function hasReceipt(row: ExpenseCsvInput): boolean {
  return typeof row.receipt_url === "string" && row.receipt_url.trim().length > 0
}

/**
 * PURE: one CSV row, in EXPENSE_CSV_HEADERS order. Emits no URL of any kind.
 *
 * DELIBERATELY NOT EXPORTED. Row ORDER is an internal detail of this module's
 * contract — `buildExpenseCsv` is "the ONE audited builder" the compliance
 * comment in app/actions/financials.ts names, and it is what the simulator runs.
 * An exported row builder is an invitation to assemble a second CSV somewhere
 * else, which would bypass the RFC-4180 quoting below and could drift out of
 * EXPENSE_CSV_HEADERS order without anything noticing. Nothing is deleted here:
 * the function and its behaviour are unchanged and still reached on every
 * export, through `buildExpenseCsv`. Callers outside this file want
 * `buildExpenseCsv` (whole file) or `hasReceipt` (the one fact a row carries).
 */
function expenseCsvRow(row: ExpenseCsvInput): string[] {
  const amount = typeof row.amount === "number" ? row.amount : Number(row.amount ?? 0)
  return [
    row.expense_date ?? "",
    row.category ?? "",
    row.description ?? "",
    (Number.isFinite(amount) ? amount : 0).toFixed(2),
    hasReceipt(row) ? RECEIPT_ON_FILE : RECEIPT_MISSING,
    row.id ?? "",
  ]
}

/** PURE: RFC-4180 CSV (every cell quoted, embedded quotes doubled). */
export function buildExpenseCsv(rows: ExpenseCsvInput[]): string {
  return [EXPENSE_CSV_HEADERS as readonly string[], ...rows.map(expenseCsvRow)]
    .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n")
}

// ─── THE FINDER LIVES SOMEWHERE ELSE, ON PURPOSE ─────────────────────────────
//
// "Is this a credential?" is not an expense question, and two exports must not be
// able to answer it differently (CLAUDE.md §6). The patterns are in
// lib/security/export-credential-scan.ts, shared with the audit-events CSV.
// Re-exported here only so the simulator that proves THIS export has one import.
export {
  CSV_CREDENTIAL_PATTERNS,
  findCredentialsInCsv,
  type CredentialFinding,
  type CredentialPattern,
} from "@/lib/security/export-credential-scan"
