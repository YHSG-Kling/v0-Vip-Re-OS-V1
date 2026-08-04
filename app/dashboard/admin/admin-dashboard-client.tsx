'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getAdminDashboardStats } from '@/app/actions/admin/get-admin-stats'
import {
  AdminCommandStrip,
  AdminOperationsRadar,
  OnboardingOperationsPanel,
  AssignmentRulesPanel,
  ProviderIntelligencePanel,
  SlaMonitorPanel,
  FormsImportPanel,
  KnowledgeOpsPanel,
  FarmIntelligencePanel,
} from './components/os'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Link as LinkIcon,
  Building2,
  Users,
  FileText,
  Target,
  TrendingUp,
  AlertCircle,
  BrainCircuit,
  Rocket,
  RefreshCw,
  DollarSign,
  Megaphone,
  Plug,
  ArrowRight,
  LifeBuoy,
  BarChart3,
  Database,
  GitMerge,
} from 'lucide-react'
import Link from 'next/link'
import type { OperationalSnapshot } from './page'

// Helper function for currency formatting
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

interface AdminDashboardClientProps {
  brokerageId: string
  operationalSnapshot?: OperationalSnapshot
  /**
   * Resolved SERVER-side from requirePlatformCapability('sentinel').
   * Domain Coherence is platform governance data, so a tenant admin/broker must
   * not be shown an entry point they will only be refused at.
   */
  canReadDomainCoherence?: boolean
}

// ── Operational health card config ────────────────────────────────────────────
type HealthStatus = 'green' | 'amber' | 'red'

function resolveStatus(value: number, thresholds: { amber: number; red: number }): HealthStatus {
  if (value >= thresholds.red)   return 'red'
  if (value >= thresholds.amber) return 'amber'
  return 'green'
}

const STATUS_STYLES: Record<HealthStatus, { card: string; badge: string; dot: string }> = {
  green: { card: 'border-green-200  bg-green-50/40',  badge: 'bg-green-100  text-green-800',  dot: 'bg-green-500' },
  amber: { card: 'border-amber-200  bg-amber-50/40',  badge: 'bg-amber-100  text-amber-800',  dot: 'bg-amber-500' },
  red:   { card: 'border-red-200    bg-red-50/40',    badge: 'bg-red-100    text-red-800',     dot: 'bg-red-500'   },
}

