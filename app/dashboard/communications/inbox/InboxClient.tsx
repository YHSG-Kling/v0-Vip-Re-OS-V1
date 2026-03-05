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
}

export default function InboxClient({
  conversations: initialConversations,
  emailTemplates,
  brokerageId,
  agentId,
  userId,
  role,
  assistantName,
}: InboxClientProps) {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [sentiment, setSentiment] = useState<any | null>(null)
  const [mobileView, setMobileView] = useState<"list" | "thread">("list")
  const [, startTransition] = useTransition()
  const realtimeRef = useRef<ReturnType<typeof createClient> | null>(null)

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
    try {
      const result = await getMessageThread(convoId)
      if (result.success && result.messages) {
        setMessages(result.messages)
        const lastInbound = [...result.messages]
          .reverse()
          .find(m => m.direction === "inbound")
        const msgText = lastInbound?.body ?? lastInbound?.content ?? lastInbound?.message_content ?? ""
        if (msgText) {
          analyzeMessageSentiment({
            message: msgText,
            contactId: contact?.id,
            agentId,
          }).then(r => {
            if (r.success) setSentiment(r.analysis ?? null)
          })
        }
      }
    } finally {
      setMessagesLoading(false)
    }
  }, [agentId, contact?.id])

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
    if (!selectedId || !contact?.id) return { success: false, error: "No conversation or contact selected" }

    const resolvedChannel = (channel ?? selectedConvo?.type ?? "email") as "email" | "sms" | "in_app"

    const result = await sendMessage({
      conversationId: selectedId,
      contactId:      contact.id,
      agentId,
      channel:        resolvedChannel,
      body,
      subject:        subject || undefined,
    })

    if (result.success) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        body,
        content: body,
        direction:   "outbound",
        sender_type: "agent",
        created_at:  new Date().toISOString(),
        type:        resolvedChannel,
        channel:     resolvedChannel,
      }])
    }
    return result as { success: boolean; error?: string }
  }, [selectedId, contact?.id, agentId, selectedConvo?.type])

  const handleDraft = useCallback(async (currentText: string): Promise<string> => {
    if (!contact) return currentText
    const lastInbound = [...messages].reverse().find(m => m.direction === "inbound")
    const result = await generateSmartResponse({
      incomingMessage: lastInbound?.body ?? lastInbound?.content ?? lastInbound?.message_content ?? currentText,
      contactId:  contact.id,
      agentId,
      channel: (selectedConvo?.type ?? "email") as "email" | "sms" | "chat",
      tone: "professional",
      includeNextSteps: true,
    })
    return result.success ? result.draft ?? currentText : currentText
  }, [contact, messages, agentId, selectedConvo?.type])

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
    </div>
  )
}
