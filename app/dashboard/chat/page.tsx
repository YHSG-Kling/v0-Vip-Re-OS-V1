import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { OfficeChatClient } from "./office-chat-client"

export const dynamic = "force-dynamic"

export default async function OfficeChatPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId, brokerageId, role } = await getAgentContext()

  // THE CONTACT PICKER USED TO BE A TEXT BOX THAT SET A NAME.
  // Relationship mode captured whatever was typed into `selectedContactName`
  // and never resolved a contacts.id, so the id handed to the generator was the
  // caller's users.id — a different id class, and "Contact not found" every
  // time. Real rows, so the session can be bound to a real contact.
  let contacts: { id: string; name: string }[] = []
  if (agentId && brokerageId) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .order("last_name", { ascending: true })
      .limit(200)
    if (error) {
      console.error("[OfficeChatPage] Contact list failed:", error.message)
    } else {
      contacts = (data ?? []).map((c) => ({
        id: c.id as string,
        name:
          `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() ||
          (c.email as string | null) ||
          "Unnamed contact",
      }))
    }
  }

  // Teammates a conversation can be shared with. message_access_control.user_id
  // is a users.id (getMessageAccessList resolves names out of `users`), so this
  // list is users — deliberately NOT agents, which is a different id space.
  let teammates: { id: string; name: string; userType: string }[] = []
  if (brokerageId) {
    const { data, error } = await supabase
      .from("users")
      .select("id, first_name, last_name, email, user_type")
      .eq("brokerage_id", brokerageId)
      .neq("id", user.id)
      .order("last_name", { ascending: true })
      .limit(200)
    if (error) {
      console.error("[OfficeChatPage] Teammate list failed:", error.message)
    } else {
      teammates = (data ?? []).map((u) => ({
        id: u.id as string,
        name:
          `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() ||
          (u.email as string | null) ||
          "Unnamed user",
        userType: (u.user_type as string | null) ?? "agent",
      }))
    }
  }

  return (
    <OfficeChatClient
      agentId={agentId ?? ""}
      brokerageId={brokerageId ?? ""}
      userId={user.id}
      userRole={role || 'agent'}
      contacts={contacts}
      teammates={teammates}
    />
  )
}
