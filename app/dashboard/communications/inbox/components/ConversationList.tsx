"use client"

import { useState, useMemo } from "react"
import { Mail, Phone, MessageSquare, Radio, Search, AtSign } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

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
    lifecycle_state: string
    lead_score?: number
  } | null
  // last message preview from joined messages
  last_message_preview?: string
  // AI-ISA LEAD threads (leads are NOT contacts): id is `lead:<leads.id>`
  party?: "lead"
  lead_id?: string
  lead_name?: string
}

interface ConversationListProps {
  conversations: Conversation[]
  selectedId: string | null
  onSelect: (id: string) => void
  totalUnread: number
  assistantName: string
}

const LIFECYCLE_BADGE: Record<string, { label: string; className: string }> = {
  lead:               { label: "Lead",           className: "bg-blue-100 text-blue-700" },
  prospect:           { label: "Prospect",        className: "bg-purple-100 text-purple-700" },
  new_contact:        { label: "New",             className: "bg-green-100 text-green-700" },
  representation:     { label: "Representation",  className: "bg-orange-100 text-orange-700" },
  active_transaction: { label: "Active Txn",      className: "bg-red-100 text-red-700" },
  isa_qualifying:     { label: "ISA",             className: "bg-indigo-100 text-indigo-700" },
  assigned:           { label: "Assigned",        className: "bg-teal-100 text-teal-700" },
}

/** Resolve the row icon from the conversation type. Handles in_app / in-app
 *  spelling drift and folds every social_dm_* platform under one social icon. */
function channelIcon(type?: string): React.ReactNode {
  const t = (type ?? "").toLowerCase()
  if (t.startsWith("social")) return <AtSign size={14} />
  if (t === "voice" || t === "call") return <Phone size={14} />
  if (t === "sms") return <MessageSquare size={14} />
  if (t === "in_app" || t === "in-app" || t === "chat") return <Radio size={14} />
  return <Mail size={14} />
}

/** Does a conversation type belong to the selected filter chip? */
function matchesChannel(type: string | undefined, filter: ChannelFilter): boolean {
  const t = (type ?? "").toLowerCase()
  switch (filter) {
    case "All":     return true
    case "Social":  return t.startsWith("social")
    case "In-App":  return t === "in_app" || t === "in-app" || t === "chat"
    case "Voice":   return t === "voice" || t === "call"
    case "Email":   return t === "email"
    case "SMS":     return t === "sms"
    default:        return true
  }
}

const CHANNELS = ["All", "Email", "SMS", "Social", "In-App", "Voice"] as const
type ChannelFilter = typeof CHANNELS[number]
type SortOption = "newest" | "unread" | "urgency"

/** Deterministic avatar color from name */
function avatarColor(name: string): string {
  const COLORS = [
    "bg-blue-500", "bg-emerald-500", "bg-violet-500",
    "bg-amber-500", "bg-rose-500", "bg-cyan-500", "bg-indigo-500",
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return COLORS[Math.abs(hash) % COLORS.length]
}

function initials(first?: string, last?: string) {
  return `${(first?.[0] ?? "").toUpperCase()}${(last?.[0] ?? "").toUpperCase()}` || "?"
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

const WARNING_STATES = ["representation", "active_transaction", "under_contract"]

export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
  totalUnread,
  assistantName,
}: ConversationListProps) {
  const [search, setSearch] = useState("")
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("All")
  const [sort, setSort] = useState<SortOption>("newest")

  const filtered = useMemo(() => {
    let list = [...conversations]

    // channel filter
    if (channelFilter !== "All") {
      list = list.filter(c => matchesChannel(c.type, channelFilter))
    }

    // search by contact / lead name
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c => {
        const name = c.party === "lead"
          ? (c.lead_name ?? "").toLowerCase()
          : `${c.contacts?.first_name ?? ""} ${c.contacts?.last_name ?? ""}`.toLowerCase()
        return name.includes(q)
      })
    }

    // sort
    if (sort === "unread") {
      list.sort((a, b) => (b.unread_count ?? 0) - (a.unread_count ?? 0))
    } else if (sort === "urgency") {
      list.sort((a, b) => (b.urgency_score ?? 0) - (a.urgency_score ?? 0))
    } else {
      list.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
    }

    return list
  }, [conversations, search, channelFilter, sort])

  return (
    <div className="flex flex-col h-full min-w-[280px] border-r border-border bg-background">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 shrink-0 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">Inbox</h2>
          {totalUnread > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs font-bold min-w-[20px] h-5 px-1.5">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Your assistant: <span className="font-medium text-foreground">{assistantName}</span></p>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="Search contacts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Channel chips */}
        <div className="flex gap-1.5 flex-wrap">
          {CHANNELS.map(ch => (
            <button
              key={ch}
              onClick={() => setChannelFilter(ch)}
              className={cn(
                "text-xs px-2 py-0.5 rounded-full border transition-colors",
                channelFilter === ch
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-primary hover:text-foreground"
              )}
            >
              {ch}
            </button>
          ))}
        </div>

        {/* Sort */}
        <select
          className="w-full text-xs border border-border rounded-md px-2 py-1 bg-background text-foreground"
          value={sort}
          onChange={e => setSort(e.target.value as SortOption)}
        >
          <option value="newest">Newest</option>
          <option value="unread">Unread First</option>
          <option value="urgency">Urgency</option>
        </select>
      </div>

      {/* Conversation rows */}
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {filtered.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No conversations</div>
        )}
        {filtered.map(convo => {
          const contact = convo.contacts
          const isLead = convo.party === "lead"
          const name = isLead
            ? (convo.lead_name || "New lead")
            : `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim() || "Unknown"
          const lc = contact?.lifecycle_state ?? ""
          const isWarning = !isLead && WARNING_STATES.includes(lc)
          const badge = isLead
            ? { label: "Lead · AI ISA", className: "bg-indigo-100 text-indigo-700" }
            : LIFECYCLE_BADGE[lc]
          const isSelected = convo.id === selectedId
          const isNegative = convo.sentiment === "negative" || convo.sentiment === "very_negative"
          const isUrgent = (convo.urgency_score ?? 0) > 7

          return (
            <button
              key={convo.id}
              onClick={() => onSelect(convo.id)}
              className={cn(
                "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                isSelected && "bg-muted",
                isWarning && "border-l-2 border-orange-400"
              )}
            >
              {/* Avatar */}
              <div className={cn("shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold", avatarColor(name))}>
                {isLead
                  ? initials(name.split(" ")[0], name.split(" ")[1])
                  : initials(contact?.first_name, contact?.last_name)}
              </div>

              {/* Center */}
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-medium text-foreground truncate">{name}</span>
                  {badge && (
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", badge.className)}>
                      {badge.label}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate leading-relaxed">
                  {convo.last_message_preview
                    ? convo.last_message_preview.substring(0, 60)
                    : "No messages yet"}
                </p>
              </div>

              {/* Right */}
              <div className="shrink-0 flex flex-col items-end gap-1">
                <div className="flex items-center gap-1 text-muted-foreground">
                  {channelIcon(convo.type)}
                  <span className="text-[10px]">{relativeTime(convo.last_message_at)}</span>
                </div>
                <div className="flex items-center gap-1">
                  {(convo.unread_count ?? 0) > 0 && (
                    <span className="inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold min-w-[16px] h-4 px-1">
                      {convo.unread_count}
                    </span>
                  )}
                  {isNegative && <span className="w-2 h-2 rounded-full bg-destructive" title="Negative sentiment" />}
                  {isUrgent && !isNegative && <span className="w-2 h-2 rounded-full bg-orange-400" title="High urgency" />}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
