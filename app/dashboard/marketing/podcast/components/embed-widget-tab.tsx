"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import { Code2, Copy, ExternalLink, Globe } from "lucide-react"
import { toast } from "sonner"

interface Episode {
  id: string
  title: string
  status: string
  audio_url: string | null
}

interface Props {
  episodes: Episode[]
  agentId: string
}

type WidgetMode = "latest" | "single"
type Theme = "light" | "dark"

export function EmbedWidgetTab({ episodes, agentId }: Props) {
  const playable = episodes.filter((e) => !!e.audio_url && (e.status === "published" || e.status === "completed"))

  const [mode, setMode] = useState<WidgetMode>("latest")
  const [episodeId, setEpisodeId] = useState<string>("")
  const [theme, setTheme] = useState<Theme>("light")
  const [width, setWidth] = useState<string>("100%")
  const [origin, setOrigin] = useState("https://app.vipreos.com")

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  useEffect(() => {
    if (!episodeId && playable.length > 0) setEpisodeId(playable[0].id)
  }, [playable, episodeId])

  const selectedEpisode = useMemo(
    () => playable.find((e) => e.id === episodeId) ?? null,
    [playable, episodeId],
  )

  const widgetSrc =
    mode === "latest"
      ? `${origin}/api/podcast/widget?agentId=${agentId}&theme=${theme}`
      : selectedEpisode
        ? `${origin}/api/podcast/widget?episodeId=${selectedEpisode.id}&theme=${theme}`
        : ""

  const iframeSnippet = widgetSrc
    ? `<iframe
  src="${widgetSrc}"
  style="border: 0; width: ${width}; height: 152px;"
  loading="lazy"
  allow="autoplay"
  title="Podcast player"
></iframe>`
    : ""

  // Native HTML audio fallback for embedding the underlying mp3 directly.
  const nativeSnippet =
    mode === "single" && selectedEpisode?.audio_url
      ? `<audio controls preload="metadata" style="width: ${width}">
  <source src="${selectedEpisode.audio_url}" type="audio/mpeg" />
  Your browser does not support the audio element.
</audio>`
      : ""

  async function copy(text: string, label = "Copied") {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(label)
    } catch {
      toast.error("Could not copy")
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            Embed Player
          </CardTitle>
          <CardDescription>
            Drop a player onto your website or landing page. Listeners can play episodes without leaving your site.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as WidgetMode)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latest">Latest episode (auto)</SelectItem>
                  <SelectItem value="single">Specific episode</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Theme</Label>
              <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Width</Label>
              <Input
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                placeholder="100% or 480px"
                className="mt-1"
              />
            </div>
          </div>

          {mode === "single" && (
            <div>
              <Label className="text-xs">Episode</Label>
              {playable.length === 0 ? (
                <p className="text-sm text-muted-foreground mt-1">
                  No episodes with audio available yet.
                </p>
              ) : (
                <Select value={episodeId} onValueChange={setEpisodeId}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {playable.map((ep) => (
                      <SelectItem key={ep.id} value={ep.id}>
                        {ep.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live preview using native audio element when single episode + audio URL */}
      {mode === "single" && selectedEpisode?.audio_url && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium mb-2">{selectedEpisode.title}</p>
            <audio controls src={selectedEpisode.audio_url} className="w-full" />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Code2 className="h-4 w-4 text-primary" />
            Embed snippet
          </CardTitle>
          <CardDescription>
            Paste this iframe into your website's HTML where you want the player to appear.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea readOnly value={iframeSnippet} rows={8} className="font-mono text-xs" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(iframeSnippet, "Embed snippet copied")}>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copy iframe
            </Button>
            {widgetSrc && (
              <Button asChild size="sm" variant="outline">
                <a href={widgetSrc} target="_blank" rel="noopener noreferrer">
                  Open player URL
                  <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                </a>
              </Button>
            )}
          </div>
          {nativeSnippet && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                Or use the native HTML audio element (no iframe required)
              </summary>
              <Textarea readOnly value={nativeSnippet} rows={5} className="font-mono text-xs mt-2" />
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => copy(nativeSnippet, "Native audio snippet copied")}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                Copy native audio tag
              </Button>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
