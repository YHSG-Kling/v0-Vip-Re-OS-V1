"use client"

import { useState, useCallback, useTransition, useEffect, useRef } from "react"
import { ChevronLeft } from "lucide-react"
import ConversationList from "./components/ConversationList"
import MessageThread from "./components/MessageThread"
import ComposeBar from "./components/ComposeBar"
import ContactDetailPane from "./components/ContactDetailPane"
import {
  getMessageThread,
  sendMessage,
  markConversationRead,
  analyzeMessageSentiment,
  generateSmartResponse,
} from "@/app/actions/ai-communication-hub"
import { getLeadThreadMessages, convertLeadFromInbox } from "@/app/actions/inbox"
import { analyzeConversation } from "@/app/actions/ai-predictions"
import { Sparkles, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"
import AIReplyCoachPanel from "./components/AIReplyCoachPanel"
import { toast } from "sonner"

type Conversation = {
  id: string
  type: string
  unread_count: number
  last_message_at: string
  sentiment?: string
  urgency_score?: number
  contacts?: {
    id: string
    first_name: string
    last_name: string
    email?: string
    phone?: string
    lifecycle_state: string
    lead_score?: number
    tcpa_consent?: boolean | null
    call_stop_flag?: boolean | null
  } | null
  last_message_preview?: string
  // AI-ISA LEAD threads (leads are NOT contacts): id is `lead:<leads.id>`
  party?: "lead"
  lead_id?: string
  lead_name?: string
}

type EmailTemplate = {
  id: string
  name: string
  subject?: string
  body?: string
  channel?: string
}

interface InboxClientProps {
  conversations: Conversation[]
  emailTemplates: EmailTemplate[]
  brokerageId: string
  agentId: string
  userId: string
  role: string
  assistantName: string
  /** Optional: show AI Reply Coach panel. Defaults to true. */
  showReplyCoach?: boolean
}

export default function InboxClient({
  conversations: initialConversations,
  emailTemplates,
  brokerageId,
  agentId,
  userId,
  role,
  assistantName,
  showReplyCoach = true,
}: InboxClientProps) {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [sentiment, setSentiment] = useState<any | null>(null)
  const [mobileView, setMobileView] = useState<"list" | "thread">("list")
  const [, startTransition] = useTransition()
  const realtimeRef = useRef<ReturnType<typeof createClient> | null>(null)
  // AI Reply Coach — track latest inbound message
  const [lastInboundId, setLastInboundId]     = useState<string | undefined>(undefined)
  const [lastInboundBody, setLastInboundBody] = useState<string | undefined>(undefined)
  // ComposeBar controlled body — lets AIReplyCoachPanel inject accepted drafts
  const [composePrefill, setComposePrefill]   = useState<{ body: string; subject?: string } | null>(null)
  const [conversationInsight, setConversationInsight] = useState<any>(null)
  const [analyzingConversation, setAnalyzingConversation] = useState(false)

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count ?? 0), 0)
  const selectedConvo = conversations.find(c => c.id === selectedId) ?? null
  const contact = selectedConvo?.contacts ?? null
  const isLeadThread = selectedConvo?.party === "lead"
  const [convertingLead, setConvertingLead] = useState(false)

  // Auto-select the first conversation on initial load so the reply composer
  // (ComposeBar, which only renders for a selected conversation) is visible right
  // away — the walkthrough opened the inbox with nothing selected and reported
  // "no window to type something". Runs once; after that the user drives selection.
  const didInitialSelect = useRef(false)
  useEffect(() => {
    if (!didInitialSelect.current && !selectedId && conversations.length > 0) {
      didInitialSelect.current = true
      setSelectedId(conversations[0].id)
    }
  }, [conversations, selectedId])

  // ── Supabase Realtime — subscribe to new messages in selected conversation ──
  useEffect(() => {
    const supabase = createClient()
    realtimeRef.current = supabase

    const channel = supabase
      .channel("inbox-messages")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload: any) => {
          const newMsg = payload.new
          // If it belongs to the currently selected conversation, append it
          if (newMsg.conversation_id === selectedId) {
            setMessages(prev => {
              const already = prev.some(m => m.id === newMsg.id)
              if (already) return prev
              return [...prev, newMsg]
            })
            // Update AI Reply Coach trigger if new inbound message arrives
            if (newMsg.direction === "inbound" && newMsg.id && (newMsg.body || newMsg.content)) {
              setLastInboundId(newMsg.id)
              setLastInboundBody(newMsg.body ?? newMsg.content ?? "")
            }
          }
          // Bump unread count on list row for other conversations
          setConversations(prev =>
            prev.map(c => {
              if (c.id !== newMsg.conversation_id) return c
              const isSelected = c.id === selectedId
              return {
                ...c,
                last_message_at: newMsg.created_at ?? c.last_message_at,
                last_message_preview: newMsg.body ?? newMsg.content ?? c.last_message_preview,
                unread_count: isSelected ? 0 : (c.unread_count ?? 0) + 1,
              }
            })
          )
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [selectedId])

  const loadThread = useCallback(async (convoId: string) => {
    setMessagesLoading(true)
    setSentiment(null)
    setLastInboundId(undefined)
    setLastInboundBody(undefined)
    try {
      const result = await getMessageThread(convoId)
      if (result.success && result.messages) {
        setMessages(result.messages)
        const lastInbound = [...result.messages]
          .reverse()
          .find(m => m.direction === "inbound")
        const msgText = lastInbound?.body ?? lastInbound?.content ?? lastInbound?.message_content ?? ""
        // Populate AI Reply Coach trigger
        if (lastInbound?.id && msgText) {
          setLastInboundId(lastInbound.id)
          setLastInboundBody(msgText)
        }
        if (msgText) {
          // Resolve contactId directly from the conversation being loaded, not from
          // the stale `contact` closure (which still points at the previous conversation
          // because React state hasn't flushed yet at this point in the call).
          setConversations(prev => {
            const convoContact = prev.find(c => c.id === convoId)?.contacts ?? null
            analyzeMessageSentiment({
              message: msgText,
              contactId: convoContact?.id,
              agentId,
            }).then(r => {
              if (r.success) setSentiment(r.analysis ?? null)
            })
            return prev
          })
        }
      }
    } finally {
      setMessagesLoading(false)
    }
  }, [agentId])

  // LEAD threads (id `lead:<leads.id>`): timeline from isa_outreach_log +
  // lead voice_calls — no conversations row, no read-state to mark.
  const loadLeadThread = useCallback(async (leadId: string) => {
    setMessagesLoading(true)
    setSentiment(null)
    setLastInboundId(undefined)
    setLastInboundBody(undefined)
    try {
      const result = await getLeadThreadMessages({ leadId })
      if (result.success && result.messages) {
        setMessages(result.messages.map(m => ({
          id: m.id,
          body: m.body,
          direction: m.direction,
          created_at: m.created_at,
          channel: m.channel,
          sender_type: m.direction === "outbound" ? "ai_assistant" : undefined,
        })))
      } else {
        setMessages([])
      }
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
    setMobileView("thread")
    if (id.startsWith("lead:")) {
      loadLeadThread(id.slice(5))
      return
    }
    loadThread(id)
    startTransition(async () => {
      await markConversationRead(id)
      setConversations(prev =>
        prev.map(c => c.id === id ? { ...c, unread_count: 0 } : c)
      )
    })
  }, [loadThread, loadLeadThread])

  const handleConvertLead = useCallback(async () => {
    if (!selectedConvo?.lead_id) return
    setConvertingLead(true)
    try {
      const res = await convertLeadFromInbox({ leadId: selectedConvo.lead_id })
      if (res.success) {
        toast.success("Lead converted to contact", {
          description: "The AI ISA hands off — this conversation now lives on the contact's thread.",
        })
        // The lead thread is done — remove it from the list.
        setConversations(prev => prev.filter(c => c.id !== selectedConvo.id))
        setSelectedId(null)
        setMessages([])
        setMobileView("list")
      } else {
        toast.error("Conversion failed", { description: res.error })
      }
    } finally {
      setConvertingLead(false)
    }
  }, [selectedConvo])

  const handleSend = useCallback(async (
    body: string,
    subject?: string,
    channel?: string
  ): Promise<{ success: boolean; error?: string }> => {
    if (!selectedId) return { success: false, error: "No conversation selected" }
    if (!contact?.id) return { success: false, error: "Contact record missing — cannot send message" }

    const resolvedChannel = (channel ?? selectedConvo?.type ?? "email") as "email" | "sms" | "in_app"

    const result = await sendMessage({
      conversationId: selectedId,
      contactId:      contact.id,
      agentId,
      channel:        resolvedChannel,
      body,
      subject:        subject || undefined,
    }) as { success: boolean; error?: string; tcpaBlocked?: boolean; suppressed?: boolean }

    if (result.success) {
      setMessages(prev => [...prev, {
        id:          crypto.randomUUID(),
        body,
        content:     body,
        direction:   "outbound",
        sender_type: "agent",
        created_at:  new Date().toISOString(),
        type:        resolvedChannel,
        channel:     resolvedChannel,
      }])
    } else if (result.tcpaBlocked) {
      toast.error("TCPA Consent Required", {
        description: result.error ?? "This contact has not opted in to SMS. Obtain written consent first.",
      })
    } else if (result.suppressed) {
      toast.error("Contact Suppressed", {
        description: result.error ?? "This contact is on a suppression list (DNC or opted out).",
      })
    } else if (result.error) {
      toast.error("Send Failed", { description: result.error })
    }

    return { success: result.success, error: result.error }
  }, [selectedId, contact?.id, agentId, selectedConvo?.type])

  const handleDraft = useCallback(async (currentText: string): Promise<string> => {
    // If the AI Reply Coach has injected an accepted draft, consume it first
    if (composePrefill) {
      const body = composePrefill.body
      setComposePrefill(null)
      return body
    }
    if (!contact) return currentText
    const lastInbound = [...messages].reverse().find(m => m.direction === "inbound")
    // generateSmartResponse accepts "email" | "sms" | "chat" — map in_app → chat
    const rawChannel  = selectedConvo?.type ?? "email"
    const draftChannel: "email" | "sms" | "chat" =
      rawChannel === "sms" ? "sms" : rawChannel === "email" ? "email" : "chat"
    const result = await generateSmartResponse({
      incomingMessage: lastInbound?.body ?? lastInbound?.content ?? lastInbound?.message_content ?? currentText,
      contactId:  contact.id,
      agentId,
      brokerageId,
      channel: draftChannel,
      tone: "professional",
      includeNextSteps: true,
    })
    return result.success ? (result as any).draft ?? currentText : currentText
  }, [contact, messages, agentId, brokerageId, selectedConvo?.type, composePrefill])

  const handleAnalyzeConversation = useCallback(async () => {
    if (!selectedId || !contact?.id) return
    setAnalyzingConversation(true)
    try {
      const transcript = messages
        .map(m => `[${m.direction === "inbound" ? "Contact" : "Agent"}]: ${m.body ?? m.content ?? ""}`)
        .join("\n")
      const result = await analyzeConversation({
        leadId: contact.id,
        agentId,
        conversationType: (selectedConvo?.type ?? "email") as "call" | "email" | "sms" | "chat",
        conversationId: selectedId,
        transcript,
      })
      if (result?.success) {
        setConversationInsight((result as any).analysis ?? result)
        toast.success("Conversation analyzed")
      } else {
        toast.error("Analysis failed")
      }
    } catch {
      toast.error("Analysis failed")
    } finally {
      setAnalyzingConversation(false)
    }
  }, [selectedId, contact?.id, agentId, messages, selectedConvo?.type])

  const contactName = isLeadThread
    ? (selectedConvo?.lead_name || "New lead")
    : `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim() || "Contact"

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden bg-background">

      {/* PANEL 1 — Conversation List */}
      <div className={`
        flex-col border-r border-border
        md:flex md:w-[300px] lg:w-[340px] shrink-0
        ${mobileView === "list" ? "flex w-full" : "hidden"}
      `}>
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={handleSelect}
          totalUnread={totalUnread}
          assistantName={assistantName}
        />
      </div>

      {/* PANEL 2 — Message Thread */}
      <div className={`
        flex-col flex-1 min-w-0
        md:flex
        ${mobileView === "thread" ? "flex" : "hidden"}
      `}>
        {selectedConvo ? (
          <>
            {/* Thread header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background shrink-0">
              <button
                className="md:hidden -ml-1 text-muted-foreground"
                onClick={() => setMobileView("list")}
                aria-label="Back to inbox"
              >
                <ChevronLeft size={20} />
              </button>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-foreground truncate">{contactName}</p>
                <p className="text-xs text-muted-foreground capitalize">
                  {isLeadThread
                    ? "Lead · AI ISA nurturing"
                    : `${selectedConvo.type ?? "email"} · ${contact?.lifecycle_state?.replace(/_/g, " ") ?? ""}`}
                </p>
              </div>
              {isLeadThread && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1 text-xs"
                  onClick={handleConvertLead}
                  disabled={convertingLead}
                >
                  {convertingLead ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  Convert to contact
                </Button>
              )}
              {/* Role badge for broker/admin */}
              {(role === "broker" || role === "admin") && (
                <span className="hidden sm:inline-block text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                  Broker View
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="gap-1 text-xs"
                onClick={handleAnalyzeConversation}
                disabled={analyzingConversation || messages.length === 0}
              >
                {analyzingConversation ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                Analyze
              </Button>
            </div>

            <MessageThread
              messages={messages}
              contactName={contactName}
              loading={messagesLoading}
            />

            {conversationInsight && (
              <div className="mx-4 mb-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs space-y-1">
                <p className="font-semibold text-blue-800 flex items-center gap-1">
                  <Sparkles className="h-3 w-3" />
                  Conversation Intelligence
                </p>
                {conversationInsight.sentiment && (
                  <p className="text-blue-900">Sentiment: <span className="font-medium capitalize">{conversationInsight.sentiment}</span></p>
                )}
                {conversationInsight.intent && (
                  <p className="text-blue-900">Intent: <span className="font-medium">{conversationInsight.intent}</span></p>
                )}
                {conversationInsight.urgency && (
                  <p className="text-blue-900">Urgency: <span className="font-medium capitalize">{conversationInsight.urgency}</span></p>
                )}
                {conversationInsight.nextBestAction && (
                  <p className="text-blue-900 border-t border-blue-200 pt-1">Next action: <span className="font-medium">{conversationInsight.nextBestAction}</span></p>
                )}
              </div>
            )}

            {isLeadThread ? (
              // Leads have no reply channel here — the AI ISA owns the nurture
              // (email + direct mail; calls come in). Positive direction converts.
              <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground bg-muted/30">
                Your AI ISA is nurturing this lead by email and direct mail. When the lead replies or
                calls in with positive intent, it converts to a contact automatically — or use
                <span className="font-medium text-foreground"> Convert to contact</span> above if
                you&apos;ve judged the direction positive yourself.
              </div>
            ) : (
              <ComposeBar
                conversationId={selectedId!}
                agentId={agentId}
                contactId={contact?.id ?? ""}
                channel={(selectedConvo.type ?? "email") as "email" | "sms" | "in_app"}
                lifecycleState={contact?.lifecycle_state}
                tcpaConsent={contact?.tcpa_consent ?? null}
                emailTemplates={emailTemplates}
                onSend={handleSend}
                onDraft={handleDraft}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
            <p className="font-medium">Select a conversation to start</p>
            <p className="text-xs">
              Your assistant: <span className="font-medium text-foreground">{assistantName}</span>
            </p>
          </div>
        )}
      </div>

      {/* PANEL 3 — Contact Detail (desktop only) */}
      <div className="hidden lg:flex">
        <ContactDetailPane
          contact={contact as any}
          sentimentSummary={sentiment}
          agentId={agentId}
        />
      </div>

      {/* PANEL 4 — AI Reply Coach (desktop only, toggled via showReplyCoach) */}
      {showReplyCoach && (
        <div className="hidden xl:flex">
          <AIReplyCoachPanel
            brokerageId={brokerageId}
            agentUserId={agentId}
            conversationId={isLeadThread ? null : selectedId}
            contactId={contact?.id ?? null}
            lastInboundId={lastInboundId}
            lastInboundBody={lastInboundBody}
            channel={(selectedConvo?.type ?? "email") as "email" | "sms" | "in_app"}
            onAccepted={(body, subject) => setComposePrefill({ body, subject })}
          />
        </div>
      )}
    </div>
  )
}
