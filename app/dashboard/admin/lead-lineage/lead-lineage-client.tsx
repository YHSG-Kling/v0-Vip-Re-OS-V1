'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Mail,
  MapPin,
  Phone,
  MessageSquare,
  AlertTriangle,
  CheckCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  User,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { governLead } from '@/app/actions/lead-governance/govern-lead'
import { handleLeadAssigned } from '@/lib/kernel/lead-acquisition-handlers'

// ── Types ────────────────────────────────────────────────────────────────────

interface AIISAQualification {
  id: string
  qualification_score: number | null
  stage: string | null
  qualification_notes: string | null
  created_at: string
  last_outreach_at: string | null
  assigned_to_agent_id: string | null
}

interface ContactRef {
  id: string
  contact_type: string | null
  created_at: string
}

export interface Lead {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  source: string | null
  lead_score: number | null
  lifecycle_state: string | null
  status: string | null
  created_at: string
  converted_at: string | null
  assigned_agent_id: string | null
  agent_id: string | null
  enrichment_status: string | null
  enrichment_provider: string | null
  dedupe_status: string | null
  minimum_viable_for_isa: boolean | null
  mailing_address_verified: boolean | null
  mailing_address: string | null
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
  tcpa_consent: boolean | null
  tcpa_consent_at: string | null
  tcpa_consent_source: string | null
  ai_isa_owner: boolean | null
  handed_to_agent_at: string | null
  raw_record_id: string | null
  ai_isa_qualifications: AIISAQualification[] | null
  contacts: ContactRef[] | null
}

// ── Stage derivation (Kernel OS rules) ───────────────────────────────────────

export const STAGES = [
  { key: 'raw_record',   label: 'Raw Record',          color: 'bg-slate-400' },
  { key: 'deduped',      label: 'Deduped',              color: 'bg-slate-600' },
  { key: 'enriched',     label: 'Enriched',             color: 'bg-indigo-500' },
  { key: 'eligible',     label: 'ISA Eligible',         color: 'bg-blue-500' },
  { key: 'isa_followup', label: 'AI-ISA Working',       color: 'bg-violet-500' },
  { key: 'qualified',    label: 'Qualified',            color: 'bg-orange-500' },
  { key: 'assigned',     label: 'Agent Assigned',       color: 'bg-amber-500' },
  { key: 'converted',    label: 'Converted Contact',    color: 'bg-yellow-500' },
  { key: 'lifetime',     label: 'Transaction / Lifetime', color: 'bg-green-500' },
]

export function deriveLineageStage(lead: Lead): string {
  if (lead.contacts && lead.contacts.length > 0) {
    return lead.status === 'closed' ? 'lifetime' : 'converted'
  }
  if (lead.agent_id || lead.assigned_agent_id) return 'assigned'
  if (lead.ai_isa_qualifications?.some((q) => q.stage === 'qualified')) return 'qualified'
  if (lead.ai_isa_owner) return 'isa_followup'
  if (lead.minimum_viable_for_isa) return 'eligible'
  if (lead.enrichment_status === 'complete') return 'enriched'
  if (lead.dedupe_status === 'complete') return 'deduped'
  return 'raw_record'
}

function isStale(lead: Lead): boolean {
  if (lead.agent_id || lead.contacts?.length) return false
  if (!lead.ai_isa_qualifications?.length) {
    const created = new Date(lead.created_at).getTime()
    return Date.now() - created > 24 * 60 * 60 * 1000
  }
  const lastTouch = lead.ai_isa_qualifications
    .map((q) => q.last_outreach_at)
    .filter(Boolean)
    .sort()
    .at(-1)
  if (!lastTouch) return true
  return Date.now() - new Date(lastTouch).getTime() > 24 * 60 * 60 * 1000
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24))
}

// ── Summary card counts ───────────────────────────────────────────────────────

