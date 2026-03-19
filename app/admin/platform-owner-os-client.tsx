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
} from "./components/os"

interface PlatformOwnerOSClientProps {
  adminStats: any
  systemHealth: any
  billingMetrics: any
  auditTrail: any[]
  brokerages: any[]
  integrations: any[]
  automationErrors: any[]
  aiAuditLog: any[]
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
  currentUserId,
}: PlatformOwnerOSClientProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const [selectedBrokerage, setSelectedBrokerage] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const handleRefresh = () => setRefreshKey(prev => prev + 1)

  return (
    <div className="flex flex-col gap-8">
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
        systemHealth={systemHealth}
        brokerageCount={brokerages.length}
        errorCount={automationErrors.length}
        auditEventCount={auditTrail.length}
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
            <PlatformConfigPanel />
            <IntegrationGovernancePanel integrations={integrations} />
          </div>
          <ErrorHandlerPanel errors={automationErrors} />
        </TabsContent>

        {/* Tenants Tab */}
        <TabsContent value="tenants" className="space-y-6">
          <BrokerageTenantPanel
            brokerages={brokerages}
            selectedId={selectedBrokerage}
            onSelect={setSelectedBrokerage}
          />
        </TabsContent>

        {/* Billing Tab */}
        <TabsContent value="billing" className="space-y-6">
          <BillingUsagePanel metrics={billingMetrics} brokerages={brokerages} />
        </TabsContent>

        {/* AI Audit Tab */}
        <TabsContent value="ai-audit" className="space-y-6">
          <AiAuditPanel aiAuditLog={aiAuditLog} />
        </TabsContent>

        {/* Operations Tab */}
        <TabsContent value="operations" className="space-y-6">
          <AuditOperationsPanel auditTrail={auditTrail} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
