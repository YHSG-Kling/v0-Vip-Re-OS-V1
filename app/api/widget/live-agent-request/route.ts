/**
 * POST /api/widget/live-agent-request
 * Called when a website visitor explicitly requests an agent callback via the chat widget.
 * Per spec: consent is given → create contact (NOT lead) via kernel CRM.
 *
 * THE TENANT AND THE RECIPIENT COME FROM THE WIDGET SESSION. This route used to
 * take `brokerageId`, `scope` and `ownerId` off the unauthenticated body, so a
 * POST could create a consented contact in any brokerage and fire a
 * high-priority notification at any user on the platform. Both now come off the
 * chat_sessions row the server-issued `session_token` identifies.
 *
 * It also carried the m336 identity-class bug: `ownerId` was an agents.id (the
 * widget URL is built from agents.id) and resolveWidgetNotificationTarget's
 * agent branch looked it up as users.id, which never matches — so the agent
 * scope silently fell through to no recipient and no contact. Resolving the
 * session's agents.id THROUGH the agents row to a users.id fixes that here.
 */
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
// Wave 148 (lane 148B): THE one consented-intake door (C8) + the one consent component's server contract (C15).
import { captureConsentedContact, consentGrantsFromComponent, resolveConsentBrand } from "@/lib/contact-pipeline/contact-capture"
import { resolveWidgetNotificationTarget } from "@/lib/integrations/widget/resolve-notification-target"
import { createCallbackTask } from "@/lib/ai-isa/callback-task"

