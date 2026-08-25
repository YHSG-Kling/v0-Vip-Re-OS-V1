"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"
import { OFFER_EVENT, OFFER_AUDIT_EVENT } from "@/lib/buyer-offer/offer-lifecycle"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import { logEventAndTrigger } from "@/lib/events/event-helpers"
import {
  planOutboundWatch,
  OUTSIDE_LISTING_AGENT_EMAIL_KEY,
  OUTSIDE_LISTING_AGENT_NAME_KEY,
  OUTBOUND_WATCH_ARMED_AT_KEY,
  type OutboundSignerRole,
} from "@/lib/inbound-mail/offer-detect"

// ── WAVE 12, R2 — WHO WE SENT IT TO IS RECORDED HERE ────────────────────────
//
// Owner's ruling: "if we send an offer out to an outsdie listing agents property
// listing for our buyers, you can check for the returned email from that listing
// agent."
//
// This is the surface that dispatches the packet, and it is the right place: it
// is the first point at which the recipient list is known to be final (the
// wizard's step-4 signers, or the auto-pull from the buyer's CRM contact) and
// the last point before the paperwork leaves the building. Nothing earlier in
// the buyer-offer chain has the recipients — `prefill-offer.ts` and
// `buyer-offers.ts:createOffer` build the offer from the PROPERTY, and on an
// outside listing they set `listing_id` null with the address on
// `property_address`, which is precisely why there is no listing row to hang a
// counterparty off and why it has to be recorded on the offer itself.
//
// `offers.metadata` is a live jsonb column and is where it goes — no column is
// invented. The write MERGES: a wholesale metadata assignment destroying
// `linked_offer_id` is the load-bearing defect of wave 9 and does not come back.
//
// The ROLE `listing_agent` already exists in the send UI (FormWizard step 4
// renders a "Listing Agent" row with name + email). This action's parameter type
// admitted only buyer/co_buyer/agent, so that address was flattened into "agent"
// and lost — indistinguishable from OUR OWN buyer's agent, which is why it can
// never be guessed back out of the signer list.

/** What the provider is told. Providers understand parties, not our deal roles. */
function providerRole(role: OutboundSignerRole | string): "buyer" | "co_buyer" | "agent" {
  return role === "co_buyer" ? "co_buyer" : role === "buyer" ? "buyer" : "agent"
}

interface SubmitForSignatureParams {
  offerId: string
  userId?: string  // ignored — derived from session (was a forgery vector)
  /** Optional — when omitted/empty, the buyer's signer info is auto-pulled from the offer's CRM contact. */
  signers?: Array<{
    name: string
    email: string
    /** `listing_agent` is the COUNTERPARTY on an outside listing — see the header. */
    role: OutboundSignerRole
  }>
  /** OPTIONAL signature placement tags (from the wizard's anchor plan, anchorsForProvider). When
   *  present they're forwarded to the provider so the marks place automatically. Absent → the agent
   *  places tabs in the provider UI (current behavior). */
  tags?: import("@/lib/integrations/providers/transaction-provider.interface").SignatureTag[]
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

  // ── AGENT READINESS HARD GATE — a license/CE/ethics-blocked agent can't send an offer for signature
  // (regulatory exposure). Canonical evaluator, same verdict as the offer-time gate + autonomous sweep.
  const { checkAgentTransactable } = await import("@/lib/compliance/agent-readiness-gate")
  const readiness = await checkAgentTransactable(supabase, userId)
  if (!readiness.transactable) {
    return { success: false, error: readiness.message ?? "Agent not clear to transact" }
  }

  // Get offer. Note esign_provider is the PLATFORM NAME (dotloop/docusign/…),
  // and provider_envelope_id is the actual envelope reference returned by the
  // provider — the webhook matches on that column.
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, brokerage_id, esign_provider, provider_envelope_id, property_address, buyer_commission_acknowledged_at, disclosed_commission_payer, metadata")
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
  let signers: Array<{ name: string; email: string; role: OutboundSignerRole }> = params.signers ?? []
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

  // WHO THE REPLY WILL COME FROM. Pure, so the three cases — in-house listing
  // (nothing to watch), outside listing with a counterparty (armed), outside
  // listing without one (REFUSED, and it says what is missing) — are provable
  // without a database. It never guesses the address out of the other signers:
  // our own buyer's agent is role `agent` too, and picking "an agent" would
  // record OUR side as the counterparty and route our own mail into the deal.
  const outboundWatch = planOutboundWatch({
    listingId: (offer.listing_id as string | null) ?? null,
    signers,
  })
  if (outboundWatch.refusal) {
    console.warn(`[submit-for-signature] offer ${offerId}: outbound reply watch NOT armed — ${outboundWatch.refusal}`)
  }

