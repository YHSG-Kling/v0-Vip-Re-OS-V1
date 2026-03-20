"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MessageSquare, Mail, Phone, Globe, Loader2 } from "lucide-react"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"

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
  onLoadDraft: (conversationId: string) => Promise<void>
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
}: CommunicationHealthPanelProps) {
  const [loadingDraft, setLoadingDraft] = useState<string | null>(null)

  const sorted = [...conversations].sort(
    (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
  )

  const handleLoadDraft = async (conversationId: string) => {
    setLoadingDraft(conversationId)
    try {
      await onLoadDraft(conversationId)
    } finally {
      setLoadingDraft(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-blue-600" />
          Communications
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="text-center py-6">
            <MessageSquare className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No conversations yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sorted.slice(0, 3).map((conv) => (
              <div
                key={conv.id}
                className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg"
              >
                <Badge className={`flex items-center gap-1 ${CHANNEL_COLORS[conv.channel] || "bg-gray-100 text-gray-600"}`}>
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
                        className={`h-2 w-2 rounded-full ${SENTIMENT_COLORS[conv.sentiment] || "bg-gray-400"}`}
                        title={conv.sentiment}
                      />
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Link href="/crm">
                    <Button variant="outline" size="sm" className="text-xs">
                      Open
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => handleLoadDraft(conv.id)}
                    disabled={loadingDraft === conv.id}
                  >
                    {loadingDraft === conv.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Load AI Draft"
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
