"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sparkles, Phone, MessageSquare, Mail, Home, FileText } from "lucide-react"
import Link from "next/link"

interface SuggestedAction {
  action: string
  reason: string
  channel?: string
  urgency?: string
}

interface NextBestActionPanelProps {
  suggestedActions: SuggestedAction[]
  contactId: string
  contactPhone?: string | null
  contactEmail?: string | null
  onSendMessage: (channel: string) => void
  onLogActivity: () => void
  onOpenPortal: () => void
}

export function NextBestActionPanel({
  suggestedActions,
  contactId,
  contactPhone,
  contactEmail,
  onSendMessage,
  onLogActivity,
  onOpenPortal,
}: NextBestActionPanelProps) {
  const topAction = suggestedActions[0]
  const remainingActions = suggestedActions.slice(1, 3)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          Next Best Action
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Top suggested action */}
        {topAction && (
          <div
            className={`p-3 rounded-lg mb-4 ${
              topAction.urgency === "high"
                ? "bg-amber-50 border border-amber-200"
                : "bg-gray-50 border border-gray-200"
            }`}
          >
            <p className="font-medium text-sm text-gray-900">{topAction.action}</p>
            <p className="text-xs text-muted-foreground mt-1">{topAction.reason}</p>
            {topAction.channel && (
              <Badge variant="outline" className="mt-2 text-xs">
                {topAction.channel}
              </Badge>
            )}
          </div>
        )}

        {/* Action buttons row */}
        <div className="flex flex-wrap gap-2 mb-4">
          {contactPhone && (
            <Button variant="outline" size="sm" asChild>
              <a href={`tel:${contactPhone}`}>
                <Phone className="h-4 w-4 mr-1" />
                Call
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onSendMessage("sms")}>
            <MessageSquare className="h-4 w-4 mr-1" />
            Message
          </Button>
          {contactEmail && (
            <Button variant="outline" size="sm" onClick={() => onSendMessage("email")}>
              <Mail className="h-4 w-4 mr-1" />
              Email
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onOpenPortal}>
            <Home className="h-4 w-4 mr-1" />
            Portal
          </Button>
          <Button variant="outline" size="sm" onClick={onLogActivity}>
            <FileText className="h-4 w-4 mr-1" />
            Log Activity
          </Button>
        </div>

        {/* Remaining suggestions */}
        {remainingActions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {remainingActions.map((action, idx) => (
              <Badge key={idx} variant="secondary" className="text-xs">
                {action.action}
              </Badge>
            ))}
          </div>
        )}

        {suggestedActions.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            AI is analyzing this contact for recommendations...
          </p>
        )}
      </CardContent>
    </Card>
  )
}
