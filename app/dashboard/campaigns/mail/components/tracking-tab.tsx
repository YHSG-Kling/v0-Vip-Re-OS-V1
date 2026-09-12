"use client"

import { useEffect, useState } from "react"
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
import { Truck, Package, CheckCircle, AlertCircle, Clock, QrCode, ScanLine } from "lucide-react"
import { formatDistanceToNow, format } from "date-fns"
import type { Campaign, TrackingRecord } from "../mail-dashboard"
import { getCampaignQrScans } from "@/app/actions/direct-mail"

interface TrackingTabProps {
  tracking: TrackingRecord[]
  campaigns: Campaign[]
  selectedCampaignId: string | null
  onSelectCampaign: (id: string) => void
  loading: boolean
}

const STATUS_CONFIG: Record<
  string,
  { color: string; icon: React.ComponentType<{ className?: string }>; label: string }
> = {
  pending: { color: "bg-muted text-muted-foreground", icon: Clock, label: "Pending" },
  in_transit: { color: "bg-blue-100 text-blue-700", icon: Truck, label: "In Transit" },
  processed: { color: "bg-amber-100 text-amber-700", icon: Package, label: "Processed" },
  delivered: { color: "bg-green-100 text-green-700", icon: CheckCircle, label: "Delivered" },
  returned: { color: "bg-red-100 text-red-700", icon: AlertCircle, label: "Returned" },
  unknown: { color: "bg-muted text-muted-foreground", icon: Package, label: "Unknown" },
}

export function TrackingTab({
  tracking,
  campaigns,
  selectedCampaignId,
  onSelectCampaign,
  loading,
}: TrackingTabProps) {
  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId)

  const [qrData, setQrData] = useState<{
    totalScans: number
    firstScans: number
    repeatScans: number
    byDay: { date: string; count: number }[]
  } | null>(null)
  const [qrLoading, setQrLoading] = useState(false)

  useEffect(() => {
    if (!selectedCampaignId) { setQrData(null); return }
    setQrLoading(true)
    getCampaignQrScans(selectedCampaignId).then((res) => {
      if (res.success) {
        setQrData({
          totalScans: res.totalScans ?? 0,
          firstScans: res.firstScans ?? 0,
          repeatScans: res.repeatScans ?? 0,
          byDay: res.byDay ?? [],
        })
      }
    }).finally(() => setQrLoading(false))
  }, [selectedCampaignId])

  // Calculate summary stats
  const stats = tracking.reduce(
    (acc, record) => {
      const status = record.provider_delivery_status || "unknown"
      acc[status] = (acc[status] || 0) + 1
      acc.total++
      return acc
    },
    { total: 0 } as Record<string, number>
  )

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-64 bg-muted rounded animate-pulse" />
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
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
      </div>

      {!selectedCampaignId ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <Truck className="h-12 w-12 text-muted-foreground mb-4" />
          <CardTitle className="text-lg mb-2">Select a Campaign</CardTitle>
          <CardDescription>
            Choose a campaign to view delivery tracking information.
          </CardDescription>
        </Card>
      ) : selectedCampaign?.status === "planning" || selectedCampaign?.status === "approved" ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <Clock className="h-12 w-12 text-muted-foreground mb-4" />
          <CardTitle className="text-lg mb-2">Campaign Not Yet Mailed</CardTitle>
          <CardDescription>
            Tracking information will appear once the campaign has been sent.
          </CardDescription>
        </Card>
      ) : tracking.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <Package className="h-12 w-12 text-muted-foreground mb-4" />
          <CardTitle className="text-lg mb-2">No Tracking Data</CardTitle>
          <CardDescription>
            Delivery tracking updates will appear here as they are received.
          </CardDescription>
        </Card>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Tracked</CardDescription>
                <CardTitle className="text-2xl">{stats.total}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Delivered</CardDescription>
                <CardTitle className="text-2xl text-green-600">
                  {stats.delivered || 0}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>In Transit</CardDescription>
                <CardTitle className="text-2xl text-blue-600">
                  {stats.in_transit || 0}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Returned</CardDescription>
                <CardTitle className="text-2xl text-red-600">
                  {stats.returned || 0}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          {/* QR Scan Analytics */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <QrCode className="h-4 w-4 text-primary" />
                QR Code Performance
              </CardTitle>
              <CardDescription>Scans from the campaign tracking QR code</CardDescription>
            </CardHeader>
            <CardContent>
              {qrLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <ScanLine className="h-4 w-4 animate-pulse" />
                  Loading scan data…
                </div>
              ) : !qrData || qrData.totalScans === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No QR scans recorded yet for this campaign. Tracking activates when the first piece is mailed.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-2xl font-bold">{qrData.totalScans}</p>
                      <p className="text-xs text-muted-foreground">Total Scans</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-2xl font-bold text-blue-600">{qrData.firstScans}</p>
                      <p className="text-xs text-muted-foreground">First Scans</p>
                    </div>
                    <div className="rounded-lg border p-3 text-center">
                      <p className="text-2xl font-bold text-amber-600">{qrData.repeatScans}</p>
                      <p className="text-xs text-muted-foreground">Repeat Scans</p>
                    </div>
                  </div>
                  {qrData.byDay.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Scans by Day</p>
                      {(() => {
                        const maxCount = Math.max(...qrData.byDay.map((d) => d.count), 1)
                        return (
                          <div className="space-y-1">
                            {qrData.byDay.map((d) => (
                              <div key={d.date} className="flex items-center gap-2 text-xs">
                                <span className="w-20 text-muted-foreground shrink-0">
                                  {format(new Date(d.date + "T00:00:00"), "MMM d")}
                                </span>
                                <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                                  <div
                                    className="h-2 bg-primary rounded-full"
                                    style={{ width: `${(d.count / maxCount) * 100}%` }}
                                  />
                                </div>
                                <span className="w-6 text-right font-medium">{d.count}</span>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Tracking Table */}
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mailed</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead>Returned</TableHead>
                  <TableHead>Last Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tracking.map((record) => {
                  const status = record.provider_delivery_status || "unknown"
                  const config = STATUS_CONFIG[status] || STATUS_CONFIG.unknown
                  const StatusIcon = config.icon

                  return (
                    <TableRow key={record.id}>
                      <TableCell className="font-mono text-sm">
                        {record.batch_id.slice(0, 12)}...
                      </TableCell>
                      <TableCell>
                        <Badge className={`gap-1 ${config.color}`}>
                          <StatusIcon className="h-3 w-3" />
                          {config.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {record.mailed_at
                          ? format(new Date(record.mailed_at), "MMM d, h:mm a")
                          : "-"}
                      </TableCell>
                      <TableCell>
                        {record.delivered_at
                          ? format(new Date(record.delivered_at), "MMM d, h:mm a")
                          : "-"}
                      </TableCell>
                      <TableCell>
                        {record.returned_at
                          ? format(new Date(record.returned_at), "MMM d, h:mm a")
                          : "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDistanceToNow(new Date(record.created_at))} ago
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}
