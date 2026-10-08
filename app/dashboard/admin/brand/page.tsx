import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { getBrandTemplateStatisticsAction } from "@/app/actions/brand-template-registry"
import { BrandComplianceClient } from "./brand-client"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Brand & Compliance OS",
  description: "Manage brand voice, template library, and compliance history",
}

export default async function BrandCompliancePage() {
  const context = await getAgentContext()

  if (!context?.brokerageId) redirect("/login")
  // Lane 89D: same defect as /dashboard/brokerage/intelligence — two live
  // spellings plus a dead 'superadmin' arm, so broker_owner / broker_admin /
  // compliance_officer (the officer "is the one that deals with marketing",
  // owner ruling in app/config/navigation-config.ts) were bounced from the
  // brand & compliance surface the admin sidebar links. ONE roster predicate.
  if (!isAdminOrBroker({ user_type: context.userType })) {
    return (
      <RoleGateNotice
        surface="Brand & Compliance"
        audience="your broker, brokerage admins, team leads and compliance officer"
      />
    )
  }

  const supabase = await createClient()
  const brokerageId = context.brokerageId

  const [
    { data: templates },
    { data: voiceProfile },
    statsResult,
    { data: complianceHistory },
  ] = await Promise.all([
    supabase
      .from("brand_templates")
      .select("id, template_name, template_type, content_html, is_active, created_at")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false }),

    supabase
      .from("brand_voice_profile")
      .select("id, tone, formality_level, key_brand_messages, prohibited_words, preferred_words, is_active, tagline, mission_statement, updated_at")
      .eq("brokerage_id", brokerageId)
      .maybeSingle(),

    getBrandTemplateStatisticsAction(),

    // Compliance history from activities table — brand compliance logs written via logBrandCompliance
    supabase
      .from("activities")
      .select("id, title, activity_type, status, created_at, agent_id")
      .eq("brokerage_id", brokerageId)
      .ilike("activity_type", "%brand%")
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  return (
    <BrandComplianceClient
      brokerageId={brokerageId}
      templates={templates ?? []}
      voiceProfile={voiceProfile ?? null}
      stats={statsResult.success ? statsResult.data ?? null : null}
      complianceHistory={complianceHistory ?? []}
    />
  )
}
