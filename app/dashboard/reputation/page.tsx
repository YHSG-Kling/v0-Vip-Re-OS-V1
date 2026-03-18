import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { ReputationClient } from "./reputation-client"

export const dynamic = "force-dynamic"

export default async function ReputationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId, brokerageId } = await getAgentContext()

  const [{ data: reviews }, { data: recentClosings }] = await Promise.all([
    supabase.from("agent_reviews").select("*")
      .eq("agent_id", agentId).order("created_at", { ascending: false }).limit(20),
    supabase.from("transactions")
      .select("id, property_address, close_date, contact_id, contacts(id, first_name, last_name, email, phone)")
      .eq("agent_id", agentId).eq("status", "closed")
      .gte("close_date", new Date(Date.now() - 90*24*60*60*1000).toISOString().split('T')[0])
      .order("close_date", { ascending: false }).limit(10),
  ])

  return (
    <ReputationClient
      agentId={agentId}
      brokerageId={brokerageId}
      userId={user.id}
      reviews={reviews || []}
      recentClosings={recentClosings || []}
    />
  )
}
