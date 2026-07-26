import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { AIToolsClient } from "./ai-tools-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "AI Toolkit" }

export default async function AIToolsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  
  // User is already known-authenticated (guard above); a context-resolution error
  // is a data problem, not a sign-in one → /dashboard (self-heals), never /login.
  let context: any = null
  try { context = await getAgentContext() } catch { redirect("/dashboard") }
  
  return (
    <AIToolsClient
      agentId={context.agentId}
      userId={user.id}
      userRole={context.userType || "agent"}
    />
  )
}
