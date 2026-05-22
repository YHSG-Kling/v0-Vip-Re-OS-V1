"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Link2, Send, Clapperboard, FileText } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  repurposeVideoUrl,
  repurposeUrlToBrandedVideo,
  repurposeUrlToBlogPost,
} from "@/lib/repurpose/actions"
import type { OutputFormat, RepurposedOutput } from "@/lib/repurpose/types"

const CHANNELS: { platform: string; format: OutputFormat; label: string }[] = [
  { platform: "instagram", format: "instagram_reels", label: "Instagram Reels" },
  { platform: "tiktok", format: "tiktok", label: "TikTok" },
  { platform: "youtube", format: "youtube_shorts", label: "YouTube Shorts" },
  { platform: "facebook", format: "facebook_reels", label: "Facebook Reels" },
  { platform: "linkedin", format: "linkedin_post", label: "LinkedIn" },
  { platform: "twitter", format: "twitter_thread", label: "X / Twitter" },
  { platform: "google_business", format: "google_business_post", label: "Google Business" },
]

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-green-100 text-green-800",
  skipped: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
  rejected: "bg-red-100 text-red-800",
  pending: "bg-blue-100 text-blue-800",
}

type Mode = "create" | "distribute" | "blog"
const NEEDS_CHANNELS: Mode[] = ["create", "distribute"]

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
    if (NEEDS_CHANNELS.includes(mode) && selected.size === 0) {
      toast.error("Select at least one channel")
      return false
    }
    return true
  }

  const handleTranscriptGate = (res: { needsTranscript?: boolean; error?: string }): boolean => {
    if (res.needsTranscript) {
      setShowTranscript(true)
      toast.error(res.error ?? "Paste the transcript to continue")
      return true
    }
    return false
  }

  const runDistribute = () =>
    startTransition(async () => {
      const res = await repurposeVideoUrl({ sourceUrl: url.trim(), outputFormats: [...selected] })
      if (!res.success) return void toast.error(res.error ?? "Repurpose failed")
      setResults(res.outputs ?? [])
      const scheduled = (res.outputs ?? []).filter((o) => o.status === "scheduled").length
      toast.success(scheduled > 0 ? `Scheduled to ${scheduled} channel${scheduled === 1 ? "" : "s"}` : "Generated — see results below")
      router.refresh()
    })

  const runCreate = () =>
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
      if (handleTranscriptGate(res)) return
      if (!res.success || !res.didPayload) return void toast.error(res.error ?? "Could not start video generation")
      try {
        const kick = await fetch("/api/did/generate-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(res.didPayload),
        })
        if (!kick.ok) {
          const body = await kick.json().catch(() => ({}))
          return void toast.error(body.error ?? "Video project created, but generation failed to start. Retry it from your video library.")
        }
      } catch {
        return void toast.error("Video project created, but the network request failed. Retry generation from your video library.")
      }
      toast.success("Generating your branded video. Posts will be drafted for review when it's ready.")
      router.refresh()
    })

  const runBlog = () =>
    startTransition(async () => {
      const res = await repurposeUrlToBlogPost({ sourceUrl: url.trim(), transcript: transcript.trim() || undefined })
      if (handleTranscriptGate(res)) return
      if (!res.success) return void toast.error(res.error ?? "Could not create the blog post")
      toast.success("Draft blog post with a cover image created — review it in your blog dashboard.")
      router.refresh()
    })

  const handleRun = () => {
    if (!validate()) return
    if (mode === "create") runCreate()
    else if (mode === "distribute") runDistribute()
    else runBlog()
  }

  const MODES: { id: Mode; label: string; icon: React.ReactNode; blurb: string }[] = [
    { id: "create", label: "New branded video", icon: <Clapperboard className="mr-2 h-4 w-4" />, blurb: "AI grabs the transcript, rewrites it in your brand voice, and renders a new branded video (your voice + avatar, intro/outro). When ready, per-channel posts are drafted for your review." },
    { id: "distribute", label: "Distribute this video", icon: <Send className="mr-2 h-4 w-4" />, blurb: "Schedules the same video to each connected channel with AI-written, platform-tailored captions." },
    { id: "blog", label: "Blog post", icon: <FileText className="mr-2 h-4 w-4" />, blurb: "No video — repurpose the transcript into an SEO blog post with a generated cover image (saved as a draft)." },
  ]
  const activeBlurb = MODES.find((m) => m.id === mode)?.blurb ?? ""

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" /> Repurpose a Video URL
        </CardTitle>
        <CardDescription>Turn one video link into omnipresence — video, social posts, a blog post, or a podcast.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <Button
              key={m.id}
              type="button"
              size="sm"
              variant={mode === m.id ? "default" : "outline"}
              onClick={() => setMode(m.id)}
              disabled={isPending}
            >
              {m.icon}
              {m.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{activeBlurb}</p>

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

        {mode !== "distribute" && (showTranscript || transcript) && (
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

        {NEEDS_CHANNELS.includes(mode) && (
          <div className="space-y-2">
            <Label>Channels</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CHANNELS.map((ch) => {
                const isConnected = connected.has(ch.platform)
                return (
                  <label key={ch.format} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                    <Checkbox checked={selected.has(ch.format)} onCheckedChange={() => toggle(ch.format)} disabled={isPending} />
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
        )}

        <Button onClick={handleRun} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Working…
            </>
          ) : (
            <>{MODES.find((m) => m.id === mode)?.icon}Run</>
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
