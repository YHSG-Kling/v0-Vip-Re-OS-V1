"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Calendar,
  Users,
  FileText,
  MessageSquare,
  AlertTriangle,
  Clock,
  Home,
  ArrowRight,
  RefreshCw,
  ChevronRight,
  Building2,
  Zap,
  CheckCircle2,
  TrendingUp,
} from "lucide-react"
import { formatDistanceToNow, format, isToday } from "date-fns"

interface OperationsData {
  agentId: string | null
  brokerageId: string | null
  todayShowings: any[]
  pendingHandoffs: any[]
  pendingDrafts: any[]
  stuckTransactions: any[]
  stuckListings: any[]
  staleQualifiedLeads: any[]
  acceptedOffersNoTx: any[]
  activeAgentCount: number
  openTransactionCount: number
  newLeadsToday: number
}

interface Props {
  role: string
  firstName?: string
}

export function OperationsClient({ role, firstName }: Props) {
  const [data, setData] = useState<OperationsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState(
    ["broker", "admin"].includes(role) ? "broker" : "agent"
  )

  const isBrokerAdmin = ["broker", "admin"].includes(role)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/dashboard/operations")
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const todayLabel = format(new Date(), "EEEE, MMMM d")

  // Stuck work total
  const stuckTotal = data
    ? data.stuckTransactions.length +
      data.stuckListings.length +
      data.staleQualifiedLeads.length +
      data.acceptedOffersNoTx.length
    : 0

  return (
    <div className="min-h-screen bg-background">
      {/* Header strip */}
      <div className="border-b border-border bg-card px-4 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground text-balance">
              {firstName ? `Good morning, ${firstName}` : "Operations"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">{todayLabel}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            disabled={loading}
            className="self-start sm:self-auto"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Summary stat strip */}
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : data ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile
              icon={Calendar}
              label="Showings Today"
              value={data.todayShowings.length}
              href="/dashboard/listings"
              accent="blue"
            />
            <StatTile
              icon={MessageSquare}
              label="AI Drafts Pending"
              value={data.pendingDrafts.length}
              href="/dashboard/communications/outreach"
              accent="indigo"
            />
            <StatTile
              icon={Users}
              label="Handoffs Pending"
              value={data.pendingHandoffs.length}
              href="/dashboard/communications/handoffs"
              accent="amber"
              urgent={data.pendingHandoffs.length > 0}
            />
            <StatTile
              icon={AlertTriangle}
              label="Stuck Work Items"
              value={stuckTotal}
              href="#stuck-work"
              accent="red"
              urgent={stuckTotal > 0}
            />
          </div>
        ) : null}

        {/* Role tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex w-full sm:w-auto">
            <TabsTrigger value="agent" className="flex-1 sm:flex-none gap-2">
              <Users className="h-4 w-4" />
              Agent View
            </TabsTrigger>
            {isBrokerAdmin && (
              <TabsTrigger value="broker" className="flex-1 sm:flex-none gap-2">
                <Building2 className="h-4 w-4" />
                Broker View
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── AGENT VIEW ────────────────────────────────────────── */}
          <TabsContent value="agent" className="space-y-6 mt-6">
            {/* Today's Showings */}
            <SectionCard
              title="Today's Showings"
              icon={Home}
              count={data?.todayShowings.length ?? 0}
              href="/dashboard/listings"
              loading={loading}
            >
              {data?.todayShowings.length === 0 ? (
                <EmptyState message="No showings scheduled today." />
              ) : (
                <div className="divide-y divide-border">
                  {(data?.todayShowings ?? []).map((s) => (
                    <div key={s.id} className="flex items-center justify-between px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {s.listing?.address ?? "Unknown address"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {s.scheduled_at
                            ? format(new Date(s.scheduled_at), "h:mm a")
                            : "Time TBD"}
                          {s.listing?.list_price
                            ? ` · $${Number(s.listing.list_price).toLocaleString()}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={s.status} />
                        <Link href="/dashboard/listings">
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* Pending AI Handoffs */}
            <SectionCard
              title="AI Handoffs Awaiting You"
              icon={Zap}
              count={data?.pendingHandoffs.length ?? 0}
              href="/dashboard/communications/handoffs"
              loading={loading}
              urgentCount={data?.pendingHandoffs.length}
            >
              {data?.pendingHandoffs.length === 0 ? (
                <EmptyState message="No pending AI handoffs." />
              ) : (
                <div className="divide-y divide-border">
                  {(data?.pendingHandoffs ?? []).map((h) => (
                    <div key={h.id} className="flex items-center justify-between px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {h.handoff_reason ?? "AI hand-off"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {h.entity_type} ·{" "}
                          {h.created_at ? formatDistanceToNow(new Date(h.created_at), { addSuffix: true }) : ""}
                        </p>
                      </div>
                      <Link href="/dashboard/communications/handoffs">
                        <Button size="sm" variant="outline" className="shrink-0 h-8">
                          Review
                        </Button>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* AI Draft Messages */}
            <SectionCard
              title="AI Draft Messages"
              icon={MessageSquare}
              count={data?.pendingDrafts.length ?? 0}
              href="/dashboard/communications/outreach"
              loading={loading}
            >
              {data?.pendingDrafts.length === 0 ? (
                <EmptyState message="No drafts waiting for review." />
              ) : (
                <div className="divide-y divide-border">
                  {(data?.pendingDrafts ?? []).map((d) => (
                    <div key={d.id} className="flex items-center justify-between px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {d.draft_subject ?? "Draft message"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {d.channel ?? "email"} ·{" "}
                          {d.created_at ? formatDistanceToNow(new Date(d.created_at), { addSuffix: true }) : ""}
                        </p>
                      </div>
                      <Link href="/dashboard/communications/outreach">
                        <Button size="sm" variant="outline" className="shrink-0 h-8">
                          Review
                        </Button>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </TabsContent>

          {/* ── BROKER VIEW ───────────────────────────────────────── */}
          {isBrokerAdmin && (
            <TabsContent value="broker" className="space-y-6 mt-6">
              {/* C-5 Operating Snapshot */}
              <Card className="border-border">
                <CardHeader className="border-b border-border pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    Operating Snapshot
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {loading ? (
                    <div className="p-4 grid grid-cols-3 gap-3">
                      {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-16 rounded-lg" />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 divide-x divide-border">
                      <SnapshotTile
                        label="Active Agents"
                        value={data?.activeAgentCount ?? 0}
                        href="/dashboard/team"
                      />
                      <SnapshotTile
                        label="Open Transactions"
                        value={data?.openTransactionCount ?? 0}
                        href="/dashboard/transactions"
                      />
                      <SnapshotTile
                        label="New Leads Today"
                        value={data?.newLeadsToday ?? 0}
                        href="/leads"
                        highlight
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Stuck Work Detector */}
              <div id="stuck-work" className="space-y-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                  <h2 className="text-base font-semibold text-foreground">Stuck Work Detector</h2>
                  {stuckTotal > 0 && (
                    <Badge variant="destructive" className="ml-1">
                      {stuckTotal} items
                    </Badge>
                  )}
                </div>

                {/* Stale qualified leads */}
                <StuckSection
                  title="Qualified Leads — Unassigned 48h+"
                  icon={Users}
                  items={data?.staleQualifiedLeads ?? []}
                  loading={loading}
                  renderItem={(lead) => (
                    <div key={lead.id} className="flex items-center justify-between px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {lead.first_name} {lead.last_name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Score {lead.lead_score ?? "—"} · {lead.source ?? "unknown source"} ·{" "}
                          {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                        </p>
                      </div>
                      <Link href="/leads">
                        <Button size="sm" variant="outline" className="shrink-0 h-8">
                          Assign
                        </Button>
                      </Link>
                    </div>
                  )}
                />

                {/* Accepted offers with no transaction */}
                <StuckSection
                  title="Accepted Offers — No Transaction Created"
                  icon={CheckCircle2}
                  items={data?.acceptedOffersNoTx ?? []}
                  loading={loading}
                  renderItem={(offer) => (
                    <div key={offer.id} className="flex items-center justify-between px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {offer.listing?.address ?? "Unknown property"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ${Number(offer.offer_price).toLocaleString()} ·{" "}
                          {formatDistanceToNow(new Date(offer.updated_at), { addSuffix: true })}
                        </p>
                      </div>
                      <Link href="/dashboard/transactions">
                        <Button size="sm" variant="outline" className="shrink-0 h-8">
                          Create Tx
                        </Button>
                      </Link>
                    </div>
                  )}
                />

                {/* Transactions with no update >5d */}
                <StuckSection
                  title="Transactions — No Update in 5+ Days"
                  icon={FileText}
                  items={data?.stuckTransactions ?? []}
                  loading={loading}
                  renderItem={(tx) => (
                    <div key={tx.id} className="flex items-center justify-between px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {tx.deal_name ?? tx.property_address ?? "Transaction"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {tx.stage ?? tx.status} · Last updated{" "}
                          {formatDistanceToNow(new Date(tx.updated_at), { addSuffix: true })}
                        </p>
                      </div>
                      <Link href={`/dashboard/transactions/${tx.id}`}>
                        <Button size="sm" variant="outline" className="shrink-0 h-8">
                          View
                        </Button>
                      </Link>
                    </div>
                  )}
                />

                {/* Listings in prep >14d */}
                <StuckSection
                  title="Listings in Prep — 14+ Days"
                  icon={Home}
                  items={data?.stuckListings ?? []}
                  loading={loading}
                  renderItem={(listing) => (
                    <div key={listing.id} className="flex items-center justify-between px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {listing.address ?? "Unknown address"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Stage: {listing.current_stage} · In prep since{" "}
                          {listing.stage_entered_at
                            ? formatDistanceToNow(new Date(listing.stage_entered_at), { addSuffix: true })
                            : "unknown"}
                        </p>
                      </div>
                      <Link href={`/dashboard/listings/${listing.id}`}>
                        <Button size="sm" variant="outline" className="shrink-0 h-8">
                          View
                        </Button>
                      </Link>
                    </div>
                  )}
                />

                {stuckTotal === 0 && !loading && (
                  <Card className="border-border">
                    <CardContent className="py-10 text-center">
                      <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-3" />
                      <p className="text-sm font-medium text-foreground">No stuck work detected</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        All pipelines are moving normally.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatTile({
  icon: Icon,
  label,
  value,
  href,
  accent,
  urgent,
}: {
  icon: any
  label: string
  value: number
  href: string
  accent: "blue" | "indigo" | "amber" | "red"
  urgent?: boolean
}) {
  const colors: Record<string, string> = {
    blue: "text-blue-600 bg-blue-50",
    indigo: "text-indigo-600 bg-indigo-50",
    amber: "text-amber-600 bg-amber-50",
    red: "text-red-600 bg-red-50",
  }
  return (
    <Link href={href}>
      <Card
        className={`border-border hover:shadow-md transition-all cursor-pointer ${
          urgent && value > 0 ? "ring-1 ring-red-400" : ""
        }`}
      >
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-muted-foreground leading-tight text-balance">{label}</p>
              <p className="text-2xl font-bold text-foreground mt-1">{value}</p>
            </div>
            <div className={`p-2 rounded-lg shrink-0 ${colors[accent]}`}>
              <Icon className="h-4 w-4" />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

function SnapshotTile({
  label,
  value,
  href,
  highlight,
}: {
  label: string
  value: number
  href: string
  highlight?: boolean
}) {
  return (
    <Link href={href}>
      <div className="p-4 sm:p-6 text-center hover:bg-accent transition-colors cursor-pointer">
        <p
          className={`text-2xl sm:text-3xl font-bold ${
            highlight ? "text-primary" : "text-foreground"
          }`}
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground mt-1 text-balance">{label}</p>
      </div>
    </Link>
  )
}

function SectionCard({
  title,
  icon: Icon,
  count,
  href,
  loading,
  urgentCount,
  children,
}: {
  title: string
  icon: any
  count: number
  href: string
  loading: boolean
  urgentCount?: number
  children: React.ReactNode
}) {
  return (
    <Card className="border-border">
      <CardHeader className="border-b border-border pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="h-4 w-4 text-primary" />
            {title}
          </CardTitle>
          <div className="flex items-center gap-2">
            {!loading && count > 0 && (
              <Badge variant={urgentCount && urgentCount > 0 ? "destructive" : "secondary"}>
                {count}
              </Badge>
            )}
            <Link href={href}>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                View all
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-4 space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-12 rounded" />
            ))}
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}

function StuckSection({
  title,
  icon: Icon,
  items,
  loading,
  renderItem,
}: {
  title: string
  icon: any
  items: any[]
  loading: boolean
  renderItem: (item: any) => React.ReactNode
}) {
  if (!loading && items.length === 0) return null
  return (
    <Card className="border-border">
      <CardHeader className="border-b border-border pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="h-4 w-4 text-amber-600" />
            {title}
          </CardTitle>
          {!loading && items.length > 0 && (
            <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
              {items.length}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-4 space-y-3">
            {[...Array(2)].map((_, i) => (
              <Skeleton key={i} className="h-12 rounded" />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border">{items.map(renderItem)}</div>
        )}
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    confirmed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    completed: "bg-slate-50 text-slate-600 border-slate-200",
    cancelled: "bg-red-50 text-red-700 border-red-200",
  }
  return (
    <Badge variant="outline" className={`text-xs ${map[status] ?? "bg-slate-50 text-slate-600"}`}>
      {status}
    </Badge>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
