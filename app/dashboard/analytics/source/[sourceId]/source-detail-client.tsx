"use client"

import { useState, useTransition, useCallback } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  BarChart3,
  Users,
  DollarSign,
  TrendingUp,
  Sparkles,
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Calendar,
  UserCheck,
  Target,
  Database,
  Globe,
  Zap,
  Clock,
} from "lucide-react"
import Link from "next/link"
import {
  generateSourceAISummaryForSource,
  getSourceDrilldown,
  type SourceFamily,
  type SourceDrilldownResult,
} from "@/app/actions/source-analytics"

// ─────────────────────────────────────────────────────────────────────────────
interface Props {
  sourceName: string
  sourceFamily: SourceFamily
  brokerageId: string
  userId: string
  userType: string
  initialData: SourceDrilldownResult
}

const FAMILY_INFO: Record<SourceFamily, { label: string; color: string; icon: typeof Database; funnelStages: string[] }> = {
  raw:            {
    label: "Raw / Acquisition",
    color: "text-orange-600",
    icon: Database,
    funnelStages: ["Raw Record", "Lead", "Contact", "Appointment", "Transaction", "Closed"],
  },
  lead:           {
    label: "Lead Source",
    color: "text-blue-600",
    icon: Zap,
    funnelStages: ["Lead", "Contact", "Appointment", "Transaction", "Closed"],
  },
  contact_direct: {
    label: "Direct Contact",
    color: "text-emerald-600",
    icon: Globe,
    funnelStages: ["Contact", "Appointment", "Transaction", "Closed"],
  },
}

function StatCard({ label, value, icon: Icon, color = "text-primary" }: { label: string; value: string | number; icon: typeof BarChart3; color?: string }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-lg border bg-card">
      <div className={`p-2 rounded-lg ${color.replace("text-", "bg-").replace("-600", "-500/10")}`}>
        <Icon className={`h-4 w-4 ${color}`} />
      </div>
      <div>
        <p className="text-xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

function FunnelRow({ label, count, percent }: { label: string; count: number; percent: number }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-sm text-muted-foreground w-32 shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
        <div
          className="h-full bg-primary/60 rounded-full transition-all"
          style={{ width: `${Math.max(1, percent)}%` }}
        />
      </div>
      <span className="text-sm font-medium w-12 text-right">{count.toLocaleString()}</span>
      <span className="text-xs text-muted-foreground w-10 text-right">{percent.toFixed(1)}%</span>
    </div>
  )
}

