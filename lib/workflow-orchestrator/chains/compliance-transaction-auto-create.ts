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
        const scan = ctx.metadata.signature_scan ?? {}
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
            earnestMoneyDue: extracted.earnestMoneyAmount?.toString(),
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

        // Find TC + compliance officer for this brokerage. The live
        // users.user_type CHECK constraint allows 'TC' (uppercase) +
        // 'compliance_officer' — earlier code used 'tc' /
        // 'transaction_coordinator' which never matched any row.
        const { data: staff } = await svc
          .from("users")
          .select("id, user_type")
          .eq("brokerage_id", ctx.brokerageId)
          .in("user_type", ["TC", "compliance_officer"])

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
