"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import useSWR, { mutate } from "swr"
import { 
  ArrowLeft, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts"
import { DealHealthRing } from "@/components/deal-health/DealHealthRing"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

interface HealthScore {
  id: string
  transaction_id: string
  overall_score: number
  risk_level: string
  score_components: Record<string, number>
  flags: string[]
  ai_narrative: string | null
  previous_score: number | null
  score_delta: number | null
  scored_at: string
}

interface HealthComponent {
  id: string
  component_category: string
  component_name: string
  points_earned: number
  points_possible: number
  pass: boolean
  detail: string | null
  scored_at: string
}

interface HealthSnapshot {
  id: string
  score: number
  risk_level: string
  factors: Record<string, unknown> | null
  created_at: string
}

interface HealthFactor {
  id: string
  factor_type: string
  factor_value: number
  risk_contribution: number
  detail: string | null
  scored_at: string
}

interface Intervention {
  id: string
  issue_detected: string
  severity: string
  ai_recommendation: string | null
  resolved: boolean
  resolved_at: string | null
  resolved_by: string | null
  client_impacted: boolean
  created_at: string
}

interface Transaction {
  id: string
  deal_name: string | null
  property_address: string | null
  stage: string | null
}

const fetcher = async (key: string) => {
  const supabase = createClient()
  const [, transactionId] = key.split("/")
  
  // Fetch all data in parallel
  const [
    transactionRes,
    healthScoreRes,
    componentsRes,
    snapshotsRes,
    factorsRes,
    interventionsRes,
  ] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, deal_name, property_address, stage")
      .eq("id", transactionId)
      .single(),
    supabase
      .from("deal_health_scores")
      .select("*")
      .eq("transaction_id", transactionId)
      .order("scored_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("deal_health_components")
      .select("*")
      .eq("transaction_id", transactionId)
      .order("scored_at", { ascending: false }),
    supabase
      .from("deal_health_snapshots")
      .select("*")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: true }),
    supabase
      .from("deal_health_factors")
      .select("*")
      .eq("transaction_id", transactionId)
      .order("scored_at", { ascending: false }),
    supabase
      .from("proactive_interventions")
      .select("*")
      .eq("transaction_id", transactionId)
      .eq("resolved", false)
      .order("created_at", { ascending: false }),
  ])

  return {
    transaction: transactionRes.data as Transaction | null,
    healthScore: healthScoreRes.data as HealthScore | null,
    components: (componentsRes.data || []) as HealthComponent[],
    snapshots: (snapshotsRes.data || []) as HealthSnapshot[],
    factors: (factorsRes.data || []) as HealthFactor[],
    interventions: (interventionsRes.data || []) as Intervention[],
  }
}

function getRiskBadgeVariant(riskLevel: string): "default" | "secondary" | "destructive" | "outline" {
  switch (riskLevel) {
    case "healthy":
      return "default"
    case "watch":
      return "secondary"
    case "at_risk":
    case "critical":
      return "destructive"
    default:
      return "outline"
  }
}

function getSeverityBadgeVariant(severity: string): "default" | "secondary" | "destructive" | "outline" {
  switch (severity) {
    case "critical":
      return "destructive"
    case "high":
      return "destructive"
    case "medium":
      return "secondary"
    default:
      return "outline"
  }
}

