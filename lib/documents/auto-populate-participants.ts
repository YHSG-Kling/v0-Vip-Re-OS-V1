/**
 * lib/documents/auto-populate-participants.ts
 *
 * Post-scan hook: when the universal scanner classifies a document and
 * pulls structured fields, hand the result here so it gets WIRED INTO
 * the right transaction's participants when possible.
 *
 * Two mappings today:
 *   PAL  ('pre_approval_letter') → transaction_participants.lender
 *     extracted_fields.lender_name + .borrower_name + .max_loan_amount
 *     → lender row { name: lender_name, company: lender_name, ... }
 *   Signed contract ('signed_contract') → transaction_participants.title_company
 *     when extracted_fields.title_company is present → title row.
 *
 * Per agent direction: lender / title / inspector should not be auto-picked
 * from a brokerage preferred-vendor list. They come from the actual deal
 * documents. This hook is HOW that happens — the scanner extracts from the
 * uploaded PDF, we lift those fields into the participants table.
 *
 * Lookup: we find the transaction via documents.transaction_id OR via the
 * offer the document is linked to (documents.metadata.linked_offer_id →
 * offers.transaction_id). If there's no tx yet, we no-op — the participant
 * populator at tx-creation time will read the PAL / signed contract for
 * the contact and pick up the lender / title then.
 *
 * Idempotent. Skips when a participant with the same role already exists.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface AutoPopulateInput {
  documentId:     string
  classification: string
  extractedFields: Record<string, unknown>
  /** Resolved at scan time; carries over to participant lookups. */
  brokerageId:    string
  contactId:      string | null
  offerId:        string | null
  transactionId:  string | null
}

export interface AutoPopulateResult {
  inserted_count: number
  roles_inserted: string[]
  reason?:        string
}

export async function autoPopulateFromScannedDocument(
  supabase: SupabaseClient,
  input: AutoPopulateInput,
): Promise<AutoPopulateResult> {
  const { classification, extractedFields, brokerageId, contactId, offerId } = input
  let { transactionId } = input

  // We only care about classifications that yield participant data.
  if (classification !== "pre_approval_letter" && classification !== "signed_contract") {
    return { inserted_count: 0, roles_inserted: [], reason: "classification not actionable" }
  }

  // Resolve the transaction id when not already known: via offer.transaction_id.
  if (!transactionId && offerId) {
    const { data: offer } = await supabase
      .from("offers")
      .select("transaction_id")
      .eq("id", offerId)
      .maybeSingle()
    transactionId = (offer?.transaction_id as string | null) ?? null
  }

  // No transaction yet → defer. populateInitialParticipants will read the
  // PAL / signed_contract for this contact when the transaction gets created.
  if (!transactionId) {
    return { inserted_count: 0, roles_inserted: [], reason: "no transaction yet — deferred to tx-creation populator" }
  }

  const inserted: string[] = []

  // ── PAL → lender participant ──
  if (classification === "pre_approval_letter") {
    const lenderName = (extractedFields?.lender_name ?? "").toString().trim()
    if (lenderName) {
      const { data: existing } = await supabase
        .from("transaction_participants")
        .select("id")
        .eq("transaction_id", transactionId)
        .eq("role", "lender")
        .maybeSingle()
      if (!existing) {
        const { error } = await supabase.from("transaction_participants").insert({
          transaction_id: transactionId,
          brokerage_id:   brokerageId,
          role:           "lender",
          name:           lenderName,
          company:        lenderName,
          notes: [
            extractedFields?.loan_type        ? `Loan type: ${extractedFields.loan_type}`         : null,
            extractedFields?.max_loan_amount  ? `Max loan: $${extractedFields.max_loan_amount}`   : null,
            extractedFields?.borrower_name    ? `Borrower: ${extractedFields.borrower_name}`      : null,
            extractedFields?.expires_at       ? `PAL expires: ${extractedFields.expires_at}`      : null,
          ].filter(Boolean).join(" · ") || null,
        })
        if (!error) inserted.push("lender")
      }
    }
  }

  // ── Signed contract → stamp EM due window on the linked offer ──
  // The contract dictates "earnest money due within N days" — we lift
  // earnest_money_due_days into offers + compute earnest_money_due_at
  // from contract_date when known. The EM-receipt-watcher cron reads
  // earnest_money_due_at per-deal instead of a hardcoded window.
  if (classification === "signed_contract" && offerId) {
    const dueDaysRaw = extractedFields?.earnest_money_due_days
    const dueDays    = typeof dueDaysRaw === "number" ? dueDaysRaw : parseInt(String(dueDaysRaw ?? ""), 10)
    if (Number.isFinite(dueDays) && dueDays > 0) {
      const { data: offerRow } = await supabase
        .from("offers")
        .select("compliance_passed_at, fully_signed_contract_received_at, seller_signed_at, buyer_signed_at, earnest_money, earnest_money_due_days")
        .eq("id", offerId)
        .maybeSingle()
      if (offerRow && !offerRow.earnest_money_due_days) {
        // Anchor the deadline to whatever "contract is in effect" timestamp
        // we have on the offer:
        //   fully_signed_contract_received_at  →  the executed contract
        //   compliance_passed_at                →  agent submitted to compliance
        //   seller_signed_at OR buyer_signed_at →  whichever is later (counter case)
        const anchorIso =
          (offerRow.fully_signed_contract_received_at as string | null)
          ?? (offerRow.compliance_passed_at as string | null)
          ?? laterOf(offerRow.seller_signed_at as string | null, offerRow.buyer_signed_at as string | null)
          ?? new Date().toISOString()
        const anchor = new Date(anchorIso)
        const due    = new Date(anchor.getTime() + dueDays * 24 * 3600 * 1000)
        const emAmount = (extractedFields?.earnest_money_amount ?? null) as number | null
        await supabase
          .from("offers")
          .update({
            earnest_money_due_days: dueDays,
            earnest_money_due_at:   due.toISOString(),
            ...(emAmount && (!offerRow.earnest_money || Number(offerRow.earnest_money) === 0)
              ? { earnest_money: emAmount } : {}),
          })
          .eq("id", offerId)
      }
    }
  }

  // ── Signed contract → title_company participant ──
  if (classification === "signed_contract") {
    const titleCompany = (extractedFields?.title_company ?? "").toString().trim()
    if (titleCompany) {
      const { data: existing } = await supabase
        .from("transaction_participants")
        .select("id")
        .eq("transaction_id", transactionId)
        .eq("role", "title_company")
        .maybeSingle()
      if (!existing) {
        const { error } = await supabase.from("transaction_participants").insert({
          transaction_id: transactionId,
          brokerage_id:   brokerageId,
          role:           "title_company",
          name:           titleCompany,
          company:        titleCompany,
          notes:          (extractedFields?.title_officer ? `Officer: ${extractedFields.title_officer}` : null),
        })
        if (!error) inserted.push("title_company")
      }
    }
  }

  // Suppress unused-var warning when contactId path isn't taken.
  void contactId

  return { inserted_count: inserted.length, roles_inserted: inserted }
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a && !b) return null
  if (!a) return b
  if (!b) return a
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}
