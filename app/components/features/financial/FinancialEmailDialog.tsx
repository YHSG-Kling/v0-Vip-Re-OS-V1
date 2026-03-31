// app/components/features/financial/FinancialEmailDialog.tsx
"use client"

import { useState, useTransition } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Mail, Send } from "lucide-react"
import { emailFinancialReportAction } from "@/app/actions/financial-kernel"

interface FinancialEmailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  brokerageId: string
}

export function FinancialEmailDialog({ open, onOpenChange, brokerageId }: FinancialEmailDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [recipients, setRecipients] = useState("")
  const [subject, setSubject] = useState("Financial Report")
  const [message, setMessage] = useState("")
  const [reportType, setReportType] = useState("summary")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)

  const handleSend = () => {
    setError("")
    setSuccess(false)

    if (!recipients.trim()) {
      setError("Please enter at least one recipient email")
      return
    }

    startTransition(async () => {
      const result = await emailFinancialReportAction({
        brokerageId,
        recipients: recipients.split(",").map((e) => e.trim()),
        reportType,
        subject,
        message: message || undefined,
      })

      if (!result.success) {
        setError(result.error ?? "Failed to send report")
        return
      }

      setSuccess(true)
      setRecipients("")
      setSubject("Financial Report")
      setMessage("")
      setTimeout(() => {
        onOpenChange(false)
        setSuccess(false)
      }, 2000)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email Financial Report</DialogTitle>
          <DialogDescription>Send a report to team members</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Recipients *</Label>
            <Input
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="email@example.com, another@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label>Report Type</Label>
            <Select value={reportType} onValueChange={setReportType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="summary">Summary</SelectItem>
                <SelectItem value="commissions">Commissions</SelectItem>
                <SelectItem value="expenses">Expenses</SelectItem>
                <SelectItem value="full">Full Report</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Subject *</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>Message</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Optional message..."
              rows={3}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-green-600">Report sent successfully</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="bg-transparent">
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={isPending || success}>
            <Send className="h-4 w-4 mr-2" />
            {isPending ? "Sending..." : "Send Report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
