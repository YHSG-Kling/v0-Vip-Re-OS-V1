"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { FileText, DollarSign, Calendar, User, CheckCircle2, AlertCircle, Clock } from "lucide-react"
import { updateLoanStatus, trackConditionClearance } from "@/app/actions/multi-persona"
import { useState, useTransition, useEffect } from "react"

interface Loan {
  id: string
  loan_amount: number
  loan_type: string
  interest_rate: number
  underwriting_status: string
  conditions_cleared: number
  conditions_list: any[]
  transactions: {
    id: string
    property_address: string
    contract_price: number
    closing_date: string
    leads: { first_name: string; last_name: string }
    agents: { first_name: string; last_name: string; email: string }
  }
}

export function LoanPipeline({ loans }: { loans: Loan[] }) {
  const [isPending, startTransition] = useTransition()
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null)
  const [newStatus, setNewStatus] = useState("")
  const [notes, setNotes] = useState("")
  const [conditionStats, setConditionStats] = useState<Record<string, any>>({})

  useEffect(() => {
    async function loadConditions() {
      const stats: Record<string, any> = {}
      for (const loan of loans) {
        const result = await trackConditionClearance(loan.id)
        stats[loan.id] = result
      }
      setConditionStats(stats)
    }
    if (loans.length > 0) {
      loadConditions()
    }
  }, [loans])

  const getStatusColor = (status: string) => {
    switch (status) {
      case "submitted":
        return "bg-blue-100 text-blue-800"
      case "in_underwriting":
        return "bg-yellow-100 text-yellow-800"
      case "conditionally_approved":
        return "bg-orange-100 text-orange-800"
      case "clear_to_close":
        return "bg-green-100 text-green-800"
      case "suspended":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const handleUpdateStatus = () => {
    if (!selectedLoan || !newStatus) return
    startTransition(async () => {
      await updateLoanStatus({
        loanId: selectedLoan.id,
        status: newStatus,
        notes,
      })
      setSelectedLoan(null)
      setNewStatus("")
      setNotes("")
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Loan Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {loans.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No active loans in your pipeline</div>
          ) : (
            loans.map((loan) => {
              const stats = conditionStats[loan.id]
              const clearanceRate = stats?.clearanceRate || 0
              return (
                <div key={loan.id} className="p-4 hover:bg-muted/50">
                  <div className="flex items-start justify-between">
                    <div className="space-y-2 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{loan.transactions?.property_address}</span>
                        <Badge className={getStatusColor(loan.underwriting_status)}>
                          {loan.underwriting_status?.replace(/_/g, " ")}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <User className="h-3 w-3" />
                          {loan.transactions?.leads?.first_name} {loan.transactions?.leads?.last_name}
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <DollarSign className="h-3 w-3" />${loan.loan_amount?.toLocaleString()}
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          {new Date(loan.transactions?.closing_date).toLocaleDateString()}
                        </div>
                        <div className="text-muted-foreground">{loan.loan_type} @ {loan.interest_rate}%</div>
                      </div>

                      {/* Conditions Progress */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Conditions Cleared</span>
                          <span className="font-medium">{clearanceRate.toFixed(0)}%</span>
                        </div>
                        <Progress value={clearanceRate} className="h-2" />
                        {stats?.pendingConditions?.length > 0 && (
                          <p className="text-xs text-orange-600">
                            {stats.pendingConditions.length} conditions pending
                          </p>
                        )}
                      </div>
                    </div>

                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedLoan(loan)}
                          className="bg-transparent ml-4"
                        >
                          Update Status
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Update Loan Status</DialogTitle>
                          <DialogDescription>{loan.transactions?.property_address}</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label>New Status</Label>
                            <Select value={newStatus} onValueChange={setNewStatus}>
                              <SelectTrigger>
                                <SelectValue placeholder="Select status" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="submitted">Submitted</SelectItem>
                                <SelectItem value="in_underwriting">In Underwriting</SelectItem>
                                <SelectItem value="conditionally_approved">Conditionally Approved</SelectItem>
                                <SelectItem value="clear_to_close">Clear to Close</SelectItem>
                                <SelectItem value="suspended">Suspended</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label>Notes</Label>
                            <Textarea
                              value={notes}
                              onChange={(e) => setNotes(e.target.value)}
                              placeholder="Add notes about this status update..."
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button onClick={handleUpdateStatus} disabled={isPending || !newStatus}>
                            {isPending ? "Updating..." : "Update Status"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
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
