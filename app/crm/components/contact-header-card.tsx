"use client"

/**
 * ContactHeaderCard — single canonical header for the contact detail surface.
 *
 * Replaces ContactCommandStrip (gradient banner) + the redundant sidebar
 * identity area. Single home for:
 *   - Avatar, name, persona, type, status badges
 *   - Contact info (email / phone / location) with click-to-tel/mail
 *   - Source + last-touch + churn risk callouts
 *   - Action row (Call / SMS / Email / Portal / Note + More menu)
 *   - AI Pilot dropdown (single source of truth)
 *   - Channel suppression toggles (collapsible)
 *
 * All call/SMS/email actions log to activities so the audit trail is
 * consistent regardless of which surface the agent uses.
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  Phone, Mail, MessageSquare, MessageCircle, Globe, MapPin, AlertTriangle,
  ChevronDown, MoreHorizontal, Share2, FileText, Loader2, ChevronUp, X,
  UserCog, GitMerge,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { logActivity } from "@/app/actions/activities"
import { AIPilotControl } from "@/app/crm/components/ai-pilot-control"
import { ReassignContactDialog } from "@/app/crm/components/reassign-contact-dialog"
import { MergeContactsDialog } from "@/app/crm/components/merge-contacts-dialog"
import { cn } from "@/lib/utils"
import type { AIPilotLevel } from "@/app/actions/contact-intelligence"

interface ContactBasic {
  id: string
  first_name: string | null
  last_name: string | null
  email?: string | null
  phone?: string | null
  city?: string | null
  state?: string | null
  contact_type?: string | null
  contact_persona?: string | null
  buyer_stage?: string | null
  status?: string | null
  lead_source?: string | null
  /** agents.id of the owning agent — present on the raw contacts row; used to
   *  filter the current owner out of the reassign picker when available. */
  agent_id?: string | null
  dnc_status?: boolean | null
  email_opt_out?: boolean | null
  sms_opt_out?: boolean | null
  phone_opt_out?: boolean | null
  direct_mail_opt_out?: boolean | null
}

interface Props {
  contact: ContactBasic
  agentId: string
  brokerageId: string
  /** Days since last touch — derived in parent */
  daysSinceContact?: number | null
  /** Optional churn risk badge */
  churnRisk?: { churning: boolean; daysInactive?: number; reason?: string } | null
  /** AI Pilot current level */
  aiPilotLevel: AIPilotLevel | null | undefined
  /** Called when AI Pilot level changes (parent updates state) */
  onAIPilotChange: (level: AIPilotLevel) => void
  /** Action handlers — parent wires these to dialogs / routes */
  onAddNote: () => void
  onSendSMS: () => void
  onSendEmail: () => void
  onShareSocialPost?: () => void
  /** Called when an opt-out toggle changes — parent persists */
  onChannelToggle: (channel: "email" | "sms" | "phone" | "direct_mail", optOut: boolean) => Promise<void>
}

