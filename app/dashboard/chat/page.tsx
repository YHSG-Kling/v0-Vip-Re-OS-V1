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
  
  return (
    <OfficeChatClient
      agentId={agentId ?? ""}
      brokerageId={brokerageId ?? ""}
      userId={user.id}
      userRole={role || 'agent'}
    />
  )
}
