"use client"

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Rss, Music2, Apple, Youtube, ExternalLink, Radio, Settings2 } from "lucide-react"

interface DistributionChannel {
  id: string
  channel_name: string
  is_enabled: boolean
  external_show_id: string | null
  distribution_config: Record<string, any>
}

interface DistributionChannelsTabProps {
  channels: DistributionChannel[]
  loading: boolean
  // Kept for call-site compatibility; this view is read-only (editing lives in Settings).
  onUpdate?: () => void
  isAdmin?: boolean
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  spotify: <Music2 className="h-5 w-5" />,
  apple: <Apple className="h-5 w-5" />,
  youtube: <Youtube className="h-5 w-5" />,
  rss: <Rss className="h-5 w-5" />,
}

const CHANNEL_COLORS: Record<string, string> = {
  spotify: "bg-green-500",
  apple: "bg-purple-500",
  youtube: "bg-red-500",
  rss: "bg-orange-500",
}

const SETTINGS_HREF = "/dashboard/settings/podcast-channels"

/**
 * READ-ONLY syndication status. The channel EDITOR lives on the main Settings
 * page (/dashboard/settings/podcast-channels) — the single source of truth,
 * hierarchy-aware (brokerage → personal). The Podcast Studio is a syndication
 * studio: it shows WHERE finished episodes are published and links out to
 * Settings to configure them, rather than duplicating the editor here.
 */
export function DistributionChannelsTab({ channels, loading }: DistributionChannelsTabProps) {
  function getChannelIcon(channelName: string) {
    return CHANNEL_ICONS[channelName.toLowerCase()] || <Radio className="h-5 w-5" />
  }

  function getChannelColor(channelName: string) {
    return CHANNEL_COLORS[channelName.toLowerCase()] || "bg-gray-500"
  }

  function getChannelDocs(channelName: string): { url: string; label: string } | null {
    const docs: Record<string, { url: string; label: string }> = {
      spotify: { url: "https://podcasters.spotify.com/", label: "Spotify for Podcasters" },
      apple: { url: "https://podcasters.apple.com/", label: "Apple Podcasts Connect" },
      youtube: { url: "https://studio.youtube.com/", label: "YouTube Studio" },
    }
    return docs[channelName.toLowerCase()] || null
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-gray-200 rounded-lg" />
                <div className="flex-1">
                  <div className="h-5 bg-gray-200 rounded w-24" />
                  <div className="h-4 bg-gray-200 rounded w-32 mt-1" />
                </div>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Setup lives in Settings — this studio only syndicates to those channels. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border bg-muted/30 p-4">
        <div>
          <p className="text-sm font-medium">Distribution channels are configured in Settings</p>
          <p className="text-sm text-muted-foreground">
            Your podcast syndicates to the channels set up on the main Settings page. Enable channels and
            add show IDs there, then publish episodes here.
          </p>
        </div>
        <Button asChild className="shrink-0">
          <a href={SETTINGS_HREF}>
            <Settings2 className="h-4 w-4 mr-2" />
            Manage Channels
          </a>
        </Button>
      </div>

      {channels.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center">
          <div className="p-4 bg-gray-100 rounded-full mb-4">
            <Radio className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No distribution channels yet</h3>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            Set up Spotify, Apple Podcasts, YouTube, and RSS in Settings to start syndicating your show.
          </p>
          <Button asChild variant="outline">
            <a href={SETTINGS_HREF}>
              <Settings2 className="h-4 w-4 mr-2" />
              Set Up Channels in Settings
            </a>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {channels.map((channel) => {
            const docs = getChannelDocs(channel.channel_name)
            return (
              <Card key={channel.id} className="relative">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-lg text-white ${getChannelColor(channel.channel_name)}`}>
                      {getChannelIcon(channel.channel_name)}
                    </div>
                    <div>
                      <CardTitle className="text-base capitalize">{channel.channel_name}</CardTitle>
                      <CardDescription>
                        {channel.external_show_id
                          ? `Show ID: ${channel.external_show_id.slice(0, 12)}…`
                          : "Not configured"}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <Badge variant={channel.is_enabled ? "default" : "secondary"}>
                      {channel.is_enabled ? "Syndicating" : "Disabled"}
                    </Badge>
                    {docs && (
                      <Button variant="ghost" size="sm" asChild>
                        <a href={docs.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-1" />
                          {docs.label}
                        </a>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
