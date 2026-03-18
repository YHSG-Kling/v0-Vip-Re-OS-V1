"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { createClient } from "@/lib/supabase/client"
import {
  Hand,
  Phone,
  Mail,
  MessageSquare,
  Clock,
  Copy,
  CheckCircle2,
  Sparkles,
} from "lucide-react"

interface FirstHumanTouchCardProps {
  contactId: string
  contactName: string
  contactPhone?: string | null
  contactEmail?: string | null
}

interface TouchRecommendation {
  channel: "phone" | "email" | "sms"
  timing: string
  conversationStarter: string
  reasonForChannel: string
  bestTimeToReach: string | null
  talkingPoints: string[]
}

export function FirstHumanTouchCard({
  contactId,
  contactName,
  contactPhone,
  contactEmail,
}: FirstHumanTouchCardProps) {
  const [recommendation, setRecommendation] = useState<TouchRecommendation | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    async function loadRecommendation() {
      const supabase = createClient()

      // Get qualification signals to determine best approach
      const { data: qualification } = await supabase
        .from("ai_isa_qualifications")
        .select("qualification_signals, urgency_level")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      // Get engagement history to see preferred channel
      const { data: engagements } = await supabase
        .from("ai_isa_engagement_tracking")
        .select("channel, event_type, metadata")
        .eq("contact_id", contactId)
        .in("event_type", ["positive_response", "opened", "clicked", "replied"])
        .order("created_at", { ascending: false })
        .limit(5)

      const signals = qualification?.qualification_signals || {}
      const urgency = qualification?.urgency_level || "medium"

      // Determine best channel based on engagement history
      const channelResponses = (engagements || []).reduce((acc: Record<string, number>, e: any) => {
        acc[e.channel] = (acc[e.channel] || 0) + 1
        return acc
      }, {})

      let bestChannel: "phone" | "email" | "sms" = "phone"
      if (channelResponses.email > (channelResponses.phone || 0)) {
        bestChannel = "email"
      } else if (channelResponses.sms > (channelResponses.phone || 0)) {
        bestChannel = "sms"
      }

      // If no phone, fall back to email
      if (bestChannel === "phone" && !contactPhone) {
        bestChannel = contactEmail ? "email" : "sms"
      }

      // Generate conversation starter based on context
      let conversationStarter = ""
      const firstName = contactName.split(" ")[0]

      if (signals.appointment_intent || signals.appointment_requested) {
        conversationStarter = `Hi ${firstName}, this is [Your Name]. I understand you're interested in scheduling a time to discuss your real estate needs. I'm following up to find a time that works best for you.`
      } else if (signals.positive_response_context) {
        conversationStarter = `Hi ${firstName}, this is [Your Name]. I saw that you recently expressed interest in ${signals.positive_response_context}. I'd love to help you take the next step.`
      } else if (signals.motivation_indicators?.includes("relocating")) {
        conversationStarter = `Hi ${firstName}, this is [Your Name]. I understand you may be planning a move. I specialize in helping people navigate relocations smoothly. When would be a good time to chat?`
      } else {
        conversationStarter = `Hi ${firstName}, this is [Your Name]. I'm reaching out to personally introduce myself and learn more about your real estate goals. Do you have a few minutes to chat?`
      }

      // Build talking points
      const talkingPoints: string[] = []
      if (signals.timeline) talkingPoints.push(`Timeline: ${signals.timeline}`)
      if (signals.budget) talkingPoints.push(`Budget discussed: ${signals.budget}`)
      if (signals.preferred_areas) talkingPoints.push(`Interested areas: ${signals.preferred_areas}`)
      if (signals.property_type) talkingPoints.push(`Looking for: ${signals.property_type}`)
      if (signals.financing_status) talkingPoints.push(`Financing: ${signals.financing_status}`)
      if (signals.pain_points) talkingPoints.push(`Key concern: ${signals.pain_points}`)

      // Determine timing
      let timing = "Within 24 hours"
      if (urgency === "urgent") timing = "Immediately"
      else if (urgency === "high") timing = "Within 4 hours"

      setRecommendation({
        channel: bestChannel,
        timing,
        conversationStarter,
        reasonForChannel: channelResponses[bestChannel]
          ? `Contact responded positively to ${bestChannel} in the past`
          : bestChannel === "phone"
          ? "Phone typically has highest conversion for first human touch"
          : "Based on available contact information",
        bestTimeToReach: signals.best_time_to_call || signals.preferred_contact_time || null,
        talkingPoints,
      })
      setLoading(false)
    }

    if (contactId) {
      loadRecommendation()
    }
  }, [contactId, contactName, contactPhone, contactEmail])

  const handleCopy = async () => {
    if (recommendation) {
      await navigator.clipboard.writeText(recommendation.conversationStarter)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const getChannelIcon = (channel: string) => {
    switch (channel) {
      case "phone":
        return <Phone className="h-4 w-4" />
      case "email":
        return <Mail className="h-4 w-4" />
      case "sms":
        return <MessageSquare className="h-4 w-4" />
      default:
        return <Phone className="h-4 w-4" />
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Hand className="h-4 w-4 text-blue-600" />
            First Human Touch
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!recommendation) {
    return null
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Hand className="h-4 w-4 text-blue-600" />
            First Human Touch
          </CardTitle>
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
            <Clock className="h-3 w-3 mr-1" />
            {recommendation.timing}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Recommended Channel */}
        <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-100">
          <div className="flex items-center gap-2">
            {getChannelIcon(recommendation.channel)}
            <div>
              <p className="text-sm font-medium text-blue-900 capitalize">
                {recommendation.channel} First
              </p>
              <p className="text-xs text-blue-600">{recommendation.reasonForChannel}</p>
            </div>
          </div>
          {recommendation.channel === "phone" && contactPhone && (
            <Button size="sm" variant="default" asChild>
              <a href={`tel:${contactPhone}`}>
                <Phone className="h-3.5 w-3.5 mr-1" />
                Call Now
              </a>
            </Button>
          )}
          {recommendation.channel === "email" && contactEmail && (
            <Button size="sm" variant="default" asChild>
              <a href={`mailto:${contactEmail}`}>
                <Mail className="h-3.5 w-3.5 mr-1" />
                Email Now
              </a>
            </Button>
          )}
        </div>

        {/* Best Time */}
        {recommendation.bestTimeToReach && (
          <div className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span>Best time: <span className="font-medium">{recommendation.bestTimeToReach}</span></span>
          </div>
        )}

        {/* Conversation Starter */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-violet-500" />
              AI-Generated Conversation Starter
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <CheckCircle2 className="h-3 w-3 mr-1 text-green-600" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 mr-1" />
                  Copy
                </>
              )}
            </Button>
          </div>
          <p className="text-sm p-3 bg-muted/50 rounded-lg border italic">
            {recommendation.conversationStarter}
          </p>
        </div>

        {/* Talking Points */}
        {recommendation.talkingPoints.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Key Talking Points</p>
            <ul className="space-y-1">
              {recommendation.talkingPoints.map((point, idx) => (
                <li key={idx} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
