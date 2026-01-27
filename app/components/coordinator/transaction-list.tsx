"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ClipboardList, MapPin, User, Calendar, ChevronRight } from "lucide-react"
import Link from "next/link"

interface Transaction {
  id: string
  property_address: string
  closing_date: string
  transaction_status: string
  progress_percentage: number
  contract_price: number
  leads?: {
    first_name: string
    last_name: string
  }
  agents?: {
    first_name: string
    last_name: string
  }
  transaction_milestones?: any[]
}

export function CoordinatorTransactionList({ transactions }: { transactions: Transaction[] }) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case "under_contract":
        return "bg-blue-100 text-blue-800"
      case "pending":
        return "bg-yellow-100 text-yellow-800"
      case "closing_scheduled":
        return "bg-green-100 text-green-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const getDaysToClosing = (closingDate: string) => {
    const days = Math.floor((new Date(closingDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    return days
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5" />
          Active Transactions
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {transactions.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No active transactions assigned</div>
          ) : (
            transactions.map((txn) => {
              const daysToClosing = getDaysToClosing(txn.closing_date)
              return (
                <div key={txn.id} className="p-4 hover:bg-muted/50 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{txn.property_address}</span>
                        <Badge className={getStatusColor(txn.transaction_status)}>
                          {txn.transaction_status?.replace(/_/g, " ")}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        {txn.leads && (
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {txn.leads.first_name} {txn.leads.last_name}
                          </span>
                        )}
                        {txn.agents && (
                          <span>
                            Agent: {txn.agents.first_name} {txn.agents.last_name}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          Closing: {new Date(txn.closing_date).toLocaleDateString()}
                          {daysToClosing <= 7 && daysToClosing > 0 && (
                            <Badge variant="outline" className="ml-1 text-orange-600 border-orange-600">
                              {daysToClosing}d
                            </Badge>
                          )}
                          {daysToClosing <= 0 && (
                            <Badge variant="destructive" className="ml-1">
                              Overdue
                            </Badge>
                          )}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 mt-2">
                        <Progress value={txn.progress_percentage || 0} className="flex-1 h-2" />
                        <span className="text-xs text-muted-foreground w-12">{txn.progress_percentage || 0}%</span>
                      </div>
                    </div>

                    <Button variant="ghost" size="icon" asChild className="bg-transparent">
                      <Link href={`/transactions/${txn.id}`}>
                        <ChevronRight className="h-5 w-5" />
                      </Link>
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}
