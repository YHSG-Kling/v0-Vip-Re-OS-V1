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

    // State for state-specific forms — comes from the PROPERTY ADDRESS, not the
    // agent's office. Resolution order:
    //   1. step.document_state (explicit override on the workflow step)
    //   2. listing.state for offers/listing agreements (from the active transaction or contact's listing)
    //   3. contact.state (fallback)
    let resolvedState = step.document_state ?? null
    let propertyAddress: string | undefined
    if (!resolvedState && contact?.id) {
      // Try active listing for the contact (seller listing OR buyer's offer target)
      const { data: listing } = await supabase
        .from("listings")
        .select("state, address")
        .or(`contact_id.eq.${contact.id},seller_contact_id.eq.${contact.id}`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (listing) {
        resolvedState = (listing as any).state ?? null
        propertyAddress = (listing as any).address ?? undefined
      }
    }
    if (!resolvedState && contact?.id) {
      // Fall back to contact's saved state
      const { data: c } = await supabase
        .from("contacts")
        .select("state")
        .eq("id", contact.id)
        .maybeSingle()
      resolvedState = (c as any)?.state ?? null
    }

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

    // For offer / listing_agreement / brokerage_rep types, the property state is required
    // (not a default — different state = different forms). Block if state can't be resolved.
    if ((docType === "offer" || docType === "listing_agreement" || docType === "brokerage_representation") && !resolvedState) {
      if (docId) {
        await supabase.from("documents").update({
          status: "review",
          metadata: { error: "Property state could not be resolved — state-specific forms unavailable." },
        }).eq("id", docId)
      }
      return { status: "error", providerKey: "document", error: "Property state required to select correct forms" }
    }

    // Route to type-specific generation (graceful fallback if action not yet exported)
    try {
      if (docType === "offer") {
        const m = await import("@/app/actions/ai-offer-creation")
        if (typeof (m as any).generateOfferDraft === "function") {
          await (m as any).generateOfferDraft({
            brokerageId, contactId: contact?.id, agentUserId,
            state: resolvedState!, propertyAddress, documentId: docId,
          })
        }
      } else if (docType === "listing_agreement") {
        const m = await import("@/app/actions/ai-listing-intake")
        if (typeof (m as any).generateListingAgreement === "function") {
          await (m as any).generateListingAgreement({
            brokerageId, contactId: contact?.id, agentUserId,
            state: resolvedState!, propertyAddress, documentId: docId,
          })
        }
      } else if (docType === "brokerage_representation") {
        // Pull the state-specific brokerage representation form name and queue for signature
        const { getBrokerageRepresentationForm } = await import("@/lib/state-forms/registry")
        const formName = getBrokerageRepresentationForm(resolvedState!)
        if (docId) {
          await supabase.from("documents").update({
            content: `Brokerage representation form for ${resolvedState}: ${formName}.\n\nThis disclosure must be signed at engagement.`,
            status: "draft_ready",
            metadata: { state: resolvedState, form_name: formName },
          }).eq("id", docId)
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

    // ── Final status reconciliation ─────────────────────────────────────
    // Document state machine:
    //   draft               → just created, no generator run yet
    //   needs_agent_input   → packet staged for offer/listing — agent must finalize in FormWizard
    //   draft_ready         → ready for send_for_esign step
    //   review              → already in signing flow (set by send_for_esign)
    //   complete            → fully signed/finished
    //
    // If a docType-specific generator fired, it already set the correct status
    // (needs_agent_input for offer/listing, draft_ready for invoice/brokerage_rep).
    // For custom / market_report / fallback, flip to draft_ready so eSign can see it.
    if (docId) {
      const { data: current } = await supabase
        .from("documents").select("status").eq("id", docId).maybeSingle()
      if (current?.status === "draft") {
        await supabase.from("documents")
          .update({ status: "draft_ready" })
          .eq("id", docId)
      }
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
          priority: "medium",
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
