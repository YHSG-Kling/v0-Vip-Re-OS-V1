"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ApprovalsBanner } from "@/components/ApprovalsBanner"
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
} from "lucide-react"
import { useAuth } from "@/lib/auth/client"
import Link from "next/link"

interface AdminStats {
  totalAgents: number
  activeAgents: number
  pendingApprovals: number
  totalTransactions: number
  monthlyVolume: number
  complianceAlerts: number
  pendingOnboarding: number
  activeListings: number
}

export default function AdminDashboardPage() {
  const { userContext } = useAuth()
  const [stats, setStats] = useState<AdminStats>({
    totalAgents: 0,
    activeAgents: 0,
    pendingApprovals: 0,
    totalTransactions: 0,
    monthlyVolume: 0,
    complianceAlerts: 0,
    pendingOnboarding: 0,
    activeListings: 0,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchAdminStats = async () => {
      setLoading(true)
      try {
        // TODO: Replace with real API calls
        setStats({
          totalAgents: 45,
          activeAgents: 38,
          pendingApprovals: 7,
          totalTransactions: 124,
          monthlyVolume: 18500000,
          complianceAlerts: 3,
          pendingOnboarding: 4,
          activeListings: 89,
        })
      } catch (error) {
        console.error("[v0] Error fetching admin stats:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchAdminStats()
  }, [])

  const statCards = [
    {
      title: "Total Agents",
      value: stats.totalAgents,
      icon: Users,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
      subtitle: `${stats.activeAgents} active`,
      href: "/settings/users",
    },
    {
      title: "Pending Approvals",
      value: stats.pendingApprovals,
      icon: CheckCircle2,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
      subtitle: "Need review",
      href: "/dashboard/admin/approvals",
    },
    {
      title: "Monthly Volume",
      value: `$${(stats.monthlyVolume / 1000000).toFixed(1)}M`,
      icon: DollarSign,
      color: "text-emerald-600",
      bgColor: "bg-emerald-50",
      subtitle: "+12% vs last month",
      href: "/admin/usage",
    },
    {
      title: "Active Listings",
      value: stats.activeListings,
      icon: Building2,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
      subtitle: "Across all agents",
      href: "/dashboard/listings",
    },
    {
      title: "Transactions",
      value: stats.totalTransactions,
      icon: FileText,
      color: "text-indigo-600",
      bgColor: "bg-indigo-50",
      subtitle: "This month",
      href: "/dashboard/transactions",
    },
    {
      title: "Compliance Alerts",
      value: stats.complianceAlerts,
      icon: AlertCircle,
      color: "text-red-600",
      bgColor: "bg-red-50",
      subtitle: "Require attention",
      href: "/dashboard/admin/compliance",
    },
  ]

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Admin Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Brokerage overview and management
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

        {/* Approvals Banner */}
        <ApprovalsBanner />

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {statCards.map((stat, index) => (
            <Link href={stat.href} key={index}>
              <Card className="hover:shadow-lg transition-all cursor-pointer border-border h-full">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-muted-foreground mb-1">
                        {stat.title}
                      </p>
                      <p className="text-3xl font-bold text-foreground mb-2">{stat.value}</p>
                      <p className="text-xs text-muted-foreground">{stat.subtitle}</p>
                    </div>
                    <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                      <stat.icon className={`h-6 w-6 ${stat.color}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Admin Quick Actions */}
          <Card className="border-border">
            <CardHeader className="border-b border-border">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4 text-primary" />
                Quick Actions
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              <Link href="/dashboard/admin/onboarding">
                <Button variant="outline" className="w-full justify-start" size="sm">
                  <UserPlus className="h-4 w-4 mr-2" />
                  Agent Onboarding ({stats.pendingOnboarding} pending)
                </Button>
              </Link>
              <Link href="/dashboard/admin/forms">
                <Button variant="outline" className="w-full justify-start" size="sm">
                  <FileText className="h-4 w-4 mr-2" />
                  Manage Forms
                </Button>
              </Link>
              <Link href="/dashboard/admin/knowledge">
                <Button variant="outline" className="w-full justify-start" size="sm">
                  <BarChart3 className="h-4 w-4 mr-2" />
                  Knowledge Base
                </Button>
              </Link>
              <Link href="/settings">
                <Button variant="outline" className="w-full justify-start" size="sm">
                  <Settings className="h-4 w-4 mr-2" />
                  Brokerage Settings
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card className="border-border">
            <CardHeader className="border-b border-border">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-primary" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                <p className="text-sm font-medium text-emerald-900">New agent registered</p>
                <p className="text-xs text-emerald-700 mt-1">John Smith - 2 hours ago</p>
              </div>
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-sm font-medium text-blue-900">Transaction closed</p>
                <p className="text-xs text-blue-700 mt-1">123 Main St - $450,000</p>
              </div>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm font-medium text-amber-900">Compliance review needed</p>
                <p className="text-xs text-amber-700 mt-1">3 documents pending approval</p>
              </div>
              <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
                <p className="text-sm font-medium text-purple-900">New listing added</p>
                <p className="text-xs text-purple-700 mt-1">456 Oak Ave - $675,000</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
