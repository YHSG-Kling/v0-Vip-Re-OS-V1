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
import { createContactManually } from "@/lib/kernel/crm"
import { resolveWidgetNotificationTarget } from "@/lib/integrations/widget/resolve-notification-target"

export async function POST(request: NextRequest) {
  const body = await request.json()
  const {
    firstName,
    lastName,
    phone,
    bestTime,
    tcpaConsent,
    session_token,
  }: {
    firstName?: string
    lastName?: string
    phone?: string
    bestTime?: string
    tcpaConsent: boolean
    session_token?: string
  } = body

  if (!tcpaConsent) return NextResponse.json({ error: "TCPA consent required" }, { status: 400 })
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

  // Create contact via kernel CRM (they gave TCPA consent, so they're a contact)
  const contactResult = agentId
    ? await createContactManually({
        first_name: firstName ?? "Widget",
        last_name: lastName ?? "Visitor",
        phone: phone ?? null,
        agent_id: agentId,
        brokerage_id: brokerageId,
        tcpa_consent: true,
        source_label: "website_widget_callback",
        status: "new",
        notes: bestTime ? `Best time to call: ${bestTime}` : undefined,
      })
    : { success: false, contactId: undefined }

  const contactId = contactResult.contactId ?? null

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
