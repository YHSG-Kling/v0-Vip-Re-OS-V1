import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TrendingUp, Clock, Users, DollarSign, Target } from "lucide-react"
import {
  getRecruitingROISummary,
  getRecruitROIByRecruit,
  getRecruitingCostBreakdown,
  getBreakEvenAnalysis,
  getRecruitingAnalyticsByYear,
} from "@/app/actions/recruiting-roi"
import { YearlyRevenueChart } from "./yearly-revenue-chart"
import { BreakEvenChart } from "./breakeven-chart"
import { LTVScatterChart } from "./ltv-scatter-chart"
import { RecruitROITable } from "./recruit-roi-table"
import { CostEntryPanel } from "./cost-entry-panel"
import { RecruitingPipelineClient } from "./recruiting-pipeline-client"
import { RecruitingPitchPanel } from "./recruiting-pitch-panel"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

export default async function RecruitingROIPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Check RBAC — user_type is canonical; role is legacy fallback
  const resolvedType = profile?.user_type ?? profile?.role ?? ""
  if (!isAdminOrBroker({ user_type: resolvedType })) {
    redirect("/dashboard")
  }

  // Fetch all data in parallel
  const [
    roiSummary,
    recruitROIs,
    costBreakdown,
    breakEvenAnalysis,
    yearlyAnalytics,
  ] = await Promise.all([
    getRecruitingROISummary(profile.brokerage_id),
    getRecruitROIByRecruit(profile.brokerage_id),
    getRecruitingCostBreakdown(profile.brokerage_id),
    getBreakEvenAnalysis(profile.brokerage_id),
    getRecruitingAnalyticsByYear(profile.brokerage_id, "").catch(() => []),
  ])

  const totalInvested = roiSummary?.totalInvested || 0
  const totalGenerated = roiSummary?.totalGenerated || 0
  const avgROI = roiSummary?.avgROI || 0
  const avgBreakEven = breakEvenAnalysis?.avgBreakEvenMonth || 0
  const activeRecruits = roiSummary?.activeRecruits || 0
  const profitableRecruits = roiSummary?.profitableRecruits || 0

  // Recruit pipeline rows (stage advance / provision live here now — the old
  // /admin/recruiting-hub was retired into this canonical recruiting surface).
  const { data: recruitRows } = await supabase
    .from("recruits")
    .select("*")
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(100)

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Recruiting ROI</h1>
        <p className="text-muted-foreground mt-1">
          Track recruiting costs, monitor agent profitability, and optimize hiring strategy
        </p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Total Invested
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(totalInvested / 100).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">All-time recruiting spend</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Generated Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">${(totalGenerated / 100).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Brokerage net from recruits</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Target className="h-4 w-4" />
              ROI
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${avgROI > 100 ? 'text-green-600' : avgROI > 0 ? 'text-blue-600' : 'text-red-600'}`}>
              {avgROI.toFixed(0)}%
            </div>
            <p className="text-xs text-muted-foreground">Average return</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Avg Breakeven
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgBreakEven.toFixed(1)}</div>
            <p className="text-xs text-muted-foreground">Months to breakeven</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Active Recruits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeRecruits}</div>
            <p className="text-xs text-muted-foreground">Currently employed</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Profitable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{profitableRecruits}</div>
            <p className="text-xs text-muted-foreground">Positive ROI</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="analysis" className="space-y-6">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="cohorts">By Recruit</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
        </TabsList>

        {/* Tab 1: Analysis */}
        <TabsContent value="pipeline" className="space-y-4">
          {/* The pitch is the top of this funnel: it is what the public careers page
              says and what the Recruiting Manager's outreach one-pager is built from.
              It had no editor anywhere in the app until now — see
              app/actions/settings/recruiting-pitch.ts. */}
          <RecruitingPitchPanel />
          <RecruitingPipelineClient recruits={(recruitRows as any[]) ?? []} brokerageId={profile.brokerage_id} />
        </TabsContent>

        <TabsContent value="analysis" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Revenue by Agent - Year 1-3</CardTitle>
                <CardDescription>Gross commission generated in each year post-hire</CardDescription>
              </CardHeader>
              <CardContent>
                <YearlyRevenueChart data={yearlyAnalytics} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>LTV vs Acquisition Cost</CardTitle>
                <CardDescription>Lifetime value against recruitment investment</CardDescription>
              </CardHeader>
              <CardContent>
                <LTVScatterChart data={recruitROIs} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 2: Timeline */}
        <TabsContent value="timeline" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Breakeven Timeline</CardTitle>
              <CardDescription>Average months to reach profitability by hire cohort</CardDescription>
            </CardHeader>
            <CardContent>
              <BreakEvenChart data={breakEvenAnalysis} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: By Recruit */}
        <TabsContent value="cohorts" className="space-y-4">
          <RecruitROITable data={recruitROIs || []} />
        </TabsContent>

        {/* Tab 4: Cost Management */}
        <TabsContent value="costs" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Cost Breakdown</CardTitle>
                  <CardDescription>Recruiting expenses by category</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {costBreakdown && Object.entries(costBreakdown).map(([costType, amount]) => (
                      <div key={costType} className="flex justify-between items-center p-3 border rounded-lg">
                        <div>
                          <p className="font-medium capitalize">{costType.replace("_", " ")}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold">${((amount as number) / 100).toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground">
                            {totalInvested > 0 ? (((amount as number) / totalInvested) * 100).toFixed(0) : 0}% of total
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <CostEntryPanel brokerageId={profile.brokerage_id} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
