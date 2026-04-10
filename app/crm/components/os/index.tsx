"use client"

/**
 * Contact OS Components — 10 fully-implemented panels for the CRM contact detail view.
 * All reads/writes use Supabase via server actions. No mock data.
 */

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { sendPortalMessage, getPortalMessages, generateAIDraft } from "@/app/actions/portal-messages"
import { askRelationshipAI } from "@/app/crm/actions/ask-relationship-ai"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Zap, Brain, MessageSquare, TrendingUp, Gift, Users,
  Clock, Loader2, Sparkles, Send, ChevronRight,
  Star, AlertTriangle, CheckCircle, Home, Search
} from "lucide-react"
import { format } from "date-fns"

// ─── 1. CONTACT COMMAND STRIP ─────────────────────────────────────────────────

interface ContactCommandStripProps {
  contact: any
  churnRisk: any
  autopilotPlans: any[]
  agentId: string
  onEnableAutopilot: (level: "conservative" | "moderate" | "aggressive") => void
  onToggleAutopilot: (planId: string, pause: boolean) => void
  onShareSocialPost?: () => void
  loading: boolean
}

export function ContactCommandStrip({
  contact,
  churnRisk,
  autopilotPlans,
  agentId,
  onEnableAutopilot,
  onToggleAutopilot,
  onShareSocialPost,
  loading,
}: ContactCommandStripProps) {
  const activePlan = autopilotPlans.find(
    (p: any) => p.contact_id === contact?.id || p.lead_id === contact?.id
  )

  // Check if this is a seller contact (has contact_persona = 'Listing Seller')
  const isSeller = contact?.contact_persona === "Listing Seller"

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card flex-wrap">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Churn risk badge */}
        {churnRisk?.churn_probability != null && (
          <Badge
            className={cn(
              "text-xs border-0",
              churnRisk.churn_probability > 0.7
                ? "bg-red-100 text-red-700"
                : churnRisk.churn_probability > 0.4
                ? "bg-amber-100 text-amber-700"
                : "bg-green-100 text-green-700"
            )}
          >
            <AlertTriangle className="h-3 w-3 mr-1" />
            Churn risk {Math.round(churnRisk.churn_probability * 100)}%
          </Badge>
        )}

        {/* Autopilot status */}
        {activePlan ? (
          <Badge className="text-xs bg-indigo-100 text-indigo-700 border-0">
            <Zap className="h-3 w-3 mr-1" />
            AI-ISA Active
          </Badge>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2 flex-wrap">
        {/* Share Social Post button - only for sellers */}
        {isSeller && onShareSocialPost && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={onShareSocialPost}
          >
            <MessageSquare className="h-3 w-3 mr-1" />
            Share Social Post
          </Button>
        )}
        
        {!activePlan ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={loading}
            onClick={() => onEnableAutopilot("moderate")}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Zap className="h-3 w-3 mr-1" />}
            Enable AI-ISA
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={loading}
            onClick={() => onToggleAutopilot(activePlan.id, !activePlan.is_paused)}
          >
            {activePlan.is_paused ? "Resume AI-ISA" : "Pause AI-ISA"}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── 2. RELATIONSHIP RADAR ────────────────────────────────────────────────────

interface RelationshipRadarProps {
  contactId: string
  engagementScore?: number | null
  daysSinceContact?: number | null
  messageTemperature?: "hot" | "warm" | "cool" | null
  referralPotential?: "high" | "medium" | "low" | null
  openThreadCount?: number
}

export function RelationshipRadar({
  contactId,
  engagementScore,
  daysSinceContact,
  referralPotential,
  openThreadCount = 0,
}: RelationshipRadarProps) {
  const score = engagementScore ?? 0

  const getScoreColor = (s: number) => {
    if (s >= 70) return "text-green-600"
    if (s >= 40) return "text-amber-600"
    return "text-red-600"
  }

  const getDaysColor = (d: number | null) => {
    if (d == null) return "text-muted-foreground"
    if (d <= 7) return "text-green-600"
    if (d <= 21) return "text-amber-600"
    return "text-red-600"
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-600" />
          Relationship Radar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Engagement score */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Engagement Score</span>
            <span className={cn("font-semibold", getScoreColor(score))}>
              {score}/100
            </span>
          </div>
          <Progress value={score} className="h-1.5" />
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          {/* Days since contact */}
          <div className="rounded-md bg-muted/40 p-2 space-y-0.5">
            <p className="text-muted-foreground">Last Touch</p>
            <p className={cn("font-medium", getDaysColor(daysSinceContact))}>
              {daysSinceContact == null
                ? "Never"
                : daysSinceContact === 0
                ? "Today"
                : `${daysSinceContact}d ago`}
            </p>
          </div>

          {/* Open threads */}
          <div className="rounded-md bg-muted/40 p-2 space-y-0.5">
            <p className="text-muted-foreground">Open Threads</p>
            <p className="font-medium">{openThreadCount}</p>
          </div>

          {/* Referral potential */}
          <div className="rounded-md bg-muted/40 p-2 space-y-0.5 col-span-2">
            <p className="text-muted-foreground">Referral Potential</p>
            <p
              className={cn(
                "font-medium capitalize",
                referralPotential === "high"
                  ? "text-green-600"
                  : referralPotential === "medium"
                  ? "text-amber-600"
                  : "text-muted-foreground"
              )}
            >
              {referralPotential ?? "Unknown"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── 3. COMMUNICATION HEALTH PANEL ───────────────────────────────────────────

interface CommunicationHealthPanelProps {
  conversations: any[]
  agentId: string
  contactId: string
  onLoadDraft?: (conversationId: string) => void
  /** When the parent generates an AI draft it passes the text here to pre-fill the compose area */
  initialDraft?: string | null
  /** Called after the compose area consumes the initial draft so the parent can clear it */
  onDraftConsumed?: () => void
}

export function CommunicationHealthPanel({
  conversations,
  agentId,
  contactId,
  onLoadDraft,
  initialDraft,
  onDraftConsumed,
}: CommunicationHealthPanelProps) {
  const [messages, setMessages] = useState<any[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const [compose, setCompose] = useState("")
  const [draftLoading, setDraftLoading] = useState(false)
  const [sending, setSending] = useState(false)

  // Sync initialDraft from parent into compose area whenever it changes
  useEffect(() => {
    if (initialDraft) {
      setCompose(initialDraft)
      onDraftConsumed?.()
    }
  }, [initialDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMessages = useCallback(async () => {
    setLoadingMessages(true)
    try {
      const result = await getPortalMessages(contactId)
      if (result.success) {
        setMessages(result.messages?.slice(-10) ?? [])
      }
    } catch {
      // non-blocking
    } finally {
      setLoadingMessages(false)
    }
  }, [contactId])

  useEffect(() => {
    if (contactId) loadMessages()
  }, [contactId, loadMessages])

  const handleGenerateDraft = async () => {
    setDraftLoading(true)
    try {
      const result = await generateAIDraft({ contactId, agentId })
      if (result.success && result.draft) {
        setCompose(result.draft)
        toast.success("AI draft ready — review before sending")
      } else {
        toast.error(result.error ?? "Failed to generate draft")
      }
    } finally {
      setDraftLoading(false)
    }
  }

  const handleSend = async () => {
    if (!compose.trim()) return
    setSending(true)
    try {
      const result = await sendPortalMessage({
        contactId,
        messageBody: compose.trim(),
        direction: "agent_to_client",
      })
      if (result.success) {
        setCompose("")
        toast.success("Message sent")
        await loadMessages()
      } else {
        toast.error(result.error ?? "Failed to send message")
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-600" />
          Message Thread
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Recent messages */}
        {loadingMessages ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3">
            No messages yet. Send the first message.
          </p>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex text-xs",
                  msg.direction === "agent_to_client" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-lg px-3 py-2",
                    msg.direction === "agent_to_client"
                      ? "bg-blue-600 text-white"
                      : "bg-muted text-foreground"
                  )}
                >
                  <p>{msg.body}</p>
                  <p
                    className={cn(
                      "text-[10px] mt-0.5 text-right",
                      msg.direction === "agent_to_client" ? "text-blue-200" : "text-muted-foreground"
                    )}
                  >
                    {format(new Date(msg.created_at), "MMM d, h:mm a")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Compose area */}
        <div className="space-y-2">
          <Textarea
            placeholder="Type a message..."
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            rows={3}
            className="text-sm resize-none"
            disabled={sending}
          />
          <div className="flex items-center gap-2 justify-between">
            <Button
              size="sm"
              variant="outline"
              onClick={handleGenerateDraft}
              disabled={draftLoading || sending}
              className="h-8 text-xs"
            >
              {draftLoading ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Sparkles className="h-3 w-3 mr-1 text-indigo-500" />
              )}
              AI Draft
            </Button>
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!compose.trim() || sending}
              className="h-8 text-xs bg-blue-600 hover:bg-blue-700 text-white"
            >
              {sending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Send className="h-3 w-3 mr-1" />
              )}
              Send
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── 4. NEXT BEST ACTION PANEL ────────────────────────────────────────────────

interface NextBestActionPanelProps {
  suggestedActions: any[]
  contactId: string
  contactPhone?: string
  contactEmail?: string
  onSendMessage: (channel: string) => void
  onLogActivity: () => void
  onOpenPortal: () => void
}

export function NextBestActionPanel({
  suggestedActions,
  contactId,
  contactPhone,
  contactEmail,
  onSendMessage,
  onLogActivity,
  onOpenPortal,
}: NextBestActionPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500" />
          Next Best Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {suggestedActions.length > 0 ? (
          suggestedActions.slice(0, 3).map((action: any, i: number) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-md border p-2 text-xs"
            >
              <ChevronRight className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-foreground">{action.title ?? action.action ?? action}</p>
                {action.reason && (
                  <p className="text-muted-foreground mt-0.5 truncate">{action.reason}</p>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">No suggestions available</p>
        )}

        {/* Quick-action buttons */}
        <div className="flex flex-wrap gap-2 pt-1">
          {contactPhone && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => window.open(`tel:${contactPhone}`)}
            >
              Call
            </Button>
          )}
          {contactEmail && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => window.open(`mailto:${contactEmail}`)}
            >
              Email
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onSendMessage("sms")}
          >
            Text
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={onOpenPortal}
          >
            Portal
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── 5. VALUE DELIVERED PANEL ─────────────────────────────��───────────────────

interface ValueDeliveredPanelProps {
  contactId: string
  agentId: string
  valueMetrics: any
}

export function ValueDeliveredPanel({ contactId, agentId, valueMetrics }: ValueDeliveredPanelProps) {
  const [data, setData] = useState<{
    total_touchpoints: number
    total_messages: number
    listings_shared: number
    showings_scheduled: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!contactId) return
    const supabase = createClient()
    Promise.all([
      supabase
        .from("activities")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", contactId),
      supabase
        .from("client_portal_messages")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", contactId),
      supabase
        .from("showings")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", contactId),
    ])
      .then(([acts, msgs, shows]) => {
        setData({
          total_touchpoints: acts.count ?? 0,
          total_messages: msgs.count ?? 0,
          listings_shared: 0,
          showings_scheduled: shows.count ?? 0,
        })
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [contactId])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Star className="h-4 w-4 text-yellow-500" />
          Value Delivered
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : data ? (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              { label: "Activities", value: data.total_touchpoints },
              { label: "Messages", value: data.total_messages },
              { label: "Showings", value: data.showings_scheduled },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-md bg-muted/40 p-2 text-center">
                <p className="text-lg font-bold">{value}</p>
                <p className="text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No data available</p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── 6. REFERRAL LIKELIHOOD PANEL ────────────────────────────────────────────

interface ReferralLikelihoodPanelProps {
  contactId: string
  agentId: string
  referralPotential?: "high" | "medium" | "low" | null
  onGenerateAsk: () => void
  generating: boolean
}

export function ReferralLikelihoodPanel({
  contactId,
  referralPotential,
  onGenerateAsk,
  generating,
}: ReferralLikelihoodPanelProps) {
  const [referralCount, setReferralCount] = useState<number | null>(null)

  useEffect(() => {
    if (!contactId) return
    const supabase = createClient()
    supabase
      .from("referrals")
      .select("id", { count: "exact", head: true })
      .eq("referred_contact_id", contactId)
      .then(({ count }) => setReferralCount(count ?? 0))
      .catch(() => {})
  }, [contactId])

  const potentialScore =
    referralPotential === "high" ? 80 : referralPotential === "medium" ? 50 : 20

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Users className="h-4 w-4 text-green-600" />
          Referral Likelihood
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Potential</span>
            <span
              className={cn(
                "font-medium capitalize",
                referralPotential === "high"
                  ? "text-green-600"
                  : referralPotential === "medium"
                  ? "text-amber-600"
                  : "text-muted-foreground"
              )}
            >
              {referralPotential ?? "Unknown"}
            </span>
          </div>
          <Progress value={potentialScore} className="h-1.5" />
        </div>

        {referralCount !== null && (
          <p className="text-xs text-muted-foreground">
            {referralCount === 0
              ? "No referrals given yet"
              : `${referralCount} referral${referralCount !== 1 ? "s" : ""} given`}
          </p>
        )}

        <Button
          size="sm"
          variant="outline"
          className="w-full h-8 text-xs"
          disabled={generating}
          onClick={onGenerateAsk}
        >
          {generating ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Gift className="h-3 w-3 mr-1" />
          )}
          Generate Referral Ask
        </Button>
      </CardContent>
    </Card>
  )
}

// ─── 7. TIMELINE CONTEXT PANEL ────────────────────────────────────────────────

interface TimelineContextPanelProps {
  contactId: string
  originalLeadSource?: string | null
  createdAt?: string | null
  isaHandoffContext?: {
    qualificationScore?: number
    qualificationResult?: string
    qualificationSignals?: Record<string, any>
    assignedAt?: string
  } | null
}

export function TimelineContextPanel({
  contactId,
  originalLeadSource,
  createdAt,
  isaHandoffContext,
}: TimelineContextPanelProps) {
  const [activities, setActivities] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!contactId) return
    const supabase = createClient()
    supabase
      .from("activities")
      .select("id, activity_type, title, description, created_at, status")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => setActivities(data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [contactId])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Clock className="h-4 w-4 text-slate-500" />
          Timeline
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Lead source & created */}
        <div className="text-xs space-y-1">
          {originalLeadSource && (
            <p className="text-muted-foreground">
              Source: <span className="text-foreground font-medium">{originalLeadSource}</span>
            </p>
          )}
          {createdAt && (
            <p className="text-muted-foreground">
              Added: <span className="text-foreground font-medium">{format(new Date(createdAt), "MMM d, yyyy")}</span>
            </p>
          )}
        </div>

        {/* ISA handoff context */}
        {isaHandoffContext && (
          <div className="rounded-md bg-indigo-50 border border-indigo-100 p-2 text-xs">
            <p className="font-medium text-indigo-700">ISA Qualified</p>
            {isaHandoffContext.qualificationScore != null && (
              <p className="text-indigo-600">Score: {isaHandoffContext.qualificationScore}/100</p>
            )}
            {isaHandoffContext.qualificationResult && (
              <p className="text-indigo-600 capitalize">{isaHandoffContext.qualificationResult}</p>
            )}
          </div>
        )}

        {/* Recent activities */}
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : activities.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity recorded yet</p>
        ) : (
          <div className="space-y-1.5">
            {activities.map((act) => (
              <div key={act.id} className="flex items-start gap-2 text-xs">
                <CheckCircle className="h-3.5 w-3.5 mt-0.5 text-green-500 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium truncate">{act.title ?? act.activity_type}</p>
                  <p className="text-muted-foreground">
                    {format(new Date(act.created_at), "MMM d, h:mm a")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── 8. RELATIONSHIP AI CHAT PANEL ───────────────────────────────────────────

interface RelationshipAiChatPanelProps {
  contactId: string
  agentId: string
  contactName: string
  contactPersona?: string | null
}

export function RelationshipAiChatPanel({
  contactId,
  agentId,
  contactName,
  contactPersona,
}: RelationshipAiChatPanelProps) {
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleAsk = async () => {
    if (!question.trim()) return
    console.log("[v0] Relationship AI - Sending question:", question)
    setLoading(true)
    setAnswer(null)
    try {
      const result = await askRelationshipAI({ question, contactName, contactPersona })
      console.log("[v0] Relationship AI - Received result:", result)
      const answerText = result.success ? (result.answer ?? "No response.") : (result.error ?? "Failed to generate advice.")
      console.log("[v0] Relationship AI - Setting answer:", answerText)
      setAnswer(answerText)
    } catch (error) {
      console.error("[v0] Relationship AI - Error:", error)
      setAnswer("An error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Brain className="h-4 w-4 text-violet-600" />
          Relationship AI
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Ask about ${contactName}…`}
            className="text-xs h-8"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) handleAsk()
            }}
            disabled={loading}
          />
          <Button
            size="sm"
            className="h-8 shrink-0"
            onClick={handleAsk}
            disabled={!question.trim() || loading}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {answer && (
          <div className="rounded-md bg-violet-50 border border-violet-100 p-2.5 text-xs text-violet-900">
            {console.log("[v0] Relationship AI - Rendering answer:", answer)}
            {answer}
          </div>
        )}

        {/* Suggested questions */}
        {!answer && (
          <div className="flex flex-wrap gap-1">
            {[
              "How should I follow up?",
              "What objections might they have?",
              "Best time to reach out?",
            ].map((q) => (
              <button
                key={q}
                className="text-[10px] rounded border px-2 py-0.5 hover:bg-muted transition-colors text-muted-foreground"
                onClick={() => setQuestion(q)}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── 9. SMART NOTE COMPOSER ───────────────────────────────────────────────────

interface SmartNoteComposerProps {
  contactId: string
  agentId: string
  contactName: string
  onSaveNote: (note: string) => Promise<void>
  saving: boolean
}

export function SmartNoteComposer({
  contactId,
  contactName,
  onSaveNote,
  saving,
}: SmartNoteComposerProps) {
  const [note, setNote] = useState("")
  const [recentNotes, setRecentNotes] = useState<any[]>([])
  const [loadingNotes, setLoadingNotes] = useState(true)

  useEffect(() => {
    if (!contactId) return
    const supabase = createClient()
    supabase
      .from("activities")
      .select("id, description, created_at")
      .eq("contact_id", contactId)
      .eq("activity_type", "note")
      .order("created_at", { ascending: false })
      .limit(3)
      .then(({ data }) => setRecentNotes(data ?? []))
      .catch(() => {})
      .finally(() => setLoadingNotes(false))
  }, [contactId])

  const handleSave = async () => {
    if (!note.trim()) return
    await onSaveNote(note)
    setNote("")
    // Reload notes
    const supabase = createClient()
    supabase
      .from("activities")
      .select("id, description, created_at")
      .eq("contact_id", contactId)
      .eq("activity_type", "note")
      .order("created_at", { ascending: false })
      .limit(3)
      .then(({ data }) => setRecentNotes(data ?? []))
      .catch(() => {})
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-500" />
          Notes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Recent notes */}
        {loadingNotes ? (
          <Skeleton className="h-10 w-full" />
        ) : recentNotes.length > 0 ? (
          <div className="space-y-1.5">
            {recentNotes.map((n) => (
              <div key={n.id} className="text-xs rounded-md bg-muted/40 p-2">
                <p className="text-foreground">{n.description}</p>
                <p className="text-muted-foreground mt-0.5">
                  {format(new Date(n.created_at), "MMM d, h:mm a")}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No notes yet</p>
        )}

        {/* New note composer */}
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`Add a note about ${contactName}…`}
          rows={2}
          className="text-xs resize-none"
          disabled={saving}
        />
        <Button
          size="sm"
          className="w-full h-8 text-xs"
          disabled={!note.trim() || saving}
          onClick={handleSave}
        >
          {saving ? (
            <><Loader2 className="h-3 w-3 animate-spin mr-1" />Saving...</>
          ) : (
            "Save Note"
          )}
        </Button>
      </CardContent>
    </Card>
  )
}

// ─── 10. BUYER MATCH PANEL ─────────────────────────────────────���──────────────

interface BuyerMatchPanelProps {
  contactId: string
  agentId: string
  isBuyerContact: boolean
  buyerStage?: string | null
  contactName: string
}

export function BuyerMatchPanel({
  contactId,
  agentId,
  buyerStage,
  contactName,
}: BuyerMatchPanelProps) {
  const [matches, setMatches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!contactId) return
    const supabase = createClient()
    supabase
      .from("property_alert_results")
      .select("id, property_address, city, state, list_price, bedrooms, bathrooms, sqft, match_score, delivered_at")
      .eq("contact_id", contactId)
      .order("match_score", { ascending: false })
      .limit(3)
      .then(({ data }) => setMatches(data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [contactId])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Home className="h-4 w-4 text-green-600" />
          Property Matches
          {buyerStage && (
            <Badge variant="outline" className="text-[10px] capitalize ml-1">
              {buyerStage.replace(/_/g, " ")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : matches.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-3">
            <Search className="h-4 w-4 mx-auto mb-1 opacity-40" />
            No property matches yet.
          </div>
        ) : (
          <div className="space-y-2">
            {matches.map((m) => (
              <div key={m.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between">
                  <p className="font-medium truncate">{m.property_address}</p>
                  {m.match_score != null && (
                    <Badge variant="secondary" className="text-[10px] shrink-0 ml-2">
                      {m.match_score}% match
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground">
                  {[m.city, m.state].filter(Boolean).join(", ")} &middot;{" "}
                  {m.bedrooms}bd / {m.bathrooms}ba
                  {m.list_price && (
                    <> &middot; ${Number(m.list_price).toLocaleString()}</>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
