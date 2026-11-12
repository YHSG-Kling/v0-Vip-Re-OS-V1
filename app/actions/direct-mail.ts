"use server"

/**
 * app/actions/direct-mail.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.9 — Direct Mail Engine Server Actions
 *
 * Provides direct mail campaign creation, recipient management, delivery
 * tracking, and response logging with full kernel wiring:
 *   - canAccessFeature('direct_mail') gate on all writes
 *   - resolveProvider(providerType='direct_mail') → 'lob' system default
 *   - processKernelEvent() for DIRECT_MAIL_CAMPAIGN_CREATED and DIRECT_MAIL_SENT
 *
 * Provider configuration (Lob API keys) is superadmin-owned — no provider UI here.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
// PURE CUT (wave 145, lane 145Z — test:proxy-graph-budget): the direct module, not the lib/kernel barrel (same export).
import { resolveProvider } from "@/lib/kernel/providers"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { mayUseFeature } from "@/lib/billing/billing-access"
import { dispatchDirectMail } from "@/lib/providers/dispatch"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
// THE ONE CREATOR of a user-authored campaign row. Aliased because this file's own export
// is createMailCampaign and ai-direct-mail's is createDirectMailCampaign; the kernel's name
// would read as a third door.
import { createDirectMailCampaign as fileDirectMailCampaign } from "@/lib/kernel/marketing"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface CreateMailCampaignParams {
  brokerageId: string
  agentId?: string
  campaignName: string
  targetAudience: string
  designUrl?: string
  copyText?: string
  quantity: number
  mailingDate?: string
  perPieceCost?: number
  createdBy: string
}

export interface AddRecipientsParams {
  campaignId: string
  recipients: Array<{
    contactId?: string
    /**
     * m491 — the audience member when they are an unconverted LEAD rather than a
     * contact. `dispatchDirectMail` explicitly permits mailing a lead row ("leads
     * are unconsented for most channels; the only outbound touches permitted to a
     * lead row are direct_mail and email"), so a mailing list that could only name
     * contacts could not say who half its pieces were addressed to. Nullable and
     * NOT exclusive with contactId — a converted lead legitimately carries both.
     */
    leadId?: string
    firstName: string
    lastName: string
    addressLine1: string
    addressLine2?: string
    city: string
    state: string
    zip: string
  }>
}

export interface TrackDeliveryParams {
  campaignId: string
  batchId: string
  deliveryPayload: Record<string, unknown>
  brokerageId: string
}

export interface LogResponseParams {
  brokerageId: string
  campaignId: string
  recipientId?: string
  contactId?: string
  /**
   * m491 — the LEAD who answered, when one is known to the caller. Usually left
   * unset: `logResponse` resolves it itself from the recipient row and then from
   * the campaign row (see the doc block on the action).
   */
  leadId?: string
  responseType: "qr_scan" | "landing_visit" | "call" | "form_submit" | "reply" | "appointment"
  /**
   * Anything the responder ACTUALLY WROTE — the text on a returned reply card,
   * the message field of a mailer form, the note an agent transcribes from a
   * call. This is what gets classified for intent and what an opt-out is read
   * out of, so it must be the consumer's own words and not a summary.
   */
  message?: string
  responseMetadata?: Record<string, unknown>
}

export interface SendCampaignParams {
  campaignId: string
  actorUserId: string
  brokerageId: string
  teamId?: string
  /**
   * Wave 150 (lane 150R, C40): PREVIEW, NOT SEND. Resolves the format's global Lob template(s) and THIS
   * tenant's brand merge variables for the first pending recipient and asks Lob for a proof with the
   * TEST key only (lib/providers/lob/client.ts createLobProof refuses a live key). Nothing is mailed,
   * nothing is charged, no recipient row changes; the proof is stamped on the ledger row.
   */
  previewOnly?: boolean
}

// ─── CAMPAIGN CRUD ────────────────────────────────────────────────────────────

/**
 * Creates a new direct mail campaign with kernel gating.
 * Fires DIRECT_MAIL_CAMPAIGN_CREATED event.
 */
