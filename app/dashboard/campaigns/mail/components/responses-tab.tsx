"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import { trackCampaignResponse } from "@/app/actions/ai-direct-mail"
import type { Campaign, Response } from "../mail-dashboard"

/**
 * Render the response metadata cell, or null when there is nothing to show.
 *
 * EMPTINESS, NOT TRUTHINESS. `mail_response_tracking.response_metadata` is a
 * nullable jsonb with column DEFAULT '{}' (verified live). Both writers pass
 * `?? null`, so today's rows are NULL — but any INSERT that omits the column
 * takes the default and lands `{}`, which is TRUTHY in JS. The previous
 * `metadata ? … : "-"` therefore printed a bare "{}" for those rows and "-" for
 * the others: one fact, two cells. An empty object and an absent one both mean
 * "the responder told us nothing", so this collapses them (§6) rather than
 * teaching the reader a second spelling.
 */
function metadataSummary(metadata: unknown) {
  if (metadata === null || metadata === undefined) return null
  const json = JSON.stringify(metadata)
  // "{}" / "[]" / '""' — serialised nothing, in every shape jsonb can hold it.
  if (!json || json === "{}" || json === "[]" || json === '""') return null
  return (
    <code className="text-xs bg-muted px-1 py-0.5 rounded">
      {json.slice(0, 50)}
      {json.length > 50 && "..."}
    </code>
  )
}

interface ResponsesTabProps {
  responses: Response[]
  campaigns: Campaign[]
  selectedCampaignId: string | null
  onSelectCampaign: (id: string) => void
  loading: boolean
  /** Reload campaign detail after a response is logged. */
  onResponseLogged?: () => void
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
  onResponseLogged,
}: ResponsesTabProps) {
  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId)

  // Operator-side response logging. QR scans attribute themselves anonymously via
  // /api/qr/scan, but the responses that arrive by PHONE or by someone typing the
  // landing URL off the postcard have no automatic signal at all — the agent is the
  // only witness, and until now there was nowhere to record them, so response rate
  // and cost-per-response undercounted every non-QR response.
  //
  // Keyed on the tracking code PRINTED ON THE PIECE (direct_mail_campaigns.tracking_id),
  // which is what a caller reads out. The action resolves the campaign from that code
  // and refuses one outside the caller's brokerage — the code is low-entropy and
  // printed, so it is an addressing key, never an authorization.
  const [logCode, setLogCode] = useState("")
  const [logType, setLogType] = useState<"call" | "website_visit" | "form_submission" | "qr_scan">("call")
  const [logMsg, setLogMsg] = useState<string | null>(null)
  const [logErr, setLogErr] = useState<string | null>(null)
  const [logging, startLogging] = useTransition()

  function handleLogResponse() {
    setLogMsg(null)
    setLogErr(null)
    const code = logCode.trim()
    if (!code) {
      setLogErr("Enter the tracking code printed on the mail piece.")
      return
    }
    startLogging(async () => {
      const res = await trackCampaignResponse({ trackingId: code, responseType: logType })
      if (!res.success) {
        setLogErr(res.error ?? "The response could not be recorded")
        return
      }
      setLogMsg("Response recorded.")
      setLogCode("")
      onResponseLogged?.()
    })
  }

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

      {/* Log a response that arrived off-platform (a call, a typed-in landing URL). */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Log a response</CardTitle>
          <CardDescription>
            Someone called or came in off a mail piece? Enter the tracking code printed
            on it so this campaign gets credit in the response rate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {logMsg && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              {logMsg}
            </p>
          )}
          {logErr && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {logErr}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Tracking code</Label>
              <Input
                className="h-9 w-56"
                value={logCode}
                onChange={(e) => setLogCode(e.target.value)}
                placeholder="dm-…"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Response type</Label>
              <Select value={logType} onValueChange={(v) => setLogType(v as typeof logType)}>
                <SelectTrigger className="h-9 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call">Phone call</SelectItem>
                  <SelectItem value="website_visit">Landing visit</SelectItem>
                  <SelectItem value="form_submission">Form submit</SelectItem>
                  <SelectItem value="qr_scan">QR scan</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={handleLogResponse} disabled={logging}>
              {logging ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Log response
            </Button>
          </div>
        </CardContent>
      </Card>

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
                          {/* "No metadata" arrives in TWO spellings and only one of them was
                              handled (§6). mail_response_tracking.response_metadata is a
                              NULLABLE jsonb whose column DEFAULT is '{}' (verified live),
                              while both writers pass `?? null` explicitly — so a row written
                              by the current writers is NULL and a row from any INSERT that
                              omits the column is `{}`. `{}` is TRUTHY, so the truthiness test
                              alone rendered a literal "{}" for the second kind and "-" for the
                              first: the same fact, two different cells. Emptiness is what the
                              reader actually cares about, so it asks that instead. */}
                          {metadataSummary(response.response_metadata) ?? "-"}
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
