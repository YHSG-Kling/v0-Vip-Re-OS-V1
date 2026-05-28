import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { DiagnosisClient } from "./diagnosis-client"

export const dynamic = "force-dynamic"

export default async function DiagnosisPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { agentId, brokerageId } = await getAgentContext()

  return <DiagnosisClient agentId={agentId ?? ""} brokerageId={brokerageId ?? ""} userId={user.id} />
}