export async function createMailCampaign(params: CreateMailCampaignParams) {
  try {
    if (!isValidUUID(params.brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    // ── IDENTITY FROM THE SESSION (wave 84E — §3 disjoint classes, §4 tenant) ──
    // This is a "use server" export, so every field below arrives from a request body.
    // Three ids of two classes: `createdBy` feeds the gate, the usage counter and
    // created_by (FK users); `agentId` feeds agent_id (FK agents). Callers had mixed
    // them — content-studio-client passed `agentId: userId`, ai-direct-mail passed one
    // id to both — and the FK refused every such insert (live direct_mail_campaigns: 0
    // rows, 2026-09-26). So: the tenant and the users id must BE the session's, and an
    // agents id must name an agents row in that tenant. When no agentId is given, the
    // session user's own agents row is crossed through the ONE survivor
    // lib/kernel/agent-identity.ts resolveAgentIdInBrokerage (NULL when they have none
    // — never the users id).
    const actor = await getAgentContext()
    if (!actor.isAuthenticated || !actor.userId || !actor.brokerageId) {
      return { success: false, error: "Not signed in to a brokerage — a direct mail campaign is filed by a signed-in brokerage user" }
    }
    if (!decideClaimedTenant({ actingBrokerageId: actor.brokerageId, claimedBrokerageId: params.brokerageId }).ok) { // The claimed-tenant rule is the ONE decision table (lane 93A, §6) — not a hand-rolled copy.
      return { success: false, error: "That brokerage is not yours — a direct mail campaign is filed in your own brokerage" }
    }
    if (params.createdBy !== actor.userId) {
      return { success: false, error: "createdBy must be your own users id — a direct mail campaign's created_by is the signed-in user" }
    }

    const supabase = await createClient()

    let agentRecordId: string | null = null
    if (params.agentId) {
      const { data: agentRow, error: agentError } = await supabase
        .from("agents")
        .select("id")
        .eq("id", params.agentId)
        .eq("brokerage_id", actor.brokerageId)
        .maybeSingle()
      if (agentError) return { success: false, error: `Could not verify the campaign's agent: ${agentError.message}` }
      if (!agentRow) {
        return { success: false, error: "That agent is not an agents row in your brokerage — agent_id takes an agents id, not a users id" }
      }
      agentRecordId = agentRow.id as string
    } else {
      agentRecordId = await resolveAgentIdInBrokerage(supabase, actor.userId, actor.brokerageId)
    }

    // TOMBSTONE (wave 85D, §1.1): the feature gate, the raw direct_mail_campaigns insert, the
    // usage counter and the DIRECT_MAIL_CAMPAIGN_CREATED emission that lived here MERGED onto
    // the one creator, lib/kernel/marketing.ts createDirectMailCampaign ("THE ONE CREATOR"
    // block). It is the same chain, and it is now shared with the voice webhook, which has
    // no cookie session to reach this action. This action stays the SESSION door: identity
    // is verified above, then handed over.
    const created = await fileDirectMailCampaign({
      ctx: { userId: actor.userId, brokerageId: actor.brokerageId, agentId: agentRecordId ?? undefined },
      campaignName: params.campaignName,
      targetAudience: params.targetAudience,
      designUrl: params.designUrl,
      copyText: params.copyText,
      quantity: params.quantity,
      mailingDate: params.mailingDate,
      perPieceCost: params.perPieceCost,
    })
    if (!created.success || !created.data) {
      return { success: false, error: created.error ?? "Direct mail campaign was not created" }
    }
    const campaign = created.data.campaign

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true, campaign }
  } catch (error) {
    console.error("[DirectMail] Create campaign error:", error)
    return handleError(error, "createMailCampaign")
  }
}

/**
 * Retrieves all direct mail campaigns for a brokerage.
 */
export async function getMailCampaigns(brokerageId: string) {
  try {
    if (!isValidUUID(brokerageId)) {
      return { success: false, error: "Invalid brokerage ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, campaigns: data || [] }
  } catch (error) {
    return handleError(error, "getMailCampaigns")
  }
}

// getMailCampaign(campaignId) was REMOVED (slice-3 orphan burn-down).
// Survivor: getMailCampaigns(brokerageId) above — the reader both live surfaces
// use (app/dashboard/campaigns/mail/mail-dashboard.tsx and
// app/dashboard/marketing/studio/marketing-studio-client.tsx), selecting the same
// columns and scoped by brokerage_id. One campaign is a .find() on a list those
// surfaces already hold. The removed by-id variant carried NO tenant filter at
// all — a bare .eq("id", …) leaning entirely on RLS. Nothing to merge.
// See docs/orphan-burndown-slice3.md.

/**
 * Updates a campaign. Only allowed when status is 'planning'.
 */
export async function updateMailCampaign(
  campaignId: string,
  updates: Partial<{
    campaignName: string
    targetAudience: string
    designUrl: string
    quantity: number
    mailingDate: string
    perPieceCost: number
    status: "planning" | "approved" | "printed" | "mailed"
  }>
) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    // Check current status
    const { data: existing } = await supabase
      .from("direct_mail_campaigns")
      .select("status")
      .eq("id", campaignId)
      .maybeSingle()

    if (existing?.status === "mailed") {
      return { success: false, error: "Cannot update a mailed campaign" }
    }

    const updatePayload: Record<string, unknown> = {}
    if (updates.campaignName !== undefined) updatePayload.campaign_name = updates.campaignName
    if (updates.targetAudience !== undefined) updatePayload.target_audience = updates.targetAudience
    if (updates.designUrl !== undefined) updatePayload.design_url = updates.designUrl
    if (updates.quantity !== undefined) updatePayload.quantity = updates.quantity
    if (updates.mailingDate !== undefined) updatePayload.mailing_date = updates.mailingDate
    if (updates.perPieceCost !== undefined) updatePayload.per_piece_cost = updates.perPieceCost
    if (updates.status !== undefined) updatePayload.status = updates.status

    const { data, error } = await supabase
      .from("direct_mail_campaigns")
      .update(updatePayload)
      .eq("id", campaignId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true, campaign: data }
  } catch (error) {
    return handleError(error, "updateMailCampaign")
  }
}

/**
 * Deletes a campaign. Only allowed when status is 'planning'.
 */
export async function deleteMailCampaign(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    // Check current status
    const { data: existing } = await supabase
      .from("direct_mail_campaigns")
      .select("status")
      .eq("id", campaignId)
      .maybeSingle()

    if (existing?.status && existing.status !== "planning") {
      return { success: false, error: "Cannot delete a campaign that is not in planning status" }
    }

    // Delete recipients first
    const { error: recipientsClearErr } = await supabase
      .from("direct_mail_recipients")
      .delete()
      .eq("campaign_id", campaignId)
    if (recipientsClearErr) return { success: false, error: `Could not remove the campaign's recipients: ${recipientsClearErr.message}` }

    // Delete the campaign
    const { error } = await supabase
      .from("direct_mail_campaigns")
      .delete()
      .eq("id", campaignId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true }
  } catch (error) {
    return handleError(error, "deleteMailCampaign")
  }
}

// ─── RECIPIENTS ───────────────────────────────────────────────────────────────

/**
 * Bulk inserts recipients for a campaign.
 */
export async function addRecipients(params: AddRecipientsParams) {
  try {
    if (!isValidUUID(params.campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    // Get brokerage_id from campaign — and, m491, the campaign's own recipient
    // anchor. A refused read is not "no such campaign": destructure it, or a
    // blocked query silently becomes a NULL-tenant insert.
    const { data: campaign, error: campaignError } = await supabase
      .from("direct_mail_campaigns")
      .select("brokerage_id, lead_id, contact_id")
      .eq("id", params.campaignId)
      .maybeSingle()

    if (campaignError) {
      return { success: false, error: `Could not read the campaign: ${campaignError.message}` }
    }
    if (!campaign) {
      return { success: false, error: "Campaign not found" }
    }

    // m491 — the audience member is anchored to whichever entity it actually is.
    // A LEAD recipient used to be written with contact_id NULL and nothing else,
    // i.e. an address with no identity: when that person answered the mailer there
    // was no row that could say who they were, and the conversion door
    // (ingestDirectMailResponseSignalAction) could never be called for them.
    // Falls back to the campaign's own lead_id/contact_id when the caller named
    // neither — a 1:1 campaign already knows exactly who it is addressed to.
    const campaignLeadId    = (campaign as { lead_id?: string | null }).lead_id ?? null
    const campaignContactId = (campaign as { contact_id?: string | null }).contact_id ?? null

    const recipientRows = params.recipients.map((r) => ({
      brokerage_id: campaign.brokerage_id,
      campaign_id: params.campaignId,
      contact_id: r.contactId ?? (r.leadId ? null : campaignContactId),
      lead_id: r.leadId ?? (r.contactId ? null : campaignLeadId),
      first_name: r.firstName,
      last_name: r.lastName,
      address_line1: r.addressLine1,
      address_line2: r.addressLine2 ?? null,
      city: r.city,
      state: r.state,
      zip: r.zip,
      delivery_status: "pending",
    }))

    const { data, error } = await supabase
      .from("direct_mail_recipients")
      .insert(recipientRows)
      .select()

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true, recipients: data }
  } catch (error) {
    return handleError(error, "addRecipients")
  }
}

/**
 * Retrieves recipients for a campaign.
 */
export async function getRecipients(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_recipients")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, recipients: data || [] }
  } catch (error) {
    return handleError(error, "getRecipients")
  }
}

/**
 * Removes a recipient from a campaign.
 */
