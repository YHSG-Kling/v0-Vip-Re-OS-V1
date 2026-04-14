"use client"

import { useState, useEffect, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import {
  getInboxMessages,
  sendInboxMessage,
  markInboxRead,
  type InboxThread,
  type InboxMessageRow,
  type InboxChannel,
} from "@/app/actions/inbox"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  MessageSquare,
  Phone,
  Mail,
  Search,
  Send,
  Loader2,
  RefreshCw,
  Filter,
  ArrowLeft,
  Inbox,
  Volume2,
} from "lucide-react"
import { format, formatDistanceToNowStrict } from "date-fns"
import { toast } from "sonner"

// ─── Types ────────────────────────────────────────────────────────────────────
// InboxThread, InboxMessageRow, InboxChannel imported from @/app/actions/inbox

// Local alias for message display (InboxMessageRow has source_table; treat uniformly)
type InboxMessage = InboxMessageRow

type ChannelFilter = InboxChannel

// ─── Channel icon helper ───────────────────────────────────────────────────────

function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const cls = cn("w-3.5 h-3.5 shrink-0", className)
  if (channel === "voice") return <Phone className={cls} />
  if (channel === "email") return <Mail className={cls} />
  if (channel === "sms") return <MessageSquare className={cls} />
  if (channel === "portal") return <Inbox className={cls} />
  return <MessageSquare className={cls} />
}

function channelColor(channel: string) {
  if (channel === "voice") return "text-purple-600 bg-purple-50"
  if (channel === "email") return "text-blue-600 bg-blue-50"
  if (channel === "sms") return "text-green-600 bg-green-50"
  if (channel === "portal") return "text-indigo-600 bg-indigo-50"
  return "text-gray-600 bg-gray-100"
}

function sentimentColor(s?: string | null) {
  if (!s) return ""
  if (s.includes("negative") || s === "frustrated") return "text-red-600"
  if (s.includes("positive") || s === "happy") return "text-green-600"
  return "text-gray-500"
}

// ─── Thread List Item ─────────────────────────────────────────────────────────

