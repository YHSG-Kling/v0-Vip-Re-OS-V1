"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { listUnassignedLeads } from "@/app/actions/lead-lifecycle"
import { assignLead, manualAssignLead } from "@/app/actions/lead-assignment/assign-lead"
import { toast } from "sonner"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Users, Zap, CheckCircle2, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

interface Agent {
  id: string
  user_id: string
  first_name: string
  last_name: string
  active_leads: number
}

interface UnassignedLead {
  id: string
  first_name: string | null
  last_name: string | null
  source: string | null
  motivation_type: string | null
  motivation_confidence: number | null
  lead_stage: string | null
  created_at: string
}

type AssignMode = "auto" | "manual"
type AssignedMap = Record<string, { agentName: string; done: boolean }>

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  brokerageId: string
  userId: string
  onAssigned?: () => void
}

export function AdminAssignmentPanel({ open, onOpenChange, brokerageId, userId, onAssigned }: Props) {
  const [leads, setLeads] = useState<UnassignedLead[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [assignMode, setAssignMode] = useState<AssignMode>("auto")
  const [assigningId, setAssigningId] = useState<string | null>(null)
  const [assigningAll, setAssigningAll] = useState(false)
  const [assignAllProgress, setAssignAllProgress] = useState(0)
  const [assigned, setAssigned] = useState<AssignedMap>({})

  // Manual mode state
  const [selectedLead, setSelectedLead] = useState<UnassignedLead | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState("")

  const loadData = useCallback(async () => {
    if (!brokerageId) return
    setLoading(true)
    try {
      const supabase = createClient()
      const [leadsResult, agentsResult] = await Promise.all([
        listUnassignedLeads({ brokerageId, limit: 50 }),
        supabase
          .from("agents")
          .select("id, user_id, users(first_name, last_name), leads(count)")
          .eq("brokerage_id", brokerageId)
          .eq("is_active", true),
      ])

      setLeads(
        [...(leadsResult.leads || [])].sort(
          (a, b) => (b.motivation_confidence ?? 0) - (a.motivation_confidence ?? 0),
        ),
      )

      const agentRows = (agentsResult.data ?? []).map((a: any) => ({
        id: a.id,
        user_id: a.user_id,
        first_name: a.users?.first_name ?? "",
        last_name: a.users?.last_name ?? "",
        active_leads: a.leads?.[0]?.count ?? 0,
      }))
      setAgents(agentRows.sort((a: Agent, b: Agent) => a.active_leads - b.active_leads))
    } catch (err) {
      toast.error("Failed to load assignment data")
    } finally {
      setLoading(false)
    }
  }, [brokerageId])

  useEffect(() => {
    if (open) {
      setAssigned({})
      setSelectedLead(null)
      setSelectedAgentId("")
      loadData()
    }
  }, [open, loadData])

  // ── AUTO-ASSIGN: single lead ──────────────────────────────────────────────
  async function handleAutoAssign(lead: UnassignedLead) {
    setAssigningId(lead.id)
    try {
      const result = await assignLead(lead.id)
      if (result.assigned && result.agentId) {
        const agent = agents.find((a) => a.id === result.agentId) ??
          agents.find((a) => a.user_id === result.agentId)
        const agentName = agent
          ? `${agent.first_name} ${agent.last_name}`.trim()
          : result.agentId.slice(0, 8)
        setAssigned((prev) => ({ ...prev, [lead.id]: { agentName, done: false } }))
        setTimeout(() => {
          setAssigned((prev) => ({ ...prev, [lead.id]: { agentName, done: true } }))
          setTimeout(() => {
            setLeads((prev) => prev.filter((l) => l.id !== lead.id))
            setAssigned((prev) => {
              const next = { ...prev }
              delete next[lead.id]
              return next
            })
          }, 1500)
        }, 300)
        onAssigned?.()
      } else {
        toast.error(result.reason ?? "Auto-assign failed — no eligible agent found")
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Assignment failed")
    } finally {
      setAssigningId(null)
    }
  }

  // ── AUTO-ASSIGN: all leads ────────────────────────────────────────────────
  async function handleAssignAll() {
    const pending = leads.filter((l) => !assigned[l.id])
    if (pending.length === 0) return
    setAssigningAll(true)
    setAssignAllProgress(0)
    let successCount = 0
    for (let i = 0; i < pending.length; i++) {
      setAssignAllProgress(i + 1)
      try {
        const result = await assignLead(pending[i].id)
        if (result.assigned) successCount++
      } catch {
        // continue on individual failure
      }
    }
    toast.success(`${successCount} of ${pending.length} leads assigned successfully`)
    setAssigningAll(false)
    setAssignAllProgress(0)
    await loadData()
    onAssigned?.()
  }

  // ── MANUAL ASSIGN ─────────────────────────────────────────────────────────
  async function handleManualAssign() {
    if (!selectedLead || !selectedAgentId) return
    setAssigningId(selectedLead.id)
    try {
      await manualAssignLead(selectedLead.id, selectedAgentId)
      const agent = agents.find((a) => a.id === selectedAgentId)
      const agentName = agent ? `${agent.first_name} ${agent.last_name}`.trim() : selectedAgentId
      toast.success(`Lead assigned to ${agentName}`)
      setLeads((prev) => prev.filter((l) => l.id !== selectedLead.id))
      setSelectedLead(null)
      setSelectedAgentId("")
      onAssigned?.()
    } catch (err: any) {
      toast.error(err?.message ?? "Manual assignment failed")
    } finally {
      setAssigningId(null)
    }
  }

  const pendingLeads = leads.filter((l) => !assigned[l.id])
  const displayLeads = leads.slice(0, 10)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <SheetTitle>Assign Leads</SheetTitle>
          </div>
          <SheetDescription>
            {loading ? "Loading…" : `${pendingLeads.length} lead${pendingLeads.length !== 1 ? "s" : ""} waiting for assignment`}
          </SheetDescription>
        </SheetHeader>

        {/* Mode toggle */}
        <div className="flex border-b">
          <button
            onClick={() => setAssignMode("auto")}
            className={cn(
              "flex-1 py-2.5 text-sm font-medium transition-colors",
              assignMode === "auto"
                ? "text-foreground border-b-2 border-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Auto-Assign
          </button>
          <button
            onClick={() => setAssignMode("manual")}
            className={cn(
              "flex-1 py-2.5 text-sm font-medium transition-colors",
              assignMode === "manual"
                ? "text-foreground border-b-2 border-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Manual Assign
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : leads.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-500" />
              <p className="text-sm font-medium">All leads are assigned</p>
            </div>
          ) : assignMode === "auto" ? (
            <>
              {displayLeads.map((lead) => {
                const result = assigned[lead.id]
                const isAssigning = assigningId === lead.id
                const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown Lead"
                const score = lead.motivation_confidence ? Math.round(lead.motivation_confidence * 100) : null
                return (
                  <div
                    key={lead.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-opacity",
                      result?.done && "opacity-40",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{name}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {lead.source ?? "unknown source"} · {lead.motivation_type ?? "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {score !== null && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-xs",
                            score >= 70 ? "border-green-300 text-green-700" :
                            score >= 40 ? "border-amber-300 text-amber-700" :
                            "border-slate-300 text-slate-600",
                          )}
                        >
                          {score}%
                        </Badge>
                      )}
                      {result ? (
                        <span className="text-xs text-green-700 font-medium flex items-center gap-1">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {result.agentName}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isAssigning || assigningAll}
                          onClick={() => handleAutoAssign(lead)}
                          className="h-7 text-xs"
                        >
                          {isAssigning ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Zap className="h-3 w-3 mr-1" />
                              Auto-Assign
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          ) : (
            // Manual mode
            <>
              <p className="text-xs text-muted-foreground mb-1">Select a lead to assign</p>
              {leads.map((lead) => {
                const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown Lead"
                const isSelected = selectedLead?.id === lead.id
                return (
                  <button
                    key={lead.id}
                    onClick={() => {
                      setSelectedLead(isSelected ? null : lead)
                      setSelectedAgentId("")
                    }}
                    className={cn(
                      "w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
                      isSelected ? "border-foreground bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{name}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {lead.source ?? "unknown"} · {lead.motivation_type ?? "—"}
                      </p>
                    </div>
                    <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", isSelected && "rotate-90")} />
                  </button>
                )
              })}

              {selectedLead && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3 mt-2">
                  <p className="text-sm font-medium">
                    Assign: {[selectedLead.first_name, selectedLead.last_name].filter(Boolean).join(" ") || "Unknown Lead"}
                  </p>
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select agent..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.first_name} {agent.last_name}
                          <span className="text-muted-foreground ml-1 text-xs">
                            ({agent.active_leads} active)
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    className="w-full"
                    disabled={!selectedAgentId || assigningId === selectedLead.id}
                    onClick={handleManualAssign}
                  >
                    {assigningId === selectedLead.id ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : null}
                    Assign to {agents.find((a) => a.id === selectedAgentId) ?
                      `${agents.find((a) => a.id === selectedAgentId)!.first_name} ${agents.find((a) => a.id === selectedAgentId)!.last_name}` :
                      "Agent"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Assign All footer — auto mode only */}
        {assignMode === "auto" && !loading && pendingLeads.length > 1 && (
          <div className="border-t px-6 py-4">
            <Button
              className="w-full"
              disabled={assigningAll || assigningId !== null}
              onClick={handleAssignAll}
            >
              {assigningAll ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Assigning {assignAllProgress} of {pendingLeads.length}...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  Assign All Now ({pendingLeads.length})
                </>
              )}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
