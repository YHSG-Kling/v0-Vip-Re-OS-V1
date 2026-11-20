import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { TemplateFormClient } from "../template-form-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "New Video Template | Dashboard",
}

export default async function NewVideoTemplatePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id || !agentRow?.id) redirect("/dashboard/videos")

  return (
    <div className="container mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">New Video Template</h1>
        <p className="text-muted-foreground mt-1">Create a reusable script template for your team</p>
      </div>
      <TemplateFormClient
        brokerageId={userData.brokerage_id}
        agentId={agentRow.id}
        userType={userData.user_type ?? "agent"}
      />
    </div>
  )
}
