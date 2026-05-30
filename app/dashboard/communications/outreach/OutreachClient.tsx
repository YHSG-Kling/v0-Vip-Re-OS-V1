"use client"

import { useState, useTransition } from "react"
import { Plus, Loader2, Play, Pause, Mail, MessageSquare, Phone, Send, RefreshCw, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  createISACampaign,
  toggleCampaignStatus,
  triggerGhostRecovery,
  skipGhostContact,
} from "@/app/actions/ai-isa"

// ── Types ─────────────────────────────────────────────────────────────────────

type Campaign = {
  id: string
  name: string
  status: string
  campaign_type: string
  channels?: string[]
  leads_targeted?: number
  touches_sent?: number
  conversions?: number
  created_at: string
}

type EngagementItem = {
  id: string
  contact_id: string
  contact_first_name?: string | null
  contact_last_name?: string | null
  campaign_name?: string | null
  channel: string
  event_type: string
  created_at: string
}

type Qualification = {
  id: string
  contact_id: string
  contact_first_name?: string | null
  contact_last_name?: string | null
  score?: number | null
  qualification_result: string
  assigned_agent_name?: string | null
  notes?: string | null
  created_at: string
}

type GhostContact = {
  id: string
  contact_id: string
  contact_first_name?: string | null
  contact_last_name?: string | null
  days_since_last_touch?: number | null
  last_channel?: string | null
  suggested_channel?: string | null
}

