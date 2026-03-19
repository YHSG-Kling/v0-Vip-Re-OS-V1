"use client"

import { useState } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  UserCheck,
  Phone,
  ArrowRight,
  Star,
  Clock
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

export function HandoffQueuePanel({ queue, brokerageId, agentId }: HandoffQueuePanelProps) {
  const router = useRouter()
  const [claiming, setClaiming] = useState<string | null>(null)

  const handleTakeCall = async (qualificationId: string, contactId: string | null) => {
    if (!contactId) return
    setClaiming(qualificationId)
    
    const supabase = createClient()
    
    // Update qualification to mark as assigned
    await supabase
      .from("ai_isa_qualifications")
      .update({ 
        assigned_to_agent_id: agentId,
        assigned_at: new Date().toISOString()
      })
      .eq("id", qualificationId)

    // Emit kernel event for handoff
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
          handoff_type: "manual_claim"
        }
      })

    setClaiming(null)
    
    // Navigate to contact
    router.push(`/contacts/${contactId}`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCheck className="h-5 w-5" />
          Handoff Queue
          {queue.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {queue.length} ready
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <UserCheck className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No qualified leads waiting</p>
            <p className="text-xs text-muted-foreground mt-1">
              AI-qualified contacts will appear here for follow-up
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {queue.map((item) => (
              <div 
                key={item.id} 
                className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {item.contacts?.first_name || "Unknown"} {item.contacts?.last_name || ""}
                    </span>
                    {getScoreBadge(item.qualification_score)}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {item.contacts?.phone || "--"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatTimeAgo(item.qualified_at)}
                    </span>
                  </div>
                  {item.notes && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      {item.notes}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={() => handleTakeCall(item.id, item.contact_id)}
                  disabled={claiming === item.id}
                >
                  {claiming === item.id ? (
                    "Claiming..."
                  ) : (
                    <>
                      Take Call
                      <ArrowRight className="h-4 w-4 ml-1" />
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
