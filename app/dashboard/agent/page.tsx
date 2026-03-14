"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ApprovalsBanner } from "@/components/ApprovalsBanner"
import {
  TrendingUp,
  Users,
  DollarSign,
  CheckCircle2,
  Calendar,
  Phone,
  Mail,
  Home,
  Clock,
  Target,
  AlertCircle,
  ArrowRight,
  Sparkles,
  Video,
  Palette,
  Zap,
} from "lucide-react"
import { getAgentStats } from "@/app/actions/agents"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface AgentStats {
  activeListings: number
  pendingOffers: number
  closingsThisMonth: number
  totalVolume: number
  activeClients: number
  upcomingShowings: number
  pendingTasks: number
  unreadMessages: number
}

interface ActionItem {
  id: string
  type: "call" | "showing" | "followup" | "task"
  title: string
  time?: string
  priority: "high" | "medium" | "low"
  contact?: string
}

export default function AgentDashboard() {
  const [stats, setStats] = useState<AgentStats>({
    activeListings: 0,
    pendingOffers: 0,
    closingsThisMonth: 0,
    totalVolume: 0,
    activeClients: 0,
    upcomingShowings: 0,
    pendingTasks: 0,
    unreadMessages: 0,
  })
  const [loading, setLoading] = useState(true)
  const [actionItems, setActionItems] = useState<ActionItem[]>([])

  useEffect(() => {
    const fetchDashboardData = async () => {
      setLoading(true)
      try {
        // Get current user ID from Supabase auth
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        
        if (!user?.id) {
          console.warn("[v0] No authenticated user found for agent dashboard")
          setLoading(false)
          return
        }

        const agentStats = await getAgentStats(user.id)
        
        if (agentStats && typeof agentStats === 'object') {
          setStats({
            activeListings: agentStats.activeDeals || 0,
            pendingOffers: 0,
            closingsThisMonth: 0,
            totalVolume: agentStats.ytdVolume || 0,
            activeClients: agentStats.contactCount || 0,
            upcomingShowings: 0,
            pendingTasks: agentStats.pendingTasks || 0,
            unreadMessages: 0,
          })
        }

        // Mock action items for today
        setActionItems([
          {
            id: "1",
            type: "call",
            title: "Follow up with Sarah Johnson",
            time: "10:00 AM",
            priority: "high",
            contact: "Sarah Johnson",
          },
          {
            id: "2",
            type: "showing",
            title: "Property showing at 123 Main St",
            time: "2:00 PM",
            priority: "high",
            contact: "Mike Chen",
          },
          {
            id: "3",
            type: "followup",
            title: "Send CMA to potential seller",
            time: "4:30 PM",
            priority: "medium",
            contact: "David Martinez",
          },
          {
            id: "4",
            type: "task",
            title: "Review and approve marketing materials",
            priority: "medium",
          },
        ])
      } catch (error) {
        console.error("[v0] Error fetching dashboard data:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchDashboardData()
  }, [])

  const statCards = [
    {
      title: "Active Listings",
      value: stats.activeListings,
      icon: Home,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
      change: "+2 this week",
    },
    {
      title: "Active Clients",
      value: stats.activeClients,
      icon: Users,
      color: "text-emerald-600",
      bgColor: "bg-emerald-50",
      change: "+5 this month",
    },
    {
      title: "Pending Offers",
      value: stats.pendingOffers,
      icon: Target,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
      change: "2 need review",
    },
    {
      title: "Volume (MTD)",
      value: `$${(stats.totalVolume / 1000000).toFixed(1)}M`,
      icon: DollarSign,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
      change: "+18% vs last month",
    },
    {
      title: "Closings This Month",
      value: stats.closingsThisMonth,
      icon: CheckCircle2,
      color: "text-green-600",
      bgColor: "bg-green-50",
      change: "3 in next 7 days",
    },
    {
      title: "Upcoming Showings",
      value: stats.upcomingShowings,
      icon: Calendar,
      color: "text-indigo-600",
      bgColor: "bg-indigo-50",
      change: "Next: Today 2pm",
    },
  ]

  const getActionIcon = (type: ActionItem["type"]) => {
    switch (type) {
      case "call":
        return Phone
      case "showing":
        return Home
      case "followup":
        return Mail
      case "task":
        return CheckCircle2
      default:
        return Clock
    }
  }

  const getPriorityColor = (priority: ActionItem["priority"]) => {
    switch (priority) {
      case "high":
        return "bg-red-100 text-red-700 border-red-200"
      case "medium":
        return "bg-amber-100 text-amber-700 border-amber-200"
      case "low":
        return "bg-slate-100 text-slate-700 border-slate-200"
      default:
        return "bg-slate-100 text-slate-700 border-slate-200"
    }
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Agent Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Welcome back! Here's what's happening today.
            </p>
          </div>
          <div className="flex items-center gap-3">
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

        {/* Approvals Banner - Prominent Position */}
        <ApprovalsBanner />

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? (
            <>
              {[...Array(6)].map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <CardContent className="p-6">
                    <div className="h-20 bg-muted rounded" />
                  </CardContent>
                </Card>
              ))}
            </>
          ) : (
            statCards.map((stat, index) => (
              <Card
                key={index}
                className="hover:shadow-lg transition-all cursor-pointer border-border"
              >
                <CardContent className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-muted-foreground mb-1">
                        {stat.title}
                      </p>
                      <p className="text-3xl font-bold text-foreground mb-2">{stat.value}</p>
                      <p className="text-xs text-muted-foreground">{stat.change}</p>
                    </div>
                    <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                      <stat.icon className={`h-6 w-6 ${stat.color}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Today's Action Items */}
          <div className="lg:col-span-2">
            <Card className="border-border">
              <CardHeader className="border-b border-border">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Target className="h-5 w-5 text-primary" />
                    Today's Action Items
                  </CardTitle>
                  <Badge variant="secondary">{actionItems.length} items</Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {loading ? (
                  <div className="p-6 space-y-4">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="h-16 bg-muted rounded animate-pulse" />
                    ))}
                  </div>
                ) : actionItems.length === 0 ? (
                  <div className="p-12 text-center">
                    <CheckCircle2 className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                    <p className="text-foreground font-medium">All caught up!</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      No action items for today
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {actionItems.map((item) => {
                      const Icon = getActionIcon(item.type)
                      return (
                        <div
                          key={item.id}
                          className="p-4 hover:bg-accent transition-colors cursor-pointer group"
                        >
                          <div className="flex items-center gap-4">
                            <div className="p-2 bg-muted rounded-lg group-hover:bg-background">
                              <Icon className="h-5 w-5 text-muted-foreground" />
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="font-medium text-foreground">{item.title}</p>
                                <Badge
                                  variant="outline"
                                  className={`text-xs ${getPriorityColor(item.priority)}`}
                                >
                                  {item.priority}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                                {item.time && (
                                  <span className="flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    {item.time}
                                  </span>
                                )}
                                {item.contact && <span>{item.contact}</span>}
                              </div>
                            </div>
                            <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100">
                              <ArrowRight className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Quick Actions & Alerts */}
          <div className="space-y-6">
            {/* Quick Actions */}
            <Card className="border-border">
              <CardHeader className="border-b border-border">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Quick Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                <Link href="/dashboard/videos/create">
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                    <Video className="h-4 w-4 mr-2" />
                    Create Video
                  </Button>
                </Link>
                <Link href="/dashboard/marketing/studio">
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                    <Palette className="h-4 w-4 mr-2" />
                    Marketing Studio
                  </Button>
                </Link>
                <Link href="/leads">
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                    <Zap className="h-4 w-4 mr-2" />
                    View Leads
                  </Button>
                </Link>
                <Link href="/dashboard/financials/agent">
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                    <DollarSign className="h-4 w-4 mr-2" />
                    My Financials
                  </Button>
                </Link>
                <Link href="/listings/new">
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                    <Home className="h-4 w-4 mr-2" />
                    Add New Listing
                  </Button>
                </Link>
                <Link href="/contacts/new">
                  <Button variant="outline" className="w-full justify-start bg-transparent" size="sm">
                    <Users className="h-4 w-4 mr-2" />
                    Add New Contact
                  </Button>
                </Link>
              </CardContent>
            </Card>

            {/* Alerts & Notifications */}
            <Card className="border-border">
              <CardHeader className="border-b border-border">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertCircle className="h-4 w-4 text-amber-600" />
                  Alerts
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm font-medium text-amber-900">2 offers expiring soon</p>
                  <p className="text-xs text-amber-700 mt-1">Review before end of day</p>
                </div>
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm font-medium text-blue-900">New lead assigned</p>
                  <p className="text-xs text-blue-700 mt-1">Contact within 15 minutes</p>
                </div>
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <p className="text-sm font-medium text-emerald-900">
                    Compliance docs ready
                  </p>
                  <p className="text-xs text-emerald-700 mt-1">3 listings need review</p>
                </div>
              </CardContent>
            </Card>

            {/* Performance Snapshot */}
            <Card className="border-border">
              <CardHeader className="border-b border-border">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  This Month
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Showings</span>
                  <span className="text-sm font-semibold text-foreground">24</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Offers Submitted</span>
                  <span className="text-sm font-semibold text-foreground">8</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">New Clients</span>
                  <span className="text-sm font-semibold text-foreground">5</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Closings</span>
                  <span className="text-sm font-semibold text-foreground">
                    {stats.closingsThisMonth}
                  </span>
                </div>
                <div className="pt-3 border-t border-border">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-foreground">Total Volume</span>
                    <span className="text-lg font-bold text-primary">
                      ${(stats.totalVolume / 1000000).toFixed(2)}M
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Additional Stats Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="border-border">
            <CardContent className="p-4 text-center">
              <Mail className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
              <p className="text-2xl font-bold text-foreground">{stats.unreadMessages}</p>
              <p className="text-xs text-muted-foreground mt-1">Unread Messages</p>
            </CardContent>
          </Card>
          <Card className="border-border">
            <CardContent className="p-4 text-center">
              <CheckCircle2 className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
              <p className="text-2xl font-bold text-foreground">{stats.pendingTasks}</p>
              <p className="text-xs text-muted-foreground mt-1">Pending Tasks</p>
            </CardContent>
          </Card>
          <Card className="border-border">
            <CardContent className="p-4 text-center">
              <Phone className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
              <p className="text-2xl font-bold text-foreground">12</p>
              <p className="text-xs text-muted-foreground mt-1">Calls Scheduled</p>
            </CardContent>
          </Card>
          <Card className="border-border">
            <CardContent className="p-4 text-center">
              <TrendingUp className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
              <p className="text-2xl font-bold text-foreground">94%</p>
              <p className="text-xs text-muted-foreground mt-1">Response Rate</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
