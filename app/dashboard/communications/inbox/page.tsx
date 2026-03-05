import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getConversations } from "@/app/actions/ai-communication-hub"
import InboxClient from "./InboxClient"

export const metadata = {
  title: "Inbox | VIP Real Estate OS",
  description: "Unified communications inbox",
}

export default async function InboxPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Resolve user profile → brokerageId, agentId, assistant_wake_name
  const service = createServiceClient()

  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type, assistant_wake_name")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/onboarding")

  const brokerageId: string = profile.brokerage_id
  const assistantName: string = profile.assistant_wake_name ?? "VIP"

  // Resolve agentId (agents table keyed by user_id)
  const { data: agentRow } = await service
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  const agentId: string = agentRow?.id ?? user.id

  // Fetch conversations server-side
  const result = await getConversations({ brokerageId, limit: 50 })
  const conversations = result.success ? (result as any).conversations ?? [] : []

  return (
    <InboxClient
      conversations={conversations}
      brokerageId={brokerageId}
      agentId={agentId}
      userId={user.id}
      assistantName={assistantName}
    />
  )
}
