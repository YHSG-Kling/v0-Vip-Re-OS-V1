"use client"

import { useState, ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DollarSign, Calculator, Wrench } from "lucide-react"
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
  children,
}: AgentFinancialsClientProps) {
  const [setAsidePercent, setSetAsidePercent] = useState(25)

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
