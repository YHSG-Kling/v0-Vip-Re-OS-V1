"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { createClient } from "@/lib/supabase/client"
import {
  MessageSquare,
  CheckCircle2,
  Calendar,
  ThumbsUp,
  Sparkles,
  AlertTriangle,
} from "lucide-react"

interface HandoffContextCardProps {
  contactId: string
  leadId?: string | null
}

interface HandoffContext {
  handoffReason: string
  lastConversationSummary: string | null
  qualificationSummary: string
  positiveResponseContext: string | null
  appointmentSignal: boolean
  appointmentDetails: string | null
  urgencyLevel: string
  qualificationScore: number | null
  motivationIndicators: string[]
  financingConfidence: string | null
}

export function HandoffContextCard({ contactId, leadId }: HandoffContextCardProps) {
  const [context, setContext] = useState<HandoffContext | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadHandoffContext() {
      const supabase = createClient()

      // Get qualification data
      const { data: qualification } = await supabase
        .from("ai_isa_qualifications")
        .select("*")
        .eq("contact_id", contactId)
        .order("qualified_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      // Get last AI conversation summary from activities
      const { data: lastActivity } = await supabase
        .from("activities")
        .select("description, metadata")
        .eq("contact_id", contactId)
        .in("activity_type", ["ai_conversation", "ai_isa_call", "ai_qualification"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      // Get engagement tracking for a positive (replied) engagement.
      // event_type CHECK has no "positive_response" — "replied" is the positive signal;
      // timestamp is event_at.
      const { data: engagementData } = await supabase
        .from("ai_isa_engagement_tracking")
        .select("event_type, channel, metadata")
        .eq("contact_id", contactId)
        .eq("event_type", "replied")
        .order("event_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      // Build context
      const signals = qualification?.qualification_signals || {}

      const handoffContext: HandoffContext = {
        handoffReason: signals.summary || qualification?.qualification_result || "Qualified lead ready for agent follow-up",
        lastConversationSummary: lastActivity?.description || signals.last_conversation_summary || null,
        qualificationSummary: signals.summary || "Lead has been qualified by AI ISA",
        positiveResponseContext: engagementData?.metadata?.context || signals.positive_response_context || null,
        appointmentSignal: signals.appointment_intent === true || !!signals.appointment_requested,
        appointmentDetails: signals.appointment_details || signals.preferred_time || null,
        urgencyLevel: signals.urgency || "medium",
        qualificationScore: qualification?.qualification_score || null,
        motivationIndicators: signals.motivation_indicators || [],
        financingConfidence: signals.financing_status || signals.pre_approved ? "Pre-approved" : null,
      }

      setContext(handoffContext)
      setLoading(false)
    }

    if (contactId) {
      loadHandoffContext()
    }
  }, [contactId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-violet-600" />
            Handoff Context
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!context) {
    return null
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-violet-600" />
            Why AI Handed This Off
          </CardTitle>
          {context.appointmentSignal && (
            <Badge className="bg-green-100 text-green-700 border-green-200">
              <Calendar className="h-3 w-3 mr-1" />
              Appointment Signal
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Handoff Reason */}
        <div className="p-3 bg-violet-50 rounded-lg border border-violet-100">
          <div className="flex items-start gap-2">
            <Sparkles className="h-4 w-4 text-violet-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-violet-900">{context.handoffReason}</p>
              {context.qualificationScore && (
                <p className="text-xs text-violet-600 mt-1">
                  Qualification Score: {context.qualificationScore}/100
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Last Conversation Summary */}
        {context.lastConversationSummary && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Last Conversation Summary</p>
            <p className="text-sm bg-muted/50 p-2 rounded">{context.lastConversationSummary}</p>
          </div>
        )}

        {/* Positive Response Context */}
        {context.positiveResponseContext && (
          <div className="flex items-start gap-2 p-2 bg-green-50 rounded border border-green-100">
            <ThumbsUp className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-medium text-green-700">Positive Response Detected</p>
              <p className="text-sm text-green-800">{context.positiveResponseContext}</p>
            </div>
          </div>
        )}

        {/* Appointment Details */}
        {context.appointmentSignal && context.appointmentDetails && (
          <div className="flex items-start gap-2 p-2 bg-blue-50 rounded border border-blue-100">
            <Calendar className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-medium text-blue-700">Appointment Interest</p>
              <p className="text-sm text-blue-800">{context.appointmentDetails}</p>
            </div>
          </div>
        )}

        {/* Motivation Indicators */}
        {context.motivationIndicators.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Motivation Signals</p>
            <div className="flex flex-wrap gap-1.5">
              {context.motivationIndicators.map((indicator, idx) => (
                <Badge key={idx} variant="outline" className="text-xs">
                  <CheckCircle2 className="h-3 w-3 mr-1 text-green-600" />
                  {indicator}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Financing Status */}
        {context.financingConfidence && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <span className="font-medium">{context.financingConfidence}</span>
          </div>
        )}

        {/* Urgency Warning */}
        {(context.urgencyLevel === "urgent" || context.urgencyLevel === "high") && (
          <div className="flex items-center gap-2 p-2 bg-orange-50 rounded border border-orange-100">
            <AlertTriangle className="h-4 w-4 text-orange-600" />
            <span className="text-sm text-orange-700 font-medium">
              {context.urgencyLevel === "urgent" ? "Urgent: Contact immediately" : "High priority follow-up needed"}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