function buildSummary(leads: Lead[], brokerageId: string) {
  const now = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000)

  return {
    todayRaw: leads.filter(
      (l) =>
        deriveLineageStage(l) === 'raw_record' &&
        new Date(l.created_at) >= todayStart,
    ).length,
    readyForISA: leads.filter((l) => l.minimum_viable_for_isa && !l.agent_id && !(l.contacts?.length)).length,
    qualifiedToday: leads.filter(
      (l) =>
        l.ai_isa_qualifications?.some((q) => q.stage === 'qualified') &&
        l.ai_isa_qualifications.some(
          (q) => q.created_at && new Date(q.created_at) >= todayStart,
        ),
    ).length,
    awaitingAssignment: leads.filter(
      (l) => deriveLineageStage(l) === 'qualified' && !l.agent_id,
    ).length,
    convertedWeek: leads.filter(
      (l) =>
        l.contacts?.length &&
        l.contacts.some((c) => new Date(c.created_at) >= weekStart),
    ).length,
    staleISA: leads.filter(isStale).length,
  }
}

// ── Channel compliance badge group ───────────────────────────────────────────

function ChannelBadges({ lead }: { lead: Lead }) {
  const isContact = !!(lead.contacts?.length)
  const emailOk = !!lead.email
  const mailOk = !!lead.mailing_address_verified
  const phoneOk = lead.tcpa_consent && isContact
  const smsOk = lead.tcpa_consent && isContact
  const blockedMsg = 'Not permitted until explicit consent is captured and the lead becomes a contact.'

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Mail className={`h-4 w-4 ${emailOk ? 'text-green-600' : 'text-slate-300'}`} />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {emailOk ? 'Email available' : 'No email — cannot enter ISA queue'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <MapPin className={`h-4 w-4 ${mailOk ? 'text-green-600' : 'text-slate-300'}`} />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {mailOk ? 'Verified mailing address — direct mail eligible' : 'No verified address'}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Phone className={`h-4 w-4 ${phoneOk ? 'text-green-600' : 'text-slate-300'}`} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{phoneOk ? 'Phone allowed' : blockedMsg}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <MessageSquare className={`h-4 w-4 ${smsOk ? 'text-green-600' : 'text-slate-300'}`} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{smsOk ? 'SMS allowed' : blockedMsg}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number | null }) {
  const s = score ?? 0
  const color = s >= 75 ? 'bg-green-500' : s >= 50 ? 'bg-amber-500' : s >= 25 ? 'bg-orange-400' : 'bg-slate-300'
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${s}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{s}</span>
    </div>
  )
}

// ── Stage badge ───────────────────────────────────────────────────────────────

