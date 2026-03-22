"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  PlatformOwnerCommandStrip,
  PlatformHealthRadar,
  BrokerageTenantPanel,
  BillingUsagePanel,
  AiAuditPanel,
  PlatformConfigPanel,
  IntegrationGovernancePanel,
  ErrorHandlerPanel,
  AuditOperationsPanel,
  ProviderIntelligencePanel,
} from "./components/os"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

interface PlatformOwnerOSClientProps {
  adminStats: AnyRecord
  systemHealth: AnyRecord
  billingMetrics: AnyRecord | null
  auditTrail: AnyRecord[]
  brokerages: AnyRecord[]
  integrations: AnyRecord[]
  automationErrors: AnyRecord[]
  aiAuditLog: AnyRecord[]
  currentUserId: string
}

export function PlatformOwnerOSClient({
  adminStats,
  systemHealth,
  billingMetrics,
  auditTrail,
  brokerages,
  integrations,
  automationErrors,
  aiAuditLog,
}: PlatformOwnerOSClientProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const [refreshKey, setRefreshKey] = useState(0)

  const handleRefresh = () => setRefreshKey((prev) => prev + 1)

  // Derive PlatformHealthRadar props from server data
  const healthyServices = systemHealth?.services?.filter(
    (s: AnyRecord) => s.current_status === "healthy"
  ).length ?? 0
  const degradedServices = systemHealth?.services?.filter(
    (s: AnyRecord) => s.current_status === "degraded" || s.current_status === "down"
  ).length ?? 0
  const criticalErrors = systemHealth?.criticalIssues?.length ?? 0

  // Derive AI approval rate from aiAuditLog
  const positiveCount = aiAuditLog.filter((l) => l.rating === "positive" || l.is_helpful === true).length
  const aiApprovalRate = aiAuditLog.length > 0 ? (positiveCount / aiAuditLog.length) * 100 : 100

  // Derive billing issues count
  const billingIssueCount = billingMetrics?.billingIssues?.length ?? 0

  // Derive BrokerageTenantPanel props
  const typedBrokerages = brokerages.map((b) => ({
    id: b.id,
    name: b.name || "Unnamed Brokerage",
    city: b.city ?? null,
    state: b.state ?? null,
    agent_count: b.agent_count ?? 0,
    subscription_status: b.subscription_status ?? null,
    has_billing_issue: !!b.has_billing_issue,
  }))

  // Derive IntegrationGovernancePanel props
  const typedIntegrations = integrations.slice(0, 10).map((i) => ({
    id: i.id,
    providerType: i.provider_type ?? "unknown",
    providerName: i.provider_name ?? i.provider_type ?? "Unknown",
    status: (["active", "error", "pending", "disconnected"].includes(i.status) ? i.status : "disconnected") as
      | "active"
      | "error"
      | "pending"
      | "disconnected",
    brokerageCount: i.brokerage_count ?? 1,
    lastError: i.last_error ?? null,
  }))
  const activeIntegrations = typedIntegrations.filter((i) => i.status === "active").length
  const errorIntegrations = typedIntegrations.filter((i) => i.status === "error").length

  // Derive ErrorHandlerPanel props
  const openErrors = automationErrors.filter((e) => e.status !== "resolved" && e.resolved !== true)
  const criticalErrorsList = openErrors.filter((e) => e.severity === "critical")
  const resolvedToday = automationErrors.filter((e) => {
    if (!e.resolved_at) return false
    return new Date(e.resolved_at).toDateString() === new Date().toDateString()
  }).length
  const typedErrors = openErrors.slice(0, 5).map((e) => ({
    id: e.id,
    workflowName: e.workflow_name ?? "Unknown Workflow",
    errorMessage: e.error_message ?? "Unknown error",
    severity: (["critical", "high", "medium", "low"].includes(e.severity) ? e.severity : "low") as
      | "critical"
      | "high"
      | "medium"
      | "low",
    status: (["open", "investigating", "resolved"].includes(e.status) ? e.status : "open") as
      | "open"
      | "investigating"
      | "resolved",
    createdAt: e.created_at ?? new Date().toISOString(),
    brokerageName: e.brokerage_name,
  }))

  // Derive AiAuditPanel props
  const negativeCount = aiAuditLog.length - positiveCount
  const topNegativeThemes = aiAuditLog
    .filter((l) => l.rating === "negative" || l.is_helpful === false)
    .map((l) => l.theme ?? l.feedback_type ?? "")
    .filter(Boolean)
    .slice(0, 3)
  const feedbackSummary = {
    totalFeedback: aiAuditLog.length,
    positiveCount,
    negativeCount,
    approvalRate: aiApprovalRate,
    topNegativeThemes,
    improvementApplied: false,
  }

  // Derive AuditOperationsPanel props
  const todayAudits = auditTrail.filter(
    (a) => new Date(a.created_at ?? a.timestamp ?? 0).toDateString() === new Date().toDateString()
  )
  const sensitiveActions = auditTrail.filter((a) =>
    ["delete", "remove", "revoke", "suspend"].some((keyword) =>
      (a.action ?? "").toLowerCase().includes(keyword)
    )
  ).length
  const typedAudits = auditTrail.slice(0, 10).map((a) => ({
    id: a.id,
    action: a.action ?? a.event_type ?? "unknown",
    entityType: a.entity_type ?? a.resource_type ?? "unknown",
    entityId: a.entity_id ?? a.resource_id ?? "",
    userId: a.user_id ?? "",
    userName: a.user_name ?? a.actor_name,
    createdAt: a.created_at ?? a.timestamp ?? new Date().toISOString(),
  }))

  // PlatformConfigPanel props
  const platformConfig = {
    aiEnabled: true,
    emergencyMode: false,
    globalRateLimitPerMinute: 1000,
  }

  return (
    <div className="flex flex-col gap-8" key={refreshKey}>
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Platform Owner Control Center</h1>
        <p className="text-muted-foreground max-w-2xl">
          Monitor platform health, manage tenants, control integrations, audit AI quality, and oversee system operations
        </p>
      </div>

      {/* Command Strip */}
      <PlatformOwnerCommandStrip onRefresh={handleRefresh} />

      {/* Health Radar */}
      <PlatformHealthRadar
        activeBrokerages={brokerages.length}
        totalUsers={adminStats?.userCount ?? 0}
        criticalErrors={criticalErrors}
        healthyServices={healthyServices}
        degradedServices={degradedServices}
        pendingBillingIssues={billingIssueCount}
        aiApprovalRate={aiApprovalRate}
        lastCheckedAt={systemHealth?.lastCheckedAt ?? null}
      />

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="ai-audit">AI Audit</TabsTrigger>
          <TabsTrigger value="operations">Operations</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <PlatformConfigPanel config={platformConfig} featureFlags={[]} />
            <IntegrationGovernancePanel
              integrations={typedIntegrations}
              totalIntegrations={integrations.length}
              activeCount={activeIntegrations}
              errorCount={errorIntegrations}
            />
          </div>
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2">
              <ErrorHandlerPanel
                errors={typedErrors}
                criticalCount={criticalErrorsList.length}
                openCount={openErrors.length}
                resolvedToday={resolvedToday}
              />
            </div>
            <ProviderIntelligencePanel />
          </div>
        </TabsContent>

        {/* Tenants Tab */}
        <TabsContent value="tenants" className="space-y-6">
          <BrokerageTenantPanel
            brokerages={typedBrokerages}
            totalCount={brokerages.length}
          />
        </TabsContent>

        {/* Billing Tab */}
        <TabsContent value="billing" className="space-y-6">
          <BillingUsagePanel
            billingIssues={billingMetrics?.billingIssues ?? []}
            usageSummary={billingMetrics?.usageSummary ?? {
              totalAiCalls: 0,
              totalVideoMinutes: 0,
              totalStorageGb: 0,
              periodLabel: "This month",
            }}
            totalMrr={billingMetrics?.totalMrr ?? 0}
          />
        </TabsContent>

        {/* AI Audit Tab */}
        <TabsContent value="ai-audit" className="space-y-6">
          <AiAuditPanel feedbackSummary={feedbackSummary} weeklyTrend={0} />
        </TabsContent>

        {/* Operations Tab */}
        <TabsContent value="operations" className="space-y-6">
          <AuditOperationsPanel
            recentAudits={typedAudits}
            totalToday={todayAudits.length}
            sensitiveActions={sensitiveActions}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
