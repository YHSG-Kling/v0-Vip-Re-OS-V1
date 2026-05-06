"use client"

/**
 * UnifiedInboxSlideOut — slide-out panel showing recent conversations
 * across all channels (SMS · email · in-app · ISA · social DMs when wired).
 *
 * Opens via:
 *   - Inbox button in the header
 *   - `U` keystroke (registered globally in app-shell)
 *
 * Fetches recent conversations from the same data source as the full inbox
 * (`/dashboard/communications/inbox`). Click into a thread to deep-link to
 * the full inbox page; reply inline for quick triage without leaving the
 * current page.
 */

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import {
  Inbox,
  X,
  MessageSquare,
  Mail,
  Phone,
  Bot,
  Sparkles,
  ChevronRight,
  Loader2,
  RefreshCw,
} from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { createClient } from "@/lib/supabase/client"

interface Conversation {
  id: string
  type: string
  channel: string | null
  unread_count: number
  last_message_at: string
  last_message_preview: string | null
  sentiment: string | null
  urgency_score: number | null
  contact: {
    id: string
    first_name: string | null
    last_name: string | null
  } | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CHANNEL_ICON: Record<string, React.ReactElement> = {
  email: <Mail className="h-3.5 w-3.5" />,
  sms: <MessageSquare className="h-3.5 w-3.5" />,
  call: <Phone className="h-3.5 w-3.5" />,
  in_app: <MessageSquare className="h-3.5 w-3.5" />,
  isa: <Bot className="h-3.5 w-3.5" />,
  social_dm: <Sparkles className="h-3.5 w-3.5" />,
}

export function UnifiedInboxSlideOut({ open, onOpenChange }: Props) {
  const [conversations, setConversations] = useState<Conversation[] | null>(null)
  const [isPending, startTransition] = useTransition()

  const loadInbox = () => {
    startTransition(async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from("conversations")
        .select(
          "id, type, channel, unread_count, last_message_at, last_message_preview, sentiment, urgency_score, " +
            "contacts(id, first_name, last_name)"
        )
        .order("last_message_at", { ascending: false })
        .limit(20)

      if (!data) {
        setConversations([])
        return
      }
      setConversations(
        (data as unknown as Array<{
          id: string
          type: string
          channel: string | null
          unread_count: number
          last_message_at: string
          last_message_preview: string | null
          sentiment: string | null
          urgency_score: number | null
          contacts: { id: string; first_name: string | null; last_name: string | null } | null
        }>).map((row) => ({
          id: row.id,
          type: row.type,
          channel: row.channel,
          unread_count: row.unread_count ?? 0,
          last_message_at: row.last_message_at,
          last_message_preview: row.last_message_preview,
          sentiment: row.sentiment,
          urgency_score: row.urgency_score,
          contact: row.contacts,
        }))
      )
    })
  }

  useEffect(() => {
    if (open) loadInbox()
  }, [open])

  const totalUnread = (conversations ?? []).reduce((s, c) => s + c.unread_count, 0)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Inbox className="h-4 w-4" />
              Inbox
              {totalUnread > 0 && (
                <Badge variant="default" className="text-[10px]">
                  {totalUnread}
                </Badge>
              )}
            </SheetTitle>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={loadInbox}
                disabled={isPending}
                title="Refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            All messages — SMS, email, calls, in-app, ISA. Press <kbd className="rounded border bg-muted px-1 text-[10px]">U</kbd> anywhere to open.
          </p>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {conversations === null && isPending ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : conversations && conversations.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-12">
              No conversations yet
            </div>
          ) : (
            <div className="divide-y">
              {(conversations ?? []).map((c) => {
                const name = c.contact
                  ? `${c.contact.first_name ?? ""} ${c.contact.last_name ?? ""}`.trim() || "Unknown"
                  : "Unknown"
                const channelKey = (c.channel ?? c.type ?? "in_app").toLowerCase()
                return (
                  <Link
                    key={c.id}
                    href={`/dashboard/communications/inbox?conversation=${c.id}`}
                    onClick={() => onOpenChange(false)}
                    className="block px-4 py-3 hover:bg-muted/40 transition"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <span className="mt-0.5 text-muted-foreground shrink-0">
                          {CHANNEL_ICON[channelKey] ?? CHANNEL_ICON.in_app}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm truncate ${c.unread_count > 0 ? "font-semibold" : "font-medium"}`}>
                              {name}
                            </span>
                            {c.urgency_score != null && c.urgency_score >= 0.7 && (
                              <Badge variant="outline" className="text-[10px] text-red-600">
                                urgent
                              </Badge>
                            )}
                          </div>
                          {c.last_message_preview && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {c.last_message_preview}
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {formatRelativeTime(c.last_message_at)}
                            {c.unread_count > 0 && ` · ${c.unread_count} unread`}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <div className="border-t p-3 shrink-0">
          <Link href="/dashboard/communications/inbox" onClick={() => onOpenChange(false)}>
            <Button variant="outline" size="sm" className="w-full text-xs">
              Open full inbox
              <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function formatRelativeTime(when: string): string {
  const ms = Date.now() - new Date(when).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const d = Math.floor(hr / 24)
  if (d < 7) return `${d}d`
  return new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
