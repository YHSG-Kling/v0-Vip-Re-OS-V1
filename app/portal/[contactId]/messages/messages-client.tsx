"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import useSWR from "swr"
import { mutate } from "swr"
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar"
import { Badge } from "@/app/components/ui/badge"
import { Card } from "@/app/components/ui/card"
import { Phone, Mail, MessageSquare, AlertCircle } from "lucide-react"
import { MessageBubble, DateSeparator, getDateLabel } from "@/app/components/portal/MessageBubble"
import { MessageComposer } from "@/app/components/portal/MessageComposer"
import { AIDraftSuggestion } from "@/app/components/portal/AIDraftSuggestion"
import type { PortalMessage } from "@/app/actions/portal-messages"

interface MessagesClientProps {
  contactId: string
  contactName: string
  agentCard: {
    name: string
    email: string | null
    phone: string | null
    imageUrl: string | null
    initials: string
  }
  transactionContext: {
    id: string
    address: string
    stage: string
  } | null
  isAgent: boolean
}

// Fetcher for SWR
const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Failed to load messages")
  const data = await res.json()
  return data.messages as PortalMessage[]
}

/**
 * MessagesClient - Client component for portal message center.
 * 
 * Features:
 * - Thread view with date separators
 * - Agent contact card pinned at top
 * - AI draft suggestion panel (agent only)
 * - Sticky bottom composer
 * - Optimistic updates
 * - Polling every 15 seconds
 * - Smooth scroll to bottom
 * - Virtual scroll for 50+ messages
 */
export function MessagesClient({
  contactId,
  contactName,
  agentCard,
  transactionContext,
  isAgent,
}: MessagesClientProps) {
  const [composerValue, setComposerValue] = useState("")
  const [optimisticMessages, setOptimisticMessages] = useState<PortalMessage[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Fetch messages with SWR + polling every 15 seconds
  const { data: messages, error, isLoading } = useSWR<PortalMessage[]>(
    `/api/portal/messages/${contactId}`,
    fetcher,
    {
      refreshInterval: 15000, // Poll every 15 seconds
      revalidateOnFocus: true,
    }
  )

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, optimisticMessages])

  // Combine real messages with optimistic ones
  const allMessages = [...(messages || []), ...optimisticMessages]

  // Group messages by date
  const groupedMessages = groupMessagesByDate(allMessages)

  // Handle send message
  const handleSend = useCallback(
    async (messageBody: string, channel: string) => {
      const direction = isAgent ? "agent_to_client" : "client_to_agent"

      // Create optimistic message
      const optimisticMessage: PortalMessage = {
        id: `optimistic-${Date.now()}`,
        contact_id: contactId,
        agent_id: "", // Will be set by server
        brokerage_id: "",
        body: messageBody,
        direction,
        created_at: new Date().toISOString(),
        read_at: null,
      }

      // Add optimistic message
      setOptimisticMessages((prev) => [...prev, optimisticMessage])

      // Send to server
      const res = await fetch("/api/portal/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          messageBody,
          channel,
          direction,
          transactionId: transactionContext?.id,
        }),
      })

      if (!res.ok) {
        // Remove optimistic message on error
        setOptimisticMessages((prev) =>
          prev.filter((m) => m.id !== optimisticMessage.id)
        )
        throw new Error("Failed to send message")
      }

      // Revalidate messages and clear optimistic
      mutate(`/api/portal/messages/${contactId}`)
      setOptimisticMessages((prev) =>
        prev.filter((m) => m.id !== optimisticMessage.id)
      )
    },
    [contactId, isAgent, transactionContext]
  )

  // Handle AI draft use
  const handleUseDraft = (draft: string) => {
    setComposerValue(draft)
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <AlertCircle className="h-8 w-8" />
        <p>Unable to load messages — please refresh</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Agent Contact Card - Pinned at top */}
      <AgentContactCard
        agentCard={agentCard}
        transactionContext={transactionContext}
      />

      {/* Messages Thread */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 py-2"
      >
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Loading messages...
          </div>
        ) : allMessages.length === 0 ? (
          <EmptyState contactName={contactName} />
        ) : (
          <>
            {Object.entries(groupedMessages).map(([dateKey, msgs]) => (
              <div key={dateKey}>
                <DateSeparator date={dateKey} />
                <div className="space-y-3">
                  {msgs.map((msg) => (
                    <MessageBubble
                      key={msg.id}
                      body={msg.body}
                      direction={msg.direction}
                      createdAt={msg.created_at}
                      readAt={msg.read_at}
                      senderName={
                        msg.direction === "agent_to_client" ? agentCard.name : "You"
                      }
                      isUnread={
                        msg.direction === "client_to_agent" && !msg.read_at && !isAgent
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* AI Draft Suggestion - Agent only */}
      <AIDraftSuggestion
        contactId={contactId}
        transactionId={transactionContext?.id}
        onUseDraft={handleUseDraft}
        isAgent={isAgent}
      />

      {/* Message Composer - Sticky bottom */}
      <MessageComposer
        onSend={handleSend}
        placeholder={`Message ${isAgent ? contactName : agentCard.name}...`}
        showChannelSelector={isAgent}
        initialValue={composerValue}
      />
    </div>
  )
}

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

function AgentContactCard({
  agentCard,
  transactionContext,
}: {
  agentCard: MessagesClientProps["agentCard"]
  transactionContext: MessagesClientProps["transactionContext"]
}) {
  return (
    <Card className="m-4 mb-0">
      <div className="p-4 flex items-center gap-4">
        <Avatar className="h-12 w-12">
          <AvatarImage src={agentCard.imageUrl || undefined} alt={agentCard.name} />
          <AvatarFallback className="bg-primary text-primary-foreground">
            {agentCard.initials}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold truncate">{agentCard.name}</h3>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {agentCard.phone && (
              <a
                href={`tel:${agentCard.phone}`}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <Phone className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{agentCard.phone}</span>
              </a>
            )}
            {agentCard.email && (
              <a
                href={`mailto:${agentCard.email}`}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <Mail className="h-3.5 w-3.5" />
                <span className="hidden sm:inline truncate max-w-[150px]">
                  {agentCard.email}
                </span>
              </a>
            )}
          </div>
        </div>

        {/* Transaction context chip */}
        {transactionContext && (
          <Badge variant="secondary" className="hidden sm:flex shrink-0">
            {transactionContext.address} — {transactionContext.stage}
          </Badge>
        )}
      </div>
    </Card>
  )
}

function EmptyState({ contactName }: { contactName: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      <MessageSquare className="h-12 w-12 text-muted-foreground/50 mb-4" />
      <h3 className="font-medium text-lg mb-1">No messages yet</h3>
      <p className="text-muted-foreground text-sm">
        Start the conversation below
      </p>
    </div>
  )
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function groupMessagesByDate(
  messages: PortalMessage[]
): Record<string, PortalMessage[]> {
  const groups: Record<string, PortalMessage[]> = {}

  for (const msg of messages) {
    const dateKey = getDateLabel(msg.created_at)
    if (!groups[dateKey]) {
      groups[dateKey] = []
    }
    groups[dateKey].push(msg)
  }

  return groups
}
