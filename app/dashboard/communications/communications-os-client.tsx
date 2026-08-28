"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  CommunicationsCommandStrip,
  InboxRadar,
  ResponsePressurePanel,
  SentimentUrgencyPanel,
  SequenceExecutionPanel,
  AiReplyCoachPanel,
} from "./components/os"
import { ConversationActionPanel } from "./components/os/conversation-action-panel"
import { CommunicationHealthPanel } from "./components/os/communication-health-panel"
import { sendMessage, analyzeConversationHealth } from "@/app/actions/ai-communication-hub"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"

interface Conversation {
  id: string
  contact_id: string
  type: string
  unread_count: number
  contacts?: {
    id: string
    first_name: string
    last_name: string
    email?: string
    phone?: string
  }
}

interface Template {
  id: string
  name: string
  subject?: string
  body?: string
  channel: string
}

interface SequenceEnrollment {
  id: string
  contactName: string
  contactId: string
  sequenceName: string
  sequenceId: string
  currentStep: number
  totalSteps: number
  status: "active" | "paused" | "completed" | "failed"
  nextStepAt?: string
  nextStepChannel?: "email" | "sms"
}

// All supported channel types including social platforms
type ChannelType = "email" | "sms" | "voicemail" | "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "youtube" | "pinterest" | "google_business"

interface PressureItem {
  id: string
  contactName: string
  channel: ChannelType
  subject?: string
  preview: string
  waitingHours: number
  urgency: "critical" | "high" | "medium" | "low"
  sentiment?: string
  contactId: string
  conversationId: string
}

interface SentimentItem {
  id: string
  contactName: string
  contactId: string
  sentiment: "very_positive" | "positive" | "neutral" | "negative" | "very_negative"
  urgency: "critical" | "high" | "medium" | "low"
  trend: "improving" | "stable" | "declining"
  lastMessage: string
  requiresAction: boolean
}

interface SocialChannelCount {
  platform: string
  label: string
  unread: number
  connected?: boolean
}

interface ConnectedSocialAccount {
  id: string
  platform: string
  accountName: string
}

interface InboxStats {
  totalUnread: number
  emailUnread: number
  smsUnread: number
  voicemailCount: number
  urgentCount: number
  avgResponseTime: number
  responseTimeTrend: "up" | "down" | "stable"
  oldestUnreadHours: number
  // Social media stats
  socialChannels?: SocialChannelCount[]
  totalSocialUnread?: number
}

interface CommunicationsOSClientProps {
  brokerageId: string
  agentId: string
  userId: string
  role: string
  conversations: Conversation[]
  templates: Template[]
  sequenceEnrollments: SequenceEnrollment[]
  pressureItems: PressureItem[]
  sentimentItems: SentimentItem[]
  inboxStats: InboxStats
  connectedSocialAccounts?: ConnectedSocialAccount[]
  /** 30-day outbound message volume (lane E2 2026-08-28:
   *  getCommunicationStats WIRED — served by the page from the tenant-scoped
   *  messages ledger; null when the read was refused, rendered as unavailable
   *  rather than as zeros). */
  outboundStats?: { total: number; sms: number; email: number; call: number } | null
}

