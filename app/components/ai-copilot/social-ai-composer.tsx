"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sparkles, Loader2, Copy, Check, Calendar, Send, Wand2, RefreshCw } from "lucide-react"
import { scheduleSocialPost } from "@/app/actions/social-media-automation"
import { generateSocialPostContent, stampPostBrandCompliance } from "@/app/actions/social/generate-social-post"
import { toast } from "sonner"
import { awardPointsForAction } from "@/app/lib/gamification/award-on-action"

interface SocialAiComposerProps {
  agentId: string
  brokerageId: string
  connectedPlatforms: string[]
  /** Full account objects so we can look up the account ID for the selected platform */
  accounts?: Array<{ id: string; platform: string; account_name: string }>
  onPostScheduled?: () => void
}

const CONTENT_TYPES = [
  { value: "market_update", label: "Market Update" },
  { value: "just_listed", label: "Just Listed" },
  { value: "just_sold", label: "Just Sold" },
  { value: "open_house", label: "Open House" },
  { value: "tips", label: "Tips & Advice" },
  { value: "testimonial", label: "Client Testimonial" },
  { value: "community", label: "Community Spotlight" },
  { value: "personal", label: "Personal/Behind the Scenes" },
]

const TONE_OPTIONS = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly & Warm" },
  { value: "energetic", label: "Energetic & Exciting" },
  { value: "informative", label: "Informative" },
  { value: "casual", label: "Casual" },
]

