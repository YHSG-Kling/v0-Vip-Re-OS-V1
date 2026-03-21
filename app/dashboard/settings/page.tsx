import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import { SettingsControlOSClient } from "./settings-control-os-client"

export const metadata = { title: "Settings | Control Center" }

export default async function SettingsControlOSPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")
  
  // Role gate: broker + admin only for full settings
  if (!["broker", "admin"].includes(profile.role ?? "")) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id

  // Fetch all settings data in parallel
  const [
    integrationRes,
    brandingRes,
    usersRes,
    notificationRulesRes,
    globalSettingsRes,
    commissionStructuresRes,
    accountingSyncRes,
  ] = await Promise.all([
    // Integrations/Providers
    service
      .from("brokerage_integrations")
      .select("id, provider_name, provider_type, status, last_error, last_health_check_at")
      .eq("brokerage_id", brokerageId),
    
    // Branding
    service
      .from("brokerage_brand_settings")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .maybeSingle(),
    
    // Users
    service
      .from("users")
      .select("id, role, user_type")
      .eq("brokerage_id", brokerageId),
    
    // Notification Rules
    service
      .from("notification_rules")
      .select("id, is_active")
      .eq("brokerage_id", brokerageId),
    
    // Global Settings
    service
      .from("global_settings")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .maybeSingle(),
    
    // Commission Structures
    service
      .from("commission_structures")
      .select("id, is_active, base_percentage")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true),
    
    // Accounting Sync Log (latest)
    service
      .from("accounting_sync_log")
      .select("id, provider, status, completed_at")
      .eq("brokerage_id", brokerageId)
      .order("completed_at", { ascending: false })
      .limit(1),
  ])

  const integrations = integrationRes.data || []
  const branding = brandingRes.data
  const users = usersRes.data || []
  const notificationRules = notificationRulesRes.data || []
  const globalSettings = globalSettingsRes.data
  const commissionStructures = commissionStructuresRes.data || []
  const latestSync = accountingSyncRes.data?.[0]

  // Calculate provider health stats
  const healthyCount = integrations.filter((i) => i.status === "active").length
  const errorCount = integrations.filter((i) => i.status === "error").length
  const pendingCount = integrations.filter((i) => i.status === "pending" || i.status === "inactive").length

  // Calculate user stats
  const userStats = {
    totalUsers: users.length,
    activeUsers: users.length, // All fetched users are active (no deleted_at filter)
    adminCount: users.filter((u) => u.role === "admin").length,
    brokerCount: users.filter((u) => u.role === "broker").length,
    agentCount: users.filter((u) => u.role === "agent" || u.user_type === "agent").length,
    coordinatorCount: users.filter((u) => u.role === "coordinator" || u.user_type === "coordinator").length,
  }

  // Calculate setup completeness
  const setupItems = [
    { key: "branding", label: "Branding configured", completed: !!branding?.wizard_completed_at, href: "/settings/branding", priority: "high" as const },
    { key: "integrations", label: "Email provider set", completed: integrations.some((i) => i.provider_type === "email"), href: "/settings/providers", priority: "high" as const },
    { key: "sms", label: "SMS provider set", completed: integrations.some((i) => i.provider_type === "sms"), href: "/settings/providers", priority: "medium" as const },
    { key: "accounting", label: "Accounting connected", completed: !!latestSync, href: "/settings/accounting", priority: "medium" as const },
    { key: "notifications", label: "Notification rules configured", completed: notificationRules.length > 0, href: "/settings/notifications", priority: "low" as const },
    { key: "commission", label: "Commission structures set", completed: commissionStructures.length > 0, href: "/settings/commission", priority: "high" as const },
  ]
  const completionPct = Math.round((setupItems.filter((i) => i.completed).length / setupItems.length) * 100)

  // Notification settings
  const notificationSettings = {
    emailEnabled: globalSettings?.email_notifications_enabled ?? true,
    smsEnabled: globalSettings?.sms_notifications_enabled ?? false,
    pushEnabled: globalSettings?.push_notifications_enabled ?? false,
    activeRulesCount: notificationRules.filter((r) => r.is_active).length,
    totalRulesCount: notificationRules.length,
  }

  // Branding data
  const brandingData = {
    logoUrl: branding?.app_logo_url ?? globalSettings?.app_logo_url,
    primaryColor: branding?.primary_color ?? globalSettings?.primary_color,
    accentColor: branding?.accent_color ?? globalSettings?.secondary_color,
    tagline: branding?.tagline,
    emailSignatureHtml: branding?.email_signature_html,
    letterheadHtml: branding?.letterhead_html,
    wizardCompleted: !!branding?.wizard_completed_at,
  }

  // Accounting status
  const accountingStatus = {
    quickbooksConnected: integrations.some((i) => i.provider_name === "quickbooks" && i.status === "active"),
    xeroConnected: integrations.some((i) => i.provider_name === "xero" && i.status === "active"),
    lastSyncAt: latestSync?.completed_at,
    syncErrors: 0, // Would need to query sync_errors table for actual count
  }

  // Commission settings
  const commissionSettings = {
    defaultSplitPct: commissionStructures[0]?.base_percentage ?? 70,
    capAmount: null, // Would come from agent_cap_tracking or commission_structures
    hasStructures: commissionStructures.length > 0,
    structureCount: commissionStructures.length,
  }

  return (
    <SettingsControlOSClient
      providers={integrations.map((i) => ({
        id: i.id,
        providerName: i.provider_name,
        providerType: i.provider_type,
        status: i.status as "active" | "error" | "inactive" | "pending",
        lastError: i.last_error,
        lastHealthCheckAt: i.last_health_check_at,
      }))}
      totalIntegrations={integrations.length}
      healthyCount={healthyCount}
      errorCount={errorCount}
      pendingCount={pendingCount}
      setupItems={setupItems}
      completionPct={completionPct}
      userStats={userStats}
      notificationSettings={notificationSettings}
      brandingData={brandingData}
      accountingStatus={accountingStatus}
      commissionSettings={commissionSettings}
      brokerageId={brokerageId}
    />
  )
}
