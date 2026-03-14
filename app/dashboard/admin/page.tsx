"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ApprovalsBanner } from "@/components/ApprovalsBanner"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Users,
  Building2,
  TrendingUp,
  DollarSign,
  FileText,
  CheckCircle2,
  AlertCircle,
  Clock,
  BarChart3,
  Settings,
  UserPlus,
  Activity,
  Loader2,
  Home,
  MessageSquare,
  Calendar,
  Target,
  Award,
  Phone,
  Mail,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  Eye,
  Bell,
  Video,
  Zap,
  GitBranch,
  CreditCard,
} from "lucide-react"
import { useAuth } from "@/lib/auth/client"
import Link from "next/link"
import { getAdminDashboardStats } from "@/app/actions/admin/get-admin-stats"

interface AdminStats {
  // Agent metrics
  totalAgents: number
  activeAgents: number
  pendingOnboarding: number
  newAgentsThisMonth: number
  // Transaction metrics
  totalTransactions: number
  pendingTransactions: number
  closedThisMonth: number
  monthlyVolume: number
  ytdVolume: number
  avgDaysToClose: number
  // Listing metrics
  activeListings: number
  newListingsThisMonth: number
  pendingListings: number
  expiringListings: number
  // Lead metrics
  totalLeads: number
  newLeadsThisWeek: number
  hotLeads: number
  conversionRate: number
  // Compliance & approvals
  pendingApprovals: number
  complianceAlerts: number
  documentsAwaitingReview: number
  // Activity metrics
  tasksOverdue: number
  upcomingDeadlines: number
  unreadMessages: number
  scheduledShowings: number
  // Recent activity
  recentActivities: Array<{
    id: string
    type: string
    title: string
    subtitle: string
    time: string
    color: string
  }>
  // Top performers
  topAgents: Array<{
    id: string
    name: string
    transactions: number
    volume: number
  }>
}

