"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Mail, Users, Eye, MousePointer, MessageSquare, Clock, Send } from "lucide-react"

interface EmailCampaignPanelProps {
  transactionId: string
  campaigns?: Array<{
    id: string
    type: string
    recipients: number
    opens?: number
    clicks?: number
    replies?: number
    status: string
    sent_date?: string
    scheduled_date?: string
  }>
}

export function EmailCampaignPanel({ transactionId, campaigns = [] }: EmailCampaignPanelProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email Campaigns
          </CardTitle>
          <Button size="sm">
            <Send className="mr-2 h-4 w-4" />
            Create Campaign
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {campaigns.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <Mail className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>No email campaigns yet</p>
            <p className="text-sm">Create your first campaign to reach potential buyers</p>
          </div>
        ) : (
          campaigns.map((campaign) => (
            <EmailCampaignCard key={campaign.id} {...campaign} />
          ))
        )}

        {/* Example campaigns for demo */}
        {campaigns.length === 0 && (
          <>
            <EmailCampaignCard
              id="demo-1"
              type="Coming Soon Announcement"
              recipients={234}
              opens={156}
              clicks={34}
              replies={8}
              status="sent"
              sent_date="Jan 15"
            />
            <EmailCampaignCard
              id="demo-2"
              type="MLS Launch Notification"
              recipients={450}
              status="scheduled"
              scheduled_date="Jan 18"
            />
            <EmailCampaignCard
              id="demo-3"
              type="Open House Invitation"
              recipients={89}
              status="draft"
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

interface EmailCampaignCardProps {
  id: string
  type: string
  recipients: number
  opens?: number
  clicks?: number
  replies?: number
  status: string
  sent_date?: string
  scheduled_date?: string
}

function EmailCampaignCard({
  type,
  recipients,
  opens = 0,
  clicks = 0,
  replies = 0,
  status,
  sent_date,
  scheduled_date,
}: EmailCampaignCardProps) {
  const getStatusVariant = () => {
    if (status === "sent") return "default"
    if (status === "scheduled") return "secondary"
    if (status === "sending") return "outline"
    return "outline"
  }

  const getStatusIcon = () => {
    if (status === "sent") return <Send className="h-3 w-3" />
    if (status === "scheduled") return <Clock className="h-3 w-3" />
    return null
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{type}</p>
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Users className="h-3 w-3" />
            {recipients} recipients
          </p>
        </div>
        <Badge variant={getStatusVariant()} className="flex items-center gap-1">
          {getStatusIcon()}
          {status}
        </Badge>
      </div>

      {status === "sent" && (
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="flex flex-col">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Eye className="h-3 w-3" />
              Opens
            </p>
            <p className="font-medium">
              {opens} <span className="text-xs text-muted-foreground">({((opens / recipients) * 100).toFixed(1)}%)</span>
            </p>
          </div>
          <div className="flex flex-col">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <MousePointer className="h-3 w-3" />
              Clicks
            </p>
            <p className="font-medium">
              {clicks} <span className="text-xs text-muted-foreground">({((clicks / recipients) * 100).toFixed(1)}%)</span>
            </p>
          </div>
          <div className="flex flex-col">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              Replies
            </p>
            <p className="font-medium">{replies}</p>
          </div>
        </div>
      )}

      {status === "scheduled" && (
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Scheduled for {scheduled_date}</span>
        </div>
      )}

      {status === "draft" && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1 bg-transparent">
            Edit
          </Button>
          <Button size="sm" className="flex-1">
            Schedule Send
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {sent_date ? `Sent ${sent_date}` : scheduled_date ? `Scheduled for ${scheduled_date}` : "Draft - not sent"}
      </p>
    </div>
  )
}
