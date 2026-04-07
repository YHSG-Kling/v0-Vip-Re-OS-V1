"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Home, Calendar, ChevronRight } from "lucide-react"
import Link from "next/link"
import { ClosingReadinessGate } from "@/app/dashboard/coordinator/components/closing-readiness-gate"

interface Transaction {
  id: string
  property_address: string
  status: string
  closing_date?: string
  agent_name?: string
  completion_percent: number
  stage?: string
  agent_id?: string
}

interface CoordinatorTransactionListProps {
  transactions?: Transaction[]
}

export function CoordinatorTransactionList({ transactions = [] }: CoordinatorTransactionListProps) {
  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "pending":
        return "secondary"
      case "active":
      case "in_progress":
        return "default"
      case "closed":
        return "outline"
      case "at_risk":
        return "destructive"
      default:
        return "secondary"
    }
  }

  if (transactions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Active Transactions</CardTitle>
          <CardDescription>Transactions you are coordinating</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Home className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>No active transactions</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Active Transactions</CardTitle>
            <CardDescription>{transactions.length} transactions in progress</CardDescription>
          </div>
          <Link href="/transactions">
            <Button variant="ghost" size="sm">
              View All <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {transactions.map((tx) => (
            <div key={tx.id} className="p-4 border rounded-lg space-y-3">
              {/* Header row */}
              <div className="flex items-start justify-between">
                <div>
                  <Link
                    href={`/transactions/${tx.id}`}
                    className="font-medium hover:underline"
                  >
                    {tx.property_address}
                  </Link>
                  {tx.agent_name && (
                    <p className="text-sm text-muted-foreground">Agent: {tx.agent_name}</p>
                  )}
                </div>
                <Badge variant={getStatusColor(tx.status)}>{tx.status}</Badge>
              </div>

              {/* Progress */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Completion</span>
                  <span className="font-medium">{tx.completion_percent}%</span>
                </div>
                <Progress value={tx.completion_percent} className="h-2" />
                {tx.closing_date && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Calendar className="w-3 h-3" />
                    <span>Closing: {new Date(tx.closing_date).toLocaleDateString()}</span>
                  </div>
                )}
              </div>

              {/* Closing Readiness Gate */}
              <ClosingReadinessGate
                transactionId={tx.id}
                transactionStage={tx.stage ?? tx.status}
                agentId={tx.agent_id ?? ""}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