export function CommunicationsOSClient({
  brokerageId,
  agentId,
  userId,
  role,
  conversations,
  templates,
  sequenceEnrollments,
  pressureItems,
  sentimentItems,
  inboxStats,
  connectedSocialAccounts = [],
  outboundStats = null,
}: CommunicationsOSClientProps) {
  const router = useRouter()
  const [selectedConversation, setSelectedConversation] = useState<PressureItem | null>(null)
  const [showComposeDialog, setShowComposeDialog] = useState(false)
  const [composeChannel, setComposeChannel] = useState<"email" | "sms">("email")
  const [healthAnalysis, setHealthAnalysis] = useState<any>(null)
  const [replyCoachMessage, setReplyCoachMessage] = useState<string>("")

  // Helper to determine if channel is social
  const isSocialChannel = (channel: ChannelType): boolean => {
    return ["facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube", "pinterest", "google_business"].includes(channel)
  }

  // Get appropriate channel for sending based on conversation type
  const getSendableChannel = (channel: ChannelType): "email" | "sms" | "in_app" => {
    if (channel === "email") return "email"
    if (channel === "sms") return "sms"
    // Social channels and voicemail default to in_app for now
    return "in_app"
  }

  // Command Strip Handlers
  const handleComposeEmail = useCallback(() => {
    setComposeChannel("email")
    setShowComposeDialog(true)
  }, [])

  const handleComposeSms = useCallback(() => {
    setComposeChannel("sms")
    setShowComposeDialog(true)
  }, [])

  const handleStartCall = useCallback(() => {
    router.push("/dashboard/voice")
  }, [router])

  const handleQuickReply = useCallback(() => {
    if (pressureItems.length > 0) {
      setSelectedConversation(pressureItems[0])
    }
  }, [pressureItems])

  // Pressure Panel Handlers
  const handleReply = useCallback((item: PressureItem) => {
    setSelectedConversation(item)
    setReplyCoachMessage(item.preview)
  }, [])

  const handleGenerateResponse = useCallback((item: PressureItem) => {
    setSelectedConversation(item)
    setReplyCoachMessage(item.preview)
  }, [])

  const handleMarkRead = useCallback((item: PressureItem) => {
    toast.success("Marked as read")
  }, [])

  // Sentiment Panel Handlers
  const handleViewConversation = useCallback((contactId: string) => {
    router.push(`/dashboard/communications/inbox?contact=${contactId}`)
  }, [router])

  const handlePrioritize = useCallback(async (contactId: string) => {
    try {
      const result = await analyzeConversationHealth({
        contactId,
        agentId,
      })
      if (result.success && result.health) {
        setHealthAnalysis({ contactId, ...result.health })
      }
    } catch (err) {
      toast.error("Failed to analyze conversation")
    }
  }, [agentId])

  // Sequence Panel Handlers
  const handlePauseEnrollment = useCallback(async (enrollmentId: string) => {
    toast.success("Sequence paused")
  }, [])

  const handleResumeEnrollment = useCallback(async (enrollmentId: string) => {
    toast.success("Sequence resumed")
  }, [])

  const handleSkipStep = useCallback(async (enrollmentId: string) => {
    toast.success("Step skipped")
  }, [])

  const handleRemoveEnrollment = useCallback(async (enrollmentId: string) => {
    toast.success("Removed from sequence")
  }, [])

  const handleViewSequence = useCallback((sequenceId: string) => {
    router.push(`/dashboard/campaigns/sequences/${sequenceId}`)
  }, [router])

  // Action Panel Handlers
  const handleSendMessage = useCallback(async (params: {
    channel: "email" | "sms" | "in_app"
    body: string
    subject?: string
  }) => {
    if (!selectedConversation) return

    const result = await sendMessage({
      conversationId: selectedConversation.conversationId,
      contactId: selectedConversation.contactId,
      agentId,
      channel: params.channel,
      body: params.body,
      subject: params.subject,
    })

    if (result.success) {
      toast.success("Message sent")
      setSelectedConversation(null)
    } else {
      toast.error(result.error || "Failed to send message")
    }
  }, [selectedConversation, agentId])

  const handleAddToSequence = useCallback(async (sequenceId: string) => {
    toast.success("Added to sequence")
  }, [])

  const handleScheduleFollowUp = useCallback(async (date: Date) => {
    toast.success(`Follow-up scheduled for ${date.toLocaleDateString()}`)
  }, [])

  const handleEscalate = useCallback(async () => {
    toast.success("Escalated to team lead")
  }, [])

  const handleMarkNeedsAttention = useCallback(async () => {
    toast.success("Marked as needs attention")
  }, [])

  // AI Reply Coach Handlers
  const handleApplyResponse = useCallback((response: string) => {
    toast.success("Response applied to composer")
  }, [])

  // Calculate grand total including social
  const grandTotalUnread = inboxStats.totalUnread + (inboxStats.totalSocialUnread ?? 0)

  return (
    <div className="min-h-screen bg-background">
      <div className="p-6 space-y-6">
        {/* Command Strip */}
        <CommunicationsCommandStrip
          onComposeEmail={handleComposeEmail}
          onComposeSms={handleComposeSms}
          onStartCall={handleStartCall}
          onQuickReply={handleQuickReply}
          unreadCount={grandTotalUnread}
          urgentCount={inboxStats.urgentCount}
        />

        {/* Inbox Radar - Now includes social channels */}
        <InboxRadar
          totalUnread={inboxStats.totalUnread}
          emailUnread={inboxStats.emailUnread}
          smsUnread={inboxStats.smsUnread}
          voicemailCount={inboxStats.voicemailCount}
          urgentCount={inboxStats.urgentCount}
          avgResponseTime={inboxStats.avgResponseTime}
          responseTimeTrend={inboxStats.responseTimeTrend}
          oldestUnreadHours={inboxStats.oldestUnreadHours}
          socialChannels={inboxStats.socialChannels}
          totalSocialUnread={inboxStats.totalSocialUnread}
        />

        {/* Outbound volume strip — last 30 days, from the messages ledger */}
        {outboundStats && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border bg-card px-4 py-2 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sent (30d)</span>
            <span><span className="font-semibold">{outboundStats.total}</span> total</span>
            <span className="text-muted-foreground">{outboundStats.email} email</span>
            <span className="text-muted-foreground">{outboundStats.sms} SMS</span>
            <span className="text-muted-foreground">{outboundStats.call} call</span>
          </div>
        )}

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {/* Response Pressure Panel */}
          <ResponsePressurePanel
            items={pressureItems as any}
            onReply={handleReply}
            onGenerateResponse={handleGenerateResponse}
            onMarkRead={handleMarkRead}
          />

          {/* Sentiment & Urgency Panel */}
          <SentimentUrgencyPanel
            items={sentimentItems}
            onViewConversation={handleViewConversation}
            onPrioritize={handlePrioritize}
          />

          {/* Sequence Execution Panel */}
          <SequenceExecutionPanel
            enrollments={sequenceEnrollments}
            onPause={handlePauseEnrollment}
            onResume={handleResumeEnrollment}
            onSkipStep={handleSkipStep}
            onRemove={handleRemoveEnrollment}
            onViewSequence={handleViewSequence}
          />
        </div>

        {/* Selected Conversation Action Area */}
        {selectedConversation && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Conversation Action Panel */}
            <ConversationActionPanel
              contactId={selectedConversation.contactId}
              contactName={selectedConversation.contactName}
              conversationId={selectedConversation.conversationId}
              channel={getSendableChannel(selectedConversation.channel)}
              templates={templates as any}
              onSendMessage={handleSendMessage}
              onAddToSequence={handleAddToSequence}
              onScheduleFollowUp={handleScheduleFollowUp}
              onEscalate={handleEscalate}
              onMarkNeedsAttention={handleMarkNeedsAttention}
            />

            {/* AI Reply Coach */}
            <AiReplyCoachPanel
              sessionId={selectedConversation.conversationId}
              contactId={selectedConversation.contactId}
              agentId={agentId}
              brokerageId={brokerageId}
              incomingMessage={replyCoachMessage || selectedConversation.preview}
              channel={getSendableChannel(selectedConversation.channel) as any}
              contactName={selectedConversation.contactName}
              onApplyResponse={handleApplyResponse}
              onSendResponse={async (response) => {
                await handleSendMessage({
                  channel: getSendableChannel(selectedConversation.channel),
                  body: response,
                })
              }}
            />
          </div>
        )}

        {/* Communication Health Panel (when analysis is available) */}
        {healthAnalysis && (
          <CommunicationHealthPanel
            contactId={healthAnalysis.contactId}
            contactName="Selected Contact"
            overallHealth={healthAnalysis.overallHealth || "fair"}
            healthScore={healthAnalysis.healthScore || 50}
            engagementLevel={healthAnalysis.engagementLevel || "passive"}
            sentimentTrend={healthAnalysis.sentimentTrend || "stable"}
            communicationBalance={healthAnalysis.communicationBalance || "Balanced"}
            responsiveness={healthAnalysis.responsiveness || "Average"}
            keyInsights={healthAnalysis.keyInsights || []}
            riskFactors={healthAnalysis.riskFactors || []}
            recommendations={healthAnalysis.recommendations || []}
            suggestedNextOutreach={healthAnalysis.suggestedNextOutreach}
            onViewFullAnalysis={() => {
              router.push(`/dashboard/communications/intelligence?contact=${healthAnalysis.contactId}`)
            }}
          />
        )}
      </div>

      {/* Compose Dialog */}
      <Dialog open={showComposeDialog} onOpenChange={setShowComposeDialog}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              New {composeChannel === "email" ? "Email" : "SMS"}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-muted-foreground text-sm">
              Select a contact from your inbox to compose a message, or go to the full inbox view.
            </p>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => {
                  setShowComposeDialog(false)
                  router.push("/dashboard/communications/inbox")
                }}
                className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
              >
                Open Inbox
              </button>
              <button
                onClick={() => setShowComposeDialog(false)}
                className="px-4 py-2 border rounded-md hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
