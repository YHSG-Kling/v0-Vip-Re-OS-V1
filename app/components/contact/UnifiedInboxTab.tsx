"use client"

/**
 * app/components/contact/UnifiedInboxTab.tsx
 *
 * Unified cross-channel message timeline for a contact or lead record.
 *
 * Pulls from three sources (merged + sorted chronologically):
 *   1. messages     — email, sms, social, direct_mail, in_app rows
 *   2. voice_calls  — phone channel (inbound + outbound calls)
 *   3. isa_outreach_log — ISA first-touch logs with channel metadata
 *
 * Renders as a vertical timeline with per-channel icons, direction
 * badges (inbound / outbound), and status chips.
 */

import { useState, useEffect, useCallback } from "react"
import {
  Mail,
  MessageSquare,
  Phone,
  MapPin,
  Facebook,
  Instagram,
  Linkedin,
  Twitter,
  RefreshCw,
  ArrowDownLeft,
  ArrowUpRight,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Bot,
  Loader2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { createClient } from "@/lib/supabase/client"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type Channel =
  | "email"
  | "sms"
  | "phone"
  | "direct_mail"
  | "social"
  | "facebook"
  | "instagram"
  | "linkedin"
  | "twitter"
  | "in_app"
  | "ai"
  | "voice"

type Direction = "inbound" | "outbound" | "internal"

interface TimelineEntry {
  id: string
  source: "message" | "voice_call" | "isa_outreach"
  channel: Channel
  direction: Direction
  subject?: string
  body?: string
  status?: string
  callDuration?: number
  createdAt: string
}

// ─── CHANNEL META ─────────────────────────────────────────────────────────────

function channelIcon(channel: Channel, size = 13) {
  const cls = "shrink-0"
  switch (channel) {
    case "email":
      return <Mail size={size} className={cn(cls, "text-blue-600")} />
    case "sms":
      return <MessageSquare size={size} className={cn(cls, "text-green-600")} />
    case "phone":
    case "voice":
      return <Phone size={size} className={cn(cls, "text-violet-600")} />
    case "direct_mail":
      return <MapPin size={size} className={cn(cls, "text-amber-600")} />
    case "facebook":
      return <Facebook size={size} className={cn(cls, "text-blue-500")} />
    case "instagram":
      return <Instagram size={size} className={cn(cls, "text-pink-500")} />
    case "linkedin":
      return <Linkedin size={size} className={cn(cls, "text-sky-700")} />
    case "twitter":
      return <Twitter size={size} className={cn(cls, "text-sky-500")} />
    case "social":
      return <MessageSquare size={size} className={cn(cls, "text-indigo-500")} />
    default:
      return <Bot size={size} className={cn(cls, "text-muted-foreground")} />
  }
}

function channelLabel(channel: Channel): string {
  const MAP: Record<string, string> = {
    email: "Email",
    sms: "SMS",
    phone: "Phone",
    voice: "Phone",
    direct_mail: "Direct Mail",
    facebook: "Facebook",
    instagram: "Instagram",
    linkedin: "LinkedIn",
    twitter: "Twitter",
    social: "Social",
    in_app: "In-App",
    ai: "AI",
  }
  return MAP[channel] ?? channel
}

function directionIcon(direction: Direction, callStatus?: string) {
  if (callStatus === "no_answer" || callStatus === "busy" || callStatus === "failed") {
    return <PhoneMissed size={11} className="text-destructive shrink-0" />
  }
  if (direction === "inbound") {
    return <PhoneIncoming size={11} className="text-green-600 shrink-0" />
  }
  if (direction === "outbound") {
    return <PhoneOutgoing size={11} className="text-primary shrink-0" />
  }
  return null
}

function statusChip(status?: string) {
  if (!status) return null
  const color =
    status === "sent" || status === "delivered" || status === "completed"
      ? "bg-green-100 text-green-700"
      : status === "queued" || status === "pending_manual"
        ? "bg-amber-100 text-amber-700"
        : status === "failed" || status === "bounced"
          ? "bg-red-100 text-red-700"
          : "bg-muted text-muted-foreground"
  return (
    <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full font-medium capitalize", color)}>
      {status.replace(/_/g, " ")}
    </span>
  )
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDuration(seconds?: number) {
  if (!seconds) return null
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

interface UnifiedInboxTabProps {
  contactId: string
  /** compact = used inside ContactDetailPane sidebar; full = standalone tab */
  variant?: "compact" | "full"
}

export default function UnifiedInboxTab({
  contactId,
  variant = "compact",
}: UnifiedInboxTabProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [channelFilter, setChannelFilter] = useState<Channel | "all">("all")

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()

    // 1. Messages (all channels)
    const { data: msgs } = await supabase
      .from("messages")
      .select("id, type, channel, direction, subject, body, status, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50)

    // 2. Voice calls
    const { data: calls } = await supabase
      .from("voice_calls")
      .select("id, direction, status, started_at, duration_seconds")
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(20)

    // 3. ISA outreach log
    const { data: outreach } = await supabase
      .from("isa_outreach_log")
      .select("id, channel, subject, body_snippet, created_at")
      .eq("lead_id", contactId)
      .order("created_at", { ascending: false })
      .limit(20)

    const timeline: TimelineEntry[] = []

    for (const m of msgs ?? []) {
      timeline.push({
        id: `msg-${m.id}`,
        source: "message",
        channel: (m.channel ?? m.type ?? "email") as Channel,
        direction: (m.direction ?? "outbound") as Direction,
        subject: m.subject ?? undefined,
        body: m.body?.slice(0, 180) ?? undefined,
        status: m.status ?? undefined,
        createdAt: m.created_at,
      })
    }

    for (const c of calls ?? []) {
      timeline.push({
        id: `call-${c.id}`,
        source: "voice_call",
        channel: "phone",
        direction: (c.direction ?? "outbound") as Direction,
        body: c.status ?? undefined,
        status: c.status ?? undefined,
        callDuration: c.duration_seconds ?? undefined,
        createdAt: c.started_at ?? new Date().toISOString(),
      })
    }

    for (const o of outreach ?? []) {
      // Deduplicate: only add if no matching message row already present
      const duplicate = timeline.find(
        (t) =>
          t.source === "message" &&
          t.channel === (o.channel as Channel) &&
          Math.abs(new Date(t.createdAt).getTime() - new Date(o.created_at).getTime()) < 5000
      )
      if (!duplicate) {
        timeline.push({
          id: `outreach-${o.id}`,
          source: "isa_outreach",
          channel: (o.channel ?? "email") as Channel,
          direction: "outbound",
          subject: o.subject ?? undefined,
          body: o.body_snippet?.slice(0, 180) ?? undefined,
          status: "sent",
          createdAt: o.created_at,
        })
      }
    }

    // Sort descending by date
    timeline.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )

    setEntries(timeline)
    setLoading(false)
  }, [contactId])

  useEffect(() => {
    if (contactId) load()
  }, [contactId, load])

  const filtered =
    channelFilter === "all"
      ? entries
      : entries.filter((e) => e.channel === channelFilter)

  // Derive available channel filters from entries
  const availableChannels = Array.from(new Set(entries.map((e) => e.channel)))

  return (
    <div className={cn("flex flex-col", variant === "full" ? "h-full" : "")}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Unified Inbox
        </p>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Refresh"
        >
          <RefreshCw size={11} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      {/* Channel filter chips */}
      {availableChannels.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-3">
          <button
            type="button"
            onClick={() => setChannelFilter("all")}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium border transition-colors",
              channelFilter === "all"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            )}
          >
            All
          </button>
          {availableChannels.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setChannelFilter(ch)}
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border transition-colors",
                channelFilter === ch
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              )}
            >
              {channelIcon(ch, 10)}
              {channelLabel(ch)}
            </button>
          ))}
        </div>
      )}

      {/* Timeline */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 size={13} className="animate-spin" />
          Loading messages…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          No messages recorded yet.
        </p>
      ) : (
        <div className="relative space-y-0">
          {/* Vertical line */}
          <div
            className="absolute left-[17px] top-0 bottom-0 w-px bg-border"
            aria-hidden
          />

          {filtered.map((entry, idx) => (
            <div key={entry.id} className="relative flex gap-3 pb-3">
              {/* Channel icon bubble */}
              <div className="shrink-0 z-10 w-[35px] flex items-start justify-center pt-0.5">
                <div className="w-7 h-7 rounded-full border border-border bg-background flex items-center justify-center shadow-sm">
                  {channelIcon(entry.channel, 13)}
                </div>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pt-0.5">
                {/* Row 1: channel + direction badge + status */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-semibold text-foreground">
                    {channelLabel(entry.channel)}
                  </span>

                  <span
                    className={cn(
                      "flex items-center gap-0.5 text-[9px] font-medium px-1.5 py-0.5 rounded-full",
                      entry.direction === "inbound"
                        ? "bg-green-100 text-green-700"
                        : "bg-primary/10 text-primary"
                    )}
                  >
                    {entry.direction === "inbound" ? (
                      <ArrowDownLeft size={9} />
                    ) : (
                      <ArrowUpRight size={9} />
                    )}
                    {entry.direction}
                  </span>

                  {statusChip(entry.status)}

                  {entry.source === "isa_outreach" && (
                    <span className="flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                      <Bot size={9} />
                      AI ISA
                    </span>
                  )}
                </div>

                {/* Subject line */}
                {entry.subject && (
                  <p className="text-[11px] text-foreground font-medium mt-0.5 truncate">
                    {entry.subject}
                  </p>
                )}

                {/* Body snippet */}
                {entry.body && entry.source !== "voice_call" && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                    {entry.body}
                  </p>
                )}

                {/* Call duration */}
                {entry.source === "voice_call" && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {entry.status === "in_progress"
                      ? "In progress…"
                      : entry.status === "no_answer"
                        ? "No answer"
                        : entry.status === "busy"
                          ? "Busy"
                          : entry.status === "completed"
                            ? `Completed${entry.callDuration ? ` · ${formatDuration(entry.callDuration)}` : ""}`
                            : entry.status ?? "—"}
                  </p>
                )}

                {/* Timestamp */}
                <p className="text-[10px] text-muted-foreground mt-1">
                  {formatDate(entry.createdAt)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