function StageBadge({ stageKey }: { stageKey: string }) {
  const stage = STAGES.find((s) => s.key === stageKey) ?? STAGES[0]
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-white ${stage.color}`}>
      {stage.label}
    </span>
  )
}

// ── Source badge ──────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  website: 'bg-blue-100 text-blue-800',
  scrape: 'bg-purple-100 text-purple-800',
  referral: 'bg-green-100 text-green-800',
  zillow: 'bg-sky-100 text-sky-800',
  portal: 'bg-indigo-100 text-indigo-800',
  ad: 'bg-pink-100 text-pink-800',
}

function SourceBadge({ source }: { source: string | null }) {
  const key = (source ?? 'unknown').toLowerCase()
  const cls = SOURCE_COLORS[key] ?? 'bg-slate-100 text-slate-700'
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {source ?? '—'}
    </span>
  )
}

// ── Expandable detail ─────────────────────────────────────────────────────────

function LeadDetail({ lead }: { lead: Lead }) {
  const qual = lead.ai_isa_qualifications ?? []
  const contact = lead.contacts?.[0]

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 px-4 py-4 bg-slate-50 border-t text-sm">
      {/* Section 1: Raw Record */}
      <div className="space-y-1">
        <p className="font-semibold text-slate-700 mb-2">Raw Record</p>
        <p className="text-muted-foreground">Source: <span className="text-foreground">{lead.source ?? '—'}</span></p>
        <p className="text-muted-foreground">Raw ID: <span className="font-mono text-xs text-foreground">{lead.raw_record_id ? lead.raw_record_id.slice(0, 8) + '…' : '—'}</span></p>
        <p className="text-muted-foreground">Captured: <span className="text-foreground">{new Date(lead.created_at).toLocaleDateString()}</span></p>
      </div>

      {/* Section 2: Dedupe + Enrichment */}
      <div className="space-y-1">
        <p className="font-semibold text-slate-700 mb-2">Dedupe + Enrichment</p>
        <p className="text-muted-foreground">Dedupe: <span className="text-foreground">{lead.dedupe_status ?? 'pending'}</span></p>
        <p className="text-muted-foreground">Enriched by: <span className="text-foreground">{lead.enrichment_provider ?? '—'}</span></p>
        <p className="text-muted-foreground">Enrichment: <span className="text-foreground">{lead.enrichment_status ?? '—'}</span></p>
        {lead.mailing_address && (
          <p className="text-muted-foreground">
            Mail: <span className="text-foreground">{lead.mailing_address}, {lead.mailing_city}, {lead.mailing_state} {lead.mailing_zip}</span>
          </p>
        )}
        <p className="text-muted-foreground">
          Mail verified: <span className="text-foreground">{lead.mailing_address_verified ? 'Yes' : 'No'}</span>
        </p>
      </div>

      {/* Section 3: AI-ISA Activity */}
      <div className="space-y-1">
        <p className="font-semibold text-slate-700 mb-2">AI-ISA Activity</p>
        {qual.length === 0 ? (
          <p className="text-muted-foreground">No qualification records yet</p>
        ) : (
          qual.slice(0, 3).map((q) => (
            <div key={q.id} className="space-y-0.5">
              <p className="text-muted-foreground">Score: <span className="text-foreground">{q.qualification_score ?? '—'}</span></p>
              <p className="text-muted-foreground">Stage: <span className="text-foreground">{q.stage ?? '—'}</span></p>
              {q.last_outreach_at && (
                <p className="text-muted-foreground">Last touch: <span className="text-foreground">{new Date(q.last_outreach_at).toLocaleDateString()}</span></p>
              )}
              {q.qualification_notes && (
                <p className="text-muted-foreground text-xs">{q.qualification_notes}</p>
              )}
            </div>
          ))
        )}
        <p className="text-muted-foreground">TCPA consent: <span className="text-foreground">{lead.tcpa_consent ? `Yes (${lead.tcpa_consent_source ?? 'unknown'})` : 'No'}</span></p>
      </div>

      {/* Section 4: Handoff */}
      <div className="space-y-1">
        <p className="font-semibold text-slate-700 mb-2">Handoff</p>
        <p className="text-muted-foreground">Agent: <span className="text-foreground">{lead.agent_id ? lead.agent_id.slice(0, 8) + '…' : '—'}</span></p>
        <p className="text-muted-foreground">Handed at: <span className="text-foreground">{lead.handed_to_agent_at ? new Date(lead.handed_to_agent_at).toLocaleDateString() : '—'}</span></p>
        <p className="text-muted-foreground">Contact: <span className="text-foreground">{contact ? contact.id.slice(0, 8) + '…' : '—'}</span></p>
        <p className="text-muted-foreground">AI owner: <span className="text-foreground">{lead.ai_isa_owner ? 'Yes' : 'No'}</span></p>
      </div>
    </div>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────────

function LeadRow({
  lead,
  brokerageId,
}: {
  lead: Lead
  brokerageId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const stage = deriveLineageStage(lead)
  const stale = isStale(lead)
  const contactId = lead.contacts?.[0]?.id
  const daysInFlow = daysSince(lead.created_at)

  function handleTriggerISA() {
    startTransition(async () => {
      const result = await governLead(lead.id, brokerageId)
      if (result.success) {
        toast.success('ISA governance triggered — lead re-evaluated')
        router.refresh()
      } else {
        toast.error(`Governance failed: ${result.message}`)
      }
    })
  }

  function handleAssignAndConvert() {
    startTransition(async () => {
      // governLead selects agent and triggers assignment chain
      const result = await governLead(lead.id, brokerageId)
      if (result.success && result.agentAssigned) {
        // handleLeadAssigned auto-creates contact (from lead-acquisition-handlers)
        await handleLeadAssigned({
          leadId: lead.id,
          brokerageId,
          agentId: result.agentAssigned,
          method: 'admin_manual',
          scoreAtAssignment: result.score,
        })
        toast.success('Lead assigned to agent and converted to contact')
        router.refresh()
      } else if (result.success && !result.agentAssigned) {
        toast.info('Lead not yet eligible for agent assignment — re-evaluate when score improves')
      } else {
        toast.error(`Assignment failed: ${result.message}`)
      }
    })
  }

  return (
    <>
      <tr className={`border-b transition-colors hover:bg-slate-50 ${stale ? 'bg-amber-50/40' : ''}`}>
        {/* Name */}
        <td className="px-4 py-3 align-top">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1.5 text-left font-medium text-slate-900 hover:text-blue-700"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
            {lead.first_name ?? '—'} {lead.last_name ?? ''}
          </button>
          {!lead.minimum_viable_for_isa && (
            <p className="mt-0.5 text-xs text-red-600">Needs valid email before AI-ISA can work this record</p>
          )}
          {stale && (
            <div className="mt-1 flex items-center gap-1 text-xs text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              ISA follow-up overdue
            </div>
          )}
        </td>

        {/* Source */}
        <td className="px-4 py-3 align-top">
          <SourceBadge source={lead.source} />
        </td>

        {/* Score */}
        <td className="px-4 py-3 align-top">
          <ScoreBar score={lead.lead_score} />
        </td>

        {/* Stage */}
        <td className="px-4 py-3 align-top">
          <StageBadge stageKey={stage} />
        </td>

        {/* Channels */}
        <td className="px-4 py-3 align-top">
          <ChannelBadges lead={lead} />
        </td>

        {/* ISA Touches */}
        <td className="px-4 py-3 align-top tabular-nums text-sm text-center">
          {lead.ai_isa_qualifications?.length ?? 0}
        </td>

        {/* Assigned Agent */}
        <td className="px-4 py-3 align-top text-sm text-muted-foreground">
          {lead.agent_id ? (
            <div className="flex items-center gap-1">
              <User className="h-3.5 w-3.5" />
              <span className="font-mono text-xs">{lead.agent_id.slice(0, 8)}…</span>
            </div>
          ) : '—'}
        </td>

        {/* Contact Created */}
        <td className="px-4 py-3 align-top text-sm text-muted-foreground">
          {lead.contacts?.[0]
            ? new Date(lead.contacts[0].created_at).toLocaleDateString()
            : '—'}
        </td>

        {/* Days in Flow */}
        <td className="px-4 py-3 align-top text-center tabular-nums text-sm text-muted-foreground">
          {daysInFlow}d
        </td>

        {/* Actions */}
        <td className="px-4 py-3 align-top">
          <div className="flex flex-col gap-1 items-start">
            {stale && !lead.agent_id && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100"
                onClick={handleTriggerISA}
                disabled={isPending}
              >
                <Zap className="h-3 w-3 mr-1" />
                Trigger ISA
              </Button>
            )}

            {stage === 'qualified' && !lead.agent_id && (
              <Button
                size="sm"
                className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
                onClick={handleAssignAndConvert}
                disabled={isPending}
              >
                Assign + Convert
              </Button>
            )}

            {contactId && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-blue-600 hover:text-blue-800"
                onClick={() => router.push(`/crm?contact=${contactId}`)}
              >
                View Contact
              </Button>
            )}
          </div>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={10} className="p-0">
            <LeadDetail lead={lead} />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Funnel strip ──────────────────────────────────────────────────────────────

function FunnelStrip({
  leads,
  activeFilter,
  onFilterChange,
}: {
  leads: Lead[]
  activeFilter: string | null
  onFilterChange: (key: string | null) => void
}) {
  const stageCounts = STAGES.map((s) => ({
    ...s,
    count: leads.filter((l) => deriveLineageStage(l) === s.key).length,
  }))

  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {stageCounts.map((s, i) => {
        const next = stageCounts[i + 1]
        const rate = next && s.count > 0 ? Math.round((next.count / s.count) * 100) : null
        const isActive = activeFilter === s.key
        return (
          <button
            key={s.key}
            onClick={() => onFilterChange(isActive ? null : s.key)}
            className={`flex-shrink-0 flex flex-col items-center rounded-lg border px-4 py-3 text-center transition-all min-w-[110px] ${
              isActive
                ? 'border-blue-500 bg-blue-50 shadow-sm'
                : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            <span className={`text-2xl font-bold tabular-nums ${isActive ? 'text-blue-700' : 'text-slate-800'}`}>
              {s.count}
            </span>
            <span className="text-xs font-medium text-slate-600 mt-0.5 leading-tight">{s.label}</span>
            {rate !== null && (
              <span className="text-xs text-muted-foreground mt-1">{rate}% next</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ leads, brokerageId }: { leads: Lead[]; brokerageId: string }) {
  const s = buildSummary(leads, brokerageId)
  const cards = [
    { label: "Today's Raw Records", value: s.todayRaw, icon: Clock, color: 'text-slate-600' },
    { label: 'Ready for ISA', value: s.readyForISA, icon: CheckCircle, color: 'text-blue-600' },
    { label: 'Qualified Today', value: s.qualifiedToday, icon: CheckCircle, color: 'text-orange-600' },
    { label: 'Awaiting Assignment', value: s.awaitingAssignment, icon: User, color: 'text-amber-600' },
    { label: 'Converted This Week', value: s.convertedWeek, icon: CheckCircle, color: 'text-green-600' },
    { label: 'Stale ISA Leads', value: s.staleISA, icon: AlertTriangle, color: 'text-red-600' },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => (
        <Card key={c.label} className="p-0">
          <CardContent className="pt-4 pb-4 px-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground leading-tight">{c.label}</span>
              <c.icon className={`h-4 w-4 shrink-0 ${c.color}`} />
            </div>
            <p className={`text-2xl font-bold tabular-nums ${c.color}`}>{c.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Main client component ─────────────────────────────────────────────────────

export default function LeadLineageClient({
  leads,
  brokerageId,
}: {
  leads: Lead[]
  brokerageId: string
}) {
  const [stageFilter, setStageFilter] = useState<string | null>(null)

  const filtered = stageFilter
    ? leads.filter((l) => deriveLineageStage(l) === stageFilter)
    : leads

  return (
    <div className="space-y-6">
      <SummaryCards leads={leads} brokerageId={brokerageId} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-slate-700">Pipeline Stages</CardTitle>
        </CardHeader>
        <CardContent>
          <FunnelStrip
            leads={leads}
            activeFilter={stageFilter}
            onFilterChange={setStageFilter}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-semibold text-slate-700">
            Lineage Table
            {stageFilter && (
              <Badge variant="secondary" className="ml-2 text-xs">
                {STAGES.find((s) => s.key === stageFilter)?.label}
              </Badge>
            )}
          </CardTitle>
          {stageFilter && (
            <Button size="sm" variant="ghost" className="text-xs" onClick={() => setStageFilter(null)}>
              Clear filter
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No leads at this stage.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-slate-50">
                  <tr>
                    {['Name', 'Source', 'Score', 'Stage', 'Channels', 'ISA Touches', 'Agent', 'Contact Created', 'Days', 'Actions'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((lead) => (
                    <LeadRow key={lead.id} lead={lead} brokerageId={brokerageId} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
