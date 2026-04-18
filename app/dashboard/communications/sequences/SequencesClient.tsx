"use client"

import { useState, useTransition } from "react"
import { Plus, Loader2, Play, Pause, ChevronDown, ChevronUp, Mail, MessageSquare, Phone, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { aiGenerateDripCampaign } from "@/app/actions/ai-lead-nurturing"

type Campaign = {
  id: string
  name: string
  status: string
  trigger_event?: string
  target_lifecycle_state?: string
  total_steps?: number
  enrolled_count?: number
  created_at: string
  updated_at: string
}

type Contact = {
  id: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  lifecycle_state?: string
}

interface SequencesClientProps {
  campaigns: Campaign[]
  brokerageId: string
  agentId: string
  userId: string
  role: string
  preContact: Contact | null
}

const CAMPAIGN_TYPES = [
  { value: "buyer_nurture",   label: "Buyer Nurture" },
  { value: "seller_nurture",  label: "Seller Nurture" },
  { value: "past_client",     label: "Past Client" },
  { value: "sphere",          label: "Sphere of Influence" },
  { value: "investor",        label: "Investor" },
  { value: "relocation",      label: "Relocation" },
] as const

const DURATIONS = [
  { value: "30_days",   label: "30 Days" },
  { value: "60_days",   label: "60 Days" },
  { value: "90_days",   label: "90 Days" },
  { value: "6_months",  label: "6 Months" },
  { value: "12_months", label: "12 Months" },
] as const

const STATUS_COLORS: Record<string, string> = {
  active:   "bg-green-100 text-green-700",
  paused:   "bg-yellow-100 text-yellow-700",
  draft:    "bg-muted text-muted-foreground",
  archived: "bg-gray-100 text-gray-500",
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  email:       <Mail size={12} />,
  sms:         <MessageSquare size={12} />,
  call:        <Phone size={12} />,
  direct_mail: <Send size={12} />,
}

export default function SequencesClient({
  campaigns: initialCampaigns,
  brokerageId,
  agentId,
  userId,
  role,
  preContact,
}: SequencesClientProps) {
  const [campaigns, setCampaigns]   = useState<Campaign[]>(initialCampaigns)
  const [showForm, setShowForm]     = useState(!!preContact)
  const [contactId, setContactId]   = useState(preContact?.id ?? "")
  const [contactName, setContactName] = useState(
    preContact ? `${preContact.first_name} ${preContact.last_name}`.trim() : ""
  )
  const [campaignType, setCampaignType] = useState<typeof CAMPAIGN_TYPES[number]["value"]>("buyer_nurture")
  const [duration, setDuration]     = useState<typeof DURATIONS[number]["value"]>("30_days")
  const [generatedCampaign, setGeneratedCampaign] = useState<any | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleGenerate() {
    if (!contactId.trim()) return
    setError(null)
    setGeneratedCampaign(null)
    startTransition(async () => {
      const result = await aiGenerateDripCampaign({
        contactId: contactId.trim(),
        agentId,
        campaignType,
        duration,
      })
      if (result.success && result.campaign) {
        setGeneratedCampaign(result.campaign)
        // Append to list as draft
        const newCampaign: Campaign = {
          id:                    result.campaign.id ?? crypto.randomUUID(),
          name:                  result.campaign.campaignName ?? result.campaign.name ?? "New Campaign",
          status:                "draft",
          trigger_event:         campaignType,
          total_steps:           result.campaign.totalTouchpoints ?? result.campaign.touchpoints?.length ?? 0,
          enrolled_count:        0,
          created_at:            new Date().toISOString(),
          updated_at:            new Date().toISOString(),
        }
        setCampaigns(prev => [newCampaign, ...prev])
        setShowForm(false)
      } else {
        setError(result.error ?? "Failed to generate campaign")
      }
    })
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Drip Sequences</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Multi-touch nurture sequences for buyers, sellers, and leads (email + SMS + voice drop + AI call).
          </p>
        </div>
        <Button
          onClick={() => setShowForm(!showForm)}
          className="gap-2"
        >
          <Plus size={16} />
          New Sequence
        </Button>
      </div>

      {/* Generate form */}
      {showForm && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-base font-semibold text-foreground">Generate AI Drip Campaign</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Contact ID</label>
              {preContact ? (
                <div className="flex items-center gap-2 text-sm text-foreground border border-border rounded-md px-3 py-1.5 bg-muted/30">
                  {contactName}
                  <span className="text-xs text-muted-foreground ml-auto">{preContact.lifecycle_state?.replace(/_/g, " ")}</span>
                </div>
              ) : (
                <Input
                  value={contactId}
                  onChange={e => setContactId(e.target.value)}
                  placeholder="Paste contact UUID…"
                  className="h-9 text-sm"
                />
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Campaign Type</label>
              <select
                value={campaignType}
                onChange={e => setCampaignType(e.target.value as typeof campaignType)}
                className="w-full text-sm border border-border rounded-md px-2 py-1.5 bg-background text-foreground h-9"
              >
                {CAMPAIGN_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Duration</label>
              <select
                value={duration}
                onChange={e => setDuration(e.target.value as typeof duration)}
                className="w-full text-sm border border-border rounded-md px-2 py-1.5 bg-background text-foreground h-9"
              >
                {DURATIONS.map(d => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center gap-3">
            <Button onClick={handleGenerate} disabled={isPending || !contactId.trim()} className="gap-2">
              {isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              {isPending ? "Generating…" : "Generate with AI"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Generated campaign preview */}
      {generatedCampaign && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-sm text-foreground">{generatedCampaign.campaignName}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{generatedCampaign.description}</p>
            </div>
            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium shrink-0">
              {generatedCampaign.totalTouchpoints} steps
            </span>
          </div>
          {generatedCampaign.touchpoints?.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Touchpoints</p>
              {generatedCampaign.touchpoints.slice(0, 5).map((tp: any, i: number) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground w-10">Day {tp.dayOffset}</span>
                  <span className="shrink-0">{CHANNEL_ICONS[tp.channel] ?? <Send size={12} />}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate">{tp.subject ?? tp.purpose}</p>
                    <p className="text-muted-foreground truncate">{tp.content?.substring(0, 80)}…</p>
                  </div>
                </div>
              ))}
              {generatedCampaign.touchpoints.length > 5 && (
                <p className="text-xs text-muted-foreground">+{generatedCampaign.touchpoints.length - 5} more steps…</p>
              )}
            </div>
          )}
          {generatedCampaign.personalizationNotes && (
            <p className="text-xs text-muted-foreground italic">{generatedCampaign.personalizationNotes}</p>
          )}
        </div>
      )}

      {/* Campaigns list */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">
          All Sequences
          <span className="ml-2 text-muted-foreground font-normal">({campaigns.length})</span>
        </h2>

        {campaigns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center space-y-2">
            <p className="text-sm font-medium text-foreground">No nurture sequences yet</p>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Build multi-touch follow-up sequences to guide buyers, sellers, and leads through their journey — email, SMS, voice drop, and AI calls.
            </p>
            <Button size="sm" className="gap-2 mt-2" onClick={() => setShowForm(true)}>
              <Plus size={14} />
              Generate AI Drip Campaign
            </Button>
          </div>
        ) : (
          campaigns.map(c => (
            <div key={c.id} className="rounded-lg border border-border bg-card overflow-hidden">
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/40 transition-colors"
                onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-foreground truncate">{c.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {c.trigger_event?.replace(/_/g, " ")}
                    {c.target_lifecycle_state && ` · ${c.target_lifecycle_state.replace(/_/g, " ")}`}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {c.total_steps != null && (
                    <span className="text-xs text-muted-foreground">{c.total_steps} steps</span>
                  )}
                  {c.enrolled_count != null && (
                    <span className="text-xs text-muted-foreground">{c.enrolled_count} enrolled</span>
                  )}
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_COLORS[c.status] ?? STATUS_COLORS.draft}`}>
                    {c.status}
                  </span>
                  {expandedId === c.id ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
                </div>
              </div>
              {expandedId === c.id && (
                <div className="border-t border-border px-4 py-3 flex items-center gap-2 bg-muted/20">
                  <Button variant="outline" size="sm" className="gap-1.5 text-xs h-7">
                    {c.status === "active" ? <Pause size={12} /> : <Play size={12} />}
                    {c.status === "active" ? "Pause" : "Activate"}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-xs h-7">
                    Edit
                  </Button>
                  <span className="ml-auto text-xs text-muted-foreground">
                    Updated {new Date(c.updated_at).toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
