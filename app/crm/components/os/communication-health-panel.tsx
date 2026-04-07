"use client"

import { useState, useEffect, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MessageSquare, Mail, Phone, Globe, Loader2, Sparkles, Send } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { sendPortalMessage } from "@/app/actions/portal-messages"
import { toast } from "sonner"

interface Conversation {
  id: string
  last_message: string
  last_message_at: string
  channel: string
  unread_count: number
  sentiment?: string | null
}

interface CommunicationHealthPanelProps {
  conversations: Conversation[]
  agentId: string
  contactId: string
  onLoadDraft: (conversationId?: string) => Promise<void>
  /** AI-generated draft text lifted from parent — pre-fills compose area */
  initialDraft?: string | null
  /** Called after the draft has been consumed so the parent can clear it */
  onDraftConsumed?: () => void
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  sms: <MessageSquare className="h-3.5 w-3.5" />,
  email: <Mail className="h-3.5 w-3.5" />,
  phone: <Phone className="h-3.5 w-3.5" />,
  voice: <Phone className="h-3.5 w-3.5" />,
  portal: <Globe className="h-3.5 w-3.5" />,
}

const CHANNEL_COLORS: Record<string, string> = {
  sms: "bg-green-100 text-green-700",
  email: "bg-blue-100 text-blue-700",
  phone: "bg-purple-100 text-purple-700",
  voice: "bg-purple-100 text-purple-700",
  portal: "bg-indigo-100 text-indigo-700",
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: "bg-emerald-500",
  neutral: "bg-gray-400",
  negative: "bg-red-500",
}

export function CommunicationHealthPanel({
  conversations,
  agentId,
  contactId,
  onLoadDraft,
  initialDraft,
  onDraftConsumed,
}: CommunicationHealthPanelProps) {
  const [loadingDraft, setLoadingDraft] = useState(false)
  const [composeText, setComposeText] = useState("")
  const [isSending, startSend] = useTransition()
  // Thread messages added optimistically after send
  const [sentMessages, setSentMessages] = useState<{ body: string; at: string }[]>([])

  // When parent lifts a new AI draft, populate the compose area
  useEffect(() => {
    if (initialDraft) {
      setComposeText(initialDraft)
      onDraftConsumed?.()
    }
  }, [initialDraft, onDraftConsumed])

  const sorted = [...conversations].sort(
    (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
  )

  const handleLoadDraft = async () => {
    setLoadingDraft(true)
    try {
      await onLoadDraft(undefined)
      // initialDraft effect will pick up the draft text
    } finally {
      setLoadingDraft(false)
    }
  }

  const handleSend = () => {
    const body = composeText.trim()
    if (!body) return
    startSend(async () => {
      const result = await sendPortalMessage({
        contactId,
        messageBody: body,
        direction: "agent_to_client",
      })
      if (result.success) {
        setSentMessages((prev) => [...prev, { body, at: new Date().toISOString() }])
        setComposeText("")
        toast.success("Message sent")
      } else {
        toast.error(result.error ?? "Failed to send message")
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-600" />
          Communications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Recent thread */}
        {sorted.length === 0 && sentMessages.length === 0 ? (
          <div className="text-center py-4">
            <MessageSquare className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No conversations yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.slice(0, 3).map((conv) => (
              <div
                key={conv.id}
                className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg"
              >
                <Badge
                  className={`flex items-center gap-1 shrink-0 ${
                    CHANNEL_COLORS[conv.channel] || "bg-gray-100 text-gray-600"
                  }`}
                >
                  {CHANNEL_ICONS[conv.channel] || <MessageSquare className="h-3.5 w-3.5" />}
                  {conv.channel.toUpperCase()}
                </Badge>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 truncate">
                    {conv.last_message.slice(0, 80)}
                    {conv.last_message.length > 80 && "..."}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(conv.last_message_at), { addSuffix: true })}
                    </span>
                    {conv.unread_count > 0 && (
                      <Badge className="bg-red-500 text-white text-xs px-1.5 py-0">
                        {conv.unread_count}
                      </Badge>
                    )}
                    {conv.sentiment && (
                      <span
                        className={`h-2 w-2 rounded-full ${
                          SENTIMENT_COLORS[conv.sentiment] || "bg-gray-400"
                        }`}
                        title={conv.sentiment}
                      />
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* Optimistic sent messages */}
            {sentMessages.map((m, i) => (
              <div key={`sent-${i}`} className="flex justify-end">
                <div className="max-w-[80%] bg-blue-600 text-white rounded-lg px-3 py-2 text-sm">
                  <p>{m.body}</p>
                  <p className="text-xs text-blue-200 mt-0.5 text-right">
                    {formatDistanceToNow(new Date(m.at), { addSuffix: true })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Compose area */}
        <div className="space-y-2 border-t pt-3">
          <Textarea
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            placeholder="Write a message..."
            className="min-h-[80px] text-sm resize-none"
            disabled={isSending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={handleLoadDraft}
              disabled={loadingDraft || isSending}
            >
              {loadingDraft ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3 text-indigo-500" />
              )}
              Generate Follow-Up
            </Button>
            <Button
              size="sm"
              className="gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white"
              onClick={handleSend}
              disabled={!composeText.trim() || isSending}
            >
              {isSending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Send
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Cmd+Enter to send</p>
        </div>
      </CardContent>
    </Card>
  )
}
