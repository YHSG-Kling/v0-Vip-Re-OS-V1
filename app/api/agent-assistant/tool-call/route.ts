/**
 * POST /api/agent-assistant/tool-call
 *
 * Webhook endpoint that ElevenLabs Conv AI calls when the assistant invokes
 * a tool. Each tool maps to a kernel-OS-validated CRM operation.
 *
 * Auth: ElevenLabs sends `x-elevenlabs-tool-secret` header (configured per
 *   tool when we provision the agent in lib/elevenlabs/conv-ai.ts).
 *   We validate it against AGENT_ASSISTANT_TOOL_SECRET on our side. Constant-
 *   time compare to avoid timing leaks.
 *
 * Attribution: ElevenLabs forwards the conversation_id with every call. We
 *   look it up against agent_assistant_sessions to find the user, brokerage,
 *   and agent. If it's the first call for this conversation, we stamp the
 *   conversation_id onto the session row that was created at /session time
 *   (matched by the user's most-recent open session).
 *
 * Audit: every call (success or failure) is logged to
 *   agent_assistant_tool_calls so brokers can audit "what did the AI do?".
 *
 * Tools (v1):
 *   - lookup_contact(query)
 *   - get_today_schedule()
 *   - get_contact_details(contact_id)
 *   - log_activity(contact_id, activity_type, notes)
 *   - create_task(title, due_date?, contact_id?)
 *   - send_portal_message(contact_id, body) — kernel-validated
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"

interface ToolCallBody {
  conversation_id?: string
  tool_name?: string
  parameters?: Record<string, unknown>
  // ElevenLabs sometimes wraps the tool name in different fields depending
  // on the exact tool config — accept variants.
  tool?: string
  args?: Record<string, unknown>
}

type SessionRow = {
  id: string
  brokerage_id: string
  agent_id: string | null
  user_id: string
  conversation_id: string | null
  tool_call_count: number | null
}

export async function POST(request: NextRequest) {
  const start = Date.now()

  // ── Auth ───────────────────────────────────────────────────────────────
  const expected = process.env.AGENT_ASSISTANT_TOOL_SECRET ?? ""
  const provided = request.headers.get("x-elevenlabs-tool-secret") ?? ""
  if (!expected || !secretMatches(expected, provided)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // ── Parse body ─────────────────────────────────────────────────────────
  const body = (await request.json().catch(() => null)) as ToolCallBody | null
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }
  const toolName = body.tool_name ?? body.tool
  const params = body.parameters ?? body.args ?? {}
  const conversationId = body.conversation_id ?? null

  if (!toolName) {
    return NextResponse.json({ error: "tool_name required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── Resolve session ────────────────────────────────────────────────────
  // The /session route created a row but didn't yet know the conversation_id.
  // First tool call: match by (user pending session) → stamp conv_id.
  // Subsequent calls: match by conversation_id directly.
  let session: SessionRow | null = null
  if (conversationId) {
    const { data } = await supabase
      .from("agent_assistant_sessions")
      .select("id, brokerage_id, agent_id, user_id, conversation_id, tool_call_count")
      .eq("conversation_id", conversationId)
      .is("ended_at", null)
      .maybeSingle()
    session = (data as SessionRow | null) ?? null
  }

  if (!session && conversationId) {
    // First call: pick the most-recent unattributed open session whose user
    // is the most likely owner. ElevenLabs doesn't pass our session id, so we
    // attribute by recency (sessions are created seconds before the first
    // tool call). This is best-effort — a defensive secondary match would
    // tie the conversation to the user via cookie/jwt if we had one, but the
    // webhook is unauthenticated by design.
    const { data: pending } = await supabase
      .from("agent_assistant_sessions")
      .select("id, brokerage_id, agent_id, user_id, conversation_id, tool_call_count")
      .is("conversation_id", null)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pending) {
      await supabase
        .from("agent_assistant_sessions")
        .update({ conversation_id: conversationId })
        .eq("id", pending.id)
      session = pending as SessionRow
    }
  }

  if (!session) {
    return jsonToolError("Session not found — try ending and re-opening the assistant.")
  }

  // ── Dispatch ───────────────────────────────────────────────────────────
  let result: any
  let success = true
  let errorMessage: string | null = null
  try {
    result = await runTool(toolName, params, session, supabase)
  } catch (e: any) {
    success = false
    errorMessage = e?.message ?? "Tool failed"
    result = { error: errorMessage }
  }

  const latencyMs = Date.now() - start

  // ── Audit log + counter ────────────────────────────────────────────────
  await Promise.all([
    supabase.from("agent_assistant_tool_calls").insert({
      session_id: session.id,
      tool_name: toolName,
      tool_input: params,
      tool_output: typeof result === "object" ? result : { value: result },
      success,
      error_message: errorMessage,
      latency_ms: latencyMs,
    }),
    supabase
      .from("agent_assistant_sessions")
      .update({ tool_call_count: (session.tool_call_count ?? 0) + 1 })
      .eq("id", session.id),
  ])

  // ElevenLabs accepts string or object as the tool response; we return the
  // tool's structured result so the LLM can quote details verbatim.
  return NextResponse.json({ result })
}

// ─── Tool implementations ────────────────────────────────────────────────────

async function runTool(
  toolName: string,
  params: Record<string, unknown>,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<any> {
  switch (toolName) {
    case "lookup_contact":
      return lookupContact(String(params.query ?? "").trim(), session, supabase)

    case "get_today_schedule":
      return getTodaySchedule(session, supabase)

    case "get_contact_details":
      return getContactDetails(String(params.contact_id ?? ""), session, supabase)

    case "log_activity":
      return logActivity(
        String(params.contact_id ?? ""),
        String(params.activity_type ?? "note"),
        String(params.notes ?? ""),
        session,
        supabase,
      )

    case "create_task":
      return createTask(
        String(params.title ?? ""),
        params.due_date ? String(params.due_date) : null,
        params.contact_id ? String(params.contact_id) : null,
        session,
        supabase,
      )

    case "send_portal_message":
      return sendPortalMessage(
        String(params.contact_id ?? ""),
        String(params.body ?? ""),
        session,
        supabase,
      )

    case "get_active_listings":
      return getActiveListings(session, supabase)

    case "get_pending_offers":
      return getPendingOffers(session, supabase)

    case "get_transactions_in_progress":
      return getTransactionsInProgress(session, supabase)

    case "get_recent_messages":
      return getRecentMessages(
        params.contact_id ? String(params.contact_id) : null,
        session,
        supabase,
      )

    case "update_contact_status":
      return updateContactStatus(
        String(params.contact_id ?? ""),
        String(params.status ?? ""),
        session,
        supabase,
      )

    case "stage_listing_packet":
      return stageListingPacket(params, session)

    case "stage_offer_packet":
      return stageOfferPacket(params, session, supabase)

    case "stage_bba_packet":
      return stageBBAPacket(params, session, supabase)

    case "read_form_status":
      return readFormStatus(params, session, supabase)

    case "dispatch_transaction_packet":
      return dispatchTransactionPacket(params, session, supabase)

    case "stage_newsletter_draft":
      return stageNewsletterDraftVoice(params, session)

    case "stage_email_campaign":
      return stageEmailCampaignVoice(params, session)

    case "stage_open_house":
      return stageOpenHouseVoice(params, session)

    case "stage_blog_draft":
      return stageBlogDraftVoice(params, session)

    case "stage_podcast_episode":
      return stagePodcastEpisodeVoice(params, session)

    case "stage_video_project":
      return stageVideoProjectVoice(params, session)

    case "stage_direct_mail_campaign":
      return stageDirectMailCampaignVoice(params, session)

    case "stage_ad_campaign":
      return stageAdCampaignVoice(params, session)

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

// ─── stage_* voice handlers — thin wrappers that delegate to content-staging ─

async function stageNewsletterDraftVoice(params: Record<string, unknown>, session: SessionRow) {
  const title = String(params.title ?? "").trim()
  if (!title) return { error: "title required" }
  const { stageNewsletterDraft } = await import("@/lib/wizard-staging/content-staging")
  return stageNewsletterDraft(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      title,
      subjectLine: params.subject_line ? String(params.subject_line) : undefined,
      topic: params.topic ? String(params.topic) : undefined,
    },
  )
}

async function stageEmailCampaignVoice(params: Record<string, unknown>, session: SessionRow) {
  const campaignName = String(params.campaign_name ?? "").trim()
  if (!campaignName) return { error: "campaign_name required" }
  const { stageEmailCampaign } = await import("@/lib/wizard-staging/content-staging")
  return stageEmailCampaign(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      campaignName,
      subjectLine: params.subject_line ? String(params.subject_line) : undefined,
      content: params.content ? String(params.content) : undefined,
      sendDate: params.send_date ? String(params.send_date) : undefined,
    },
  )
}

async function stageOpenHouseVoice(params: Record<string, unknown>, session: SessionRow) {
  const listingId = String(params.listing_id ?? "").trim()
  if (!listingId) return { error: "listing_id required" }
  const date = String(params.date ?? "").trim()
  const startTime = String(params.start_time ?? "").trim()
  const endTime = String(params.end_time ?? "").trim()
  if (!date || !startTime || !endTime) {
    return { error: "date + start_time + end_time required" }
  }
  const { stageOpenHouse } = await import("@/lib/wizard-staging/content-staging")
  return stageOpenHouse(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      listingId,
      date,
      startTime,
      endTime,
      maxAttendees: params.max_attendees != null ? Number(params.max_attendees) : undefined,
      notes: params.notes ? String(params.notes) : undefined,
      publicDescription: params.public_description ? String(params.public_description) : undefined,
    },
  )
}

async function stageBlogDraftVoice(params: Record<string, unknown>, session: SessionRow) {
  const title = String(params.title ?? "").trim()
  if (!title) return { error: "title required" }
  const { stageBlogDraft } = await import("@/lib/wizard-staging/content-staging")
  return stageBlogDraft(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      title,
      topic: params.topic ? String(params.topic) : undefined,
      category: params.category ? String(params.category) : undefined,
    },
  )
}

async function stagePodcastEpisodeVoice(params: Record<string, unknown>, session: SessionRow) {
  const title = String(params.title ?? "").trim()
  if (!title) return { error: "title required" }
  const { stagePodcastEpisode } = await import("@/lib/wizard-staging/content-staging")
  const rawKw = params.keywords
  const keywords = Array.isArray(rawKw)
    ? rawKw.map((k) => String(k))
    : rawKw
      ? String(rawKw).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined
  return stagePodcastEpisode(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      title,
      description: params.description ? String(params.description) : undefined,
      script: params.script ? String(params.script) : undefined,
      category: params.category ? String(params.category) : undefined,
      keywords,
    },
  )
}

async function stageVideoProjectVoice(params: Record<string, unknown>, session: SessionRow) {
  const title = String(params.title ?? "").trim()
  if (!title) return { error: "title required" }
  const rawFormat = params.format ? String(params.format) : undefined
  const format: "vertical" | "horizontal" | "square" | undefined =
    rawFormat === "vertical" || rawFormat === "horizontal" || rawFormat === "square"
      ? rawFormat
      : undefined
  const { stageVideoProject } = await import("@/lib/wizard-staging/content-staging")
  return stageVideoProject(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      title,
      script: params.script ? String(params.script) : undefined,
      videoType: params.video_type ? String(params.video_type) : undefined,
      format,
      durationSeconds: params.duration_seconds != null ? Number(params.duration_seconds) : undefined,
      listingId: params.listing_id ? String(params.listing_id) : undefined,
    },
  )
}

async function stageAdCampaignVoice(params: Record<string, unknown>, session: SessionRow) {
  const campaignName = String(params.campaign_name ?? "").trim()
  if (!campaignName) return { error: "campaign_name required" }
  const platform = String(params.platform ?? "").trim() as
    | "facebook" | "instagram" | "google" | "linkedin" | "tiktok"
  const objective = String(params.objective ?? "").trim() as
    | "awareness" | "traffic" | "leads" | "conversions"
  const allowedPlatforms = new Set(["facebook", "instagram", "google", "linkedin", "tiktok"])
  const allowedObjectives = new Set(["awareness", "traffic", "leads", "conversions"])
  if (!allowedPlatforms.has(platform)) return { error: "platform must be facebook/instagram/google/linkedin/tiktok" }
  if (!allowedObjectives.has(objective)) return { error: "objective must be awareness/traffic/leads/conversions" }

  const { stageAdCampaign } = await import("@/lib/wizard-staging/content-staging")
  return stageAdCampaign(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      campaignName,
      platform,
      objective,
      dailyBudget: params.daily_budget != null ? Number(params.daily_budget) : undefined,
      lifetimeBudget: params.lifetime_budget != null ? Number(params.lifetime_budget) : undefined,
      startDate: params.start_date ? String(params.start_date) : undefined,
      endDate: params.end_date ? String(params.end_date) : undefined,
      city: params.city ? String(params.city) : undefined,
      state: params.state ? String(params.state) : undefined,
      ageMin: params.age_min != null ? Number(params.age_min) : undefined,
      ageMax: params.age_max != null ? Number(params.age_max) : undefined,
    },
  )
}

async function stageDirectMailCampaignVoice(params: Record<string, unknown>, session: SessionRow) {
  const campaignName = String(params.campaign_name ?? "").trim()
  const targetAudience = String(params.target_audience ?? "").trim()
  if (!campaignName) return { error: "campaign_name required" }
  if (!targetAudience) return { error: "target_audience required" }
  const rawPieceType = params.piece_type ? String(params.piece_type) : undefined
  const allowedPieceTypes = new Set([
    "postcard_4x6",
    "postcard_6x9",
    "postcard_6x11",
    "letter",
    "handwritten",
    "thank_you_note",
  ])
  const pieceType =
    rawPieceType && allowedPieceTypes.has(rawPieceType)
      ? (rawPieceType as "postcard_4x6" | "postcard_6x9" | "postcard_6x11" | "letter" | "handwritten" | "thank_you_note")
      : undefined
  const { stageDirectMailCampaign } = await import("@/lib/wizard-staging/content-staging")
  return stageDirectMailCampaign(
    { brokerageId: session.brokerage_id, userId: session.user_id },
    {
      campaignName,
      targetAudience,
      pieceType,
      budget: params.budget != null ? Number(params.budget) : undefined,
      sendDate: params.send_date ? String(params.send_date) : undefined,
      copyText: params.copy_text ? String(params.copy_text) : undefined,
    },
  )
}

// ─── stage_listing_packet (voice) ────────────────────────────────────────────
// Routes the agent's free-text input through the CANONICAL workflow:
//   extractListingIntake → fillListingPacket → documents insert
// Same chain as voiceDraftListing minus the auth-cookie createClient (we use
// the service client here because the webhook is unauthenticated by design).

async function stageListingPacket(
  params: Record<string, unknown>,
  session: SessionRow,
) {
  const voiceInput = String(params.voice_input ?? params.address ?? "").trim()
  if (!voiceInput) return { error: "voice_input required" }

  try {
    const { extractListingIntake } = await import("@/lib/workflow/intake/voice-to-listing")
    const { fillListingPacket } = await import("@/lib/workflow/intake/form-fill-engine")
    const supabase = createServiceClient()

    const extracted = await extractListingIntake({ text: voiceInput })
    const state = extracted.intake.propertyState.value

    if (!state) {
      return {
        error: "Need state for listing forms. Ask the agent which state the property is in.",
        intake_so_far: extracted.intake,
      }
    }

    const filledPacket = await fillListingPacket({
      intake: extracted.intake,
      brokerageId: session.brokerage_id,
    })

    const { data: doc, error } = await supabase
      .from("documents")
      .insert({
        brokerage_id: session.brokerage_id,
        document_type: "listing_agreement",
        status: "needs_agent_input",
        state_code: state,
        metadata: {
          packet_type: "listing",
          state,
          forms_count: filledPacket.forms.length,
          brokerage_forms_count: filledPacket.brokerageForms.length,
          agent_must_complete: filledPacket.agentMustComplete,
          audit: filledPacket.audit,
          source: "voice_intake_elevenlabs",
        },
        content: JSON.stringify({ filledPacket, intake: extracted.intake }, null, 2),
      })
      .select("id")
      .maybeSingle()

    if (error || !doc) return { error: error?.message ?? "Could not create listing document" }

    // Post-call hand-off: email the agent with the review link. Same pattern
    // as stageOfferPacket — voice tells them "I've emailed you the link",
    // they open it after the call to review + dispatch for signatures.
    const reviewUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/listings/new?documentId=${doc.id}`
    let emailedAt: string | null = null
    try {
      const { data: agentUser } = await supabase
        .from("users")
        .select("email, first_name")
        .eq("id", session.user_id)
        .maybeSingle()

      if (agentUser?.email) {
        const { sendEmail } = await import("@/lib/providers/messaging")
        const subject = `Listing agreement staged — review and send for signatures`
        const propertyLine = (extracted.intake.propertyAddress?.value as string | undefined) ?? "the new listing"
        const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
          <h2 style="margin:0 0 12px 0;">Listing agreement staged</h2>
          <p>Hi ${agentUser.first_name ?? "there"} — the AI captured the listing intake from your call and filled the ${state} state forms for ${propertyLine}. Here's what to do next:</p>
          <ol>
            <li>Review the filled packet for accuracy</li>
            <li>Click <strong>Send for signature</strong> to dispatch via your configured e-sign provider</li>
            <li>Seller signs through the portal; you get a webhook notification</li>
          </ol>
          <div style="margin:24px 0;">
            <a href="${reviewUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Review & send for signatures →</a>
          </div>
          <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
            Forms count: ${filledPacket.forms.length} · State: ${state}
            ${filledPacket.agentMustComplete?.length ? `<br/>Fields still needing your input: ${filledPacket.agentMustComplete.length}` : ""}
          </p>
        </body></html>`

        const sendResult = await sendEmail({
          to:          agentUser.email,
          subject,
          html,
          agentUserId: session.user_id,
        })
        if (sendResult.success) emailedAt = new Date().toISOString()
      }
    } catch (err: any) {
      console.error("[voice/stageListingPacket] post-stage email failed:", err?.message)
    }

    return {
      success: true,
      document_id: doc.id,
      emailed_at: emailedAt,
      spoken_summary: emailedAt
        ? "Listing agreement is staged. I've emailed you the review link — open it after the call to check the filled forms and send for signatures."
        : "Listing agreement is staged in your listings page. Email send failed — open it manually to review and send for signatures.",
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Listing staging failed" }
  }
}

// ─── stage_offer_packet (voice) ──────────────────────────────────────────────
// Same canonical chain as voiceDraftOffer:
//   extractOfferIntake → fillOfferPacket → documents insert

async function stageOfferPacket(
  params: Record<string, unknown>,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  const contactId = String(params.contact_id ?? "").trim()
  const voiceInput = String(params.voice_input ?? params.address ?? "").trim()
  if (!contactId || !voiceInput) return { error: "contact_id and voice_input required" }

  // Brokerage check + agent_id for NAR-mandated BBA gate
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()
  if (!contact) return { error: "Contact not found in your brokerage" }

  // NAR 2024 Settlement: signed BBA required before an offer can be DISPATCHED.
  // Voice-staging is "drafting" — when no active BBA exists, we still allow the
  // offer DRAFT to stage so the agent doesn't have to redo the call later.
  // BUT we mark the offer document.metadata.requires_bba_first = true, which
  // the offer review page + e-sign dispatch gate (Commit L: submit-for-signature)
  // refuses to let the offer go out for signatures until the BBA is signed.
  //
  // The AI cockpit's response logic also checks for `needs_bba_intake` in the
  // return — when true, the AI captures BBA terms in the same call and stages
  // both packets (BBA via stage_bba_packet + offer here).
  let needsBBAIntake = false
  let activeBBAId: string | null = null
  if (contact.agent_id) {
    const { requireActiveBBA } = await import("@/lib/buyer-broker/gate")
    const bba = await requireActiveBBA({
      buyerContactId: contactId,
      agentId:        contact.agent_id as string,
      brokerageId:    session.brokerage_id,
    })
    if (bba.allowed && bba.agreementId) {
      activeBBAId = bba.agreementId
    } else {
      // Check if a draft BBA already exists in this same staging session
      const { data: draftBBA } = await supabase
        .from("buyer_broker_agreements")
        .select("id")
        .eq("buyer_contact_id", contactId)
        .eq("agent_id", contact.agent_id as string)
        .in("status", ["draft", "pending_signature"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (draftBBA?.id) {
        activeBBAId = draftBBA.id as string
      } else {
        needsBBAIntake = true
      }
    }
  }

  try {
    const { extractOfferIntake } = await import("@/lib/workflow/intake/voice-to-offer")
    const { fillOfferPacket } = await import("@/lib/workflow/intake/form-fill-engine")

    const extracted = await extractOfferIntake({ text: voiceInput })
    const state = extracted.intake.propertyState.value
    if (!state) {
      return {
        error: "Need state for offer forms. Ask the agent which state the property is in.",
        intake_so_far: extracted.intake,
      }
    }

    const filledPacket = await fillOfferPacket({
      intake: extracted.intake,
      brokerageId: session.brokerage_id,
    })

    const { data: doc, error } = await supabase
      .from("documents")
      .insert({
        brokerage_id: session.brokerage_id,
        contact_id: contactId,
        document_type: "offer",
        status: "needs_agent_input",
        state_code: state,
        metadata: {
          packet_type: "offer",
          state,
          forms_count: filledPacket.forms.length,
          brokerage_forms_count: filledPacket.brokerageForms.length,
          agent_must_complete: filledPacket.agentMustComplete,
          audit: filledPacket.audit,
          source: "voice_intake_elevenlabs",
          // BBA dependency tracking — submit-for-signature gate (Commit L)
          // refuses to dispatch when this flag is set and no active BBA exists.
          requires_bba_first:      activeBBAId === null,
          linked_bba_id:           activeBBAId,
          needs_bba_intake_first:  needsBBAIntake,
        },
        content: JSON.stringify({ filledPacket, intake: extracted.intake }, null, 2),
      })
      .select("id")
      .maybeSingle()
    if (error || !doc) return { error: error?.message ?? "Could not create offer document" }

    const contactName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
    // Review URL lands on the contact's offer-new page with the staged
    // documentId — FormWizard preloads the filled packet from the documents
    // row, the agent reviews + adjusts in the actual forms UI, then dispatches
    // to the configured e-sign provider (resolveESignProviderForActor cascade).
    const reviewUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/contacts/${contactId}/offers/new?documentId=${doc.id}`

    // Post-call hand-off: email the agent with a review link. The AI tells
    // them aloud "I've staged the offer — check your email"; the email is the
    // artifact they review after the call. They open the link, review the
    // filled forms, and dispatch through the configured e-sign provider
    // (Dotloop / DocuSign / etc. — see lib/integrations/resolve-esign-provider).
    let emailedAt: string | null = null
    try {
      const { data: agentUser } = await supabase
        .from("users")
        .select("email, first_name")
        .eq("id", session.user_id)
        .maybeSingle()

      if (agentUser?.email) {
        const { sendEmail } = await import("@/lib/providers/messaging")
        const subject = `Offer staged for ${contactName} — review and send for signatures`
        const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
          <h2 style="margin:0 0 12px 0;">Your offer for ${contactName} is staged</h2>
          <p>Hi ${agentUser.first_name ?? "there"} — the AI captured the offer intake from your call and filled the ${state} state forms. Here's what to do next:</p>
          <ol>
            <li>Review the filled packet for accuracy</li>
            <li>Click <strong>Send for signature</strong> to dispatch via your configured e-sign provider</li>
            <li>Buyer signs through their portal; you get a webhook notification</li>
          </ol>
          <div style="margin:24px 0;">
            <a href="${reviewUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Review & send for signatures →</a>
          </div>
          <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
            Forms count: ${filledPacket.forms.length} · State: ${state}
            ${filledPacket.agentMustComplete?.length ? `<br/>Fields still needing your input: ${filledPacket.agentMustComplete.length}` : ""}
          </p>
        </body></html>`

        const sendResult = await sendEmail({
          to:          agentUser.email,
          subject,
          html,
          agentUserId: session.user_id,
          contactId,
        })
        if (sendResult.success) emailedAt = new Date().toISOString()
      }
    } catch (err: any) {
      // Email failure does not undo staging — the document exists in /crm.
      console.error("[voice/stageOfferPacket] post-stage email failed:", err?.message)
    }

    return {
      success: true,
      document_id: doc.id,
      contact_name: contactName,
      emailed_at: emailedAt,
      linked_bba_id: activeBBAId,
      needs_bba_intake: needsBBAIntake,
      spoken_summary: needsBBAIntake
        ? `Offer for ${contactName} is staged. There's no Buyer Broker Agreement on file yet — let's capture those terms now. Agreement type, commission percentage or flat, and who pays. I'll stage the BBA too and email you both review links. Review them, then tell me to send for signatures when you're ready — I won't send anything until you say so.`
        : emailedAt
        ? `Offer for ${contactName} is staged. I've emailed you the review link — open it, verify the filled forms look right, then tell me to send for signature or send it yourself from the review page. Nothing's been dispatched yet.`
        : `Offer for ${contactName} is staged in the CRM. Email send failed — open the contact's record after the call to review and send for signatures.`,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Offer staging failed" }
  }
}

// ─── stage_bba_packet (voice) ────────────────────────────────────────────────
// Companion to stage_offer_packet. When the AI determines the buyer has no
// active BBA, it captures the BBA terms in the same conversation and stages
// a draft via this tool. The agent reviews + sends for signatures first;
// once signed (status='active'), the offer document's requires_bba_first
// flag is satisfied and submit-for-signature gate (Commit L) lets the offer
// go out too.

async function stageBBAPacket(
  params: Record<string, unknown>,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  const contactId = String(params.contact_id ?? "").trim()
  const voiceInput = String(params.voice_input ?? "").trim()
  if (!contactId || !voiceInput) return { error: "contact_id and voice_input required" }

  // Resolve buyer + agent_id (agents.id — BBA FKs agents not users)
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()
  if (!contact) return { error: "Contact not found in your brokerage" }
  if (!contact.agent_id) return { error: "Contact has no assigned agent — assign one before drafting a BBA." }

  try {
    const { extractBBAIntake } = await import("@/lib/workflow/intake/voice-to-bba")
    const extracted = await extractBBAIntake({ text: voiceInput })

    if (!extracted.readyToDraft) {
      // AI must capture more before drafting — return the missing questions
      // so ElevenLabs Conv AI can continue the conversation.
      return {
        error: "BBA intake incomplete — need more information before drafting.",
        missing_questions: extracted.missingQuestions,
        intake_so_far: extracted.intake,
        spoken_summary: "I need a few more details on the BBA before I can draft it.",
      }
    }

    // Map IntakeField → buyer_broker_agreements column shape
    const i = extracted.intake
    const agreementType  = (i.agreementType.value ?? "exclusive") as "exclusive" | "non_exclusive" | "showing_only" | "open"
    const commissionPct  = i.commissionPercentage.value ?? null
    const commissionFlat = i.commissionFlatAmount.value ?? null
    const commissionPayer = (i.commissionPayer.value ?? "seller") as "seller" | "buyer" | "split" | "either"

    if (commissionPct === null && commissionFlat === null && agreementType !== "showing_only") {
      return {
        error: "BBA requires either a commission percentage or flat amount (showing_only is the only exception).",
        missing_questions: [{ field: "commissionPercentage", question: "What's the commission percentage or flat amount?", severity: "must_ask" }],
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    const ninetyD = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)

    // Create the draft BBA row directly (mirrors createBBADraftAction logic
    // but uses service client because the voice tool runs without an auth
    // session user — it has session.user_id from the agent_assistant_sessions
    // row, which we use as created_by).
    const { data: bba, error: bbaErr } = await supabase
      .from("buyer_broker_agreements")
      .insert({
        brokerage_id:           session.brokerage_id,
        buyer_contact_id:       contactId,
        agent_id:               contact.agent_id,
        agreement_type:         agreementType,
        commission_percentage:  commissionPct,
        commission_flat_amount: commissionFlat,
        commission_payer:       commissionPayer,
        commission_notes:       i.commissionNotes.value ?? null,
        geographic_scope:       i.geographicScope.value ?? null,
        property_type_scope:    i.propertyTypeScope.value ?? ["residential"],
        effective_date:         i.effectiveDate.value ?? today,
        expiration_date:        i.expirationDate.value ?? ninetyD,
        status:                 "draft",
        created_by:             session.user_id,
        notes:                  i.agentNotes.value ?? null,
      })
      .select("id")
      .single()

    if (bbaErr || !bba) return { error: bbaErr?.message ?? "Could not create BBA draft" }

    const contactName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
    const reviewUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/buyer-broker-agreements?id=${bba.id}`

    // Post-call email handoff to the agent
    let emailedAt: string | null = null
    try {
      const { data: agentUser } = await supabase
        .from("users")
        .select("email, first_name")
        .eq("id", session.user_id)
        .maybeSingle()

      if (agentUser?.email) {
        const { sendEmail } = await import("@/lib/providers/messaging")
        const commissionLine = commissionPct !== null
          ? `${commissionPct}% paid by ${commissionPayer}`
          : commissionFlat !== null
          ? `$${commissionFlat.toLocaleString()} paid by ${commissionPayer}`
          : `terms in document`
        const subject = `Buyer Broker Agreement staged for ${contactName} — review and send for signature`
        const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
          <h2 style="margin:0 0 12px 0;">Buyer Broker Agreement staged</h2>
          <p>Hi ${agentUser.first_name ?? "there"} — captured the BBA terms with ${contactName} from your call. Here's what to do next:</p>
          <ol>
            <li>Review the agreement type + commission terms</li>
            <li>Click <strong>Send for signature</strong> to dispatch via your configured e-sign provider</li>
            <li>Buyer signs through their portal — once signed (status=active), the linked offer can go out for signatures too</li>
          </ol>
          <div style="margin:24px 0;">
            <a href="${reviewUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Review & send for signature →</a>
          </div>
          <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
            Type: ${agreementType} · Commission: ${commissionLine} · Expires: ${i.expirationDate.value ?? ninetyD}
          </p>
        </body></html>`

        const sendResult = await sendEmail({
          to:          agentUser.email,
          subject,
          html,
          agentUserId: session.user_id,
          contactId,
        })
        if (sendResult.success) emailedAt = new Date().toISOString()
      }
    } catch (err: any) {
      console.error("[voice/stageBBAPacket] post-stage email failed:", err?.message)
    }

    return {
      success:       true,
      bba_id:        bba.id,
      contact_name:  contactName,
      emailed_at:    emailedAt,
      spoken_summary: emailedAt
        ? `BBA for ${contactName} is staged. I've emailed you the review link — verify the terms, then tell me to send for signature when you're ready. If there's a staged offer too, I'll bundle them into one packet. Nothing's been dispatched yet.`
        : `BBA for ${contactName} is staged in the CRM. Email send failed — open it manually to review and send for signature.`,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "BBA staging failed" }
  }
}

// ─── lookup_contact ───────────────────────────────────────────────────────────

async function lookupContact(
  query: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!query || query.length < 2) return { matches: [] }

  const phoneDigits = query.replace(/\D/g, "")
  const isPhone = phoneDigits.length >= 7

  let q = supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, contact_type, last_contact_at")
    .eq("brokerage_id", session.brokerage_id)
    .limit(5)

  if (isPhone) {
    q = q.ilike("phone", `%${phoneDigits.slice(-7)}%`)
  } else if (query.includes("@")) {
    q = q.ilike("email", `%${query}%`)
  } else {
    // Name search across first + last
    q = q.or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%`)
  }

  const { data } = await q
  return {
    matches: (data ?? []).map((c: any) => ({
      contact_id: c.id,
      name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(no name)",
      email: c.email,
      phone: c.phone,
      type: c.contact_type,
      last_contact: c.last_contact_at,
    })),
  }
}

// ─── get_today_schedule ───────────────────────────────────────────────────────

async function getTodaySchedule(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { appointments: [], message: "No agent profile for this session." }

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(startOfDay)
  endOfDay.setHours(23, 59, 59, 999)

  // Showings + activities scheduled today
  const [showings, activities] = await Promise.all([
    supabase
      .from("showings")
      .select("id, scheduled_at, listing_id, contact_id, notes")
      .eq("agent_id", session.agent_id)
      .gte("scheduled_at", startOfDay.toISOString())
      .lt("scheduled_at", endOfDay.toISOString())
      .order("scheduled_at", { ascending: true }),
    supabase
      .from("activities")
      .select("id, scheduled_at, activity_type, title, contact_id")
      .eq("agent_id", session.agent_id)
      .eq("status", "scheduled")
      .gte("scheduled_at", startOfDay.toISOString())
      .lt("scheduled_at", endOfDay.toISOString())
      .order("scheduled_at", { ascending: true }),
  ])

  const appointments = [
    ...(showings.data ?? []).map((s: any) => ({
      time: s.scheduled_at,
      type: "showing",
      title: s.notes ?? "Showing",
      listing_id: s.listing_id,
      contact_id: s.contact_id,
    })),
    ...(activities.data ?? []).map((a: any) => ({
      time: a.scheduled_at,
      type: a.activity_type,
      title: a.title,
      contact_id: a.contact_id,
    })),
  ].sort((a, b) => (a.time < b.time ? -1 : 1))

  return { appointments, count: appointments.length }
}

// ─── get_contact_details ──────────────────────────────────────────────────────

async function getContactDetails(
  contactId: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId) return { error: "contact_id required" }

  const { data: c } = await supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, email, phone, contact_type, contact_persona, last_contact_at, engagement_score, do_not_contact, notes, status",
    )
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()

  if (!c) return { error: "Contact not found in your brokerage" }

  const { data: recentActivities } = await supabase
    .from("activities")
    .select("activity_type, title, scheduled_at, status")
    .eq("contact_id", contactId)
    .order("scheduled_at", { ascending: false })
    .limit(5)

  return {
    contact_id: c.id,
    name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(no name)",
    email: c.email,
    phone: c.phone,
    type: c.contact_type,
    persona: c.contact_persona,
    status: c.status,
    do_not_contact: !!c.do_not_contact,
    engagement_score: c.engagement_score,
    last_contact: c.last_contact_at,
    notes: c.notes,
    recent_activities: recentActivities ?? [],
  }
}

// ─── log_activity ─────────────────────────────────────────────────────────────

async function logActivity(
  contactId: string,
  activityType: string,
  notes: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId || !notes) return { error: "contact_id + notes required" }

  // Verify contact belongs to this brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()
  if (!contact) return { error: "Contact not found" }

  const { data, error } = await supabase
    .from("activities")
    .insert({
      brokerage_id: session.brokerage_id,
      agent_id: session.agent_id,
      contact_id: contactId,
      activity_type: activityType,
      title: notes.slice(0, 100),
      notes,
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Failed to log activity" }

  // Bump contacts.last_contact_at so the CRM reflects the touchpoint.
  await supabase
    .from("contacts")
    .update({ last_contact_at: new Date().toISOString() })
    .eq("id", contactId)

  return { success: true, activity_id: data.id }
}

// ─── create_task ──────────────────────────────────────────────────────────────

async function createTask(
  title: string,
  dueDate: string | null,
  contactId: string | null,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!title) return { error: "title required" }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      brokerage_id: session.brokerage_id,
      assigned_to_agent_id: session.user_id,
      created_by_agent_id: session.user_id,
      title,
      priority: "normal",
      due_date: dueDate ?? undefined,
      contact_id: contactId ?? undefined,
      status: "pending",
    })
    .select("id, title, due_date")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Failed to create task" }
  return { success: true, task_id: data.id, title: data.title, due_date: data.due_date }
}

// ─── send_portal_message ──────────────────────────────────────────────────────

async function sendPortalMessage(
  contactId: string,
  bodyText: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId || !bodyText) return { error: "contact_id + body required" }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, agent_id, dnc_status, call_stop_flag, tcpa_consent, contact_type, status")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()

  if (!contact) return { error: "Contact not found" }
  // dnc_status is the canonical "do not contact" gate (TCPA-level).
  // call_stop_flag is the agent-toggled hard stop. Either blocks.
  if (contact.dnc_status === true) {
    return { error: "Contact is on the Do Not Call list — message blocked." }
  }
  if (contact.call_stop_flag === true) {
    return { error: "Contact has requested no further communication (call_stop_flag) — message blocked." }
  }

  // Kernel-level outbound compliance gate (brand voice + Them-First + fair
  // housing + content scans). Portal messages bypass TCPA (no phone/email
  // touch) but content quality + brand voice still apply.
  try {
    const { evaluateOutbound } = await import("@/lib/kernel/compliance")
    const compliance = await evaluateOutbound({
      actorContext: {
        userId:      session.user_id,
        brokerageId: session.brokerage_id,
        role:        "agent",
      },
      journeyType:  (contact.contact_type as any) === "seller" ? "seller" : "buyer",
      persona:      "other",
      messageType:  "in_app",
      content:      bodyText,
      contact: {
        id:                   contact.id,
        first_name:           contact.first_name ?? "",
        last_name:            contact.last_name ?? "",
        email:                contact.email ?? undefined,
        phone:                contact.phone ?? undefined,
        contact_type:         contact.contact_type ?? "buyer",
        tcpa_consent:         contact.tcpa_consent ?? false,
        dnc_status:           contact.dnc_status ?? false,
        isa_reengage_allowed: false,
        status:               contact.status ?? undefined,
        brokerage_id:         session.brokerage_id,
      },
    })
    if (compliance.allowed === false) {
      return {
        error: compliance.blockedReason ?? "Message blocked by compliance gate.",
        violations: compliance.violations,
        spoken_summary: "I can't send that message — it didn't pass compliance. Try again with different wording.",
      }
    }
  } catch (err: any) {
    // Compliance evaluator failure should not bypass — fail CLOSED on portal sends.
    console.error("[voice/sendPortalMessage] compliance evaluator threw:", err?.message)
    return { error: "Compliance check failed — message not sent. Try again or escalate to admin." }
  }

  const { data, error } = await supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      agent_id: contact.agent_id ?? session.agent_id,
      brokerage_id: session.brokerage_id,
      direction: "agent_to_client",
      channel: "portal",
      read: false,
      body: bodyText,
      read_at: null,
    })
    .select("id")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Failed to send message" }
  return { success: true, message_id: data.id, preview: bodyText.slice(0, 80) }
}

// ─── get_active_listings ──────────────────────────────────────────────────────

async function getActiveListings(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { listings: [] }
  const { data } = await supabase
    .from("listings")
    .select("id, address, city, state, list_price, bedrooms, bathrooms, sqft, status, lifecycle_stage")
    .eq("agent_id", session.agent_id)
    .in("status", ["active", "coming_soon"])
    .is("deleted_at", null)
    .order("listing_date", { ascending: false })
    .limit(10)
  return { listings: data ?? [], count: data?.length ?? 0 }
}

// ─── get_pending_offers ───────────────────────────────────────────────────────

async function getPendingOffers(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { offers: [] }
  const { data } = await supabase
    .from("offers")
    .select(
      "id, offer_number, offer_price, status, response_deadline, financing_type, contact_id, listing_id, property_address",
    )
    .eq("agent_id", session.agent_id)
    .in("status", ["pending", "countered", "submitted"])
    .order("submitted_at", { ascending: false })
    .limit(10)
  return { offers: data ?? [], count: data?.length ?? 0 }
}

// ─── get_transactions_in_progress ─────────────────────────────────────────────

async function getTransactionsInProgress(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { transactions: [] }
  const { data } = await supabase
    .from("transactions")
    .select("id, deal_name, status, stage, property_address, close_date, contact_id, purchase_price")
    .eq("agent_id", session.agent_id)
    .in("status", ["under_contract", "inspection", "appraisal", "financing", "closing_prep"])
    .is("deleted_at", null)
    .order("close_date", { ascending: true })
    .limit(10)
  return { transactions: data ?? [], count: data?.length ?? 0 }
}

// ─── get_recent_messages ──────────────────────────────────────────────────────

async function getRecentMessages(
  contactId: string | null,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  let q = supabase
    .from("client_portal_messages")
    .select("id, contact_id, direction, body, channel, read, created_at")
    .eq("brokerage_id", session.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(10)
  if (contactId) q = q.eq("contact_id", contactId)
  if (session.agent_id) q = q.eq("agent_id", session.agent_id)
  const { data } = await q
  return {
    messages: (data ?? []).map((m: any) => ({
      contact_id: m.contact_id,
      from: m.direction === "agent_to_client" ? "you" : "client",
      preview: (m.body as string).slice(0, 120),
      channel: m.channel,
      read: m.read,
      ts: m.created_at,
    })),
  }
}

// ─── update_contact_status ────────────────────────────────────────────────────

async function updateContactStatus(
  contactId: string,
  status: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId || !status) return { error: "contact_id + status required" }

  const { data, error } = await supabase
    .from("contacts")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .select("id, first_name, last_name, status")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Update failed — contact not in your brokerage" }
  return {
    success: true,
    contact_id: data.id,
    name: `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim(),
    new_status: data.status,
  }
}

// ─── read_form_status (voice) ────────────────────────────────────────────────
// The AI voice agent can OPEN any staged packet (offer / listing / BBA) and
// read the fill status field-by-field back to the agent. Used when the agent
// hasn't supplied enough info — the AI walks the unfilled fields aloud so the
// agent can answer them in real time instead of staging and reopening later.

async function readFormStatus(
  params: Record<string, unknown>,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  const documentId = String(params.document_id ?? "").trim()
  if (!documentId) return { error: "document_id required" }

  const { data: doc } = await supabase
    .from("documents")
    .select("id, document_type, status, state_code, content, metadata, brokerage_id, contact_id")
    .eq("id", documentId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()
  if (!doc) return { error: "Document not found in your brokerage" }

  let filledPacket: any = {}
  try {
    const parsed = JSON.parse((doc.content as string | null) ?? "{}")
    filledPacket = parsed?.filledPacket ?? {}
  } catch { /* old docs may not be JSON — fall through */ }

  // Build a flat list of (form, field, value/empty) tuples the AI can read aloud
  const forms = [...(filledPacket.forms ?? []), ...(filledPacket.brokerageForms ?? [])]
  const filledByForm: Array<{ form: string; filled_count: number; unfilled: string[] }> = []
  const allUnfilled: Array<{ form: string; field: string; reason: string }> = []
  let highConf = 0, medConf = 0, lowConf = 0

  for (const f of forms) {
    const filled = (f.filledFields ?? []) as Array<{ fieldName: string; confidence: string }>
    const unfilled = (f.unfilled ?? []) as Array<{ fieldName: string; reason: string }>
    for (const ff of filled) {
      if (ff.confidence === "high") highConf++
      else if (ff.confidence === "medium") medConf++
      else if (ff.confidence === "low") lowConf++
    }
    filledByForm.push({
      form: f.formName ?? f.formId,
      filled_count: filled.length,
      unfilled: unfilled.map(u => u.fieldName),
    })
    for (const u of unfilled) {
      allUnfilled.push({ form: f.formName ?? f.formId, field: u.fieldName, reason: u.reason })
    }
  }

  const meta = (doc.metadata as Record<string, unknown>) ?? {}
  const agentMustComplete = (meta.agent_must_complete as string[]) ?? filledPacket.agentMustComplete ?? []

  // Compose plain-English spoken summary the AI can use directly
  const docLabel =
    doc.document_type === "offer" ? "offer" :
    doc.document_type === "listing_agreement" ? "listing agreement" :
    doc.document_type
  const spoken_summary = allUnfilled.length === 0
    ? `The ${docLabel} packet is fully filled — ${highConf} high-confidence fields. Ready to send.`
    : `The ${docLabel} packet has ${highConf + medConf + lowConf} fields filled. Still need: ${allUnfilled.slice(0, 10).map(u => u.field).join(", ")}${allUnfilled.length > 10 ? `, and ${allUnfilled.length - 10} more` : ""}. Want me to walk through them?`

  return {
    success: true,
    document_id: documentId,
    document_type: doc.document_type,
    state_code: doc.state_code,
    forms: filledByForm,
    unfilled_fields: allUnfilled,
    agent_must_complete: agentMustComplete,
    confidence_breakdown: { high: highConf, medium: medConf, low: lowConf },
    spoken_summary,
  }
}

