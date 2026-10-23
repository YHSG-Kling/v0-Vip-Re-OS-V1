import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { AIToolsClient } from "./ai-tools-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "AI Toolkit" }

export default async function AIToolsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  
  // Heal an incomplete account IN PLACE — don't bounce off the AI Toolkit page.
  const context = await ensureAgentContextInPlace()

  // Heal genuinely couldn't complete (pending invite / non-agent) — honest in-place
  // notice instead of the page failing to load.
  if (!context.agentId) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Finishing your account setup — refresh in a moment to open the AI Toolkit.
      </div>
    )
  }

  return (
    <AIToolsClient
      agentId={context.agentId}
      userId={user.id}
      userRole={context.userType || "agent"}
    />
  )
}
