// lib/ai-isa/lead-nurture.ts
//
// THE AI ISA HOT-SELLER-LEAD NURTURE — channel-appropriate, VERIFICATION-GATED
// outreach for a LEAD (no portal, NOT a contact). The Listing Inventory Radar
// promotes a hot seller candidate raw_scraped_leads → THE GATE → leads
// (ai_isa_owner=true) and routes data_steward → ai_isa. The ISA handler
// `ai_isa:seller_intent_hot` PRIORITIZES the lead; this module adds the
// conversion-push outreach ON TOP of that prioritization:
//
//   · when leads.email_verified  → a Director "thinking of selling?" reel is
//     commissioned (commissionVideo, gated pending_review) and its EMAIL
//     delivery to the lead's verified email is PROPOSED (agent_client_messages
//     status='proposed', audience 'lead', channel 'email' — human-approved).
//   · when leads.mailing_address_verified → a POSTCARD to the verified mailing
//     address is PROPOSED (direct_mail_campaigns approval_status='pending',
//     status='planning', carrying a tracked QR → conversion landing) — NEVER
//     dispatched. A human approves before any Lob send.
//
// Each channel is INDEPENDENT + IDEMPOTENT per (lead, channel). A missing/false
// verification flag → that channel is honestly SKIPPED. NOTHING auto-sends; the
// proposal IS the gate. The lead is not a contact, so there is NEVER a portal card.
//
// NOT server-only: chooseLeadNurtureChannels is PURE (no I/O) so the simulator
// drives it directly. proposeLeadNurture uses the caller-supplied service client.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ============================================================================
// PURE — channel selection from the lead's verification flags
// ============================================================================

/** The verification-flag + recipient shape the channel selector reasons over —
 *  exactly the columns the radar carries onto a promoted lead. */
export interface LeadNurtureInput {
  email?: string | null
  email_verified?: boolean | null
  /** CAN-SPAM: a verified email is still skipped if the lead opted out. */
  email_opt_out?: boolean | null
  mailing_address?: string | null
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
  mailing_address_verified?: boolean | null
}

export interface LeadNurtureChannels {
  /** Email the Director reel only when the email is VERIFIED, present, and not opted out. */
  email: boolean
  /** Mail the postcard only when the mailing address is VERIFIED and complete (Lob-deliverable). */
  postcard: boolean
}

/**
 * chooseLeadNurtureChannels — PURE. No I/O, no DB.
 *
 * Reads ONLY the lead's verification flags + the channel's own address columns
 * and decides which channels are eligible:
 *
 *   email    ← email_verified === true  AND a non-empty email  AND email_opt_out !== true
 *   postcard ← mailing_address_verified === true  AND a complete mailing address
 *              (street + city + state + zip — Lob requires all four)
 *
 * A false/missing flag → that channel is false (skipped honestly). Both flags
 * true → both channels. Neither → none. This is the verification gate, expressed
 * as data: the handler only ACTS on a channel this returns true for.
 */
export function chooseLeadNurtureChannels(lead: LeadNurtureInput): LeadNurtureChannels {
  const emailOk =
    lead.email_verified === true &&
    typeof lead.email === "string" &&
    lead.email.trim().length > 0 &&
    lead.email_opt_out !== true

  const postcardOk =
    lead.mailing_address_verified === true &&
    !!(lead.mailing_address && lead.mailing_address.trim()) &&
    !!(lead.mailing_city && lead.mailing_city.trim()) &&
    !!(lead.mailing_state && lead.mailing_state.trim()) &&
    !!(lead.mailing_zip && lead.mailing_zip.trim())

  return { email: !!emailOk, postcard: !!postcardOk }
}

// ============================================================================
// LIVE — propose the gated, verification-conditioned outreach
// ============================================================================

export interface ProposeLeadNurtureArgs {
  brokerageId: string
  leadId: string
  /** users.id of the agent who owns the render + QR (ai_video_projects.agent_id
   *  FK → users.id; qr_codes.agent_id). Resolved from the brokerage by the caller. */
  agentUserId: string
  intentScore?: number
  propertyAddress?: string | null
}

