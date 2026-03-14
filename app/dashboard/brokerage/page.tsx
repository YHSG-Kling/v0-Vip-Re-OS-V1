import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getBrokerageDashboard, forecastBrokerageRevenue, trackLicenseExpirations } from "@/app/actions/multi-persona"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import {
  Building2,
  Users,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  Shield,
  FileText,
  Calendar,
  Map,
  Heart,
  Sparkles,
  Network,
  Activity,
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { BrokerageAgentList } from "@/components/brokerage/agent-list"
import { BrokerageRevenueChart } from "@/components/brokerage/revenue-chart"
import { BrokerageComplianceOverview } from "@/components/brokerage/compliance-overview"

export default async function BrokerageDashboard({
  searchParams,
}: {
  searchParams: Promise<{ brokerageId?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  let brokerageId = params.brokerageId
  if (!brokerageId) {
    const { data: brokerage } = await supabase.from("brokerages").select("id").eq("owner_id", user.id).single()
    brokerageId = brokerage?.id
  }

  if (!brokerageId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No brokerage found. Please contact support.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const [dashboard, forecast, licenseStatus] = await Promise.all([
    getBrokerageDashboard(brokerageId),
    forecastBrokerageRevenue(brokerageId, 3),
    trackLicenseExpirations(brokerageId),
  ])

  const { agents, activeTransactions, complianceRate, totalGCI, pendingCommissions } = dashboard

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Brokerage Dashboard</h1>
          <p className="text-muted-foreground">Overview of your brokerage operations</p>
        </div>
        {licenseStatus.expiringLicenses.length > 0 && (
          <Badge variant="destructive" className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {licenseStatus.expiringLicenses.length} License(s) Expiring
          </Badge>
        )}
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Active Agents
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{agents?.length || 0}</div>
            <p className="text-xs text-muted-foreground">Licensed agents</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Transactions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{activeTransactions}</div>
            <p className="text-xs text-muted-foreground">Active deals</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              YTD GCI
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">${((totalGCI || 0) / 1000).toFixed(0)}K</div>
            <p className="text-xs text-muted-foreground">Gross commission</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Compliance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{complianceRate?.toFixed(0) || 0}%</div>
            <Progress value={complianceRate || 0} className="mt-2 h-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Forecast (90d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${((forecast?.likely || 0) / 1000).toFixed(0)}K</div>
            <p className="text-xs text-muted-foreground">Projected revenue</p>
          </CardContent>
        </Card>
      </div>

      {/* License Alerts */}
      {(licenseStatus.expiringLicenses.length > 0 || licenseStatus.expiredLicenses.length > 0) && (
        <Card className="border-orange-200 bg-orange-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 text-orange-800">
              <AlertTriangle className="h-5 w-5" />
              License Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-6 text-sm">
              {licenseStatus.expiredLicenses.length > 0 && (
                <div className="text-red-700">
                  <span className="font-bold">{licenseStatus.expiredLicenses.length}</span> Expired
                </div>
              )}
              {licenseStatus.expiringLicenses.length > 0 && (
                <div className="text-orange-700">
                  <span className="font-bold">{licenseStatus.expiringLicenses.length}</span> Expiring within 60 days
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quick Actions</CardTitle>
          <CardDescription>Intelligence & monitoring tools</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Link href="/dashboard/brokerage/deal-health">
            <Button variant="outline" className="w-full h-auto flex-col py-4 gap-2">
              <Activity className="h-5 w-5" />
              <span className="text-xs">Deal Health</span>
            </Button>
          </Link>
          <Link href="/dashboard/team-heatmap">
            <Button variant="outline" className="w-full h-auto flex-col py-4 gap-2">
              <Map className="h-5 w-5" />
              <span className="text-xs">Team Heatmap</span>
            </Button>
          </Link>
          <Link href="/dashboard/brokerage/fatigue">
            <Button variant="outline" className="w-full h-auto flex-col py-4 gap-2">
              <Heart className="h-5 w-5" />
              <span className="text-xs">Agent Fatigue</span>
            </Button>
          </Link>
          <Link href="/dashboard/recruiting-roi">
            <Button variant="outline" className="w-full h-auto flex-col py-4 gap-2">
              <TrendingUp className="h-5 w-5" />
              <span className="text-xs">Recruiting ROI</span>
            </Button>
          </Link>
          <Link href="/dashboard/ai-quality">
            <Button variant="outline" className="w-full h-auto flex-col py-4 gap-2">
              <Sparkles className="h-5 w-5" />
              <span className="text-xs">AI Quality</span>
            </Button>
          </Link>
          <Link href="/dashboard/coordination">
            <Button variant="outline" className="w-full h-auto flex-col py-4 gap-2">
              <Network className="h-5 w-5" />
              <span className="text-xs">AI Coordination</span>
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Main Content Tabs */}
      <Tabs defaultValue="agents" className="space-y-4">
        <TabsList>
          <TabsTrigger value="agents">Agents ({agents?.length || 0})</TabsTrigger>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
        </TabsList>

        <TabsContent value="agents">
          <BrokerageAgentList agents={agents || []} brokerageId={brokerageId} />
        </TabsContent>

        <TabsContent value="revenue">
          <BrokerageRevenueChart forecast={forecast} totalGCI={totalGCI || 0} pendingCommissions={pendingCommissions || 0} />
        </TabsContent>

        <TabsContent value="compliance">
          <BrokerageComplianceOverview brokerageId={brokerageId} complianceRate={complianceRate || 0} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