export default function TransactionHealthPage() {
  const params = useParams()
  const router = useRouter()
  const transactionId = params.id as string
  const [isRescanning, setIsRescanning] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const { data, error, isLoading } = useSWR(
    transactionId ? `health/${transactionId}` : null,
    fetcher,
    { refreshInterval: 30000 }
  )

  const handleRescan = async () => {
    setIsRescanning(true)
    try {
      const response = await fetch("/api/cron/deal-health-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id: transactionId }),
      })

      if (!response.ok) {
        throw new Error("Failed to trigger rescan")
      }

      toast.success("Health score recalculated")
      mutate(`health/${transactionId}`)
    } catch (err) {
      toast.error("Failed to rescan deal health")
    } finally {
      setIsRescanning(false)
    }
  }

  const handleResolveIntervention = async (interventionId: string) => {
    setResolvingId(interventionId)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()

      const { error: updateError } = await supabase
        .from("proactive_interventions")
        .update({
          resolved: true,
          resolved_at: new Date().toISOString(),
          resolved_by: user?.id || null,
        })
        .eq("id", interventionId)

      if (updateError) throw updateError

      toast.success("Intervention marked as resolved")
      mutate(`health/${transactionId}`)
    } catch (err) {
      toast.error("Failed to resolve intervention")
    } finally {
      setResolvingId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64 lg:col-span-2" />
        </div>
      </div>
    )
  }

  if (error || !data?.transaction) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-muted-foreground">
              {error ? "Failed to load health data" : "Transaction not found"}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { transaction, healthScore, components, snapshots, factors, interventions } = data

  // Deduplicate components by category (keep most recent)
  const uniqueComponents = components.reduce((acc, comp) => {
    if (!acc.find(c => c.component_category === comp.component_category)) {
      acc.push(comp)
    }
    return acc
  }, [] as HealthComponent[])

  // Prepare chart data
  const chartData = snapshots.map((s) => ({
    date: new Date(s.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    score: Number(s.score),
  }))

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Deal Health</h1>
            <p className="text-muted-foreground">
              {transaction.property_address || transaction.deal_name || "Transaction"}
            </p>
          </div>
        </div>
        <Button onClick={handleRescan} disabled={isRescanning}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isRescanning ? "animate-spin" : ""}`} />
          Rescan
        </Button>
      </div>

      {/* Main Score Card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Score Overview */}
        <Card>
          <CardHeader className="text-center pb-2">
            <CardTitle>Overall Health Score</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {healthScore ? (
              <>
                <DealHealthRing
                  score={healthScore.overall_score}
                  size={160}
                  showLabel
                />
                <div className="flex items-center gap-2">
                  <Badge variant={getRiskBadgeVariant(healthScore.risk_level)}>
                    {healthScore.risk_level.replace("_", " ").toUpperCase()}
                  </Badge>
                  {healthScore.score_delta !== null && healthScore.score_delta !== 0 && (
                    <div className="flex items-center text-sm">
                      {healthScore.score_delta > 0 ? (
                        <TrendingUp className="h-4 w-4 text-green-500 mr-1" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-red-500 mr-1" />
                      )}
                      <span className={healthScore.score_delta > 0 ? "text-green-500" : "text-red-500"}>
                        {healthScore.score_delta > 0 ? "+" : ""}{healthScore.score_delta}
                      </span>
                    </div>
                  )}
                </div>
                {healthScore.ai_narrative && (
                  <p className="text-sm text-muted-foreground text-center">
                    {healthScore.ai_narrative}
                  </p>
                )}
                {healthScore.flags && healthScore.flags.length > 0 && (
                  <div className="flex flex-wrap gap-1 justify-center">
                    {healthScore.flags.slice(0, 3).map((flag, i) => (
                      <Badge key={i} variant="outline" className="text-xs">
                        {flag}
                      </Badge>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">No health score calculated yet</p>
                <Button onClick={handleRescan} disabled={isRescanning}>
                  Calculate Now
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Timeline Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Score Timeline</CardTitle>
            <CardDescription>Health score history over time</CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length > 1 ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="date" className="text-xs" />
                    <YAxis domain={[0, 100]} className="text-xs" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "var(--radius)",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="score"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={{ fill: "hsl(var(--primary))" }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-64 flex items-center justify-center">
                <p className="text-muted-foreground">
                  Not enough data points for timeline chart
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Component Grid */}
      <Card>
        <CardHeader>
          <CardTitle>Health Components</CardTitle>
          <CardDescription>Breakdown by category (10 components)</CardDescription>
        </CardHeader>
        <CardContent>
          {uniqueComponents.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {uniqueComponents.map((comp) => (
                <div
                  key={comp.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {comp.component_category.replace(/_/g, " ")}
                      </span>
                      {comp.pass ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                    </div>
                    {comp.detail && (
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {comp.detail}
                      </p>
                    )}
                  </div>
                  <div className="text-right ml-4">
                    <div className="font-bold">
                      {comp.points_earned}/{comp.points_possible}
                    </div>
                    <Badge variant={comp.pass ? "default" : "destructive"} className="text-xs">
                      {comp.pass ? "PASS" : "FAIL"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-8">
              No component data available. Click Rescan to calculate.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Active Interventions */}
      {interventions.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              <CardTitle>Active Interventions</CardTitle>
            </div>
            <CardDescription>Issues requiring attention</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {interventions.map((intervention) => (
                <div
                  key={intervention.id}
                  className="flex items-start justify-between p-4 border rounded-lg bg-muted/50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant={getSeverityBadgeVariant(intervention.severity)}>
                        {intervention.severity.toUpperCase()}
                      </Badge>
                      {intervention.client_impacted && (
                        <Badge variant="outline">Client Impacted</Badge>
                      )}
                    </div>
                    <p className="font-medium">{intervention.issue_detected}</p>
                    {intervention.ai_recommendation && (
                      <p className="text-sm text-muted-foreground mt-2">
                        <strong>Recommendation:</strong> {intervention.ai_recommendation}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(intervention.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleResolveIntervention(intervention.id)}
                    disabled={resolvingId === intervention.id}
                  >
                    {resolvingId === intervention.id ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      "Mark Resolved"
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Health Factors Table */}
      {factors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Health Factors</CardTitle>
            <CardDescription>Detailed factor breakdown</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Factor Type</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Risk Contribution</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {factors.slice(0, 10).map((factor) => (
                  <TableRow key={factor.id}>
                    <TableCell className="font-medium">
                      {factor.factor_type.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>{factor.factor_value}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            factor.risk_contribution > 0.5
                              ? "text-red-500"
                              : factor.risk_contribution > 0.25
                              ? "text-yellow-500"
                              : "text-green-500"
                          }
                        >
                          {(factor.risk_contribution * 100).toFixed(0)}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-xs truncate">
                      {factor.detail || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
