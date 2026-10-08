// lib/leads/pre-approval.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE READING OF "is this buyer financed and ready" — the facts the system
// actually holds → the three `lead_intelligence` columns that scored them.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// `lib/services/lead-management.service.ts:504` awards +30 intent points on
// `lead_intelligence.pre_approved === true`. The column's SOLE writer
// (app/actions/lead-intelligence.ts:1339 updateIntelligenceProfile) never named
// it — nor `pre_approval_amount`, nor `financial_readiness`. An earlier wave
// corrected the column NAME in the reader (it had been `preapproval_status`,
// which is not a column at all) and did not follow the value to its writer, so
// the branch went from "unreachable because the name is wrong" to "unreachable
// because nothing writes it". A scoring branch that can never fire is a scale
// that silently tops out 30 points below what it claims.
//
// ─── THE JUDGEMENT CALL, AND THE EVIDENCE FOR IT ─────────────────────────────
//
// The branch is NOT deleted. There are two live, written facts that answer the
// question it asks, and both are available at the exact point the writer runs:
//
//   1. `contacts.lender_status` — CHECK-constrained to
//      cash | pre_approved | needs_pre_approval | unknown
//      (scripts/1002-isa-handoff-brief-and-qualification-carry-forward.sql:16).
//      WRITERS, all live:
//        lib/contact-pipeline/contact-capture.ts:199 + :444  (capture + CSV import)
//        app/actions/credit-copilot.ts:78                    (the credit co-pilot)
//        app/credit-pipeline/page.tsx:404                    (the credit pipeline board)
//      `enrichLeadData` (the only caller of the writer) loads the CONTACT row —
//      `supabase.from("contacts").select("*")` at app/actions/lead-intelligence.ts:735 —
//      so `lender_status` is already in its hand.
//
//   2. `buyer_financial_profiles` — contact-keyed, with `pre_approval_amount`,
//      `pre_approval_expires_at`, `is_cash_buyer` and `verified`. WRITER:
//      app/actions/buyer-financial.ts:84/:181/:267/:275, behind a real agent
//      surface. This is where the AMOUNT lives; `contacts` has no such column,
//      which is why `pre_approval_amount` had no honest source before.
//
// WHY NOT `leads.lender_status`: the column exists with the same CHECK, but the
// census finds NO WRITER for it anywhere in the tree (the ISA's own
// QualificationSignals — lib/ai-isa/qualification-core.ts:30 — carries
// confirmedIntent / urgency / readiness / engagement and NOTHING financial).
// Deriving from it would have moved the writerless read one column sideways.
// It is accepted here as an INPUT because the shape is identical and a future
// ISA capture would land there; it simply never supplies a value today. That
// absence is a finding, not a silent gap — see the report.
//
// WHY THIS IS NOT "post-conversion so it does not count": the owner's ruling is
// that a lead reaches an agent only once QUALIFIED or showing POSITIVE INTENT,
// and `enrichLeadData` is a CONTACT-stage enrichment — it is gated by
// `requirePermission("edit", "contact", …)` and keyed on a contacts id. The
// scorer likewise runs `calculateIntentScore(record, "contacts")` over a contact
// row. Both sides of this branch live at the stage where the fact exists. The
// pre-conversion lane keeps returning `null`, which is the truthful answer for
// it, not a zero.
//
// ─── WHAT IS DELIBERATELY *NOT* DERIVED ──────────────────────────────────────
//
// A CASH buyer does NOT set `preApproved`. `lender_status = 'cash'` is a
// different fact — no lender is involved and there is nothing to be approved
// for — and folding it in would put a value into a boolean column that its
// CHECK-constrained source distinguishes. It is carried in
// `financialReadiness` instead, where a reader can see it, and the +30 intent
// branch is left as the narrow question it was written to ask. Whether a cash
// buyer should score the same points is a PRODUCT decision about the scale, not
// a mapping decision, and is recorded rather than made here — the same ruling
// lib/finance/cap-progress.ts made about never emitting `post_cap`.
//
// PURE and dependency-free, so the cron-side writer and the request-scoped
// scorer share one reading instead of disagreeing about who is pre-approved.

