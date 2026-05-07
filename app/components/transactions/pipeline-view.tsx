"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { TRANSACTION_STAGES, STAGE_TO_STATUS_MAP } from "@/lib/transactions"

interface Transaction {
  id: string
  stage: string
  status: string
  property_address: string
  contract_price: number
  contract_date: string
  agent: { id: string; name: string } | null
  milestones: Array<{
    id: string
    milestone_name: string
    status: string
    target_date: string | null
    completed_at: string | null
  }>
}

interface Props {
  transactions: Transaction[]
  userRole: string
}

export function TransactionPipelineView({ transactions, userRole }: Props) {
  const [selectedStage, setSelectedStage] = useState<string | null>(null)

  const stages = [
    TRANSACTION_STAGES.UNDER_CONTRACT,
    TRANSACTION_STAGES.INSPECTION,
    TRANSACTION_STAGES.APPRAISAL,
    TRANSACTION_STAGES.FINANCING_PENDING,
    TRANSACTION_STAGES.CLOSING_PREP,
    TRANSACTION_STAGES.CLOSED
  ]

  const transactionsByStage = stages.reduce((acc, stage) => {
    acc[stage] = transactions.filter(t => t.stage === stage)
    return acc
  }, {} as Record<string, Transaction[]>)

  const getOverdueMilestones = (transaction: Transaction) => {
    return transaction.milestones.filter(m => 
      m.status === 'overdue' || 
      (m.status === 'pending' && m.target_date && new Date(m.target_date) < new Date())
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {stages.map(stage => {
          const count = transactionsByStage[stage].length
          return (
            <Button
              key={stage}
              variant={selectedStage === stage ? "default" : "outline"}
              onClick={() => setSelectedStage(selectedStage === stage ? null : stage)}
              className="h-auto py-4 flex flex-col items-center"
            >
              <div className="text-sm font-medium">{stage.replace(/_/g, ' ')}</div>
              <div className="text-2xl font-bold">{count}</div>
            </Button>
          )
        })}
      </div>

      <div className="grid gap-4">
        {(selectedStage ? [selectedStage] : stages).map(stage => {
          const stageTransactions = transactionsByStage[stage]
          if (stageTransactions.length === 0) return null

          return (
            <div key={stage} className="space-y-2">
              <h2 className="text-xl font-semibold">{stage.replace(/_/g, ' ')}</h2>
              <div className="grid gap-3">
                {stageTransactions.map(transaction => {
                  const overdueMilestones = getOverdueMilestones(transaction)
                  
                  return (
                    <Card key={transaction.id} className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1 flex-1">
                          <Link 
                            href={`/transactions/${transaction.id}`}
                            className="font-medium hover:underline"
                          >
                            {transaction.property_address}
                          </Link>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <span>${transaction.contract_price?.toLocaleString()}</span>
                            <span>•</span>
                            <span>{transaction.agent?.name || 'No agent'}</span>
                            {overdueMilestones.length > 0 && (
                              <>
                                <span>•</span>
                                <Badge variant="destructive">
                                  {overdueMilestones.length} overdue
                                </Badge>
                              </>
                            )}
                          </div>
                        </div>
                        <Badge variant="outline">{transaction.stage}</Badge>
                      </div>
                    </Card>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
