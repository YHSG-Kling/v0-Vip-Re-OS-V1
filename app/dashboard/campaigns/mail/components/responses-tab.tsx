"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table"
import {
  MessageSquare,
  QrCode,
  Globe,
  Phone,
  FileText,
  Reply,
  Calendar,
  TrendingUp,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import type { Campaign, Response } from "../mail-dashboard"

interface ResponsesTabProps {
  responses: Response[]
  campaigns: Campaign[]
  selectedCampaignId: string | null
  onSelectCampaign: (id: string) => void
  loading: boolean
}

const RESPONSE_CONFIG: Record<
  Response["response_type"],
  { color: string; icon: React.ComponentType<{ className?: string }>; label: string }
> = {
  qr_scan: { color: "bg-purple-100 text-purple-700", icon: QrCode, label: "QR Scan" },
  landing_visit: { color: "bg-blue-100 text-blue-700", icon: Globe, label: "Landing Visit" },
  call: { color: "bg-green-100 text-green-700", icon: Phone, label: "Phone Call" },
  form_submit: { color: "bg-amber-100 text-amber-700", icon: FileText, label: "Form Submit" },
  reply: { color: "bg-cyan-100 text-cyan-700", icon: Reply, label: "Reply" },
  appointment: { color: "bg-pink-100 text-pink-700", icon: Calendar, label: "Appointment" },
}

export function ResponsesTab({
  responses,
  campaigns,
  selectedCampaignId,
  onSelectCampaign,
  loading,
}: ResponsesTabProps) {
  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId)

  // Calculate summary stats
  const stats = responses.reduce(
    (acc, response) => {
      acc[response.response_type] = (acc[response.response_type] || 0) + 1
      acc.total++
      return acc
    },
    { total: 0 } as Record<string, number>
  )

  // Calculate response rate if campaign has been mailed
  const responseRate =
    selectedCampaign?.pieces_mailed && selectedCampaign.pieces_mailed > 0
      ? ((stats.total / selectedCampaign.pieces_mailed) * 100).toFixed(2)
      : null

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 bg-muted rounded animate-pulse" />
        <div className="grid grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-64 bg-muted rounded-xl animate-pulse" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Select value={selectedCampaignId || ""} onValueChange={onSelectCampaign}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Select a campaign" />
          </SelectTrigger>
          <SelectContent>
            {campaigns.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.campaign_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {responseRate && (
          <div className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4 text-green-600" />
            <span className="font-medium">{responseRate}% response rate</span>
          </div>
        )}
      </div>

      {!selectedCampaignId ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
          <CardTitle className="text-lg mb-2">Select a Campaign</CardTitle>
          <CardDescription>
            Choose a campaign to view response data.
          </CardDescription>
        </Card>
      ) : responses.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
          <CardTitle className="text-lg mb-2">No Responses Yet</CardTitle>
          <CardDescription>
            Responses will appear here as recipients engage with your mail pieces.
          </CardDescription>
        </Card>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {Object.entries(RESPONSE_CONFIG).map(([type, config]) => {
              const Icon = config.icon
              const count = stats[type] || 0
              return (
                <Card key={type}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <div className={`p-1.5 rounded ${config.color}`}>
                        <Icon className="h-3 w-3" />
                      </div>
                      <CardDescription className="text-xs">{config.label}</CardDescription>
                    </div>
                    <CardTitle className="text-2xl">{count}</CardTitle>
                  </CardHeader>
                </Card>
              )
            })}
          </div>

          {/* Responses Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Recent Responses</CardTitle>
              <CardDescription>
                {stats.total} total response{stats.total !== 1 ? "s" : ""} from this campaign
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {responses.map((response) => {
                    const config = RESPONSE_CONFIG[response.response_type]
                    const Icon = config.icon
                    const contact = response.contacts

                    return (
                      <TableRow key={response.id}>
                        <TableCell>
                          <Badge className={`gap-1 ${config.color}`}>
                            <Icon className="h-3 w-3" />
                            {config.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {contact ? (
                            <div>
                              <div className="font-medium">
                                {contact.first_name} {contact.last_name}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                {contact.email || contact.phone}
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">Unknown</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {response.response_metadata ? (
                            <code className="text-xs bg-muted px-1 py-0.5 rounded">
                              {JSON.stringify(response.response_metadata).slice(0, 50)}
                              {JSON.stringify(response.response_metadata).length > 50 && "..."}
                            </code>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDistanceToNow(new Date(response.created_at))} ago
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
