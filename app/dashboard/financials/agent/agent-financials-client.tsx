"use client"

import { useState, ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { DollarSign, Calculator, Wrench } from "lucide-react"
import { format } from "date-fns"
import {
  TaxReadinessPanel,
  TaxSetasidePanel,
  DeductionReadinessPanel,
  BusinessPlanningPanel,
  PlanningAiSummaryPanel,
} from "../components/planning"
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

  const isCapped = capTracking?.is_capped ?? false
  const anniversaryEnd = capTracking?.anniversary_end

  // Calculate quarter from current month
  const currentMonth = new Date().getMonth() + 1
  const quarter = Math.ceil(currentMonth / 3)

  // Calculate estimated tax liability
  const estimatedTaxRate = 0.25
  const grossTaxable = ytdGCI - ytdExpenses
  const estimatedTaxLiability = Math.max(0, grossTaxable * estimatedTaxRate)

  return (
    <Tabs defaultValue="earnings" className="space-y-6">
      <TabsList>
        <TabsTrigger value="earnings" className="gap-2">
          <DollarSign className="h-4 w-4" />
          Earnings
        </TabsTrigger>
        <TabsTrigger value="planning" className="gap-2">
          <Calculator className="h-4 w-4" />
          Planning & Tax
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
  )
}
