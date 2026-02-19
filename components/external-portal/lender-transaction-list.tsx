"use client"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"

interface Transaction {
  id: string
  property_address: string
  stage: string
  status: string
  contract_price: number
  contract_date: string
  agent: { name: string; email: string; phone: string } | null
  milestones: Array<{
    id: string
    milestone_name: string
    status: string
    milestone_date: string | null
    completed_at: string | null
  }>
}

interface Props {
  transactions: Transaction[]
  lenderId: string
}

const LENDER_MILESTONES = [
  'appraisal_ordered',
  'appraisal_completed',
  'financing_deadline',
  'conditional_approval_received',
  'clear_to_close_received',
  'funding_confirmed'
]

export function LenderTransactionList({ transactions, lenderId }: Props) {
  const getLenderMilestones = (transaction: Transaction) => {
    return transaction.milestones.filter(m => 
      LENDER_MILESTONES.includes(m.milestone_name)
    )
  }

  const getPendingActions = (transaction: Transaction) => {
    const milestones = getLenderMilestones(transaction)
    return milestones.filter(m => m.status === 'pending' && !m.completed_at)
  }

  return (
    <div className="grid gap-4">
      {transactions.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">No assigned transactions</p>
        </Card>
      ) : (
        transactions.map(transaction => {
          const pendingActions = getPendingActions(transaction)
          
          return (
            <Card key={transaction.id} className="p-6">
              <div className="space-y-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <h3 className="text-xl font-semibold">
                      {transaction.property_address}
                    </h3>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>${transaction.contract_price?.toLocaleString()}</span>
                      <span>•</span>
                      <span>{transaction.agent?.name}</span>
                    </div>
                  </div>
                  <Badge variant="outline">{transaction.stage}</Badge>
                </div>

                {pendingActions.length > 0 && (
                  <div className="rounded-lg border p-4 bg-muted/50">
                    <h4 className="font-medium mb-2">Pending Actions</h4>
                    <ul className="space-y-1 text-sm">
                      {pendingActions.map(milestone => (
                        <li key={milestone.id} className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">
                            {milestone.milestone_name.replace(/_/g, ' ')}
                          </Badge>
                          {milestone.milestone_date && (
                            <span className="text-muted-foreground">
                              Due {new Date(milestone.milestone_date).toLocaleDateString()}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button asChild>
                    <Link href={`/lender/transactions/${transaction.id}`}>
                      View Details
                    </Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <Link href={`/lender/transactions/${transaction.id}/documents`}>
                      Upload Documents
                    </Link>
                  </Button>
                </div>
              </div>
            </Card>
          )
        })
      )}
    </div>
  )
}