export function SocialAiComposer({
  agentId,
  brokerageId,
  connectedPlatforms,
  accounts = [],
  onPostScheduled,
}: SocialAiComposerProps) {
  const [contentType, setContentType] = useState("")
  const [tone, setTone] = useState("professional")
  const [topic, setTopic] = useState("")
  const [generatedContent, setGeneratedContent] = useState("")
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [scheduledTime, setScheduledTime] = useState("")
  const [generating, setGenerating] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [copied, setCopied] = useState(false)
  const [hashtags, setHashtags] = useState<string[]>([])
  const [complianceViolations, setComplianceViolations] = useState<string[]>([])

  async function handleGenerate() {
    if (!contentType || !topic) {
      toast.error("Please select a content type and enter a topic")
      return
    }

    setGenerating(true)
    setComplianceViolations([])
    try {
      const platform = selectedPlatforms[0] ?? "instagram"
      const result = await generateSocialPostContent({
        brief: topic,
        platform,
        tone,
        contentType,
        brokerageId,
        agentId,
      })

      if (result.complianceBlocked) {
        setComplianceViolations(result.complianceViolations ?? [])
        toast.error("Content blocked by compliance")
      } else if (result.success && result.data) {
        setGeneratedContent(result.data.content)
        setHashtags(result.data.hashtags ?? [])
        toast.success("Content generated")
      } else {
        toast.error(result.error ?? "Failed to generate content")
      }
    } catch (error) {
      console.error("Error generating content:", error)
      toast.error("Failed to generate content")
    } finally {
      setGenerating(false)
    }
  }

  async function handleRegenerate() {
    await handleGenerate()
  }

  async function handleSchedule() {
    if (!generatedContent || selectedPlatforms.length === 0) {
      toast.error("Please generate content and select at least one platform")
      return
    }

    setScheduling(true)
    try {
      const platform = selectedPlatforms[0] ?? "facebook"
      const contentWithHashtags = hashtags.length
        ? `${generatedContent}\n\n${hashtags.map(h => `#${h}`).join(" ")}`
        : generatedContent

      // Resolve the social_media_accounts.id for the selected platform
      const account = accounts.find(a => a.platform === platform) ?? accounts[0]
      if (!account) {
        toast.error("No connected account found for the selected platform")
        setScheduling(false)
        return
      }

      const scheduled = await scheduleSocialPost({
        agentId,
        brokerageId,
        userId: agentId,
        platform,
        postType: contentType || "custom",
        content: contentWithHashtags,
        hashtags,
        scheduledFor: scheduledTime || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        socialAccountId: account.id,
      })
      // THE SERVER'S VERDICT, not an optimistic one: scheduleSocialPost RESOLVES
      // with success:false on a compliance block or a refused insert.
      if (!scheduled.success) {
        toast.error(scheduled.error ?? "Failed to schedule post")
        return
      }

      // COMPLIANCE-FIRST STAMP (wired 2026-09-03). brand_compliance_passed is the
      // flag app/actions/social-share.ts refuses to share without, and the
      // publisher cron only stamps it at publish time — AFTER a human approved
      // the post. Stamping here, the moment the row exists, puts hashtag /
      // prohibited-word / logo findings in front of the AGENT first, so the
      // approver and the publisher see a post that was already checked.
      const postId = (scheduled as { data?: { id?: string } | null }).data?.id
      if (postId) {
        const stamp = await stampPostBrandCompliance({ postId })
        if (!stamp.passed) {
          toast.warning(
            `Scheduled, but brand compliance flagged it: ${stamp.violations.slice(0, 2).join("; ")}${stamp.violations.length > 2 ? "…" : ""}. Fix it before it publishes.`,
          )
        }
      }

      toast.success("Post scheduled successfully!")
      awardPointsForAction(agentId, "social_posted").catch(() => {})

      // Reset form
      setGeneratedContent("")
      setTopic("")
      setSelectedPlatforms([])
      setScheduledTime("")
      setHashtags([])
      
      onPostScheduled?.()
    } catch (error) {
      console.error("Error scheduling post:", error)
      toast.error("Failed to schedule post")
    } finally {
      setScheduling(false)
    }
  }

  function handleCopy() {
    const fullContent = `${generatedContent}\n\n${hashtags.join(" ")}`
    navigator.clipboard.writeText(fullContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success("Copied to clipboard!")
  }

  function togglePlatform(platform: string) {
    setSelectedPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform]
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          AI Content Composer
        </CardTitle>
        <CardDescription>
          Generate engaging social media content with AI assistance
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Step 1: Configure */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Content Type</Label>
            <Select value={contentType} onValueChange={setContentType}>
              <SelectTrigger>
                <SelectValue placeholder="Select content type" />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Tone</Label>
            <Select value={tone} onValueChange={setTone}>
              <SelectTrigger>
                <SelectValue placeholder="Select tone" />
              </SelectTrigger>
              <SelectContent>
                {TONE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Topic / Key Points</Label>
          <Textarea
            placeholder="E.g., New listing at 123 Main St - 4 bed, 3 bath, recently renovated kitchen..."
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={3}
          />
        </div>

        <Button
          onClick={handleGenerate}
          disabled={generating || !contentType || !topic}
          className="w-full"
        >
          {generating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4 mr-2" />
              Generate Content
            </>
          )}
        </Button>

        {/* Compliance violations */}
        {complianceViolations.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
            <p className="text-sm font-medium text-destructive flex items-center gap-1">
              <span className="inline-block w-4 h-4 rounded-full border border-destructive text-[10px] font-bold flex items-center justify-center">!</span>
              Content blocked by compliance
            </p>
            <ul className="text-xs text-destructive list-disc list-inside space-y-0.5">
              {complianceViolations.map((v, i) => <li key={i}>{v}</li>)}
            </ul>
          </div>
        )}

        {/* Step 2: Review & Edit */}
        {generatedContent && (
          <div className="space-y-4 border-t pt-4">
            <div className="flex items-center justify-between">
              <Label>Generated Content</Label>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleRegenerate} disabled={generating}>
                  <RefreshCw className={`h-4 w-4 mr-1 ${generating ? "animate-spin" : ""}`} />
                  Regenerate
                </Button>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? (
                    <Check className="h-4 w-4 mr-1" />
                  ) : (
                    <Copy className="h-4 w-4 mr-1" />
                  )}
                  Copy
                </Button>
              </div>
            </div>

            <Textarea
              value={generatedContent}
              onChange={(e) => setGeneratedContent(e.target.value)}
              rows={4}
              className="font-medium"
            />

            {hashtags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {hashtags.map((tag, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {/* Step 3: Select Platforms */}
            <div className="space-y-2">
              <Label>Platforms</Label>
              <div className="flex flex-wrap gap-3">
                {connectedPlatforms.length > 0 ? (
                  connectedPlatforms.map((platform) => (
                    <label
                      key={platform}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedPlatforms.includes(platform)}
                        onCheckedChange={() => togglePlatform(platform)}
                      />
                      <span className="capitalize text-sm">{platform}</span>
                    </label>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No connected platforms. Connect accounts in Settings.
                  </p>
                )}
              </div>
            </div>

            {/* Step 4: Schedule */}
            <div className="space-y-2">
              <Label>Schedule (optional)</Label>
              <Input
                type="datetime-local"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to save as draft
              </p>
            </div>

            <Button
              onClick={handleSchedule}
              disabled={scheduling || selectedPlatforms.length === 0}
              className="w-full"
            >
              {scheduling ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Scheduling...
                </>
              ) : scheduledTime ? (
                <>
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule Post
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Save as Draft
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