/** The live CHECK on contacts.lender_status / leads.lender_status. */
export type LenderStatus = "cash" | "pre_approved" | "needs_pre_approval" | "unknown"

export const LENDER_STATUS_VALUES: readonly LenderStatus[] = [
  "cash",
  "pre_approved",
  "needs_pre_approval",
  "unknown",
] as const

/** The `buyer_financial_profiles` row this reading consults for the AMOUNT. */
export interface BuyerFinancialFacts {
  pre_approval_amount?: number | string | null
  /** DATE. A lapsed pre-approval is not a pre-approval. */
  pre_approval_expires_at?: string | null
  is_cash_buyer?: boolean | null
  verified?: boolean | null
}

export interface PreApprovalInput {
  /** contacts.lender_status (or leads.lender_status), verbatim. */
  lenderStatus?: string | null
  /** The contact's buyer_financial_profiles row, when one exists. */
  financial?: BuyerFinancialFacts | null
}

export interface PreApprovalReading {
  /**
   * `lead_intelligence.pre_approved`. NEVER null — the column is `DEFAULT false`
   * and NOT-nullable in practice, and "we hold no pre-approval fact" and "they
   * are not pre-approved" are the same claim for a scoring branch that only
   * tests `=== true`.
   */
  preApproved: boolean
  /**
   * `lead_intelligence.pre_approval_amount`. NULL when no financial profile
   * carries one, or when the pre-approval has EXPIRED — a stale number quoted as
   * current buying power is worse than no number.
   */
  preApprovalAmount: number | null
  /**
   * `lead_intelligence.financial_readiness` — free text in the schema, but it
   * speaks the lender_status VOCABULARY here rather than inventing a fifth set
   * of words for the same idea (CLAUDE.md §6). NULL when nothing is known.
   */
  financialReadiness: LenderStatus | null
  /** Why the verdict came out as it did — for the report, never for a score. */
  basis: "lender_status" | "financial_profile" | "none"
}

function isExpired(date: string | null | undefined, today: Date): boolean {
  if (!date) return false // no expiry recorded → not expired; absence is not lapse
  const day = today.toISOString().slice(0, 10)
  return String(date).slice(0, 10) < day
}

function asAmount(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The reading. Both inputs are optional because both are legitimately absent:
 * a contact captured from a web form has neither yet, and that is `false` /
 * `null` / `null` — an honest "nothing known", not a claim.
 *
 * `financial` wins over `lenderStatus` for the AMOUNT only. For the BOOLEAN, a
 * live non-expired pre-approval amount on the financial profile counts even when
 * `lender_status` was never set: the agent who entered a lender, a letter and an
 * amount has established the fact more concretely than a dropdown does, and
 * requiring both would let the stronger evidence score zero.
 */
export function readPreApproval(input: PreApprovalInput, today = new Date()): PreApprovalReading {
  const status = LENDER_STATUS_VALUES.includes(input.lenderStatus as LenderStatus)
    ? (input.lenderStatus as LenderStatus)
    : null

  const fin = input.financial ?? null
  const expired = isExpired(fin?.pre_approval_expires_at, today)
  const amount = expired ? null : asAmount(fin?.pre_approval_amount)

  // A cash buyer is recorded as cash, never as pre-approved — see the header.
  const cash = status === "cash" || fin?.is_cash_buyer === true

  const preApproved = !cash && (status === "pre_approved" || amount !== null)

  const financialReadiness: LenderStatus | null =
    status ?? (cash ? "cash" : preApproved ? "pre_approved" : null)

  const basis: PreApprovalReading["basis"] =
    status !== null ? "lender_status" : amount !== null || fin?.is_cash_buyer === true ? "financial_profile" : "none"

  return { preApproved, preApprovalAmount: amount, financialReadiness, basis }
}
