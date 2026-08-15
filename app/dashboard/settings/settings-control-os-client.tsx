"use client"

import {
  SettingsCommandStrip,
  ProviderHealthRadar,
  SetupCompletenessPanel,
  BrandingOutputPanel,
  AccountingCommissionPanel,
  UserAccessPanel,
  NotificationDefaultsPanel,
  ProviderActionPanel,
  SettingsBatchMaintenancePanel,
} from "./components/os"
import { IsaAutoRespondSettings } from "@/app/components/isa/IsaAutoRespondSettings"
import { VoiceAccessSettings } from "@/app/components/settings/VoiceAccessSettings"
import { LeadRoutingPanel } from "./components/lead-routing-panel"
import { ShowingFinancialGatePanel } from "./components/showing-financial-gate-panel"
import { ProhibitedPhrasesPanel } from "./components/prohibited-phrases-panel"

interface ProviderData {
  id: string
  providerName: string
  providerType: string
  status: "active" | "error" | "inactive" | "pending"
  lastError?: string | null
  lastHealthCheckAt?: string | null
}

interface SetupItem {
  key: string
  label: string
  completed: boolean
  href: string
  priority: "high" | "medium" | "low"
}

interface UserStats {
  totalUsers: number
  /** Plan SEATS in use — partners and the system actor never consume one. */
  seatCount: number
  seatLimit: number | null
  seatOverridden: boolean
  planTier: string | null
  activeUsers: number
  adminCount: number
  brokerCount: number
  agentCount: number
  coordinatorCount: number
}

interface NotificationSettings {
  emailEnabled: boolean
  smsEnabled: boolean
  pushEnabled: boolean
  activeRulesCount: number
  totalRulesCount: number
}

interface BrandingData {
  logoUrl?: string | null
  primaryColor?: string | null
  accentColor?: string | null
  tagline?: string | null
  emailSignatureHtml?: string | null
  letterheadHtml?: string | null
  wizardCompleted: boolean
}

interface AccountingStatus {
  quickbooksConnected: boolean
  xeroConnected: boolean
  lastSyncAt?: string | null
  syncErrors: number
}

interface CommissionSettings {
  defaultSplitPct: number
  capAmount?: number | null
  hasStructures: boolean
  structureCount: number
}

interface SettingsControlOSClientProps {
  providers: ProviderData[]
  totalIntegrations: number
  healthyCount: number
  errorCount: number
  pendingCount: number
  setupItems: SetupItem[]
  completionPct: number
  userStats: UserStats
  notificationSettings: NotificationSettings
  brandingData: BrandingData
  accountingStatus: AccountingStatus
  commissionSettings: CommissionSettings
  brokerageId: string
  isaSettings: {
    current: Record<string, unknown>
    existing: Record<string, unknown>
  }
}

export function SettingsControlOSClient({
  providers,
  totalIntegrations,
  healthyCount,
  errorCount,
  pendingCount,
  setupItems,
  completionPct,
  userStats,
  notificationSettings,
  brandingData,
  accountingStatus,
  commissionSettings,
  brokerageId,
  isaSettings,
}: SettingsControlOSClientProps) {
  // Provider test action (placeholder - would call real action)
  const handleTestProvider = async (providerId: string) => {
    // In production, this would call a real server action
    return { success: true }
  }

  // Provider reconnect action (placeholder - would call real action)
  const handleReconnectProvider = async (providerId: string) => {
    // In production, this would call a real server action
    return { success: true }
  }

  // Maintenance task action (placeholder - would call real action)
  const handleRunTask = async (taskKey: string) => {
    // In production, this would call a real server action
    return { success: true }
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings Control Center</h1>
        <p className="text-muted-foreground mt-1">
          Configure your brokerage operations from one command center
        </p>
      </div>

      {/* Command Strip */}
      <SettingsCommandStrip />

      {/* Main Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Setup Completeness - Full width on mobile */}
        <div className="md:col-span-2 lg:col-span-1">
          <SetupCompletenessPanel items={setupItems} completionPct={completionPct} />
        </div>

        {/* Provider Health */}
        <ProviderHealthRadar
          providers={providers.map((p) => ({
            id: p.id,
            provider_name: p.providerName,
            provider_type: p.providerType,
            status: p.status,
            last_error: p.lastError,
            last_health_check_at: p.lastHealthCheckAt,
          }))}
          totalIntegrations={totalIntegrations}
          healthyCount={healthyCount}
          errorCount={errorCount}
          pendingCount={pendingCount}
        />

        {/* User Access */}
        <UserAccessPanel stats={userStats} />

        {/* Branding */}
        <BrandingOutputPanel branding={brandingData} />

        {/* Accounting & Commission */}
        <AccountingCommissionPanel
          accounting={accountingStatus}
          commission={commissionSettings}
        />

        {/* Notifications */}
        <NotificationDefaultsPanel settings={notificationSettings} />

        {/* Provider Actions */}
        <ProviderActionPanel
          providers={providers.map((p) => ({
            id: p.id,
            providerName: p.providerName,
            providerType: p.providerType,
            status: p.status,
            lastError: p.lastError,
          })) as any}
          onTestProvider={handleTestProvider}
          onReconnectProvider={handleReconnectProvider}
        />

        {/* Maintenance Tasks */}
        <SettingsBatchMaintenancePanel onRunTask={handleRunTask} />

        {/* AI-ISA Auto-Response Settings */}
        <IsaAutoRespondSettings
          brokerageId={brokerageId}
          currentSettings={isaSettings.current as any}
          existingAdditionalSettings={isaSettings.existing}
        />

        {/* Voice Assistant Access — management-controlled staff expansion */}
        <VoiceAccessSettings />

        {/* Lead Routing — the DEFAULT assignment method (m305). Per-rule methods
            live on the assignment-rules page; this is the one that decides every
            contact no rule matches, which is most of them, and it used to be
            hardcoded. Broker + admin only, which is already this page's gate. */}
        <LeadRoutingPanel />

        {/* Showing Requirements — whether the buyer financial gate applies before
            a showing is set or scheduled (m377). Off for every brokerage until a
            broker turns it on here; the engine that enforces it was already built
            and, until m377, ran on no path at all. Broker + admin only, which is
            already this page's gate. */}
        <ShowingFinancialGatePanel />

        {/* Prohibited Words — the brokerage's OWN additions to the federal Fair
            Housing catalogue (m454 added prohibited_phrases.brokerage_id; NULL is
            the platform list, a set id is a tenant's own words). The federal rows
            are listed read-only because RLS refuses a tenant write against them.
            Two columns wide: it carries a list and a form, not a single control.
            The same panel also renders on /compliance/settings, which is where the
            settings command strip's "Compliance" button goes and the only such
            surface a COMPLIANCE OFFICER can reach — this page is broker + admin
            only, while RLS grants phrase writes to is_compliance_officer_role()
            as well. */}
        <div className="md:col-span-2">
          <ProhibitedPhrasesPanel />
        </div>
      </div>
    </div>
  )
}
