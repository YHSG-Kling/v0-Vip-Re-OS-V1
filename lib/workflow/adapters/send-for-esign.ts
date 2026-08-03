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
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

/**
 * Record the packet of record (signature_requests) for a successful send —
 * this is the row the client portal's Sign button gates on (owner rule: the
 * button only appears when an ACTIVE packet exists, and routes to the invite
 * via signing_url when the provider returned one; l54-s01).
 *
 * WHY IT STAYS NON-FATAL, AND WHY IT IS NO LONGER SILENCED:
 * every caller below reaches this only AFTER the provider has already accepted
 * the envelope. Throwing or returning an error at this point would mark a step
 * that really did send as failed, and the workflow retry would cut a SECOND
 * envelope against the same document. So the send result stands — but the loss
 * is now OBSERVABLE two ways instead of discarded by `.then(() => {}, () => {})`:
 *   1. sentinelWrite ledgers the failure to self_heal_events (data_flow /
 *      best_effort_write) where the repair digest and Exception Center rank it;
 *   2. the boolean returned here rides out on the step's own output as
 *      `packet_recorded`, so the workflow ledger records that the send happened
 *      without a portal-visible packet rather than implying one exists.
 * Note supabase-js RESOLVES a rejected write, so the old silencer swallowed the
 * common case (FK/CHECK rejection), not just network faults.
 */
