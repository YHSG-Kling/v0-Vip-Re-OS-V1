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
import { Link as LinkIcon, Building2, Users, FileText, Target, TrendingUp, AlertCircle } from 'lucide-react'
import Link from 'next/link'

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
}

export function AdminDashboardClient({ brokerageId }: AdminDashboardClientProps) {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    const loadStats = async () => {
      try {
        setLoading(true)
        const result = await getAdminDashboardStats(brokerageId)
        if (result.success && result.stats) {
          setStats(result.stats)
          setError(null)
        } else {
          setError(result.error || 'Failed to load dashboard stats')
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

        {/* OS Command Strip */}
        <AdminCommandStrip brokerageId={brokerageId} stats={stats} />

        {/* OS Panels - First Row (3 columns) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <AdminOperationsRadar brokerageId={brokerageId} stats={stats} />
          <OnboardingOperationsPanel brokerageId={brokerageId} stats={stats} />
          <AssignmentRulesPanel brokerageId={brokerageId} stats={stats} />
        </div>

        {/* OS Panels - Second Row (3 columns) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <ProviderIntelligencePanel brokerageId={brokerageId} stats={stats} />
          <SlaMonitorPanel brokerageId={brokerageId} stats={stats} />
          <FormsImportPanel brokerageId={brokerageId} stats={stats} />
        </div>

        {/* OS Panels - Third Row (3 columns) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <KnowledgeOpsPanel brokerageId={brokerageId} stats={stats} />
          <FarmIntelligencePanel brokerageId={brokerageId} stats={stats} />
          
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
                <Link href="/dashboard/admin/analytics">
                  <Button size="sm" variant="outline" className="w-full">
                    View Analytics
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Existing Tabs - Preserved for backward compatibility */}
        <Tabs defaultValue="overview" className="space-y-4 mt-8">
          <TabsList className="grid w-full grid-cols-5 lg:w-1/3">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="transactions">Deals</TabsTrigger>
            <TabsTrigger value="listings">Listings</TabsTrigger>
            <TabsTrigger value="leads">Leads</TabsTrigger>
          </TabsList>

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
