"use client"

/**
 * QualificationSummaryCard
 *
 * Renders the AI ISA's structured handoff brief at the top of the contact
 * detail view — the first thing the agent sees the moment a contact lands.
 *
 * Reads from contacts.isa_handoff_brief (jsonb). Brief is generated at the
 * `qualified` ISA outcome and carried forward at conversion time.
 */

import {
  Star,
  Sparkles,
  Phone,
  Mail,
  MessageSquare,
  ClipboardList,
  Calendar,
  TrendingUp,
  ChevronRight,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export interface IsaHandoffBriefShape {
  generatedAt?: string
  qualificationScore?: number | null
  contactType?: "buyer" | "seller" | "investor" | "both" | null
  summary?: string
  motivation?: { type?: string | null; confidence?: number | null; detail?: string | null }
  timeline?: { label?: string | null; months?: number | null; raw?: string | null }
  urgency?: "low" | "medium" | "high" | "urgent" | null
  budget?: { min?: number | null; max?: number | null; formattedRange?: string | null }
  property?: { address?: string | null; zipCode?: string | null; type?: string | null; beds?: number | null; baths?: number | null }
  lender?: { status?: "cash" | "pre_approved" | "needs_pre_approval" | "unknown" | null; notes?: string | null }
  equity?: { estimate?: number | null; formatted?: string | null }
  conversationHistory?: Array<{
    when: string
    channel: "email" | "sms" | "call" | "form" | "other"
    summary: string
    outcome?: string | null
  }>
  suggestedNextStep?: { action: string; reason: string; cta?: "schedule_consultation" | "send_message" | "schedule_listing_appointment" | "schedule_tour" | null }
}

interface Props {
  brief: IsaHandoffBriefShape | null | undefined
  contactName: string
  handoffAt?: string | null
  onSchedule?: () => void
  onSendMessage?: () => void
  onViewFullProfile?: () => void
}

const URGENCY_BADGE: Record<string, { label: string; className: string }> = {
  urgent: { label: "Urgent", className: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300" },
  high: { label: "High", className: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300" },
  medium: { label: "Medium", className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300" },
  low: { label: "Low", className: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300" },
}

const CHANNEL_ICON: Record<string, React.ReactElement> = {
  email: <Mail className="h-3 w-3" />,
  sms: <MessageSquare className="h-3 w-3" />,
  call: <Phone className="h-3 w-3" />,
  form: <ClipboardList className="h-3 w-3" />,
  other: <Sparkles className="h-3 w-3" />,
}

function formatRelativeTime(when: string): string {
  const ms = Date.now() - new Date(when).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

function formatLenderStatus(status: string | null | undefined): string | null {
  if (!status) return null
  const map: Record<string, string> = {
    cash: "Cash buyer",
    pre_approved: "Pre-approved",
    needs_pre_approval: "Needs pre-approval",
    unknown: "Unknown",
  }
  return map[status] ?? status
}

export function QualificationSummaryCard(props: Props) {
  const { brief, contactName, handoffAt, onSchedule, onSendMessage, onViewFullProfile } = props

  if (!brief) return null

  const urgencyConfig = brief.urgency ? URGENCY_BADGE[brief.urgency] : null
  const score = brief.qualificationScore
  const handoffAge = handoffAt ? formatRelativeTime(handoffAt) : null

  return (
    <Card className="border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/20 dark:to-orange-950/20">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center h-8 w-8 rounded-full bg-amber-100 dark:bg-amber-900/40">
              <Star className="h-4 w-4 text-amber-600 dark:text-amber-400 fill-amber-500" />
            </div>
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {contactName}
                <Badge className="bg-amber-500 hover:bg-amber-600 text-white text-[10px] gap-0.5">
                  <Sparkles className="h-2.5 w-2.5" />
                  Qualified
                </Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Assigned to you by AI ISA{handoffAge ? ` · ${handoffAge}` : ""}
                {score != null ? ` · score ${Math.round(score)}` : ""}
              </p>
            </div>
          </div>
          {urgencyConfig && (
            <Badge variant="outline" className={`text-[10px] ${urgencyConfig.className}`}>
              {urgencyConfig.label}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ISA Qualification Summary */}
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
            ISA Qualification Summary
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {brief.contactType && (
              <Row label="Type" value={contactTypeLabel(brief.contactType, brief.motivation?.type)} />
            )}
            {brief.timeline?.label && <Row label="Timeline" value={brief.timeline.label} />}
            {brief.motivation?.detail && (
              <Row label="Motivation" value={brief.motivation.detail} fullWidth />
            )}
            {brief.property?.address && (
              <Row label="Property" value={brief.property.address} fullWidth />
            )}
            {brief.budget?.formattedRange && <Row label="Budget" value={brief.budget.formattedRange} />}
            {brief.equity?.formatted && <Row label="Equity" value={`~${brief.equity.formatted} estimated`} />}
            {brief.lender?.status && <Row label="Lender" value={formatLenderStatus(brief.lender.status) ?? "—"} />}
          </div>
        </div>

        {/* Conversation History */}
        {brief.conversationHistory && brief.conversationHistory.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
              Conversation History
            </p>
            <div className="space-y-1.5">
              {brief.conversationHistory.slice(-5).map((touch, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Touch {idx + 1}</span>
                  <span className="flex items-center gap-1 text-muted-foreground">
                    {CHANNEL_ICON[touch.channel] ?? CHANNEL_ICON.other}
                    {touch.channel}
                  </span>
                  <span className="text-foreground">· {touch.summary}</span>
                  <span className="text-muted-foreground ml-auto">
                    {new Date(touch.when).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Suggested Next Step */}
        {brief.suggestedNextStep && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-100/50 dark:bg-amber-950/40 p-3">
            <div className="flex items-start gap-2">
              <TrendingUp className="h-4 w-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground mb-0.5">Suggested Next Step</p>
                <p className="text-xs text-foreground">{brief.suggestedNextStep.action}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{brief.suggestedNextStep.reason}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {(brief.suggestedNextStep.cta === "schedule_consultation" ||
                brief.suggestedNextStep.cta === "schedule_listing_appointment" ||
                brief.suggestedNextStep.cta === "schedule_tour") && (
                <Button size="sm" className="h-7 text-xs gap-1" onClick={onSchedule}>
                  <Calendar className="h-3 w-3" />
                  Schedule
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onSendMessage}>
                <MessageSquare className="h-3 w-3" />
                Send Message
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 ml-auto" onClick={onViewFullProfile}>
                View Full Profile
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Row({ label, value, fullWidth }: { label: string; value: string; fullWidth?: boolean }) {
  return (
    <div className={fullWidth ? "col-span-2" : ""}>
      <span className="text-muted-foreground inline-block w-20">{label}:</span>
      <span className="text-foreground">{value}</span>
    </div>
  )
}

function contactTypeLabel(type: string, motivation?: string | null): string {
  if (motivation) {
    const m = motivation.replace(/_/g, " ").trim()
    return m.charAt(0).toUpperCase() + m.slice(1)
  }
  const map: Record<string, string> = {
    buyer: "Buyer",
    seller: "Seller",
    investor: "Investor",
    both: "Buyer + Seller",
  }
  return map[type] ?? type
}
