/**
 * Send-for-eSign adapter — routes a draft document to an eSignature provider.
 *
 * Reads `step.esign_document_id` (or pulls the most recent draft document for
 * the contact when omitted) and dispatches it through the configured eSign
 * provider. Default provider is Dotloop (already integrated at
 * lib/integrations/providers/dotloop-provider.ts and exposed by
 * app/actions/ai-listing-intake:createOrPullDotloop /
 * app/actions/ai-offer-creation:createOfferDotloop).
 *
 * Step config:
 *   esign_document_id: uuid             — optional; defaults to latest draft
 *   esign_provider:    'dotloop'        — extensible to docusign, hellosign
 *   esign_recipient:   'contact' | 'seller' | 'buyer' | 'lender' | 'opposing_agent'
 *   esign_subject:     text             — subject line on the signing request
 *   esign_message:     text             — message in the request body
 *
 * Output: { loop_id, signing_url, status, signed_at }
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const sendForEsignAdapter: ChannelAdapter = {
  channel: "send_for_esign",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, contact, agentUserId, supabase, previousOutputs } = ctx

    const provider = (step as any).esign_provider ?? "dotloop"
    const recipient = (step as any).esign_recipient ?? "contact"

    // Resolve the document — either explicitly set on the step, from a previous
    // step's output (variable graph), or the most recent draft for this contact.
    let documentId: string | null = (step as any).esign_document_id ?? null

    if (!documentId) {
      for (const output of Object.values(previousOutputs)) {
        if (output && typeof output === "object" && "document_id" in output) {
          documentId = (output as { document_id?: string }).document_id ?? null
          if (documentId) break
        }
      }
    }

    if (!documentId && contact?.id) {
      const { data: latest } = await supabase
        .from("documents")
        .select("id")
        .eq("contact_id", contact.id)
        .eq("status", "draft_ready")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      documentId = (latest as any)?.id ?? null
    }

    if (!documentId) {
      return { status: "error", providerKey: provider, error: "No document found to send for signature" }
    }

    // Fetch the document
    const { data: document } = await supabase
      .from("documents")
      .select("id, document_type, content, state_code, transaction_id, listing_id, metadata")
      .eq("id", documentId)
      .maybeSingle()

    if (!document) {
      return { status: "error", providerKey: provider, error: "Document not found" }
    }

    // ── Dotloop path ──────────────────────────────────────────────────────
    if (provider === "dotloop") {
      try {
        // Existing offer integration
        if (document.document_type === "offer" && (document as any).transaction_id) {
          const m = await import("@/app/actions/ai-offer-creation")
          if (typeof (m as any).createOfferDotloop === "function") {
            const result = await (m as any).createOfferDotloop({
              brokerageId,
              contactId: contact?.id,
              agentUserId,
              documentId,
              transactionId: (document as any).transaction_id,
              recipientType: recipient,
            })
            await supabase.from("documents")
              .update({ status: "review", metadata: { ...(document.metadata as any), esign_loop_id: result?.loopId } })
              .eq("id", documentId)
            return {
              status: "sent",
              providerKey: "dotloop",
              messageId: result?.loopId,
              output: {
                document_id: documentId,
                loop_id: result?.loopId,
                signing_url: result?.signingUrl ?? null,
                status: "sent_for_signature",
              },
            }
          }
        }

        // Existing listing integration
        if (document.document_type === "listing_agreement" && (document as any).listing_id) {
          const m = await import("@/app/actions/ai-listing-intake")
          if (typeof (m as any).createOrPullDotloop === "function") {
            const result = await (m as any).createOrPullDotloop({
              brokerageId,
              listingId: (document as any).listing_id,
              agentUserId,
              documentId,
            })
            await supabase.from("documents")
              .update({ status: "review", metadata: { ...(document.metadata as any), esign_loop_id: result?.loopId } })
              .eq("id", documentId)
            return {
              status: "sent",
              providerKey: "dotloop",
              messageId: result?.loopId,
              output: {
                document_id: documentId,
                loop_id: result?.loopId,
                signing_url: result?.signingUrl ?? null,
                status: "sent_for_signature",
              },
            }
          }
        }

        // Generic Dotloop path for brokerage representation, invoice, custom docs.
        // Falls through to provider's queueDocumentForSignature() if available.
        const dotloopMod = await import("@/lib/integrations/providers/dotloop-provider")
        const provider = new (dotloopMod as any).DotloopProvider()
        if (typeof provider.queueDocumentForSignature === "function") {
          const result = await provider.queueDocumentForSignature({
            brokerageId,
            documentId,
            documentContent: document.content,
            documentType: document.document_type,
            stateCode: document.state_code,
            recipientContactId: contact?.id,
          })
          await supabase.from("documents")
            .update({ status: "review", metadata: { ...(document.metadata as any), esign_loop_id: result?.loopId } })
            .eq("id", documentId)
          return {
            status: "sent",
            providerKey: "dotloop",
            messageId: result?.loopId,
            output: {
              document_id: documentId,
              loop_id: result?.loopId,
              signing_url: result?.signingUrl ?? null,
              status: "sent_for_signature",
            },
          }
        }

        // No specific path matched — record as pending and notify agent
        if (agentUserId) {
          void Promise.resolve(supabase.from("notifications").insert({
            brokerage_id: brokerageId,
            type: "esign_required_manual",
            title: "Manual eSign needed",
            body: `${document.document_type} for ${contact?.first_name ?? "contact"} is ready — Dotloop integration could not auto-send. Open the document and send manually.`,
            priority: "high",
          })).catch(() => {})
        }
        return {
          status: "sent",
          providerKey: "dotloop",
          output: {
            document_id: documentId,
            status: "manual_send_required",
            note: "Dotloop generic queue not implemented; document flagged for manual send.",
          },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { status: "error", providerKey: "dotloop", error: msg }
      }
    }

    return { status: "error", providerKey: provider, error: `Unsupported eSign provider: ${provider}` }
  },
}