export async function removeRecipient(recipientId: string) {
  try {
    if (!isValidUUID(recipientId)) {
      return { success: false, error: "Invalid recipient ID" }
    }

    const supabase = await createClient()

    const { error } = await supabase
      .from("direct_mail_recipients")
      .delete()
      .eq("id", recipientId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns/mail")
    return { success: true }
  } catch (error) {
    return handleError(error, "removeRecipient")
  }
}

// ─── TRACKING ─────────────────────────────────────────────────────────────────

/**
 * Records a Lob delivery event onto mail_tracking — the row the Tracking tab
 * (app/dashboard/campaigns/mail/components/tracking-tab.tsx, via
 * getTrackingRecords below) reads.
 *
 * PROVIDER-TRUTH INGEST, NOT A UI ACTION. This lives in a "use server" module,
 * so it is an HTTP endpoint. It used to be an anonymous one that took
 * `brokerageId` and a free-form `deliveryPayload` from whoever called it, which
 * meant anyone could forge "delivered" / "returned_to_sender" events against any
 * brokerage's campaign — on the most expensive touch the platform makes, and the
 * one a broker is most likely to be asked to prove. Two things changed:
 *
 *   1. SHARED-SECRET GATE. Same posture as the real Lob receiver
 *      (app/api/webhooks/lob-events/route.ts): LOB_WEBHOOK_SECRET must be set
 *      and must match. Unset = REFUSE — never silently open.
 *   2. THE TENANT IS RESOLVED, NOT ACCEPTED. brokerage_id comes off the campaign
 *      row. A campaign that cannot be read is a REFUSAL, not a NULL tenant: the
 *      read destructures `error`, and a refused read is not "no such campaign".
 *
 * WIRED (wave 4 slice 2) into app/api/webhooks/lob-events/route.ts, after
 * ingestProviderTruth, with the campaign resolved from `lob_order_id`. Before
 * that the Tracking tab rendered empty for every campaign, forever: nothing in
 * the tree wrote mail_tracking.
 *
 * SERVICE CLIENT, deliberately. mail_tracking's live RLS policy is
 * `brokerage_id = current_user_brokerage_id()` for ALL commands. The only caller
 * that can get past the secret gate above is an UNATTENDED one (Lob's receiver),
 * which has no session — so a cookie client would make every insert a silent
 * no-op and the Tracking tab would stay empty even once wired. The secret is the
 * gate; the tenant is still resolved from the campaign row, never accepted from
 * the caller.
 */
export async function trackDelivery(params: TrackDeliveryParams & { webhookSecret?: string }) {
  try {
    if (!isValidUUID(params.campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    // Provider-truth ingest is not callable by a browser. Unset secret = refuse. The compare is
    // CONSTANT-TIME (wave 140P — lib/security/constant-time.ts secretsEqual): `!==` returned at the
    // first differing byte and leaked the length of a correct prefix.
    const secret = process.env.LOB_WEBHOOK_SECRET
    const { secretsEqual } = await import("@/lib/security/constant-time")
    if (!secret || !secretsEqual(params.webhookSecret, secret)) {
      return {
        success: false,
        error:
          "Refused — trackDelivery records PROVIDER truth and is callable only by the Lob receiver with LOB_WEBHOOK_SECRET.",
      }
    }

    const supabase = createServiceClient()

    // Resolve the tenant from the campaign. Never take it from the caller, and
    // never let a refused read become a NULL brokerage_id on an inserted row.
    const { data: campaign, error: campaignError } = await supabase
      .from("direct_mail_campaigns")
      .select("id, brokerage_id")
      .eq("id", params.campaignId)
      .maybeSingle()

    if (campaignError) {
      return { success: false, error: `Cannot verify campaign tenancy: ${campaignError.message}` }
    }
    if (!campaign?.brokerage_id) {
      return { success: false, error: "Campaign not found, or has no brokerage — refusing to record delivery" }
    }

    const payload = (params.deliveryPayload ?? {}) as Record<string, string>

    const { data, error } = await supabase
      .from("mail_tracking")
      .insert({
        brokerage_id: campaign.brokerage_id,
        campaign_id: params.campaignId,
        batch_id: params.batchId,
        tracking_payload: params.deliveryPayload,
        provider_delivery_status: payload?.status ?? "unknown",
        mailed_at: payload?.mailed_at ?? null,
        delivered_at: payload?.delivered_at ?? null,
        returned_at: payload?.returned_at ?? null,
      })
      .select()
      .maybeSingle()

    if (error) throw error

    // ── WAVE 150 (lane 150R, C40): ASYNC DELIVERY OUTCOME ON THE ONE LEDGER, PER PIECE ──
    // The event settles onto the RECIPIENT row whose provider piece id it names (m985), in the campaign's
    // own tenant. What it proves comes from the one mapping (piece-type.ts mailOutcomeFromLobEvent): a
    // carrier scan is evidence about the piece — "delivered" reads `delivered_per_carrier_scan` — and is
    // NEVER household receipt (householdReceiptProven is false by type). An unmatched piece is said, not
    // read as success: the UPDATE is .select()ed and counted (CLAUDE.md §3).
    let pieceSettled = 0
    let truth: import("@/lib/direct-mail/mail-piece-rules").MailPieceTruth | null = null
    let returnedMail: import("@/lib/direct-mail/piece-type").ReturnedMailResult | null = null
    const pieceId = typeof payload?.lob_piece_id === "string" ? payload.lob_piece_id : params.batchId
    const lobEvent = String(payload?.lob_event ?? payload?.status ?? "")
    if (pieceId && lobEvent) {
      const { mailOutcomeFromLobEvent } = await import("@/lib/direct-mail/mail-piece-rules")
      const reading = mailOutcomeFromLobEvent(lobEvent)
      const at = payload?.delivered_at ?? payload?.returned_at ?? payload?.mailed_at ?? new Date().toISOString()
      const outcomePatch: Record<string, unknown> = { delivery_outcome: reading.outcome, last_provider_event: lobEvent, last_provider_event_at: at }
      if (payload?.expected_delivery_date) outcomePatch.expected_delivery_date = payload.expected_delivery_date
      if (reading.deliveryStatus && reading.deliveryStatus !== "mailed") outcomePatch.delivery_status = reading.deliveryStatus
      if (reading.deliveryStatus === "delivered") outcomePatch.delivered_at = at
      const { data: settled, error: settleErr } = await supabase
        .from("direct_mail_recipients")
        .update(outcomePatch)
        .eq("campaign_id", params.campaignId)
        .eq("brokerage_id", campaign.brokerage_id)
        .eq("provider_piece_id", pieceId)
        .select("id")
      if (settleErr) console.error(`[DirectMail] delivery outcome NOT settled on the recipient for piece ${pieceId}: ${settleErr.message}`)
      pieceSettled = Array.isArray(settled) ? settled.length : 0
      if (!settleErr && pieceSettled === 0) console.warn(`[DirectMail] Lob event ${lobEvent} for piece ${pieceId} matched no recipient of campaign ${params.campaignId} (a 1:1 drain piece has its own campaign row)`)

      // ── WAVE 151 (lane 151H): DELIVERY TRUTH + RETURNED MAIL ──
      // Six separate truths (mail-piece-rules.ts mailPieceTruth): this event is what it proves and nothing more — an accepted
      // or rendered piece is not mailed, a mailed piece is not delivered, a carrier scan is not household receipt. A piece
      // that came BACK corrects the address record it was mailed to and stops the sequence (applyReturnedMailHandling).
      const { mailPieceTruth } = await import("@/lib/direct-mail/mail-piece-rules")
      const { applyReturnedMailHandling } = await import("@/lib/direct-mail/piece-type")
      truth = mailPieceTruth(reading.outcome)
      if (reading.outcome === "returned_to_sender" && pieceSettled > 0) {
        const { data: rec, error: recErr } = await supabase
          .from("direct_mail_recipients")
          .select("id, campaign_id, lead_id, contact_id, address_line1, zip, delivery_status")
          .eq("campaign_id", params.campaignId).eq("brokerage_id", campaign.brokerage_id).eq("provider_piece_id", pieceId)
          .maybeSingle()
        if (recErr) console.error(`[DirectMail] returned piece ${pieceId}: recipient read refused: ${recErr.message}`)
        else if (rec) {
          returnedMail = await applyReturnedMailHandling(supabase, { brokerageId: campaign.brokerage_id, recipient: rec as { id: string; campaign_id: string | null; lead_id?: string | null; contact_id?: string | null; address_line1: string | null; zip: string | null; delivery_status?: string | null } })
          for (const e of returnedMail.errors) console.error(`[DirectMail] returned piece ${pieceId}: ${e}`)
        }
      }
    }

    return { success: true, tracking: data, pieceSettled, truth, returnedMail }
  } catch (error) {
    return handleError(error, "trackDelivery")
  }
}

/**
 * Retrieves tracking records for a campaign.
 */
export async function getTrackingRecords(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("mail_tracking")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, tracking: data || [] }
  } catch (error) {
    return handleError(error, "getTrackingRecords")
  }
}

// ─── RESPONSES ────────────────────────────────────────────────────────────────

/**
 * Logs a response to a direct mail piece.
 * Also inserts into mail_response_tracking for L9-S12 ROI aggregation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * m491 — THIS IS NOW THE MAIL LANE'S CONVERSION DOOR, not just a ledger write.
 *
 * The owner's ruling: "leads converting should be automatic as soon as positive
 * feedback is returned or a positive response from inbound calls/texts, email or
 * direct mail." Email, SMS and voice each already reach the evaluation door.
 * Direct mail did not, and could not, for a structural reason: neither
 * `direct_mail_responses` nor `direct_mail_recipients` had a `lead_id`, so a lead
 * who answered a mailer was written attached to NOBODY. m491 added the column.
 * This action now (a) writes it and (b) hands the answer to the ONE evaluator —
 * `app/actions/lead-signal-ingest.ts ingestDirectMailResponseSignalAction`, which
 * owns opt-out detection, intent classification, the already-converted guard, and
 * the canonical `classifyAndRouteInbound → … → createContactFromLead` chain.
 * NOTHING is re-implemented here; a second classifier is how two thresholds end
 * up disagreeing about the same sentence.
 *
 * HOW THE LEAD IS RESOLVED, most specific first:
 *   1. `params.leadId` — the caller already knows (rare).
 *   2. the RECIPIENT row's `lead_id` — the mailing-list entry this response names.
 *   3. the CAMPAIGN row's `lead_id` — `direct_mail_campaigns.lead_id` is how the
 *      1:1 lead path (lib/direct-mail/campaign-drain.ts) names its addressee, and
 *      that path writes no recipient row at all, so this arm is the one that
 *      actually fires for drain-dispatched lead mail.
 * If none of the three yields a lead, the response is recorded and stops there —
 * which is correct for a contact's response and for an audience campaign.
 *
 * THE TENANT IS RESOLVED, NOT ACCEPTED. `brokerageId` is still a parameter (the
 * live caller, ai-direct-mail.ts trackCampaignResponse, already derives it from
 * the campaign and cross-checks the session), but the campaign is now re-read
 * under that predicate through the COOKIE client, so RLS applies to the proof and
 * a response cannot be recorded against another brokerage's paid campaign.
 *
 * IDEMPOTENCY. `providerRef` is the inserted `direct_mail_responses.id` — the
 * natural key, unique by construction. A retried call inserts a new response row
 * and therefore a new ref, which is the honest reading: two logged responses are
 * two responses. The door's own guard stops the SAME response being evaluated
 * twice.
 */
export async function logResponse(params: LogResponseParams) {
  try {
    if (!isValidUUID(params.campaignId) || !isValidUUID(params.brokerageId)) {
      return { success: false, error: "Invalid IDs" }
    }

    const supabase = await createClient()

    // ── WHO ANSWERED — resolved before anything is written ────────────────────
    // A refused read is not "no such campaign". supabase-js RESOLVES a refusal;
    // destructuring it is the only thing separating "blocked" from "absent".
    const { data: campaign, error: campaignError } = await supabase
      .from("direct_mail_campaigns")
      .select("id, brokerage_id, lead_id, contact_id")
      .eq("id", params.campaignId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()

    if (campaignError) {
      return { success: false, error: `Could not verify campaign tenancy: ${campaignError.message}` }
    }
    if (!campaign) {
      return {
        success: false,
        error: "Campaign not found in this brokerage — refusing to record a response against it",
      }
    }

    let recipientLeadId: string | null = null
    let recipientContactId: string | null = null
    if (params.recipientId && isValidUUID(params.recipientId)) {
      const { data: recipient, error: recipientError } = await supabase
        .from("direct_mail_recipients")
        .select("id, lead_id, contact_id")
        .eq("id", params.recipientId)
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()
      if (recipientError) {
        return {
          success: false,
          error: `Could not read the recipient this response names: ${recipientError.message}`,
        }
      }
      recipientLeadId = (recipient as { lead_id?: string | null } | null)?.lead_id ?? null
      recipientContactId = (recipient as { contact_id?: string | null } | null)?.contact_id ?? null
    }

    const leadId =
      params.leadId ?? recipientLeadId ?? ((campaign as { lead_id?: string | null }).lead_id ?? null)
    const contactId =
      params.contactId ?? recipientContactId ?? ((campaign as { contact_id?: string | null }).contact_id ?? null)

    // Insert into direct_mail_responses
    const { data: response, error: responseError } = await supabase
      .from("direct_mail_responses")
      .insert({
        brokerage_id: params.brokerageId,
        campaign_id: params.campaignId,
        recipient_id: params.recipientId ?? null,
        contact_id: contactId,
        lead_id: leadId,
        response_type: params.responseType,
        response_metadata: params.responseMetadata ?? null,
      })
      .select()
      .maybeSingle()

    if (responseError) throw responseError

    // Also insert into mail_response_tracking for ROI aggregation. The refusal
    // used to be discarded entirely — a swallowed refusal here is how a campaign's
    // cost-per-response silently disagrees with its Responses tab.
    //
    // ── TOMBSTONE: `response_metadata` is NO LONGER WRITTEN HERE (2026-09-07) ──
    // It was a DUPLICATE (orphan doctrine §1.1). SURVIVOR:
    // `direct_mail_responses.response_metadata`, written above from the SAME
    // `params.responseMetadata` and genuinely read — app/actions/ai-direct-mail.ts
    // selects `*, responses:direct_mail_responses(*)`, which is what the
    // Responses tab renders. The copy on `mail_response_tracking` had no reader:
    // this table's only consumers take a COUNT
    // (app/api/cron/bundle-attribution-rollup/route.ts:166) or id/type/contact/
    // lead columns (lib/campaigns/roi-calculator.ts:316, :812), never metadata.
    // The twin write at app/api/qr/scan/route.ts was dropped in the same edit.
    //
    // The 2026-09-04 note that stood here kept the write pending ONE fact —
    // nullability — because PGRST/23502 refuses an INSERT that omits a NOT NULL
    // column with no default. MEASURED LIVE against hrvaqgvukzxfskkcrwbt on
    // 2026-09-07 (information_schema.columns): is_nullable = 'YES',
    // column_default = '{}'::jsonb. Omitting the column lands `{}`, which the
    // ROI consumers never read, so the ledger row is unchanged in every way
    // that is read.
    const { error: roiError } = await supabase.from("mail_response_tracking").insert({
      brokerage_id: params.brokerageId,
      campaign_id: params.campaignId,
      contact_id: contactId,
      lead_id: leadId,
      response_type: params.responseType,
    })
    if (roiError) {
      console.error("[DirectMail] ROI ledger write refused:", roiError.message)
    }

    // A neighbor-notification campaign is a direct-mail campaign wearing a
    // different card, and `responses_received` on that card had no writer — so
    // a neighbour who called back was recorded here and invisible there.
    // Derived from the responses just filed rather than incremented, so a
    // re-run cannot double-count.
    try {
      const { refreshNeighborCampaignCounters } = await import("@/lib/direct-mail/neighbor-campaign-rollup")
      const nnRollup = await refreshNeighborCampaignCounters(supabase, params.campaignId)
      if (nnRollup.refusal) {
        console.error("[DirectMail] neighbor counter rollup refused:", nnRollup.refusal)
      }
    } catch (err) {
      console.error("[DirectMail] neighbor counter rollup failed (non-blocking):", err)
    }

    // ── THE DOOR ──────────────────────────────────────────────────────────────
    // Only for a LEAD. A contact's mail response already lives in the CRM the
    // contact belongs to; there is nothing to convert.
    let leadSignal:
      | { outcome: string; reason?: string; contactId?: string; optOutChannels?: string[]; error?: string }
      | null = null
    if (leadId && (response as { id?: string } | null)?.id) {
      try {
        const { ingestDirectMailResponseSignalAction } = await import("@/app/actions/lead-signal-ingest")
        const written = (params.message ?? "").trim()
        const fromMeta =
          typeof params.responseMetadata?.message === "string"
            ? (params.responseMetadata.message as string)
            : undefined
        const outcome = await ingestDirectMailResponseSignalAction({
          brokerageId: params.brokerageId,
          leadId,
          responseType: params.responseType,
          message: written || fromMeta,
          campaignId: params.campaignId,
          providerRef: (response as { id: string }).id,
          internalSecret: process.env.CRON_SECRET,
        })
        leadSignal = {
          outcome: outcome.outcome,
          reason: outcome.reason,
          contactId: outcome.contactId,
          optOutChannels: outcome.optOutChannels,
          error: outcome.error,
        }
        if (outcome.error) {
          console.error(
            `[DirectMail] lead signal evaluation reported an error for lead ${leadId}: ${outcome.error}`,
          )
        }
      } catch (err) {
        // The response IS recorded; only the evaluation failed. Say so loudly —
        // a silently unevaluated hand-raise is the defect this whole lane exists
        // to close.
        console.error("[DirectMail] lead signal evaluation threw:", err)
        leadSignal = { outcome: "skipped", reason: "ingest_threw", error: String(err) }
      }
    }

    return { success: true, response, leadSignal }
  } catch (error) {
    return handleError(error, "logResponse")
  }
}

/**
 * Retrieves responses for a campaign.
 */
export async function getResponses(campaignId: string) {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    // m491 — the LEAD embed alongside the contact embed. A response from a lead
    // has contact_id NULL, so the Responses tab rendered a nameless row for every
    // mail piece the product sent to a lead. Unambiguous: `direct_mail_responses`
    // has exactly one FK onto `leads` (direct_mail_responses_lead_id_fkey).
    const { data, error } = await supabase
      .from("direct_mail_responses")
      .select("*, contacts(first_name, last_name, email, phone), leads(first_name, last_name, email, phone)")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, responses: data || [] }
  } catch (error) {
    return handleError(error, "getResponses")
  }
}

