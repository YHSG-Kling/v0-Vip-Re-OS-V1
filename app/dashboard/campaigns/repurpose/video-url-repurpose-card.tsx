"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Link2, Send, Clapperboard } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { repurposeVideoUrl, repurposeUrlToBrandedVideo } from "@/lib/repurpose/actions"
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

type Mode = "distribute" | "create"

export function VideoUrlRepurposeCard({ connectedPlatforms }: { connectedPlatforms: string[] }) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>("create")
  const [url, setUrl] = useState("")
  const [transcript, setTranscript] = useState("")
  const [showTranscript, setShowTranscript] = useState(false)
  const [selected, setSelected] = useState<Set<OutputFormat>>(new Set())
  const [results, setResults] = useState<RepurposedOutput[]>([])
  const [isPending, startTransition] = useTransition()

  const connected = new Set(connectedPlatforms)

  const toggle = (format: OutputFormat) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(format)) next.delete(format)
      else next.add(format)
      return next
    })
  }

  const validate = (): boolean => {
    if (!/^https?:\/\/\S+$/i.test(url.trim())) {
      toast.error("Enter a valid http(s) video URL")
      return false
    }
    if (selected.size === 0) {
      toast.error("Select at least one channel")
      return false
    }
    return true
  }

  const runDistribute = () => {
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

  const runCreate = () => {
    startTransition(async () => {
      const res = await repurposeUrlToBrandedVideo({
        sourceUrl: url.trim(),
        transcript: transcript.trim() || undefined,
        channels: [...selected],
      })
      if (res.redirectTo) {
        toast.message(res.error ?? "Setup required", { description: "Redirecting to setup…" })
        router.push(res.redirectTo)
        return
      }
      if (res.needsTranscript) {
        setShowTranscript(true)
        toast.error(res.error ?? "Paste the transcript to continue")
        return
      }
      if (!res.success || !res.didPayload) {
        toast.error(res.error ?? "Could not start video generation")
        return
      }
      // Kick off the D-ID render client-side (session cookie travels automatically).
      try {
        const kick = await fetch("/api/did/generate-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(res.didPayload),
        })
        if (!kick.ok) {
          const body = await kick.json().catch(() => ({}))
          toast.error(body.error ?? "Video project created, but generation failed to start. Retry it from your video library.")
          return
        }
      } catch {
        toast.error("Video project created, but the network request failed. Retry generation from your video library.")
        return
      }
      toast.success("Generating your branded video. Posts will be drafted for review when it's ready.")
      router.refresh()
    })
  }

  const handleRun = () => {
    if (!validate()) return
    if (mode === "create") runCreate()
    else runDistribute()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Repurpose a Video URL
        </CardTitle>
        <CardDescription>
          Turn a video link into omnipresence across your connected social channels.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "create" ? "default" : "outline"}
            onClick={() => setMode("create")}
            disabled={isPending}
          >
            <Clapperboard className="mr-2 h-4 w-4" /> New branded video
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "distribute" ? "default" : "outline"}
            onClick={() => setMode("distribute")}
            disabled={isPending}
          >
            <Send className="mr-2 h-4 w-4" /> Distribute this video
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === "create"
            ? "AI grabs the transcript, rewrites it in your brand voice, and renders a new branded video (your voice + avatar). When ready, per-channel posts are drafted for your review."
            : "Schedules the same video to each connected channel with AI-written, platform-tailored captions."}
        </p>

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

        {mode === "create" && (showTranscript || transcript) && (
          <div className="space-y-2">
            <Label htmlFor="repurpose-transcript">Transcript (paste if the link isn't a direct media file)</Label>
            <Textarea
              id="repurpose-transcript"
              placeholder="Paste the video's transcript or talking points…"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={4}
              disabled={isPending}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label>Channels</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CHANNELS.map((ch) => {
              const isConnected = connected.has(ch.platform)
              return (
                <label key={ch.format} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <Checkbox
                    checked={selected.has(ch.format)}
                    onCheckedChange={() => toggle(ch.format)}
                    disabled={isPending}
                  />
                  <span className="flex-1">{ch.label}</span>
                  {!isConnected && <span className="text-xs text-muted-foreground">not connected</span>}
                </label>
              )
            })}
          </div>
          {connectedPlatforms.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No social accounts connected — you'll be sent to Settings → Integrations to connect them first.
            </p>
          )}
        </div>

        <Button onClick={handleRun} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Working…
            </>
          ) : mode === "create" ? (
            <>
              <Clapperboard className="mr-2 h-4 w-4" /> Generate branded video
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