async function recordSignaturePacket(supabase: StepContext["supabase"], p: {
  brokerageId: string
  documentId: string
  contactId: string | null
  transactionId: string | null
  signingUrl: string | null
  envelopeId?: string | null
}): Promise<boolean> {
  // LIVE-SCHEMA CONTRACT: signature_requests.document_id FKs to
  // client_documents — this adapter sends AI-drafted `documents` rows, so
  // the id only goes on the packet when it actually exists there; otherwise
  // the packet anchors on (contact, transaction) and the portal's
  // single-active-packet fallback resolves it.
  const { data: cd } = await supabase.from("client_documents").select("id").eq("id", p.documentId).maybeSingle()
  return sentinelWrite(
    supabase,
    supabase.from("signature_requests").insert({
      brokerage_id: p.brokerageId,
      document_id: cd ? p.documentId : null,
      contact_id: p.contactId,
      transaction_id: p.transactionId,
      request_status: "pending",
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      signing_url: p.signingUrl,
      provider_envelope_id: p.envelopeId ?? null,
    }),
    { table: "signature_requests", flow: "workflow_send_for_esign", brokerageId: p.brokerageId },
  )
}

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
      .select("id, document_type, content, state_code, transaction_id, listing_id, status, storage_url, metadata")
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

    // ── Dotloop-specific document-type integrations (offer / listing) ────
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
            const packetRecorded = await recordSignaturePacket(supabase, {
              brokerageId, documentId,
              contactId: contact?.id ?? null,
              transactionId: (document as any).transaction_id ?? null,
              signingUrl: result?.signingUrl ?? null,
              envelopeId: result?.loopId ?? null,
            })
            return {
              status: "sent",
              providerKey: "dotloop",
              messageId: result?.loopId,
              output: {
                document_id: documentId,
                loop_id: result?.loopId,
                signing_url: result?.signingUrl ?? null,
                status: "sent_for_signature",
                // false ⇒ the envelope went out but no portal-visible packet exists
                // (loss is on the sentinel ledger). Never implied to be true.
                packet_recorded: packetRecorded,
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
            const packetRecorded = await recordSignaturePacket(supabase, {
              brokerageId, documentId,
              contactId: contact?.id ?? null,
              transactionId: (document as any).transaction_id ?? null,
              signingUrl: result?.signingUrl ?? null,
              envelopeId: result?.loopId ?? null,
            })
            return {
              status: "sent",
              providerKey: "dotloop",
              messageId: result?.loopId,
              output: {
                document_id: documentId,
                loop_id: result?.loopId,
                signing_url: result?.signingUrl ?? null,
                status: "sent_for_signature",
                packet_recorded: packetRecorded,
              },
            }
          }
        }

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { status: "error", providerKey: "dotloop", error: msg }
      }
    }

    // ── Generic provider path — EVERY implemented e-sign provider ────────
    // The canonical createTransaction → attachForms → sendForSignature flow.
    // All provider classes implement the same ITransactionProvider interface
    // (dotloop, docusign, skyslope, formsimplicity, authentisign), so the
    // flow that used to be Dotloop-only is provider-agnostic — resolved via
    // the same registry the FormWizard's submitForSignature uses. Brokermint
    // is the one provider with NO native e-sign (its class honestly returns
    // ESIGN_UNSUPPORTED) — it goes straight to the manual-send path below.
    let esignProv: import("@/lib/integrations/providers/transaction-provider.interface").ITransactionProvider | null = null
    if (provider !== "brokermint") {
      try {
        const { getTransactionProviderByName } = await import("@/lib/integrations/providers/provider-resolver")
        esignProv = getTransactionProviderByName(
          provider,
          providerCredentials?.access_token && providerCredentials?.account_id
            ? { apiKey: providerCredentials.access_token, profileId: providerCredentials.account_id }
            : undefined
        )
      } catch {
        // Unknown / not-yet-implemented provider name — fall to the manual path.
        esignProv = null
      }
    }

    if (esignProv) {
      try {
        // Resolve property address (best-effort)
        let propertyAddress = "Document"
        if ((document as any).listing_id) {
          const { data: l } = await supabase
            .from("listings").select("address").eq("id", (document as any).listing_id).maybeSingle()
          if (l?.address) propertyAddress = l.address
        }
        if (propertyAddress === "Document" && (document as any).transaction_id) {
          const { data: t } = await supabase
            .from("transactions").select("property_address").eq("id", (document as any).transaction_id).maybeSingle()
          if (t?.property_address) propertyAddress = t.property_address
        }

        // 1. Create the transaction container (loop / envelope / file)
        const txResult = await esignProv.createTransaction({
          propertyAddress,
          transactionType: document.document_type === "listing_agreement" ? "listing" : "purchase",
          contactId: contact?.id,
          listingId: (document as any).listing_id ?? undefined,
          transactionId: (document as any).transaction_id ?? undefined,
        })
        if (!txResult.success || !txResult.externalTransactionId) {
          return { status: "error", providerKey: provider, error: txResult.error ?? `${provider} createTransaction failed` }
        }

        // 2. Attach the document
        const attachResult = await esignProv.attachForms({
          externalTransactionId: txResult.externalTransactionId,
          forms: [{
            formName: `${document.document_type} — ${propertyAddress}`,
            formUrl:  document.storage_url ?? undefined,
            formData: { content: document.content ?? "", state: document.state_code ?? null },
          }],
        })
        if (!attachResult.success) {
          return { status: "error", providerKey: provider, error: attachResult.error ?? `${provider} attachForms failed` }
        }

        // 3. Send for signature
        const signers: Array<{ email: string; name: string; role: string }> = []
        if (contact?.email) {
          signers.push({
            email: contact.email,
            name:  `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || contact.email,
            role:  recipient,
          })
        }
        if (signers.length > 0) {
          const sendResult = await esignProv.sendForSignature({
            externalTransactionId: txResult.externalTransactionId,
            documentId,
            signers,
            message: (step as any).esign_message ?? undefined,
          })
          if (!sendResult.success) {
            return { status: "error", providerKey: provider, error: sendResult.error ?? `${provider} sendForSignature failed` }
          }
        }

        await supabase.from("documents")
          .update({
            status: "review",
            metadata: {
              ...(document.metadata as Record<string, unknown>),
              esign_loop_id: txResult.externalTransactionId,
              esign_provider: provider,
            },
          })
          .eq("id", documentId)

        let packetRecorded = false
        if (signers.length > 0) {
          packetRecorded = await recordSignaturePacket(supabase, {
            brokerageId, documentId,
            contactId: contact?.id ?? null,
            transactionId: (document as any).transaction_id ?? null,
            signingUrl: null, // provider invites ride email; the portal card says so
            envelopeId: txResult.externalTransactionId,
          })
        }

        return {
          status: "sent",
          providerKey: provider,
          messageId: txResult.externalTransactionId,
          output: {
            document_id: documentId,
            loop_id: txResult.externalTransactionId,
            signing_url: null,
            status: "sent_for_signature",
            signers_count: signers.length,
            packet_recorded: packetRecorded,
          },
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { status: "error", providerKey: provider, error: msg }
      }
    }

    // ── Manual-send path — Brokermint (no native e-sign) / unresolvable ──
    // Explicit degraded path: task the agent to send from their provider's
    // UI, and report the step honestly as SKIPPED (nothing was sent) so the
    // workflow ledger never claims a signature request that didn't happen.
    if (agentUserId) {
      void Promise.resolve(supabase.from("notifications").insert({
        user_id: agentUserId,
        brokerage_id: brokerageId,
        type: "esign_provider_manual_send",
        title: `Send for signature via ${provider}`,
        body: `Workflow staged a ${document.document_type} for ${contact?.first_name ?? "the contact"}. Open ${provider} and send manually — ${provider === "brokermint" ? "Brokermint has no native e-signature API" : `auto-send is not available for ${provider}`}.`,
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
      status: "skipped",
      providerKey: provider,
      output: {
        document_id: documentId,
        provider,
        status: "manual_send_required",
        note: `No auto-send lane for ${provider} — agent notified to send manually.`,
      },
    }
  },
}
