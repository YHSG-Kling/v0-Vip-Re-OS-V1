import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAIIdentityProfile } from "@/app/actions/ai-identity"
import { AICallSetupClient } from "./AICallSetupClient"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Call Handling Setup | Onboarding",
}

export default async function AICallSetupPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id || !["broker", "admin", "superadmin"].includes(profile.user_type ?? "")) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id

  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name")
    .eq("id", brokerageId)
    .maybeSingle()

  const { data: existingProfile } = await getAIIdentityProfile("brokerage", brokerageId)

  return (
    <AICallSetupClient
      brokerageId={brokerageId}
      brokerageName={brokerage?.name ?? ""}
      existingProfile={existingProfile}
    />
  )
}