export interface LeadNurtureResult {
  /** The channels chosen from the verification flags (the gate, as data). */
  channels: LeadNurtureChannels
  /** A staged + EMAIL-delivery-PROPOSED Director reel (gated), when email-eligible. */
  emailVideo: { staged: boolean; videoProjectId?: string; messageId?: string; status?: string; reason?: string } | null
  /** A PROPOSED (gated) postcard campaign row, when mailing-eligible. */
  postcard: { proposed: boolean; campaignId?: string; qrCodeId?: string | null; reason?: string } | null
  /** Human-readable lines describing what was proposed (for the consumed_action). */
  actions: string[]
}

const LEAD_NURTURE_EMAIL_ENTITY_TYPE = "lead_nurture_video"

/**
 * proposeLeadNurture — the live, GATED, verification-conditioned outreach.
 *
 * Re-reads the lead (defensive — never act on a converted/contact-backed lead or
 * one that has changed), derives the eligible channels with the PURE selector,
 * then for each TRUE channel proposes its deliverable:
 *
 *   email    → commissionVideo stages a Director "thinking of selling?" reel
 *              (gated pending_review, lead carried in video_metadata since
 *              ai_video_projects has no lead_id), then proposeClientMessage
 *              proposes its EMAIL delivery to the verified email (status
 *              'proposed', audience 'lead', channel 'email'). Idempotent per
 *              (lead) on both the reel (commissionVideo director_key) and the
 *              email proposal (one open proposal per lead).
 *   postcard → a direct_mail_campaigns row at approval_status='pending',
 *              status='planning' carrying a tracked QR (mintVideoQr → landing_page
 *              conversion landing). NEVER dispatched. Idempotent per (lead): one
 *              open proposed campaign per lead.
 *
 * NOTHING auto-sends. A missing/false flag → that channel is skipped honestly.
 * Returns the channels + per-channel outcomes + action lines.
 */
export async function proposeLeadNurture(
  args: ProposeLeadNurtureArgs,
  client?: Svc,
): Promise<LeadNurtureResult> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase: Svc = client ?? createServiceClient()

  const result: LeadNurtureResult = {
    channels: { email: false, postcard: false },
    emailVideo: null,
    postcard: null,
    actions: [],
  }

  // Defensive re-read — only the verification columns + the guard columns. We
  // never act on a lead that doesn't exist, isn't ISA-owned, or has converted
  // to a contact (that's the listing_concierge path, not lead nurture).
  const { data: lead } = await supabase
    .from("leads")
    .select(
      "id, ai_isa_owner, contact_id, first_name, last_name, " +
        "email, email_verified, email_opt_out, " +
        "mailing_address, mailing_city, mailing_state, mailing_zip, mailing_address_verified",
    )
    .eq("id", args.leadId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()

  const l = lead as
    | (LeadNurtureInput & {
        id: string
        ai_isa_owner?: boolean | null
        contact_id?: string | null
        first_name?: string | null
        last_name?: string | null
      })
    | null

  // Not ISA-owned, missing, or already a contact → not this module's job.
  if (!l || l.ai_isa_owner !== true || l.contact_id) return result

  const channels = chooseLeadNurtureChannels(l)
  result.channels = channels

  // ── EMAIL channel — Director reel + gated EMAIL delivery proposal ──────────
  if (channels.email) {
    result.emailVideo = await proposeEmailVideo(supabase, args, l.email!.trim())
    if (result.emailVideo.staged && result.emailVideo.messageId) {
      result.actions.push(
        `email-verified → commissioned a gated 'thinking of selling?' reel (${result.emailVideo.status}) + proposed its EMAIL delivery to the lead (gate message ${result.emailVideo.messageId})`,
      )
    } else if (result.emailVideo.reason) {
      result.actions.push(`email channel skipped: ${result.emailVideo.reason}`)
    }
  }

  // ── POSTCARD channel — gated direct-mail proposal carrying its QR ──────────
  if (channels.postcard) {
    result.postcard = await proposePostcard(supabase, args, l)
    if (result.postcard.proposed && result.postcard.campaignId) {
      result.actions.push(
        `mailing-verified → proposed a gated POSTCARD to the verified mailing address (campaign ${result.postcard.campaignId}${result.postcard.qrCodeId ? `, QR ${result.postcard.qrCodeId}` : ""})`,
      )
    } else if (result.postcard.reason) {
      result.actions.push(`postcard channel skipped: ${result.postcard.reason}`)
    }
  }

  return result
}

/**
 * Commission the Director reel + PROPOSE its email delivery to the verified-email
 * lead. The reel is gated (commissionVideo → approval_status='pending_review');
 * the lead is carried in video_metadata (ai_video_projects has no lead_id). The
 * delivery is proposed (agent_client_messages status='proposed', audience 'lead',
 * channel 'email') — never auto-sent. Idempotent per lead on both.
 */
