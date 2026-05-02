"use client"

import { useEffect, useState } from "react"
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
import { Mic, AlertCircle, CheckCircle2, ExternalLink, Save, Loader2 } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

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

const STORAGE_KEY = "podcast_show_settings"

interface ShowSettings {
  showName: string
  hostName: string
  description: string
  category: string
  language: string
  websiteUrl: string
}

interface Props {
  channels: any[]
  hasVoiceClone?: boolean
}

export function MyShowTab({ channels, hasVoiceClone }: Props) {
  const [settings, setSettings] = useState<ShowSettings>({
    showName: "",
    hostName: "",
    description: "",
    category: "Real Estate",
    language: "en",
    websiteUrl: "",
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        setSettings(JSON.parse(saved))
      } catch {
        // ignore invalid stored data
      }
    }
  }, [])

  function handleSave() {
    setSaving(true)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      toast.success("Show settings saved.")
    } finally {
      setSaving(false)
    }
  }

  const enabledChannels = channels.filter((c) => c.is_enabled || c.enabled)
  const channelNames = enabledChannels.map((c) => c.platform_name || c.platform || c.name).join(", ")

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
                <Link href="/dashboard/videos/voice" className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium mt-1.5 hover:underline">
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
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
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
                    <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
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

      {/* Connected channels summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Connected Distribution Channels</CardTitle>
        </CardHeader>
        <CardContent>
          {enabledChannels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels connected yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {enabledChannels.map((ch, i) => (
                <Badge key={i} variant="secondary">
                  {ch.platform_name || ch.platform || ch.name}
                </Badge>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            Manage show IDs and connection settings in the <strong>Distribution Channels</strong> tab.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
