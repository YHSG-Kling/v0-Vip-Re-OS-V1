// ============================================================
// SYSTEM: L11-S03 — Tech Stack Setup Page
// VIP Real Estate AI OS — Layer 11
// ============================================================
// ROUTE: app/dashboard/onboarding/tech-stack/page.tsx

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getIntegrationStatus } from "@/app/actions/onboarding/tech-stack"
import { TechStackClient } from "./tech-stack-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = 'force-dynamic'

export const metadata = {
  title: "Tech Stack Setup | VIP Real Estate AI OS",
  description: "Configure your third-party integrations for SMS, email, e-signatures, and more",
}

export default async function TechStackPage() {
  const supabase = await createClient()

  // Verify session
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    redirect("/auth/login")
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user and brokerage info
  const { data: userData } = await supabase
    .from("users")
    .select("id, brokerage_id, first_name, last_name, email")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/dashboard")
  }

  // Get brokerage info
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("id, name")
    .eq("id", userData.brokerage_id)
    .single()

  // Get initial integration status
  const { data: integrationStatus } = await getIntegrationStatus(userData.brokerage_id)

  return (
    <TechStackClient
      userId={userData.id}
      brokerageId={userData.brokerage_id}
      brokerageName={brokerage?.name || ""}
      initialStatus={integrationStatus}
    />
  )
}
