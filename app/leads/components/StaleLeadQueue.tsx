"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { assignLead } from "@/app/actions/leads"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, ChevronDown, ChevronUp, Bell, UserCog, Bot, Archive } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface StaleLead {
  id: string
  first_name: string | null
  last_name: string | null
  agent_id: string | null
  lead_stage: string | null
  last_activity_at: string | null
  contact_id: string | null
  agents: { users: { first_name: string | null; last_name: string | null } | null } | null
}

interface Agent {
  id: string
  users: { first_name: string | null; last_name: string | null } | null
}

interface StaleLeadQueueProps {
  brokerageId: string
}

export function StaleLeadQueue({ brokerageId }: StaleLeadQueueProps) {
  const { toast } = useToast()
  const supabase = createClient()

  const [expanded, setExpanded] = useState(false)
  const [staleLeads, setStaleLeads] = useState<StaleLead[]>([])
  const [loading, setLoading] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])

  // Per-lead action state
  const [nudging, setNudging] = useState<string | null>(null)
  const [reassigning, setReassigning] = useState<string | null>(null)
  const [reassignTarget, setReassignTarget] = useState<Record<string, string>>({})
  const [autopiloting, setAutopiloting] = useState<string | null>(null)
  const [archiving, setArchiving] = useState<string | null>(null)
  // Track local overrides after actions
  const [aiActiveIds, setAiActiveIds] = useState<Set<string>>(new Set())
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from("leads")
      .select("id, first_name, last_name, agent_id, lead_stage, last_activity_at, contact_id, agents(users(first_name, last_name))")
      .eq("brokerage_id", brokerageId)
      .eq("lead_stage", "stale")
      .eq("is_active", true)
      .order("last_activity_at", { ascending: true })
      .limit(10)
    setStaleLeads((data as StaleLead[]) ?? [])

    const { data: agentData } = await supabase
      .from("agents")
      .select("id, users(first_name, last_name)")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
    setAgents((agentData as Agent[]) ?? [])

    setLoading(false)
  }, [brokerageId])

  useEffect(() => {
    if (expanded) load()
  }, [expanded, load])

  function daysSince(ts: string | null) {
    if (!ts) return null
    return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
  }

  async function handleNudge(lead: StaleLead) {
    setNudging(lead.id)
    const { error } = await supabase.from("activities").insert({
      agent_id: lead.agent_id,
      activity_type: "admin_nudge",
      title: "Follow up on stale lead",
      description: "Admin requested follow-up",
      contact_id: lead.contact_id,
      priority: "high",
      status: "pending",
      brokerage_id: brokerageId,
    })
    setNudging(null)
    if (error) {
      toast({ title: "Nudge failed", description: error.message, variant: "destructive" })
    } else {
      toast({ title: "Agent nudged", description: "A follow-up task has been created for the agent." })
    }
  }

  async function handleReassign(lead: StaleLead) {
    const newAgentId = reassignTarget[lead.id]
    if (!newAgentId) return
    setReassigning(lead.id)
    const result = await assignLead(lead.id, newAgentId)
    setReassigning(null)
    if (result.success) {
      toast({ title: "Lead reassigned" })
      setRemovedIds((prev) => new Set(prev).add(lead.id))
    } else {
      toast({ title: "Reassign failed", description: (result as any).error, variant: "destructive" })
    }
  }

  async function handleAutopilot(lead: StaleLead) {
    if (!lead.contact_id) return
    setAutopiloting(lead.id)
    const { error } = await supabase
      .from("contacts")
      .update({ isa_reengage_allowed: true })
      .eq("id", lead.contact_id)
    setAutopiloting(null)
    if (error) {
      toast({ title: "Autopilot failed", description: error.message, variant: "destructive" })
    } else {
      setAiActiveIds((prev) => new Set(prev).add(lead.id))
      toast({ title: "AI Autopilot enabled", description: "AI-ISA will begin re-engaging this lead." })
    }
  }

  async function handleArchive(lead: StaleLead) {
    setArchiving(lead.id)
    const { error } = await supabase
      .from("leads")
      .update({ lead_stage: "archived", is_active: false })
      .eq("id", lead.id)
    setArchiving(null)
    if (error) {
      toast({ title: "Archive failed", description: error.message, variant: "destructive" })
    } else {
      setRemovedIds((prev) => new Set(prev).add(lead.id))
      toast({ title: "Lead archived" })
    }
  }

  const visible = staleLeads.filter((l) => !removedIds.has(l.id))

  return (
    <Card className="border-amber-300">
      <CardHeader className="py-3 px-4">
        <button
          type="button"
          className="flex items-center justify-between w-full"
          onClick={() => setExpanded((v) => !v)}
        >
          <CardTitle className="text-sm font-semibold text-amber-900 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
            Stale Lead Queue
            {visible.length > 0 && (
              <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-xs ml-1">
                {visible.length}
              </Badge>
            )}
          </CardTitle>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-amber-700" />
          ) : (
            <ChevronDown className="h-4 w-4 text-amber-700" />
          )}
        </button>
      </CardHeader>

      {expanded && (
        <CardContent className="px-4 pb-4 pt-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stale leads...
            </div>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No stale leads at this time.</p>
          ) : (
            <div className="space-y-3">
              {/* Column headers */}
              <div className="grid grid-cols-[1fr_1fr_80px_60px] gap-3 text-xs font-medium text-muted-foreground pb-1 border-b border-border">
                <span>Lead</span>
                <span>Assigned Agent</span>
                <span>Last Activity</span>
                <span>Actions</span>
              </div>

              {visible.map((lead) => {
                const days = daysSince(lead.last_activity_at)
                const agentName = lead.agents?.users
                  ? `${lead.agents.users.first_name ?? ""} ${lead.agents.users.last_name ?? ""}`.trim()
                  : "Unassigned"
                const isAiActive = aiActiveIds.has(lead.id)

                return (
                  <div
                    key={lead.id}
                    className="grid grid-cols-[1fr_1fr_80px_auto] gap-3 items-start py-2 border-b border-border last:border-0"
                  >
                    {/* Lead name */}
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">
                        {lead.first_name} {lead.last_name}
                      </span>
                      {isAiActive && (
                        <Badge className="w-fit bg-violet-100 text-violet-700 border-violet-200 text-[10px] py-0 px-1.5">
                          AI Active
                        </Badge>
                      )}
                    </div>

                    {/* Agent */}
                    <span className="text-sm text-muted-foreground">{agentName}</span>

                    {/* Days stale */}
                    <span className="text-sm text-amber-700 font-medium">
                      {days !== null ? `${days}d ago` : "—"}
                    </span>

                    {/* Actions */}
                    <div className="flex flex-col gap-1.5 min-w-[260px]">
                      {/* Row 1: Nudge + Autopilot */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => handleNudge(lead)}
                          disabled={nudging === lead.id}
                        >
                          {nudging === lead.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Bell className="h-3 w-3" />
                          )}
                          Nudge Agent
                        </Button>

                        {lead.contact_id && (
                          <Button
                            size="sm"
                            variant="outline"
                            className={`h-7 text-xs gap-1 ${isAiActive ? "border-violet-300 text-violet-700" : ""}`}
                            onClick={() => handleAutopilot(lead)}
                            disabled={autopiloting === lead.id || isAiActive}
                          >
                            {autopiloting === lead.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Bot className="h-3 w-3" />
                            )}
                            {isAiActive ? "AI Active" : "Enable AI Autopilot"}
                          </Button>
                        )}

                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1 text-destructive border-destructive/30 hover:bg-destructive/5"
                          onClick={() => handleArchive(lead)}
                          disabled={archiving === lead.id}
                        >
                          {archiving === lead.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Archive className="h-3 w-3" />
                          )}
                          Archive
                        </Button>
                      </div>

                      {/* Row 2: Reassign */}
                      <div className="flex items-center gap-1.5">
                        <Select
                          value={reassignTarget[lead.id] ?? ""}
                          onValueChange={(v) =>
                            setReassignTarget((prev) => ({ ...prev, [lead.id]: v }))
                          }
                        >
                          <SelectTrigger className="h-7 text-xs w-40">
                            <SelectValue placeholder="Select agent..." />
                          </SelectTrigger>
                          <SelectContent>
                            {agents
                              .filter((a) => a.id !== lead.agent_id)
                              .map((a) => (
                                <SelectItem key={a.id} value={a.id}>
                                  {a.users?.first_name} {a.users?.last_name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => handleReassign(lead)}
                          disabled={reassigning === lead.id || !reassignTarget[lead.id]}
                        >
                          {reassigning === lead.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <UserCog className="h-3 w-3" />
                          )}
                          Reassign
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
