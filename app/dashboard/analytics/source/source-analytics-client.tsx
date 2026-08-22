"use client"

import { useState, useTransition, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
  TrendingUp,
  Users,
  DollarSign,
  Target,
  Sparkles,
  Download,
  Mail,
  RefreshCw,
  Search,
  ChevronRight,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Globe,
  Database,
  Zap,
  Award,
  XCircle,
  SlidersHorizontal,
  Printer,
} from "lucide-react"
import Link from "next/link"
import {
  getSourcePerformance,
  generateSourceAIInsights,
  exportSourceCSV,
  emailSourceReport,
  type SourceMetrics,
  type SourceFamily,
} from "@/app/actions/source-analytics"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────
interface Props {
  userId: string
  brokerageId: string
  userType: string
  agentId: string | null
  initialSources: SourceMetrics[]
  initialSummary: {
    total_sources: number
    total_contacts: number
    total_leads: number
    total_raw_records: number
    total_transactions: number
    total_revenue: number
    top_roi_source: string | null
    top_volume_source: string | null
    top_direct_source: string | null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const FAMILY_LABELS: Record<SourceFamily, { label: string; color: string; bg: string; icon: typeof Globe }> = {
  raw:            { label: "Raw / Acquisition", color: "text-orange-600",  bg: "bg-orange-500/10", icon: Database },
  lead:           { label: "Lead",               color: "text-blue-600",   bg: "bg-blue-500/10",   icon: Zap },
  contact_direct: { label: "Direct Contact",     color: "text-emerald-600",bg: "bg-emerald-500/10",icon: Globe },
}

function FamilyBadge({ family }: { family: SourceFamily }) {
  const meta = FAMILY_LABELS[family]
  return (
    <Badge variant="outline" className={`text-xs ${meta.color} border-current`}>
      {meta.label}
    </Badge>
  )
}

function MetricCard({
  label, value, sub, icon: Icon, color = "text-primary",
}: {
  label: string; value: string; sub?: string; icon: typeof BarChart3; color?: string
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${color.replace("text-", "bg-").replace("-600", "-500/10").replace("-500", "-500/10")}`}>
            <Icon className={`h-5 w-5 ${color}`} />
          </div>
          <div>
            <p className="text-2xl font-bold tracking-tight">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function FunnelBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground w-28 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium w-10 text-right">{value.toLocaleString()}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Row
// ─────────────────────────────────────────────────────────────────────────────
function SourceRow({
  source,
  isSelected,
  onSelect,
  onDrilldown,
}: {
  source: SourceMetrics
  isSelected: boolean
  onSelect: (key: string) => void
  onDrilldown: (source: SourceMetrics) => void
}) {
  const key = `${source.source}::${source.source_family}`
  return (
    <TableRow
      className={`cursor-pointer hover:bg-muted/50 ${isSelected ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
      onClick={() => onSelect(key)}
    >
      <TableCell>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onSelect(key)}
            onClick={e => e.stopPropagation()}
            className="rounded"
          />
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <p className="font-medium text-sm capitalize">{source.source.replace(/_/g, " ")}</p>
          <FamilyBadge family={source.source_family} />
        </div>
      </TableCell>
      <TableCell className="text-sm">
        {source.source_family === "raw" && (
          <span className="text-orange-600">{source.raw_record_count.toLocaleString()} raw</span>
        )}
        {source.source_family === "lead" && (
          <span className="text-blue-600">{source.lead_count.toLocaleString()} leads</span>
        )}
        {source.source_family === "contact_direct" && (
          <span className="text-emerald-600">{source.contact_count.toLocaleString()} contacts</span>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {source.contact_count.toLocaleString()}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {source.appointment_count.toLocaleString()}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {source.closed_count.toLocaleString()}
      </TableCell>
      <TableCell>
        <span className={`text-sm font-medium ${source.close_rate >= 10 ? "text-emerald-600" : source.close_rate >= 3 ? "text-amber-600" : "text-muted-foreground"}`}>
          {source.close_rate}%
        </span>
        {/* Wording-vs-quality verdict. A weak source with a fixable opener must NOT
            be downranked — that throws away good leads over a copy problem. */}
        {source.diagnostic && source.diagnostic.verdict !== "healthy" && (
          <div
            className={`mt-1 text-[10px] leading-tight ${
              source.diagnostic.verdict === "wording_issue"
                ? "text-amber-700"
                : source.diagnostic.verdict === "insufficient_data"
                  ? "text-muted-foreground"
                  : "text-red-600"
            }`}
            title={source.diagnostic.why}
          >
            {source.diagnostic.verdict === "wording_issue"
              ? "copy, not source — test new opener"
              : source.diagnostic.verdict === "source_quality_issue"
                ? "source quality — consider downranking"
                : source.diagnostic.verdict === "targeting_issue"
                  ? "targeting/cadence mismatch"
                  : "not enough touches to judge"}
          </div>
        )}
      </TableCell>
      <TableCell>
        <span className={`text-sm font-medium ${source.roi_multiple >= 5 ? "text-emerald-600" : source.roi_multiple >= 2 ? "text-amber-600" : "text-red-500"}`}>
          {source.roi_multiple > 0 ? `${source.roi_multiple}x` : "—"}
        </span>
      </TableCell>
      <TableCell className="text-sm font-medium">
        ${source.revenue_attributed > 0 ? (source.revenue_attributed / 1000).toFixed(0) + "k" : "—"}
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={e => { e.stopPropagation(); onDrilldown(source) }}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare Dialog
// ─────────────────────────────────────────────────────────────────────────────
function CompareDialog({
  open,
  onClose,
  sources,
}: {
  open: boolean
  onClose: () => void
  sources: SourceMetrics[]
}) {
  if (!open || sources.length === 0) return null
  const metrics: Array<{ label: string; fn: (s: SourceMetrics) => string }> = [
    { label: "Source Family", fn: s => s.source_family },
    { label: "Raw Records", fn: s => s.raw_record_count > 0 ? s.raw_record_count.toLocaleString() : "—" },
    { label: "Leads", fn: s => s.lead_count > 0 ? s.lead_count.toLocaleString() : "—" },
    { label: "Contacts", fn: s => s.contact_count.toLocaleString() },
    { label: "Appointments", fn: s => s.appointment_count.toLocaleString() },
    { label: "Transactions", fn: s => s.transaction_count.toLocaleString() },
    { label: "Closed", fn: s => s.closed_count.toLocaleString() },
    { label: "Close Rate", fn: s => `${s.close_rate}%` },
    { label: "Appt Rate", fn: s => `${s.contact_to_appt_rate}%` },
    { label: "Total Spend", fn: s => `$${s.total_spend.toFixed(0)}` },
    { label: "Revenue", fn: s => `$${s.revenue_attributed.toFixed(0)}` },
    { label: "ROI", fn: s => s.roi_multiple > 0 ? `${s.roi_multiple}x` : "—" },
    { label: "Cost / Contact", fn: s => s.cost_per_contact > 0 ? `$${s.cost_per_contact.toFixed(0)}` : "—" },
    { label: "Top Agent", fn: s => s.top_agent_name ?? "—" },
  ]

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Source Comparison</DialogTitle>
          <DialogDescription>Side-by-side comparison of {sources.length} sources</DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">Metric</TableHead>
                {sources.map(s => (
                  <TableHead key={`${s.source}::${s.source_family}`} className="capitalize">
                    {s.source.replace(/_/g, " ")}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map(m => (
                <TableRow key={m.label}>
                  <TableCell className="text-xs font-medium text-muted-foreground">{m.label}</TableCell>
                  {sources.map(s => (
                    <TableCell key={`${s.source}::${s.source_family}`} className="text-sm">
                      {m.fn(s)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Report Dialog
// ─────────────────────────────────────────────────────────────────────────────
function EmailReportDialog({
  open,
  onClose,
  onSend,
  isPending,
}: {
  open: boolean
  onClose: () => void
  onSend: (email: string, name: string) => void
  isPending: boolean
}) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Email Source Report</DialogTitle>
          <DialogDescription>Send a source performance report via email</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Recipient Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="John Smith" />
          </div>
          <div className="space-y-1.5">
            <Label>Email Address</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="agent@brokerage.com" />
          </div>
          <Button
            className="w-full"
            onClick={() => onSend(email, name)}
            disabled={!email || !name || isPending}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Mail className="h-4 w-4 mr-2" />}
            Send Report
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────
export function SourceAnalyticsClient({
  userId,
  brokerageId,
  userType,
  agentId,
  initialSources,
  initialSummary,
}: Props) {
  const router = useRouter()
  const [sources, setSources] = useState<SourceMetrics[]>(initialSources)
  const [summary, setSummary] = useState(initialSummary)
  const [isLoading, startLoading] = useTransition()
  const [isAILoading, startAILoading] = useTransition()
  const [isExporting, startExporting] = useTransition()
  const [isEmailing, startEmailing] = useTransition()

  // Filters
  const [dateFrom, setDateFrom] = useState<string>(() => {
    const d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    return d.toISOString().split("T")[0]
  })
  const [dateTo, setDateTo] = useState<string>(() => new Date().toISOString().split("T")[0])
  const [familyFilter, setFamilyFilter] = useState<string>("all")
  const [sortBy, setSortBy] = useState<string>("volume")
  const [searchQuery, setSearchQuery] = useState("")

  // State
  const [aiInsights, setAIInsights] = useState<string | null>(null)
  const [aiError, setAIError] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [compareOpen, setCompareOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailSuccess, setEmailSuccess] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const isBrokerOrAdmin = userType === "broker" || userType === "admin" || userType === "superadmin"

  // Filter sources by tab and search
  const filteredSources = sources.filter(s => {
    if (familyFilter !== "all" && s.source_family !== familyFilter) return false
    if (searchQuery && !s.source.toLowerCase().includes(searchQuery.toLowerCase())) return false
    return true
  })

  const acquisitionSources = filteredSources.filter(s => s.source_family === "raw")
  const leadSources = filteredSources.filter(s => s.source_family === "lead")
  const directSources = filteredSources.filter(s => s.source_family === "contact_direct")

  // Best / worst performers
  const topRoiSources = [...sources].filter(s => s.roi_multiple > 0).sort((a, b) => b.roi_multiple - a.roi_multiple).slice(0, 3)
  const topVolumeSources = [...sources].sort((a, b) => b.contact_count - a.contact_count).slice(0, 3)
  const lowestPaidSources = [...sources].filter(s => s.total_spend > 0).sort((a, b) => a.roi_multiple - b.roi_multiple).slice(0, 3)
  const topDirectSources = [...sources].filter(s => s.source_family === "contact_direct").sort((a, b) => b.close_rate - a.close_rate).slice(0, 3)

  const handleRefresh = useCallback(() => {
    startLoading(async () => {
      const result = await getSourcePerformance({
        brokerageId,
        agentId: isBrokerOrAdmin ? undefined : userId,
        dateFrom: new Date(dateFrom).toISOString(),
        dateTo: new Date(dateTo).toISOString(),
        sourceFamilies: familyFilter !== "all" ? [familyFilter as SourceFamily] : undefined,
        sortBy: sortBy as "roi" | "volume" | "revenue" | "appt_rate" | "close_rate" | "cost_efficiency",
      })
      if (result.success) {
        setSources(result.sources)
        setSummary(result.summary)
      }
    })
  }, [brokerageId, userId, isBrokerOrAdmin, dateFrom, dateTo, familyFilter, sortBy])

  const handleGenerateInsights = useCallback(() => {
    setAIError(null)
    startAILoading(async () => {
      const result = await generateSourceAIInsights(brokerageId, sources)
      if (result.success) {
        setAIInsights(result.insights)
      } else {
        setAIError(result.error ?? "Failed to generate insights")
      }
    })
  }, [brokerageId, sources])

  const handleExportCSV = useCallback(() => {
    setExportError(null)
    startExporting(async () => {
      const result = await exportSourceCSV({
        brokerageId,
        agentId: isBrokerOrAdmin ? undefined : userId,
        dateFrom: new Date(dateFrom).toISOString(),
        dateTo: new Date(dateTo).toISOString(),
      })
      if (result.success) {
        const blob = new Blob([result.csv], { type: "text/csv" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `source-analytics-${dateFrom}-to-${dateTo}.csv`
        a.click()
        URL.revokeObjectURL(url)
      } else {
        setExportError(result.error ?? "Export failed")
      }
    })
  }, [brokerageId, userId, isBrokerOrAdmin, dateFrom, dateTo])

  const handleSendEmail = useCallback((email: string, name: string) => {
    startEmailing(async () => {
      const result = await emailSourceReport(brokerageId, email, name, "brokerage", {
        brokerageId,
        agentId: isBrokerOrAdmin ? undefined : userId,
        dateFrom: new Date(dateFrom).toISOString(),
        dateTo: new Date(dateTo).toISOString(),
      })
      if (result.success) {
        setEmailOpen(false)
        setEmailSuccess(true)
      }
    })
  }, [brokerageId, userId, isBrokerOrAdmin, dateFrom, dateTo])

  const handlePrint = useCallback(() => {
    window.print()
  }, [])

  const handleToggleSelect = useCallback((key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else if (next.size < 4) next.add(key)
      return next
    })
  }, [])

  const selectedSources = sources.filter(s => selectedKeys.has(`${s.source}::${s.source_family}`))

  function SourceTable({ rows }: { rows: SourceMetrics[] }) {
    if (isLoading) {
      return (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )
    }
    if (rows.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <p className="text-muted-foreground font-medium">No source data available</p>
          <p className="text-sm text-muted-foreground mt-1">
            Sources appear when contacts, leads, or records are acquired with source attribution.
          </p>
        </div>
      )
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10"></TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Entry Stage</TableHead>
            <TableHead>Contacts</TableHead>
            <TableHead>Appts</TableHead>
            <TableHead>Closed</TableHead>
            <TableHead>Close Rate</TableHead>
            <TableHead>ROI</TableHead>
            <TableHead>Revenue</TableHead>
            <TableHead className="w-10"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(s => (
            <SourceRow
              key={`${s.source}::${s.source_family}`}
              source={s}
              isSelected={selectedKeys.has(`${s.source}::${s.source_family}`)}
              onSelect={handleToggleSelect}
              onDrilldown={s => router.push(`/dashboard/analytics/source/${encodeURIComponent(s.source)}?family=${s.source_family}`)}
            />
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Summary Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <MetricCard label="Total Sources" value={summary.total_sources.toString()} icon={Target} color="text-primary" />
        <MetricCard label="Total Contacts" value={summary.total_contacts.toLocaleString()} icon={Users} color="text-blue-600" />
        <MetricCard label="Total Leads" value={summary.total_leads.toLocaleString()} icon={Zap} color="text-amber-600" />
        <MetricCard label="Raw Records" value={summary.total_raw_records.toLocaleString()} icon={Database} color="text-orange-600" />
        <MetricCard label="Transactions" value={summary.total_transactions.toLocaleString()} icon={TrendingUp} color="text-emerald-600" />
        <MetricCard label="Revenue" value={`$${(summary.total_revenue / 1000).toFixed(0)}k`} icon={DollarSign} color="text-emerald-600" />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 p-4 bg-muted/30 border rounded-lg">
        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 text-xs w-36" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 text-xs w-36" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Family</Label>
          <Select value={familyFilter} onValueChange={setFamilyFilter}>
            <SelectTrigger className="h-8 text-xs w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Families</SelectItem>
              <SelectItem value="raw">Raw / Acquisition</SelectItem>
              <SelectItem value="lead">Lead</SelectItem>
              <SelectItem value="contact_direct">Direct Contact</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Sort By</Label>
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="h-8 text-xs w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="volume">Volume</SelectItem>
              <SelectItem value="roi">ROI</SelectItem>
              <SelectItem value="revenue">Revenue</SelectItem>
              <SelectItem value="close_rate">Close Rate</SelectItem>
              <SelectItem value="appt_rate">Appt Rate</SelectItem>
              <SelectItem value="cost_efficiency">Cost Efficiency</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Search</Label>
          <div className="relative">
            <Search className="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="h-8 text-xs pl-7 w-48"
              placeholder="Search sources..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-end gap-2 ml-auto flex-wrap">
          <Button size="sm" variant="outline" onClick={handleRefresh} disabled={isLoading} className="h-8 text-xs">
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Refresh</span>
          </Button>
          {selectedKeys.size >= 2 && (
            <Button size="sm" variant="outline" onClick={() => setCompareOpen(true)} className="h-8 text-xs">
              <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
              Compare ({selectedKeys.size})
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleExportCSV} disabled={isExporting} className="h-8 text-xs">
            {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Export CSV</span>
          </Button>
          <Button size="sm" variant="outline" onClick={handlePrint} className="h-8 text-xs">
            <Printer className="h-3.5 w-3.5 mr-1.5" />
            Print Report
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEmailOpen(true)} className="h-8 text-xs">
            <Mail className="h-3.5 w-3.5 mr-1.5" />
            Email Report
          </Button>
        </div>
      </div>

      {exportError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{exportError}</AlertDescription>
        </Alert>
      )}
      {emailSuccess && (
        <Alert>
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <AlertDescription className="flex items-center justify-between">
            <span>Report queued for delivery.</span>
            <button
              type="button"
              onClick={() => setEmailSuccess(false)}
              className="text-xs text-muted-foreground hover:text-foreground ml-4"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* Performance Highlights */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Top ROI */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Award className="h-4 w-4 text-emerald-500" />
              Top ROI Sources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {topRoiSources.length === 0 ? (
              <p className="text-xs text-muted-foreground">No spend data yet</p>
            ) : topRoiSources.map((s, i) => (
              <div key={`${s.source}::${s.source_family}`} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                  <span className="text-xs capitalize">{s.source.replace(/_/g, " ")}</span>
                </div>
                <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-500">{s.roi_multiple}x</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Top Volume */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-blue-500" />
              Top Volume Sources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {topVolumeSources.length === 0 ? (
              <p className="text-xs text-muted-foreground">No data yet</p>
            ) : topVolumeSources.map((s, i) => (
              <div key={`${s.source}::${s.source_family}`} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                  <span className="text-xs capitalize">{s.source.replace(/_/g, " ")}</span>
                </div>
                <span className="text-xs font-medium">{s.contact_count.toLocaleString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Lowest Performing Paid */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-500" />
              Low-ROI Paid Sources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {lowestPaidSources.length === 0 ? (
              <p className="text-xs text-muted-foreground">No paid sources yet</p>
            ) : lowestPaidSources.map((s, i) => (
              <div key={`${s.source}::${s.source_family}`} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                  <span className="text-xs capitalize">{s.source.replace(/_/g, " ")}</span>
                </div>
                <Badge variant="outline" className="text-xs text-red-500 border-red-400">{s.roi_multiple}x</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Best Direct Contact */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Globe className="h-4 w-4 text-emerald-500" />
              Best Direct Sources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {topDirectSources.length === 0 ? (
              <p className="text-xs text-muted-foreground">No direct sources yet</p>
            ) : topDirectSources.map((s, i) => (
              <div key={`${s.source}::${s.source_family}`} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                  <span className="text-xs capitalize">{s.source.replace(/_/g, " ")}</span>
                </div>
                <span className="text-xs font-medium text-emerald-600">{s.close_rate}% close</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All Sources ({filteredSources.length})</TabsTrigger>
          <TabsTrigger value="acquisition">
            <Database className="h-3.5 w-3.5 mr-1.5" />
            Acquisition ({acquisitionSources.length})
          </TabsTrigger>
          <TabsTrigger value="lead">
            <Zap className="h-3.5 w-3.5 mr-1.5" />
            Lead ({leadSources.length})
          </TabsTrigger>
          <TabsTrigger value="direct">
            <Globe className="h-3.5 w-3.5 mr-1.5" />
            Direct Contact ({directSources.length})
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            AI Insights
          </TabsTrigger>
        </TabsList>

        {/* All Sources */}
        <TabsContent value="all" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">All Sources</CardTitle>
              <CardDescription>
                Select 2-4 sources to compare. Click a row to open the drill-down.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <SourceTable rows={filteredSources} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Raw / Acquisition */}
        <TabsContent value="acquisition" className="mt-4 space-y-4">
          <Card className="border-orange-200 bg-orange-50/30 dark:border-orange-900/30 dark:bg-orange-950/10">
            <CardHeader>
              <CardTitle className="text-base text-orange-700 dark:text-orange-400">Raw / Acquisition Sources</CardTitle>
              <CardDescription>
                Pre-consent records: scraped, imported, purchased. Funnel: Raw Record → Lead → Contact → Appointment → Transaction → Closed
              </CardDescription>
            </CardHeader>
          </Card>
          {/* Funnel overview for raw sources */}
          {acquisitionSources.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Aggregate Raw Funnel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const totalRaw = acquisitionSources.reduce((s, x) => s + x.raw_record_count, 0)
                  const totalLeads = acquisitionSources.reduce((s, x) => s + x.lead_count, 0)
                  const totalContacts = acquisitionSources.reduce((s, x) => s + x.contact_count, 0)
                  const totalAppts = acquisitionSources.reduce((s, x) => s + x.appointment_count, 0)
                  const totalTx = acquisitionSources.reduce((s, x) => s + x.transaction_count, 0)
                  const totalClosed = acquisitionSources.reduce((s, x) => s + x.closed_count, 0)
                  return <>
                    <FunnelBar label="Raw Records" value={totalRaw} max={totalRaw} color="bg-orange-400" />
                    <FunnelBar label="Promoted to Lead" value={totalLeads} max={totalRaw} color="bg-amber-400" />
                    <FunnelBar label="Converted Contact" value={totalContacts} max={totalRaw} color="bg-blue-400" />
                    <FunnelBar label="Appointments" value={totalAppts} max={totalRaw} color="bg-purple-400" />
                    <FunnelBar label="Transactions" value={totalTx} max={totalRaw} color="bg-indigo-400" />
                    <FunnelBar label="Closed" value={totalClosed} max={totalRaw} color="bg-emerald-500" />
                  </>
                })()}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <SourceTable rows={acquisitionSources} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Lead Sources */}
        <TabsContent value="lead" className="mt-4 space-y-4">
          <Card className="border-blue-200 bg-blue-50/30 dark:border-blue-900/30 dark:bg-blue-950/10">
            <CardHeader>
              <CardTitle className="text-base text-blue-700 dark:text-blue-400">Lead-Level Sources</CardTitle>
              <CardDescription>
                Sources that create leads directly. Funnel: Lead → Contact → Appointment → Transaction → Closed
              </CardDescription>
            </CardHeader>
          </Card>
          {leadSources.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Aggregate Lead Funnel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const totalLeads = leadSources.reduce((s, x) => s + x.lead_count, 0)
                  const totalContacts = leadSources.reduce((s, x) => s + x.contact_count, 0)
                  const totalAppts = leadSources.reduce((s, x) => s + x.appointment_count, 0)
                  const totalClosed = leadSources.reduce((s, x) => s + x.closed_count, 0)
                  return <>
                    <FunnelBar label="Leads" value={totalLeads} max={totalLeads} color="bg-blue-400" />
                    <FunnelBar label="Converted Contact" value={totalContacts} max={totalLeads} color="bg-sky-400" />
                    <FunnelBar label="Appointments" value={totalAppts} max={totalLeads} color="bg-purple-400" />
                    <FunnelBar label="Closed" value={totalClosed} max={totalLeads} color="bg-emerald-500" />
                  </>
                })()}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <SourceTable rows={leadSources} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Direct Contact Sources */}
        <TabsContent value="direct" className="mt-4 space-y-4">
          <Card className="border-emerald-200 bg-emerald-50/30 dark:border-emerald-900/30 dark:bg-emerald-950/10">
            <CardHeader>
              <CardTitle className="text-base text-emerald-700 dark:text-emerald-400">Direct Contact Sources</CardTitle>
              <CardDescription>
                Consented, customer-facing entry points. Funnel: Contact → Appointment → Transaction → Closed. No fake lead stage applied.
              </CardDescription>
            </CardHeader>
          </Card>
          {directSources.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Aggregate Direct Contact Funnel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const totalContacts = directSources.reduce((s, x) => s + x.contact_count, 0)
                  const totalAppts = directSources.reduce((s, x) => s + x.appointment_count, 0)
                  const totalTx = directSources.reduce((s, x) => s + x.transaction_count, 0)
                  const totalClosed = directSources.reduce((s, x) => s + x.closed_count, 0)
                  return <>
                    <FunnelBar label="Contacts Created" value={totalContacts} max={totalContacts} color="bg-emerald-400" />
                    <FunnelBar label="Appointments" value={totalAppts} max={totalContacts} color="bg-teal-400" />
                    <FunnelBar label="Transactions" value={totalTx} max={totalContacts} color="bg-cyan-400" />
                    <FunnelBar label="Closed" value={totalClosed} max={totalContacts} color="bg-green-500" />
                  </>
                })()}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <SourceTable rows={directSources} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* AI Insights */}
        <TabsContent value="ai" className="mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    AI Source Performance Insights
                  </CardTitle>
                  <CardDescription>
                    Natural language analysis of your source attribution data
                  </CardDescription>
                </div>
                <Button
                  onClick={handleGenerateInsights}
                  disabled={isAILoading || sources.length === 0}
                  size="sm"
                >
                  {isAILoading ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Generating...</>
                  ) : (
                    <><Sparkles className="h-4 w-4 mr-2" /> Generate Insights</>
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
              {!aiInsights && !isAILoading && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Sparkles className="h-12 w-12 text-muted-foreground/40 mb-4" />
                  <p className="text-muted-foreground font-medium">No AI insights yet</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                    Click Generate Insights to get a natural language analysis of your source attribution performance.
                  </p>
                </div>
              )}
              {isAILoading && (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              )}
              {aiInsights && !isAILoading && (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  {aiInsights.split("\n\n").map((para, i) => (
                    <p key={i} className="text-sm leading-relaxed mb-3">{para}</p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Modals */}
      <CompareDialog
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        sources={selectedSources}
      />
      <EmailReportDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        onSend={handleSendEmail}
        isPending={isEmailing}
      />
    </div>
  )
}
