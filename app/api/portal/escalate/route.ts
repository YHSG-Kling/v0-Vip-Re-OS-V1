import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Portal contacts are authenticated as contact users — allow unauthenticated too
  // (portal uses contactId from session context)

  const { contactId, requestType = "callback", lastMessage } = await request.json()
  if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 })

  const serviceClient = createServiceClient()

  const { data: contact } = await serviceClient
    .from("contacts")
    .select("first_name, last_name, assigned_agent_user_id, brokerage_id, phone")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  const agentUserId = contact.assigned_agent_user_id
  if (!agentUserId) return NextResponse.json({ ok: true, note: "No agent assigned" })

  const contactName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "A portal user"

  await serviceClient.from("notifications").insert({
    user_id: agentUserId,
    brokerage_id: contact.brokerage_id,
    type: "portal_live_agent_request",
    entity_type: "contact",
    entity_id: contactId,
    title: `${contactName} is requesting to speak with you`,
    body: [
      `Contact requested a callback via portal.`,
      contact.phone ? `Phone: ${contact.phone}.` : null,
      lastMessage ? `Last message: "${String(lastMessage).substring(0, 150)}"` : null,
    ].filter(Boolean).join(" "),
    priority: "high",
    is_read: false,
  })

  return NextResponse.json({ ok: true })
}