interface OutreachClientProps {
  campaigns: Campaign[]
  engagementFeed: EngagementItem[]
  qualifications: Qualification[]
  ghostQueue: GhostContact[]
  brokerageId: string
  agentId: string
  userId: string
  role: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CAMPAIGN_TYPES = [
  { value: "cold_outreach",  label: "Cold Outreach" },
  { value: "warm_nurture",   label: "Warm Nurture" },
  { value: "re_engagement",  label: "Re-Engagement" },
  { value: "lifetime_customer",    label: "Lifetime Customer" },
] as const

const CHANNELS = ["email", "sms", "voice", "direct_mail"] as const

const STATUS_COLORS: Record<string, string> = {
  active:    "bg-green-100 text-green-700",
  paused:    "bg-yellow-100 text-yellow-700",
  draft:     "bg-muted text-muted-foreground",
  completed: "bg-blue-100 text-blue-700",
}

const QUAL_COLORS: Record<string, string> = {
  qualified:         "bg-green-100 text-green-700",
  not_qualified:     "bg-red-100 text-red-700",
  appointment_set:   "bg-blue-100 text-blue-700",
  no_response:       "bg-gray-100 text-gray-600",
  needs_follow_up:   "bg-yellow-100 text-yellow-700",
}

const CHANNEL_ICON: Record<string, React.ReactNode> = {
  email:       <Mail size={13} />,
  sms:         <MessageSquare size={13} />,
  voice:       <Phone size={13} />,
  direct_mail: <Send size={13} />,
}

type Tab = "campaigns" | "engagement" | "qualifications" | "ghost"
const TABS: { id: Tab; label: string }[] = [
  { id: "campaigns",      label: "AI Campaigns" },
  { id: "engagement",     label: "Engagement Feed" },
  { id: "qualifications", label: "Qualification Outcomes" },
  { id: "ghost",          label: "Ghost Recovery" },
]

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CampaignsTab({
  campaigns: initial,
  brokerageId,
}: {
  campaigns: Campaign[]
  brokerageId: string
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>(initial)
  const [showForm, setShowForm]   = useState(false)
  const [name, setName]           = useState("")
  const [type, setType]           = useState<typeof CAMPAIGN_TYPES[number]["value"]>("cold_outreach")
  const [selectedChannels, setSelectedChannels] = useState<string[]>(["email"])
  const [isPending, start]        = useTransition()
  const [error, setError]         = useState<string | null>(null)
  const [toggling, setToggling]   = useState<string | null>(null)

  function toggleChannel(ch: string) {
    setSelectedChannels(prev =>
      prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch]
    )
  }

  function handleCreate() {
    if (!name.trim()) return
    setError(null)
    start(async () => {
      const result = await createISACampaign({
        brokerageId,
        name: name.trim(),
        campaignType: type as any,
        channels: selectedChannels,
      })
      if (result.success && result.campaignId) {
        setCampaigns(prev => [{
          id:            result.campaignId!,
          name:          name.trim(),
          status:        "draft",
          campaign_type: type,
          channels:      selectedChannels,
          leads_targeted: 0,
          touches_sent:  0,
          conversions:   0,
          created_at:    new Date().toISOString(),
        }, ...prev])
        setShowForm(false)
        setName("")
      } else {
        setError(result.error ?? "Failed to create campaign")
      }
    })
  }

  async function handleToggle(c: Campaign) {
    setToggling(c.id)
    const result = await toggleCampaignStatus(c.id, c.status as any)
    if (result.success) {
      setCampaigns(prev =>
        prev.map(x =>
          x.id === c.id
            ? { ...x, status: x.status === "active" ? "paused" : "active" }
            : x
        )
      )
    }
    setToggling(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{campaigns.length} campaigns</p>
        <Button size="sm" className="gap-2" onClick={() => setShowForm(!showForm)}>
          <Plus size={14} /> New Campaign
        </Button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <h3 className="text-sm font-semibold text-foreground">Create ISA Campaign</h3>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Campaign Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Q2 Buyer Leads" className="h-9 text-sm" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value as typeof type)}
                className="w-full text-sm border border-border rounded-md px-2 py-1.5 bg-background text-foreground h-9"
              >
                {CAMPAIGN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Channels</label>
              <div className="flex gap-2 flex-wrap">
                {CHANNELS.map(ch => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => toggleChannel(ch)}
                    className={cn(
                      "text-xs px-2 py-1 rounded-full border transition-colors capitalize",
                      selectedChannels.includes(ch)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:border-primary"
                    )}
                  >
                    {ch}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate} disabled={isPending || !name.trim()} className="gap-2">
              {isPending && <Loader2 size={13} className="animate-spin" />}
              {isPending ? "Creating…" : "Create Campaign"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {campaigns.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-10 text-center text-muted-foreground text-sm">
          No campaigns yet. Create your first AI ISA campaign.
        </div>
      )}

      <div className="space-y-2">
        {campaigns.map(c => (
          <div key={c.id} className="rounded-lg border border-border bg-card p-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm text-foreground truncate">{c.name}</p>
              <p className="text-xs text-muted-foreground capitalize">
                {c.campaign_type?.replace(/_/g, " ")}
                {c.channels && c.channels.length > 0 && (
                  <span className="ml-2 flex-inline items-center gap-1">
                    {c.channels.map(ch => (
                      <span key={ch} className="inline-flex items-center gap-0.5 capitalize">{ch}</span>
                    )).reduce((a: React.ReactNode[], b, i) => [...a, i > 0 ? ", " : "", b], [])}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
              <span>{c.leads_targeted ?? 0} leads</span>
              <span>{c.touches_sent ?? 0} touches</span>
              <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-medium capitalize", STATUS_COLORS[c.status] ?? STATUS_COLORS.draft)}>
                {c.status}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={toggling === c.id || c.status === "completed"}
                onClick={() => handleToggle(c)}
              >
                {toggling === c.id
                  ? <Loader2 size={12} className="animate-spin" />
                  : c.status === "active"
                    ? <Pause size={12} />
                    : <Play size={12} />}
                {c.status === "active" ? "Pause" : "Activate"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EngagementFeedTab({ items }: { items: EngagementItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground py-10 text-center border border-border rounded-lg">No engagement events yet.</p>
  }
  return (
    <div className="space-y-2">
      {items.map(item => {
        const name = [item.contact_first_name, item.contact_last_name].filter(Boolean).join(" ") || "Unknown"
        return (
          <div key={item.id} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
            <div className="shrink-0 mt-0.5 text-muted-foreground">
              {CHANNEL_ICON[item.channel] ?? <Mail size={13} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{name}</p>
              <p className="text-xs text-muted-foreground capitalize">
                {item.event_type?.replace(/_/g, " ")}
                {item.campaign_name && <span> · {item.campaign_name}</span>}
              </p>
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0">{relativeTime(item.created_at)}</span>
          </div>
        )
      })}
    </div>
  )
}

function QualificationsTab({ items }: { items: Qualification[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground py-10 text-center border border-border rounded-lg">No qualification outcomes yet.</p>
  }
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              {["Contact", "Result", "Score", "Assigned Agent", "Notes", "Date"].map(h => (
                <th key={h} className="px-3 py-2 text-left text-xs font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {items.map(q => {
              const name = [q.contact_first_name, q.contact_last_name].filter(Boolean).join(" ") || "Unknown"
              return (
                <tr key={q.id} className="hover:bg-muted/40 transition-colors">
                  <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap">{name}</td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-block px-2 py-0.5 rounded-full text-[10px] font-medium capitalize", QUAL_COLORS[q.qualification_result] ?? "bg-muted text-muted-foreground")}>
                      {q.qualification_result?.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{q.score ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{q.assigned_agent_name ?? "—"}</td>
                  <td className="px-3 py-2 max-w-[180px]">
                    <span className="text-xs text-muted-foreground line-clamp-1">{q.notes ?? "—"}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(q.created_at).toLocaleDateString()}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GhostRecoveryTab({ items, brokerageId }: { items: GhostContact[]; brokerageId: string }) {
  const [localItems, setLocalItems] = useState<GhostContact[]>(items)
  const [pending, setPending]       = useState<string | null>(null)
  const [recovered, setRecovered]   = useState<Set<string>>(new Set())

  async function handleRecover(g: GhostContact) {
    setPending(g.id)
    const result = await triggerGhostRecovery({
      contactId:  g.contact_id,
      campaignId: "",
      brokerageId,
    })
    if (result.success) {
      setRecovered(prev => new Set([...prev, g.id]))
    }
    setPending(null)
  }

  async function handleSkip(g: GhostContact) {
    setPending(g.id)
    await skipGhostContact({ contactId: g.contact_id, campaignId: "", brokerageId })
    setLocalItems(prev => prev.filter(x => x.id !== g.id))
    setPending(null)
  }

  if (localItems.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-10 text-center space-y-2">
        <CheckCircle2 size={28} className="mx-auto text-green-500" />
        <p className="text-sm text-muted-foreground">No ghost contacts — your pipeline is active!</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {localItems.map(g => {
        const name = [g.contact_first_name, g.contact_last_name].filter(Boolean).join(" ") || "Unknown"
        const isRecovered = recovered.has(g.id)
        return (
          <div key={g.id} className={cn(
            "flex items-center gap-3 rounded-lg border border-border bg-card p-3",
            isRecovered && "opacity-60"
          )}>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{name}</p>
              <p className="text-xs text-muted-foreground">
                {g.days_since_last_touch != null && `${g.days_since_last_touch}d since last touch`}
                {g.last_channel && ` · Last: ${g.last_channel}`}
                {g.suggested_channel && <span className="text-primary"> · Try: {g.suggested_channel}</span>}
              </p>
            </div>
            {isRecovered ? (
              <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                <CheckCircle2 size={13} /> Recovery sent
              </span>
            ) : (
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  disabled={pending === g.id}
                  onClick={() => handleRecover(g)}
                >
                  {pending === g.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  Recover
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground"
                  disabled={pending === g.id}
                  onClick={() => handleSkip(g)}
                >
                  <XCircle size={11} />
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main Client ───────────────────────────────────────────────────────────────

export default function OutreachClient({
  campaigns,
  engagementFeed,
  qualifications,
  ghostQueue,
  brokerageId,
  agentId,
  userId,
  role,
}: OutreachClientProps) {
  const [tab, setTab] = useState<Tab>("campaigns")

  const badgeCounts: Partial<Record<Tab, number>> = {
    ghost: ghostQueue.length,
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-screen-xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Outreach</h1>
        <p className="text-sm text-muted-foreground mt-1">
          AI ISA campaigns, engagement tracking, qualification outcomes, and ghost recovery.
        </p>
      </div>

      {/* Tab nav */}
      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {badgeCounts[t.id] ? (
              <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold">
                {badgeCounts[t.id]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === "campaigns" && (
          <CampaignsTab campaigns={campaigns} brokerageId={brokerageId} />
        )}
        {tab === "engagement" && (
          <EngagementFeedTab items={engagementFeed} />
        )}
        {tab === "qualifications" && (
          <QualificationsTab items={qualifications} />
        )}
        {tab === "ghost" && (
          <GhostRecoveryTab items={ghostQueue} brokerageId={brokerageId} />
        )}
      </div>
    </div>
  )
}
