import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { createCallbackTask } from "@/lib/ai-isa/callback-task"

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Portal contacts are authenticated as contact users — allow unauthenticated too
  // (portal uses contactId from session context)

  const { contactId, requestType = "callback", lastMessage } = await request.json()
  if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 })

  const serviceClient = createServiceClient()

  // contacts.agent_id is agents.id — resolve the agent's users.id for the
  // notification target (the phantom assigned_agent_user_id select errored the
  // lookup, so portal "talk to a human" requests never reached any agent).
  const { data: contact } = await serviceClient
    .from("contacts")
    .select("first_name, last_name, agent_id, brokerage_id, phone")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: agentRow } = await serviceClient
      .from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    agentUserId = agentRow?.user_id ?? null
  }
  if (!agentUserId) return NextResponse.json({ ok: true, note: "No agent assigned" })

  const contactName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "A portal user"

  // THE DURABLE HALF — owner ruling (wave 55): "the ai assistant or
  // receptionist needs to be able to make a task to call a person back and
  // then do the call back when it is time." This button used to ONLY fire a
  // notification: if the assigned agent missed it (asleep, off-shift, phone
  // silenced), the portal contact who asked for a callback simply never got
  // one — nothing else was watching. createCallbackTask writes the SAME
  // durable `tasks` row the reception voice lane writes, so
  // /api/cron/ai-callback-dispatch places the call autonomously even if the
  // human notification goes unread. Best-effort: a missing phone number just
  // means there is nothing to dial — the human notification above still fires.
  if (contact.phone) {
    const callback = await createCallbackTask(serviceClient, {
      brokerageId: contact.brokerage_id,
      contactId,
      phone: contact.phone,
      whenPhrase: "as soon as possible",
      reason: "Requested a callback from their client portal",
      voiceCallId: null,
      assigneeType: "ai_isa",
      assignedToAgentId: contact.agent_id ?? null,
    })
    if (!callback.ok) {
      console.error("[portal/escalate] callback task write refused:", callback.error)
    }
  }

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
