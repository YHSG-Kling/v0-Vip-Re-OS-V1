"use client"

import { useState, useCallback, useTransition, useEffect } from "react"
import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
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

interface InboxClientProps {
  conversations: Conversation[]
  brokerageId: string
  agentId: string
  userId: string
  assistantName: string
}

export default function InboxClient({
  conversations,
  brokerageId,
  agentId,
  userId,
  assistantName,
}: InboxClientProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [sentiment, setSentiment] = useState<any | null>(null)
  // mobile: show list or thread
  const [mobileView, setMobileView] = useState<"list" | "thread">("list")
  const [, startTransition] = useTransition()

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count ?? 0), 0)
  const selectedConvo = conversations.find(c => c.id === selectedId) ?? null
  const contact = selectedConvo?.contacts ?? null

  const loadThread = useCallback(async (convoId: string) => {
    setMessagesLoading(true)
    setSentiment(null)
    try {
      const result = await getMessageThread(convoId)
      if (result.success && result.messages) {
        setMessages(result.messages)
        // Analyze last inbound message for sentiment
        const lastInbound = [...result.messages].reverse().find(m => m.direction === "inbound")
        if (lastInbound?.content || lastInbound?.message_content) {
          analyzeMessageSentiment({
            message: lastInbound.content ?? lastInbound.message_content ?? "",
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
    // Mark read non-blocking
    startTransition(async () => {
      await markConversationRead(id)
    })
  }, [loadThread])

  const handleSend = useCallback(async (content: string) => {
    if (!selectedId) return { success: false, error: "No conversation selected" }
    const result = await sendMessage({
      conversationId: selectedId,
      content,
      senderType: "agent",
      senderId: userId,
      channel: selectedConvo?.type ?? "email",
    })
    if (result.success) {
      // Optimistically add message
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        content,
        direction: "outbound",
        sender_type: "agent",
        created_at: new Date().toISOString(),
        channel: selectedConvo?.type ?? "email",
      }])
    }
    return result as { success: boolean; error?: string }
  }, [selectedId, selectedConvo?.type, userId])

  const handleDraft = useCallback(async (currentText: string) => {
    if (!contact) return currentText
    const lastInbound = [...messages].reverse().find(m => m.direction === "inbound")
    const result = await generateSmartResponse({
      incomingMessage: lastInbound?.content ?? lastInbound?.message_content ?? currentText,
      contactId: contact.id,
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

      {/* PANEL 1 — Conversation List (hidden on mobile when thread open) */}
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
              {/* Mobile back */}
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
            </div>

            {/* Messages */}
            <MessageThread
              messages={messages}
              contactName={contactName}
              loading={messagesLoading}
            />

            {/* Compose */}
            <ComposeBar
              conversationId={selectedId!}
              senderId={userId}
              channel={selectedConvo.type ?? "email"}
              lifecycleState={contact?.lifecycle_state}
              onSend={handleSend}
              onDraft={handleDraft}
            />
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
            <p className="font-medium">Select a conversation to start</p>
            <p className="text-xs">Your assistant: <span className="font-medium text-foreground">{assistantName}</span></p>
          </div>
        )}
      </div>

      {/* PANEL 3 — Contact Detail (desktop only) */}
      <div className="hidden lg:flex">
        <ContactDetailPane
          contact={contact}
          sentimentSummary={sentiment}
        />
      </div>
    </div>
  )
}
