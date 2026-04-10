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

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count ?? 0), 0)
  const selectedConvo = conversations.find(c => c.id === selectedId) ?? null
  const contact = selectedConvo?.contacts ?? null

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

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
    setMobileView("thread")
    loadThread(id)
    startTransition(async () => {
      await markConversationRead(id)
      setConversations(prev =>
        prev.map(c => c.id === id ? { ...c, unread_count: 0 } : c)
      )
    })
  }, [loadThread])

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

  const contactName = `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim() || "Contact"

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
                  {selectedConvo.type ?? "email"} · {contact?.lifecycle_state?.replace(/_/g, " ") ?? ""}
                </p>
              </div>
              {/* Role badge for broker/admin */}
              {(role === "broker" || role === "admin") && (
                <span className="hidden sm:inline-block text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                  Broker View
                </span>
              )}
            </div>

            <MessageThread
              messages={messages}
              contactName={contactName}
              loading={messagesLoading}
            />

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
          contact={contact}
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
            conversationId={selectedId}
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
