/**
 * Send-for-eSign adapter — routes a draft document to the agent's configured
 * eSignature provider.
 *
 * IMPORTANT: The eSign provider is per-AGENT/BROKERAGE — not hardcoded.
 * resolveTransactionFormsProvider() reads platform_credentials and returns
 * whichever provider the user/brokerage has connected (dotloop, docusign,
 * skyslope, formsimplicity, brokermint, authentisign). The same lookup
 * powers the FormWizard's "Send for signature" button — this adapter mirrors
 * that flow so workflow-driven sends behave identically to manual ones.
 *
 * Pre-condition: the document must already have status='draft_ready' or
 * 'review' (i.e. the agent has approved the packet in the FormWizard).
 * Documents with status='needs_agent_input' are SKIPPED — they're not
 * ready for signature yet.
 *
 * Step config:
 *   esign_document_id  uuid    — optional; defaults to latest approved doc
 *   esign_provider     text    — optional override; default = user's provider
 *   esign_recipient    text    — 'contact' | 'seller' | 'buyer' | 'lender' | 'opposing_agent'
 *   esign_subject      text    — subject line on the signing request
 *   esign_message      text    — body of the signing-request email
 *
 * Output: { loop_id | envelope_id, signing_url, provider, status }
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const sendForEsignAdapter: ChannelAdapter = {
  channel: "send_for_esign",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, contact, agentUserId, supabase, previousOutputs } = ctx

    // ── Resolve the agent's configured eSign provider ────────────────────
    // Step-level override beats brokerage default; brokerage default beats nothing.
    let provider: string = (step as any).esign_provider ?? ""
    let providerCredentials: { access_token: string | null; account_id: string | null } | null = null

    if (!provider) {
      try {
        const { resolveTransactionFormsProvider } = await import("@/lib/kernel/forms")
        const result = await resolveTransactionFormsProvider({ brokerage_id: brokerageId })
        if (result.success && result.data?.is_configured) {
          provider            = result.data.provider_name
          providerCredentials = {
            access_token: result.data.access_token,
            account_id:   result.data.account_id,
          }
        }
      } catch { /* fall through */ }
    }

    if (!provider || provider === "not_configured") {
      // Notify the agent that they need to connect an eSign provider
      if (agentUserId) {
        void Promise.resolve(supabase.from("notifications").insert({
          user_id: agentUserId,
          brokerage_id: brokerageId,
          type: "esign_provider_not_configured",
          title: "Connect an eSign provider",
          body: "A workflow tried to send a document for signature but no eSign provider is connected. Configure Dotloop, DocuSign, or another supported provider in Settings → Integrations.",
          priority: "high",
        })).catch(() => {})
      }
      return {
        status: "error",
        providerKey: "esign",
        error: "No eSign provider configured for this brokerage — connect one in Settings → Integrations",
      }
    }

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
        .in("status", ["draft_ready", "review"])         // approved-by-agent OR already in signing flow
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      documentId = (latest as any)?.id ?? null
    }

    if (!documentId) {
      return { status: "error", providerKey: provider, error: "No approved document found to send for signature" }
    }

    // Fetch the document
    const { data: document } = await supabase
      .from("documents")
      .select("id, document_type, content, state_code, transaction_id, listing_id, status, metadata")
      .eq("id", documentId)
      .maybeSingle()

    if (!document) {
      return { status: "error", providerKey: provider, error: "Document not found" }
    }

    // Block packets that haven't been approved by the agent yet — those
    // require human review/finalization in the FormWizard before signing.
    if (document.status === "needs_agent_input") {
      if (agentUserId) {
        void Promise.resolve(supabase.from("notifications").insert({
          user_id: agentUserId,
          brokerage_id: brokerageId,
          type: "esign_blocked_packet_pending",
          title: "Packet awaiting your approval",
          body: "A workflow tried to send a document for signature, but the offer/listing packet still needs your finalization in the FormWizard. Open it, complete the missing fields, and approve before this step can run.",
          priority: "high",
          entity_type: "document",
          entity_id: documentId,
        })).catch(() => {})
      }
      return {
        status: "skipped",
        providerKey: provider,
        error: "Document is still a packet awaiting agent finalization (status=needs_agent_input)",
      }
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
        const dotloopInstance = new (dotloopMod as any).DotloopProvider(providerCredentials)
        if (typeof dotloopInstance.queueDocumentForSignature === "function") {
          const result = await dotloopInstance.queueDocumentForSignature({
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

    // ── DocuSign / Skyslope / FormSimplicity / Brokermint / Authentisign ─
    // For non-Dotloop providers we don't yet have an inline integration —
    // create a task for the agent to send manually using their connected
    // provider's UI. This is a degraded but explicit path; users get a
    // notification so they don't silently miss the signature flow.
    if (agentUserId) {
      void Promise.resolve(supabase.from("notifications").insert({
        user_id: agentUserId,
        brokerage_id: brokerageId,
        type: "esign_provider_manual_send",
        title: `Send for signature via ${provider}`,
        body: `Workflow staged a ${document.document_type} for ${contact?.first_name ?? "the contact"}. Open ${provider} and send manually — auto-send for ${provider} is not yet wired (only Dotloop is auto-routable today).`,
        priority: "high",
        entity_type: "document",
        entity_id: documentId,
      })).catch(() => {})
    }

    await supabase.from("documents")
      .update({
        status: "review",
        metadata: { ...(document.metadata as any), esign_provider: provider, esign_pending_manual: true },
      })
      .eq("id", documentId)

    return {
      status: "sent",
      providerKey: provider,
      output: {
        document_id: documentId,
        provider,
        status: "manual_send_required",
        note: `Auto-send not implemented for ${provider} — agent notified to send manually.`,
      },
    }
  },
}
