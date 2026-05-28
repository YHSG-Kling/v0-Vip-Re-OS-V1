/**
 * POST /api/widget/live-agent-request
 * Called when a website visitor explicitly requests an agent callback via the chat widget.
 * Per spec: consent is given → create contact (NOT lead) via kernel CRM.
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
    scope,
    ownerId,
    brokerageId,
  }: {
    firstName?: string
    lastName?: string
    phone?: string
    bestTime?: string
    tcpaConsent: boolean
    scope: "agent" | "team" | "brokerage"
    ownerId: string
    brokerageId: string
  } = body

  if (!tcpaConsent) return NextResponse.json({ error: "TCPA consent required" }, { status: 400 })
  if (!brokerageId) return NextResponse.json({ error: "brokerageId required" }, { status: 400 })

  const supabase = createServiceClient()

  // Resolve notification recipient
  const recipient = await resolveWidgetNotificationTarget(scope, ownerId)

  // Resolve agent_id (agents.id) for the notification target
  let agentId: string | null = null
  if (recipient?.user_id) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", recipient.user_id)
      .maybeSingle()
    agentId = agentRow?.id ?? null
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
    await supabase.from("notifications").insert({
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
  }

  return NextResponse.json({ ok: true, contactId })
}
