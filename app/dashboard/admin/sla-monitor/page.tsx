"use client"

import { useEffect, useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type SLARow = {
  id: string
  lead_id: string
  brokerage_id: string
  sla_type: string
  target_at: string
  completed_at: string | null
  breached: boolean
  breach_notified: boolean
  lead_first_name: string | null
  lead_last_name: string | null
  agent_first_name: string | null
  agent_last_name: string | null
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function daysOverdue(targetAt: string): number {
  return Math.floor((Date.now() - new Date(targetAt).getTime()) / (1000 * 60 * 60 * 24))
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function SLAMonitorPage() {
  const supabase = createClient()

  const [rows, setRows]           = useState<SLARow[]>([])
  const [loading, setLoading]     = useState(true)
  const [brokerageId, setBrokerageId] = useState<string | null>(null)

  // Filters
  const [filterType, setFilterType]       = useState<string>("all")
  const [filterAgent, setFilterAgent]     = useState<string>("")
  const [filterFrom, setFilterFrom]       = useState<string>("")
  const [filterTo, setFilterTo]           = useState<string>("")

  const [, startTransition] = useTransition()

  // Load brokerage from session
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("brokerage_id")
        .eq("user_id", data.user.id)
        .single()
      if (profile) setBrokerageId(profile.brokerage_id)
    })
  }, [])

  // Load SLA rows
  useEffect(() => {
    if (!brokerageId) return
    setLoading(true)
    startTransition(async () => {
      // Fetch breached rows joined with lead + agent names
      const { data: slaData } = await supabase
        .from("lead_sla_tracking")
        .select(`
          id, lead_id, brokerage_id, sla_type, target_at, completed_at,
          breached, breach_notified,
          leads!lead_id ( first_name, last_name, agent_id,
            user_profiles!agent_id ( first_name, last_name )
          )
        `)
        .eq("brokerage_id", brokerageId)
        .eq("breached", true)
        .order("target_at", { ascending: false })
        .limit(200)

      const mapped: SLARow[] = (slaData ?? []).map((r: Record<string, unknown>) => {
        const lead = r.leads as Record<string, unknown> | null
        const agentProfile = lead?.user_profiles as Record<string, unknown> | null
        return {
          id:               r.id as string,
          lead_id:          r.lead_id as string,
          brokerage_id:     r.brokerage_id as string,
          sla_type:         r.sla_type as string,
          target_at:        r.target_at as string,
          completed_at:     r.completed_at as string | null,
          breached:         r.breached as boolean,
          breach_notified:  r.breach_notified as boolean,
          lead_first_name:  (lead?.first_name as string) ?? null,
          lead_last_name:   (lead?.last_name as string) ?? null,
          agent_first_name: (agentProfile?.first_name as string) ?? null,
          agent_last_name:  (agentProfile?.last_name as string) ?? null,
        }
      })
      setRows(mapped)
      setLoading(false)
    })
  }, [brokerageId])

  // ── Filtered rows ──────────────────────────────────────────────────────────
  const filtered = rows.filter((r) => {
    if (filterType !== "all" && r.sla_type !== filterType) return false
    if (filterAgent) {
      const agentName = `${r.agent_first_name ?? ""} ${r.agent_last_name ?? ""}`.toLowerCase()
      if (!agentName.includes(filterAgent.toLowerCase())) return false
    }
    if (filterFrom && new Date(r.target_at) < new Date(filterFrom)) return false
    if (filterTo   && new Date(r.target_at) > new Date(filterTo))   return false
    return true
  })

  // ── Summary stats ──────────────────────────────────────────────────────────
  const totalBreached  = rows.length
  const totalCompleted = rows.filter((r) => r.completed_at !== null).length
  const compliancePct  = totalBreached > 0
    ? Math.round((totalCompleted / totalBreached) * 100)
    : 100

  const avgDaysOverdue = filtered.length > 0
    ? Math.round(
        filtered.reduce((sum, r) => sum + daysOverdue(r.target_at), 0) / filtered.length
      )
    : 0

  const slaTypes = Array.from(new Set(rows.map((r) => r.sla_type)))

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">SLA Monitor</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Track lead SLA breaches, response times, and compliance rates.
        </p>
      </div>

      {/* ── Summary stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Total Breached
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">{totalBreached}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Compliance Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{compliancePct}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Avg Days Overdue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{avgDaysOverdue}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Notified
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">
              {rows.filter((r) => r.breach_notified).length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="SLA Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {slaTypes.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          placeholder="Filter by agent name"
          value={filterAgent}
          onChange={(e) => setFilterAgent(e.target.value)}
          className="w-52"
        />

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">From</span>
          <Input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="w-36"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">To</span>
          <Input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className="w-36"
          />
        </div>

        {(filterType !== "all" || filterAgent || filterFrom || filterTo) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilterType("all")
              setFilterAgent("")
              setFilterFrom("")
              setFilterTo("")
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* ── Breach table ── */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading SLA data...</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No SLA breaches found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Lead</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">SLA Type</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Agent</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Target Date</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Days Overdue</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => {
                    const overdue    = daysOverdue(row.target_at)
                    const leadName   = [row.lead_first_name, row.lead_last_name].filter(Boolean).join(" ") || row.lead_id.slice(0, 8)
                    const agentName  = [row.agent_first_name, row.agent_last_name].filter(Boolean).join(" ") || "Unassigned"

                    return (
                      <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{leadName}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="text-xs">{row.sla_type}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{agentName}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(row.target_at)}</td>
                        <td className="px-4 py-3">
                          <span className={overdue > 7 ? "text-destructive font-semibold" : "text-orange-600 dark:text-orange-400 font-medium"}>
                            {overdue}d
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {row.completed_at ? (
                            <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                              Resolved
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-xs">
                              Breached
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Button
                            variant="outline"
                            size="sm"
                            asChild
                          >
                            <a href={`/dashboard/leads/${row.lead_id}`}>
                              View Lead
                            </a>
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
