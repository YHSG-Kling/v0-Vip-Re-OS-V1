"use client"

/**
 * UnifiedInboxSlideOut — slide-out panel showing recent conversations
 * across all channels (SMS · email · in-app · ISA · social DMs when wired).
 *
 * Opens via:
 *   - Inbox button in the header
 *   - `U` keystroke (registered globally in app-shell)
 *
 * Keyboard verbs (fire when slide-out is open and no input is focused):
 *   ↑ / ↓   navigate threads
 *   R       open inline reply composer for the selected thread
 *   A       AI-draft a reply into the composer in the agent's voice
 *   T       create a follow-up task for the selected contact
 *   ⌘↩ / S  send the composer when it has content
 *   Esc     close the composer (or the slide-out if composer is closed)
 *
 * Fetches recent conversations from the same data source as the full inbox
 * (`/dashboard/communications/inbox`). Click into a thread to deep-link to
 * the full inbox page; reply inline for quick triage without leaving the
 * current page.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
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
  Reply,
  Send,
  CheckCircle2,
  ListTodo,
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
import { sendInboxMessage, forceComplianceOverrideAndSend } from "@/app/actions/inbox"
import { quickDraftForConversation } from "@/app/actions/inbox-quick-draft"
import { createTask } from "@/app/actions/tasks"

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

// Channels the inline composer can send through. Calls/ISA replays are not
// re-sent from here — the agent deep-links into the full inbox for those.
const REPLYABLE = new Set(["email", "sms", "in_app", "portal", "chat"])
type SendChannel = "sms" | "email" | "portal" | "chat"

function toSendChannel(raw: string | null | undefined): SendChannel | null {
  const k = (raw ?? "").toLowerCase()
  if (k === "sms") return "sms"
  if (k === "email") return "email"
  if (k === "in_app" || k === "portal") return "portal"
  if (k === "chat") return "chat"
  return null
}

// UI gate mirrors lib/kernel/portal-auth requireOverrideActor. Server is the
// real boundary — hiding the override panel from a regular agent is UX only.
const COMPLIANCE_OVERRIDE_USER_TYPES = new Set([
  "broker", "broker_admin", "admin", "superadmin",
  "compliance_officer", "compliance_manager",
])

// Heuristic — server returns "Message blocked by compliance gate" / "Brand
// voice violation" / "Fair housing" etc. when evaluateOutbound denies. The
// override panel only surfaces when these phrases appear so we don't show
// the override prompt for ordinary errors (network, DNC, TCPA).
function isComplianceBlockedError(msg: string | null | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  if (m.includes("dnc") || m.includes("tcpa") || m.includes("opt") || m.includes("consent"))
    return false  // legal stops — NOT overridable
  return (
    m.includes("compliance") ||
    m.includes("brand voice") ||
    m.includes("them-first") ||
    m.includes("fair housing") ||
    m.includes("blocked")
  )
}

export function UnifiedInboxSlideOut({ open, onOpenChange }: Props) {
  const [conversations, setConversations] = useState<Conversation[] | null>(null)
  const [isPending, startTransition] = useTransition()
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Composer state
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerBody, setComposerBody] = useState("")
  const [composerLoading, setComposerLoading] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [composerSending, setComposerSending] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  // Compliance override state
  const [userType, setUserType] = useState<string | null>(null)
  const [showOverridePanel, setShowOverridePanel] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")
  const canOverrideCompliance = COMPLIANCE_OVERRIDE_USER_TYPES.has(
    (userType ?? "").toLowerCase(),
  )

  // Fetch user_type once when slide-out opens — used only to decide whether
  // to surface the override prompt when a send is blocked by compliance.
  // Server-side requireOverrideActor enforces the same set on submit.
  useEffect(() => {
    if (!open || userType !== null) return
    const supabase = createClient()
    supabase.auth.getUser().then(async (res: { data: { user: { id: string } | null } }) => {
      const user = res.data.user
      if (!user) return
      const { data } = await supabase
        .from("users")
        .select("user_type")
        .eq("id", user.id)
        .maybeSingle()
      setUserType((data?.user_type ?? "").toLowerCase())
    })
  }, [open, userType])

  // Transient confirmations
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showFlash = useCallback((text: string) => {
    setFlash(text)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2200)
  }, [])

  const loadInbox = useCallback(() => {
    startTransition(async () => {
      const supabase = createClient()
      // conversations has no `channel` (modeled as `type`) or `last_message_preview`
      // (derived from the joined messages) — mirrors the canonical inbox hub.
      const { data } = await supabase
        .from("conversations")
        .select(
          "id, type, unread_count, last_message_at, sentiment, urgency_score, " +
            "contacts(id, first_name, last_name), messages!messages_conversation_id_fkey(body, created_at)"
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
          unread_count: number
          last_message_at: string
          sentiment: string | null
          urgency_score: number | null
          contacts: { id: string; first_name: string | null; last_name: string | null } | null
          messages: { body: string | null; created_at: string }[] | null
        }>).map((row) => {
          const latest = (row.messages ?? [])
            .slice()
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
          return {
            id: row.id,
            type: row.type,
            channel: row.type,
            unread_count: row.unread_count ?? 0,
            last_message_at: row.last_message_at,
            last_message_preview: latest?.body ?? null,
            sentiment: row.sentiment,
            urgency_score: row.urgency_score,
            contact: row.contacts,
          }
        })
      )
      setSelectedIndex(0)
    })
  }, [])

  useEffect(() => {
    if (open) loadInbox()
    if (!open) {
      // Reset composer state on close
      setComposerOpen(false)
      setComposerBody("")
      setComposerError(null)
    }
  }, [open, loadInbox])

  const list = conversations ?? []
  const selected = list[selectedIndex] ?? null
  const selectedChannelKey = useMemo(
    () => (selected?.channel ?? selected?.type ?? "in_app").toLowerCase(),
    [selected],
  )
  const canReply = selected && REPLYABLE.has(selectedChannelKey)

  const totalUnread = list.reduce((s, c) => s + c.unread_count, 0)

  // ─── Verb handlers ────────────────────────────────────────────────────────

  const openComposer = useCallback(() => {
    if (!canReply) {
      showFlash(`Reply unavailable for ${selectedChannelKey}`)
      return
    }
    setComposerOpen(true)
    setComposerError(null)
    // Focus after render
    setTimeout(() => composerRef.current?.focus(), 30)
  }, [canReply, selectedChannelKey, showFlash])

  const handleAIDraft = useCallback(async () => {
    if (!selected) return
    if (!canReply) {
      showFlash(`AI draft unavailable for ${selectedChannelKey}`)
      return
    }
    setComposerOpen(true)
    setComposerLoading(true)
    setComposerError(null)
    try {
      const res = await quickDraftForConversation({ conversationId: selected.id })
      if (res.success && res.draftBody) {
        setComposerBody(res.draftBody)
        setTimeout(() => composerRef.current?.focus(), 30)
      } else {
        setComposerError(res.error ?? "Draft unavailable")
      }
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : "Draft failed")
    } finally {
      setComposerLoading(false)
    }
  }, [selected, canReply, selectedChannelKey, showFlash])

  const handleSend = useCallback(async () => {
    if (!selected?.contact?.id) {
      setComposerError("No contact for this thread")
      return
    }
    const channel = toSendChannel(selectedChannelKey)
    if (!channel) {
      setComposerError(`Cannot send to ${selectedChannelKey}`)
      return
    }
    const body = composerBody.trim()
    if (!body) return

    setComposerSending(true)
    setComposerError(null)
    setShowOverridePanel(false)
    try {
      const res = await sendInboxMessage({
        contactId: selected.contact.id,
        body,
        channel,
      })
      if (res.success) {
        showFlash("Sent")
        setComposerBody("")
        setComposerOpen(false)
        // Refresh list so the thread shows the new outbound preview
        loadInbox()
      } else {
        setComposerError(res.error ?? "Send failed")
      }
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : "Send failed")
    } finally {
      setComposerSending(false)
    }
  }, [selected, composerBody, selectedChannelKey, loadInbox, showFlash])

  // Force-send with compliance override. Available when the prior send
  // failed with a compliance-style error AND user is elevated. Server-side
  // requireOverrideActor enforces the same user_type + min-10-char reason.
  const handleForceSend = useCallback(async () => {
    if (!selected?.contact?.id) {
      setComposerError("No contact for this thread")
      return
    }
    const channel = toSendChannel(selectedChannelKey)
    if (!channel) {
      setComposerError(`Cannot send to ${selectedChannelKey}`)
      return
    }
    if (overrideReason.trim().length < 10) {
      setComposerError("Override reason must be at least 10 characters")
      return
    }
    setComposerSending(true)
    setComposerError(null)
    try {
      const res = await forceComplianceOverrideAndSend({
        contactId:      selected.contact.id,
        body:           composerBody.trim(),
        channel,
        overrideReason: overrideReason.trim(),
      })
      if (res.success) {
        showFlash("Sent with override (audit logged)")
        setComposerBody("")
        setComposerOpen(false)
        setShowOverridePanel(false)
        setOverrideReason("")
        loadInbox()
      } else {
        setComposerError(res.error ?? "Override send failed")
      }
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : "Override send failed")
    } finally {
      setComposerSending(false)
    }
  }, [selected, composerBody, selectedChannelKey, overrideReason, loadInbox, showFlash])

  const handleCreateTask = useCallback(async () => {
    if (!selected?.contact) return
    const name =
      `${selected.contact.first_name ?? ""} ${selected.contact.last_name ?? ""}`.trim() ||
      "this contact"
    try {
      const res = await createTask({
        title: `Follow up with ${name}`,
        contactId: selected.contact.id,
        priority: "medium",
      })
      if ((res as { success?: boolean }).success !== false) {
        showFlash(`Task created — Follow up with ${name}`)
      } else {
        showFlash("Task creation failed")
      }
    } catch {
      showFlash("Task creation failed")
    }
  }, [selected, showFlash])

  // ─── Global keyboard handler while slide-out is open ──────────────────────

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)

      // Composer-specific shortcuts (active when composer is open)
      if (composerOpen && isTyping && target === composerRef.current) {
        // ⌘↩ / Ctrl+↩ to send
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          handleSend()
          return
        }
        // Esc to close composer
        if (e.key === "Escape") {
          e.preventDefault()
          setComposerOpen(false)
          return
        }
        // Otherwise let the textarea handle keystrokes
        return
      }

      if (isTyping) return
      if (e.altKey) return

      switch (e.key.toLowerCase()) {
        case "arrowdown":
        case "j":
          if (list.length > 0) {
            e.preventDefault()
            setSelectedIndex((i) => Math.min(list.length - 1, i + 1))
          }
          break
        case "arrowup":
        case "k":
          if (list.length > 0) {
            e.preventDefault()
            setSelectedIndex((i) => Math.max(0, i - 1))
          }
          break
        case "r":
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          openComposer()
          break
        case "a":
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          handleAIDraft()
          break
        case "s":
          if (e.metaKey || e.ctrlKey) return
          if (composerOpen && composerBody.trim()) {
            e.preventDefault()
            handleSend()
          }
          break
        case "t":
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          handleCreateTask()
          break
        case "escape":
          if (composerOpen) {
            e.preventDefault()
            setComposerOpen(false)
          }
          break
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [
    open,
    list.length,
    composerOpen,
    composerBody,
    openComposer,
    handleAIDraft,
    handleSend,
    handleCreateTask,
  ])

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
          <p className="text-[11px] text-muted-foreground leading-snug">
            <kbd className="rounded border bg-muted px-1">↑↓</kbd> nav ·{" "}
            <kbd className="rounded border bg-muted px-1">R</kbd> reply ·{" "}
            <kbd className="rounded border bg-muted px-1">A</kbd> AI draft ·{" "}
            <kbd className="rounded border bg-muted px-1">S</kbd> send ·{" "}
            <kbd className="rounded border bg-muted px-1">T</kbd> task
          </p>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {conversations === null && isPending ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : list.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-12">
              No conversations yet
            </div>
          ) : (
            <div className="divide-y">
              {list.map((c, idx) => {
                const name = c.contact
                  ? `${c.contact.first_name ?? ""} ${c.contact.last_name ?? ""}`.trim() || "Unknown"
                  : "Unknown"
                const channelKey = (c.channel ?? c.type ?? "in_app").toLowerCase()
                const isSelected = idx === selectedIndex
                return (
                  <div key={c.id} className={isSelected ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}>
                    <button
                      type="button"
                      onClick={() => setSelectedIndex(idx)}
                      className="w-full text-left block px-4 py-3 hover:bg-muted/40 transition"
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
                        <Link
                          href={`/dashboard/communications/inbox?conversation=${c.id}`}
                          onClick={(e) => e.stopPropagation()}
                          title="Open full thread"
                          className="shrink-0 mt-1 text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </div>
                    </button>

                    {/* Inline composer attached to the selected thread */}
                    {isSelected && composerOpen && (
                      <div className="px-4 pb-3 -mt-1 space-y-2 bg-amber-50/60 dark:bg-amber-950/20">
                        <textarea
                          ref={composerRef}
                          value={composerBody}
                          onChange={(e) => setComposerBody(e.target.value)}
                          placeholder={
                            composerLoading
                              ? "AI drafting in your voice…"
                              : `Reply via ${selectedChannelKey} — ⌘↩ to send, Esc to close`
                          }
                          disabled={composerLoading}
                          rows={4}
                          className="w-full text-sm rounded-md border border-amber-200 dark:border-amber-900 bg-white dark:bg-slate-950 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                        {composerError && (
                          <p className="text-[11px] text-red-600 dark:text-red-400">{composerError}</p>
                        )}

                        {/* Compliance override prompt — surfaces only when:
                            (a) the prior send returned a compliance-style block
                            (b) user is elevated (broker / admin / compliance)
                            (c) the error isn't a hard legal stop (DNC / TCPA)
                            Server-side requireOverrideActor enforces the same
                            user_type set + min 10-char reason. */}
                        {canOverrideCompliance && isComplianceBlockedError(composerError) && !showOverridePanel && (
                          <button
                            type="button"
                            onClick={() => setShowOverridePanel(true)}
                            className="text-[11px] text-amber-700 hover:underline flex items-center gap-1.5"
                          >
                            <Sparkles className="h-3 w-3" />
                            Force send with override
                          </button>
                        )}

                        {showOverridePanel && canOverrideCompliance && (
                          <div className="border-t border-amber-200 dark:border-amber-900 pt-2 mt-1 space-y-1.5">
                            <label className="text-[11px] font-medium text-amber-700">
                              Override reason (required, min 10 chars)
                            </label>
                            <textarea
                              value={overrideReason}
                              onChange={(e) => setOverrideReason(e.target.value)}
                              placeholder="e.g. Buyer agent specifically requested this exact wording — context discussed verbally"
                              rows={2}
                              className="w-full text-xs rounded-md border border-amber-300 bg-amber-50/40 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400"
                            />
                            <p className="text-[10px] text-muted-foreground">
                              Bypasses brand voice / them-first / fair-housing wording gates. DNC + TCPA cannot
                              be overridden. Logged to <code className="text-[9px]">compliance_events</code> as
                              OVERRIDDEN with your user id + user_type.
                            </p>
                            <div className="flex items-center gap-1.5">
                              <Button
                                size="sm"
                                onClick={handleForceSend}
                                disabled={composerSending || overrideReason.trim().length < 10}
                                className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                              >
                                {composerSending ? (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                ) : (
                                  <Send className="h-3 w-3 mr-1" />
                                )}
                                Force Send
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setShowOverridePanel(false)
                                  setOverrideReason("")
                                }}
                                className="h-7 text-xs"
                              >
                                Cancel override
                              </Button>
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            onClick={handleSend}
                            disabled={composerSending || !composerBody.trim()}
                            className="h-7 text-xs"
                          >
                            {composerSending ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Send className="h-3 w-3 mr-1" />
                            )}
                            Send
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleAIDraft}
                            disabled={composerLoading}
                            className="h-7 text-xs"
                          >
                            {composerLoading ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Sparkles className="h-3 w-3 mr-1" />
                            )}
                            AI draft
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setComposerOpen(false)}
                            className="h-7 text-xs ml-auto"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>

        {/* Action bar — visible verbs for mouse users; keyboard verbs work in parallel */}
        <div className="border-t shrink-0 px-3 py-2 flex items-center gap-1.5 bg-background">
          <Button
            size="sm"
            variant="outline"
            onClick={openComposer}
            disabled={!selected || !canReply}
            className="h-7 text-xs"
            title="Reply (R)"
          >
            <Reply className="h-3 w-3 mr-1" />
            Reply
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleAIDraft}
            disabled={!selected || !canReply || composerLoading}
            className="h-7 text-xs"
            title="AI draft (A)"
          >
            <Sparkles className="h-3 w-3 mr-1" />
            AI draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCreateTask}
            disabled={!selected?.contact}
            className="h-7 text-xs"
            title="Create task (T)"
          >
            <ListTodo className="h-3 w-3 mr-1" />
            Task
          </Button>
          <Link
            href="/dashboard/communications/inbox"
            onClick={() => onOpenChange(false)}
            className="ml-auto"
          >
            <Button variant="ghost" size="sm" className="h-7 text-xs">
              Full inbox
              <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>

        {flash && (
          <div className="fixed bottom-4 right-4 z-50 bg-foreground text-background text-xs px-3 py-1.5 rounded-md shadow-lg flex items-center gap-1.5">
            <CheckCircle2 className="h-3 w-3" />
            {flash}
          </div>
        )}
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