// getResponseSummary(campaignId) was REMOVED (slice-3 orphan burn-down).
// Survivor: getResponses(campaignId) directly above — the reader the Responses
// tab uses. It returns the same rows (same table, same filter) with strictly
// more on them, response_type included; the per-type counts this action computed
// are a reduce() over data the surface already has in hand. Nothing to merge.
// See docs/orphan-burndown-slice3.md.

// ─── SEND CAMPAIGN ────────────────────────────────────────────────────────────

/**
 * Sends a campaign via the resolved direct mail provider (Lob).
 * - canAccessFeature('direct_mail') gate
 * - resolveProvider(providerType='direct_mail') → 'lob'
 * - Updates campaign status to 'mailed'
 * - Fires DIRECT_MAIL_SENT event
 */
export async function sendCampaign(params: SendCampaignParams) {
  try {
    if (!isValidUUID(params.campaignId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // ── IDENTITY FROM THE SESSION (wave 145, lane 145Z — CLAUDE.md §4) ──
    // A "use server" export: brokerageId and actorUserId arrive in a request body. The
    // barrel cut (test:proxy-graph-budget) let test:tenant-scope SEE this door for the first
    // time — it judges whole-object hand-offs only for `@/lib/kernel/*` imports, so the old
    // `from "@/lib/kernel"` barrel hid params.brokerageId flowing into resolveProvider,
    // processKernelEvent and the dispatcher. The session wins: a claimed foreign tenant is
    // refused, and both ids are RE-KEYED from the session before any use. (The campaigns tab
    // passed `campaign.agent_id` — an agents id — as actorUserId; the session users id
    // replaces it, which is the class mayUseFeature takes.)
    const actor = await getAgentContext()
    if (!actor.isAuthenticated || !actor.userId || !actor.brokerageId) {
      return { success: false, error: "Not signed in to a brokerage — a direct mail campaign is sent by a signed-in brokerage user" }
    }
    if (!decideClaimedTenant({ actingBrokerageId: actor.brokerageId, claimedBrokerageId: params.brokerageId }).ok) {
      return { success: false, error: "That brokerage is not yours — a direct mail campaign is sent from your own brokerage" }
    }
    params = { ...params, brokerageId: actor.brokerageId, actorUserId: actor.userId }

    // ── Kernel Gate: canAccessFeature ──
    const access = await mayUseFeature(params.actorUserId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // ── Resolve provider ──
    const provider = await resolveProvider({
      providerType: "direct_mail",
      actorContext: {
        userId: params.actorUserId,
        brokerageId: params.brokerageId,
        teamId: params.teamId,
      },
    })
    // provider.providerKey should be 'lob' (system default)

    // Get campaign and recipients
    const { data: campaign, error: campaignError } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("id", params.campaignId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()

    if (campaignError) {
      return { success: false, error: `Could not read the campaign: ${campaignError.message}` }
    }
    if (!campaign) {
      return { success: false, error: "Campaign not found" }
    }

    if (campaign.status === "mailed") {
      return { success: false, error: "Campaign already mailed" }
    }

    const { data: recipients, error: recipientsError } = await supabase
      .from("direct_mail_recipients")
      .select("*")
      .eq("campaign_id", params.campaignId)
      .eq("delivery_status", "pending")

    if (recipientsError) {
      return { success: false, error: `Could not read the campaign's recipients: ${recipientsError.message}` }
    }
    if (!recipients?.length) {
      return { success: false, error: "No pending recipients to mail" }
    }

    // ── WAVE 150 (lane 150R, owner ruling R5 / C40): THE FORMAT DECIDES THE TEMPLATE ──
    // TOMBSTONE: this used to mail `templateId: campaign.design_url ?? campaign.id` with no piece type —
    // a campaign UUID handed to Lob as a template id, every campaign a letter, and no brand. The ONE
    // format router (lib/direct-mail/piece-type.ts routeMailFormat) now names the GLOBAL Lob template(s)
    // for the campaign's format (distinct ids per format; a postcard's back is never its front; a format
    // with none, or two formats sharing one id, is refused BEFORE any spend). The campaign's own uploaded
    // design is DATA: it travels as the hosted `front_art_url` merge variable, never as a template.
    const { routeMailFormat, formatForCampaignPieceType, readMailBrandFacts, buildMailMergeVariables, mailPieceIdempotencyKey, mailTemplateProvenance, campaignSendGate } =
      await import("@/lib/direct-mail/piece-type")
    const route = routeMailFormat(formatForCampaignPieceType(campaign.piece_type as string | null))

    // ── WAVE 151 (lane 151H): TENANT APPROVAL BEFORE SEND + THE SPEND GUARD OVER THE WHOLE BATCH ──
    // A campaign a human has not yet approved (approval_status pending / pending_review / rejected) is refused here — the Send
    // click cannot step over the approval queue. The spend guard asks the SAME billing resolver the dispatcher asks per piece
    // (lib/billing/billing-access.ts mayUseAndAfford — the tenant's mail budget + subscription), but for pieces × the ONE Lob
    // price BEFORE the first piece, so a 500-piece campaign is refused at piece 0 and not at piece 300. The preview is kept
    // as evidence on the campaign (spend_preview, m981). A degraded budget read proceeds with a warning (the dispatcher's
    // documented fail-open for the budget half); an affirmative refusal stops the send.
    let spendGate: ReturnType<typeof campaignSendGate>
    {
      const { DIRECT_MAIL_PIECE_COST_USD } = await import("@/lib/vendor-governance/cost-normalizer")
      const unit = route.ok ? (DIRECT_MAIL_PIECE_COST_USD[route.templates.pieceType] ?? null) : null
      let budget: Parameters<typeof campaignSendGate>[0]["budget"] = null
      if (route.ok && typeof unit === "number") {
        try {
          const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
          const v = await mayUseAndAfford({ brokerageId: params.brokerageId, capability: "comms.send", estCostUsd: Math.round(recipients.length * unit * 100) / 100 })
          budget = { allowed: v.allowed, reason: v.reason, remainingBudget: v.remainingBudget, budgetDegraded: v.budgetDegraded, softWarning: v.softWarning }
        } catch (e) {
          budget = { allowed: true, reason: `budget check threw: ${(e as Error)?.message ?? String(e)}`, remainingBudget: null, budgetDegraded: true }
        }
      }
      spendGate = campaignSendGate({ approvalStatus: campaign.approval_status as string | null, status: campaign.status as string | null, pieces: recipients.length, unitCostUsd: unit, budget })
      if (!spendGate.ok && spendGate.code !== "no_price") {
        return { success: false, error: `Not mailed — ${spendGate.reason}`, gate: spendGate.code }
      }
    }
    const svcLedger = createServiceClient()
    const stampProvenance = async (campaignLedgerPatch: Record<string, unknown>) => {
      // m985 columns. A separate write on purpose: before m985 is applied PGRST204 refuses an unknown
      // column ENTIRELY, and the send's own status write above must never be taken down with it.
      const { error: provErr } = await svcLedger.from("direct_mail_campaigns").update(campaignLedgerPatch).eq("id", params.campaignId).eq("brokerage_id", params.brokerageId)
      if (provErr) console.error(`[DirectMail] format/proof provenance NOT recorded on campaign ${params.campaignId}: ${provErr.message}`)
    }
    if (!route.ok) {
      await stampProvenance({ mail_format: route.format, template_provenance: mailTemplateProvenance(route, null) })
      return { success: false, error: `Not mailed — ${route.reason}`, waitingExternal: route.waitingExternal }
    }

    // Brand, office, sending user and QR resolved NOW (proof time), from the one cascade.
    let qrDestinationUrl: string | null = null
    if (campaign.qr_code_id) {
      const { data: code, error: codeErr } = await supabase.from("qr_codes").select("label").eq("id", campaign.qr_code_id).eq("brokerage_id", params.brokerageId).maybeSingle()
      if (codeErr) console.error(`[DirectMail] campaign QR read refused for ${params.campaignId}: ${codeErr.message}`)
      const label = (code as { label?: string } | null)?.label
      if (label) {
        const { mintTrackedQr } = await import("@/lib/marketing/tracked-qr")
        const minted = await mintTrackedQr({ brokerageId: params.brokerageId, agentId: campaign.agent_id ?? null, label, purpose: "campaign" }, svcLedger as never)
        qrDestinationUrl = minted?.scanUrl ?? null
      }
    }
    const brandRead = await readMailBrandFacts({ brokerageId: params.brokerageId, teamId: params.teamId ?? null, agentUserId: params.actorUserId })
    const brand = {
      ...buildMailMergeVariables(brandRead.facts, {
        qrDestinationUrl,
        frontArtUrl: (campaign.design_url as string | null) ?? null,
        bodies: { copy_text: (campaign.copy_text as string | null) ?? "", note_body: (campaign.copy_text as string | null) ?? "" },
      }),
      provenance: brandRead.provenance,
    }
    if (brand.oversize) {
      return { success: false, error: "Not mailed — the merge variables exceed Lob's 25,000-character limit; shorten the copy" }
    }
    const provenance = mailTemplateProvenance(route, brand)
    const isPersonal = route.format === "personal_letter"

    // ── WAVE 151 (lane 151H): THE SENDER'S RETURN ADDRESS, JUDGED ONCE FOR THE WHOLE CAMPAIGN ──
    // The tenant's configured / approved address (readMailBrandFacts → resolveTenantSenderAddress) through the ONE sender gate
    // (lib/providers/mailing-cass-gate.ts decideSenderAddress). Missing / incomplete / unverified / the platform's → REFUSED by
    // name here, before the proof and before the first piece. The dispatcher judges each piece again (defense in depth).
    const { decideSenderAddress } = await import("@/lib/providers/mailing-cass-gate")
    const sender = decideSenderAddress(brandRead.facts.returnAddress ?? null, { platformLobAddressId: process.env.LOB_RETURN_ADDRESS_ID })
    if (!sender.ok) {
      await stampProvenance({ mail_format: route.format, template_provenance: { ...provenance, sender_refusal: sender.reason } })
      return { success: false, error: `Not mailed — sender address refused (${sender.code}): ${sender.reason}${brandRead.provenance.returnAddressRefusal ? ` — ${brandRead.provenance.returnAddressRefusal}` : ""}`, gate: "sender_address" }
    }
    const senderSnapshot = { ...sender.from, source: sender.source, ...sender.evidence }

    // ── PREVIEW: a Lob TEST-key proof, zero spend ─────────────────────────────
    if (params.previewOnly) {
      const first = recipients[0]
      const { createLobProof } = await import("@/lib/providers/lob/client")
      const proof = await createLobProof(process.env.LOB_TEST_API_KEY ?? "", {
        pieceType: route.templates.pieceType,
        to: { name: `${first.first_name} ${first.last_name}`.trim(), address_line1: first.address_line1, ...(first.address_line2 ? { address_line2: first.address_line2 } : {}), address_city: first.city, address_state: first.state, address_zip: first.zip },
        // The TENANT's return address on the proof too — the proof shows what the piece will carry.
        from: sender.from as unknown as Record<string, string>,
        templateId: route.templates.templateId,
        backTemplateId: route.templates.backTemplateId,
        mergeVariables: { ...brand.mergeVars, recipient_name: `${first.first_name} ${first.last_name}`.trim() },
        color: isPersonal ? true : undefined,
      })
      await stampProvenance({
        mail_format: route.format,
        template_provenance: provenance,
        proof_status: proof.ok ? "rendered" : (proof.error?.startsWith("unconfigured") ? "unavailable" : "refused"),
        proof_url: proof.data?.url ?? null,
        proof_rendered_at: proof.ok ? new Date().toISOString() : null,
      })
      // m981 / m980 columns — separate write (PGRST204 before apply must not take the proof stamp down).
      await stampProvenance({ sender_address_snapshot: senderSnapshot, sender_address_id: sender.evidence.addressId, spend_preview: spendGate.ok ? spendGate.spendPreview : null })
      return {
        success: proof.ok,
        preview: {
          format: route.format, label: route.label, proofUrl: proof.data?.url ?? null, thumbnails: proof.data?.thumbnails ?? [], brandMissing: brand.missing, mergeVariables: brand.mergeVars,
          senderAddress: senderSnapshot,
          spend: spendGate.ok ? { estimatedCostUsd: spendGate.estimatedCostUsd, warning: spendGate.warning } : { refused: spendGate.reason },
        },
        error: proof.ok ? undefined : proof.error ?? "Proof not rendered",
      }
    }
    if (!spendGate.ok) return { success: false, error: `Not mailed — ${spendGate.reason}`, gate: spendGate.code }

    // ── Call Lob API via dispatchDirectMail() for each recipient ──
    let firstSuccessfulMessageId: string | undefined
    let successCount = 0
    const failedRecipientIds: string[] = []
    const mailedRecipientIds: string[] = []
    const pieceIds: Array<{ id: string; pieceId: string }> = []
    for (const recipient of recipients) {
      try {
        const lobResult = await dispatchDirectMail({
          brokerageId: params.brokerageId,
          userId: params.actorUserId,
          teamId: params.teamId,
          contactId: recipient.contact_id ?? undefined,
          // m491 — carry the LEAD through to the dispatcher. Without this a
          // lead-anchored recipient was dispatched with neither contactId nor
          // leadId, so dispatchDirectMail's lead consent gate, its mail
          // suppression gate ("stop mailing me") and its over-touch de-confliction
          // all saw an anonymous piece and every one of them passed vacuously.
          leadId: recipient.lead_id ?? undefined,
          systemSource: "direct_mail_campaign",
          recipientName: `${recipient.first_name} ${recipient.last_name}`.trim(),
          mailingAddress: recipient.address_line1,
          mailingAddress2: recipient.address_line2 ?? undefined,
          city: recipient.city,
          state: recipient.state,
          zip: recipient.zip,
          templateId: route.templates.templateId,
          backTemplateId: route.templates.backTemplateId,
          pieceType: route.templates.pieceType,
          color: isPersonal ? true : undefined,
          mergeVars: { ...brand.mergeVars, recipient_name: `${recipient.first_name} ${recipient.last_name}`.trim() },
          // THE TENANT's return address (wave 150, lane 150Z — lane 150QTV Outside-lane 3): the brokerage of record's address
          // from the brand cascade, so a letter's window never shows the platform's; absent → the dispatcher's platform default.
          fromAddress: brandRead.facts.returnAddress ?? null,
          // Human approval is unchanged: this export is session-gated, and the dispatcher's autonomy gate arms
          // only for a manager send. humanApproved is NOT asserted here — the workflow tool (app/actions/
          // workflows.ts "send-direct-mail") reaches this door too, and the ledger must not read HUMAN_REQUESTED
          // for it. The signed-in initiator is stamped on the ledger row (approved_by_user_id, m985).
          // AT-MOST-ONCE PER PIECE: the action ledger's unique idempotency key makes a retried or
          // concurrent Send of this recipient a REPLAY of the first dispatch — never a second Lob charge.
          ledger: { idempotencyKey: mailPieceIdempotencyKey("campaign_recipient", params.campaignId, recipient.id), detail: { mail_format: route.format } },
          metadata: { campaign_id: params.campaignId, recipient_id: recipient.id, mail_format: route.format, template_env_names: provenance.template_env_names },
        })
        if (lobResult.success && lobResult.messageId) {
          if (!firstSuccessfulMessageId) firstSuccessfulMessageId = lobResult.messageId
          successCount++
          mailedRecipientIds.push(recipient.id)
          pieceIds.push({ id: recipient.id, pieceId: lobResult.messageId })
        } else {
          failedRecipientIds.push(recipient.id)
        }
      } catch {
        failedRecipientIds.push(recipient.id)
      }
    }

    if (successCount === 0) {
      return { success: false, error: "Direct mail failed: no pieces dispatched via Lob" }
    }

    const lobOrderId = firstSuccessfulMessageId ?? `lob_${Date.now()}`
    // TOMBSTONE (wave 150, lane 150R): "partial" is not in the LIVE direct_mail_campaigns_status_check
    // (planning | approved | printed | mailed | cancelled | failed — read 2026-11-06), so a partly-failed
    // send's status write was REFUSED after Lob had charged, the throw below skipped marking the mailed
    // recipients, and they stayed `pending` for the next Send to mail AGAIN. One vocabulary (§6): the
    // campaign is "mailed"; which pieces failed is on each recipient row (delivery_status 'failed').
    const campaignStatus = "mailed"

    // Update campaign FIRST — recipients are only marked after this succeeds to keep state consistent
    const { error: updateError } = await supabase
      .from("direct_mail_campaigns")
      .update({
        status: campaignStatus,
        mailing_date: new Date().toISOString().slice(0, 10),
        lob_order_id: lobOrderId,
        pieces_mailed: successCount,
      })
      .eq("id", params.campaignId)
      .eq("brokerage_id", params.brokerageId)

    if (updateError) throw updateError

    // Mark successfully dispatched recipients as mailed
    if (mailedRecipientIds.length > 0) {
      const mailedAt = new Date().toISOString()
      const { error: mailedUpdateError } = await supabase
        .from("direct_mail_recipients")
        .update({ delivery_status: "mailed", mailed_at: mailedAt })
        .in("id", mailedRecipientIds)
      if (mailedUpdateError) throw mailedUpdateError
    }

    // m985 — the provider piece id per recipient (what trackDelivery settles each Lob event onto; the
    // campaign's lob_order_id names only the FIRST piece) and the format/template/brand provenance.
    for (const p of pieceIds) {
      const { error: pieceErr } = await svcLedger.from("direct_mail_recipients")
        .update({ provider_piece_id: p.pieceId, delivery_outcome: "accepted", idempotency_key: mailPieceIdempotencyKey("campaign_recipient", params.campaignId, p.id) })
        .eq("id", p.id).eq("brokerage_id", params.brokerageId)
      if (pieceErr) console.error(`[DirectMail] provider piece id NOT recorded for recipient ${p.id}: ${pieceErr.message}`)
    }
    await stampProvenance({ mail_format: route.format, template_provenance: provenance, approved_by_user_id: params.actorUserId, approved_at: new Date().toISOString() })
    // Wave 151 (151H): what the pieces carried as the sender (evidence), and the spend preview that cleared them (m980 / m981 — separate write).
    await stampProvenance({ sender_address_snapshot: senderSnapshot, sender_address_id: sender.evidence.addressId, spend_preview: { ...spendGate.spendPreview, pieces_dispatched: successCount, pieces_failed: failedRecipientIds.length } })

    // Mark failed recipients so they aren't silently re-queried as pending
    if (failedRecipientIds.length > 0) {
      console.warn(`[DirectMail] Partial success: ${successCount}/${recipients.length} dispatched for campaign ${params.campaignId}`)
      const { error: failedUpdateError } = await supabase
        .from("direct_mail_recipients")
        .update({ delivery_status: "failed" })
        .in("id", failedRecipientIds)
      if (failedUpdateError) {
        console.error(`[DirectMail] Could not mark failed recipients for campaign ${params.campaignId}:`, failedUpdateError.message)
      }
    }

    // ── Fire kernel event ──
    await processKernelEvent({
      event: KernelEvent.DIRECT_MAIL_SENT,
      brokerageId: params.brokerageId,
      entityType: "direct_mail_campaign",
      entityId: params.campaignId,
    }).catch((err) => {
      console.error("[DirectMail] Event processing failed (non-blocking):", err)
    })

    revalidatePath("/dashboard/campaigns/mail")

    return {
      success: true,
      lobOrderId,
      piecesMailed: successCount,
      failedCount: failedRecipientIds.length,
      status: campaignStatus,
      provider: provider.providerKey,
    }
  } catch (error) {
    console.error("[DirectMail] Send campaign error:", error)
    return handleError(error, "sendCampaign")
  }
}

// ─── QR SCAN ANALYTICS ────────────────────────────────────────────────────────

export interface QrScanEvent {
  id: string
  qr_code_id: string
  campaign_id: string | null
  is_first_scan: boolean
  scanned_at: string
}

/**
 * Returns all QR scan events for a direct mail campaign,
 * aggregated for the Tracking tab analytics section.
 */
export async function getCampaignQrScans(campaignId: string): Promise<{
  success: boolean
  scans?: QrScanEvent[]
  totalScans?: number
  firstScans?: number
  repeatScans?: number
  byDay?: { date: string; count: number }[]
  error?: string
}> {
  try {
    if (!isValidUUID(campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("qr_scan_events")
      .select("id, qr_code_id, campaign_id, is_first_scan, scanned_at")
      .eq("campaign_id", campaignId)
      .order("scanned_at", { ascending: true })

    if (error) throw error

    const scans = (data ?? []) as QrScanEvent[]
    const totalScans = scans.length
    const firstScans = scans.filter((s) => s.is_first_scan).length
    const repeatScans = totalScans - firstScans

    // Aggregate by day (YYYY-MM-DD)
    const dayMap: Record<string, number> = {}
    for (const scan of scans) {
      const day = scan.scanned_at.slice(0, 10)
      dayMap[day] = (dayMap[day] || 0) + 1
    }
    const byDay = Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }))

    return { success: true, scans, totalScans, firstScans, repeatScans, byDay }
  } catch (error) {
    return handleError(error, "getCampaignQrScans")
  }
}

// Imported at the foot (lane 93A) so the file:line references other files hold into this one stay true (ES imports hoist).
import { decideClaimedTenant } from "@/lib/platform/acting-context"
