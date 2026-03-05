"use client"

import { useState } from "react"
import KPIBar from "./components/KPIBar"
import HealthTab from "./components/HealthTab"
import AuditFlagsTab from "./components/AuditFlagsTab"
import InsightsTab from "./components/InsightsTab"

type Tab = "health" | "audit" | "insights"

interface IntelligenceClientProps {
  kpi: {
    avgHealthScore: number
    pendingFlagsToday: number
    fairHousingPending: number
    escalationsLast7Days: number
  }
  chartData: { date: string; text_score: number; voice_score: number }[]
  healthInsights: Parameters<typeof HealthTab>[0]["insights"]
  auditFlags: Parameters<typeof AuditFlagsTab>[0]["flags"]
  insightRecords: Parameters<typeof InsightsTab>[0]["insights"]
  userId: string
}

const TABS: { id: Tab; label: string }[] = [
  { id: "health",   label: "Conversation Health" },
  { id: "audit",    label: "Audit Flags" },
  { id: "insights", label: "Insights" },
]

export default function IntelligenceClient({
  kpi,
  chartData,
  healthInsights,
  auditFlags,
  insightRecords,
  userId,
}: IntelligenceClientProps) {
  const [activeTab, setActiveTab] = useState<Tab>("health")

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-7xl mx-auto">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Communication Intelligence</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Health scores, audit flags, and conversation insights across all channels.
        </p>
      </div>

      {/* KPI Bar */}
      <KPIBar {...kpi} />

      {/* Tab Nav */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.id === "audit" && auditFlags.filter(f => f.review_status === "pending").length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center h-4 w-4 rounded-full bg-red-500 text-white text-[10px] font-bold">
                {auditFlags.filter(f => f.review_status === "pending").length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "health" && (
          <HealthTab chartData={chartData} insights={healthInsights} />
        )}
        {activeTab === "audit" && (
          <AuditFlagsTab flags={auditFlags} reviewerId={userId} />
        )}
        {activeTab === "insights" && (
          <InsightsTab insights={insightRecords} />
        )}
      </div>
    </div>
  )
}
