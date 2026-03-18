"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Megaphone, Globe, Mail, Instagram, Facebook, CheckCircle2 } from "lucide-react"

interface MarketingChannel {
  name: string
  status: "live" | "scheduled" | "not_started"
  description?: string
}

interface SellerMarketingLiveCardProps {
  channels: MarketingChannel[]
  marketingTier?: string | null
  totalReach?: number
}

export function SellerMarketingLiveCard({
  channels,
  marketingTier,
  totalReach,
}: SellerMarketingLiveCardProps) {
  const liveChannels = channels.filter(c => c.status === "live")
  const scheduledChannels = channels.filter(c => c.status === "scheduled")

  const channelIcons: Record<string, React.ReactNode> = {
    MLS: <Globe className="h-4 w-4" />,
    Zillow: <Globe className="h-4 w-4" />,
    "Realtor.com": <Globe className="h-4 w-4" />,
    Email: <Mail className="h-4 w-4" />,
    Instagram: <Instagram className="h-4 w-4" />,
    Facebook: <Facebook className="h-4 w-4" />,
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Megaphone className="h-4 w-4" />
            Marketing Live Now
          </CardTitle>
          {marketingTier && (
            <Badge variant="secondary" className="text-xs">
              {marketingTier}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Plain Language Summary */}
        <p className="text-sm text-muted-foreground">
          {liveChannels.length > 0 ? (
            <>
              Your home is being promoted on{" "}
              <span className="font-medium text-foreground">{liveChannels.length} channels</span> right now.
              {totalReach && totalReach > 0 && (
                <> Potential reach: <span className="font-medium text-foreground">{totalReach.toLocaleString()}+</span> buyers.</>
              )}
            </>
          ) : (
            "Marketing will begin once your listing goes live."
          )}
        </p>

        {/* Live Channels */}
        {liveChannels.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Active Now</p>
            <div className="flex flex-wrap gap-2">
              {liveChannels.map((channel) => (
                <div
                  key={channel.name}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200"
                >
                  {channelIcons[channel.name] || <CheckCircle2 className="h-4 w-4" />}
                  <span className="text-sm font-medium text-emerald-800">{channel.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scheduled Channels */}
        {scheduledChannels.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Coming Soon</p>
            <div className="flex flex-wrap gap-2">
              {scheduledChannels.map((channel) => (
                <div
                  key={channel.name}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/50 border"
                >
                  {channelIcons[channel.name] || <CheckCircle2 className="h-4 w-4 text-muted-foreground" />}
                  <span className="text-sm text-muted-foreground">{channel.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* What This Means */}
        <div className="pt-2 border-t">
          <p className="text-xs text-muted-foreground">
            Your agent is actively promoting your home to maximize buyer exposure. Marketing performance is tracked and adjusted as needed.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
