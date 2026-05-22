"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Link2, Send } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { repurposeVideoUrl } from "@/lib/repurpose/actions"
import type { OutputFormat, RepurposedOutput } from "@/lib/repurpose/types"

const CHANNELS: { platform: string; format: OutputFormat; label: string }[] = [
  { platform: "instagram", format: "instagram_reels", label: "Instagram Reels" },
  { platform: "tiktok", format: "tiktok", label: "TikTok" },
  { platform: "youtube", format: "youtube_shorts", label: "YouTube Shorts" },
  { platform: "facebook", format: "facebook_reels", label: "Facebook Reels" },
  { platform: "linkedin", format: "linkedin_post", label: "LinkedIn" },
  { platform: "twitter", format: "twitter_thread", label: "X / Twitter" },
]

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-green-100 text-green-800",
  skipped: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
  rejected: "bg-red-100 text-red-800",
  pending: "bg-blue-100 text-blue-800",
}

export function VideoUrlRepurposeCard({ connectedPlatforms }: { connectedPlatforms: string[] }) {
  const router = useRouter()
  const [url, setUrl] = useState("")
  const [selected, setSelected] = useState<Set<OutputFormat>>(new Set())
  const [results, setResults] = useState<RepurposedOutput[]>([])
  const [isPending, startTransition] = useTransition()

  const connected = new Set(connectedPlatforms)

  const toggle = (format: OutputFormat) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(format) ? next.delete(format) : next.add(format)
      return next
    })
  }

  const handleRun = () => {
    if (!/^https?:\/\/\S+$/i.test(url.trim())) {
      toast.error("Enter a valid http(s) video URL")
      return
    }
    if (selected.size === 0) {
      toast.error("Select at least one channel")
      return
    }
    startTransition(async () => {
      const res = await repurposeVideoUrl({ sourceUrl: url.trim(), outputFormats: [...selected] })
      if (!res.success) {
        toast.error(res.error ?? "Repurpose failed")
        return
      }
      setResults(res.outputs ?? [])
      const scheduled = (res.outputs ?? []).filter((o) => o.status === "scheduled").length
      toast.success(scheduled > 0 ? `Scheduled to ${scheduled} channel${scheduled === 1 ? "" : "s"}` : "Generated — see results below")
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Repurpose a Video URL
        </CardTitle>
        <CardDescription>
          Paste a video link. AI rewrites a platform-tailored caption in your voice for each channel and
          schedules the video across your connected social accounts (omnipresence).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="repurpose-url">Source video URL</Label>
          <Input
            id="repurpose-url"
            placeholder="https://…/my-listing-tour.mp4"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isPending}
          />
        </div>

        <div className="space-y-2">
          <Label>Channels</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CHANNELS.map((ch) => {
              const isConnected = connected.has(ch.platform)
              return (
                <label
                  key={ch.format}
                  className="flex items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <Checkbox
                    checked={selected.has(ch.format)}
                    onCheckedChange={() => toggle(ch.format)}
                    disabled={isPending}
                  />
                  <span className="flex-1">{ch.label}</span>
                  {!isConnected && (
                    <span className="text-xs text-muted-foreground">not connected</span>
                  )}
                </label>
              )
            })}
          </div>
          {connectedPlatforms.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No social accounts connected yet — connect them in Settings → Integrations to enable
              distribution. Unconnected channels are skipped.
            </p>
          )}
        </div>

        <Button onClick={handleRun} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating & distributing…
            </>
          ) : (
            <>
              <Send className="mr-2 h-4 w-4" /> Generate &amp; Distribute
            </>
          )}
        </Button>

        {results.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">Results</p>
            {results.map((o, i) => (
              <div key={`${o.outputType}-${i}`} className="flex items-start justify-between gap-3 rounded-md border p-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium capitalize">{o.platform}</p>
                  <p className="truncate text-xs text-muted-foreground">{o.contentPreview}</p>
                </div>
                <Badge className={STATUS_STYLES[o.status] ?? "bg-gray-100 text-gray-800"}>{o.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