  // ── EVERY `activities` WRITE IN THIS FILE NOW CARRIES THE TENANT AND THE KEY ─
  // Four of this file's five inserts (the two `buyer.offer.block` audits, the
  // signature-requested event, and the provider-requested event) omitted
  // `brokerage_id`. It is NOT NULL with no default on the live schema, so each
  // of those inserts wrote ZERO rows. The signature-requested one destructures
  // its error and returns on it — which means EVERY call to this action failed
  // at that line and no offer has ever been sent for signature through it. Only
  // the sentinelWrite at the bottom supplied the tenant.
  //
  // They also omitted `entity_id`, which is the silent half: `entity_id` is
  // NULLABLE, so such a row inserts fine and is then invisible to every keyed
  // reader (status-sync.ts, track-offer-lifecycle.ts, expire-offers.ts,
  // offer-lifecycle.ts all filter entity_type='offer' AND entity_id=<offers.id>).
  //
  // The tenant comes from `offers.brokerage_id` — the offer was already proven
  // to belong to the caller's brokerage above, but the audit row's tenant is a
  // property of the offer, not of the caller.
  //
  // The actor is resolved ONCE: activities.agent_id FKs agents(id) and the
  // session gives a users id — disjoint spaces, resolved and never substituted.
  // (It was re-resolved on every insert, one round-trip each, for one answer.)
  const brokerageId  = offer.brokerage_id as string
  const actorAgentId = await resolveAgentId(supabase as any, userId)

  // NAR 2024 GATE: buyer commission disclosure must be acknowledged before submit.
  // The acknowledgment captures explicit comp terms + audit trail (IP/UA for
  // click-through, method=wet_signature/docusign/dotloop for agent-recorded).
  if (!offer.buyer_commission_acknowledged_at) {
    const { error: blockError } = await supabase.from("activities").insert({
      brokerage_id:  brokerageId,
      activity_type: OFFER_AUDIT_EVENT.BLOCKED,
      agent_id:      actorAgentId,
      entity_type:   "offer",
      entity_id:     offerId,
      title:         "Signature blocked: buyer commission disclosure not acknowledged",
      description:   `Offer ${offerId} blocked — NAR 2024 requires explicit commission acknowledgment before submission`,
      notes:         JSON.stringify({ offer_id: offerId, reason: "commission_disclosure_required" }),
      metadata:      { offer_id: offerId, reason: "commission_disclosure_required" },
      status:        "completed",
    })
    if (blockError) {
      // The refusal below stands regardless — the audit row is the record of it,
      // and a refusal whose audit row vanished must not be silent.
      console.error("[submit-for-signature] commission-disclosure block audit row failed to write:", blockError.message)
    }
    return {
      success: false,
      error: "Buyer must acknowledge commission disclosure before submission (NAR 2024 settlement)",
      blockerType: "commission_disclosure_required"
    }
  }

  // COMPLIANCE GATE: Must pass before requesting signatures.
  //
  // ⚠ READ THIS BEFORE "FIXING" THE TEST BELOW. `checkCompliancePassed` returns
  // a ComplianceCheckResult OBJECT, so `if (!compliancePassed)` can never be
  // true and this branch is unreachable — the same defect that was corrected in
  // respond-to-counter.ts in this pass. It is DELIBERATELY left alone HERE,
  // because the correction cannot be made in isolation: the event this gate
  // waits for cannot exist yet at this point in the lifecycle.
  //
  //   · buyer.offer.compliance.passed is emitted only by
  //     lib/buyer-offer/compliance-gate.ts:emitCompliancePassed, whose live
  //     callers are submit-to-compliance.ts (which REFUSES unless
  //     offers.buyer_signed_at is set — i.e. unless the buyer has ALREADY
  //     signed, which is what this action requests) and the staff-only override
  //     button in app/dashboard/listings/[id]/offers/components/compliance-bridge-panel.tsx.
  //   · submit-to-compliance.ts's own header and
  //     lib/esign-webhooks/finalize-packet.ts:199-204 both state the sequence:
  //     buyer signs → forward to listing agent → seller responds → THEN
  //     compliance.passed. Compliance is post-signature by design.
  //   · lib/buyer-offer/compliance-gate.ts's header scopes the constitutional
  //     rule to `buyer.offer.accepted` / `buyer.under_contract` — acceptance,
  //     not signature request.
  //
  // So making this test real would refuse every buyer-offer signature request
  // in the product, waiting on an event that by design comes later. The gate is
  // in the WRONG PLACE, not merely mis-tested. Owner decision required — see
  // docs/wave7-slice-writers.md § "The gate that cannot refuse". Nothing here is
  // loosened in the meantime.
  const compliancePassed = await checkCompliancePassed(offerId)
  if (!compliancePassed) {
    // Emit block event
    const { error: blockError } = await supabase.from("activities").insert({
      brokerage_id:  brokerageId,
      activity_type: OFFER_AUDIT_EVENT.BLOCKED,
      agent_id:      actorAgentId,
      entity_type:   "offer",
      entity_id:     offerId,
      title:        "Signature blocked: compliance not passed",
      description:  `Offer ${offerId} blocked from submission — compliance gate failed`,
      notes:        JSON.stringify({ offer_id: offerId, reason: "compliance_gate_failed" }),
      metadata:     { offer_id: offerId, reason: "compliance_gate_failed" },
      status:       "completed",
    })
    if (blockError) {
      console.error("[submit-for-signature] compliance block audit row failed to write:", blockError.message)
    }

    return {
      success: false,
      error: "Cannot submit for signature: compliance check not passed",
      blockerType: "compliance_gate"
    }
  }

