"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Switch } from "@/app/components/ui/switch"
import { Separator } from "@/app/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/app/components/ui/dialog"
import { Rss, Music2, Apple, Youtube, Radio, Loader2, Building2, Lock } from "lucide-react"
import { updateDistributionChannel, createDistributionChannel } from "@/app/actions/podcast-generation"
import { toast } from "sonner"

interface Channel {
  id: string
  channel_name: string
  is_enabled: boolean
  external_show_id: string | null
  distribution_config: Record<string, unknown>
  agent_user_id: string | null
}

interface PodcastChannelsClientProps {
  agentChannels: Channel[]
  brokerageChannels: Channel[]
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

const PLATFORM_LABELS: Record<string, string> = {
  spotify: "Spotify for Podcasters",
  apple: "Apple Podcasts",
  youtube: "YouTube",
  rss: "RSS Feed",
}

const SHOW_ID_LABELS: Record<string, string> = {
  spotify: "Spotify Show ID",
  apple: "Apple Podcast ID",
  youtube: "YouTube Channel ID",
  rss: "RSS Feed URL",
}

const DEFAULT_PLATFORMS = ["spotify", "apple", "youtube", "rss"]

function getChannelColor(name: string) {
  return CHANNEL_COLORS[name.toLowerCase()] ?? "bg-gray-500"
}

function getChannelIcon(name: string) {
  return CHANNEL_ICONS[name.toLowerCase()] ?? <Radio className="h-5 w-5" />
}

export function PodcastChannelsClient({ agentChannels, brokerageChannels }: PodcastChannelsClientProps) {
  const [channels, setChannels] = useState<Channel[]>(agentChannels)
  const [editing, setEditing] = useState<Channel | null>(null)
  const [formData, setFormData] = useState({ isEnabled: false, externalShowId: "" })
  const [saving, setSaving] = useState(false)
  const [seeding, setSeeding] = useState(false)

  function openEdit(ch: Channel) {
    setEditing(ch)
    setFormData({ isEnabled: ch.is_enabled, externalShowId: ch.external_show_id ?? "" })
  }

  async function handleSave() {
    if (!editing) return
    setSaving(true)
    try {
      const res = await updateDistributionChannel(editing.id, {
        isEnabled: formData.isEnabled,
        externalShowId: formData.externalShowId || undefined,
      })
      if (res.success) {
        setChannels(prev => prev.map(c => c.id === editing.id
          ? { ...c, is_enabled: formData.isEnabled, external_show_id: formData.externalShowId || null }
          : c
        ))
        setEditing(null)
        toast.success("Channel updated")
      } else {
        toast.error("Failed to update channel")
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(ch: Channel) {
    setSaving(true)
    try {
      const res = await updateDistributionChannel(ch.id, { isEnabled: !ch.is_enabled })
      if (res.success) {
        setChannels(prev => prev.map(c => c.id === ch.id ? { ...c, is_enabled: !c.is_enabled } : c))
      } else {
        toast.error("Failed to toggle channel")
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleAddPersonalChannels() {
    setSeeding(true)
    try {
      await Promise.all(DEFAULT_PLATFORMS.map(name => createDistributionChannel(name)))
      toast.success("Personal channels created. Refresh to see them.")
    } catch {
      toast.error("Failed to create channels")
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Personal channels */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Personal Distribution Channels</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Your own show credentials — override brokerage defaults for your episodes.
            </p>
          </div>
          {channels.length === 0 && (
            <Button size="sm" onClick={handleAddPersonalChannels} disabled={seeding} className="gap-1.5">
              {seeding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Set Up My Channels
            </Button>
          )}
        </div>

        {channels.length === 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {DEFAULT_PLATFORMS.map(name => (
              <div
                key={name}
                className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-dashed bg-muted/20 opacity-50"
              >
                <div className={`p-2 rounded-lg text-white ${getChannelColor(name)}`}>
                  {getChannelIcon(name)}
                </div>
                <span className="text-xs font-medium capitalize">{PLATFORM_LABELS[name] ?? name}</span>
                <Badge variant="outline" className="text-[10px]">Not configured</Badge>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {channels.map(ch => (
              <Card key={ch.id} className="relative">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2.5 rounded-lg text-white ${getChannelColor(ch.channel_name)}`}>
                        {getChannelIcon(ch.channel_name)}
                      </div>
                      <div>
                        <CardTitle className="text-sm capitalize">
                          {PLATFORM_LABELS[ch.channel_name] ?? ch.channel_name}
                        </CardTitle>
                        <CardDescription className="text-xs">
                          {ch.external_show_id
                            ? `ID: ${ch.external_show_id.slice(0, 14)}...`
                            : "No show ID set"}
                        </CardDescription>
                      </div>
                    </div>
                    <Switch
                      checked={ch.is_enabled}
                      onCheckedChange={() => handleToggle(ch)}
                      disabled={saving}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <Badge variant={ch.is_enabled ? "default" : "secondary"} className="text-[10px]">
                      {ch.is_enabled ? "Active" : "Disabled"}
                    </Badge>
                    <Button variant="outline" size="sm" onClick={() => openEdit(ch)}>
                      Configure
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Brokerage-level inherited channels */}
      {brokerageChannels.length > 0 && (
        <>
          <Separator />
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <div>
                <h3 className="text-base font-semibold">Brokerage Channels</h3>
                <p className="text-sm text-muted-foreground">
                  Inherited from your brokerage — used when you have no personal override.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {brokerageChannels.map(ch => (
                <Card key={ch.id} className="relative opacity-80">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2.5 rounded-lg text-white ${getChannelColor(ch.channel_name)}`}>
                          {getChannelIcon(ch.channel_name)}
                        </div>
                        <div>
                          <CardTitle className="text-sm capitalize flex items-center gap-1.5">
                            {PLATFORM_LABELS[ch.channel_name] ?? ch.channel_name}
                            <Lock className="h-3 w-3 text-muted-foreground" />
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {ch.external_show_id ? `ID: ${ch.external_show_id.slice(0, 14)}...` : "Configured by brokerage"}
                          </CardDescription>
                        </div>
                      </div>
                      <Badge variant="secondary" className="text-[10px]">Inherited</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Badge variant={ch.is_enabled ? "default" : "secondary"} className="text-[10px]">
                      {ch.is_enabled ? "Active at brokerage" : "Disabled at brokerage"}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="capitalize flex items-center gap-2">
              {editing && (
                <div className={`p-1.5 rounded text-white ${getChannelColor(editing.channel_name)}`}>
                  {getChannelIcon(editing.channel_name)}
                </div>
              )}
              Configure {PLATFORM_LABELS[editing?.channel_name ?? ""] ?? editing?.channel_name}
            </DialogTitle>
            <DialogDescription>
              Set your personal show credentials for this platform.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label htmlFor="ch-enabled" className="font-medium">Enable distribution</Label>
              <Switch
                id="ch-enabled"
                checked={formData.isEnabled}
                onCheckedChange={v => setFormData(p => ({ ...p, isEnabled: v }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ch-show-id" className="text-sm">
                {SHOW_ID_LABELS[editing?.channel_name ?? ""] ?? "External Show ID"}
              </Label>
              <Input
                id="ch-show-id"
                value={formData.externalShowId}
                onChange={e => setFormData(p => ({ ...p, externalShowId: e.target.value }))}
                placeholder={
                  editing?.channel_name === "spotify" ? "e.g., 4rOoJ6Egrf8K2IrywzwOMk" :
                  editing?.channel_name === "apple" ? "e.g., 1234567890" :
                  editing?.channel_name === "youtube" ? "e.g., UCxxxxxxxxxxxxxx" :
                  "Enter your show or feed identifier"
                }
              />
              <p className="text-xs text-muted-foreground">
                {editing?.channel_name === "spotify" && "Find your Show ID in your Spotify for Podcasters dashboard."}
                {editing?.channel_name === "apple" && "Find your Podcast ID in Apple Podcasts Connect under My Podcasts."}
                {editing?.channel_name === "youtube" && "Find your Channel ID in YouTube Studio → Settings → Channel → Basic Info."}
                {editing?.channel_name === "rss" && "Your RSS feed is auto-generated. Enter a custom feed URL to override it."}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
