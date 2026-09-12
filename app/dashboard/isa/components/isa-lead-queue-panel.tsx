"use client"

/**
 * app/dashboard/isa/components/isa-lead-queue-panel.tsx
 *
 * The ISA raw-lead queue — the operating surface for app/actions/leads.ts.
 *
 * ORPHAN BURN-DOWN: leads.ts is the full lead lifecycle module (queue, stats,
 * qualify, pause, hand off, AI outreach, outreach history) and only two of its
 * exports had any caller. An ISA could see the AI's *results* on this console
 * but could not work the queue those results come from. This panel is that
 * surface.
 *
 * ACCESS: every action in leads.ts enforces the ISA role gate itself
 * (admin / broker / broker_admin / superadmin / isa). Agents are NOT in that
 * set — agents work CONTACTS, never raw leads — so the console only mounts
 * this panel for a role that can legitimately reach lead rows. The server-side
 * gate is the real one; this is so an agent is never shown a control that can
 * only refuse.
 *
 * Every call READS its outcome — a refusal is shown, never swallowed.
 */

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Pause,
  Send,
  UserCheck,
  Users,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import {
  getISAQueueLeads,
  getLeadStats,
  getLeadById,
  getBrokerageAgents,
  getLeadOutreachHistory,
  qualifyLead,
  pauseAIISA,
  handOffToHumanAgent,
  initiateAIOutreach,
} from "@/app/actions/leads"

interface QueueLead {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  lead_score: number | null
  lifecycle_state: string | null
  lead_type: string | null
  source: string | null
  urgency_level: string | null
  motivation_type: string | null
  ai_outreach_paused: boolean | null
  tcpa_consent: boolean | null
  days_in_stage: number | null
  last_contacted_at: string | null
}

interface AgentOption {
  id: string
  first_name: string
  last_name: string
  email: string
}

interface Stats {
  total: number
  active_isa: number
  paused: number
  assigned: number
  hot: number
}

function leadName(l: { first_name: string | null; last_name: string | null }) {
  return [l.first_name, l.last_name].filter(Boolean).join(" ") || "(unnamed lead)"
}

function urgencyTone(u: string | null) {
  if (u === "hot") return "bg-red-50 text-red-700 border-red-200"
  if (u === "warm") return "bg-amber-50 text-amber-700 border-amber-200"
  return "bg-slate-50 text-slate-600 border-slate-200"
}