  // Emit signature request event. THE line that made this whole action dead:
  // it omitted NOT NULL brokerage_id, so the insert wrote zero rows and errored,
  // and the check immediately below turned that into a hard return. Canonical
  // event name from lib/buyer-offer/offer-lifecycle.ts — the same constant
  // lib/buyer-offer/status-sync.ts maps to offers.status='submitted'.
  const { error: eventError } = await supabase.from("activities").insert({
    brokerage_id:  brokerageId,
    activity_type: OFFER_EVENT.SIGNATURE_REQUESTED,
    agent_id:      actorAgentId,
    contact_id:    offer.contact_id,
    entity_type:   "offer",
    entity_id:     offerId,
    title:         "Signature requested",
    description:   `Signature requested for offer ${offerId} (${signers.length} signer(s))`,
    notes:         JSON.stringify({ offer_id: offerId, signer_count: signers.length }),
    metadata:      { offer_id: offerId, signer_count: signers.length },
    status:        "completed",
  })

  if (eventError) {
    return { success: false, error: `Failed to log signature request event: ${eventError.message}` }
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
  // Provider faults were console-only; carry the reason out to the caller too.
  let providerError: string | null = null

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
        signers:               signers.map((s) => ({ email: s.email, name: s.name, role: providerRole(s.role) })),
        // Forward the provider-shaped placement tags when the caller supplied them (the wizard's
        // anchor plan) so the provider places the marks automatically instead of manual tabbing.
        ...(params.tags && params.tags.length > 0 ? { tags: params.tags } : {}),
      })

      const { error: providerEventError } = await supabase.from("activities").insert({
        brokerage_id:  brokerageId,
        activity_type: OFFER_AUDIT_EVENT.PROVIDER_SIGNATURE_REQUESTED,
        agent_id:      actorAgentId,
        contact_id:    offer.contact_id,
        entity_type:   "offer",
        entity_id:     offerId,
        title:         `Provider signature requested via ${credential.platform}`,
        description:   `Offer ${offerId} sent to ${credential.platform} for signature`,
        notes:         JSON.stringify({ offer_id: offerId, provider: credential.platform, envelope_id: envelopeId }),
        metadata:      { offer_id: offerId, provider: credential.platform, envelope_id: envelopeId },
        status:        "completed",
      })
      if (providerEventError) {
        // The envelope IS out at the provider — the offer update below is the
        // load-bearing write. Loud, not swallowed.
        console.error("[submit-for-signature] provider-requested audit row failed to write:", providerEventError.message)
      }
    } catch (error: any) {
      // Provider call failed — the offer still records the agent's intent, but the
      // agent must be TOLD, not just console.error'd: without an envelope nothing
      // was actually sent and the webhook has nothing to finalize against.
      providerError = String(error?.message ?? error)
      console.error("[submit-for-signature] Provider call failed:", providerError)

      // Put the fault on the agent's activity feed — a human-visible record, the
      // same lane the compliance/commission blocks above already use. Best-effort
      // (the offer update below is the load-bearing write) but sentinel-ledgered
      // rather than swallowed, so a feed that never records faults is detectable.
      const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
      const faultRowLanded = await sentinelWrite(supabase, supabase.from("activities").insert({
        activity_type: OFFER_AUDIT_EVENT.PROVIDER_SIGNATURE_FAILED,
        agent_id:      actorAgentId,
        entity_type:   "offer",
        entity_id:     offerId,
        brokerage_id:  brokerageId,
        title:         `Provider signature request FAILED via ${credential.platform}`,
        description:   `Offer ${offerId} could not be dispatched to ${credential.platform}: ${providerError}`,
        priority:      "high",
      }), { table: "activities", flow: "buyer_offer_submit_for_signature", brokerageId })
      // The comment above says this must be human-visible, not console-only.
      // sentinelWrite returns false when the row was lost — if that happens the
      // agent is NOT being told, and that has to be visible too.
      if (!faultRowLanded) {
        console.error(`[submit-for-signature] the provider-failure activity for offer ${offerId} was NOT written — the agent has no feed entry telling them nothing was sent`)
      }
    }
  }

  // Mark offer esign_status as sent + stamp the canonical envelope reference
  // on provider_envelope_id (not on esign_provider — that's the platform name).
  //
  // CHECKED, not fire-and-forget: supabase-js resolves a rejected update, so an
  // unread { error } here returned success while provider_envelope_id — the ONLY
  // key finalize-packet matches a signed envelope on — was never stamped. The
  // offer would then sit at its old status forever and never convert. Same file,
  // same rule as the eventError check above.
  //
  // The outbound watch rides ALONG with it rather than on a second write, so a
  // packet that went out and a record of who it went to can never disagree. The
  // blob is MERGED on top of what the offer already carries — never assigned.
  const sentAt = new Date().toISOString()
  const priorMetadata = ((offer.metadata ?? {}) as Record<string, unknown>)
  const dispatchPayload = {
    esign_status:         "sent",
    esign_sent_at:        sentAt,
    esign_provider:       credential?.platform ?? offer.esign_provider ?? null,
    provider_envelope_id: envelopeId ?? offer.provider_envelope_id ?? null,
    metadata: outboundWatch.armed
      ? {
          ...priorMetadata,
          [OUTSIDE_LISTING_AGENT_EMAIL_KEY]: outboundWatch.email,
          [OUTSIDE_LISTING_AGENT_NAME_KEY]:  outboundWatch.name,
          [OUTBOUND_WATCH_ARMED_AT_KEY]:     sentAt,
        }
      : priorMetadata,
  }
  const { error: offerUpdateError } = await supabase
    .from("offers")
    .update(dispatchPayload)
    .eq("id", offerId)

  if (offerUpdateError) {
    return {
      success: false,
      error: `Signature request dispatched but the offer record could not be updated (${offerUpdateError.message}). The envelope reference is unsaved, so a completed signature cannot be matched back — resolve this before the buyer signs.`,
      blockerType: "offer_update_failed",
      providerError,
    }
  }

  // Sync the operational index. Until this pass the signature-requested event
  // above carried no entity_id (and never landed at all), so this call queried
  // the offer key, found nothing, and returned
  // {success:false, error:"No lifecycle events found"} — discarded. Now that the
  // event is keyed, it should move offers.status to 'submitted'
  // (lib/buyer-offer/status-sync.ts). If it still cannot, the envelope IS out at
  // the provider, so this is not a reason to fail the action — but it is
  // reported rather than dropped, because a status column that silently stopped
  // tracking is exactly what put this lane in the dark.
  const sync = await syncOfferStatus(offerId)
  const statusSyncError = sync.success ? null : (sync.error ?? "offers.status could not be synced")
  if (statusSyncError) {
    console.error(`[submit-for-signature] offer ${offerId}: ${statusSyncError}`)
  }

  // Fire notification to the buyer contact so they know to expect the signature request
  if (offer.contact_id) {
    await logEventAndTrigger({
      brokerage_id: offer.brokerage_id,
      event_type: OFFER_AUDIT_EVENT.SIGNATURE_SENT_TO_CONTACT,
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
    message: providerError
      ? "Offer marked as sent, but the e-sign provider rejected the request — see providerError"
      : "Offer submitted for signature",
    // Non-null ⇒ nothing actually reached the provider. Surfaced instead of being
    // buried in server logs so the UI can tell the agent to retry.
    providerError,
    // Non-null ⇒ the events landed but offers.status did not follow.
    statusSyncError,
    // Non-null ⇒ this offer is on an OUTSIDE listing and no reply from the
    // listing agent can be routed back to it, because we do not know their
    // address. Surfaced, never silent: the packet is out either way, but the
    // deal's mail will land unfiled until this is supplied.
    outboundWatchError: outboundWatch.refusal,
    // true ⇒ a reply from the recorded listing agent will be routed to this offer.
    outboundWatchArmed: outboundWatch.armed,
  }
}
