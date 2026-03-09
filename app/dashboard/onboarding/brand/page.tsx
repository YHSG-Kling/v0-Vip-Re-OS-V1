// ============================================================
// SYSTEM: L11-S02 — Brand Setup Wizard Page
// VIP Real Estate AI OS — Layer 11
// ============================================================
// ROUTE: app/dashboard/onboarding/brand/page.tsx

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getBrandSetupStatus } from "@/app/actions/onboarding/brand"
import { BrandSetupClient } from "./brand-setup-client"

export const metadata = {
  title: "Brand Setup | VIP Real Estate AI OS",
  description: "Configure your brand colors, typography, voice, and templates",
}

export default async function BrandSetupPage() {
  const supabase = await createClient()

  // Verify session
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    redirect("/auth/login")
  }

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
    .select("id, name, phone, email, website")
    .eq("id", userData.brokerage_id)
    .single()

  // Get initial brand setup status
  const { data: brandStatus } = await getBrandSetupStatus(userData.brokerage_id)

  return (
    <BrandSetupClient
      userId={userData.id}
      brokerageId={userData.brokerage_id}
      brokerageName={brokerage?.name || ""}
      brokeragePhone={brokerage?.phone || ""}
      brokerageEmail={brokerage?.email || ""}
      agentName={`${userData.first_name || ""} ${userData.last_name || ""}`.trim()}
      agentEmail={userData.email || ""}
      initialStatus={brandStatus}
    />
  )
}
