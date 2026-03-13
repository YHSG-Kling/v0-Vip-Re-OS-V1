"use client"

import { cn } from "@/lib/utils"
import { Check, CheckCheck } from "lucide-react"

interface MessageBubbleProps {
  body: string
  direction: "agent_to_client" | "client_to_agent"
  createdAt: string
  readAt?: string | null
  senderName: string
  isUnread?: boolean
}

/**
 * MessageBubble - iMessage-style chat bubble.
 * - direction='agent_to_client' → right-aligned, agent name label
 * - direction='client_to_agent' → left-aligned, "You" label
 * - Shows read receipt for agent_to_client messages
 * - Highlights unread client_to_agent messages
 */
export function MessageBubble({
  body,
  direction,
  createdAt,
  readAt,
  senderName,
  isUnread = false,
}: MessageBubbleProps) {
  const isAgentMessage = direction === "agent_to_client"
  const formattedTime = formatMessageTime(createdAt)

  return (
    <div
      className={cn(
        "flex flex-col gap-1 max-w-[80%]",
        isAgentMessage ? "ml-auto items-end" : "mr-auto items-start"
      )}
    >
      {/* Sender label */}
      <span className="text-xs text-muted-foreground px-1">{senderName}</span>

      {/* Message bubble */}
      <div
        className={cn(
          "px-4 py-2 rounded-2xl text-sm leading-relaxed",
          isAgentMessage
            ? "bg-primary text-primary-foreground rounded-br-md"
            : cn(
                "bg-muted text-foreground rounded-bl-md",
                isUnread && "bg-blue-50 dark:bg-blue-950/30"
              )
        )}
      >
        {body}
      </div>

      {/* Timestamp and read receipt */}
      <div className="flex items-center gap-1 px-1">
        <span className="text-[10px] text-muted-foreground">{formattedTime}</span>
        {isAgentMessage && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
            {readAt ? (
              <>
                <CheckCheck className="h-3 w-3 text-blue-500" />
                <span>Read {formatReadTime(readAt)}</span>
              </>
            ) : (
              <Check className="h-3 w-3" />
            )}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * DateSeparator - Groups messages by date.
 */
export function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-4 py-4">
      <div className="flex-1 h-px bg-border" />
      <span className="text-xs text-muted-foreground font-medium">{date}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function formatMessageTime(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

function formatReadTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

/**
 * Get display date for separator.
 */
export function getDateLabel(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === now.toDateString()) {
    return "Today"
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday"
  }

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
}