async function proposeEmailVideo(
  supabase: Svc,
  args: ProposeLeadNurtureArgs,
  verifiedEmail: string,
): Promise<NonNullable<LeadNurtureResult["emailVideo"]>> {
  let videoProjectId: string | undefined
  let videoStatus: string | undefined
  try {
    const { commissionVideo } = await import("@/lib/video/video-director")
    // A seller-curious LEAD wants an explainer/market reel (avatar-led, email
    // channel). Facts come ONLY from the lead — no fabrication. The contactId is
    // intentionally OMITTED (this is a lead, not a contact); the lead is keyed
    // into video_metadata via a campaignId-free director entity (the brokerage
    // entity) — see note below — so we pass the leadId as the campaignId so the
    // director_key is idempotent per (lead) without minting a contact QR.
    const reel = await commissionVideo(
      {
        kind: "explainer",
        tier: "solo_agent",
        targetChannel: "email",
        facts: { topic: "thinking of selling?", property_address: args.propertyAddress ?? undefined },
      },
      {
        brokerageId: args.brokerageId,
        agentUserId: args.agentUserId,
        // No contactId — a lead is not a contact. campaignId carries the leadId so
        // the director_key (director:explainer:<lead>) is idempotent per lead.
        campaignId: args.leadId,
        title: `Thinking of selling? — ${args.propertyAddress ?? "your home"}`,
      },
      supabase as any,
    )
    if (!reel.ok || (reel.status !== "staged" && reel.status !== "already_staged")) {
      return { staged: false, reason: `reel not staged (${reel.status}${reel.reason ? `: ${reel.reason}` : ""})` }
    }
    videoProjectId = reel.videoProjectId
    videoStatus = reel.status

    // Stamp the lead association onto the reel's video_metadata (no lead_id column)
    // so the delivery side + analytics can resolve the lead from the project. Best-
    // effort, idempotent (merges into existing metadata).
    if (videoProjectId) {
      const { data: vp } = await supabase
        .from("ai_video_projects")
        .select("video_metadata")
        .eq("id", videoProjectId)
        .maybeSingle()
      const md = ((vp as { video_metadata?: Record<string, unknown> } | null)?.video_metadata ?? {}) as Record<string, unknown>
      if (md.lead_id !== args.leadId || md.delivery_channel !== "email") {
        await supabase
          .from("ai_video_projects")
          .update({
            video_metadata: { ...md, lead_id: args.leadId, delivery_channel: "email", requested_via: "ai_isa_lead_nurture" },
            updated_at: new Date().toISOString(),
          })
          .eq("id", videoProjectId)
      }
    }
  } catch (e) {
    return { staged: false, reason: `reel commission failed: ${(e as Error).message}` }
  }

  // Propose the EMAIL delivery to the lead's VERIFIED email — gated, never auto-sent.
  // Idempotent per lead: skip if an open proposal already carries this lead's reel.
  const { data: existing } = await supabase
    .from("agent_client_messages")
    .select("id, status")
    .eq("brokerage_id", args.brokerageId)
    .eq("entity_type", LEAD_NURTURE_EMAIL_ENTITY_TYPE)
    .eq("entity_id", args.leadId)
    .in("status", ["proposed", "approved", "sent"])
    .maybeSingle()
  if (existing?.id) {
    return {
      staged: true,
      videoProjectId,
      messageId: (existing as { id: string }).id,
      status: videoStatus ?? "already_staged",
      reason: "email delivery already proposed (deduped)",
    }
  }

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage(
    {
      brokerageId: args.brokerageId,
      agentKind: "ai_isa",
      entityType: LEAD_NURTURE_EMAIL_ENTITY_TYPE,
      entityId: args.leadId,
      // A LEAD has no portal contact — recipientContactId stays null; the verified
      // email rides the rationale + the lead entity. audience 'lead', channel 'email'.
      recipientContactId: null,
      audience: "lead",
      channel: "email",
      subject: `A quick look${args.propertyAddress ? ` at ${args.propertyAddress}` : ""} — thinking of selling?`,
      body:
        `We put together a short video for you${args.propertyAddress ? ` about ${args.propertyAddress}` : ""}. ` +
        `If you've been wondering what selling could look like right now, this two-minute walk-through breaks it down — no pressure. ` +
        `Tap to watch, and scan or click through whenever you're ready for a real number.`,
      rationale:
        `AI ISA hot-seller-LEAD nurture — email VERIFIED (${verifiedEmail}). Director 'thinking of selling?' reel` +
        `${videoProjectId ? ` (ai_video_projects ${videoProjectId})` : ""} proposed for EMAIL delivery to the lead` +
        ` (conversion CTA = watch + scan/click → becomes a contact). Gated, ISA-owned, consent respected — never auto-sent.` +
        `${typeof args.intentScore === "number" ? ` Seller-intent ${(args.intentScore * 100).toFixed(0)}/100.` : ""}`,
    },
    supabase as any,
  )
  if (!res.ok) {
    return { staged: true, videoProjectId, status: videoStatus, reason: `email delivery proposal failed: ${res.error ?? "unknown"}` }
  }
  return { staged: true, videoProjectId, messageId: res.id, status: videoStatus }
}