function TimelineChart({ data }: { data: Array<{ month: string; contacts: number; leads: number; transactions: number; revenue: number }> }) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No timeline data available</p>
  }
  const maxContacts = Math.max(...data.map(d => d.contacts), 1)
  return (
    <div className="space-y-2">
      {data.slice(-12).map(d => (
        <div key={d.month} className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground w-16 shrink-0">{d.month}</span>
          <div className="flex-1 flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <div className="h-1.5 bg-blue-400 rounded-full" style={{ width: `${(d.contacts / maxContacts) * 100}%`, minWidth: d.contacts > 0 ? "4px" : "0" }} />
              <span className="text-xs text-muted-foreground">{d.contacts}c</span>
            </div>
            {d.transactions > 0 && (
              <div className="flex items-center gap-1">
                <div className="h-1.5 bg-emerald-400 rounded-full" style={{ width: `${Math.min((d.transactions / maxContacts) * 100 * 10, 100)}%`, minWidth: "4px" }} />
                <span className="text-xs text-emerald-600">{d.transactions}tx</span>
              </div>
            )}
          </div>
          {d.revenue > 0 && (
            <span className="text-xs text-emerald-600 w-16 text-right">
              ${(d.revenue / 1000).toFixed(0)}k
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
export function SourceDetailClient({ sourceName, sourceFamily, brokerageId, userId, userType, initialData }: Props) {
  const [data, setData] = useState<SourceDrilldownResult>(initialData)
  const [isRefreshing, startRefresh] = useTransition()
  const [isAILoading, startAILoading] = useTransition()
  const [aiSummary, setAISummary] = useState<string | null>(initialData.ai_summary)
  const [aiError, setAIError] = useState<string | null>(null)

  const info = FAMILY_INFO[sourceFamily]
  const s = data.source

  const isBrokerOrAdmin = userType === "broker" || userType === "admin" || userType === "superadmin"

  const handleRefresh = useCallback(() => {
    startRefresh(async () => {
      const result = await getSourceDrilldown(
        brokerageId,
        `${sourceName}::${sourceFamily}`,
        isBrokerOrAdmin ? undefined : userId,
      )
      setData(result)
    })
  }, [brokerageId, sourceName, sourceFamily, userId, isBrokerOrAdmin])

  const handleGenerateAI = useCallback(() => {
    if (!s) return
    setAIError(null)
    startAILoading(async () => {
      const result = await generateSourceAISummaryForSource(
        brokerageId,
        s,
        data.timeline,
        data.agents,
      )
      if (result.success) {
        setAISummary(result.summary)
      } else {
        setAIError(result.error ?? "Failed to generate summary")
      }
    })
  }, [brokerageId, s, data.timeline, data.agents])

  // Compute funnel percentages
  const funnelData = s ? (() => {
    const upstream = sourceFamily === "raw" ? s.raw_record_count : sourceFamily === "lead" ? s.lead_count : s.contact_count
    const stages = []
    if (sourceFamily === "raw") stages.push({ label: "Raw Records", count: s.raw_record_count, pct: 100 })
    if (sourceFamily !== "contact_direct") {
      stages.push({ label: "Leads", count: s.lead_count, pct: upstream > 0 ? (s.lead_count / upstream) * 100 : 0 })
    }
    stages.push({ label: "Contacts", count: s.contact_count, pct: upstream > 0 ? (s.contact_count / upstream) * 100 : 0 })
    stages.push({ label: "Appointments", count: s.appointment_count, pct: upstream > 0 ? (s.appointment_count / upstream) * 100 : 0 })
    stages.push({ label: "Transactions", count: s.transaction_count, pct: upstream > 0 ? (s.transaction_count / upstream) * 100 : 0 })
    stages.push({ label: "Closed", count: s.closed_count, pct: upstream > 0 ? (s.closed_count / upstream) * 100 : 0 })
    return stages
  })() : []

  if (!s) {
    return (
      <div className="p-6 flex flex-col items-center justify-center gap-4 py-24">
        <AlertTriangle className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-muted-foreground font-medium">Source not found</p>
        <p className="text-sm text-muted-foreground">
          No data was found for source <strong>{sourceName}</strong> ({sourceFamily}).
          This source may not exist within the selected date range.
        </p>
        <Link href="/dashboard/analytics/source">
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Source Analytics
          </Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/analytics/source">
            <Button variant="ghost" size="sm" className="h-8 text-xs">
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
              Back
            </Button>
          </Link>
          <Badge variant="outline" className={`${info.color} border-current text-xs`}>
            {info.label}
          </Badge>
          {s.campaign_name && (
            <Badge variant="secondary" className="text-xs">
              Campaign: {s.campaign_name}
            </Badge>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={handleRefresh} disabled={isRefreshing} className="h-8 text-xs">
          {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TrendingUp className="h-3.5 w-3.5" />}
          <span className="ml-1.5">Refresh</span>
        </Button>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {sourceFamily === "raw" && (
          <StatCard label="Raw Records" value={s.raw_record_count.toLocaleString()} icon={Database} color="text-orange-600" />
        )}
        {sourceFamily !== "contact_direct" && (
          <StatCard label="Leads" value={s.lead_count.toLocaleString()} icon={Zap} color="text-blue-600" />
        )}
        <StatCard label="Contacts" value={s.contact_count.toLocaleString()} icon={Users} color="text-indigo-600" />
        <StatCard label="Appointments" value={s.appointment_count.toLocaleString()} icon={Calendar} color="text-purple-600" />
        <StatCard label="Transactions" value={s.transaction_count.toLocaleString()} icon={Target} color="text-amber-600" />
        <StatCard label="Closed" value={s.closed_count.toLocaleString()} icon={UserCheck} color="text-emerald-600" />
        <StatCard label="Revenue" value={`$${(s.revenue_attributed / 1000).toFixed(0)}k`} icon={DollarSign} color="text-emerald-600" />
        <StatCard label="ROI" value={s.roi_multiple > 0 ? `${s.roi_multiple}x` : "—"} icon={TrendingUp} color="text-emerald-600" />
        <StatCard label="Close Rate" value={`${s.close_rate}%`} icon={BarChart3} color="text-primary" />
        <StatCard label="Cost/Contact" value={s.cost_per_contact > 0 ? `$${s.cost_per_contact.toFixed(0)}` : "—"} icon={Clock} color="text-muted-foreground" />
      </div>

      <Tabs defaultValue="funnel">
        <TabsList>
          <TabsTrigger value="funnel">Funnel</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="contacts">Contacts ({data.recent_contacts.length})</TabsTrigger>
          {sourceFamily !== "contact_direct" && (
            <TabsTrigger value="leads">Leads ({data.recent_leads.length})</TabsTrigger>
          )}
          <TabsTrigger value="transactions">Transactions ({data.recent_transactions.length})</TabsTrigger>
          <TabsTrigger value="agents">Agents ({data.agents.length})</TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            AI Summary
          </TabsTrigger>
        </TabsList>

        {/* Funnel tab */}
        <TabsContent value="funnel" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Source Funnel — {info.funnelStages.join(" → ")}</CardTitle>
              <CardDescription>
                Each stage is shown as a percentage of the first entry stage for this source family.
                {sourceFamily === "contact_direct" && " Direct contact sources do not include a lead stage."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {funnelData.map(stage => (
                <FunnelRow key={stage.label} label={stage.label} count={stage.count} percent={stage.pct} />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Timeline tab */}
        <TabsContent value="timeline" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Monthly Performance</CardTitle>
            </CardHeader>
            <CardContent>
              <TimelineChart data={data.timeline} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Contacts tab */}
        <TabsContent value="contacts" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Contacts from this Source</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.recent_contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No contacts from this source yet</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recent_contacts.map(c => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.first_name} {c.last_name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{c.email ?? "—"}</TableCell>
                        <TableCell>
                          {c.status && <Badge variant="outline" className="text-xs">{c.status}</Badge>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{c.agent_name ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(c.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Link href={`/crm/contacts/${c.id}`}>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">View</Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Leads tab */}
        {sourceFamily !== "contact_direct" && (
          <TabsContent value="leads" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {sourceFamily === "raw" ? "Promoted Leads from Raw Records" : "Leads from this Source"}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.recent_leads.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No leads from this source yet</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Stage</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.recent_leads.map(l => (
                        <TableRow key={l.id}>
                          <TableCell className="font-medium">{l.first_name} {l.last_name}</TableCell>
                          <TableCell>
                            {l.lead_stage && <Badge variant="outline" className="text-xs capitalize">{l.lead_stage}</Badge>}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(l.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <Link href={`/dashboard/leads/${l.id}`}>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">View</Button>
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Transactions tab */}
        <TabsContent value="transactions" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Transactions Attributed to this Source</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.recent_transactions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No transactions attributed yet</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Deal</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Close Date</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recent_transactions.map(t => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.deal_name ?? "Unnamed Deal"}</TableCell>
                        <TableCell className="text-sm">
                          {t.purchase_price ? `$${(t.purchase_price / 1000).toFixed(0)}k` : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${t.status === "closed" ? "text-emerald-600 border-emerald-500" : ""}`}>
                            {t.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{t.agent_name ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {t.close_date ? new Date(t.close_date).toLocaleDateString() : "—"}
                        </TableCell>
                        <TableCell>
                          <Link href={`/dashboard/transactions/${t.id}`}>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">View</Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agents tab */}
        <TabsContent value="agents" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agent Performance for this Source</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.agents.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No agent data yet</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Contacts</TableHead>
                      <TableHead>Transactions</TableHead>
                      <TableHead>Revenue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.agents.map(a => (
                      <TableRow key={a.agent_id}>
                        <TableCell className="font-medium">{a.agent_name}</TableCell>
                        <TableCell>{a.contact_count}</TableCell>
                        <TableCell>{a.transaction_count}</TableCell>
                        <TableCell className="text-emerald-600">
                          {a.revenue > 0 ? `$${(a.revenue / 1000).toFixed(0)}k` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* AI Summary tab */}
        <TabsContent value="ai" className="mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    AI Performance Summary
                  </CardTitle>
                  <CardDescription>Natural language analysis for this specific source</CardDescription>
                </div>
                <Button onClick={handleGenerateAI} disabled={isAILoading} size="sm">
                  {isAILoading ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Generating...</>
                  ) : (
                    <><Sparkles className="h-4 w-4 mr-2" /> {aiSummary ? "Regenerate" : "Generate Summary"}</>
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {aiError && (
                <Alert variant="destructive" className="mb-4">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{aiError}</AlertDescription>
                </Alert>
              )}
              {!aiSummary && !isAILoading && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Sparkles className="h-12 w-12 text-muted-foreground/40 mb-4" />
                  <p className="text-muted-foreground font-medium">No summary yet</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Generate a natural language analysis of this source&apos;s performance.
                  </p>
                </div>
              )}
              {isAILoading && (
                <div className="space-y-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              )}
              {aiSummary && !isAILoading && (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  {aiSummary.split("\n\n").map((para, i) => (
                    <p key={i} className="text-sm leading-relaxed mb-3">{para}</p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
