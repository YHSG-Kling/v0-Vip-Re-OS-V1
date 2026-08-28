"use client"

import { useState } from "react"
import KPIBar from "./components/KPIBar"
import HealthTab from "./components/HealthTab"
import ComplianceTab from "./components/ComplianceTab"
import type { ReviewContact } from "./components/FairHousingReviewCard"
import CoachingTab from "./components/CoachingTab"
import VoiceTab from "./components/VoiceTab"

type Tab = "health" | "compliance" | "coaching" | "voice"

interface AuditFlag {
  id: string
  conversation_id: string
  risk_type: string
  risk_score: number
  explanation: string
  flagged_text: string | null
  recommended_action: string | null
  review_status: string
  created_at: string
  conversation?: {
    contact_id: string | null
    agent_id: string | null
    start_time: string | null
    topics_discussed: string[] | null
  } | null
}

interface AgentInsight {
  agent_id: string
  agent_name: string
  avg_sentiment_score: number
  avg_health_score: number
  objections_raised: string[]
  buying_signals: string[]
  response_time_avg_seconds: number | null
  conversation_count: number
}

interface VoiceInsight {
  id: string
  conversation_id: string
  contact_name: string
  agent_name: string
  voice_quality_score: number | null
  interruption_count: number | null
  silence_duration_seconds: number | null
  call_completion_status: string | null
  overall_sentiment: string | null
  /** voice_calls.id — the key the authenticated playback proxy takes. Distinct
   *  from `id`, which is the conversation_insights row. */
  voice_call_id: string | null
  recording_url: string | null
  transcript: string | null
  updated_at: string
}

interface IntelligenceClientProps {
  kpi: {
    avgHealthScore: number
    pendingFlagsToday: number
    fairHousingPending: number
    escalationsLast7Days: number
  }
  chartData: { date: string; text_score: number; voice_score: number }[]
  healthInsights: {
    id: string
    contact_name: string
    agent_name: string
    overall_sentiment: string
    trajectory: string
    health_score: number
    response_time_avg: number | null
    unanswered_questions_count: number
    escalation_recommended: boolean
    updated_at: string
  }[]
  auditFlags: AuditFlag[]
  agentInsights: AgentInsight[]
  teamAvgResponseTime: number
  topicFrequency: { topic: string; count: number }[]
  voiceInsights: VoiceInsight[]
  userId: string
  /** Contact picker for the Fair-Housing Review card (Risk & Compliance tab). */
  reviewContacts: ReviewContact[]
}

const TABS: { id: Tab; label: string }[] = [
  { id: "health",     label: "Conversation Health" },
  { id: "compliance", label: "Risk & Compliance" },
  { id: "coaching",   label: "Coaching Insights" },
  { id: "voice",      label: "Voice Call Analysis" },
]

export default function IntelligenceClient({
  kpi,
  chartData,
  healthInsights,
  auditFlags,
  agentInsights,
  teamAvgResponseTime,
  topicFrequency,
  voiceInsights,
  userId,
  reviewContacts,
}: IntelligenceClientProps) {
  const [activeTab, setActiveTab] = useState<Tab>("health")

  const pendingFlagCount = auditFlags.filter(f => f.review_status === "pending").length

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-screen-2xl mx-auto">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Communication Intelligence</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Health scores, compliance flags, coaching insights, and voice call analysis.
        </p>
      </div>

      {/* KPI Bar */}
      <KPIBar {...kpi} />

      {/* Tab Nav */}
      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.id === "compliance" && pendingFlagCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
                {pendingFlagCount}
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
        {activeTab === "compliance" && (
          <ComplianceTab flags={auditFlags} reviewerId={userId} reviewContacts={reviewContacts} />
        )}
        {activeTab === "coaching" && (
          <CoachingTab
            agentInsights={agentInsights}
            teamAvgResponseTime={teamAvgResponseTime}
            topicFrequency={topicFrequency}
          />
        )}
        {activeTab === "voice" && (
          <VoiceTab voiceInsights={voiceInsights} />
        )}
      </div>
    </div>
  )
}
