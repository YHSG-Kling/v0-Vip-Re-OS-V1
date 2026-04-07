"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  UserCheck,
  Phone,
  ArrowRight,
  Star,
  Clock,
  CheckCircle2,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { KernelEvent } from "@/lib/kernel/events"

interface QualifiedContact {
  id: string
  contact_id: string | null
  qualification_score: number | null
  qualification_result: string | null
  notes: string | null
  qualified_at: string | null
  contacts: {
    id: string
    first_name: string | null
    last_name: string | null
    phone: string | null
    buyer_stage: string | null
  } | null
}

interface HandoffQueuePanelProps {
  queue: QualifiedContact[]
  brokerageId: string
  agentId: string
}

function formatTimeAgo(dateString: string | null): string {
  if (!dateString) return "--"
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

function getScoreBadge(score: number | null) {
  if (!score) return null
  if (score >= 80) {
    return (
      <Badge className="bg-green-500/10 text-green-600 border-green-200">
        <Star className="h-3 w-3 mr-1 fill-current" />
        {score}
      </Badge>
    )
  }
  if (score >= 60) {
    return (
      <Badge className="bg-amber-500/10 text-amber-600 border-amber-200">
        {score}
      </Badge>
    )
  }
  return <Badge variant="secondary">{score}</Badge>
}

export function HandoffQueuePanel({ queue: initialQueue, brokerageId, agentId }: HandoffQueuePanelProps) {
  const router = useRouter()
  const [claiming, setClaiming] = useState<string | null>(null)
  // Optimistic removal: maintain local copy of the queue
  const [localQueue, setLocalQueue] = useState<QualifiedContact[]>(initialQueue)

  const handleTakeCall = async (qualificationId: string, contactId: string | null) => {
    if (!contactId || claiming) return
    setClaiming(qualificationId)

    const supabase = createClient()

    try {
      // 1. Persist: mark qualification as assigned to this agent
      const { error: assignErr } = await supabase
        .from("ai_isa_qualifications")
        .update({
          assigned_to_agent_id: agentId,
          assigned_at: new Date().toISOString(),
        })
        .eq("id", qualificationId)

      if (assignErr) {
        console.error("[HandoffQueue] Failed to assign qualification:", assignErr.message)
      }

      // 2. Emit Kernel handoff event
      await supabase
        .from("lifecycle_events")
        .insert({
          brokerage_id: brokerageId,
          entity_type: "contact",
          entity_id: contactId,
          event_type: KernelEvent.AI_ISA_HANDOFF_TO_AGENT,
          actor_user_id: agentId,
          metadata: {
            qualification_id: qualificationId,
            handoff_type: "manual_claim",
          },
        })

      // 3. Insert notification so agent sees it in their notification feed
      await supabase.from("notifications").insert({
        brokerage_id: brokerageId,
        user_id: agentId,
        type: "handoff_claimed",
        title: "Handoff claimed",
        body: `You claimed a qualified lead from the AI-ISA handoff queue.`,
        entity_type: "qualification",
        entity_id: qualificationId,
        created_at: new Date().toISOString(),
        read: false,
      })

      // 4. Optimistic removal — remove from local queue immediately
      setLocalQueue((prev) => prev.filter((item) => item.id !== qualificationId))

    } catch (err: any) {
      console.error("[HandoffQueue] Claim error:", err.message)
    } finally {
      setClaiming(null)
    }

    // 5. Navigate to the contact detail page
    router.push(`/contacts/${contactId}`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCheck className="h-5 w-5" />
          Human Handoff Required
          {localQueue.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {localQueue.length} ready
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {localQueue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500/50 mb-3" />
            <p className="text-sm text-muted-foreground">Queue is clear</p>
            <p className="text-xs text-muted-foreground mt-1">
              AI-qualified contacts will appear here for agent follow-up
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {localQueue.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium">
                      {item.contacts?.first_name} {item.contacts?.last_name}
                    </p>
                    {getScoreBadge(item.qualification_score)}
                    {item.qualification_result && (
                      <Badge
                        variant="outline"
                        className="text-xs capitalize"
                      >
                        {item.qualification_result.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>

                  {item.contacts?.phone && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {item.contacts.phone}
                    </p>
                  )}

                  {item.notes && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {item.notes}
                    </p>
                  )}

                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Qualified {formatTimeAgo(item.qualified_at)}
                  </p>
                </div>

                <Button
                  size="sm"
                  className="shrink-0"
                  disabled={claiming === item.id}
                  onClick={() => handleTakeCall(item.id, item.contact_id)}
                >
                  {claiming === item.id ? (
                    <span className="text-xs">Claiming...</span>
                  ) : (
                    <>
                      <ArrowRight className="h-3 w-3 mr-1" />
                      <span className="text-xs">Hand Off to Human Agent</span>
                    </>
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