export default function AdminDashboardPage() {
  const { userContext } = useAuth()
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState("overview")

  useEffect(() => {
    const fetchAdminStats = async () => {
      setLoading(true)
      try {
        const data = await getAdminDashboardStats()
        setStats(data)
      } catch (error) {
        console.error("[v0] Error fetching admin stats:", error)
        // Set default stats on error
        setStats({
          totalAgents: 0,
          activeAgents: 0,
          pendingOnboarding: 0,
          newAgentsThisMonth: 0,
          totalTransactions: 0,
          pendingTransactions: 0,
          closedThisMonth: 0,
          monthlyVolume: 0,
          ytdVolume: 0,
          avgDaysToClose: 0,
          activeListings: 0,
          newListingsThisMonth: 0,
          pendingListings: 0,
          expiringListings: 0,
          totalLeads: 0,
          newLeadsThisWeek: 0,
          hotLeads: 0,
          conversionRate: 0,
          pendingApprovals: 0,
          complianceAlerts: 0,
          documentsAwaitingReview: 0,
          tasksOverdue: 0,
          upcomingDeadlines: 0,
          unreadMessages: 0,
          scheduledShowings: 0,
          recentActivities: [],
          topAgents: [],
        })
      } finally {
        setLoading(false)
      }
    }

    fetchAdminStats()
  }, [])

  if (loading || !stats) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const formatCurrency = (amount: number) => {
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`
    if (amount >= 1000) return `$${(amount / 1000).toFixed(0)}K`
    return `$${amount.toFixed(0)}`
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Admin Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Complete brokerage overview and management
            </p>
          </div>
          <div className="flex items-center gap-3">
            {stats.complianceAlerts > 0 && (
              <Badge variant="destructive" className="px-3 py-1">
                <AlertCircle className="h-3 w-3 mr-1" />
                {stats.complianceAlerts} Alerts
              </Badge>
            )}
            <Badge variant="outline" className="px-3 py-1">
              <Clock className="h-3 w-3 mr-1" />
              {new Date().toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </Badge>
          </div>
        </div>

        {/* Approvals Banner */}
        <ApprovalsBanner />

        {/* Tabs for different views */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-5 lg:w-auto lg:grid-cols-none lg:inline-flex">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="listings">Listings</TabsTrigger>
            <TabsTrigger value="leads">Leads</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6 mt-6">
            {/* Key Metrics Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Monthly Volume</p>
                      <p className="text-2xl font-bold text-foreground">{formatCurrency(stats.monthlyVolume)}</p>
                      <p className="text-xs text-emerald-600 flex items-center mt-1">
                        <ArrowUpRight className="h-3 w-3 mr-1" />
                        YTD: {formatCurrency(stats.ytdVolume)}
                      </p>
                    </div>
                    <div className="p-2 bg-emerald-50 rounded-lg">
                      <DollarSign className="h-5 w-5 text-emerald-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Active Agents</p>
                      <p className="text-2xl font-bold text-foreground">{stats.activeAgents}</p>
                      <p className="text-xs text-blue-600 flex items-center mt-1">
                        <UserPlus className="h-3 w-3 mr-1" />
                        +{stats.newAgentsThisMonth} this month
                      </p>
                    </div>
                    <div className="p-2 bg-blue-50 rounded-lg">
                      <Users className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Active Listings</p>
                      <p className="text-2xl font-bold text-foreground">{stats.activeListings}</p>
                      <p className="text-xs text-purple-600 flex items-center mt-1">
                        <Home className="h-3 w-3 mr-1" />
                        +{stats.newListingsThisMonth} this month
                      </p>
                    </div>
                    <div className="p-2 bg-purple-50 rounded-lg">
                      <Building2 className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Closed This Month</p>
                      <p className="text-2xl font-bold text-foreground">{stats.closedThisMonth}</p>
                      <p className="text-xs text-indigo-600 flex items-center mt-1">
                        <Clock className="h-3 w-3 mr-1" />
                        Avg {stats.avgDaysToClose} days
                      </p>
                    </div>
                    <div className="p-2 bg-indigo-50 rounded-lg">
                      <CheckCircle2 className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Attention Required Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Link href="/dashboard/admin/approvals">
                <Card className={`border-border hover:shadow-md transition-all cursor-pointer ${stats.pendingApprovals > 0 ? 'border-amber-300 bg-amber-50/50' : ''}`}>
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="p-2 bg-amber-100 rounded-lg">
                      <Eye className="h-5 w-5 text-amber-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-foreground">Pending Approvals</p>
                      <p className="text-2xl font-bold text-amber-600">{stats.pendingApprovals}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>

              <Link href="/dashboard/admin/compliance">
                <Card className={`border-border hover:shadow-md transition-all cursor-pointer ${stats.complianceAlerts > 0 ? 'border-red-300 bg-red-50/50' : ''}`}>
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="p-2 bg-red-100 rounded-lg">
                      <AlertCircle className="h-5 w-5 text-red-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-foreground">Compliance Alerts</p>
                      <p className="text-2xl font-bold text-red-600">{stats.complianceAlerts}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>

              <Link href="/dashboard/tasks">
                <Card className={`border-border hover:shadow-md transition-all cursor-pointer ${stats.tasksOverdue > 0 ? 'border-orange-300 bg-orange-50/50' : ''}`}>
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="p-2 bg-orange-100 rounded-lg">
                      <Clock className="h-5 w-5 text-orange-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-foreground">Tasks Overdue</p>
                      <p className="text-2xl font-bold text-orange-600">{stats.tasksOverdue}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>

              <Link href="/dashboard/admin/onboarding">
                <Card className={`border-border hover:shadow-md transition-all cursor-pointer ${stats.pendingOnboarding > 0 ? 'border-blue-300 bg-blue-50/50' : ''}`}>
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="p-2 bg-blue-100 rounded-lg">
                      <UserPlus className="h-5 w-5 text-blue-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-foreground">Pending Onboarding</p>
                      <p className="text-2xl font-bold text-blue-600">{stats.pendingOnboarding}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            </div>

            {/* Two Column Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Quick Actions & Activity */}
              <div className="lg:col-span-2 space-y-6">
                {/* Quick Stats Row */}
                <Card className="border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Quick Stats</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="text-center p-3 bg-muted/50 rounded-lg">
                      <p className="text-2xl font-bold text-foreground">{stats.totalLeads}</p>
                      <p className="text-xs text-muted-foreground">Total Leads</p>
                    </div>
                    <div className="text-center p-3 bg-muted/50 rounded-lg">
                      <p className="text-2xl font-bold text-foreground">{stats.hotLeads}</p>
                      <p className="text-xs text-muted-foreground">Hot Leads</p>
                    </div>
                    <div className="text-center p-3 bg-muted/50 rounded-lg">
                      <p className="text-2xl font-bold text-foreground">{stats.scheduledShowings}</p>
                      <p className="text-xs text-muted-foreground">Scheduled Showings</p>
                    </div>
                    <div className="text-center p-3 bg-muted/50 rounded-lg">
                      <p className="text-2xl font-bold text-foreground">{stats.conversionRate}%</p>
                      <p className="text-xs text-muted-foreground">Conversion Rate</p>
                    </div>
                  </CardContent>
                </Card>

                {/* Recent Activity */}
                <Card className="border-border">
                  <CardHeader className="border-b border-border">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Activity className="h-4 w-4 text-primary" />
                      Recent Activity
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-3 max-h-80 overflow-y-auto">
                    {stats.recentActivities.length > 0 ? (
                      stats.recentActivities.map((activity) => (
                        <div
                          key={activity.id}
                          className={`p-3 bg-${activity.color}-50 border border-${activity.color}-200 rounded-lg`}
                        >
                          <p className={`text-sm font-medium text-${activity.color}-900`}>{activity.title}</p>
                          <p className={`text-xs text-${activity.color}-700 mt-1`}>{activity.subtitle} - {activity.time}</p>
                        </div>
                      ))
                    ) : (
                      <>
                        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                          <p className="text-sm font-medium text-emerald-900">System Active</p>
                          <p className="text-xs text-emerald-700 mt-1">All systems operational</p>
                        </div>
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                          <p className="text-sm font-medium text-blue-900">Ready for Business</p>
                          <p className="text-xs text-blue-700 mt-1">Brokerage dashboard loaded successfully</p>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Right Sidebar */}
              <div className="space-y-6">
                {/* Quick Actions */}
                <Card className="border-border">
                  <CardHeader className="border-b border-border">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Target className="h-4 w-4 text-primary" />
                      Quick Actions
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-2">
                    <Link href="/leads">
                      <Button variant="outline" className="w-full justify-start" size="sm">
                        <Zap className="h-4 w-4 mr-2" />
                        Lead Intelligence
                      </Button>
                    </Link>
                    <Link href="/dashboard/admin/assignment-rules">
                      <Button variant="outline" className="w-full justify-start" size="sm">
                        <GitBranch className="h-4 w-4 mr-2" />
                        Assignment Rules
                      </Button>
                    </Link>
                    <Link href="/dashboard/financials/team">
                      <Button variant="outline" className="w-full justify-start" size="sm">
                        <DollarSign className="h-4 w-4 mr-2" />
                        Team Financials
                      </Button>
                    </Link>
                    <Link href="/dashboard/videos/analytics">
                      <Button variant="outline" className="w-full justify-start" size="sm">
                        <Video className="h-4 w-4 mr-2" />
                        Video Analytics
                      </Button>
                    </Link>
                    <Link href="/admin/usage">
                      <Button variant="outline" className="w-full justify-start" size="sm">
                        <Activity className="h-4 w-4 mr-2" />
                        Usage Metrics
                      </Button>
                    </Link>
                    <Link href="/dashboard/admin/onboarding">
                      <Button variant="outline" className="w-full justify-start" size="sm">
                        <UserPlus className="h-4 w-4 mr-2" />
                        Agent Onboarding
                      </Button>
                    </Link>
                  </CardContent>
                </Card>

                {/* Top Performers */}
                <Card className="border-border">
                  <CardHeader className="border-b border-border">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Award className="h-4 w-4 text-primary" />
                      Top Performers
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-3">
                    {stats.topAgents.length > 0 ? (
                      stats.topAgents.slice(0, 5).map((agent, index) => (
                        <div key={agent.id} className="flex items-center gap-3">
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
