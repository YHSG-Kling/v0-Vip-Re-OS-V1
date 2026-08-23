"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import {
  RefreshCw,
  Plus,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  Home,
  DollarSign,
  BarChart3,
  AlertTriangle,
  Send,
  Sparkles,
  Loader2,
  CheckSquare,
} from "lucide-react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts"
import {
  addMarketSource,
  refreshMarketDataAction,
  generateInsightAction,
  getCurrentInsight,
  getCurrentMarketData,
  getTrendData,
  getRecentCMAReports,
  getSellersInMarket,
  generateMarketUpdateEmail,
} from "@/app/actions/market-insight-actions"
import { predictMarketShift } from "@/app/actions/ai-predictions"
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"

interface MarketInsightsDashboardClientProps {
  brokerageId: string
  agentId: string
  sources: any[]
  initialMarketArea: string
  initialInsight: any
  initialMarketData: any
  initialTrends: any[]
  initialCMAReports: any[]
  /** Territory-marketplace carry (round 40): the zip searched on /pricing at
   *  signup — prefills the Add Market dialog as a suggestion only. */
  suggestedZip?: string | null
}

export function MarketInsightsDashboardClient({
  brokerageId,
  agentId,
  sources: initialSources,
  initialMarketArea,
  initialInsight,
  initialMarketData,
  initialTrends,
  initialCMAReports,
  suggestedZip = null,
}: MarketInsightsDashboardClientProps) {
  const router = useRouter()
  const [sources, setSources] = useState(initialSources)
  const [selectedMarket, setSelectedMarket] = useState(initialMarketArea)
  const [insight, setInsight] = useState(initialInsight)
  const [marketData, setMarketData] = useState(initialMarketData)
  const [trends, setTrends] = useState(initialTrends)
  const [cmaReports, setCmaReports] = useState(initialCMAReports)

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isAddingMarket, setIsAddingMarket] = useState(false)
  const [addMarketOpen, setAddMarketOpen] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [marketPrediction, setMarketPrediction] = useState<any>(null)
  const [isPredicting, setIsPredicting] = useState(false)

  // Share modal state
  const [shareContacts, setShareContacts] = useState<any[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [emailDrafts, setEmailDrafts] = useState<{ subject: string; body: string }[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [generatingEmail, setGeneratingEmail] = useState(false)
  const [sendingDrafts, setSendingDrafts] = useState(false)

  const handleOpenShareModal = async () => {
    setSelectedIds([])
    setEmailDrafts([])
    setShareModalOpen(true)
    setLoadingContacts(true)
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email, contact_type")
        .eq("agent_id", agentId)
        .in("contact_type", ["seller", LIFETIME_CUSTOMER_TYPE, "buyer"])
        .not("email", "is", null)
        .limit(50)
      setShareContacts(data ?? [])
    } catch {
      toast.error("Failed to load contacts")
    } finally {
      setLoadingContacts(false)
    }
  }

  const handleSaveDrafts = async () => {
    if (!emailDrafts[0] || selectedIds.length === 0) return
    setSendingDrafts(true)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error("Not authenticated")
      const rows = selectedIds.map((contactId) => ({
        agent_user_id: user.id,
        brokerage_id: brokerageId,
        contact_id: contactId,
        channel: "email",
        draft_subject: emailDrafts[0].subject,
        draft_body: emailDrafts[0].body,
        status: "pending",
        trigger_event: "market_update_share",
      }))
      const { error } = await supabase.from("ai_message_drafts").insert(rows)
      if (error) throw error
      toast.success(`${selectedIds.length} draft${selectedIds.length !== 1 ? "s" : ""} saved`)
      setShareModalOpen(false)
      router.push("/dashboard/communications/inbox")
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save drafts")
    } finally {
      setSendingDrafts(false)
    }
  }

  // Territory-marketplace prefill: the carried signup zip seeds the dialog as a
  // SUGGESTION — the user still reviews and clicks Add (never auto-created).
  const [newMarket, setNewMarket] = useState({
    marketArea: "",
    city: "",
    state: "",
    zipCode: suggestedZip ?? "",
  })

  const [chartMode, setChartMode] = useState<"price" | "dom" | "inventory">("price")

  // Load data for selected market
  const loadMarketData = useCallback(async (marketArea: string) => {
    const [insightData, mdData, trendData, cmaData] = await Promise.all([
      getCurrentInsight(marketArea),
      getCurrentMarketData(marketArea),
      getTrendData(marketArea),
      getRecentCMAReports(marketArea),
    ])
    setInsight(insightData)
    setMarketData(mdData)
    setTrends(trendData)
    setCmaReports(cmaData)
  }, [])

  const handleMarketChange = async (marketArea: string) => {
    setSelectedMarket(marketArea)
    await loadMarketData(marketArea)
  }

  const handleRefreshData = async () => {
    if (!selectedMarket) return
    setIsRefreshing(true)
    try {
      const result = await refreshMarketDataAction(selectedMarket)
      if (result.success) {
        toast.success(`Market data refreshed via ${result.source}`)
        await loadMarketData(selectedMarket)
      } else {
        toast.error("No data sources available")
      }
    } catch (error) {
      toast.error("Failed to refresh market data")
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleGenerateInsight = async () => {
    if (!selectedMarket) return
    setIsGenerating(true)
    try {
      const result = await generateInsightAction(selectedMarket, true)
      toast.success(result.cached ? "Using cached insight" : "New insight generated")
      await loadMarketData(selectedMarket)
    } catch (error) {
      toast.error("Failed to generate insight")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleAddMarket = async () => {
    if (!newMarket.marketArea) {
      toast.error("Market area is required")
      return
    }
    setIsAddingMarket(true)
    try {
      await addMarketSource(newMarket)
      toast.success("Market added and data refreshed")
      setAddMarketOpen(false)
      setNewMarket({ marketArea: "", city: "", state: "", zipCode: "" })
      router.refresh()
    } catch (error) {
      toast.error("Failed to add market")
    } finally {
      setIsAddingMarket(false)
    }
  }

  // Format trend data for chart
  const chartData = trends
    .slice()
    .reverse()
    .map((t) => ({
      month: t.snapshot_month?.slice(0, 7) || "N/A",
      price: t.median_price || 0,
      dom: t.avg_dom || 0,
      inventory: t.active_inventory || 0,
    }))

  const getTrendIcon = (trend: string) => {
    if (trend === "up" || trend === "increasing") return <TrendingUp className="h-4 w-4" />
    if (trend === "down" || trend === "decreasing") return <TrendingDown className="h-4 w-4" />
    return <Minus className="h-4 w-4" />
  }

  const getMarketTypeBadge = (type: string) => {
    if (type === "seller") {
      return <Badge variant="destructive">Seller&apos;s Market</Badge>
    }
    if (type === "buyer") {
      return <Badge className="bg-blue-500">Buyer&apos;s Market</Badge>
    }
    return <Badge variant="secondary">Balanced Market</Badge>
  }

  if (sources.length === 0) {
    return (
      <div className="container mx-auto py-8">
        <Card className="max-w-lg mx-auto">
          <CardHeader>
            <CardTitle>No Markets Configured</CardTitle>
            <CardDescription>
              Add your first market area to start receiving AI-powered insights.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Dialog open={addMarketOpen} onOpenChange={setAddMarketOpen}>
              <DialogTrigger asChild>
                <Button className="w-full">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Your First Market
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Market Area</DialogTitle>
                  <DialogDescription>
                    Enter the market area details to track.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="marketArea">Market Area Name *</Label>
                    <Input
                      id="marketArea"
                      placeholder="e.g., Downtown Austin"
                      value={newMarket.marketArea}
                      onChange={(e) =>
                        setNewMarket({ ...newMarket, marketArea: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        placeholder="Austin"
                        value={newMarket.city}
                        onChange={(e) =>
                          setNewMarket({ ...newMarket, city: e.target.value })
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="state">State</Label>
                      <Input
                        id="state"
                        placeholder="TX"
                        maxLength={2}
                        value={newMarket.state}
                        onChange={(e) =>
                          setNewMarket({ ...newMarket, state: e.target.value.toUpperCase() })
                        }
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="zipCode">ZIP Code (recommended)</Label>
                    <Input
                      id="zipCode"
                      placeholder="78701"
                      maxLength={5}
                      value={newMarket.zipCode}
                      onChange={(e) =>
                        setNewMarket({ ...newMarket, zipCode: e.target.value })
                      }
                    />
                    {suggestedZip && newMarket.zipCode === suggestedZip && (
                      <p className="text-xs text-muted-foreground">
                        Suggested from signup — the territory you searched on our pricing page.
                        Edit freely; nothing is added until you save.
                      </p>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setAddMarketOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleAddMarket} disabled={isAddingMarket}>
                    {isAddingMarket ? "Adding..." : "Add Market"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Market Insights</h1>
          <p className="text-muted-foreground">
            AI-powered market analysis for your territories
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedMarket} onValueChange={handleMarketChange}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select market" />
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s.id} value={s.market_area}>
                  {s.market_area}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Dialog open={addMarketOpen} onOpenChange={setAddMarketOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="icon">
                <Plus className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Market Area</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label>Market Area Name *</Label>
                  <Input
                    placeholder="e.g., Downtown Austin"
                    value={newMarket.marketArea}
                    onChange={(e) =>
                      setNewMarket({ ...newMarket, marketArea: e.target.value })
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>City</Label>
                    <Input
                      placeholder="Austin"
                      value={newMarket.city}
                      onChange={(e) =>
                        setNewMarket({ ...newMarket, city: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <Label>State</Label>
                    <Input
                      placeholder="TX"
                      maxLength={2}
                      value={newMarket.state}
                      onChange={(e) =>
                        setNewMarket({ ...newMarket, state: e.target.value.toUpperCase() })
                      }
                    />
                  </div>
                </div>
                <div>
                  <Label>ZIP Code</Label>
                  <Input
                    placeholder="78701"
                    maxLength={5}
                    value={newMarket.zipCode}
                    onChange={(e) =>
                      setNewMarket({ ...newMarket, zipCode: e.target.value })
                    }
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddMarketOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAddMarket} disabled={isAddingMarket}>
                  {isAddingMarket ? "Adding..." : "Add Market"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button
            variant="outline"
            onClick={handleRefreshData}
            disabled={isRefreshing}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh Data
          </Button>
        </div>
      </div>

      {/* Last Updated */}
      {marketData?.updated_at && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          Last updated: {new Date(marketData.updated_at).toLocaleString()}
          <Badge variant="outline" className="ml-2">
            {marketData.source_type || "unknown"}
          </Badge>
        </div>
      )}

      {/* Market Snapshot Stats */}
      <div className="grid gap-4 md:grid-cols-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <DollarSign className="h-5 w-5 text-muted-foreground" />
              {marketData?.price_trend_pct_30d !== undefined && (
                <span
                  className={`text-xs ${marketData.price_trend_pct_30d > 0 ? "text-green-600" : marketData.price_trend_pct_30d < 0 ? "text-red-600" : "text-muted-foreground"}`}
                >
                  {marketData.price_trend_pct_30d > 0 ? "+" : ""}
                  {marketData.price_trend_pct_30d?.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="mt-2">
              <p className="text-2xl font-bold">
                ${marketData?.median_sale_price?.toLocaleString() || "—"}
              </p>
              <p className="text-xs text-muted-foreground">Median Price</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <Clock className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-2">
              <p className="text-2xl font-bold">
                {marketData?.avg_days_on_market || "—"}
              </p>
              <p className="text-xs text-muted-foreground">Avg DOM</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <BarChart3 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-2">
              <p className="text-2xl font-bold">
                {marketData?.months_of_inventory?.toFixed(1) || "—"}
              </p>
              <p className="text-xs text-muted-foreground">Months Supply</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-2">
              <p className="text-2xl font-bold">
                {marketData?.list_to_sale_ratio
                  ? (marketData.list_to_sale_ratio * 100).toFixed(1) + "%"
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">List-to-Sale</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <Home className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-2">
              <p className="text-2xl font-bold">
                {marketData?.active_listings || "—"}
              </p>
              <p className="text-xs text-muted-foreground">Active Listings</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <Plus className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-2">
              <p className="text-2xl font-bold">
                {marketData?.new_listings_30d || "—"}
              </p>
              <p className="text-xs text-muted-foreground">New (30d)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* AI Insight Panel */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                AI Market Insight
              </CardTitle>
              {insight && (
                <CardDescription>
                  Generated {new Date(insight.insight_date).toLocaleDateString()}
                </CardDescription>
              )}
            </div>
            <div className="flex items-center gap-2">
              {marketData?.market_type && getMarketTypeBadge(marketData.market_type)}
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateInsight}
                disabled={isGenerating}
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${isGenerating ? "animate-spin" : ""}`}
                />
                Regenerate
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {insight ? (
              <>
                <h3 className="text-xl font-semibold">{insight.headline}</h3>
                <p className="text-muted-foreground">{insight.summary}</p>

                <div className="grid gap-4 sm:grid-cols-2">
                  {/* Buyer Signals */}
                  <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                    <h4 className="font-medium text-green-800 mb-2">
                      Buyer Signals
                    </h4>
                    <ul className="space-y-1">
                      {insight.buyer_indicators?.map((indicator: string, i: number) => (
                        <li key={i} className="text-sm text-green-700 flex items-start gap-2">
                          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-green-500 flex-shrink-0" />
                          {indicator}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Seller Signals */}
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <h4 className="font-medium text-amber-800 mb-2">
                      Seller Signals
                    </h4>
                    <ul className="space-y-1">
                      {insight.seller_indicators?.map((indicator: string, i: number) => (
                        <li key={i} className="text-sm text-amber-700 flex items-start gap-2">
                          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                          {indicator}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {insight.seasonal_pattern && (
                  <p className="text-sm italic text-muted-foreground">
                    {insight.seasonal_pattern}
                  </p>
                )}

                {insight.competition_alert && (
                  <div className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 p-4">
                    <AlertTriangle className="h-5 w-5 text-orange-500 flex-shrink-0" />
                    <div>
                      <h4 className="font-medium text-orange-800">
                        Competition Alert
                      </h4>
                      <p className="text-sm text-orange-700">
                        {insight.competition_alert}
                      </p>
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t">
                  <Button variant="outline"                   onClick={handleOpenShareModal}>
                    <Send className="mr-2 h-4 w-4" />
                    Send to Sellers
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-20 w-full" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Skeleton className="h-32" />
                  <Skeleton className="h-32" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Trend Chart */}
        <Card>
          <CardHeader>
            <CardTitle>6-Month Trends</CardTitle>
            <div className="flex gap-2">
              <Button
                variant={chartMode === "price" ? "default" : "outline"}
                size="sm"
                onClick={() => setChartMode("price")}
              >
                Price
              </Button>
              <Button
                variant={chartMode === "dom" ? "default" : "outline"}
                size="sm"
                onClick={() => setChartMode("dom")}
              >
                DOM
              </Button>
              <Button
                variant={chartMode === "inventory" ? "default" : "outline"}
                size="sm"
                onClick={() => setChartMode("inventory")}
              >
                Inventory
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  {chartMode === "price" && (
                    <Line
                      type="monotone"
                      dataKey="price"
                      stroke="#2563eb"
                      strokeWidth={2}
                      name="Median Price"
                    />
                  )}
                  {chartMode === "dom" && (
                    <Line
                      type="monotone"
                      dataKey="dom"
                      stroke="#16a34a"
                      strokeWidth={2}
                      name="Avg DOM"
                    />
                  )}
                  {chartMode === "inventory" && (
                    <Line
                      type="monotone"
                      dataKey="inventory"
                      stroke="#ea580c"
                      strokeWidth={2}
                      name="Active Listings"
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-64 text-muted-foreground">
                No trend data available
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent CMA Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent CMA Activity</CardTitle>
          <CardDescription>
            This month&apos;s CMA data is informing your market insights
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cmaReports.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Property Address</TableHead>
                  <TableHead className="text-right">Estimated Value</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cmaReports.map((report) => (
                  <TableRow key={report.id}>
                    <TableCell className="font-medium">
                      {report.property_address}
                    </TableCell>
                    <TableCell className="text-right">
                      ${report.estimated_value?.toLocaleString() || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {new Date(report.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-center text-muted-foreground py-8">
              No recent CMA reports for this market area
            </p>
          )}
        </CardContent>
      </Card>

      {/* Market Shift Prediction */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Market Shift Prediction
            </CardTitle>
            <CardDescription>AI-powered 90-day market forecast</CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={isPredicting || !selectedMarket}
            onClick={async () => {
              if (!selectedMarket) return
              setIsPredicting(true)
              try {
                const parts = selectedMarket.split(",").map((s: string) => s.trim())
                const city = parts[0] ?? selectedMarket
                const state = parts[1] ?? ""
                const result = await predictMarketShift({ city, state })
                if (result?.success) setMarketPrediction(result.prediction)
                else toast.error("Prediction failed")
              } catch {
                toast.error("Prediction failed")
              } finally {
                setIsPredicting(false)
              }
            }}
          >
            {isPredicting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1" />
            )}
            Run Prediction
          </Button>
        </CardHeader>
        {marketPrediction && (
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Direction</p>
                <p className="font-semibold capitalize">{marketPrediction.prediction?.direction?.replace(/_/g, " ") ?? "—"}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Confidence</p>
                <p className="font-semibold">{marketPrediction.prediction?.confidence != null ? `${Math.round(marketPrediction.prediction.confidence * 100)}%` : "—"}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Timeframe</p>
                <p className="font-semibold">{marketPrediction.prediction?.timeframe ?? "—"}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Magnitude</p>
                <p className="font-semibold capitalize">{marketPrediction.prediction?.magnitude ?? "—"}</p>
              </div>
            </div>
            {marketPrediction.predictions && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">Median Price (60d)</p>
                  <p className="font-medium">{marketPrediction.predictions.medianPrice60Days ? `$${marketPrediction.predictions.medianPrice60Days.toLocaleString()}` : "—"}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">Price Change</p>
                  <p className="font-medium">{marketPrediction.predictions.priceChange ?? "—"}</p>
                </div>
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">Avg DOM (60d)</p>
                  <p className="font-medium">{marketPrediction.predictions.daysOnMarket60Days ?? "—"} days</p>
                </div>
              </div>
            )}
            {marketPrediction.actionableIntelligence?.forAgents?.length > 0 && (
              <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs space-y-1">
                <p className="font-semibold text-amber-800">Agent Actions</p>
                {marketPrediction.actionableIntelligence.forAgents.map((tip: string, i: number) => (
                  <p key={i} className="text-amber-900">• {tip}</p>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Share Modal — 3-step workflow */}
      <Dialog open={shareModalOpen} onOpenChange={(open) => {
        if (!open) { setSelectedIds([]); setEmailDrafts([]) }
        setShareModalOpen(open)
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send Market Update</DialogTitle>
            <DialogDescription>
              Generate and share a personalized market update with your contacts.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Step 1 — Contact selector */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Step 1 — Select contacts</p>
              {loadingContacts ? (
                <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Loading contacts…</span>
                </div>
              ) : shareContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No contacts with email addresses — add emails in CRM first.
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setSelectedIds(
                          shareContacts
                            .filter((c) => c.contact_type === "seller")
                            .map((c) => c.id)
                        )
                      }
                    >
                      Select All Sellers
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedIds(shareContacts.map((c) => c.id))}
                    >
                      Select All
                    </Button>
                    {selectedIds.length > 0 && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {selectedIds.length} selected
                      </span>
                    )}
                  </div>
                  <ScrollArea className="h-48 rounded-md border border-border">
                    <div className="divide-y divide-border">
                      {shareContacts.map((contact) => (
                        <label
                          key={contact.id}
                          className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40"
                        >
                          <Checkbox
                            checked={selectedIds.includes(contact.id)}
                            onCheckedChange={(checked) =>
                              setSelectedIds((prev) =>
                                checked
                                  ? [...prev, contact.id]
                                  : prev.filter((id) => id !== contact.id)
                              )
                            }
                          />
                          <span className="flex-1 text-sm font-medium">
                            {contact.first_name} {contact.last_name}
                          </span>
                          <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                            {contact.contact_type}
                          </Badge>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {contact.email}
                          </span>
                        </label>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>

            {/* Step 2 — Generate email */}
            {selectedIds.length > 0 && emailDrafts.length === 0 && (
              <div className="space-y-2 pt-2 border-t border-border">
                <p className="text-sm font-medium">Step 2 — Generate email</p>
                <Button
                  onClick={async () => {
                    if (!selectedMarket) {
                      toast.error("Select a market area first")
                      return
                    }
                    setGeneratingEmail(true)
                    try {
                      const result = await generateMarketUpdateEmail(selectedMarket, selectedIds)
                      if (result) {
                        setEmailDrafts([{ subject: result.subject ?? "Market Update", body: result.body ?? "" }])
                      } else {
                        toast.error("No market insight available for this area")
                      }
                    } catch (e: any) {
                      toast.error(e.message ?? "Failed to generate email")
                    } finally {
                      setGeneratingEmail(false)
                    }
                  }}
                  disabled={generatingEmail}
                >
                  {generatingEmail ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-2" />Generating…</>
                  ) : (
                    <><Sparkles className="h-4 w-4 mr-2" />Generate Email</>
                  )}
                </Button>
              </div>
            )}

            {/* Step 3 — Preview and send */}
            {emailDrafts.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-border">
                <p className="text-sm font-medium">Step 3 — Review and save drafts</p>
                <div className="space-y-2">
                  <Label htmlFor="draft-subject" className="text-xs text-muted-foreground">Subject</Label>
                  <Input
                    id="draft-subject"
                    value={emailDrafts[0].subject}
                    onChange={(e) =>
                      setEmailDrafts([{ ...emailDrafts[0], subject: e.target.value }])
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="draft-body" className="text-xs text-muted-foreground">Body</Label>
                  <Textarea
                    id="draft-body"
                    rows={8}
                    value={emailDrafts[0].body}
                    onChange={(e) =>
                      setEmailDrafts([{ ...emailDrafts[0], body: e.target.value }])
                    }
                    className="resize-none font-mono text-xs"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={generatingEmail}
                    onClick={async () => {
                      if (!selectedMarket) return
                      setEmailDrafts([])
                      setGeneratingEmail(true)
                      try {
                        const result = await generateMarketUpdateEmail(selectedMarket, selectedIds)
                        if (result) {
                          setEmailDrafts([{ subject: result.subject ?? "Market Update", body: result.body ?? "" }])
                        }
                      } catch (e: any) {
                        toast.error(e.message ?? "Failed to regenerate")
                      } finally {
                        setGeneratingEmail(false)
                      }
                    }}
                  >
                    {generatingEmail ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    )}
                    Regenerate
                  </Button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setShareModalOpen(false)}>
              Cancel
            </Button>
            {emailDrafts.length > 0 && (
              <Button
                onClick={handleSaveDrafts}
                disabled={sendingDrafts || selectedIds.length === 0}
              >
                {sendingDrafts ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <CheckSquare className="h-4 w-4 mr-2" />
                )}
                Save {selectedIds.length} Draft{selectedIds.length !== 1 ? "s" : ""}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
