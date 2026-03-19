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
          }))}
          onTestProvider={handleTestProvider}
          onReconnectProvider={handleReconnectProvider}
        />

        {/* Maintenance Tasks */}
        <SettingsBatchMaintenancePanel onRunTask={handleRunTask} />
      </div>
    </div>
  )
}
