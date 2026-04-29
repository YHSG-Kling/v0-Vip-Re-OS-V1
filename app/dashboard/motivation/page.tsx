import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { MotivationClient } from "./motivation-client"

export const dynamic = "force-dynamic"

export default async function MotivationPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { agentId, brokerageId } = await getAgentContext()

  return <MotivationClient agentId={agentId ?? ""} brokerageId={brokerageId ?? ""} userId={user.id} />
}
