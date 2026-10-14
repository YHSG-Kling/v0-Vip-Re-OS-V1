"use client"

import { useEffect, useRef } from "react"
import { Mail, Phone, MessageSquare, Radio, AtSign } from "lucide-react"
import { cn } from "@/lib/utils"

type Message = {
  id: string
  body?: string
  content?: string
  message_content?: string
  direction?: "inbound" | "outbound"
  sender_type?: string
  created_at: string
  channel?: string
  type?: string
  /** true for synthetic call-transcript rows folded into the thread (getMessageThread) */
  is_call_transcript?: boolean
}

interface MessageThreadProps {
  messages: Message[]
  contactName: string
  loading: boolean
}

/** Per-message channel icon — folds social_dm_* and in_app/in-app spellings. */
function channelIcon(channel?: string): React.ReactNode {
  const c = (channel ?? "").toLowerCase()
  if (c.startsWith("social")) return <AtSign size={12} />
  if (c === "voice" || c === "call") return <Phone size={12} />
  if (c === "sms") return <MessageSquare size={12} />
  if (c === "in_app" || c === "in-app" || c === "chat") return <Radio size={12} />
  if (c === "email") return <Mail size={12} />
  return null
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return "Today"
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday"
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

export default function MessageThread({ messages, contactName, loading }: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading messages...
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No messages in this conversation yet.
      </div>
    )
  }

  // Group by date
  const grouped: { date: string; msgs: Message[] }[] = []
  let lastDate = ""
  for (const msg of messages) {
    const d = formatDate(msg.created_at)
    if (d !== lastDate) {
      grouped.push({ date: d, msgs: [] })
      lastDate = d
    }
    grouped[grouped.length - 1].msgs.push(msg)
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      {grouped.map(group => (
        <div key={group.date}>
          {/* Date divider */}
          <div className="flex items-center gap-2 my-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] text-muted-foreground font-medium">{group.date}</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="space-y-2">
            {group.msgs.map(msg => {
              // Call transcript — render as a distinct full-width call card, not a
              // chat bubble, so the unified thread reads "here's the call" at a glance.
              if (msg.is_call_transcript || msg.type === "voice") {
                return (
                  <div key={msg.id} className="my-1">
                    <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs font-semibold text-indigo-700 mb-1">
                        <Phone className="h-3.5 w-3.5" />
                        Call transcript
                        <span className="ml-auto font-normal text-[10px] text-muted-foreground">
                          {formatTime(msg.created_at)}
                        </span>
                      </div>
                      <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">
                        {msg.body ?? msg.content ?? ""}
                      </p>
                    </div>
                  </div>
                )
              }
              const isOutbound = msg.direction === "outbound" || msg.sender_type === "agent" || msg.sender_type === "ai_assistant"
              // body is the primary column written by sendMessage; content/message_content are fallbacks
              const text = msg.body ?? msg.content ?? msg.message_content ?? ""
              const isAI = msg.sender_type === "ai_assistant"
              // Resolve channel for icon: prefer msg.channel, fall back to msg.type
              const msgChannel = msg.channel ?? msg.type

              return (
                <div key={msg.id} className={cn("flex gap-2", isOutbound ? "justify-end" : "justify-start")}>
                  {/* Inbound avatar */}
                  {!isOutbound && (
                    <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                      {(contactName[0] ?? "?").toUpperCase()}
                    </div>
                  )}

                  <div className={cn("max-w-[70%] space-y-1", isOutbound ? "items-end" : "items-start")}>
                    <div
                      className={cn(
                        "px-3 py-2 rounded-2xl text-sm leading-relaxed",
                        isOutbound
                          ? isAI
                            ? "bg-indigo-600 text-white rounded-br-sm"
                            : "bg-primary text-primary-foreground rounded-br-sm"
                          : "bg-muted text-foreground rounded-bl-sm"
                      )}
                    >
                      {text || <em className="opacity-50">Empty message</em>}
                    </div>
                    <div className={cn("flex items-center gap-1 text-[10px] text-muted-foreground", isOutbound ? "flex-row-reverse" : "flex-row")}>
                      <span>{formatTime(msg.created_at)}</span>
                      {isAI && <span className="bg-indigo-100 text-indigo-700 px-1 rounded text-[9px] font-medium">AI</span>}
                      {channelIcon(msgChannel)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
