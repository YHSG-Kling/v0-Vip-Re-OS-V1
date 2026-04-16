"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Zap, Loader2, UserCheck } from "lucide-react"
import { toast } from "sonner"
import { listUnassignedLeads, claimLead } from "@/app/actions/lead-lifecycle"
import { formatDistanceToNow } from "date-fns"

interface Lead {
  id: string
  first_name: string | null
  last_name: string | null
  source: string | null
  motivation_type: string | null
  lead_stage: string | null
  created_at: string
  urgency_level: string | null
}

interface AvailableLeadsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string
  brokerageId: string
  onLeadClaimed: (leadId: string) => void
}

export function AvailableLeadsSheet({
  open,
  onOpenChange,
  agentId,
  brokerageId,
  onLeadClaimed,
}: AvailableLeadsSheetProps) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(false)
  const [claimingId, setClaimingId] = useState<string | null>(null)

  const loadLeads = useCallback(async () => {
    if (!brokerageId) return
    setLoading(true)
    try {
      const result = await listUnassignedLeads({
        brokerageId,
        limit: 20,
        leadStage: "available",
      })
      setLeads(result.leads as unknown as Lead[])
    } catch {
      // If no leads with stage "available" exist, fall back to all unassigned leads
      try {
        const fallback = await listUnassignedLeads({ brokerageId, limit: 20 })
        setLeads(fallback.leads as unknown as Lead[])
      } catch {
        setLeads([])
      }
    } finally {
      setLoading(false)
    }
  }, [brokerageId])

  useEffect(() => {
    if (open) {
      loadLeads()
    }
  }, [open, loadLeads])

  async function handleClaim(lead: Lead) {
    if (!agentId || !brokerageId) return
    setClaimingId(lead.id)
    try {
      const result = await claimLead({ leadId: lead.id, agentId, brokerageId })
      if (result.success) {
        // Optimistic removal from pool
        setLeads((prev) => prev.filter((l) => l.id !== lead.id))
        onLeadClaimed(lead.id)
        toast.success("Lead claimed! It's now in your pipeline.")
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to claim lead. Please try again.")
    } finally {
      setClaimingId(null)
    }
  }

  function getTemperatureBadge(urgency: string | null) {
    if (urgency === "high") return { label: "Hot", className: "bg-red-100 text-red-800" }
    if (urgency === "medium") return { label: "Warm", className: "bg-orange-100 text-orange-800" }
    return { label: "Cold", className: "bg-blue-100 text-blue-700" }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader className="pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            Available Leads
          </SheetTitle>
          <SheetDescription>
            Leads available to claim in your brokerage
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-4 space-y-3">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-4 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
            ))
          ) : leads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center space-y-3 text-muted-foreground">
              <UserCheck className="h-10 w-10 opacity-30" />
              <p className="font-medium text-foreground">No leads available to claim right now.</p>
              <p className="text-sm">Your admin assigns leads as they come in.</p>
            </div>
          ) : (
            leads.map((lead) => {
              const name =
                lead.first_name || lead.last_name
                  ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim()
                  : "Unknown Lead"
              const tempBadge = getTemperatureBadge(lead.urgency_level)
              const isClaiming = claimingId === lead.id

              return (
                <div
                  key={lead.id}
                  className="rounded-lg border bg-card p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${tempBadge.className}`}
                    >
                      {tempBadge.label}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {lead.source && (
                      <Badge variant="outline" className="text-xs capitalize">
                        {lead.source.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {lead.motivation_type && (
                      <Badge variant="outline" className="text-xs capitalize">
                        {lead.motivation_type.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {lead.lead_stage && (
                      <Badge variant="secondary" className="text-xs capitalize">
                        {lead.lead_stage}
                      </Badge>
                    )}
                  </div>

                  <Button
                    size="sm"
                    className="w-full"
                    disabled={isClaiming}
                    onClick={() => handleClaim(lead)}
                  >
                    {isClaiming ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                        Claiming...
                      </>
                    ) : (
                      <>
                        <Zap className="h-3.5 w-3.5 mr-2" />
                        Claim This Lead
                      </>
                    )}
                  </Button>
                </div>
              )
            })
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center pb-2 border-t pt-3">
          Claimed leads appear in your My Leads list
        </p>
      </SheetContent>
    </Sheet>
  )
}
