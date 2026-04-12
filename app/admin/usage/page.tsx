import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, AlertCircle, Cpu, Phone, HardDrive, Video, DollarSign, Download, TrendingUp } from "lucide-react"
import { UsageByTypeChart } from "./usage-by-type-chart"
import { UsageTrendsChart } from "./usage-trends-chart"

export const dynamic = "force-dynamic"

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

function formatCurrency(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default async function UsageMeteringDashboard() {
  const supabase = await createClient()

  // Verify auth and role
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  // Role gate: broker + admin + superadmin only
  if (!profile || !["broker", "admin", "superadmin"].includes(profile.user_type ?? "")) {
    redirect("/dashboard")
  }
  // Kernel guard: brokerage_id must be present for all dashboard queries
  if (!profile.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId = profile.brokerage_id
  const now = new Date()
  const currentMonth = now.toISOString().slice(0, 7) // YYYY-MM
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)

  // Fetch all data in parallel
  const [
    usageLogsResult,
    meterReadingsResult,
    costAllocationResult,
    agentUsageResult,
    teamUsageResult,
    featureUsageResult,
    aiToolUsageResult,
    trendDataResult,
    subscriptionResult,
  ] = await Promise.all([
    // Usage logs for current month summary
    supabase
      .from("usage_logs")
      .select("usage_type, units_used, cost_cents")
      .eq("brokerage_id", brokerageId)
      .gte("recorded_at", monthStart.toISOString())
      .lte("recorded_at", monthEnd.toISOString()),

    // Meter readings for current period
    supabase
      .from("meter_readings")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .gte("period_start", monthStart.toISOString())
      .order("computed_at", { ascending: false }),

    // Cost allocation for current month
    supabase
      .from("cost_allocation")
      .select(`
        *,
        agents:agent_id(id, user_id),
        teams:team_id(id, name)
      `)
      .eq("brokerage_id", brokerageId)
      .eq("period_label", currentMonth)
      .order("allocated_cost_cents", { ascending: false }),

    // Usage by agent
    supabase
      .from("usage_logs")
      .select(`
        agent_id,
        usage_type,
        units_used,
        cost_cents,
        agents:agent_id(id, user_id)
      `)
      .eq("brokerage_id", brokerageId)
      .gte("recorded_at", monthStart.toISOString())
      .lte("recorded_at", monthEnd.toISOString()),

    // Team usage from cost_allocation
    supabase
      .from("cost_allocation")
      .select(`
        team_id,
        cost_type,
        allocated_cost_cents,
        teams:team_id(id, name)
      `)
      .eq("brokerage_id", brokerageId)
      .eq("period_label", currentMonth)
      .not("team_id", "is", null),

    // Feature usage tracking
    supabase
      .from("feature_usage_tracking")
      .select("feature_key, usage_count, limit_amount, exceeded")
      .eq("brokerage_id", brokerageId)
      .order("usage_count", { ascending: false })
      .limit(20),

    // AI tool usage
    supabase
      .from("ai_tool_usage")
      .select("tool_name, cost_cents, tokens_used")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", monthStart.toISOString())
      .lte("created_at", monthEnd.toISOString()),

    // Trend data for last 6 months
    supabase
      .from("meter_readings")
      .select("meter_type, total_units, total_cost_cents, period_start")
      .eq("brokerage_id", brokerageId)
      .gte("period_start", new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString())
      .order("period_start", { ascending: true }),

    // Subscription tier limits
    supabase
      .from("subscriptions")
      .select(`
        *,
        subscription_tiers:tier_id(*)
      `)
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .maybeSingle(),
  ])

  const usageLogs = usageLogsResult.data || []
  const meterReadings = meterReadingsResult.data || []
  const costAllocations = costAllocationResult.data || []
  const agentUsage = agentUsageResult.data || []
  const teamUsage = teamUsageResult.data || []
  const featureUsage = featureUsageResult.data || []
  const aiToolUsage = aiToolUsageResult.data || []
  const trendData = trendDataResult.data || []
  const subscription = subscriptionResult.data

  // Calculate KPI summaries
  const aiCallsMTD = usageLogs
    .filter((l: any) => l.usage_type === "ai_call")
    .reduce((sum: number, l: any) => sum + (l.units_used || 0), 0)
  
  const voiceMinutesMTD = usageLogs
    .filter((l: any) => l.usage_type === "voice_call")
    .reduce((sum: number, l: any) => sum + (l.units_used || 0), 0)
  
  const storageMTD = usageLogs
    .filter((l: any) => l.usage_type === "storage")
    .reduce((sum: number, l: any) => sum + (l.units_used || 0), 0)
  
  const totalCostMTD = usageLogs
    .reduce((sum: number, l: any) => sum + (l.cost_cents || 0), 0)

  // Aggregate agent usage
  const agentUsageMap = new Map<string, { ai: number; voice: number; storage: number; cost: number }>()
  agentUsage.forEach((u: any) => {
    const agentId = u.agent_id || "unknown"
    if (!agentUsageMap.has(agentId)) {
      agentUsageMap.set(agentId, { ai: 0, voice: 0, storage: 0, cost: 0 })
    }
    const entry = agentUsageMap.get(agentId)!
    if (u.usage_type === "ai_call") entry.ai += u.units_used || 0
    if (u.usage_type === "voice_call") entry.voice += u.units_used || 0
    if (u.usage_type === "storage") entry.storage += u.units_used || 0
    entry.cost += u.cost_cents || 0
  })

  // Aggregate team usage
  const teamUsageMap = new Map<string, { name: string; cost: number }>()
  teamUsage.forEach((t: any) => {
    const teamId = t.team_id || "unknown"
    const teamName = t.teams?.name || "Unknown Team"
    if (!teamUsageMap.has(teamId)) {
      teamUsageMap.set(teamId, { name: teamName, cost: 0 })
    }
    teamUsageMap.get(teamId)!.cost += t.allocated_cost_cents || 0
  })

  // AI Tool Usage aggregation by tool, model, and brokerage
  const aiToolSummary = new Map<string, { count: number; cost: number; tokens: number }>()
  const aiModelSummary = new Map<string, { count: number; cost: number; tokens: number }>()
  const aiBrokerageSummary = new Map<string, { count: number; cost: number; tokens: number; brokerage_id: string }>()
  
  aiToolUsage.forEach((t: any) => {
    // By tool name
    const tool = t.tool_name || "unknown"
    if (!aiToolSummary.has(tool)) {
      aiToolSummary.set(tool, { count: 0, cost: 0, tokens: 0 })
    }
    const toolEntry = aiToolSummary.get(tool)!
    toolEntry.count++
    toolEntry.cost += t.cost_cents || 0
    toolEntry.tokens += t.tokens_used || 0
    
    // By model used (AI Gateway tracking)
    const model = t.model_used || "unknown"
    if (!aiModelSummary.has(model)) {
      aiModelSummary.set(model, { count: 0, cost: 0, tokens: 0 })
    }
    const modelEntry = aiModelSummary.get(model)!
    modelEntry.count++
    modelEntry.cost += t.cost_cents || 0
    modelEntry.tokens += t.tokens_used || 0
    
    // By brokerage
    const brokId = t.brokerage_id || "unknown"
    if (!aiBrokerageSummary.has(brokId)) {
      aiBrokerageSummary.set(brokId, { count: 0, cost: 0, tokens: 0, brokerage_id: brokId })
    }
    const brokEntry = aiBrokerageSummary.get(brokId)!
    brokEntry.count++
    brokEntry.cost += t.cost_cents || 0
    brokEntry.tokens += t.tokens_used || 0
  })

  // Check threshold alerts
  const tierLimits = subscription?.subscription_tiers?.features || {}
  const aiLimit = tierLimits.ai_calls_limit || 10000
  const storageLimit = tierLimits.storage_limit_bytes || 10737418240 // 10GB default
  const voiceLimit = tierLimits.voice_minutes_limit || 1000
  
  const aiUsagePct = (aiCallsMTD / aiLimit) * 100
  const storageUsagePct = (storageMTD / storageLimit) * 100
  const voiceUsagePct = (voiceMinutesMTD / voiceLimit) * 100

  const alerts: { type: string; severity: "amber" | "red"; message: string }[] = []
  if (aiUsagePct >= 95) alerts.push({ type: "AI Calls", severity: "red", message: `AI calls at ${aiUsagePct.toFixed(0)}% of limit` })
  else if (aiUsagePct >= 80) alerts.push({ type: "AI Calls", severity: "amber", message: `AI calls at ${aiUsagePct.toFixed(0)}% of limit` })
  if (storageUsagePct >= 95) alerts.push({ type: "Storage", severity: "red", message: `Storage at ${storageUsagePct.toFixed(0)}% of limit` })
  else if (storageUsagePct >= 80) alerts.push({ type: "Storage", severity: "amber", message: `Storage at ${storageUsagePct.toFixed(0)}% of limit` })
  if (voiceUsagePct >= 95) alerts.push({ type: "Voice", severity: "red", message: `Voice minutes at ${voiceUsagePct.toFixed(0)}% of limit` })
  else if (voiceUsagePct >= 80) alerts.push({ type: "Voice", severity: "amber", message: `Voice minutes at ${voiceUsagePct.toFixed(0)}% of limit` })

  // Prepare chart data
  const usageByTypeData = [
    { type: "AI Calls", value: aiCallsMTD },
    { type: "Voice Minutes", value: voiceMinutesMTD },
    { type: "Storage (MB)", value: Math.round(storageMTD / (1024 * 1024)) },
  ]

  // Total cost allocation
  const totalCostAllocation = costAllocations.reduce((sum: number, c: any) => sum + (c.allocated_cost_cents || 0), 0)

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Usage Metering</h1>
          <p className="text-muted-foreground">Monitor AI, storage, voice, and service consumption</p>
        </div>
        <Badge variant="outline">{currentMonth}</Badge>
      </div>

      {/* Section 5: Threshold Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 p-4 rounded-lg ${
                alert.severity === "red" 
                  ? "bg-red-50 border border-red-200 text-red-800" 
                  : "bg-amber-50 border border-amber-200 text-amber-800"
              }`}
            >
              {alert.severity === "red" ? (
                <AlertCircle className="h-5 w-5" />
              ) : (
                <AlertTriangle className="h-5 w-5" />
              )}
              <div className="flex-1">
                <p className="font-medium">{alert.message}</p>
                {alert.severity === "red" && (
                  <p className="text-sm mt-1">Consider upgrading your plan to avoid service interruptions.</p>
                )}
              </div>
              {alert.severity === "red" && (
                <Button variant="outline" size="sm">
                  Upgrade Plan
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Section 1: Summary KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              AI Calls MTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{aiCallsMTD.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {aiUsagePct.toFixed(0)}% of {aiLimit.toLocaleString()} limit
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Phone className="h-4 w-4" />
              Voice Minutes MTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{voiceMinutesMTD.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {voiceUsagePct.toFixed(0)}% of {voiceLimit.toLocaleString()} limit
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              Storage Used
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(storageMTD)}</div>
            <p className="text-xs text-muted-foreground">
              {storageUsagePct.toFixed(0)}% of {formatBytes(storageLimit)} limit
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Video className="h-4 w-4" />
              Video Minutes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {meterReadings.find((m: any) => m.meter_type === "video")?.total_units?.toLocaleString() || 0}
            </div>
            <p className="text-xs text-muted-foreground">This period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Total MTD Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalCostMTD)}</div>
            <p className="text-xs text-muted-foreground">All usage types</p>
          </CardContent>
        </Card>
      </div>

      {/* Section 2: Usage Breakdown Tabs */}
      <Card>
        <CardHeader>
          <CardTitle>Usage Breakdown</CardTitle>
          <CardDescription>Analyze usage by type, agent, team, or feature</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="by-type" className="space-y-4">
            <TabsList>
              <TabsTrigger value="by-type">By Type</TabsTrigger>
              <TabsTrigger value="by-agent">Agents</TabsTrigger>
              <TabsTrigger value="by-team">Teams</TabsTrigger>
              <TabsTrigger value="by-feature">By Feature</TabsTrigger>
              <TabsTrigger value="by-brokerage">By Brokerage</TabsTrigger>
            </TabsList>

            <TabsContent value="by-type">
              <UsageByTypeChart data={usageByTypeData} />
            </TabsContent>

            <TabsContent value="by-agent">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">AI Calls</TableHead>
                    <TableHead className="text-right">Voice (min)</TableHead>
                    <TableHead className="text-right">Storage</TableHead>
                    <TableHead className="text-right">Total Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from(agentUsageMap.entries())
                    .sort((a, b) => b[1].cost - a[1].cost)
                    .slice(0, 20)
                    .map(([agentId, data]) => (
                      <TableRow key={agentId}>
                        <TableCell className="font-medium">{agentId.slice(0, 8)}...</TableCell>
                        <TableCell className="text-right">{data.ai.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{data.voice.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{formatBytes(data.storage)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(data.cost)}</TableCell>
                      </TableRow>
                    ))}
                  {agentUsageMap.size === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                        No agent usage data for this period
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="by-team">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Team</TableHead>
                    <TableHead className="text-right">Total Cost</TableHead>
                    <TableHead className="text-right">% of Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from(teamUsageMap.entries())
                    .sort((a, b) => b[1].cost - a[1].cost)
                    .map(([teamId, data]) => (
                      <TableRow key={teamId}>
                        <TableCell className="font-medium">{data.name}</TableCell>
                        <TableCell className="text-right">{formatCurrency(data.cost)}</TableCell>
                        <TableCell className="text-right">
                          {totalCostAllocation > 0
                            ? ((data.cost / totalCostAllocation) * 100).toFixed(1)
                            : 0}%
                        </TableCell>
                      </TableRow>
                    ))}
                  {teamUsageMap.size === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                        No team usage data for this period
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="by-feature">
              <div className="grid md:grid-cols-2 gap-6">
                {/* AI Gateway Model Usage */}
                <div>
                  <h4 className="font-medium mb-3">AI Gateway - By Model</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Calls</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Array.from(aiModelSummary.entries())
                        .sort((a, b) => b[1].cost - a[1].cost)
                        .slice(0, 10)
                        .map(([model, data]) => (
                          <TableRow key={model}>
                            <TableCell className="font-medium text-xs">{model}</TableCell>
                            <TableCell className="text-right">{data.count.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{(data.tokens / 1000).toFixed(1)}K</TableCell>
                            <TableCell className="text-right">{formatCurrency(data.cost)}</TableCell>
                          </TableRow>
                        ))}
                      {aiModelSummary.size === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                            No AI Gateway usage this period
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                
                {/* AI Tool Usage */}
                <div>
                  <h4 className="font-medium mb-3">AI Tool Usage</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tool</TableHead>
                        <TableHead className="text-right">Calls</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Array.from(aiToolSummary.entries())
                        .sort((a, b) => b[1].cost - a[1].cost)
                        .slice(0, 10)
                        .map(([tool, data]) => (
                          <TableRow key={tool}>
                            <TableCell className="font-medium">{tool}</TableCell>
                            <TableCell className="text-right">{data.count.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{formatCurrency(data.cost)}</TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              
              <div className="mt-6 p-4 bg-muted/50 rounded-lg border">
                <h4 className="font-medium mb-2 text-sm">AI Gateway Tracking</h4>
                <p className="text-xs text-muted-foreground">
                  All AI generation calls are automatically tracked through the Vercel AI Gateway. 
                  Costs are calculated based on token usage and model pricing. Model breakdowns show which AI models are being used most frequently across your organization.
                </p>
              </div>
              {/* Feature Usage Tracking */}
              <div className="mt-6">
                <h4 className="font-medium mb-3">Feature Usage</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Feature</TableHead>
                      <TableHead className="text-right">Usage</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {featureUsage.slice(0, 10).map((f: any) => (
                      <TableRow key={f.feature_key}>
                        <TableCell className="font-medium">{f.feature_key}</TableCell>
                        <TableCell className="text-right">
                          {f.usage_count?.toLocaleString()} / {f.limit_amount?.toLocaleString() || "∞"}
                        </TableCell>
                        <TableCell className="text-right">
                          {f.exceeded ? (
                            <Badge variant="destructive">Exceeded</Badge>
                          ) : (
                            <Badge variant="secondary">OK</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {featureUsage.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                          No feature usage data available
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="by-brokerage">
              <div className="space-y-4">
                <h4 className="font-medium">AI Gateway Usage by Brokerage</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Brokerage ID</TableHead>
                      <TableHead className="text-right">AI Calls</TableHead>
                      <TableHead className="text-right">Total Tokens</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Array.from(aiBrokerageSummary.values())
                      .sort((a, b) => b.cost - a.cost)
                      .map((brok) => (
                        <TableRow key={brok.brokerage_id}>
                          <TableCell className="font-mono text-xs">
                            {brok.brokerage_id.slice(0, 8)}...
                          </TableCell>
                          <TableCell className="text-right">
                            {brok.count.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right">
                            {(brok.tokens / 1000).toFixed(1)}K
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {formatCurrency(brok.cost)}
                          </TableCell>
                        </TableRow>
                      ))}
                    {aiBrokerageSummary.size === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                          No AI usage data available for this period
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                
                <div className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    Brokerage AI Usage Insights
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    This breakdown shows AI Gateway usage across all brokerages using the platform. 
                    Each brokerage's AI costs are tracked separately for accurate billing and usage monitoring. 
                    Token counts include both input and output tokens from all AI models (GPT-4, Claude, etc.).
                  </p>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Section 3: Usage Trends Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Usage Trends (6 Months)
          </CardTitle>
          <CardDescription>Monthly usage by type over time</CardDescription>
        </CardHeader>
        <CardContent>
          <UsageTrendsChart data={trendData} />
        </CardContent>
      </Card>

      {/* Section 4: Cost Allocation Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Cost Allocation</CardTitle>
            <CardDescription>Breakdown of costs by agent and team for {currentMonth}</CardDescription>
          </div>
          <form action={`/api/admin/usage/export-csv?month=${currentMonth}&brokerageId=${brokerageId}`} method="GET">
            <Button variant="outline" size="sm" type="submit">
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </form>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent / Team</TableHead>
                <TableHead>Cost Type</TableHead>
                <TableHead className="text-right">Allocated Cost</TableHead>
                <TableHead className="text-right">% of Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {costAllocations.slice(0, 25).map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {c.teams?.name || (c.agent_id ? c.agent_id.slice(0, 8) + "..." : "Unassigned")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.cost_type}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(c.allocated_cost_cents || 0)}</TableCell>
                  <TableCell className="text-right">
                    {totalCostAllocation > 0
                      ? (((c.allocated_cost_cents || 0) / totalCostAllocation) * 100).toFixed(1)
                      : 0}%
                  </TableCell>
                </TableRow>
              ))}
              {costAllocations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    No cost allocation data for this period
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {costAllocations.length > 25 && (
            <p className="text-sm text-muted-foreground mt-4 text-center">
              Showing top 25 of {costAllocations.length} entries. Export CSV for full data.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
