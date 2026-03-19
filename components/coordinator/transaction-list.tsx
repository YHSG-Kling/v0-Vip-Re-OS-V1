"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Home, Calendar, ChevronRight } from "lucide-react"
import Link from "next/link"

interface Transaction {
  id: string
  property_address: string
  status: string
  closing_date?: string
  agent_name?: string
  completion_percent: number
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
            <Link href={`/transactions/${tx.id}`} key={tx.id}>
              <div className="p-4 border rounded-lg hover:bg-muted/50 transition-colors cursor-pointer">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="font-medium">{tx.property_address}</p>
                    {tx.agent_name && (
                      <p className="text-sm text-muted-foreground">Agent: {tx.agent_name}</p>
                    )}
                  </div>
                  <Badge variant={getStatusColor(tx.status)}>{tx.status}</Badge>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Completion</span>
                    <span className="font-medium">{tx.completion_percent}%</span>
                  </div>
                  <Progress value={tx.completion_percent} className="h-2" />
                  {tx.closing_date && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2">
                      <Calendar className="w-3 h-3" />
                      <span>Closing: {new Date(tx.closing_date).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
