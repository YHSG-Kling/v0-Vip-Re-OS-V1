"use client"

import { useState, useTransition, ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DollarSign,
  Calculator,
  Wrench,
  Sparkles,
  Loader2,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Plus,
  BarChart2,
  GitMerge,
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"
import { generateAIForecast } from "@/app/actions/financials"
import {
  loadAgentProfitLossSummaryAction,
  loadCommissionDistributionsAction,
  recalculateCommissionStateAction,
  createCommissionRecordAction,
} from "@/app/actions/financial-kernel"
import {
  TaxReadinessPanel,
  TaxSetasidePanel,
  DeductionReadinessPanel,
  BusinessPlanningPanel,
  PlanningAiSummaryPanel,
} from "../components/planning"
import { MyProfitLossPanel } from "../components/my-profit-loss-panel"
import { MyCommissionsDisputePanel } from "../components/my-commissions-dispute-panel"
import { BillingSummaryCard } from "./components/billing-summary-card"
import { CommissionCalculatorCard } from "./components/commission-calculator-card"
import { BudgetPlannerCard } from "./components/budget-planner-card"

interface SyncStatus {
  connected: boolean
  lastSync?: string
  errors: number
}

interface Expense {
  id: string
  category: string
  amount: number
  description: string
  receipt_url?: string
  date: string
}

interface PipelineTransaction {
  id: string
  property_address: string | null
  purchase_price: number | null
  commission_percentage: number | null
  estimated_commission: number | null
  deal_name: string | null
}

interface CommissionProfile {
  split_percent: number | null
  cap_amount: number | null
  transaction_fee_value: number | null
  transaction_fee_type: string | null
  structure_type: string | null
  desk_fee_value: number | null
  royalty_percent: number | null
  is_active: boolean | null
}

interface CapTracking {
  cap_amount: number | null
  cap_paid_to_date: number | null
  is_capped: boolean | null
  anniversary_start: string | null
  anniversary_end: string | null
}

interface AgentFinancialsClientProps {
  agentId: string
  brokerageId: string
  ytdGCI: number
  ytdExpenses: number
  ytdTransactionCount: number
  expenses: Expense[]
  syncStatus: SyncStatus | null
  currentBilling: any | null
  existingBudget: any | null
  pipelineTransactions: PipelineTransaction[]
  commissionProfile: CommissionProfile | null
  capTracking: CapTracking | null
  children: ReactNode // The existing earnings content
}

export function AgentFinancialsClient({
  agentId,
  brokerageId,
  ytdGCI,
  ytdExpenses,
  ytdTransactionCount,
  expenses,
  syncStatus,
  currentBilling,
  existingBudget,
  pipelineTransactions,
  commissionProfile,
  capTracking,
  children,
}: AgentFinancialsClientProps) {
  const [setAsidePercent, setSetAsidePercent] = useState(25)
  const [forecastText, setForecastText] = useState<string | null>(null)
  const [forecastProjection, setForecastProjection] = useState<number | null>(null)
  const [forecastError, setForecastError] = useState<string | null>(null)
  const [isForecastPending, startForecast] = useTransition()

  // ── P&L Summary ──────────────────────────────────────────────────────────────
  const [plSummary, setPlSummary] = useState<{
    totalIncome: number
    totalExpenses: number
    netProfit: number
    closedTransactions: number
  } | null>(null)
  const [plError, setPlError] = useState<string | null>(null)
  const [isPlPending, startPl] = useTransition()

  // ── Commission Distributions ─────────────────────────────────────────────────
  const [distributions, setDistributions] = useState<Array<{
    id: string
    agentId: string
    recipientId: string | null
    recipientName: string | null
    type: string
    calculatedAmount: number
    status: string
    paidAt: string | null
  }> | null>(null)
  const [distError, setDistError] = useState<string | null>(null)
  const [isDistPending, startDist] = useTransition()

  // ── Recalculate Commission State ─────────────────────────────────────────────
  const [isRecalcPending, startRecalc] = useTransition()

  // ── Add Commission Dialog ────────────────────────────────────────────────────
  const [addCommOpen, setAddCommOpen] = useState(false)
  const [addCommForm, setAddCommForm] = useState({
    transactionId: "",
    grossCommission: "",
    splitPercentage: "70",
  })
  const [isAddCommPending, startAddComm] = useTransition()

  const isCapped = capTracking?.is_capped ?? false
  const anniversaryEnd = capTracking?.anniversary_end

  // Calculate quarter from current month
  const currentMonth = new Date().getMonth() + 1
  const quarter = Math.ceil(currentMonth / 3)

  function handleAIForecast() {
    startForecast(async () => {
      setForecastError(null)
      setForecastText(null)
      const pipelineValue = pipelineTransactions.reduce(
        (sum, t) => sum + (t.estimated_commission ?? 0),
        0
      )
      const result = await generateAIForecast({
        agentId,
        brokerageId,
        ytdGCI,
        ytdTransactionCount,
        pipelineValue,
        monthsElapsed: currentMonth,
      })
      if (result.success) {
        setForecastText(result.forecast ?? null)
        setForecastProjection(result.projectedYearEnd ?? null)
      } else {
        setForecastError(result.error ?? "Forecast failed")
      }
    })
  }

  // ── P&L handler ──────────────────────────────────────────────────────────────
  function handleLoadPl() {
    startPl(async () => {
      setPlError(null)
      const result = await loadAgentProfitLossSummaryAction({ agentId, brokerageId })
      if (result.success && result.data) {
        setPlSummary(result.data)
      } else {
        setPlError(result.error ?? "Failed to load P&L summary")
        toast.error(result.error ?? "Failed to load P&L summary")
      }
    })
  }

  // ── Commission Distributions handler ────────────────────────────────────────
  function handleLoadDistributions() {
    startDist(async () => {
      setDistError(null)
      const result = await loadCommissionDistributionsAction({ brokerageId, agentId })
      if (result.success && result.data) {
        setDistributions(result.data)
      } else {
        setDistError(result.error ?? "Failed to load distributions")
        toast.error(result.error ?? "Failed to load distributions")
      }
    })
  }

  // ── Recalculate handler ──────────────────────────────────────────────────────
  function handleRecalculate() {
    startRecalc(async () => {
      const result = await recalculateCommissionStateAction({ brokerageId })
      if (result.success && result.data) {
        toast.success(
          `Recalculated ${result.data.recalculated} records — ${result.data.capped} newly capped`
        )
        // Refresh distributions so the UI reflects newly recalculated data
        handleLoadDistributions()
        // Also refresh P&L if it was already loaded
        if (plSummary !== null) {
          handleLoadPl()
        }
      } else {
        toast.error(result.error ?? "Recalculation failed")
      }
    })
  }

  // ── Add Commission handler ───────────────────────────────────────────────────
  function handleAddCommission() {
    startAddComm(async () => {
      const gross = parseFloat(addCommForm.grossCommission)
      const split = parseFloat(addCommForm.splitPercentage)
      if (!addCommForm.transactionId || isNaN(gross) || isNaN(split)) {
        toast.error("Please fill in all required fields with valid values")
        return
      }
      const result = await createCommissionRecordAction({
        agentId,
        transactionId: addCommForm.transactionId,
        grossCommission: gross,
        splitPercentage: split,
      })
      if (result.success) {
        toast.success("Commission record created successfully")
        setAddCommOpen(false)
        setAddCommForm({ transactionId: "", grossCommission: "", splitPercentage: "70" })
        // Refresh distributions if already loaded
        if (distributions !== null) {
          handleLoadDistributions()
        }
      } else {
        toast.error(result.error ?? "Failed to create commission record")
      }
    })
  }

  // Calculate estimated tax liability
  const estimatedTaxRate = 0.25
  const grossTaxable = ytdGCI - ytdExpenses
  const estimatedTaxLiability = Math.max(0, grossTaxable * estimatedTaxRate)

  return (
    <>
    <Tabs defaultValue="earnings" className="space-y-6">
      <TabsList>
        <TabsTrigger value="earnings" className="gap-2">
          <DollarSign className="h-4 w-4" />
          Earnings
        </TabsTrigger>
        <TabsTrigger value="pl-commissions" className="gap-2">
          <BarChart2 className="h-4 w-4" />
          P&amp;L &amp; Commissions
        </TabsTrigger>
        <TabsTrigger value="planning" className="gap-2">
          <Calculator className="h-4 w-4" />
          Planning &amp; Tax
        </TabsTrigger>
        <TabsTrigger value="finance-tools" className="gap-2">
          <Wrench className="h-4 w-4" />
          Finance Tools
        </TabsTrigger>
      </TabsList>

      <TabsContent value="earnings" className="space-y-6">
        {/* Capped celebration banner — shown only when agent_cap_tracking.is_capped = true */}
        {isCapped && (
          <div className="rounded-lg border-2 border-green-400 bg-green-50 p-4 text-center">
            <p className="text-2xl">&#127881;</p>
            <p className="font-bold text-green-900">You've hit your cap!</p>
            <p className="text-sm text-green-700">
              100% of commissions are yours until{" "}
              {anniversaryEnd
                ? format(new Date(anniversaryEnd), "MMMM d, yyyy")
                : "year end"}
              .
            </p>
          </div>
        )}

        {/* Commission structure badge — shown when an active profile exists */}
        {commissionProfile && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {commissionProfile.structure_type?.replace(/_/g, " ") ?? "Standard"} Structure
            </Badge>
            <span className="text-sm text-muted-foreground">
              {commissionProfile.split_percent}% split
              {(commissionProfile.transaction_fee_value ?? 0) > 0
                ? ` · $${commissionProfile.transaction_fee_value?.toLocaleString()} transaction fee`
                : ""}
            </span>
          </div>
        )}

        {children}

        {/* AI Forecast Panel */}
        <Card className="border-blue-200">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-blue-100">
                  <TrendingUp className="h-5 w-5 text-blue-700" />
                </div>
                <div>
                  <CardTitle className="text-base">AI Earnings Forecast</CardTitle>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={handleAIForecast}
                disabled={isForecastPending}
              >
                {isForecastPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                )}
                {isForecastPending ? "Generating..." : "Generate Forecast"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {forecastError && (
              <Alert variant="destructive">
                <AlertDescription>{forecastError}</AlertDescription>
              </Alert>
            )}
            {!forecastText && !forecastError && !isForecastPending && (
              <p className="text-sm text-muted-foreground">
                Click &ldquo;Generate Forecast&rdquo; to get an AI projection of your year-end GCI based on current pace and pipeline.
              </p>
            )}
            {forecastText && (
              <div className="space-y-3">
                {forecastProjection !== null && (
                  <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                    <p className="text-xs text-muted-foreground">Linear Year-End Projection</p>
                    <p className="text-2xl font-bold text-blue-700">
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(forecastProjection)}
                    </p>
                  </div>
                )}
                <p className="text-sm leading-relaxed whitespace-pre-line">{forecastText}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="planning" className="space-y-6">
        {/* Planning & Tax Tab Content */}
        <div className="grid gap-6 lg:grid-cols-2">
          <TaxReadinessPanel
            agentId={agentId}
            brokerageId={brokerageId}
            ytdGCI={ytdGCI}
            ytdExpenses={ytdExpenses}
            quarter={quarter}
          />
          <TaxSetasidePanel
            ytdGCI={ytdGCI}
            setAsidePercent={setAsidePercent}
            onUpdatePercent={setSetAsidePercent}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <DeductionReadinessPanel
            agentId={agentId}
            brokerageId={brokerageId}
            expenses={expenses}
          />
          <BusinessPlanningPanel
            agentId={agentId}
            ytdGCI={ytdGCI}
            ytdTransactionCount={ytdTransactionCount}
            ytdExpenses={ytdExpenses}
          />
        </div>

        <PlanningAiSummaryPanel
          agentId={agentId}
          ytdGCI={ytdGCI}
          ytdExpenses={ytdExpenses}
          estimatedTaxLiability={estimatedTaxLiability}
          syncStatus={syncStatus}
        />
      </TabsContent>

      {/* ── P&L & Commissions Tab ──────────────────────────────────────────── */}
      <TabsContent value="pl-commissions" className="space-y-6">

        {/* My monthly P&L snapshot + AI-tool ROI (agent-facing; was broker-only) */}
        <MyProfitLossPanel />

        {/* Review my commissions + dispute one that looks wrong */}
        <MyCommissionsDisputePanel />

        {/* P&L Summary */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-emerald-100">
                  <BarChart2 className="h-5 w-5 text-emerald-700" />
                </div>
                <div>
                  <CardTitle className="text-base">Profit &amp; Loss Summary</CardTitle>
                  <CardDescription>Year-to-date income, expenses, and net</CardDescription>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={handleLoadPl}
                disabled={isPlPending}
              >
                {isPlPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {isPlPending ? "Loading…" : "Load P&L"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {plError && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{plError}</AlertDescription>
              </Alert>
            )}
            {!plSummary && !plError && !isPlPending && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Click &ldquo;Load P&amp;L&rdquo; to fetch your year-to-date profit &amp; loss summary.
              </p>
            )}
            {plSummary && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200">
                  <p className="text-xs text-muted-foreground">Gross Income</p>
                  <p className="text-xl font-bold text-emerald-700">
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    }).format(plSummary.totalIncome)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Total commissions YTD</p>
                </div>
                <div className="p-4 rounded-lg bg-red-50 border border-red-200">
                  <p className="text-xs text-muted-foreground">Total Expenses</p>
                  <p className="text-xl font-bold text-red-600">
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    }).format(plSummary.totalExpenses)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Business expenses YTD</p>
                </div>
                <div
                  className={`p-4 rounded-lg border ${
                    plSummary.netProfit >= 0
                      ? "bg-blue-50 border-blue-200"
                      : "bg-orange-50 border-orange-200"
                  }`}
                >
                  <p className="text-xs text-muted-foreground">Net Income</p>
                  <p
                    className={`text-xl font-bold ${
                      plSummary.netProfit >= 0 ? "text-blue-700" : "text-orange-600"
                    }`}
                  >
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    }).format(plSummary.netProfit)}
                  </p>
                  <div className="flex items-center gap-1 mt-1">
                    {plSummary.netProfit >= 0 ? (
                      <TrendingUp className="h-3 w-3 text-blue-500" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-orange-500" />
                    )}
                    <span className="text-xs text-muted-foreground">After expenses</span>
                  </div>
                </div>
                <div className="p-4 rounded-lg bg-violet-50 border border-violet-200">
                  <p className="text-xs text-muted-foreground">Profit Margin</p>
                  <p className="text-xl font-bold text-violet-700">
                    {plSummary.totalIncome > 0
                      ? `${((plSummary.netProfit / plSummary.totalIncome) * 100).toFixed(1)}%`
                      : "—"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {plSummary.closedTransactions} closed transaction
                    {plSummary.closedTransactions !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Commission Distributions */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-sky-100">
                  <GitMerge className="h-5 w-5 text-sky-700" />
                </div>
                <div>
                  <CardTitle className="text-base">Commission Distributions</CardTitle>
                  <CardDescription>How commissions are split across recipients</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setAddCommOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Commission
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={handleLoadDistributions}
                  disabled={isDistPending}
                >
                  {isDistPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {isDistPending ? "Loading…" : "Load Distributions"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {distError && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{distError}</AlertDescription>
              </Alert>
            )}
            {!distributions && !distError && !isDistPending && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Click &ldquo;Load Distributions&rdquo; to view commission split data.
              </p>
            )}
            {distributions && distributions.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No commission distributions found.
              </p>
            )}
            {distributions && distributions.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Paid At</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {distributions.map((dist) => (
                    <TableRow key={dist.id}>
                      <TableCell className="font-medium">
                        {dist.recipientName ?? dist.recipientId ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize">
                          {dist.type.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD",
                        }).format(dist.calculatedAmount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={dist.status === "paid" ? "default" : "outline"}
                          className={
                            dist.status === "paid"
                              ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                              : ""
                          }
                        >
                          {dist.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {dist.paidAt
                          ? format(new Date(dist.paidAt), "MMM d, yyyy")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5 h-7 text-xs"
                          disabled={isRecalcPending}
                          onClick={handleRecalculate}
                        >
                          {isRecalcPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                          Recalculate
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="finance-tools" className="space-y-6">
        {/* Row 1: Billing Summary + Commission Calculator */}
        <div className="grid gap-6 lg:grid-cols-2">
          <BillingSummaryCard
            agentId={agentId}
            brokerageId={brokerageId}
            initialBilling={currentBilling}
          />
          <CommissionCalculatorCard
            agentId={agentId}
            pendingTransactions={pipelineTransactions}
            defaultSplitPercent={commissionProfile?.split_percent ?? 70}
            defaultTransactionFee={commissionProfile?.transaction_fee_value ?? 0}
            structureType={commissionProfile?.structure_type ?? undefined}
          />
        </div>

        {/* Row 2: Budget Planner (full width) */}
        <BudgetPlannerCard
          agentId={agentId}
          initialBudget={existingBudget}
          ytdGCI={ytdGCI}
        />
      </TabsContent>
    </Tabs>

    {/* Add Commission Dialog */}
    <Dialog open={addCommOpen} onOpenChange={setAddCommOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Commission Record</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="add-txn-id">Transaction ID</Label>
            <Input
              id="add-txn-id"
              placeholder="Enter transaction ID"
              value={addCommForm.transactionId}
              onChange={(e) =>
                setAddCommForm((f) => ({ ...f, transactionId: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-gross">Gross Commission ($)</Label>
            <Input
              id="add-gross"
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 12000"
              value={addCommForm.grossCommission}
              onChange={(e) =>
                setAddCommForm((f) => ({ ...f, grossCommission: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-split">Agent Split %</Label>
            <Select
              value={addCommForm.splitPercentage}
              onValueChange={(val) =>
                setAddCommForm((f) => ({ ...f, splitPercentage: val }))
              }
            >
              <SelectTrigger id="add-split">
                <SelectValue placeholder="Select split %" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50%</SelectItem>
                <SelectItem value="60">60%</SelectItem>
                <SelectItem value="70">70%</SelectItem>
                <SelectItem value="75">75%</SelectItem>
                <SelectItem value="80">80%</SelectItem>
                <SelectItem value="85">85%</SelectItem>
                <SelectItem value="90">90%</SelectItem>
                <SelectItem value="100">100% (post-cap)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setAddCommOpen(false)}
            disabled={isAddCommPending}
          >
            Cancel
          </Button>
          <Button onClick={handleAddCommission} disabled={isAddCommPending}>
            {isAddCommPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Saving…
              </>
            ) : (
              "Save Commission"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
