"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  MessageSquare,
  Send,
  Clock,
  User,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

interface Message {
  id: string
  body: string
  direction: "inbound" | "outbound"
  senderName: string
  senderRole?: string
  createdAt: string
  read?: boolean
}

interface ExternalCommunicationPanelProps {
  partnerType: "vendor" | "lender" | "title"
  partnerId: string
  transactionId?: string
  messages: Message[]
  onSendMessage?: (body: string) => Promise<{ success: boolean; error?: string }>
}

export function ExternalCommunicationPanel({
  partnerType,
  partnerId,
  transactionId,
  messages,
  onSendMessage,
}: ExternalCommunicationPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [newMessage, setNewMessage] = useState("")
  const [sending, setSending] = useState(false)

  const unreadCount = messages.filter((m) => m.direction === "inbound" && !m.read).length
  const displayMessages = expanded ? messages : messages.slice(0, 3)

  const handleSend = async () => {
    if (!newMessage.trim() || !onSendMessage) return

    setSending(true)
    try {
      const result = await onSendMessage(newMessage.trim())
      if (result.success) {
        setNewMessage("")
        toast.success("Message sent")
      } else {
        toast.error(result.error || "Failed to send message")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setSending(false)
    }
  }

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = diffMs / (1000 * 60 * 60)

    if (diffHours < 24) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    } else if (diffHours < 48) {
      return "Yesterday"
    } else {
      return date.toLocaleDateString()
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Messages
          </CardTitle>
          {unreadCount > 0 && (
            <Badge variant="destructive" className="text-xs">
              {unreadCount} Unread
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {messages.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground">
            <MessageSquare className="h-6 w-6 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No messages yet</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {displayMessages.map((msg) => (
              <div
                key={msg.id}
                className={`p-3 rounded-lg ${
                  msg.direction === "outbound"
                    ? "bg-primary/10 ml-4"
                    : "bg-muted/50 mr-4"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1 text-xs">
                    <User className="h-3 w-3" />
                    <span className="font-medium">{msg.senderName}</span>
                    {msg.senderRole && (
                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                        {msg.senderRole}
                      </Badge>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatTime(msg.createdAt)}
                  </span>
                </div>
                <p className="text-sm">{msg.body}</p>
              </div>
            ))}
          </div>
        )}

        {messages.length > 3 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-2"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <>
                Show Less <ChevronUp className="h-4 w-4 ml-1" />
              </>
            ) : (
              <>
                Show All {messages.length} Messages <ChevronDown className="h-4 w-4 ml-1" />
              </>
            )}
          </Button>
        )}

        {onSendMessage && (
          <div className="mt-4 border-t pt-4">
            <Textarea
              placeholder="Type a message..."
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              className="min-h-[60px] text-sm resize-none"
            />
            <div className="flex justify-end mt-2">
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!newMessage.trim() || sending}
              >
                {sending ? "Sending..." : "Send"}
                <Send className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
