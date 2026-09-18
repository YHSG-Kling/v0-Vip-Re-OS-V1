"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, ChevronDown, ChevronUp, ExternalLink, StopCircle, CheckCircle2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface GhostLead {
  id: string
  first_name: string | null
  last_name: string | null
  reengagement_status: string | null
  last_activity_at: string | null
}

interface GhostRecoveryQueueProps {
  brokerageId: string
}

export function GhostRecoveryQueue({ brokerageId }: GhostRecoveryQueueProps) {
  const { toast } = useToast()
  const supabase = createClient()

  const [expanded, setExpanded] = useState(false)
  const [ghostLeads, setGhostLeads] = useState<GhostLead[]>([])
  const [loading, setLoading] = useState(false)

  // Per-lead action state
  const [stopping, setStopping] = useState<string | null>(null)
  const [recovering, setRecovering] = useState<string | null>(null)
  // Track local overrides
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [recoveredIds, setRecoveredIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from("leads")
      .select("id, first_name, last_name, reengagement_status, last_activity_at")
      .eq("brokerage_id", brokerageId)
      .eq("reengagement_status", "active")
      .eq("is_active", true)
      .limit(10)
    setGhostLeads((data as GhostLead[]) ?? [])
    setLoading(false)
  }, [brokerageId])

  useEffect(() => {
    if (expanded) load()
  }, [expanded, load])

  function daysSince(ts: string | null) {
    if (!ts) return null
    return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
  }

  async function handleStopRecovery(lead: GhostLead) {
    setStopping(lead.id)
    const { error } = await supabase
      .from("leads")
      .update({ reengagement_status: "stopped" })
      .eq("id", lead.id)
    setStopping(null)
    if (error) {
      toast({ title: "Failed to stop recovery", description: error.message, variant: "destructive" })
    } else {
      setRemovedIds((prev) => new Set(prev).add(lead.id))
      toast({ title: "Recovery stopped", description: "AI-ISA will no longer contact this lead." })
    }
  }

  async function handleMarkRecovered(lead: GhostLead) {
    setRecovering(lead.id)
    const { error } = await supabase
      .from("leads")
      .update({ reengagement_status: "completed", lead_stage: "qualified" })
      .eq("id", lead.id)
    setRecovering(null)
    if (error) {
      toast({ title: "Failed to mark recovered", description: error.message, variant: "destructive" })
    } else {
      setRecoveredIds((prev) => new Set(prev).add(lead.id))
      setRemovedIds((prev) => new Set(prev).add(lead.id))
      toast({ title: "Lead marked as recovered", description: "Lead stage updated to Qualified." })
    }
  }

  const visible = ghostLeads.filter((l) => !removedIds.has(l.id))

  return (
    <Card className="border-red-300">
      <CardHeader className="py-3 px-4">
        <button
          type="button"
          className="flex items-center justify-between w-full"
          onClick={() => setExpanded((v) => !v)}
        >
          <CardTitle className="text-sm font-semibold text-red-900 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />
            Ghost Recovery Queue
            {visible.length > 0 && (
              <Badge className="bg-red-100 text-red-800 border-red-300 text-xs ml-1">
                {visible.length}
              </Badge>
            )}
          </CardTitle>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-red-700" />
          ) : (
            <ChevronDown className="h-4 w-4 text-red-700" />
          )}
        </button>
      </CardHeader>

      {expanded && (
        <CardContent className="px-4 pb-4 pt-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading ghost recovery leads...
            </div>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No ghost leads in active recovery.</p>
          ) : (
            <div className="space-y-3">
              {/* Column headers */}
              <div className="grid grid-cols-[1fr_160px_100px_auto] gap-3 text-xs font-medium text-muted-foreground pb-1 border-b border-border">
                <span>Lead</span>
                <span>Status</span>
                <span>Last Activity</span>
                <span>Actions</span>
              </div>

              {visible.map((lead) => {
                const days = daysSince(lead.last_activity_at)

                return (
                  <div
                    key={lead.id}
                    className="grid grid-cols-[1fr_160px_100px_auto] gap-3 items-center py-2 border-b border-border last:border-0"
                  >
                    {/* Lead name */}
                    <span className="text-sm font-medium">
                      {lead.first_name} {lead.last_name}
                    </span>

                    {/* Status badge */}
                    <Badge className="w-fit bg-red-50 text-red-700 border-red-200 text-xs">
                      AI-ISA Recovering
                    </Badge>

                    {/* Last activity */}
                    <span className="text-sm text-muted-foreground">
                      {days !== null ? `${days}d ago` : "—"}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        asChild
                      >
                        {/* REPOINTED (dangling-link sweep, 2026-09-02): was
                            `/dashboard/isa/leads/${id}` — app/dashboard/isa has no leads
                            child. `lead.id` is a leads.id (this component updates
                            `leads` by it), and app/leads/[leadId]/page.tsx is the lead
                            detail that renders the lead_conversation_history transcript
                            — the conversation this button promises. Gate there:
                            resolveLeadVisibility + leadRowInScope (brokerage/platform,
                            never agent-claimed — §5). */}
                        <a href={`/leads/${lead.id}`} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3 w-3" />
                          View Conversation
                        </a>
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 text-destructive border-destructive/30 hover:bg-destructive/5"
                        onClick={() => handleStopRecovery(lead)}
                        disabled={stopping === lead.id}
                      >
                        {stopping === lead.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <StopCircle className="h-3 w-3" />
                        )}
                        Stop Recovery
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                        onClick={() => handleMarkRecovered(lead)}
                        disabled={recovering === lead.id}
                      >
                        {recovering === lead.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                        Mark Recovered
                      </Button>
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
