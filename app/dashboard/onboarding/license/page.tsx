// app/dashboard/onboarding/license/page.tsx
// ============================================================
// SYSTEM: L11-S01 — Agent License Intake Page (RSC)
// VIP Real Estate AI OS — Layer 11
// ============================================================

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getAgentLicenseStatus } from "@/app/actions/onboarding/license"
import { LicenseIntakeClient } from "./license-intake-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = 'force-dynamic'

export const metadata = {
  title: "License Intake | Agent Onboarding",
  description: "Complete your license verification and compliance requirements",
}

export default async function LicenseIntakePage() {
  const supabase = await createClient()

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
  // Get agent's brokerage
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/dashboard")
  }

  // Get initial status
  const { data: initialStatus, error } = await getAgentLicenseStatus(user.id)

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-destructive">Error Loading Onboarding</h1>
          <p className="mt-2 text-muted-foreground">{error}</p>
        </div>
      </div>
    )
  }

  // Get compliance checklist items
  const { data: complianceSteps } = await supabase
    .from("onboarding_steps")
    .select("id, step_key, step_name, instructions")
    .in("step_key", ["fair_housing_ack", "tcpa_ack", "mls_rules_ack", "brand_standards_ack"])
    .or(`brokerage_id.eq.${userData.brokerage_id},brokerage_id.is.null`)

  return (
    <LicenseIntakeClient
      userId={user.id}
      brokerageId={userData.brokerage_id}
      initialStatus={initialStatus}
      complianceSteps={complianceSteps || []}
    />
  )
}
