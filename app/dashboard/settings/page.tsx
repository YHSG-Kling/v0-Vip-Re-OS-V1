import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  effectiveSeatLimit, parseSeatOverride, seatDecision, seatDecisionMessage, agentRoleAdvisory,
} from "@/lib/kernel/tier-role-matrix"
import { resolveSeatUsage } from "@/lib/kernel/seat-usage"
import { redirect } from "next/navigation"
import { SettingsControlOSClient } from "./settings-control-os-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = { title: "Settings | Control Center" }

export default async function SettingsControlOSPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, user_type, role, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Role gate: broker + admin only for full settings — user_type is canonical; role is legacy fallback
  const resolvedType = profile.user_type ?? profile.role ?? ""
  if (!["broker", "admin"].includes(resolvedType)) {
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
    brokerageRowRes,
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
      .select("id, role, user_type, status")
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
    
    // Brokerage tier + seat override — the seat meter's inputs
    service
      .from("brokerages")
      .select("plan_tier, billing_metadata")
      .eq("id", brokerageId)
      .maybeSingle(),

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
  const brokerageRow = (brokerageRowRes.data ?? null) as { plan_tier: string | null; billing_metadata: unknown } | null
  const notificationRules = notificationRulesRes.data || []
  const globalSettings = globalSettingsRes.data
  const commissionStructures = commissionStructuresRes.data || []
  const latestSync = accountingSyncRes.data?.[0]

  // Calculate provider health stats
  const healthyCount = integrations.filter((i) => i.status === "active").length
  const errorCount = integrations.filter((i) => i.status === "error").length
  const pendingCount = integrations.filter((i) => i.status === "pending" || i.status === "inactive").length

  // Calculate user stats
  // SEATS — the same math the user-management page shows and the invite gate
  // enforces, from the one source (tier-role-matrix). This panel used to report
  // `users.length` as both total and active, which counted PARTNERS (vendor,
  // lender), the `system` AI-ISA actor and SUSPENDED users as if they were seats,
  // and showed no limit at all. So an admin here saw a different number from the
  // one the users page showed for the same tenant, and neither told them what
  // their plan allows.
  // A seat is a PERSON. resolveSeatUsage counts distinct non-suspended users
  // holding a seat role by user_type OR by user_role_assignments — reading only
  // user_type under-counts, because a user may be ASSIGNED a seat role without
  // their primary type being one.
  const seatUsage = await resolveSeatUsage(service, brokerageId)
  const holderIds = new Set(seatUsage.seatHolderIds)
  const seatHolders = users.filter((u) => holderIds.has(u.id))
  const { limit: seatLimit, overridden: seatOverridden } =
    effectiveSeatLimit(brokerageRow?.plan_tier ?? null, parseSeatOverride(brokerageRow?.billing_metadata))

  // Over the limit is a BILLING CHOICE, not a wall (owner's ruling): the panel
  // names the upgrade first and the per-seat price second. And the agent-role
  // advisory — a workspace with seats but no Agent looks staffed and is inert,
  // because contacts, deals, listings and campaigns all attach to an agent.
  const seatDecisionForTenant = seatDecision(
    brokerageRow?.plan_tier ?? null,
    seatUsage.seatCount,
    parseSeatOverride(brokerageRow?.billing_metadata),
    0, // asking about the CURRENT state, not a new invite
  )
  const agentAdvisory = agentRoleAdvisory(seatUsage.rolesInUse)

  const userStats = {
    totalUsers: seatUsage.peopleCount,
    seatMessage: seatDecisionMessage(seatDecisionForTenant),
    upgradeTo: seatDecisionForTenant.upgradeTo,
    upgradeSeats: seatDecisionForTenant.upgradeSeats,
    additionalSeatMonthlyUsd: seatDecisionForTenant.additionalSeatMonthlyUsd,
    agentRoleAdvisory: agentAdvisory.advisory,
    // Seats, not headcount — partners and the system actor never consume one.
    seatCount: seatUsage.seatCount,
    seatLimit,
    seatOverridden,
    planTier: brokerageRow?.plan_tier ?? null,
    activeUsers: users.filter((u) => u.status !== "suspended").length,
    // Badges describe the seat holders' PRIMARY type; a user with several roles
    // still holds one seat, so these can sum to less than seatCount.
    adminCount: seatHolders.filter((u) => u.user_type === "admin").length,
    brokerCount: seatHolders.filter((u) => u.user_type === "broker" || u.user_type === "broker_owner").length,
    agentCount: seatHolders.filter((u) => u.user_type === "agent").length,
    coordinatorCount: seatHolders.filter((u) => u.user_type === "tc").length,
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
      isaSettings={{
        current: {
          isa_auto_respond_new_leads: (globalSettings?.additional_settings as any)?.isa_auto_respond_new_leads ?? false,
          isa_auto_respond_ghost_threshold_days: (globalSettings?.additional_settings as any)?.isa_auto_respond_ghost_threshold_days ?? 14,
          isa_require_admin_approval_before_send: (globalSettings?.additional_settings as any)?.isa_require_admin_approval_before_send ?? true,
          isa_auto_respond_hours: (globalSettings?.additional_settings as any)?.isa_auto_respond_hours ?? "8-20",
          isa_voice_provider: (globalSettings?.additional_settings as any)?.isa_voice_provider ?? "elevenlabs",
        },
        existing: (globalSettings?.additional_settings as Record<string, unknown>) ?? {},
      }}
    />
  )
}
