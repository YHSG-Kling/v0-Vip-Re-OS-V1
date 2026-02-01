"use client"

import { useState, useTransition } from "react"
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
import { FileText, User, MapPin, Calendar, DollarSign, Edit } from "lucide-react"
import { updateLoanStatus } from "@/app/actions/multi-persona"

interface Loan {
  id: string
  loan_amount: number
  loan_type: string
  interest_rate: number
  underwriting_status: string
  conditions_cleared: number
  conditions_list?: any[]
  transactions?: {
    id: string
    property_address: string
    contract_price: number
    closing_date: string
    leads?: {
      first_name: string
      last_name: string
      email: string
    }
    agents?: {
      first_name: string
      last_name: string
    }
  }
}

export function LenderLoanList({ loans }: { loans: Loan[] }) {
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [newStatus, setNewStatus] = useState("")
  const [notes, setNotes] = useState("")
  const [isPending, startTransition] = useTransition()

  const getStatusColor = (status: string) => {
    switch (status) {
      case "clear_to_close":
        return "bg-green-100 text-green-800"
      case "approved":
        return "bg-blue-100 text-blue-800"
      case "pending_conditions":
        return "bg-yellow-100 text-yellow-800"
      case "in_underwriting":
        return "bg-purple-100 text-purple-800"
      case "denied":
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
      setUpdateDialogOpen(false)
      setNewStatus("")
      setNotes("")
      setSelectedLoan(null)
    })
  }

  const conditionsProgress = (loan: Loan) => {
    if (!loan.conditions_list?.length) return 100
    const cleared = loan.conditions_list.filter((c: any) => c.status === "cleared").length
    return (cleared / loan.conditions_list.length) * 100
  }

  return (
    <>
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
              <div className="p-8 text-center text-muted-foreground">No loans in your pipeline</div>
            ) : (
              loans.map((loan) => (
                <div key={loan.id} className="p-4 hover:bg-muted/50 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="space-y-2 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{loan.transactions?.property_address || "Address pending"}</span>
                        <Badge className={getStatusColor(loan.underwriting_status)}>
                          {loan.underwriting_status?.replace(/_/g, " ")}
                        </Badge>
                        <Badge variant="outline">{loan.loan_type}</Badge>
                      </div>

                      <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                        {loan.transactions?.leads && (
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {loan.transactions.leads.first_name} {loan.transactions.leads.last_name}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <DollarSign className="h-3 w-3" />
                          Loan: ${(loan.loan_amount || 0).toLocaleString()}
                        </span>
                        {loan.interest_rate && <span>{loan.interest_rate}% rate</span>}
                        {loan.transactions?.closing_date && (
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            Closing: {new Date(loan.transactions.closing_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>

                      {loan.conditions_list && loan.conditions_list.length > 0 && (
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-muted-foreground">Conditions:</span>
                          <Progress value={conditionsProgress(loan)} className="flex-1 h-2 max-w-48" />
                          <span className="text-xs text-muted-foreground">
                            {loan.conditions_list.filter((c: any) => c.status === "cleared").length}/
                            {loan.conditions_list.length}
                          </span>
                        </div>
                      )}
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      className="bg-transparent"
                      onClick={() => {
                        setSelectedLoan(loan)
                        setNewStatus(loan.underwriting_status)
                        setUpdateDialogOpen(true)
                      }}
                    >
                      <Edit className="h-4 w-4 mr-1" />
                      Update
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={updateDialogOpen} onOpenChange={setUpdateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Loan Status</DialogTitle>
            <DialogDescription>{selectedLoan?.transactions?.property_address}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Underwriting Status</Label>
              <Select value={newStatus} onValueChange={setNewStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="in_underwriting">In Underwriting</SelectItem>
                  <SelectItem value="pending_conditions">Pending Conditions</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="clear_to_close">Clear to Close</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="denied">Denied</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Add notes about this status update..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUpdateDialogOpen(false)} className="bg-transparent">
              Cancel
            </Button>
            <Button onClick={handleUpdateStatus} disabled={isPending || !newStatus}>
              {isPending ? "Updating..." : "Update Status"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
