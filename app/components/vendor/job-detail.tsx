"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { FileText, MessageSquare, DollarSign, Clock, CheckCircle2, Upload } from "lucide-react"
import {
  updateVendorJobStatus,
  addVendorJobNote,
  updateVendorJobCost,
  sendVendorMessageToAgent,
} from "@/app/actions/vendor-portal"

interface VendorJobDetailProps {
  job: any
  vendorId: string
}

export function VendorJobDetail({ job, vendorId }: VendorJobDetailProps) {
  const [status, setStatus] = useState(job.status)
  const [vendorNotes, setVendorNotes] = useState(job.vendor_notes || "")
  const [costActual, setCostActual] = useState(job.cost_actual?.toString() || "")
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [saveStatus, setSaveStatus] = useState("")
  const [showMarkComplete, setShowMarkComplete] = useState(false)

  const handleStatusChange = async (newStatus: string) => {
    setLoading(true)
    setSaveStatus("")
    try {
      await updateVendorJobStatus({
        jobId: job.id,
        vendorId,
        status: newStatus,
      })
      setStatus(newStatus)
      setSaveStatus("Status updated")
      setTimeout(() => setSaveStatus(""), 2000)
    } catch (error) {
      setSaveStatus("Failed to update status")
    }
    setLoading(false)
  }

  const handleNotesChange = async () => {
    if (!vendorNotes.trim()) return
    setLoading(true)
    setSaveStatus("")
    try {
      await addVendorJobNote({
        jobId: job.id,
        vendorId,
        note: vendorNotes,
      })
      setSaveStatus("Notes saved")
      setTimeout(() => setSaveStatus(""), 2000)
    } catch (error) {
      setSaveStatus("Failed to save notes")
    }
    setLoading(false)
  }

  const handleCostChange = async () => {
    if (!costActual.trim()) return
    setLoading(true)
    setSaveStatus("")
    try {
      await updateVendorJobCost({
        jobId: job.id,
        vendorId,
        costActual: parseFloat(costActual),
      })
      setSaveStatus("Cost updated")
      setTimeout(() => setSaveStatus(""), 2000)
    } catch (error) {
      setSaveStatus("Failed to update cost")
    }
    setLoading(false)
  }

  const handleSendMessage = async () => {
    if (!message.trim()) return
    setLoading(true)
    try {
      await sendVendorMessageToAgent({
        jobId: job.id,
        transactionId: job.vendor_assignments?.transaction_id,
        vendorId,
        message,
      })
      setMessage("")
      setSaveStatus("Message sent to agent")
      setTimeout(() => setSaveStatus(""), 2000)
    } catch (error) {
      setSaveStatus("Failed to send message")
    }
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      {/* Job Header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>{job.job_title}</CardTitle>
              <CardDescription className="mt-2">
                {job.vendor_assignments?.transactions?.property_address}
              </CardDescription>
            </div>
            <Badge
              className={
                status === "completed"
                  ? "bg-green-100 text-green-800"
                  : status === "in_progress"
                  ? "bg-blue-100 text-blue-800"
                  : status === "scheduled"
                  ? "bg-amber-100 text-amber-800"
                  : "bg-gray-100 text-gray-800"
              }
            >
              {status}
            </Badge>
          </div>
        </CardHeader>
      </Card>

      {/* Status Update */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Update Job Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="status">Current Status</Label>
            <Select value={status} onValueChange={handleStatusChange} disabled={loading}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {status === "completed" && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setShowMarkComplete(true)}
              disabled={loading}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Mark as Complete & Notify Agent
            </Button>
          )}
          {saveStatus && (
            <p className="text-sm text-green-600">{saveStatus}</p>
          )}
        </CardContent>
      </Card>

      {/* Cost Information */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Cost Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-muted-foreground text-sm">Estimated Cost</Label>
              <p className="text-2xl font-bold">
                ${job.cost_estimate?.toLocaleString() || "N/A"}
              </p>
            </div>
            <div>
              <Label htmlFor="cost_actual" className="text-sm">
                Actual Cost
              </Label>
              <div className="flex gap-2 mt-1">
                <Input
                  id="cost_actual"
                  type="number"
                  placeholder="Enter actual cost"
                  value={costActual}
                  onChange={(e) => setCostActual(e.target.value)}
                  disabled={loading}
                />
                <Button
                  variant="outline"
                  onClick={handleCostChange}
                  disabled={loading || !costActual.trim()}
                  size="sm"
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Notes Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Job Notes</CardTitle>
          <CardDescription>Agent Notes: {job.agent_notes || "No notes yet"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="vendor_notes" className="text-sm mb-2 block">
              Your Notes
            </Label>
            <Textarea
              id="vendor_notes"
              placeholder="Add notes about this job..."
              value={vendorNotes}
              onChange={(e) => setVendorNotes(e.target.value)}
              disabled={loading}
              className="min-h-24"
            />
            <Button
              variant="outline"
              onClick={handleNotesChange}
              disabled={loading || !vendorNotes.trim()}
              className="mt-2"
              size="sm"
            >
              Save Notes
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Document Upload */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Documents
          </CardTitle>
          <CardDescription>Job photos, invoices, and completion reports</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border-2 border-dashed rounded-lg p-8 text-center hover:bg-muted/50 transition-colors cursor-pointer">
            <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium">Upload documents</p>
            <p className="text-xs text-muted-foreground">Drag and drop or click to select</p>
            <input
              type="file"
              multiple
              className="sr-only"
              id="doc-upload"
              disabled={loading}
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              disabled={loading}
              onClick={() => document.getElementById("doc-upload")?.click()}
            >
              Choose Files
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Message to Agent */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Message Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            placeholder="Send a message to the agent about this job..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={loading}
            className="min-h-20"
          />
          <Button
            onClick={handleSendMessage}
            disabled={loading || !message.trim()}
            className="w-full"
          >
            Send Message
          </Button>
        </CardContent>
      </Card>

      {/* Confirm Completion Dialog */}
      <AlertDialog open={showMarkComplete} onOpenChange={setShowMarkComplete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark Job as Complete?</AlertDialogTitle>
            <AlertDialogDescription>
              This will notify the agent that you've completed this job. Make sure all work is done before confirming.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              handleStatusChange("completed")
              setShowMarkComplete(false)
            }}
          >
            Confirm Complete
          </AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
