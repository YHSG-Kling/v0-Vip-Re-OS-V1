"use client"

import { useState } from "react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Switch } from "@/app/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/app/components/ui/dialog"
import { Rss, Music2, Apple, Youtube, Loader2, ExternalLink, Radio, Plus } from "lucide-react"
import { updateDistributionChannel, createDistributionChannel } from "@/app/actions/podcast-generation"

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
  onUpdate: () => void
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

const DEFAULT_CHANNELS = ["spotify", "apple", "youtube", "rss"]

export function DistributionChannelsTab({ channels, loading, onUpdate, isAdmin = false }: DistributionChannelsTabProps) {
  const [editingChannel, setEditingChannel] = useState<DistributionChannel | null>(null)
  const [processing, setProcessing] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [formData, setFormData] = useState({
    isEnabled: false,
    externalShowId: "",
  })

  function openEditDialog(channel: DistributionChannel) {
    setEditingChannel(channel)
    setFormData({
      isEnabled: channel.is_enabled,
      externalShowId: channel.external_show_id || "",
    })
  }

  function closeDialog() {
    setEditingChannel(null)
    setFormData({ isEnabled: false, externalShowId: "" })
  }

  async function handleSave() {
    if (!editingChannel) return

    setProcessing(true)
    try {
      const result = await updateDistributionChannel(editingChannel.id, {
        isEnabled: formData.isEnabled,
        externalShowId: formData.externalShowId || undefined,
      })

      if (result.success) {
        onUpdate()
        closeDialog()
      } else {
        console.error("Failed to update channel:", result.error)
      }
    } finally {
      setProcessing(false)
    }
  }

  async function handleToggle(channel: DistributionChannel) {
    setProcessing(true)
    try {
      const result = await updateDistributionChannel(channel.id, {
        isEnabled: !channel.is_enabled,
      })

      if (result.success) {
        onUpdate()
      } else {
        console.error("Failed to toggle channel:", result.error)
      }
    } finally {
      setProcessing(false)
    }
  }

  async function handleSeedChannels() {
    setSeeding(true)
    try {
      await Promise.all(DEFAULT_CHANNELS.map((name) => createDistributionChannel(name)))
      onUpdate()
    } finally {
      setSeeding(false)
    }
  }

  function getChannelIcon(channelName: string) {
    const name = channelName.toLowerCase()
    return CHANNEL_ICONS[name] || <Radio className="h-5 w-5" />
  }

  function getChannelColor(channelName: string) {
    const name = channelName.toLowerCase()
    return CHANNEL_COLORS[name] || "bg-gray-500"
  }

  function getChannelDocs(channelName: string): { url: string; label: string } | null {
    const docs: Record<string, { url: string; label: string }> = {
      spotify: {
        url: "https://podcasters.spotify.com/",
        label: "Spotify for Podcasters",
      },
      apple: {
        url: "https://podcasters.apple.com/",
        label: "Apple Podcasts Connect",
      },
      youtube: {
        url: "https://studio.youtube.com/",
        label: "YouTube Studio",
      },
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

  if (channels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="p-4 bg-gray-100 rounded-full mb-4">
          <Radio className="h-8 w-8 text-gray-400" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">No distribution channels</h3>
        {isAdmin ? (
          <>
            <p className="text-sm text-gray-500 max-w-sm mb-4">
              Set up distribution channels to publish your podcast to Spotify, Apple Podcasts, YouTube, and RSS.
            </p>
            <Button onClick={handleSeedChannels} disabled={seeding}>
              {seeding ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Initializing...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-2" />
                  Initialize Distribution Channels
                </>
              )}
            </Button>
          </>
        ) : (
          <div className="space-y-4 w-full max-w-md">
            <div className="grid grid-cols-2 gap-3">
              {(["spotify", "apple", "youtube", "rss"] as const).map((name) => (
                <div
                  key={name}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border bg-muted/30 opacity-60"
                >
                  <div className={`p-2 rounded-lg text-white ${getChannelColor(name)}`}>
                    {getChannelIcon(name)}
                  </div>
                  <span className="text-xs capitalize font-medium">{name === "apple" ? "Apple Podcasts" : name}</span>
                  <span className="text-[10px] text-muted-foreground">Not configured</span>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Channels follow brokerage → team → agent hierarchy.{" "}
              <a
                href="/dashboard/settings/podcast-channels"
                className="text-primary underline underline-offset-2 hover:no-underline"
              >
                Configure your personal channels
              </a>{" "}
              or contact your administrator for brokerage-level setup.
            </p>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Configure where your podcast episodes are distributed. Enable channels and provide the required IDs to start distributing.
        </p>
        {isAdmin && (
          <Button variant="outline" size="sm" onClick={handleSeedChannels} disabled={seeding}>
            {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Add Channels
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {channels.map((channel) => {
          const docs = getChannelDocs(channel.channel_name)

          return (
            <Card key={channel.id} className="relative">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2.5 rounded-lg text-white ${getChannelColor(channel.channel_name)}`}
                    >
                      {getChannelIcon(channel.channel_name)}
                    </div>
                    <div>
                      <CardTitle className="text-base capitalize">
                        {channel.channel_name}
                      </CardTitle>
                      <CardDescription>
                        {channel.external_show_id
                          ? `Show ID: ${channel.external_show_id.slice(0, 12)}...`
                          : "Not configured"}
                      </CardDescription>
                    </div>
                  </div>
                  <Switch
                    checked={channel.is_enabled}
                    onCheckedChange={() => handleToggle(channel)}
                    disabled={processing}
                  />
                </div>
              </CardHeader>

              <CardContent>
                <div className="flex items-center justify-between">
                  <Badge variant={channel.is_enabled ? "default" : "secondary"}>
                    {channel.is_enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <div className="flex items-center gap-2">
                    {docs && (
                      <Button variant="ghost" size="sm" asChild>
                        <a href={docs.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-1" />
                          {docs.label}
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEditDialog(channel)}
                    >
                      Configure
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editingChannel} onOpenChange={closeDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="capitalize">
              Configure {editingChannel?.channel_name}
            </DialogTitle>
            <DialogDescription>
              Update the distribution settings for this channel.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="enabled">Enable Distribution</Label>
              <Switch
                id="enabled"
                checked={formData.isEnabled}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, isEnabled: checked })
                }
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="showId">
                {editingChannel?.channel_name === "youtube"
                  ? "YouTube Channel ID"
                  : editingChannel?.channel_name === "spotify"
                    ? "Spotify Show ID"
                    : editingChannel?.channel_name === "apple"
                      ? "Apple Podcast ID"
                      : "External Show ID"}
              </Label>
              <Input
                id="showId"
                value={formData.externalShowId}
                onChange={(e) =>
                  setFormData({ ...formData, externalShowId: e.target.value })
                }
                placeholder={
                  editingChannel?.channel_name === "spotify"
                    ? "e.g., 4rOoJ6Egrf8K2IrywzwOMk"
                    : "Enter your show/channel ID"
                }
              />
              <p className="text-xs text-gray-500">
                {editingChannel?.channel_name === "spotify" && (
                  <>Find your Show ID in Spotify for Podcasters dashboard.</>
                )}
                {editingChannel?.channel_name === "apple" && (
                  <>Find your Podcast ID in Apple Podcasts Connect.</>
                )}
                {editingChannel?.channel_name === "youtube" && (
                  <>Find your Channel ID in YouTube Studio settings.</>
                )}
                {editingChannel?.channel_name === "rss" && (
                  <>RSS feeds are automatically generated.</>
                )}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={processing}>
              {processing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
