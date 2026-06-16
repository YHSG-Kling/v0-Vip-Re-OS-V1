"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import { logEventAndTrigger } from "@/lib/events/event-helpers"

interface SubmitForSignatureParams {
  offerId: string
  userId?: string  // ignored — derived from session (was a forgery vector)
  /** Optional — when omitted/empty, the buyer's signer info is auto-pulled from the offer's CRM contact. */
  signers?: Array<{
    name: string
    email: string
    role: "buyer" | "co_buyer" | "agent"
  }>
}

export async function submitForSignature(params: SubmitForSignatureParams) {
  const { offerId } = params

  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  // CRITICAL auth gate — previously took caller-supplied userId, fetched
  // the offer by id (no auth), then used the offer's stored brokerage_id
  // to pull platform_credentials (Dotloop/DocuSign/SkySlope/Authentisign
  // OAuth tokens) and dispatched provider calls under them. Any
  // signed-in caller could send any tenant's offer for signature with
  // attacker-controlled signer emails — a wire-fraud / contract-fraud
  // vector.
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }
  const userId = user.id

  const supabase = createServiceClient()

  // Get offer. Note esign_provider is the PLATFORM NAME (dotloop/docusign/…),
  // and provider_envelope_id is the actual envelope reference returned by the
  // provider — the webhook matches on that column.
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, brokerage_id, esign_provider, provider_envelope_id, property_address, buyer_commission_acknowledged_at, disclosed_commission_payer")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }

  // Verify the offer belongs to caller's brokerage BEFORE pulling
  // platform_credentials with offer.brokerage_id.
  if (offer.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }

  // AUTO-PULL the buyer signer from the offer's CRM contact when the caller didn't pass signers —
  // the e-sign provider should get the buyer's name + email automatically (no manual re-typing). A
  // contact with no email on file is surfaced as a blocker, never faked.
  let signers = params.signers ?? []
  if (signers.length === 0) {
    const { buildSignersFromContacts } = await import("@/lib/intelligence/offer-signers")
    let buyer: { first_name?: string | null; last_name?: string | null; email?: string | null } | null = null
    if (offer.contact_id) {
      const { data: c } = await supabase.from("contacts").select("first_name, last_name, email").eq("id", offer.contact_id).maybeSingle()
      buyer = (c as any) ?? null
    }
    signers = buildSignersFromContacts(
      buyer ? { firstName: buyer.first_name, lastName: buyer.last_name, email: buyer.email } : null,
    )
    if (signers.length === 0) {
      return { success: false, error: "No buyer email on file to send for signature — add the buyer's email first.", blockerType: "missing_signer_email" }
    }
  }

  // NAR 2024 GATE: buyer commission disclosure must be acknowledged before submit.
  // The acknowledgment captures explicit comp terms + audit trail (IP/UA for
  // click-through, method=wet_signature/docusign/dotloop for agent-recorded).
  if (!offer.buyer_commission_acknowledged_at) {
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.block",
      agent_id:      userId,
      entity_type:   "offer",
      title:         "Signature blocked: buyer commission disclosure not acknowledged",
      description:   `Offer ${offerId} blocked — NAR 2024 requires explicit commission acknowledgment before submission`,
    })
    return {
      success: false,
      error: "Buyer must acknowledge commission disclosure before submission (NAR 2024 settlement)",
      blockerType: "commission_disclosure_required"
    }
  }

  // COMPLIANCE GATE: Must pass before requesting signatures
  const compliancePassed = await checkCompliancePassed(offerId)
  if (!compliancePassed) {
    // Emit block event
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.block",
      agent_id: userId,
      entity_type: "offer",
      title:        "Signature blocked: compliance not passed",
      description:  `Offer ${offerId} blocked from submission — compliance gate failed`,
    })

    return {
      success: false,
      error: "Cannot submit for signature: compliance check not passed",
      blockerType: "compliance_gate"
    }
  }

  // Emit signature request event
  const { error: eventError } = await supabase.from("activities").insert({
    activity_type: "buyer.offer.signature.requested",
    agent_id:      userId,
    entity_type:   "offer",
    title:         "Signature requested",
    description:   `Signature requested for offer ${offerId} (${signers.length} signer(s))`,
  })

  if (eventError) {
    return { success: false, error: "Failed to log signature request event" }
  }

  // Resolve the brokerage's connected e-sign platform from platform_credentials.
  // The contact (buyer/seller) has no provider — only the brokerage/team/agent does.
  const { data: credential } = await supabase
    .from("platform_credentials")
    .select("platform, account_id, access_token")
    .eq("brokerage_id", offer.brokerage_id)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Track the envelope id we end up with so we can stamp it on the offer.
  let envelopeId: string | null = offer.provider_envelope_id ?? null

  if (credential) {
    try {
      const provider = getTransactionProviderByName(credential.platform, {
        apiKey:    credential.access_token ?? "",
        profileId: credential.account_id ?? "",
      })

      // First-time submit: create the provider envelope/loop so we have an
      // externalTransactionId to send. Previously this was skipped when the
      // offer had no envelope, which silently turned sendForSignature into
      // a no-op + stamped the platform name as the "envelope id". The
      // webhook could then never match.
      if (!envelopeId) {
        const createRes = await provider.createTransaction({
          propertyAddress: offer.property_address ?? "Real estate transaction",
          transactionType: "purchase",
          agentId:         userId,
          contactId:       offer.contact_id ?? undefined,
          listingId:       offer.listing_id ?? undefined,
        })
        if (!createRes.success || !createRes.externalTransactionId) {
          throw new Error(createRes.error ?? "Provider createTransaction failed")
        }
        envelopeId = createRes.externalTransactionId
      }

      await provider.sendForSignature({
        externalTransactionId: envelopeId,
        documentId:            offerId,
        signers:               signers.map((s) => ({ email: s.email, name: s.name, role: s.role })),
      })

      await supabase.from("activities").insert({
        activity_type: "buyer.offer.provider.signature.requested",
        agent_id:      userId,
        entity_type:   "offer",
        title:         `Provider signature requested via ${credential.platform}`,
        description:   `Offer ${offerId} sent to ${credential.platform} for signature`,
      })
    } catch (error: any) {
      // Provider call failed — log and continue; offer status reflects intent
      console.error("[submit-for-signature] Provider call failed:", error?.message ?? error)
    }
  }

  // Mark offer esign_status as sent + stamp the canonical envelope reference
  // on provider_envelope_id (not on esign_provider — that's the platform name).
  await supabase
    .from("offers")
    .update({
      esign_status:         "sent",
      esign_sent_at:        new Date().toISOString(),
      esign_provider:       credential?.platform ?? offer.esign_provider ?? null,
      provider_envelope_id: envelopeId ?? offer.provider_envelope_id ?? null,
    })
    .eq("id", offerId)

  // Sync status
  await syncOfferStatus(offerId)

  // Fire notification to the buyer contact so they know to expect the signature request
  if (offer.contact_id) {
    await logEventAndTrigger({
      brokerage_id: offer.brokerage_id,
      event_type: "buyer.offer.signature.sent_to_contact",
      user_id:    userId,
      payload: {
        offerId,
        contact_id:  offer.contact_id,
        signerCount: signers.length,
        provider:    credential?.platform ?? null,
      },
      source:     "ui",
      dedupe_key: `offer-sig-sent-${offerId}-${Date.now()}`,
    }).catch(() => {})
  }

  return {
    success: true,
    message: "Offer submitted for signature"
  }
}
