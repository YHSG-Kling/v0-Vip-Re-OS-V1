"use client"

interface LeadStatusBadgeProps {
  lead: {
    agent_id?: string | null
    lifecycle_state?: string | null
    reengagement_status?: string | null
    lead_stage?: string | null
    is_active?: boolean
  }
}

interface StatusConfig {
  label: string
  color: string
}

function getLeadStatusConfig(lead: LeadStatusBadgeProps["lead"]): StatusConfig {
  if (!lead.is_active) {
    return { label: "Converted", color: "bg-gray-100 text-gray-500 border border-gray-200" }
  }

  if (lead.reengagement_status === "active") {
    return { label: "AI-ISA Active", color: "bg-purple-100 text-purple-800 border border-purple-200" }
  }

  if (lead.reengagement_status === "completed") {
    return { label: "Recovered", color: "bg-green-100 text-green-800 border border-green-200" }
  }

  if (lead.lifecycle_state === "isa_qualifying") {
    return { label: "ISA Qualifying", color: "bg-blue-100 text-blue-800 border border-blue-200" }
  }

  if (lead.lead_stage === "stale") {
    return { label: "Stale", color: "bg-amber-100 text-amber-700 border border-amber-200" }
  }

  if (lead.lead_stage === "qualified") {
    return { label: "Qualified", color: "bg-green-100 text-green-800 border border-green-200" }
  }

  if (lead.lead_stage === "claimed" && lead.agent_id) {
    return { label: "Claimed", color: "bg-indigo-100 text-indigo-800 border border-indigo-200" }
  }

  if (!lead.agent_id) {
    return { label: "Unassigned", color: "bg-amber-100 text-amber-800 border border-amber-200" }
  }

  const rawStage = lead.lead_stage || "New"
  const label = rawStage.charAt(0).toUpperCase() + rawStage.slice(1)
  return { label, color: "bg-slate-100 text-slate-700 border border-slate-200" }
}

export function LeadStatusBadge({ lead }: LeadStatusBadgeProps) {
  const config = getLeadStatusConfig(lead)
  return (
    <span
      className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium ${config.color}`}
    >
      {config.label}
    </span>
  )
}
