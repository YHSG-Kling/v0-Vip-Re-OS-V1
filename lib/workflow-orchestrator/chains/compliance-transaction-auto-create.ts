/**
 * Chain: compliance-transaction-auto-create
 *
 * Triggered when a fully-executed offer passes the compliance scan (all
 * buyer + seller signatures and initials verified). Auto-creates the
 * transactions row using extracted contract terms.
 *
 * Wraps the existing convertOfferToTransaction action so the same code path
 * runs whether triggered automatically (compliance pass) or manually.
 *
 * Steps:
 *   1. validate_signatures — verify both parties' sigs/initials present
 *   2. create_transaction  — call convertOfferToTransaction with extracted data
 *   3. notify_parties      — agent + TC + compliance manager notified
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { WorkflowChain } from "../types"

export const complianceTransactionAutoCreateChain: WorkflowChain = {
  key: "compliance-transaction-auto-create",
  label: "Auto-Create Transaction on Offer Compliance Pass",
  triggerEvent: "compliance.executed_offer_passed",
  steps: [
    {
      key: "validate_signatures",
      label: "Validate All Signatures + Initials",
      handler: async (ctx) => {
        // THE PAYLOAD IS ONE LEVEL DEEPER THAN THIS READ ASSUMED.
        //
        // Emitters pass `signature_scan: signatureScan`, whose shape is
        // { signatureCompleteness: { allRequiredSignaturesPresent, missingInitials,
        // missingSignatures }, ... }. This handler read those keys off the TOP
        // level, so `allRequiredSignaturesPresent` was always undefined, the first
        // guard always tripped, and the run was written `failed` every time. An
        // executed purchase agreement could never auto-create its transaction.
        // (The listing branch in app/actions/documents.ts reads the nested form
        // correctly — the two sides of the same file disagreed.)
        //
        // Both shapes are accepted so an older emitter cannot silently regress it.
        const raw  = ctx.metadata.signature_scan ?? {}
        const scan = raw.signatureCompleteness ?? raw

        // A purchase agreement is executed when BUYER and SELLER have both signed
        // and initialed. Same predicate the listing gate uses — one answer to
        // "is it signed", and absence never reads as signed.
        const { evaluateExecution } = await import("@/lib/compliance/signature-completeness")
        const verdict = evaluateExecution(
          { signatures: scan.signatures, initials: scan.initials },
          ["buyer", "seller"],
        )

        // Prefer the explicit per-role evidence when the scan carried it; fall back
        // to the aggregate flags for scans that only reported those.
        const hasPerRole = Array.isArray(scan.signatures) && scan.signatures.length > 0
        if (hasPerRole) {
          if (!verdict.executed) {
            return {
              success: false,
              error: `Not fully executed — missing: ${verdict.missing.join(", ")}`,
            }
          }
        } else {
          if (!scan.allRequiredSignaturesPresent) {
            return {
              success: false,
              error: "Compliance scan reports missing signatures — cannot auto-create transaction",
            }
          }
          if (scan.missingInitials?.length > 0) {
            return {
              success: false,
              error: `Missing initials on ${scan.missingInitials.length} required pages`,
            }
          }
        }
        return { success: true, output: { validated: true } }
      },
    },

    {
      key: "create_transaction",
      label: "Create Transaction Record",
      handler: async (ctx) => {
        const offerId = ctx.metadata.offer_id
        const extracted = ctx.metadata.extracted ?? {}

        if (!offerId) return { success: false, error: "Missing offer_id in metadata" }
        if (!ctx.agentUserId) return { success: false, error: "Missing agentUserId" }

        const { convertOfferToTransaction } = await import(
          "@/app/actions/buyer-offer/convert-to-transaction"
        )

        const result = await convertOfferToTransaction(
          offerId,
          ctx.agentUserId,
          extracted.closingDate ?? "",
          extracted.contractDate ?? new Date().toISOString().slice(0, 10),
          {
            // earnestMoneyDue is a DATE (the deposit's due-by milestone), NOT the
            // dollar amount — feeding extracted.earnestMoneyAmount here was the
            // root of the amount-as-date conflation. Leave it unset: the offer
            // bridge derives the real due date from the offer's own
            // earnest_money_due_days / earnest_money_due_at, and reads the deposit
            // AMOUNT from offers.earnest_money — the two are kept typed apart.
            inspectionDeadline: extracted.inspectionDeadline,
            appraisalDeadline: extracted.appraisalDeadline,
            financingDeadline: extracted.financingDeadline,
          }
        )

        if (!result?.success) {
          return { success: false, error: result?.error ?? "Transaction creation failed" }
        }

        return {
          success: true,
          output: { transactionId: result.transaction_id },
        }
      },
    },

    {
      key: "notify_parties",
      label: "Notify Agent + TC + Compliance",
      handler: async (ctx) => {
        const svc = createServiceClient()
        const txId = ctx.previousStepOutputs.create_transaction?.transactionId
        if (!txId) return { success: false, error: "No transactionId in prior step" }

        const notifyTargets: string[] = []
        if (ctx.agentUserId) notifyTargets.push(ctx.agentUserId)

        // Notify the deal's TC + compliance officer. user_type is stored in the
        // canonical lowercase vocabulary (see lib/security/types.ts CanonicalRole,
        // which lib/auth/permissions.ts's deleted `Role` copy used to restate) — the
        // TC role is 'tc', and 'compliance_manager' is a legacy alias of
        // 'compliance_officer'. The prior ['TC','compliance_manager'] filter
        // matched no rows, so TCs were never notified.
        const { data: staff } = await svc
          .from("users")
          .select("id, user_type")
          .eq("brokerage_id", ctx.brokerageId)
          .in("user_type", ["tc", "compliance_officer"])

        for (const u of staff ?? []) notifyTargets.push(u.id)

        if (notifyTargets.length > 0) {
          const rows = notifyTargets.map((userId) => ({
            user_id: userId,
            brokerage_id: ctx.brokerageId,
            title: "Transaction created from executed contract",
            body: "Compliance scan passed — transaction is now active.",
            type: "transaction_created",
            entity_type: "transaction",
            entity_id: txId,
            priority: "high",
            is_read: false,
          }))
          await svc.from("notifications").insert(rows)
        }

        return { success: true, output: { notifiedCount: notifyTargets.length } }
      },
    },
  ],
}
