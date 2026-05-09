/**
 * Draft Document adapter — generates state-specific legal documents.
 *
 * document_type: 'offer' | 'listing_agreement' | 'invoice' | 'market_report' | 'avm_cma' | 'custom'
 *
 * For document types whose backing action isn't yet built, a pending record is
 * created in the documents table and the agent is notified to complete manually.
 * This ensures the workflow doesn't block while those actions are being built.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const draftDocumentAdapter: ChannelAdapter = {
  channel: "draft_document",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, contact, agentUserId, supabase } = ctx

    const docType = step.document_type ?? "custom"

    // Create a document record — baseline for all types
    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .insert({
        brokerage_id: brokerageId,
        contact_id: contact?.id ?? null,
        template_id: step.document_template_id ?? null,
        document_type: docType,
        status: "draft",
        content: step.body ?? "",
        state_code: step.document_state ?? null,
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (docErr) {
      return { status: "error", providerKey: "document", error: docErr.message }
    }

    const docId = doc?.id

    // Route to type-specific generation (graceful fallback if action not yet exported)
    try {
      if (docType === "offer") {
        const m = await import("@/app/actions/ai-offer-creation")
        if (typeof (m as any).generateOfferDraft === "function") {
          await (m as any).generateOfferDraft({
            brokerageId, contactId: contact?.id, agentUserId,
            state: step.document_state ?? "CA", documentId: docId,
          })
        }
      } else if (docType === "listing_agreement") {
        const m = await import("@/app/actions/ai-listing-intake")
        if (typeof (m as any).generateListingAgreement === "function") {
          await (m as any).generateListingAgreement({
            brokerageId, contactId: contact?.id, agentUserId,
            state: step.document_state ?? "CA", documentId: docId,
          })
        }
      } else if (docType === "invoice") {
        const m = await import("@/app/actions/ai-financial-management")
        const fn = (m as any).generateInvoice ?? (m as any).createExpense ?? null
        if (typeof fn === "function") {
          await fn({ brokerageId, contactId: contact?.id, agentUserId, documentId: docId })
        }
      } else if (docType === "market_report") {
        const m = await import("@/app/actions/ai-market-intelligence")
        if (typeof (m as any).generateMarketReport === "function") {
          await (m as any).generateMarketReport({
            brokerageId, contactId: contact?.id, agentUserId, documentId: docId,
          })
        }
      }
    } catch {
      // Generation action not yet built — document record exists as pending draft;
      // agent can complete it manually from the Documents section in CRM.
    }

    // Notify agent that a document draft was created and may need review
    if (agentUserId) {
      void Promise.resolve(
        supabase.from("notifications").insert({
          brokerage_id: brokerageId,
          type: "document_draft_ready",
          title: `Document Draft Created: ${docType.replace(/_/g, " ")}`,
          body: contact
            ? `A ${docType.replace(/_/g, " ")} draft has been created for ${contact.first_name ?? ""} ${contact.last_name ?? ""}. Review and finalize in Documents.`
            : `A ${docType.replace(/_/g, " ")} draft requires your review.`,
          priority: "normal",
        })
      ).catch(() => {})
    }

    return {
      status: "sent",
      providerKey: "document",
      messageId: docId,
      output: { document_id: docId, document_type: docType },
    }
  },
}
