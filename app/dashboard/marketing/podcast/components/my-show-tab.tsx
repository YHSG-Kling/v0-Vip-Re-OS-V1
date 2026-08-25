"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import { Badge } from "@/app/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import {
  Mic,
  AlertCircle,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Save,
  Loader2,
  ImagePlus,
  PlugZap,
} from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"
import {
  getPodcastShowSettings,
  savePodcastShowSettings,
  uploadPodcastCoverArt,
  testDistributionChannelConnection,
} from "@/app/actions/podcast-generation"

const PODCAST_CATEGORIES = [
  "Business",
  "Education",
  "Entrepreneurship",
  "Investing",
  "Real Estate",
  "Finance",
  "Self-Improvement",
  "Society & Culture",
  "Technology",
]

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "pt", label: "Portuguese" },
]

interface ShowSettings {
  showName: string
  hostName: string
  description: string
  category: string
  language: string
  websiteUrl: string
  coverArtUrl: string | null
}

interface ChannelLite {
  id: string
  channel_name?: string
  platform_name?: string
  platform?: string
  name?: string
  is_enabled?: boolean
  enabled?: boolean
  external_show_id?: string | null
}

interface Props {
  channels: ChannelLite[]
  hasVoiceClone?: boolean
}

type ConnTestState = { ok: boolean; message: string } | null

export function MyShowTab({ channels, hasVoiceClone }: Props) {
  const [settings, setSettings] = useState<ShowSettings>({
    showName: "",
    hostName: "",
    description: "",
    category: "Real Estate",
    language: "en",
    websiteUrl: "",
    coverArtUrl: null,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, ConnTestState>>({})
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await getPodcastShowSettings()
      if (cancelled) return
      if (res.success && res.settings) {
        const s: any = res.settings
        setSettings({
          showName: s.show_name ?? "",
          hostName: s.host_name ?? "",
          description: s.description ?? "",
          category: s.category ?? "Real Estate",
          language: s.language ?? "en",
          websiteUrl: s.website_url ?? "",
          coverArtUrl: s.cover_art_url ?? null,
        })
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const res = await savePodcastShowSettings({
        showName: settings.showName,
        hostName: settings.hostName,
        description: settings.description,
        category: settings.category,
        language: settings.language,
        coverArtUrl: settings.coverArtUrl ?? undefined,
        websiteUrl: settings.websiteUrl,
      })
      if (res.success) toast.success("Show settings saved.")
      else toast.error(res.error ?? "Could not save show settings.")
    } finally {
      setSaving(false)
    }
  }

  async function handleCoverArtChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await uploadPodcastCoverArt(fd)
      if (res.success && res.url) {
        setSettings((s) => ({ ...s, coverArtUrl: res.url ?? null }))
        toast.success("Cover art uploaded. Don't forget to Save Show Settings.")
      } else {
        toast.error(res.error ?? "Cover art upload failed.")
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function handleTestChannel(channelId: string) {
    setTesting((t) => ({ ...t, [channelId]: true }))
    try {
      const res = await testDistributionChannelConnection(channelId)
      setTestResults((r) => ({
        ...r,
        [channelId]: res.success
          ? { ok: !!res.ok, message: res.message ?? (res.ok ? "Reachable" : "Unreachable") }
          : { ok: false, message: res.error ?? "Test failed" },
      }))
    } finally {
      setTesting((t) => ({ ...t, [channelId]: false }))
    }
  }

  const enabledChannels = channels.filter((c) => c.is_enabled || c.enabled)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Voice Clone Status */}
      <Card className={hasVoiceClone ? "border-emerald-200" : "border-amber-200"}>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-start gap-3">
            {hasVoiceClone ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            )}
            <div className="flex-1">
              <p className={`font-medium text-sm ${hasVoiceClone ? "text-emerald-800" : "text-amber-800"}`}>
                {hasVoiceClone ? "Voice clone configured" : "Voice clone required for audio generation"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {hasVoiceClone
                  ? "Your ElevenLabs cloned voice will be used for AI-generated podcast audio."
                  : "Clone your voice with ElevenLabs before generating podcast audio."}
              </p>
              {!hasVoiceClone && (
                <Link
                  href="/dashboard/settings/twin-studio"
                  className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium mt-1.5 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  Set up Voice Clone →
                </Link>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Show branding */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mic className="h-4 w-4 text-primary" />
            Show Branding
          </CardTitle>
          <CardDescription>These details appear in your podcast listings and episode metadata.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Cover art */}
          <div>
            <Label className="text-xs">Cover art</Label>
            <div className="mt-1 flex items-center gap-3">
              <div className="relative h-20 w-20 rounded-md border overflow-hidden bg-muted shrink-0">
                {settings.coverArtUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={settings.coverArtUrl} alt="Cover art" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-muted-foreground">
                    <ImagePlus className="h-5 w-5" />
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleCoverArtChange}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="gap-1.5"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                  {settings.coverArtUrl ? "Replace" : "Upload"}
                </Button>
                <p className="text-[11px] text-muted-foreground">PNG / JPG / WEBP. 1400×1400+ recommended.</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Show name</Label>
              <Input
                value={settings.showName}
                onChange={(e) => setSettings((s) => ({ ...s, showName: e.target.value }))}
                placeholder="The Real Estate Edge"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Host name</Label>
              <Input
                value={settings.hostName}
                onChange={(e) => setSettings((s) => ({ ...s, hostName: e.target.value }))}
                placeholder="Your name"
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Show description</Label>
            <Textarea
              value={settings.description}
              onChange={(e) => setSettings((s) => ({ ...s, description: e.target.value }))}
              placeholder="What's your show about? Who is it for?"
              rows={3}
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Category</Label>
              <Select value={settings.category} onValueChange={(v) => setSettings((s) => ({ ...s, category: v }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PODCAST_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Language</Label>
              <Select value={settings.language} onValueChange={(v) => setSettings((s) => ({ ...s, language: v }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((lang) => (
                    <SelectItem key={lang.value} value={lang.value}>
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Website / show page URL</Label>
            <Input
              value={settings.websiteUrl}
              onChange={(e) => setSettings((s) => ({ ...s, websiteUrl: e.target.value }))}
              placeholder="https://yourwebsite.com/podcast"
              className="mt-1"
            />
          </div>
          <Button onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Show Settings
          </Button>
        </CardContent>
      </Card>

      {/* Connected channels — list + Test Connection per row */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Connected Distribution Channels</CardTitle>
          <CardDescription>Verify each channel can be reached. External show IDs are managed in the Setup tab.</CardDescription>
        </CardHeader>
        <CardContent>
          {enabledChannels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels connected yet.</p>
          ) : (
            <ul className="divide-y">
              {enabledChannels.map((ch) => {
                const id = ch.id
                const name = ch.platform_name || ch.platform || ch.channel_name || ch.name || "channel"
                const result = testResults[id]
                return (
                  <li key={id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="capitalize">{name}</Badge>
                        {ch.external_show_id ? (
                          <span className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                            ID: {ch.external_show_id}
                          </span>
                        ) : (
                          <span className="text-[11px] text-amber-600">No external show ID set</span>
                        )}
                      </div>
                      {result && (
                        <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                          {result.ok ? (
                            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                          ) : (
                            <XCircle className="h-3 w-3 text-red-500" />
                          )}
                          <span className={result.ok ? "text-emerald-700" : "text-red-600"}>{result.message}</span>
                        </div>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => handleTestChannel(id)}
                      disabled={!!testing[id]}
                      className="gap-1.5"
                    >
                      {testing[id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                      Test
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
