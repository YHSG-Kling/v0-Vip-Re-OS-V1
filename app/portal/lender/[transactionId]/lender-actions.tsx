"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { CheckCircle2, AlertTriangle, Loader2, PartyPopper } from "lucide-react"
import { issueClearToClose, flagLenderIssue, updateLenderLoanStatus } from "@/app/actions/lender-portal-actions"
import { useRouter } from "next/navigation"

const LOAN_STATUSES = [
  { value: "submitted", label: "Submitted" },
  { value: "in_review", label: "In Review" },
  { value: "pending_conditions", label: "Pending Conditions" },
  { value: "approved", label: "Approved" },
  { value: "clear_to_close", label: "Clear to Close" },
] as const

export function LenderActions({
  transactionId,
  lenderId,
  currentStatus,
  isClearToClose,
}: {
  transactionId: string
  lenderId: string
  currentStatus: string
  isClearToClose: boolean
}) {
  const router = useRouter()
  const [issuingCTC, setIssuingCTC] = useState(false)
  const [ctcSuccess, setCtcSuccess] = useState(false)
  const [flagging, setFlagging] = useState(false)
  const [issueText, setIssueText] = useState("")
  const [flagSuccess, setFlagSuccess] = useState(false)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleIssueCTC = async () => {
    setIssuingCTC(true)
    setError(null)

    try {
      await issueClearToClose({ transactionId, lenderId })
      setCtcSuccess(true)
      router.refresh()
    } catch (err: any) {
      setError(err.message || "Failed to issue Clear to Close")
    } finally {
      setIssuingCTC(false)
    }
  }

  const handleFlagIssue = async () => {
    if (!issueText.trim()) return

    setFlagging(true)
    setError(null)

    try {
      await flagLenderIssue({
        transactionId,
        lenderId,
        issueDescription: issueText,
      })
      setFlagSuccess(true)
      setIssueText("")
      setTimeout(() => setFlagSuccess(false), 3000)
    } catch (err: any) {
      setError(err.message || "Failed to flag issue")
    } finally {
      setFlagging(false)
    }
  }

  const handleStatusUpdate = async (newStatus: string) => {
    setUpdatingStatus(true)
    setError(null)

    try {
      await updateLenderLoanStatus({
        transactionId,
        lenderId,
        newStatus,
      })
      router.refresh()
    } catch (err: any) {
      setError(err.message || "Failed to update status")
    } finally {
      setUpdatingStatus(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status Update */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Update Loan Status</label>
          <Select
            value={currentStatus}
            onValueChange={handleStatusUpdate}
            disabled={updatingStatus || isClearToClose}
          >
            <SelectTrigger>
              {updatingStatus ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Updating...
                </span>
              ) : (
                <SelectValue placeholder="Select status" />
              )}
            </SelectTrigger>
            <SelectContent>
              {LOAN_STATUSES.map((status) => (
                <SelectItem key={status.value} value={status.value}>
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Clear to Close Button */}
        {!isClearToClose && !ctcSuccess && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button className="w-full bg-emerald-600 hover:bg-emerald-700" disabled={issuingCTC}>
                {issuingCTC ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Issuing...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Issue Clear to Close
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Issue Clear to Close?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will notify the buyer and their agent that the loan is Clear to Close.
                  This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleIssueCTC}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  Yes, Issue CTC
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* CTC Success State */}
        {(isClearToClose || ctcSuccess) && (
          <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-center">
            <PartyPopper className="h-8 w-8 mx-auto text-emerald-600 mb-2" />
            <p className="font-medium text-emerald-800">Clear to Close Issued!</p>
            <p className="text-sm text-emerald-600">Buyer and agent have been notified</p>
          </div>
        )}

        {/* Flag Issue Section */}
        <div className="pt-4 border-t space-y-3">
          <label className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Flag an Issue
          </label>
          <Textarea
            placeholder="Describe the issue that needs attention..."
            value={issueText}
            onChange={(e) => setIssueText(e.target.value)}
            rows={3}
            disabled={flagging}
          />
          <Button
            variant="outline"
            className="w-full border-amber-300 text-amber-700 hover:bg-amber-50"
            onClick={handleFlagIssue}
            disabled={flagging || !issueText.trim()}
          >
            {flagging ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : flagSuccess ? (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Issue Reported
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 mr-2" />
                Report Issue to Agent
              </>
            )}
          </Button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
