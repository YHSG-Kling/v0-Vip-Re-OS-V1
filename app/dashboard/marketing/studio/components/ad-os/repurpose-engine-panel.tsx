"use client"

// ============================================================
// PANEL C – Repurpose Engine
// Generates brand-voice-tuned variants for multiple channels.
// Each output card has Copy + Schedule actions.
// ============================================================

import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Loader2, RefreshCw, Copy, CalendarDays, CheckCheck } from "lucide-react"
import { repurposeContent, scheduleRepurposedPost } from "./ad-os-actions"

interface Props {
  agentId: string
}

const SOURCE_TYPES = [
  { value: "social_post", label: "Social Post" },
  { value: "email", label: "Email" },
  { value: "blog_post", label: "Blog Post" },
  { value: "video_script", label: "Video Script" },
  { value: "listing_description", label: "Listing Description" },
]

const TARGET_CHANNELS = [
  "Facebook Post",
  "Instagram Caption",
  "LinkedIn Article",
  "Email Newsletter",
  "SMS Follow-up",
  "Seller Update",
  "Blog Introduction",
  "Direct Mail Copy",
]

interface VariantCard {
  channel: string
  content: string
  copied: boolean
  scheduling: boolean
  scheduled: boolean
  scheduleError: string | null
}

export function RepurposeEnginePanel({ agentId }: Props) {
  const [sourceContent, setSourceContent] = useState("")
  const [sourceType, setSourceType] = useState("social_post")
  const [selectedChannels, setSelectedChannels] = useState<string[]>([
    "Facebook Post",
    "Instagram Caption",
    "Email Newsletter",
  ])
  const [isGenerating, setIsGenerating] = useState(false)
  const [variants, setVariants] = useState<VariantCard[]>([])
  const [error, setError] = useState<string | null>(null)

  function toggleChannel(channel: string) {
    setSelectedChannels((prev) =>
      prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]
    )
  }

  async function handleRepurpose() {
    if (!sourceContent.trim() || selectedChannels.length === 0 || !agentId) return
    setIsGenerating(true)
    setVariants([])
    setError(null)

    try {
      const res = await repurposeContent({
        agentId,
        sourceContent: sourceContent.trim(),
        sourceType,
        targetChannels: selectedChannels,
      })

      if (!res.success || !res.variants) {
        setError(res.error ?? "Repurpose failed")
        return
      }

      setVariants(
        res.variants.map((v) => ({
          channel: v.channel,
          content: v.content,
          copied: false,
          scheduling: false,
          scheduled: false,
          scheduleError: null,
        }))
      )
    } catch {
      setError("Unexpected error — please try again")
    } finally {
      setIsGenerating(false)
    }
  }

  function handleCopy(idx: number) {
    navigator.clipboard.writeText(variants[idx].content)
    setVariants((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, copied: true } : v))
    )
    setTimeout(
      () =>
        setVariants((prev) =>
          prev.map((v, i) => (i === idx ? { ...v, copied: false } : v))
        ),
      2000
    )
  }

  async function handleSchedule(idx: number) {
    const variant = variants[idx]
    setVariants((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, scheduling: true, scheduleError: null } : v))
    )

    try {
      const res = await scheduleRepurposedPost({
        platform: variant.channel,
        content: variant.content,
      })

      setVariants((prev) =>
        prev.map((v, i) =>
          i === idx
            ? {
                ...v,
                scheduling: false,
                scheduled: res.success,
                scheduleError: res.success ? null : (res.error ?? "Schedule failed"),
              }
            : v
        )
      )
    } catch {
      setVariants((prev) =>
        prev.map((v, i) =>
          i === idx
            ? { ...v, scheduling: false, scheduleError: "Unexpected error" }
            : v
        )
      )
    }
  }

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-violet-600" />
          Repurpose Engine
        </CardTitle>
        <CardDescription>
          Transform your best content into platform-optimized variants in your brand voice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Source content */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Paste Your Best-Performing Content</Label>
          <Textarea
            placeholder="Paste your source content here..."
            value={sourceContent}
            onChange={(e) => setSourceContent(e.target.value)}
            className="min-h-[80px] text-sm resize-none"
          />
        </div>

        {/* Source type */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Source Type</Label>
          <Select value={sourceType} onValueChange={setSourceType}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Target outputs */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">Target Outputs</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {TARGET_CHANNELS.map((channel) => (
              <div key={channel} className="flex items-center gap-2">
                <Checkbox
                  id={`ch-${channel}`}
                  checked={selectedChannels.includes(channel)}
                  onCheckedChange={() => toggleChannel(channel)}
                />
                <label
                  htmlFor={`ch-${channel}`}
                  className="text-xs cursor-pointer select-none leading-none"
                >
                  {channel}
                </label>
              </div>
            ))}
          </div>
        </div>

        <Button
          onClick={handleRepurpose}
          disabled={
            isGenerating ||
            !sourceContent.trim() ||
            selectedChannels.length === 0 ||
            !agentId
          }
          className="w-full bg-violet-600 hover:bg-violet-700"
        >
          {isGenerating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Repurposing...
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              Repurpose for Me
            </>
          )}
        </Button>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md p-2">{error}</p>
        )}

        {/* Generated variants */}
        {variants.length > 0 && (
          <div className="border-t pt-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {variants.length} Platform Variants — Brand Voice Applied
            </p>
            <ScrollArea className="max-h-[420px] pr-1">
              <div className="space-y-3">
                {variants.map((variant, idx) => (
                  <div
                    key={variant.channel}
                    className="rounded-lg border bg-muted/30 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <Badge
                        variant="outline"
                        className="text-xs font-medium"
                      >
                        {variant.channel}
                      </Badge>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleCopy(idx)}
                        >
                          {variant.copied ? (
                            <>
                              <CheckCheck className="mr-1 h-3 w-3 text-green-600" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="mr-1 h-3 w-3" />
                              Copy
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleSchedule(idx)}
                          disabled={variant.scheduling || variant.scheduled}
                        >
                          {variant.scheduling ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : variant.scheduled ? (
                            <>
                              <CheckCheck className="mr-1 h-3 w-3 text-green-600" />
                              Scheduled
                            </>
                          ) : (
                            <>
                              <CalendarDays className="mr-1 h-3 w-3" />
                              Schedule
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">
                      {variant.content}
                    </p>
                    {variant.scheduleError && (
                      <p className="text-xs text-red-600">{variant.scheduleError}</p>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