/**
 * PROPOSE a gated postcard to the lead's VERIFIED mailing address. Inserts a
 * direct_mail_campaigns row at approval_status='pending', status='planning'
 * carrying a tracked QR (mintVideoQr → landing_page conversion landing keyed on
 * the lead). NEVER calls dispatchDirectMail — a human approves before any Lob send.
 * Idempotent per (lead): one open proposed campaign per lead.
 */
async function proposePostcard(
  supabase: Svc,
  args: ProposeLeadNurtureArgs,
  lead: { first_name?: string | null; last_name?: string | null },
): Promise<NonNullable<LeadNurtureResult["postcard"]>> {
  // Idempotency — skip if a still-gated (pending/planning) proposed postcard for
  // this lead already exists.
  const { data: existing } = await supabase
    .from("direct_mail_campaigns")
    .select("id, qr_code_id")
    .eq("brokerage_id", args.brokerageId)
    .eq("lead_id", args.leadId)
    .eq("target_audience", "ai_isa_seller_nurture")
    .eq("approval_status", "pending")
    .maybeSingle()
  if (existing?.id) {
    return {
      proposed: true,
      campaignId: (existing as { id: string }).id,
      qrCodeId: (existing as { qr_code_id?: string | null }).qr_code_id ?? null,
      reason: "postcard already proposed (deduped)",
    }
  }

  // Mint the tracked QR → the conversion landing (the lead scans → landing →
  // captured as the conversion). Best-effort: a null QR still proposes the postcard.
  let qrCodeId: string | null = null
  try {
    const { mintVideoQr } = await import("@/lib/video/video-qr")
    const minted = await mintVideoQr(
      {
        brokerageId: args.brokerageId,
        agentUserId: args.agentUserId,
        kind: "newsletter", // → destination_type 'landing_page' (the seller conversion landing)
        campaignId: args.leadId, // drives /n/<lead> landing + idempotency entity
      },
      supabase,
    )
    qrCodeId = minted?.qrCodeId ?? null
  } catch {
    /* a postcard proposal must still land without a QR */
  }

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "Homeowner"
  // direct_mail_campaigns.agent_id is agents-class — the USERS id was FK-rejected,
  // so the postcard proposal was assembled (QR and all) and never recorded.
  const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
  const mailAgentId = await resolveUserIdToAgentRecord(args.agentUserId, args.brokerageId)
  const { data: campaign, error } = await supabase
    .from("direct_mail_campaigns")
    .insert({
      brokerage_id: args.brokerageId,
      agent_id: mailAgentId,
      lead_id: args.leadId,
      campaign_name: `AI ISA seller nurture — ${name}`.slice(0, 120),
      target_audience: "ai_isa_seller_nurture",
      quantity: 1,
      piece_type: "postcard",
      copy_text:
        `Thinking about what your home could sell for${args.propertyAddress ? ` at ${args.propertyAddress}` : ""}? ` +
        `Scan the code for a no-pressure look at today's number.`,
      qr_code_id: qrCodeId,
      is_ai_generated: true,
      approval_status: "pending", // GATED — a human approves before any Lob send
      status: "planning",         // not approved/printed/mailed — nothing dispatched
      created_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error || !campaign) {
    return { proposed: false, qrCodeId, reason: error?.message ?? "campaign insert failed" }
  }
  return { proposed: true, campaignId: (campaign as { id: string }).id, qrCodeId }
}
