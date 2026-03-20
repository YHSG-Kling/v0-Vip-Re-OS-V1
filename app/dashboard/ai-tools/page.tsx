import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { AIToolsClient } from "./ai-tools-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "AI Toolkit | VIP Real Estate OS" }

export default async function AIToolsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  
  let context: any = null
  try { context = await getAgentContext() } catch { redirect("/login") }
  
  return (
    <AIToolsClient
      agentId={context.agentId}
      userId={user.id}
      userRole={context.role || "agent"}
    />
  )
}