export function ISALeadQueuePanel() {
  const [leads, setLeads] = useState<QueueLead[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Expanded lead detail: full row + outreach history, both server-loaded.
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, any> | null>(null)
  const [history, setHistory] = useState<any[]>([])
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [handoffTarget, setHandoffTarget] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const [queueRes, statsRes, agentsRes] = await Promise.all([
      getISAQueueLeads(),
      getLeadStats(),
      getBrokerageAgents(),
    ])

    if (!queueRes.success) {
      setLoadError(queueRes.error ?? "The ISA queue could not be loaded.")
      setLeads([])
    } else {
      setLeads((queueRes.leads ?? []) as QueueLead[])
    }
    if (statsRes.success) setStats((statsRes.stats as Stats | null) ?? null)
    if (agentsRes.success) setAgents((agentsRes.agents ?? []) as AgentOption[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function openDetail(leadId: string) {
    if (openLeadId === leadId) {
      setOpenLeadId(null)
      setDetail(null)
      setHistory([])
      return
    }
    setOpenLeadId(leadId)
    setDetail(null)
    setHistory([])
    setDetailError(null)
    setDetailLoading(true)
    const [byId, hist] = await Promise.all([
      getLeadById(leadId),
      getLeadOutreachHistory(leadId),
    ])
    if (!byId.success) {
      setDetailError(byId.error ?? "That lead could not be loaded.")
    } else {
      setDetail(byId.lead as Record<string, any>)
    }
    if (hist.success) {
      setHistory(hist.history ?? [])
    } else if (byId.success) {
      setDetailError(hist.error ?? "The outreach history could not be loaded.")
    }
    setDetailLoading(false)
  }

  async function run(
    leadId: string,
    label: string,
    fn: () => Promise<{ success: boolean; error?: string }>,
  ) {
    setBusyId(leadId)
    try {
      const res = await fn()
      if (res.success) {
        toast.success(label)
        await load()
        if (openLeadId === leadId) {
          const hist = await getLeadOutreachHistory(leadId)
          if (hist.success) setHistory(hist.history ?? [])
        }
      } else {
        toast.error(res.error ?? `${label} failed`)
      }
    } finally {
      setBusyId(null)
    }
  }

  const statCards = stats
    ? [
        { label: "Total leads", value: stats.total, tone: "text-slate-700" },
        { label: "AI-owned, unassigned", value: stats.active_isa, tone: "text-indigo-600" },
        { label: "Outreach paused", value: stats.paused, tone: "text-amber-600" },
        { label: "Assigned to agents", value: stats.assigned, tone: "text-emerald-600" },
        { label: "Hot", value: stats.hot, tone: "text-red-600" },
      ]
    : []

  return (
    <div className="space-y-3">
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {statCards.map((s) => (
            <Card key={s.label}>
              <CardContent className="p-3">
                <p className={`text-2xl font-bold leading-tight ${s.tone}`}>{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-indigo-500" />
            ISA Queue
            {leads.length > 0 && (
              <Badge variant="secondary" className="text-xs">{leads.length}</Badge>
            )}
          </CardTitle>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{loadError}</span>
            </div>
          )}

          {loading && !loadError && (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading the queue…</p>
          )}

          {!loading && !loadError && leads.length === 0 && (
            <div className="py-8 text-center">
              <UserCheck className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No AI-owned, unassigned leads waiting.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Leads land here when the AI-ISA owns them and no human agent has picked them up.
              </p>
            </div>
          )}

          {leads.map((lead) => {
            const isBusy = busyId === lead.id
            const isOpen = openLeadId === lead.id
            return (
              <div key={lead.id} className="rounded-lg border overflow-hidden">
                <div className="p-3 flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm truncate">{leadName(lead)}</p>
                      {lead.urgency_level && (
                        <Badge variant="outline" className={`text-[10px] ${urgencyTone(lead.urgency_level)}`}>
                          {lead.urgency_level}
                        </Badge>
                      )}
                      {lead.lead_score != null && (
                        <Badge variant="outline" className="text-[10px]">score {lead.lead_score}</Badge>
                      )}
                      {lead.ai_outreach_paused && (
                        <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                          Outreach paused
                        </Badge>
                      )}
                      {!lead.tcpa_consent && (
                        <Badge variant="outline" className="text-[10px] bg-slate-50 text-slate-600">
                          No TCPA consent
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {[lead.email, lead.phone].filter(Boolean).join(" · ") || "No contact details"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {(lead.lifecycle_state ?? "unconsented").replace(/_/g, " ")}
                      {lead.source && ` · ${lead.source}`}
                      {lead.days_in_stage != null && ` · ${lead.days_in_stage}d in stage`}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      disabled={isBusy}
                      onClick={() => run(lead.id, "Lead qualified", () => qualifyLead(lead.id))}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                      Qualify
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      disabled={isBusy}
                      onClick={() =>
                        run(lead.id, "AI outreach started", () => initiateAIOutreach(lead.id))
                      }
                    >
                      <Zap className="w-3.5 h-3.5 mr-1" />
                      Start AI outreach
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      disabled={isBusy || !!lead.ai_outreach_paused}
                      onClick={() => run(lead.id, "AI-ISA outreach paused", () => pauseAIISA(lead.id))}
                    >
                      <Pause className="w-3.5 h-3.5 mr-1" />
                      Pause
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7"
                      onClick={() => openDetail(lead.id)}
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 mr-1 transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                      Detail
                    </Button>
                  </div>
                </div>

                {/* Hand off to a human agent */}
                <div className="border-t bg-muted/30 px-3 py-2 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">Hand off to</span>
                  <Select
                    value={handoffTarget[lead.id] ?? ""}
                    onValueChange={(v) => setHandoffTarget((p) => ({ ...p, [lead.id]: v }))}
                  >
                    <SelectTrigger className="h-7 w-56 text-xs">
                      <SelectValue placeholder="Queue for manual assignment" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.length === 0 ? (
                        <SelectItem value="__none" disabled>
                          No active agents in this brokerage
                        </SelectItem>
                      ) : (
                        agents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {[a.first_name, a.last_name].filter(Boolean).join(" ") || a.email || a.id}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    disabled={isBusy}
                    onClick={() => {
                      const target = handoffTarget[lead.id]
                      run(
                        lead.id,
                        target ? "Lead handed to the agent" : "Lead queued for manual assignment",
                        () => handOffToHumanAgent(lead.id, target || undefined),
                      )
                    }}
                  >
                    <Send className="w-3.5 h-3.5 mr-1" />
                    Hand off
                  </Button>
                  {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
                </div>

                {isOpen && (
                  <div className="border-t p-3 space-y-3 bg-background">
                    {detailLoading && (
                      <p className="text-xs text-muted-foreground">Loading lead detail…</p>
                    )}
                    {detailError && (
                      <p className="text-xs text-destructive">{detailError}</p>
                    )}
                    {detail && (
                      <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        {[
                          ["Lead type", detail.lead_type],
                          ["Lead stage", detail.lead_stage],
                          ["Motivation", detail.motivation_type],
                          ["Preferred channel", detail.preferred_channel],
                          ["AI-ISA owner", detail.ai_isa_owner ? "Yes" : "No"],
                          ["Viable for ISA", detail.minimum_viable_for_isa ? "Yes" : "No"],
                          ["Call stop flag", detail.call_stop_flag ? "Yes" : "No"],
                          [
                            "Last contacted",
                            detail.last_contacted_at
                              ? new Date(detail.last_contacted_at).toLocaleString()
                              : "Never",
                          ],
                        ].map(([label, value]) => (
                          <div key={String(label)} className="flex gap-2">
                            <span className="text-muted-foreground w-32 shrink-0">{label}</span>
                            <span className="truncate">{value ? String(value) : "—"}</span>
                          </div>
                        ))}
                        {Array.isArray(detail.tags) && detail.tags.length > 0 && (
                          <div className="sm:col-span-2 flex gap-2 flex-wrap items-center">
                            <span className="text-muted-foreground w-32 shrink-0">Tags</span>
                            {detail.tags.map((t: string) => (
                              <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                            ))}
                          </div>
                        )}
                        {detail.notes && (
                          <div className="sm:col-span-2">
                            <p className="text-muted-foreground mb-0.5">Notes</p>
                            <p className="leading-relaxed">{detail.notes}</p>
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                        Outreach history
                      </p>
                      {history.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Nothing has been sent to this lead yet.
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {history.map((h: any) => (
                            <li key={h.id} className="rounded border px-2 py-1.5 text-xs">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <span className="font-medium capitalize">{h.channel}</span>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <Badge variant="outline" className="text-[10px]">{h.status}</Badge>
                                  {h.compliance_passed === false && (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] bg-red-50 text-red-700 border-red-200"
                                    >
                                      Compliance blocked
                                    </Badge>
                                  )}
                                  <span className="text-muted-foreground">
                                    {h.sent_at
                                      ? new Date(h.sent_at).toLocaleString()
                                      : h.created_at
                                        ? new Date(h.created_at).toLocaleString()
                                        : ""}
                                  </span>
                                </div>
                              </div>
                              {h.subject && <p className="mt-0.5 font-medium">{h.subject}</p>}
                              {h.body_snippet && (
                                <p className="text-muted-foreground leading-relaxed">{h.body_snippet}</p>
                              )}
                              {(h.opened_at || h.replied_at) && (
                                <p className="mt-0.5 text-muted-foreground">
                                  {h.opened_at && `Opened ${new Date(h.opened_at).toLocaleString()}`}
                                  {h.opened_at && h.replied_at && " · "}
                                  {h.replied_at && `Replied ${new Date(h.replied_at).toLocaleString()}`}
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