function ThreadItem({
  thread,
  active,
  onClick,
}: {
  thread: InboxThread
  active: boolean
  onClick: () => void
}) {
  const relTime = formatDistanceToNowStrict(new Date(thread.last_message_at), {
    addSuffix: false,
  })

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 border-b transition-colors hover:bg-muted/50 focus-visible:outline-none",
        active ? "bg-indigo-50 border-l-2 border-l-indigo-600" : ""
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span
              className={cn(
                "w-5 h-5 rounded-full flex items-center justify-center text-[10px]",
                channelColor(thread.channel)
              )}
            >
              <ChannelIcon channel={thread.channel} />
            </span>
            <span className="font-medium text-sm truncate text-foreground">
              {thread.contact_name || "Unknown"}
            </span>
          </div>
          {thread.last_message_body && (
            <p className="text-xs text-muted-foreground truncate leading-4">
              {thread.last_message_body}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">{relTime}</span>
          {thread.unread_count > 0 && (
            <span className="px-1.5 py-0.5 bg-indigo-600 text-white text-[10px] rounded-full font-semibold leading-none">
              {thread.unread_count > 99 ? "99+" : thread.unread_count}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: InboxMessage }) {
  const isInbound = msg.direction === "inbound"
  return (
    <div className={cn("flex", isInbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isInbound
            ? "bg-muted text-foreground rounded-tl-sm"
            : "bg-indigo-600 text-white rounded-tr-sm"
        )}
      >
        {msg.source_table === "voice_calls" || msg.channel === "voice" ? (
          <div className="flex items-start gap-2">
            <Volume2 className="w-4 h-4 mt-0.5 shrink-0 opacity-70" />
            <span>{msg.body || "Voice call"}</span>
          </div>
        ) : (
          <span>{msg.body}</span>
        )}
        <div
          className={cn(
            "flex items-center gap-1 mt-1 text-[10px]",
            isInbound ? "text-muted-foreground" : "text-indigo-200"
          )}
        >
          <ChannelIcon channel={msg.channel} />
          <span>{format(new Date(msg.created_at), "h:mm a · MMM d")}</span>
          {msg.sentiment && (
            <span className={cn("ml-1", sentimentColor(msg.sentiment))}>
              {msg.sentiment}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Inbox Client ────────────────────────────────────────────────────────

export function InboxClient({
  initialContactId,
  initialChannel,
  initialThreads = [],
}: {
  initialContactId?: string | null
  initialChannel?: string | null
  initialThreads?: InboxThread[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [threads, setThreads] = useState<InboxThread[]>(initialThreads)
  const [threadsLoading, setThreadsLoading] = useState(initialThreads.length === 0)
  const [search, setSearch] = useState("")
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all")
  const [unreadOnly, setUnreadOnly] = useState(false)

  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    initialContactId ?? searchParams.get("contact")
  )
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [composing, setComposing] = useState("")
  const [sending, setSending] = useState(false)

  // Load threads (uses server action — kernel-scoped, RLS-enforced)
  const loadThreads = useCallback(async () => {
    setThreadsLoading(true)
    try {
      const result = await getInboxMessages({ channel: "all", limit: 100 })
      setThreads(result.threads ?? [])
    } catch {
      // silent
    } finally {
      setThreadsLoading(false)
    }
  }, [])

  // Load messages for selected contact (uses server action)
  const loadMessages = useCallback(
    async (contactId: string) => {
      setMessagesLoading(true)
      try {
        const result = await getInboxMessages({
          contactId,
          channel: channelFilter === "all" ? "all" : channelFilter,
          unreadOnly,
          limit: 100,
        })
        setMessages(result.messages ?? [])
        // Mark as read when opening thread
        if ((result.messages ?? []).some((m) => !m.read)) {
          markInboxRead({ contactId }).catch(() => {})
        }
      } catch {
        // silent
      } finally {
        setMessagesLoading(false)
      }
    },
    [channelFilter, unreadOnly]
  )

  useEffect(() => {
    // Skip initial fetch when server-hydrated threads are already loaded
    if (initialThreads.length === 0) {
      loadThreads()
    }
    // Poll every 15s to pick up new messages
    const id = setInterval(loadThreads, 15000)
    return () => clearInterval(id)
  }, [loadThreads])

  useEffect(() => {
    if (selectedContactId) {
      loadMessages(selectedContactId)
    }
  }, [selectedContactId, loadMessages])

  // Sync URL param
  useEffect(() => {
    const cid = searchParams.get("contact")
    if (cid && cid !== selectedContactId) setSelectedContactId(cid)
  }, [searchParams, selectedContactId])

  // Send message via kernel inbox command (compliance-gated)
  const handleSend = async () => {
    if (!composing.trim() || !selectedContactId) return
    setSending(true)
    try {
      const channel = (initialChannel ?? "portal") as "sms" | "email" | "portal" | "chat"
      const result = await sendInboxMessage({
        contactId: selectedContactId,
        body: composing.trim(),
        channel,
      })
      if (result.success) {
        setComposing("")
        toast.success("Message sent")
        await loadMessages(selectedContactId)
        loadThreads()
      } else {
        toast.error(result.error ?? "Failed to send")
      }
    } catch {
      toast.error("Failed to send message")
    } finally {
      setSending(false)
    }
  }

  const filteredThreads = threads.filter((t) => {
    const matchesSearch =
      !search ||
      t.contact_name.toLowerCase().includes(search.toLowerCase()) ||
      t.last_message_body.toLowerCase().includes(search.toLowerCase())
    const matchesChannel = channelFilter === "all" || t.channel === channelFilter
    const matchesUnread = !unreadOnly || t.unread_count > 0
    return matchesSearch && matchesChannel && matchesUnread
  })

  const selectedThread = threads.find((t) => t.contact_id === selectedContactId)

  const CHANNELS: { value: ChannelFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "portal", label: "Portal" },
    { value: "sms", label: "SMS" },
    { value: "email", label: "Email" },
    { value: "voice", label: "Voice" },
  ]

  return (
    <div className="flex h-full min-h-[500px] overflow-hidden border rounded-lg bg-background">
      {/* ── LEFT: Thread List ─────────────────────────────────────────────── */}
      <div
        className={cn(
          "flex flex-col border-r bg-background transition-all duration-200",
          selectedContactId ? "hidden md:flex w-80 shrink-0" : "flex w-full md:w-80 md:shrink-0"
        )}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b">
          <h2 className="font-semibold text-base text-foreground mb-2">Inbox</h2>
          {/* Search */}
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="Search contacts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {/* Channel filter tabs */}
          <div className="flex gap-1 flex-wrap">
            {CHANNELS.map((c) => (
              <button
                key={c.value}
                onClick={() => setChannelFilter(c.value)}
                className={cn(
                  "px-2 py-0.5 text-xs rounded-full border transition-colors",
                  channelFilter === c.value
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "text-muted-foreground border-muted hover:bg-muted/50"
                )}
              >
                {c.label}
              </button>
            ))}
            <button
              onClick={() => setUnreadOnly((p) => !p)}
              className={cn(
                "px-2 py-0.5 text-xs rounded-full border transition-colors",
                unreadOnly
                  ? "bg-red-600 text-white border-red-600"
                  : "text-muted-foreground border-muted hover:bg-muted/50"
              )}
            >
              Unread
            </button>
          </div>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto">
          {threadsLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              ))}
            </div>
          ) : filteredThreads.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8 text-center">
              <Inbox className="w-8 h-8 mb-2 opacity-40" />
              <p className="text-sm">No conversations found</p>
              {unreadOnly && (
                <p className="text-xs mt-1">Try disabling the unread filter</p>
              )}
            </div>
          ) : (
            filteredThreads.map((t) => (
              <ThreadItem
                key={t.contact_id}
                thread={t}
                active={t.contact_id === selectedContactId}
                onClick={() => {
                  setSelectedContactId(t.contact_id)
                  router.replace(
                    `/dashboard/inbox?contact=${t.contact_id}`,
                    { scroll: false }
                  )
                }}
              />
            ))
          )}
        </div>

        {/* Refresh */}
        <div className="px-4 py-2 border-t flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={loadThreads}
            disabled={threadsLoading}
          >
            <RefreshCw className={cn("w-3 h-3", threadsLoading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── RIGHT: Message Thread ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedContactId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <MessageSquare className="w-12 h-12 opacity-20" />
            <p className="text-sm">Select a conversation</p>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="px-4 py-3 border-b flex items-center gap-3 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden h-8 w-8"
                onClick={() => setSelectedContactId(null)}
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-foreground">
                  {selectedThread?.contact_name ?? "Contact"}
                </p>
                {selectedThread && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={cn(
                        "text-xs px-1.5 py-0.5 rounded",
                        channelColor(selectedThread.channel)
                      )}
                    >
                      {selectedThread.channel}
                    </span>
                    {selectedThread.contact_type && (
                      <span className="text-xs text-muted-foreground capitalize">
                        {selectedThread.contact_type}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => selectedContactId && loadMessages(selectedContactId)}
              >
                <RefreshCw
                  className={cn("w-3 h-3", messagesLoading && "animate-spin")}
                />
              </Button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messagesLoading ? (
                <div className="space-y-3">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className={cn("flex", i % 2 === 0 ? "justify-start" : "justify-end")}>
                      <Skeleton className={cn("h-12 rounded-2xl", i % 2 === 0 ? "w-48" : "w-56")} />
                    </div>
                  ))}
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
                  <MessageSquare className="w-8 h-8 opacity-20" />
                  <p className="text-sm">No messages yet</p>
                  <p className="text-xs">Send a message to start the conversation</p>
                </div>
              ) : (
                [...messages].reverse().map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} />
                ))
              )}
            </div>

            {/* Composer */}
            <div className="px-4 py-3 border-t shrink-0">
              <div className="flex gap-2 items-end">
                <Textarea
                  className="flex-1 min-h-[60px] max-h-32 resize-none text-sm"
                  placeholder={`Message ${selectedThread?.contact_name ?? "contact"}…`}
                  value={composing}
                  onChange={(e) => setComposing(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                />
                <Button
                  size="icon"
                  className="h-9 w-9 shrink-0 bg-indigo-600 hover:bg-indigo-700"
                  onClick={handleSend}
                  disabled={sending || !composing.trim()}
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Enter to send · Shift+Enter for new line
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