// ─── dispatch_transaction_packet (voice) ─────────────────────────────────────
// Combined e-sign dispatch: when an agent has BOTH a staged BBA and a staged
// offer for the same buyer, send them in ONE e-sign envelope so the buyer
// signs both at once. Per NAR 2024, the BBA still has to be signed before
// the offer is presented to the seller — bundling them in the same packet
// to the BUYER is the correct UX (buyer signs both in sequence within the
// envelope; offer is held until BBA section is signed).

async function dispatchTransactionPacket(
  params: Record<string, unknown>,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  const contactId       = String(params.contact_id ?? "").trim()
  const offerDocumentId = params.offer_document_id ? String(params.offer_document_id) : null
  const bbaId           = params.bba_id ? String(params.bba_id) : null
  /** When true (default), the AI can be called with ONLY contact_id and we
   *  auto-resolve the most recent draftable BBA + offer for that buyer.
   *  Agent can say "send Jane's offer for signature" without quoting IDs. */
  const autoResolve     = params.auto_resolve === false ? false : true

  if (!contactId) return { error: "contact_id required" }

  // Brokerage check + resolve buyer + agent_id for e-sign provider routing
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, agent_id")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()
  if (!contact)        return { error: "Contact not found in your brokerage" }
  if (!contact.email)  return { error: "Buyer has no email — cannot dispatch for signature" }

  // Verify both artifacts belong to this brokerage + buyer.
  // When the agent didn't quote IDs, auto-resolve the most recent dispatchable
  // BBA (status='draft') + offer (status='needs_agent_input' or 'draft_ready')
  // for this contact. The AI uses this when the agent says "send Jane's offer
  // for signature" — we look up Jane's staged packet from the contact record.
  let bba: any = null
  let offerDoc: any = null

  if (bbaId) {
    const { data } = await supabase
      .from("buyer_broker_agreements")
      .select("id, status, agreement_type, commission_percentage, commission_flat_amount, commission_payer")
      .eq("id", bbaId)
      .eq("brokerage_id", session.brokerage_id)
      .eq("buyer_contact_id", contactId)
      .maybeSingle()
    if (!data) return { error: "BBA not found in your brokerage" }
    if (data.status !== "draft" && data.status !== "pending_signature") {
      return { error: `BBA is already ${data.status} — cannot bundle into a new packet` }
    }
    bba = data
  } else if (autoResolve) {
    const { data } = await supabase
      .from("buyer_broker_agreements")
      .select("id, status, agreement_type, commission_percentage, commission_flat_amount, commission_payer")
      .eq("brokerage_id", session.brokerage_id)
      .eq("buyer_contact_id", contactId)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    bba = data ?? null
  }

  if (offerDocumentId) {
    const { data } = await supabase
      .from("documents")
      .select("id, status, document_type, state_code, metadata")
      .eq("id", offerDocumentId)
      .eq("brokerage_id", session.brokerage_id)
      .eq("contact_id", contactId)
      .maybeSingle()
    if (!data)                                   return { error: "Offer document not found in your brokerage" }
    if (data.document_type !== "offer")          return { error: "Document is not an offer" }
    if (data.status !== "needs_agent_input" && data.status !== "draft_ready") {
      return { error: `Offer is already ${data.status} — cannot bundle into a new packet` }
    }
    offerDoc = data
  } else if (autoResolve) {
    const { data } = await supabase
      .from("documents")
      .select("id, status, document_type, state_code, metadata")
      .eq("brokerage_id", session.brokerage_id)
      .eq("contact_id", contactId)
      .eq("document_type", "offer")
      .in("status", ["needs_agent_input", "draft_ready"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    offerDoc = data ?? null
  }

  if (!bba && !offerDoc) {
    return {
      error: "No staged BBA or offer found for this buyer.",
      spoken_summary: `${contact.first_name ?? "This buyer"} has no draft BBA or staged offer ready to send. Stage one first.`,
    }
  }

  // Resolve the agent's configured e-sign provider (user-scope > brokerage)
  let resolved: any
  try {
    const { resolveESignProviderForActor } = await import("@/lib/integrations/resolve-esign-provider")
    resolved = await resolveESignProviderForActor({
      brokerageId: session.brokerage_id,
      userId:      session.user_id,
    })
  } catch (err: any) {
    return { error: err?.message ?? "No e-sign provider configured. Add credentials in Settings → Integrations." }
  }

  // 1. Create ONE transaction in the e-sign provider
  const txReq = await resolved.provider.createTransaction({
    propertyAddress: bba && offerDoc
      ? "BBA + Offer packet"
      : bba ? "Buyer Broker Agreement" : "Offer packet",
    transactionType: "purchase",
    agentId:         contact.agent_id ?? session.user_id,
    contactId,
  })
  if (!txReq.success || !txReq.externalTransactionId) {
    return { error: txReq.error ?? "Provider createTransaction failed" }
  }
  const externalTxId = txReq.externalTransactionId

  // 2. Attach both artifacts as separate forms in the same envelope
  const formsToAttach: Array<{ formName: string; formData?: Record<string, any> }> = []
  if (bba) {
    const commissionLine = bba.commission_percentage !== null
      ? `${bba.commission_percentage}% paid by ${bba.commission_payer}`
      : bba.commission_flat_amount !== null
      ? `$${bba.commission_flat_amount} paid by ${bba.commission_payer}`
      : "see document"
    formsToAttach.push({
      formName: `Buyer Broker Agreement (${bba.agreement_type})`,
      formData: { commission: commissionLine, agreement_type: bba.agreement_type, bba_id: bba.id },
    })
  }
  if (offerDoc) {
    formsToAttach.push({
      formName: `Purchase Offer (${offerDoc.state_code})`,
      formData: { offer_document_id: offerDoc.id, state: offerDoc.state_code },
    })
  }
  await resolved.provider.attachForms({
    externalTransactionId: externalTxId,
    forms: formsToAttach,
  })

  // 3. Send ONE signature request to the buyer
  const signers = [{
    email: contact.email,
    name:  [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Buyer",
    role:  "buyer",
  }]
  const send = await resolved.provider.sendForSignature({
    externalTransactionId: externalTxId,
    documentId:            offerDoc?.id ?? bba?.id ?? externalTxId,
    signers,
    message: bba && offerDoc
      ? "Please review and sign both the Buyer Broker Agreement and the Purchase Offer."
      : bba
      ? "Please review and sign your Buyer Broker Agreement."
      : "Please review and sign your purchase offer.",
  })
  if (!send.success) {
    return { error: send.error ?? "Provider sendForSignature failed" }
  }

  // 4. Update both artifact statuses
  if (bba) {
    await supabase
      .from("buyer_broker_agreements")
      .update({
        status:               "pending_signature",
        signed_method:        resolved.providerName === "dotloop" ? "dotloop" : "docusign",
        signature_request_id: externalTxId,
      })
      .eq("id", bba.id)
  }
  if (offerDoc) {
    await supabase
      .from("documents")
      .update({
        status: "pending_signature",
        metadata: {
          ...((offerDoc as any).metadata ?? {}),
          signature_request_id: externalTxId,
          dispatched_via:       resolved.providerName,
          dispatched_at:        new Date().toISOString(),
          bundled_with_bba_id:  bba?.id ?? null,
        },
      })
      .eq("id", offerDoc.id)
  }

  const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Buyer"
  return {
    success: true,
    external_transaction_id: externalTxId,
    provider: resolved.providerName,
    artifacts_sent: { bba_id: bba?.id ?? null, offer_document_id: offerDoc?.id ?? null },
    spoken_summary: bba && offerDoc
      ? `Both the BBA and the offer for ${contactName} are out for signature via ${resolved.providerName}. ${contact.first_name ?? "The buyer"} will get one packet with both. Webhook updates land on the document records as they sign.`
      : bba
      ? `BBA for ${contactName} is out for signature via ${resolved.providerName}.`
      : `Offer for ${contactName} is out for signature via ${resolved.providerName}.`,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonToolError(message: string) {
  return NextResponse.json({ result: { error: message } })
}

function secretMatches(expected: string, provided: string): boolean {
  // Constant-time comparison to thwart timing attacks. Fall back to a length
  // mismatch rejection if buffers differ.
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
