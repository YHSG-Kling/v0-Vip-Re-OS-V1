"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CheckCircle2, MessageSquare, Loader2 } from "lucide-react"
import { updateTitleStatus, sendTitleMessageToAgent } from "@/app/actions/title-portal"
import { TITLE_STATUS_OPTIONS, type TitleStatus } from "@/lib/title-portal/constants"
import { useRouter } from "next/navigation"

export function TitleActions({
  transactionId,
  titleUserId,
  currentStatus,
}: {
  transactionId: string
  titleUserId: string
  currentStatus: string
}) {
  const router = useRouter()
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [message, setMessage] = useState("")
  const [messageSent, setMessageSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStatusUpdate = async (newStatus: string) => {
    setUpdatingStatus(true)
    setError(null)

    try {
      await updateTitleStatus({
        transactionId,
        titleUserId,
        newStatus: newStatus as TitleStatus,
      })
      router.refresh()
    } catch (err: any) {
      setError(err.message || "Failed to update status")
    } finally {
      setUpdatingStatus(false)
    }
  }

  const handleSendMessage = async () => {
    if (!message.trim()) return

    setSendingMessage(true)
    setError(null)

    try {
      await sendTitleMessageToAgent({
        transactionId,
        titleUserId,
        message,
      })
      setMessageSent(true)
      setMessage("")
      setTimeout(() => setMessageSent(false), 3000)
    } catch (err: any) {
      setError(err.message || "Failed to send message")
    } finally {
      setSendingMessage(false)
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
          <label className="text-sm font-medium">Update Title Status</label>
          <Select
            value={currentStatus}
            onValueChange={handleStatusUpdate}
            disabled={updatingStatus}
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
              {TITLE_STATUS_OPTIONS.map((status) => (
                <SelectItem key={status.value} value={status.value}>
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Status changes are synced with transaction milestones
          </p>
        </div>

        {/* Message to Agent */}
        <div className="pt-4 border-t space-y-3">
          <label className="text-sm font-medium flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Message Agent
          </label>
          <Textarea
            placeholder="Send a message to the agent about this transaction..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            disabled={sendingMessage}
          />
          <Button
            variant="outline"
            className="w-full"
            onClick={handleSendMessage}
            disabled={sendingMessage || !message.trim()}
          >
            {sendingMessage ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : messageSent ? (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Message Sent
              </>
            ) : (
              <>
                <MessageSquare className="h-4 w-4 mr-2" />
                Send Message
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
