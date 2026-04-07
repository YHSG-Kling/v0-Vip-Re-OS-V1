"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { createClient } from "@/lib/supabase/client"
import {
  FileText,
  ExternalLink,
  MessageSquare,
  History,
  Clock,
  Phone,
  Mail,
  Bot,
  User,
} from "lucide-react"

interface OriginalLeadAccessCardProps {
  contactId: string
  leadId?: string | null
}

interface LeadRecord {
  id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  /** DB column: source */
  source: string | null
  /** DB column: status */
  status: string | null
  /** DB column: lifecycle_state (replaces non-existent temperature) */
  lifecycle_state: string | null
  /** DB column: lead_type (replaces non-existent intent_type) */
  lead_type: string | null
  motivation_confidence: number | null
  lead_score: number | null
  created_at: string
  notes: string | null
}

interface ConversationMessage {
  id: string
  sender: "ai" | "contact" | "agent"
  content: string
  channel: string
  timestamp: string
}

interface QualificationEvent {
  id: string
  event: string
  details: string | null
  timestamp: string
}

export function OriginalLeadAccessCard({ contactId, leadId }: OriginalLeadAccessCardProps) {
  const [lead, setLead] = useState<LeadRecord | null>(null)
  const [conversations, setConversations] = useState<ConversationMessage[]>([])
  const [qualificationHistory, setQualificationHistory] = useState<QualificationEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState("conversations")

  useEffect(() => {
    async function loadLeadData() {
      const supabase = createClient()

      // Get original lead record if leadId exists
      if (leadId) {
          const { data: leadData } = await supabase
          .from("leads")
          .select("id, first_name, last_name, email, phone, source, status, lifecycle_state, lead_type, motivation_confidence, lead_score, created_at, notes")
          .eq("id", leadId)
          .maybeSingle()

        if (leadData) {
          setLead(leadData as LeadRecord)
        }
      }

      // Get AI conversation history from activities
      const { data: activities } = await supabase
        .from("activities")
        .select("id, description, metadata, created_at, activity_type")
        .eq("contact_id", contactId)
        .in("activity_type", [
          "ai_conversation",
          "ai_isa_call",
          "email_sent",
          "email_received",
          "sms_sent",
          "sms_received",
          "call_completed",
        ])
        .order("created_at", { ascending: false })
        .limit(20)

      const convos: ConversationMessage[] = (activities || []).map((a: any) => ({
        id: a.id,
        sender: a.activity_type.includes("received") || a.activity_type === "ai_isa_call"
          ? a.metadata?.from === "ai" ? "ai" : "contact"
          : "ai",
        content: a.description || a.metadata?.summary || "Message",
        channel: a.activity_type.includes("email")
          ? "email"
          : a.activity_type.includes("sms")
          ? "sms"
          : "phone",
        timestamp: a.created_at,
      }))
      setConversations(convos)

      // Get qualification history
      const { data: qualifications } = await supabase
        .from("ai_isa_qualifications")
        .select("id, qualification_reason, urgency_level, created_at, qualification_signals")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(10)

      const history: QualificationEvent[] = (qualifications || []).map((q: any) => ({
        id: q.id,
        event: q.qualification_reason || "Qualification updated",
        details: q.qualification_signals?.summary || null,
        timestamp: q.created_at,
      }))
      setQualificationHistory(history)

      setLoading(false)
    }

    if (contactId) {
      loadLeadData()
    }
  }, [contactId, leadId])

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-600" />
            Original Lead Record
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-600" />
            Original Lead Intelligence
          </CardTitle>
          {leadId && (
            <Link href={`/dashboard/leads/${leadId}`}>
              <Button size="sm" variant="outline" className="h-7 text-xs">
                <ExternalLink className="h-3 w-3 mr-1" />
                View Full Lead
              </Button>
            </Link>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Lead Summary */}
        {lead && (
          <div className="p-3 bg-amber-50 rounded-lg border border-amber-100">
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="font-medium text-sm">
                  {lead.first_name} {lead.last_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  Source: {lead.source ?? "Unknown"}
                </p>
              </div>
              <div className="flex gap-1">
                <Badge variant="outline" className="text-xs capitalize">
                  {lead.lifecycle_state ?? "unknown"}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {lead.status ?? "unknown"}
                </Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {lead.motivation_confidence != null && (
                <div>
                  <span className="text-muted-foreground">Motivation:</span>{" "}
                  <span className="font-medium">{Math.round((lead.motivation_confidence ?? 0) * 100)}%</span>
                </div>
              )}
              {lead.lead_score != null && (
                <div>
                  <span className="text-muted-foreground">Lead score:</span>{" "}
                  <span className="font-medium">{lead.lead_score}</span>
                </div>
              )}
              {lead.lead_type && (
                <div>
                  <span className="text-muted-foreground">Type:</span>{" "}
                  <span className="font-medium capitalize">{lead.lead_type}</span>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Created:</span>{" "}
                <span className="font-medium">{formatDate(lead.created_at)}</span>
              </div>
            </div>
            {lead.notes && (
              <p className="text-xs mt-2 text-muted-foreground italic">{lead.notes}</p>
            )}
          </div>
        )}

        {/* Tabs for Conversations and History */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2 h-8">
            <TabsTrigger value="conversations" className="text-xs">
              <MessageSquare className="h-3 w-3 mr-1" />
              AI Conversations
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs">
              <History className="h-3 w-3 mr-1" />
              Qualification History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="conversations" className="mt-3">
            <ScrollArea className="h-48">
              {conversations.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No conversation history available
                </p>
              ) : (
                <div className="space-y-2">
                  {conversations.map((msg) => (
                    <div
                      key={msg.id}
                      className={`p-2 rounded text-xs ${
                        msg.sender === "ai"
                          ? "bg-violet-50 border-l-2 border-violet-400"
                          : msg.sender === "contact"
                          ? "bg-blue-50 border-l-2 border-blue-400"
                          : "bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        {msg.sender === "ai" ? (
                          <Bot className="h-3 w-3 text-violet-600" />
                        ) : (
                          <User className="h-3 w-3 text-blue-600" />
                        )}
                        <span className="font-medium capitalize">{msg.sender}</span>
                        <span className="text-muted-foreground">via {msg.channel}</span>
                        <span className="text-muted-foreground ml-auto">
                          {formatDate(msg.timestamp)}
                        </span>
                      </div>
                      <p className="line-clamp-2">{msg.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="history" className="mt-3">
            <ScrollArea className="h-48">
              {qualificationHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No qualification history available
                </p>
              ) : (
                <div className="space-y-2">
                  {qualificationHistory.map((event) => (
                    <div key={event.id} className="p-2 bg-muted/50 rounded text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium">{event.event}</span>
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDate(event.timestamp)}
                        </span>
                      </div>
                      {event.details && (
                        <p className="text-muted-foreground line-clamp-2">{event.details}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