export function AdminDashboardClient({ brokerageId, operationalSnapshot, canReadDomainCoherence = false }: AdminDashboardClientProps) {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    const loadStats = async () => {
      try {
        setLoading(true)
        const result = await getAdminDashboardStats()
        if (result) {
          setStats(result)
          setError(null)
        } else {
          setError('Failed to load dashboard stats')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadStats()
  }, [brokerageId])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="min-h-screen bg-background p-6">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error Loading Dashboard</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{error || 'Unable to load dashboard statistics'}</p>
            <Button onClick={() => router.refresh()} className="mt-4">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="space-y-6 p-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-foreground">Brokerage Command Center</h1>
          <p className="text-muted-foreground mt-1">
            Real-time operations intelligence and management dashboard
          </p>
        </div>

        {/* ── Operational Health Grid ──────────────────────────────────────── */}
        {operationalSnapshot && (() => {
          const snap = operationalSnapshot
          const degraded = snap.degradedProviders

          const cards = [
            {
              label:    'AI-ISA Active Leads',
              value:    snap.aiIsaActiveLeads,
              href:     '/dashboard/isa',
              icon:     BrainCircuit,
              status:   snap.aiIsaActiveLeads > 0 ? 'green' : 'amber',
              hint:     snap.aiIsaActiveLeads > 0 ? 'AI pipeline active' : 'No active AI-ISA leads',
            },
            {
              label:    'Listings Ready to Launch',
              value:    snap.listingsReadyToLaunch,
              href:     '/dashboard/listings',
              icon:     Rocket,
              status:   resolveStatus(snap.listingsReadyToLaunch, { amber: 1, red: 10 }),
              hint:     snap.listingsReadyToLaunch > 0 ? 'Awaiting launch' : 'Nothing queued',
            },
            {
              label:    'Stalled Transactions',
              value:    snap.transactionsStalled,
              href:     '/dashboard/transactions',
              icon:     RefreshCw,
              status:   resolveStatus(snap.transactionsStalled, { amber: 1, red: 5 }),
              hint:     snap.transactionsStalled > 0 ? 'No update in 7+ days' : 'All deals moving',
            },
            {
              label:    'Pending Commissions',
              value:    snap.pendingCommissions,
              href:     '/dashboard/financials',
              icon:     DollarSign,
              status:   resolveStatus(snap.pendingCommissions, { amber: 1, red: 10 }),
              hint:     snap.pendingCommissions > 0 ? 'Distributions unpaid' : 'Fully disbursed',
            },
            {
              label:    'Failed Publishes',
              value:    snap.failedPublishes,
              href:     '/dashboard/marketing/studio?tab=ops',
              icon:     Megaphone,
              status:   resolveStatus(snap.failedPublishes, { amber: 1, red: 5 }),
              hint:     snap.failedPublishes > 0 ? 'Social posts failed' : 'All posts published',
            },
            {
              label:    'Degraded Providers',
              value:    degraded.length,
              href:     '/settings/integrations',
              icon:     Plug,
              status:   degraded.length > 0 ? 'red' : 'green',
              hint:     degraded.length > 0 ? degraded.join(', ') : 'All providers healthy',
            },
          ] as const

          return (
            <div className="space-y-3">
              {/* Degraded provider alert strip */}
              {degraded.length > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
                  <span className="font-medium">Degraded integrations:</span>
                  <span className="truncate">{degraded.join(', ')}</span>
                  <Link
                    href="/settings/integrations"
                    className="ml-auto flex shrink-0 items-center gap-1 font-semibold underline underline-offset-2 hover:opacity-80"
                  >
                    Fix now <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              )}

              {/* Metric card grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {cards.map(({ label, value, href, icon: Icon, status, hint }) => {
                  const s = STATUS_STYLES[status as HealthStatus]
                  return (
                    <Link key={label} href={href} className="group">
                      <div className={`relative flex flex-col gap-2 rounded-lg border p-4 transition-shadow hover:shadow-md ${s.card}`}>
                        <div className="flex items-center justify-between">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <span className={`h-2 w-2 rounded-full ${s.dot}`} />
                        </div>
                        <p className="text-2xl font-bold tabular-nums text-foreground">{value}</p>
                        <div>
                          <p className="text-xs font-medium text-foreground leading-snug">{label}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground leading-snug line-clamp-1">{hint}</p>
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {/* OS Command Strip */}
        <AdminCommandStrip brokerageId={brokerageId} />

        {/* Brokerage administration quick links — Users, Support, Income, Usage, Recruiting */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[
            { label: 'Users & Roles',      hint: 'Invite, edit roles, deactivate',        href: '/dashboard/admin/users',           icon: Users },
            { label: 'Support Tickets',    hint: 'Triage & reply to your agents',         href: '/dashboard/admin/support-tickets', icon: LifeBuoy },
            { label: 'Financial Reports',  hint: 'Income reporting & report history',     href: '/dashboard/financials/reports',    icon: FileText },
            { label: 'Brokerage P&L',      hint: 'Profit & loss statement',               href: '/dashboard/financials/brokerage',   icon: DollarSign },
            { label: 'Usage',              hint: 'Platform usage across the brokerage',   href: '/dashboard/admin/usage',           icon: BarChart3 },
            { label: 'Recruiting',         hint: 'Pipeline & recruiting ROI',             href: '/dashboard/recruiting-roi',        icon: Target },
          ].map(({ label, hint, href, icon: Icon }) => (
            <Link key={href} href={href}>
              <Card className="h-full border-foreground/10 bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer">
                <CardContent className="p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold leading-snug">{label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground leading-snug line-clamp-2">{hint}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        {/* OS Panels - First Row (3 columns) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <AdminOperationsRadar brokerageId={brokerageId} />
          <OnboardingOperationsPanel brokerageId={brokerageId} stats={stats} />
          <AssignmentRulesPanel brokerageId={brokerageId} />
        </div>

        {/* OS Panels - Second Row (3 columns) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <ProviderIntelligencePanel brokerageId={brokerageId} stats={stats} />
          <SlaMonitorPanel brokerageId={brokerageId} stats={stats} />
          <FormsImportPanel brokerageId={brokerageId} />
        </div>

        {/* OS Panels - Third Row (3 columns) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <KnowledgeOpsPanel brokerageId={brokerageId} />
          <FarmIntelligencePanel brokerageId={brokerageId} />
          
          {/* Quick Stats Card */}
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Key Metrics
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Broker Health Score</span>
                <Badge variant="secondary" className="bg-emerald-50 text-emerald-700">
                  {Math.round((stats.activeAgents / stats.totalAgents) * 100)}%
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Avg Transaction Value</span>
                <span className="text-sm font-semibold text-foreground">
                  {formatCurrency(stats.monthlyVolume / Math.max(stats.totalTransactions, 1))}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Lead to Deal Rate</span>
                <Badge variant="secondary" className="bg-blue-50 text-blue-700">
                  {stats.conversionRate}%
                </Badge>
              </div>
              <div className="pt-3 border-t border-border">
                <Link href="/dashboard/analytics">
                  <Button size="sm" variant="outline" className="w-full">
                    View Analytics
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Acquisition Funnel CTA */}
        <Link href="/dashboard/analytics/source">
          <Card className="border-foreground/10 bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer">
            <CardContent className="py-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Database className="h-5 w-5 text-foreground shrink-0" />
                <div>
                  <p className="text-sm font-semibold">Acquisition Funnel &amp; Source Analytics</p>
                  <p className="text-xs text-muted-foreground">
                    Track raw, lead, and direct-contact source performance — ROI, conversion, and attribution
                  </p>
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </CardContent>
          </Card>
        </Link>

        {/* Domain Coherence CTA — platform staff only (the page and the server
            actions behind it both gate on the 'sentinel' platform capability). */}
        {canReadDomainCoherence && (
        <Link href="/dashboard/admin/domain-coherence">
          <Card className="border-foreground/10 bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer">
            <CardContent className="py-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <GitMerge className="h-5 w-5 text-foreground shrink-0" />
                <div>
                  <p className="text-sm font-semibold">Domain Coherence &amp; Route Audit</p>
                  <p className="text-xs text-muted-foreground">
                    Classify route ownership, detect duplicate surfaces, validate kernel contracts, preview role-based navigation
                  </p>
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </CardContent>
          </Card>
        </Link>
        )}

        {/* Existing Tabs - Preserved for backward compatibility */}
        <Tabs defaultValue="overview" className="space-y-4 mt-8">
          <div className="overflow-x-auto">
            <TabsList className="flex min-w-max sm:grid sm:w-full sm:grid-cols-5 lg:w-1/3">
              <TabsTrigger value="overview" className="min-h-[44px] sm:min-h-0 min-w-[90px] sm:min-w-0">Overview</TabsTrigger>
              <TabsTrigger value="agents" className="min-h-[44px] sm:min-h-0 min-w-[80px] sm:min-w-0">Agents</TabsTrigger>
              <TabsTrigger value="transactions" className="min-h-[44px] sm:min-h-0 min-w-[80px] sm:min-w-0">Deals</TabsTrigger>
              <TabsTrigger value="listings" className="min-h-[44px] sm:min-h-0 min-w-[85px] sm:min-w-0">Listings</TabsTrigger>
              <TabsTrigger value="leads" className="min-h-[44px] sm:min-h-0 min-w-[75px] sm:min-w-0">Leads</TabsTrigger>
            </TabsList>
          </div>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6 mt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats.totalAgents}</p>
                  <p className="text-sm text-muted-foreground">Total Agents</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-emerald-600">{stats.totalTransactions}</p>
                  <p className="text-sm text-muted-foreground">Active Deals</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-blue-600">{stats.activeListings}</p>
                  <p className="text-sm text-muted-foreground">Active Listings</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-purple-600">{formatCurrency(stats.monthlyVolume)}</p>
                  <p className="text-sm text-muted-foreground">Monthly Volume</p>
                </CardContent>
              </Card>
            </div>

            {/* Top Agents */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-border">
                <CardHeader>
                  <CardTitle className="text-lg">Top Agents by Volume</CardTitle>
                  <CardDescription>This month</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {stats.topAgentsByVolume && stats.topAgentsByVolume.length > 0 ? (
                    stats.topAgentsByVolume.slice(0, 5).map((agent: any, index: number) => (
                      <div key={agent.id || index} className="flex items-center gap-3">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                          index === 0 ? 'bg-yellow-100 text-yellow-700' :
                          index === 1 ? 'bg-gray-100 text-gray-700' :
                          index === 2 ? 'bg-orange-100 text-orange-700' :
                          'bg-muted text-muted-foreground'
                        }`}>
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{agent.name}</p>
                          <p className="text-xs text-muted-foreground">{agent.transactions} deals</p>
                        </div>
                        <p className="text-sm font-semibold text-foreground">{formatCurrency(agent.volume)}</p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">No data available</p>
                  )}
                </CardContent>
              </Card>

              <Card className="border-border">
                <CardHeader>
                  <CardTitle className="text-lg">Top Agents by Deals</CardTitle>
                  <CardDescription>Active transactions</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {stats.topAgentsByDeals && stats.topAgentsByDeals.length > 0 ? (
                    stats.topAgentsByDeals.slice(0, 5).map((agent: any, index: number) => (
                      <div key={agent.id || index} className="flex items-center gap-3">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                          index === 0 ? 'bg-yellow-100 text-yellow-700' :
                          index === 1 ? 'bg-gray-100 text-gray-700' :
                          index === 2 ? 'bg-orange-100 text-orange-700' :
                          'bg-muted text-muted-foreground'
                        }`}>
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{agent.name}</p>
                          <p className="text-xs text-muted-foreground">{agent.transactions} deals</p>
                        </div>
                        <p className="text-sm font-semibold text-foreground">{formatCurrency(agent.volume)}</p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">No data available</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Agents Tab */}
          <TabsContent value="agents" className="space-y-6 mt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats.totalAgents}</p>
                  <p className="text-sm text-muted-foreground">Total Agents</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-emerald-600">{stats.activeAgents}</p>
                  <p className="text-sm text-muted-foreground">Active</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-blue-600">{stats.pendingOnboarding}</p>
                  <p className="text-sm text-muted-foreground">Onboarding</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-purple-600">{stats.newAgentsThisMonth}</p>
                  <p className="text-sm text-muted-foreground">New This Month</p>
                </CardContent>
              </Card>
            </div>
            <Card className="border-border">
              <CardContent className="p-8 text-center">
                <Link href="/settings/users">
                  <Button>
                    <Users className="h-4 w-4 mr-2" />
                    Manage Agents
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Transactions Tab */}
          <TabsContent value="transactions" className="space-y-6 mt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats.totalTransactions}</p>
                  <p className="text-sm text-muted-foreground">Total Active</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-amber-600">{stats.pendingTransactions}</p>
                  <p className="text-sm text-muted-foreground">Pending</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-emerald-600">{stats.closedThisMonth}</p>
                  <p className="text-sm text-muted-foreground">Closed This Month</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{formatCurrency(stats.monthlyVolume)}</p>
                  <p className="text-sm text-muted-foreground">Monthly Volume</p>
                </CardContent>
              </Card>
            </div>
            <Card className="border-border">
              <CardContent className="p-8 text-center">
                <Link href="/dashboard/transactions">
                  <Button>
                    <FileText className="h-4 w-4 mr-2" />
                    View All Transactions
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Listings Tab */}
          <TabsContent value="listings" className="space-y-6 mt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats.activeListings}</p>
                  <p className="text-sm text-muted-foreground">Active Listings</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-blue-600">{stats.newListingsThisMonth}</p>
                  <p className="text-sm text-muted-foreground">New This Month</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-amber-600">{stats.pendingListings}</p>
                  <p className="text-sm text-muted-foreground">Pending</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-red-600">{stats.expiringListings}</p>
                  <p className="text-sm text-muted-foreground">Expiring Soon</p>
                </CardContent>
              </Card>
            </div>
            <Card className="border-border">
              <CardContent className="p-8 text-center">
                <Link href="/dashboard/listings">
                  <Button>
                    <Building2 className="h-4 w-4 mr-2" />
                    View All Listings
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Leads Tab */}
          <TabsContent value="leads" className="space-y-6 mt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-foreground">{stats.totalLeads}</p>
                  <p className="text-sm text-muted-foreground">Total Leads</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-blue-600">{stats.newLeadsThisWeek}</p>
                  <p className="text-sm text-muted-foreground">New This Week</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-red-600">{stats.hotLeads}</p>
                  <p className="text-sm text-muted-foreground">Hot Leads</p>
                </CardContent>
              </Card>
              <Card className="border-border">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-emerald-600">{stats.conversionRate}%</p>
                  <p className="text-sm text-muted-foreground">Conversion Rate</p>
                </CardContent>
              </Card>
            </div>
            <Card className="border-border">
              <CardContent className="p-8 text-center">
                <Link href="/leads">
                  <Button>
                    <Target className="h-4 w-4 mr-2" />
                    View All Leads
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
