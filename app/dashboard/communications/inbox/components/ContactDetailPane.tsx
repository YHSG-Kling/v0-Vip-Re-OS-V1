"use client"

import { useState, useEffect } from "react"
import { Mail, Phone, User, TrendingUp, Circle, ShieldAlert, CalendarPlus, ListPlus, Inbox, Settings2, PhoneOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { createClient } from "@/lib/supabase/client"
import UnifiedInboxTab from "@/app/components/contact/UnifiedInboxTab"
import ContactChannelControls from "@/app/components/contact/ContactChannelControls"
import type { PreferredChannel, SocialHandles } from "@/app/actions/contacts/update-channel-controls"

type ConversationContact = {
  id: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  lifecycle_state?: string
  lead_score?: number
  preferred_channel?: PreferredChannel | null
  social_handles?: SocialHandles | null
  call_stop_flag?: boolean
}

interface ContactDetailPaneProps {
  contact: ConversationContact | null
  agentId: string
  sentimentSummary?: {
    sentiment: string
    urgency: string
    keyTopics?: string[]
    requiresImmediateAction?: boolean
  } | null
}

const LIFECYCLE_COLOR: Record<string, string> = {
  lead:               "text-blue-600",
  prospect:           "text-purple-600",
  new_contact:        "text-green-600",
  representation:     "text-orange-600",
  active_transaction: "text-red-600",
  isa_qualifying:     "text-indigo-600",
  assigned:           "text-teal-600",
}

const SENTIMENT_COLOR: Record<string, string> = {
  very_positive: "text-emerald-600",
  positive:      "text-green-600",
  neutral:       "text-muted-foreground",
  negative:      "text-orange-600",
  very_negative: "text-destructive",
  urgent:        "text-destructive",
}

const URGENCY_COLOR: Record<string, string> = {
  low:      "text-green-600",
  medium:   "text-amber-600",
  high:     "text-orange-600",
  critical: "text-destructive",
}

const AUTHORITY_STATES = ["representation", "active_transaction", "under_contract"]

function scoreColor(score?: number) {
  if (!score) return "text-muted-foreground"
  if (score >= 80) return "text-green-600"
  if (score >= 50) return "text-amber-600"
  return "text-destructive"
}

type ISAActivity = {
  id: string
  activity_type: string
  channel?: string
  status?: string
  notes?: string
  created_at: string
}

function activityIcon(type: string) {
  const icons: Record<string, string> = {
    call:       "📞",
    email:      "✉️",
    sms:        "💬",
    task:       "✓",
    note:       "📝",
  }
  return icons[type] ?? "•"
}

type DetailTab = "activity" | "inbox" | "channels"

export default function ContactDetailPane({ contact, sentimentSummary, agentId }: ContactDetailPaneProps) {
  const [activities, setActivities]   = useState<ISAActivity[]>([])
  const [actLoading, setActLoading]   = useState(false)
  const [actionMsg, setActionMsg]     = useState<string | null>(null)
  const [activeTab, setActiveTab]     = useState<DetailTab>("activity")

  // Load ISA activities when contact changes
  useEffect(() => {
    if (!contact?.id) {
      setActivities([])
      return
    }
    setActLoading(true)
    const supabase = createClient()
    supabase
      .from("ai_isa_activities")
      .select("id, activity_type, channel, status, notes, created_at")
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }: { data: any }) => {
        setActivities(data ?? [])
        setActLoading(false)
      })
  }, [contact?.id])

  if (!contact) {
    return (
      <div className="w-64 border-l border-border bg-background flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
        Select a conversation to see contact details
      </div>
    )
  }

  const name = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown"
  const lc   = contact.lifecycle_state ?? ""
  const isAuthorityBlocked = AUTHORITY_STATES.includes(lc)

  async function quickEnrollSequence() {
    setActionMsg("Opening sequence enrollment…")
    // Navigate to sequences page with contact pre-filled
    window.open(`/dashboard/communications/sequences?contactId=${contact!.id}`, "_blank")
    setTimeout(() => setActionMsg(null), 2000)
  }

  async function quickScheduleShowing() {
    setActionMsg("Opening showing scheduler…")
    window.open(`/contacts/${contact!.id}?tab=showings`, "_blank")
    setTimeout(() => setActionMsg(null), 2000)
  }

  return (
    <div className="w-64 border-l border-border bg-background overflow-y-auto shrink-0">
      <div className="p-4 space-y-4">

        {/* Authority block banner */}
        {isAuthorityBlocked && (
          <div className="flex items-start gap-2 text-xs text-orange-800 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
            <ShieldAlert size={13} className="shrink-0 mt-0.5 text-orange-600" />
            <span>
              <strong>Authority Block</strong> — AI outreach disabled for{" "}
              <span className="capitalize">{lc.replace(/_/g, " ")}</span>.
              Broker oversight required.
            </span>
          </div>
        )}

        {/* Contact header */}
        <div className="flex flex-col items-center text-center gap-2 pt-2">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <User size={22} className="text-primary" />
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground">{name}</p>
            {lc && (
              <span className={cn("text-xs font-medium capitalize", LIFECYCLE_COLOR[lc] ?? "text-muted-foreground")}>
                {lc.replace(/_/g, " ")}
              </span>
            )}
          </div>
        </div>

        {/* Lead score */}
        {contact.lead_score !== undefined && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground flex items-center gap-1">
              <TrendingUp size={13} /> Lead Score
            </span>
            <span className={cn("font-bold text-base", scoreColor(contact.lead_score))}>
              {contact.lead_score}
            </span>
          </div>
        )}

        {/* Contact info */}
        <div className="space-y-2">
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors truncate"
            >
              <Mail size={12} className="shrink-0" />
              <span className="truncate">{contact.email}</span>
            </a>
          )}
          {contact.phone && (
            <a
              href={`tel:${contact.phone}`}
              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Phone size={12} className="shrink-0" />
              <span>{contact.phone}</span>
            </a>
          )}
        </div>

        {/* Quick actions */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Quick Actions</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={quickEnrollSequence}
              className="flex flex-col items-center gap-1 rounded-lg border border-border bg-muted/40 hover:bg-muted px-2 py-2.5 text-[11px] text-foreground transition-colors"
            >
              <ListPlus size={16} className="text-primary" />
              Add to Sequence
            </button>
            <button
              onClick={quickScheduleShowing}
              className="flex flex-col items-center gap-1 rounded-lg border border-border bg-muted/40 hover:bg-muted px-2 py-2.5 text-[11px] text-foreground transition-colors"
            >
              <CalendarPlus size={16} className="text-primary" />
              Schedule Showing
            </button>
          </div>
          {actionMsg && (
            <p className="text-[10px] text-primary text-center animate-pulse">{actionMsg}</p>
          )}
        </div>

        {/* Sentiment */}
        {sentimentSummary && (
          <div className="border border-border rounded-lg p-3 space-y-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">AI Sentiment</p>

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Sentiment</span>
              <span className={cn("font-medium capitalize", SENTIMENT_COLOR[sentimentSummary.sentiment] ?? "text-foreground")}>
                {sentimentSummary.sentiment?.replace(/_/g, " ")}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Urgency</span>
              <span className={cn("font-medium capitalize", URGENCY_COLOR[sentimentSummary.urgency] ?? "text-foreground")}>
                {sentimentSummary.urgency}
              </span>
            </div>

            {sentimentSummary.requiresImmediateAction && (
              <div className="flex items-center gap-1.5 text-xs text-destructive bg-destructive/5 rounded px-2 py-1">
                <Circle size={6} className="fill-destructive" />
                Requires immediate action
              </div>
            )}

            {sentimentSummary.keyTopics && sentimentSummary.keyTopics.length > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground mb-1">Key Topics</p>
                <div className="flex flex-wrap gap-1">
                  {sentimentSummary.keyTopics.slice(0, 5).map(t => (
                    <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full text-foreground">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Tab strip ──────────────────────────────────────────────────────── */}
        <div className="flex rounded-lg border border-border overflow-hidden text-[11px]">
          {(
            [
              { id: "activity" as const, label: "Activity",  icon: <TrendingUp size={11} /> },
              { id: "inbox"    as const, label: "Inbox",     icon: <Inbox size={11} /> },
              { id: "channels" as const, label: "Channels",  icon: <Settings2 size={11} /> },
            ] satisfies { id: DetailTab; label: string; icon: React.ReactNode }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1 py-1.5 font-medium transition-colors",
                activeTab === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Tab: Activity ──────────────────────────────────────────────────── */}
        {activeTab === "activity" && (
          <div>
            {actLoading ? (
              <p className="text-[11px] text-muted-foreground">Loading…</p>
            ) : activities.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No recorded ISA activities.</p>
            ) : (
              <div className="space-y-2">
                {activities.map(act => (
                  <div key={act.id} className="flex gap-2 text-[11px]">
                    <span className="shrink-0 w-4 text-center">{activityIcon(act.activity_type)}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground capitalize">
                        {act.activity_type}
                        {act.channel && <span className="text-muted-foreground font-normal"> · {act.channel}</span>}
                      </p>
                      {act.notes && (
                        <p className="text-muted-foreground truncate">{act.notes}</p>
                      )}
                      <p className="text-muted-foreground text-[10px]">
                        {new Date(act.created_at).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                    {act.status && (
                      <span className={cn(
                        "shrink-0 text-[9px] px-1 py-0.5 rounded-full font-medium capitalize h-fit",
                        act.status === "completed" ? "bg-green-100 text-green-700" :
                        act.status === "failed"    ? "bg-red-100 text-red-700" :
                                                     "bg-muted text-muted-foreground"
                      )}>
                        {act.status}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Unified Inbox ─────────────────────────────────────────────── */}
        {activeTab === "inbox" && (
          <UnifiedInboxTab contactId={contact.id} variant="compact" />
        )}

        {/* ── Tab: Channel Controls ──────────────────────────────────────────── */}
        {activeTab === "channels" && (
          <>
            {/* Call stop indicator at-a-glance */}
            {contact.call_stop_flag && (
              <div className="flex items-center gap-1.5 text-[11px] text-destructive bg-destructive/5 border border-destructive/20 rounded-lg px-2.5 py-2">
                <PhoneOff size={12} className="shrink-0" />
                <span>Calls are currently <strong>stopped</strong> for this contact.</span>
              </div>
            )}
            <ContactChannelControls
              contactId={contact.id}
              initialPreferredChannel={contact.preferred_channel}
              initialSocialHandles={contact.social_handles}
              initialCallStopFlag={contact.call_stop_flag ?? false}
            />
          </>
        )}

        {/* View profile link */}
        <a
          href={`/contacts/${contact.id}`}
          className="block text-center text-xs text-primary hover:underline pt-1 pb-1"
        >
          View full profile
        </a>
      </div>
    </div>
  )
}