export async function POST(request: NextRequest) {
  const body = await request.json()
  const {
    firstName,
    lastName,
    phone,
    bestTime,
    tcpaConsent,
    session_token,
    consent,
  }: {
    firstName?: string
    lastName?: string
    phone?: string
    bestTime?: string
    /** @deprecated pre-148 widgets — the bare box. Superseded by `consent` (C15). */
    tcpaConsent?: boolean
    session_token?: string
    /** THE ONE CONSENT COMPONENT's submission (C15 — wave 148). The wording is re-rendered here, never the body's. */
    consent?: unknown
  } = body

  if (!tcpaConsent && !consent) return NextResponse.json({ error: "TCPA consent required" }, { status: 400 })
  if (!session_token) return NextResponse.json({ error: "session_token required" }, { status: 400 })

  const supabase = createServiceClient()

  // ── Resolve the tenant from the widget session ──────────────────────────
  // Destructured error: a failed read resolves in supabase-js, so `!session`
  // alone would report an outage as a rejected callback request.
  const { data: session, error: sessionError } = await supabase
    .from("chat_sessions")
    .select("id, brokerage_id, agent_id, status")
    .eq("widget_session_token", session_token)
    .maybeSingle()

  if (sessionError) {
    console.error("[widget/live-agent-request] session lookup failed:", sessionError.message)
    return NextResponse.json({ error: "Callback requests are temporarily unavailable." }, { status: 503 })
  }
  if (!session || !session.brokerage_id || session.status === "closed") {
    return NextResponse.json({ error: "Invalid or closed session" }, { status: 403 })
  }

  const brokerageId: string = session.brokerage_id
  // chat_sessions.agent_id is an agents.id, and the session mint has already
  // proven it belongs to THIS brokerage.
  const agentId: string | null = session.agent_id ?? null

  // ── Resolve who gets told ───────────────────────────────────────────────
  // Agent-scoped session → that agent's users.id, resolved ACROSS the id
  // classes. Brokerage-scoped → the brokerage's lead router / first broker.
  let recipient: { user_id: string } | null = null
  if (agentId) {
    const { data: agentRow, error: agentError } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (agentError) {
      console.error("[widget/live-agent-request] agent lookup failed:", agentError.message)
    }
    recipient = agentRow?.user_id ? { user_id: agentRow.user_id } : null
  }
  if (!recipient) {
    recipient = await resolveWidgetNotificationTarget("brokerage", brokerageId)
  }

  // ONE DOOR (wave 148, lane 148B — owner rulings 3, 4). TOMBSTONE: this used to create the contact through the kernel
  // CRM's staff manual-create (createContactManually) with an invented "Widget Visitor" name, `tcpa_consent: true` stamped
  // with no wording, and ONLY when the session was agent-scoped (a brokerage widget's callback filed no contact at all). It
  // now rides THE one consented-intake door (C8) with the ONE consent component's boxes (C15) — or, for a cached pre-148
  // widget, the label it showed beside its box. A visitor with no name stays a callback task, never a fabricated contact.
  const callbackBrand = await resolveConsentBrand(supabase, { agentId: null, brokerageId })
  const callbackC15 = consentGrantsFromComponent(consent, { door: "chat_widget", brandName: callbackBrand, provided: { email: false, phone: !!phone } })
  if (consent && !callbackC15.submission?.service_delivery) return NextResponse.json({ error: "Please tick the first consent box (the service follow-up) so we can call you back." }, { status: 400 })
  const CALLBACK_LEGACY_TEXT = "I agree to be contacted by a real estate professional via phone, email, or text."
  let contactId: string | null = null
  if ((firstName ?? lastName) && phone) {
    const intake = await captureConsentedContact({
      brokerageId,
      ownerAgentId: agentId,
      source: "website_widget_callback",
      status: "new",
      first_name: firstName ?? null,
      last_name: lastName ?? null,
      phone,
      preferred_channel: "phone",
      notes: bestTime ? `Best time to call: ${bestTime}` : null,
      ...(bestTime ? { preferred_contact_time: bestTime.slice(0, 120) } : {}),
      consents: callbackC15.submission
        ? callbackC15.grants
        : [{ family: "phone", given: tcpaConsent === true, text: CALLBACK_LEGACY_TEXT, textVersion: "widget_callback:legacy", purposes: ["requested_information"] }],
      intake: {
        channel: "chat_widget", sourceUrl: "/api/widget/live-agent-request",
        evidence: { ...callbackC15.evidence, ...(callbackC15.wordingHash ? { wording_hash: callbackC15.wordingHash } : {}), chat_session_id: session.id, ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, user_agent: request.headers.get("user-agent") ?? null },
        formOwner: { table: "chat_sessions", id: session.id },
      },
    }, { client: supabase })
    if (intake.ok && intake.contactId) contactId = intake.contactId
    else console.error("[widget/live-agent-request] consented intake refused:", intake.refused, intake.reason)
  }

  // THE DURABLE HALF — owner ruling (wave 55): a callback ask must become a
  // real task with an autonomous executor, not just a notification a human
  // might miss. /api/cron/ai-callback-dispatch places the call through the
  // same gated outbound door every other ISA dial uses, regardless of
  // whether the notification below is ever read.
  if (phone) {
    const callback = await createCallbackTask(supabase, {
      brokerageId,
      contactId,
      phone,
      whenPhrase: bestTime?.trim() || "as soon as possible",
      reason: "Requested a callback from the website chat widget",
      voiceCallId: null,
      assigneeType: "ai_isa",
      assignedToAgentId: agentId,
    })
    if (!callback.ok) {
      console.error("[widget/live-agent-request] callback task write refused:", callback.error)
    }
  }

  // Send notification to scoped recipient
  if (recipient?.user_id) {
    const { error: notifyError } = await supabase.from("notifications").insert({
      user_id: recipient.user_id,
      brokerage_id: brokerageId,
      type: "website_live_agent_request",
      entity_type: contactId ? "contact" : null,
      entity_id: contactId,
      title: `${firstName ?? "A visitor"} requested a callback from your website`,
      body: [
        phone ? `Phone: ${phone}.` : null,
        bestTime ? `Best time: ${bestTime}.` : null,
      ].filter(Boolean).join(" ") || "No additional details.",
      priority: "high",
      is_read: false,
    })
    // A refused insert resolves — without this the callback request reported
    // success while nobody was ever told about it.
    if (notifyError) {
      console.error("[widget/live-agent-request] notification insert refused:", notifyError.message)
    }
  }

  return NextResponse.json({ ok: true, contactId })
}
