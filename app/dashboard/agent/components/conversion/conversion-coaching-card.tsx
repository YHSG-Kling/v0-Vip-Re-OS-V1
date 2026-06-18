"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createClient } from "@/lib/supabase/client"
import {
  GraduationCap,
  MessageSquare,
  Shield,
  Phone,
  Calendar,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  AlertTriangle,
} from "lucide-react"

interface ConversionCoachingCardProps {
  contactId: string
}

interface CoachingData {
  responseCoaching: {
    tone: string
    keyPhrases: string[]
    avoidPhrases: string[]
    emotionalTriggers: string[]
  }
  objectionCoaching: {
    likelyObjections: Array<{
      objection: string
      response: string
      confidence: "high" | "medium" | "low"
    }>
  }
  nextCallCoaching: {
    objectives: string[]
    questionsToAsk: string[]
    informationToGather: string[]
    closingStrategy: string
  }
  followUpGuidance: {
    recommendedCadence: string
    channels: string[]
    contentSuggestions: string[]
    escalationTriggers: string[]
  }
}

export function ConversionCoachingCard({ contactId }: ConversionCoachingCardProps) {
  const [coaching, setCoaching] = useState<CoachingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState("response")

  useEffect(() => {
    async function loadCoaching() {
      const supabase = createClient()

      // Get qualification signals to derive coaching
      const { data: qualification } = await supabase
        .from("ai_isa_qualifications")
        .select("qualification_signals, qualification_result")
        .eq("contact_id", contactId)
        .order("qualified_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      const signals = qualification?.qualification_signals || {}
      const urgency = (qualification?.qualification_signals as { urgency?: string } | null)?.urgency || "medium"

      // Build coaching based on signals
      const coachingData: CoachingData = {
        responseCoaching: {
          tone: signals.preferred_communication_style || "Professional and consultative",
          keyPhrases: signals.positive_triggers || [
            "I understand your timeline",
            "Let me help you with that",
            "Based on your needs",
          ],
          avoidPhrases: signals.negative_triggers || [
            "You should hurry",
            "Everyone is doing this",
            "Trust me",
          ],
          emotionalTriggers: signals.motivation_indicators || [
            "Family needs",
            "Financial goals",
            "Lifestyle change",
          ],
        },
        objectionCoaching: {
          likelyObjections: (signals.detected_objections || []).map((obj: any) => ({
            objection: typeof obj === "string" ? obj : obj.objection || "General hesitation",
            response: typeof obj === "string"
              ? "Acknowledge the concern and provide relevant information"
              : obj.suggested_response || "Acknowledge and address with empathy",
            confidence: typeof obj === "object" ? obj.confidence || "medium" : "medium",
          })),
        },
        nextCallCoaching: {
          objectives: signals.call_objectives || [
            "Confirm timeline and urgency",
            "Understand specific requirements",
            "Schedule next step",
          ],
          questionsToAsk: signals.discovery_questions || [
            "What's most important to you in this process?",
            "Have you been pre-approved for financing?",
            "What's your ideal timeline?",
          ],
          informationToGather: signals.info_to_gather || [
            "Budget range",
            "Must-have features",
            "Deal-breakers",
          ],
          closingStrategy: signals.closing_strategy || "Soft close with specific next step",
        },
        followUpGuidance: {
          recommendedCadence: urgency === "urgent"
            ? "Same day follow-up"
            : urgency === "high"
            ? "Within 24 hours"
            : "Within 48 hours",
          channels: signals.preferred_channels || ["Phone", "Email"],
          contentSuggestions: signals.content_suggestions || [
            "Market update for their area",
            "Similar properties that match criteria",
            "Financing options overview",
          ],
          escalationTriggers: [
            "No response after 3 touches",
            "Objection not resolved",
            "Competitor mention",
          ],
        },
      }

      // Add default objections if none detected
      if (coachingData.objectionCoaching.likelyObjections.length === 0) {
        coachingData.objectionCoaching.likelyObjections = [
          {
            objection: "I need more time to think",
            response: "I completely understand. What specific information would help you make a decision?",
            confidence: "medium",
          },
          {
            objection: "I'm working with another agent",
            response: "That's great you're being proactive. What's been your experience so far? I'd be happy to offer a second opinion.",
            confidence: "medium",
          },
          {
            objection: "The market seems uncertain",
            response: "I hear that concern often. Let me share what we're actually seeing in your specific area...",
            confidence: "medium",
          },
        ]
      }

      setCoaching(coachingData)
      setLoading(false)
    }

    if (contactId) {
      loadCoaching()
    }
  }, [contactId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-emerald-600" />
            Conversion Coaching
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!coaching) {
    return null
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <GraduationCap className="h-4 w-4 text-emerald-600" />
          Conversion Coaching
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-4 h-8">
            <TabsTrigger value="response" className="text-xs">
              <MessageSquare className="h-3 w-3 mr-1" />
              Response
            </TabsTrigger>
            <TabsTrigger value="objections" className="text-xs">
              <Shield className="h-3 w-3 mr-1" />
              Objections
            </TabsTrigger>
            <TabsTrigger value="call" className="text-xs">
              <Phone className="h-3 w-3 mr-1" />
              Next Call
            </TabsTrigger>
            <TabsTrigger value="followup" className="text-xs">
              <Calendar className="h-3 w-3 mr-1" />
              Follow-up
            </TabsTrigger>
          </TabsList>

          {/* Response Coaching */}
          <TabsContent value="response" className="mt-3 space-y-3">
            <div className="p-2 bg-emerald-50 rounded border border-emerald-100">
              <p className="text-xs font-medium text-emerald-700 mb-1">Recommended Tone</p>
              <p className="text-sm">{coaching.responseCoaching.tone}</p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-green-600" />
                Key Phrases to Use
              </p>
              <div className="flex flex-wrap gap-1.5">
                {coaching.responseCoaching.keyPhrases.map((phrase, idx) => (
                  <Badge key={idx} variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                    {phrase}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-red-500" />
                Phrases to Avoid
              </p>
              <div className="flex flex-wrap gap-1.5">
                {coaching.responseCoaching.avoidPhrases.map((phrase, idx) => (
                  <Badge key={idx} variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                    {phrase}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <Sparkles className="h-3 w-3 text-violet-500" />
                Emotional Triggers
              </p>
              <div className="flex flex-wrap gap-1.5">
                {coaching.responseCoaching.emotionalTriggers.map((trigger, idx) => (
                  <Badge key={idx} variant="outline" className="text-xs">
                    {trigger}
                  </Badge>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* Objection Coaching */}
          <TabsContent value="objections" className="mt-3 space-y-2">
            {coaching.objectionCoaching.likelyObjections.map((obj, idx) => (
              <div key={idx} className="p-2 border rounded">
                <div className="flex items-start justify-between mb-1">
                  <p className="text-xs font-medium text-red-700">"{obj.objection}"</p>
                  <Badge
                    variant="outline"
                    className={`text-xs ${
                      obj.confidence === "high"
                        ? "bg-red-50 text-red-700"
                        : obj.confidence === "medium"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-gray-50"
                    }`}
                  >
                    {obj.confidence} likelihood
                  </Badge>
                </div>
                <div className="flex items-start gap-1.5 mt-1.5">
                  <ArrowRight className="h-3 w-3 text-green-600 mt-0.5 shrink-0" />
                  <p className="text-xs text-green-700">{obj.response}</p>
                </div>
              </div>
            ))}
          </TabsContent>

          {/* Next Call Coaching */}
          <TabsContent value="call" className="mt-3 space-y-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Call Objectives</p>
              <ul className="space-y-1">
                {coaching.nextCallCoaching.objectives.map((obj, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-xs">
                    <CheckCircle2 className="h-3 w-3 text-blue-600 shrink-0" />
                    {obj}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Questions to Ask</p>
              <ul className="space-y-1">
                {coaching.nextCallCoaching.questionsToAsk.map((q, idx) => (
                  <li key={idx} className="text-xs p-1.5 bg-muted/50 rounded">
                    "{q}"
                  </li>
                ))}
              </ul>
            </div>

            <div className="p-2 bg-blue-50 rounded border border-blue-100">
              <p className="text-xs font-medium text-blue-700 mb-1">Closing Strategy</p>
              <p className="text-xs text-blue-800">{coaching.nextCallCoaching.closingStrategy}</p>
            </div>
          </TabsContent>

          {/* Follow-up Guidance */}
          <TabsContent value="followup" className="mt-3 space-y-3">
            <div className="p-2 bg-violet-50 rounded border border-violet-100">
              <p className="text-xs font-medium text-violet-700 mb-1">Recommended Cadence</p>
              <p className="text-sm font-medium text-violet-900">{coaching.followUpGuidance.recommendedCadence}</p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Preferred Channels</p>
              <div className="flex gap-1.5">
                {coaching.followUpGuidance.channels.map((channel, idx) => (
                  <Badge key={idx} variant="outline" className="text-xs">
                    {channel}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Content to Send</p>
              <ul className="space-y-1">
                {coaching.followUpGuidance.contentSuggestions.map((content, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-xs">
                    <Sparkles className="h-3 w-3 text-violet-500 shrink-0" />
                    {content}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="text-xs font-medium text-red-600 mb-1.5">Escalation Triggers</p>
              <ul className="space-y-1">
                {coaching.followUpGuidance.escalationTriggers.map((trigger, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-xs text-red-700">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {trigger}
                  </li>
                ))}
              </ul>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