export function ContactHeaderCard({
  contact,
  agentId,
  brokerageId,
  daysSinceContact,
  churnRisk,
  aiPilotLevel,
  onAIPilotChange,
  onAddNote,
  onSendSMS,
  onSendEmail,
  onShareSocialPost,
  onChannelToggle,
}: Props) {
  const router = useRouter()
  const [channelsOpen, setChannelsOpen] = useState(false)
  const [, startTransition] = useTransition()
  const [channelLoading, setChannelLoading] = useState<string | null>(null)
  // Reassign + Merge/Dedupe affordances (dialogs enforce their own server-side
  // gates: reassign is principal/manager-only; merge is owner-or-manager).
  const [reassignOpen, setReassignOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)

  const initials = [contact.first_name?.[0], contact.last_name?.[0]]
    .filter(Boolean).join("").toUpperCase() || "?"
  const fullName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Contact"
  const location = [contact.city, contact.state].filter(Boolean).join(", ")

  // Type-keyed avatar color (matches contact list card)
  const typeKey = (contact.contact_type ?? "other").toLowerCase()
  const avatarColors = AVATAR_COLORS[typeKey] ?? AVATAR_COLORS.other

  // Recency tone
  const recencyClass =
    daysSinceContact == null            ? "text-muted-foreground" :
    daysSinceContact > 30               ? "text-red-600 font-medium" :
    daysSinceContact > 14               ? "text-amber-600" :
                                          "text-muted-foreground"

  function handleCall() {
    if (!contact.phone) return
    logActivity({
      brokerageId, agentId, contactId: contact.id,
      activityType: "call_initiated",
      title: `Call initiated with ${fullName}`,
      status: "completed",
    }).catch(() => {})
    window.location.href = `tel:${contact.phone}`
  }

  async function handleChannelToggle(channel: "email" | "sms" | "phone" | "direct_mail") {
    const isOptedOut =
      channel === "email"       ? !!contact.email_opt_out
      : channel === "sms"       ? !!contact.sms_opt_out
      : channel === "phone"     ? !!contact.phone_opt_out
      :                           !!contact.direct_mail_opt_out
    setChannelLoading(channel)
    try {
      await onChannelToggle(channel, !isOptedOut)
    } finally {
      setChannelLoading(null)
    }
  }

  return (
    <Card className={cn("border-l-4", avatarColors.border)}>
      <CardContent className="p-4 space-y-3">
        {/* Identity row */}
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className={cn(
            "h-12 w-12 rounded-full flex items-center justify-center text-base font-bold shrink-0",
            avatarColors.bg, avatarColors.text
          )}>
            {initials}
          </div>

          {/* Name + badges + meta */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold leading-none">{fullName}</h2>
              {contact.contact_type && (
                <Badge className={cn("text-[10px] px-1.5 py-0 h-[18px] leading-none", BADGE_COLORS[typeKey] ?? BADGE_COLORS.other)}>
                  {contact.contact_type === "lifetime_customer" ? "Lifetime" : contact.contact_type}
                </Badge>
              )}
              {contact.status && (
                <Badge className="text-[10px] px-1.5 py-0 h-[18px] leading-none bg-slate-100 text-slate-700">
                  {contact.status.replace(/_/g, " ")}
                </Badge>
              )}
              {contact.dnc_status && (
                <Badge className="text-[10px] px-1.5 py-0 h-[18px] leading-none bg-red-100 text-red-700">
                  DNC
                </Badge>
              )}
              {churnRisk?.churning && (
                <Badge className="text-[10px] px-1.5 py-0 h-[18px] leading-none bg-red-100 text-red-700 gap-0.5">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {churnRisk.daysInactive}d inactive
                </Badge>
              )}
            </div>

            {/* Persona / buyer-stage subtle line */}
            {(contact.contact_persona || contact.buyer_stage) && (
              <p className="text-xs text-muted-foreground capitalize">
                {[contact.contact_persona?.replace(/_/g, " "), contact.buyer_stage?.replace(/[_-]/g, " ")]
                  .filter(Boolean).join(" · ")}
              </p>
            )}

            {/* Contact info */}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {contact.email && (
                <a href={`mailto:${contact.email}`}
                   className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors truncate max-w-[260px]">
                  <Mail className="h-3 w-3 shrink-0" />
                  {contact.email}
                </a>
              )}
              {contact.phone && (
                <a href={`tel:${contact.phone}`}
                   className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors">
                  <Phone className="h-3 w-3 shrink-0" />
                  {contact.phone}
                </a>
              )}
              {location && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {location}
                </span>
              )}
            </div>

            {/* Source + last touch ribbon */}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
              {contact.lead_source && (
                <span className="text-muted-foreground">Source: <span className="text-foreground">{contact.lead_source}</span></span>
              )}
              {daysSinceContact != null && (
                <span className={recencyClass}>
                  {daysSinceContact === 0 ? "Touched today"
                   : daysSinceContact === 1 ? "Last touch: yesterday"
                   : `Last touch: ${daysSinceContact}d ago`}
                </span>
              )}
            </div>
          </div>

          {/* AI Pilot — top-right */}
          <div className="shrink-0">
            <AIPilotControl
              contactId={contact.id}
              initialLevel={aiPilotLevel}
              onChange={onAIPilotChange}
              compact
            />
          </div>
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t">
          {contact.phone && !contact.phone_opt_out && (
            <ActionBtn icon={Phone} label="Call" onClick={handleCall} tone="green" />
          )}
          {contact.phone && !contact.sms_opt_out && (
            <ActionBtn icon={MessageCircle} label="SMS" onClick={onSendSMS} tone="purple" />
          )}
          {contact.email && !contact.email_opt_out && (
            <ActionBtn icon={Mail} label="Email" onClick={onSendEmail} tone="blue" />
          )}
          <Link href={`/portal/${contact.id}`} target="_blank" className="contents">
            <ActionBtn icon={Globe} label="Portal" tone="indigo" />
          </Link>
          <ActionBtn icon={FileText} label="Note" onClick={onAddNote} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2 gap-1 text-xs">
                <MoreHorizontal className="h-3.5 w-3.5" />
                More
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onShareSocialPost && (
                <DropdownMenuItem onClick={onShareSocialPost} className="gap-2 text-xs">
                  <Share2 className="h-3.5 w-3.5" />
                  Share Social Post
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setReassignOpen(true)} className="gap-2 text-xs">
                <UserCog className="h-3.5 w-3.5" />
                Reassign to another agent
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMergeOpen(true)} className="gap-2 text-xs">
                <GitMerge className="h-3.5 w-3.5" />
                Find duplicates / Merge
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setChannelsOpen(o => !o)} className="gap-2 text-xs">
                <MessageSquare className="h-3.5 w-3.5" />
                {channelsOpen ? "Hide channel preferences" : "Channel preferences"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ReassignContactDialog
            open={reassignOpen}
            onOpenChange={setReassignOpen}
            contactId={contact.id}
            contactName={fullName}
            currentAgentId={contact.agent_id ?? null}
            onReassigned={() => router.refresh()}
          />
          <MergeContactsDialog
            open={mergeOpen}
            onOpenChange={setMergeOpen}
            contactId={contact.id}
            contactName={fullName}
            agentId={agentId}
          />

          <button
            type="button"
            onClick={() => setChannelsOpen(o => !o)}
            className="ml-auto flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Channels
            {channelsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>

        {/* Channel suppression — collapsible */}
        {channelsOpen && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Communication channels
              </p>
              <button
                type="button"
                onClick={() => setChannelsOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ChannelToggle
                label="Email"
                allowed={!contact.email_opt_out}
                disabled={!!contact.dnc_status || channelLoading === "email"}
                loading={channelLoading === "email"}
                onChange={() => handleChannelToggle("email")}
              />
              <ChannelToggle
                label="SMS"
                allowed={!contact.sms_opt_out}
                disabled={!!contact.dnc_status || channelLoading === "sms"}
                loading={channelLoading === "sms"}
                onChange={() => handleChannelToggle("sms")}
              />
              <ChannelToggle
                label="Phone"
                allowed={!contact.phone_opt_out}
                disabled={!!contact.dnc_status || channelLoading === "phone"}
                loading={channelLoading === "phone"}
                onChange={() => handleChannelToggle("phone")}
              />
              <ChannelToggle
                label="Direct Mail"
                allowed={!contact.direct_mail_opt_out}
                disabled={channelLoading === "direct_mail"}
                loading={channelLoading === "direct_mail"}
                onChange={() => handleChannelToggle("direct_mail")}
              />
            </div>
            {contact.dnc_status && (
              <p className="text-[11px] text-red-600">
                Contact is on the Do Not Contact list — phone/SMS/email channels suppressed.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AVATAR_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  buyer:             { bg: "bg-blue-100",    text: "text-blue-700",    border: "border-l-blue-500" },
  seller:            { bg: "bg-green-100",   text: "text-green-700",   border: "border-l-green-500" },
  investor:          { bg: "bg-purple-100",  text: "text-purple-700",  border: "border-l-purple-500" },
  lifetime_customer: { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-l-emerald-500" },
  other:             { bg: "bg-gray-100",    text: "text-gray-600",    border: "border-l-gray-400" },
}

const BADGE_COLORS: Record<string, string> = {
  buyer:             "bg-blue-50 text-blue-700",
  seller:            "bg-green-50 text-green-700",
  investor:          "bg-purple-50 text-purple-700",
  lifetime_customer: "bg-emerald-50 text-emerald-700",
  other:             "bg-gray-50 text-gray-600",
}

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  tone,
}: {
  icon: any
  label: string
  onClick?: () => void
  tone?: "green" | "purple" | "blue" | "indigo"
}) {
  const toneClass =
    tone === "green"   ? "hover:text-green-600 hover:border-green-400"
    : tone === "purple" ? "hover:text-purple-600 hover:border-purple-400"
    : tone === "blue"   ? "hover:text-blue-600 hover:border-blue-400"
    : tone === "indigo" ? "hover:text-indigo-600 hover:border-indigo-400"
    : "hover:text-foreground hover:border-foreground"
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 px-2 rounded-md border bg-background text-xs font-medium",
        "flex items-center gap-1 text-muted-foreground transition-colors",
        toneClass,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

function ChannelToggle({
  label,
  allowed,
  disabled,
  loading,
  onChange,
}: {
  label: string
  allowed: boolean
  disabled?: boolean
  loading?: boolean
  onChange: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex items-center gap-1.5">
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <Switch checked={allowed} disabled={disabled} onCheckedChange={onChange} />
      </div>
    </div>
  )
}
