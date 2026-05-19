"use client"

/**
 * PostComposerDialog
 *
 * Full create/edit composer for social posts.
 * Features:
 *  - Platform selector with character-limit display
 *  - Per-platform post preview (Instagram card, LinkedIn box, Twitter/X pill, Facebook box)
 *  - Media upload via Vercel Blob (drag-drop + file picker), with thumbnail preview
 *  - Hashtag chips with add/remove
 *  - Schedule datetime picker (or "Post now" intent)
 *  - Account selector scoped to chosen platform
 *  - Broker approval notice if setting is enabled
 *  - Compliance violation surface from generateSocialPostContent
 */

import { useState, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertCircle,
  Calendar,
  Check,
  Image as ImageIcon,
  Loader2,
  Plus,
  Send,
  Shield,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { upload } from "@vercel/blob/client"
import { scheduleSocialPost, updateSocialPost } from "@/app/actions/social-media-automation"
import { generateSocialPostContent, suggestHashtags } from "@/app/actions/social/generate-social-post"
import { GenerateImageButton } from "@/app/components/ai-image/generate-image-button"

// ── Platform config ──────────────────────────────────────────────────────────

const PLATFORM_CONFIG: Record<string, { charLimit: number; hashtagNote: string; color: string }> = {
  facebook:  { charLimit: 63000, hashtagNote: "1–3 hashtags",     color: "text-blue-600" },
  instagram: { charLimit: 2200,  hashtagNote: "Up to 30 hashtags", color: "text-pink-600" },
  linkedin:  { charLimit: 3000,  hashtagNote: "3–5 hashtags",     color: "text-blue-700" },
  twitter:   { charLimit: 280,   hashtagNote: "1–2 hashtags",     color: "text-gray-900" },
  tiktok:    { charLimit: 2200,  hashtagNote: "3–5 hashtags",     color: "text-black" },
  youtube:   { charLimit: 5000,  hashtagNote: "5–10 hashtags",    color: "text-red-600" },
  pinterest: { charLimit: 500,   hashtagNote: "2–5 hashtags",     color: "text-red-700" },
}

const POST_TYPES = [
  { value: "new_listing", label: "New Listing" },
  { value: "coming_soon", label: "Coming Soon" },
  { value: "open_house_announcement", label: "Open House Announcement" },
  { value: "open_house_reminder", label: "Open House Reminder" },
  { value: "price_reduction", label: "Price Reduction" },
  { value: "just_sold", label: "Just Sold" },
  { value: "market_update", label: "Market Update" },
  { value: "tips", label: "Tips & Advice" },
  { value: "community", label: "Community Spotlight" },
  { value: "testimonial", label: "Client Testimonial" },
  { value: "custom", label: "Custom" },
]

// ── Props ─────────────────────────────────────────────────────────────────────

interface PostComposerDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  userId: string
  agentId: string
  brokerageId: string
  userRole: string
  accounts: Array<{ id: string; platform: string; account_name: string }>
  initialPost?: {
    id: string
    content: string
    platform: string
    post_type: string
    hashtags: string[]
    media_urls: string[]
    scheduled_for?: string
    social_account_id: string
  }
  requiresBrokerApproval?: boolean
  onSaved?: (post: any) => void
}

// ── Platform Preview ──────────────────────────────────────────────────────────

function PlatformPreview({ platform, content, hashtags, mediaUrl }: {
  platform: string
  content: string
  hashtags: string[]
  mediaUrl?: string
}) {
  const fullText = `${content}${hashtags.length ? `\n\n${hashtags.map(h => `#${h}`).join(" ")}` : ""}`

  if (platform === "twitter") {
    return (
      <div className="rounded-2xl border p-4 max-w-sm bg-card text-sm leading-relaxed">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-gray-200" />
          <div>
            <p className="font-semibold text-xs">Your Name</p>
            <p className="text-muted-foreground text-xs">@yourhandle</p>
          </div>
        </div>
        <p className="whitespace-pre-wrap text-sm">{fullText.slice(0, 280)}</p>
        {mediaUrl && <img src={mediaUrl} alt="Preview" className="rounded-lg mt-2 w-full object-cover max-h-48" crossOrigin="anonymous" />}
      </div>
    )
  }

  if (platform === "instagram") {
    return (
      <div className="rounded-lg border max-w-sm overflow-hidden bg-card">
        {mediaUrl
          ? <img src={mediaUrl} alt="Preview" className="w-full object-cover aspect-square" crossOrigin="anonymous" />
          : <div className="w-full aspect-square bg-gradient-to-br from-pink-100 to-purple-100 flex items-center justify-center text-muted-foreground text-sm">No media</div>
        }
        <div className="p-3 text-sm">
          <span className="font-semibold text-xs mr-1">yourhandle</span>
          <span className="text-sm leading-relaxed whitespace-pre-wrap">{content.slice(0, 125)}{content.length > 125 ? "… more" : ""}</span>
          {hashtags.length > 0 && (
            <p className="text-blue-500 text-xs mt-1">{hashtags.slice(0, 8).map(h => `#${h}`).join(" ")}</p>
          )}
        </div>
      </div>
    )
  }

  if (platform === "linkedin") {
    return (
      <div className="rounded-lg border p-4 max-w-sm bg-card text-sm">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-10 h-10 rounded-full bg-blue-200" />
          <div>
            <p className="font-semibold text-xs">Your Name</p>
            <p className="text-muted-foreground text-xs">Real Estate Agent</p>
          </div>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{fullText.slice(0, 300)}{fullText.length > 300 ? "… see more" : ""}</p>
        {mediaUrl && <img src={mediaUrl} alt="Preview" className="rounded mt-3 w-full object-cover max-h-48" crossOrigin="anonymous" />}
      </div>
    )
  }

  // Facebook / generic
  return (
    <div className="rounded-lg border p-4 max-w-sm bg-card text-sm">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-full bg-blue-200" />
        <p className="font-semibold text-xs">Your Page</p>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{fullText.slice(0, 500)}{fullText.length > 500 ? "… see more" : ""}</p>
      {mediaUrl && <img src={mediaUrl} alt="Preview" className="rounded mt-3 w-full object-cover max-h-48" crossOrigin="anonymous" />}
    </div>
  )
}

// ── Main Component ────────────────���───────────────────────────────────────────

export function PostComposerDialog({
  open,
  onOpenChange,
  userId,
  agentId,
  brokerageId,
  userRole,
  accounts,
  initialPost,
  requiresBrokerApproval = false,
  onSaved,
}: PostComposerDialogProps) {
  const isEdit = !!initialPost

  const [platform, setPlatform] = useState(initialPost?.platform ?? "")
  const [accountId, setAccountId] = useState(initialPost?.social_account_id ?? "")
  const [postType, setPostType] = useState(initialPost?.post_type ?? "custom")
  const [content, setContent] = useState(initialPost?.content ?? "")
  const [hashtags, setHashtags] = useState<string[]>(initialPost?.hashtags ?? [])
  const [newTag, setNewTag] = useState("")
  const [mediaUrls, setMediaUrls] = useState<string[]>(initialPost?.media_urls ?? [])
  const [scheduledFor, setScheduledFor] = useState(
    initialPost?.scheduled_for
      ? new Date(initialPost.scheduled_for).toISOString().slice(0, 16)
      : ""
  )
  const [tab, setTab] = useState<"compose" | "preview">("compose")

  // AI state
  const [aiTopic, setAiTopic] = useState("")
  const [generating, setGenerating] = useState(false)
  const [suggestingTags, setSuggestingTags] = useState(false)
  const [complianceViolations, setComplianceViolations] = useState<string[]>([])

  // Media upload state
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Submit state
  const [saving, setSaving] = useState(false)

  const platformCfg = PLATFORM_CONFIG[platform]
  const charCount = content.length
  const charLimit = platformCfg?.charLimit ?? 2200
  const overLimit = charCount > charLimit

  // ── Handlers ────────────────────────────────────────────────────────────────

  function handlePlatformChange(p: string) {
    setPlatform(p)
    const firstAccount = accounts.find(a => a.platform === p)
    if (firstAccount) setAccountId(firstAccount.id)
  }

  function addHashtag() {
    const tag = newTag.replace(/^#/, "").trim()
    if (tag && !hashtags.includes(tag)) {
      setHashtags(prev => [...prev, tag])
    }
    setNewTag("")
  }

  function removeHashtag(tag: string) {
    setHashtags(prev => prev.filter(t => t !== tag))
  }

  // Media upload via Vercel Blob
  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const uploaded: string[] = []
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
          toast.error(`${file.name} is not an image or video`)
          continue
        }
        if (file.size > 50 * 1024 * 1024) {
          toast.error(`${file.name} exceeds 50MB limit`)
          continue
        }
        const blob = await upload(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
        })
        uploaded.push(blob.url)
      }
      if (uploaded.length > 0) {
        setMediaUrls(prev => [...prev, ...uploaded])
        toast.success(`${uploaded.length} file(s) uploaded`)
      }
    } catch (err) {
      console.error("[PostComposerDialog] Upload error:", err)
      toast.error("Upload failed — please try again")
    } finally {
      setUploading(false)
    }
  }, [])

  // AI generate
  async function handleAIGenerate() {
    if (!aiTopic) { toast.error("Enter a topic first"); return }
    if (!platform) { toast.error("Select a platform first"); return }
    setGenerating(true)
    setComplianceViolations([])
    try {
      const result = await generateSocialPostContent({
        brief: aiTopic,
        platform,
        contentType: postType,
        agentId,
        brokerageId,
      })
      if (result.complianceBlocked) {
        setComplianceViolations(result.complianceViolations ?? [])
        toast.error("Content blocked by compliance rules")
      } else if (result.success && result.data) {
        setContent(result.data.content)
        setHashtags(result.data.hashtags ?? [])
        toast.success("Content generated")
      } else {
        toast.error(result.error ?? "Generation failed")
      }
    } catch {
      toast.error("Generation failed")
    } finally {
      setGenerating(false)
    }
  }

  // AI suggest hashtags
  async function handleSuggestHashtags() {
    if (!content) { toast.error("Write some content first"); return }
    setSuggestingTags(true)
    try {
      const result = await suggestHashtags({ content, platform })
      setHashtags(prev => {
        const combined = [...new Set([...prev, ...result.hashtags])]
        return combined.slice(0, platform === "instagram" ? 30 : 10)
      })
      toast.success("Hashtags suggested")
    } catch {
      toast.error("Failed to suggest hashtags")
    } finally {
      setSuggestingTags(false)
    }
  }

  // Save / schedule
  async function handleSave() {
    if (!platform)      { toast.error("Select a platform"); return }
    if (!accountId)     { toast.error("Select an account"); return }
    if (!content.trim()){ toast.error("Post content is required"); return }
    if (overLimit)      { toast.error(`Content exceeds ${charLimit} character limit`); return }

    setSaving(true)
    try {
      let result
      if (isEdit && initialPost) {
        result = await updateSocialPost({
          postId: initialPost.id,
          userId,
          content,
          hashtags,
          mediaUrls,
          platform,
          postType,
          scheduledFor: scheduledFor
            ? new Date(scheduledFor).toISOString()
            : undefined,
        })
      } else {
        result = await scheduleSocialPost({
          brokerageId,
          userId,
          agentId,
          platform,
          postType,
          content,
          hashtags,
          mediaUrls,
          scheduledFor: scheduledFor
            ? new Date(scheduledFor).toISOString()
            : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          socialAccountId: accountId,
          requiresBrokerApproval,
        })
      }

      if (result.success) {
        toast.success(isEdit ? "Post updated" : scheduledFor ? "Post scheduled" : "Post saved as draft")
        onSaved?.(result.data)
        onOpenChange(false)
      } else {
        toast.error(result.error ?? "Failed to save post")
      }
    } catch (err) {
      console.error("[PostComposerDialog] Save error:", err)
      toast.error("Failed to save post")
    } finally {
      setSaving(false)
    }
  }

  const platformAccounts = accounts.filter(a => a.platform === platform)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Post" : "Create New Post"}</DialogTitle>
          <DialogDescription>
            {requiresBrokerApproval
              ? "This post requires broker approval before publishing."
              : "Schedule or save a social media post."}
          </DialogDescription>
        </DialogHeader>

        {requiresBrokerApproval && (
          <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <Shield className="h-4 w-4 flex-shrink-0" />
            Broker approval is required for all posts at this brokerage. Your post will be submitted for review.
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="compose" className="flex-1">Compose</TabsTrigger>
            <TabsTrigger value="preview" className="flex-1" disabled={!platform || !content}>
              Preview
            </TabsTrigger>
          </TabsList>

          <TabsContent value="compose" className="space-y-4 mt-4">
            {/* Platform + Account */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Platform <span className="text-destructive">*</span></Label>
                <Select value={platform} onValueChange={handlePlatformChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select platform" />
                  </SelectTrigger>
                  <SelectContent>
                    {["facebook","instagram","linkedin","twitter","tiktok","youtube","pinterest"].map(p => (
                      <SelectItem key={p} value={p} disabled={!accounts.some(a => a.platform === p)}>
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                        {!accounts.some(a => a.platform === p) && " (not connected)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Account <span className="text-destructive">*</span></Label>
                <Select value={accountId} onValueChange={setAccountId} disabled={!platform}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {platformAccounts.map(a => (
                      <SelectItem key={a.id} value={a.id}>{a.account_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Post Type */}
            <div className="space-y-1">
              <Label>Post Type</Label>
              <Select value={postType} onValueChange={setPostType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POST_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* AI Topic + Generate */}
            <div className="space-y-1">
              <Label>AI Topic (optional)</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g., Just listed 4BR in Riverside — $650k..."
                  value={aiTopic}
                  onChange={e => setAiTopic(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleAIGenerate()}
                />
                <Button
                  variant="outline"
                  onClick={handleAIGenerate}
                  disabled={generating || !aiTopic || !platform}
                  className="flex-shrink-0"
                >
                  {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            {/* Compliance violations */}
            {complianceViolations.length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                <p className="text-sm font-medium text-destructive flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  Content blocked by compliance
                </p>
                <ul className="text-xs text-destructive list-disc list-inside space-y-0.5">
                  {complianceViolations.map((v, i) => <li key={i}>{v}</li>)}
                </ul>
              </div>
            )}

            {/* Content */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Content <span className="text-destructive">*</span></Label>
                {platform && (
                  <span className={`text-xs tabular-nums ${overLimit ? "text-destructive font-semibold" : "text-muted-foreground"}`}>
                    {charCount} / {charLimit.toLocaleString()}
                  </span>
                )}
              </div>
              <Textarea
                value={content}
                onChange={e => { setContent(e.target.value); setComplianceViolations([]) }}
                placeholder="Write your post content..."
                rows={5}
                className={overLimit ? "border-destructive" : ""}
              />
              {platformCfg && (
                <p className="text-xs text-muted-foreground">{platformCfg.hashtagNote}</p>
              )}
            </div>

            {/* Hashtags */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Hashtags</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleSuggestHashtags}
                  disabled={suggestingTags || !content}
                >
                  {suggestingTags
                    ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    : <Sparkles className="h-3 w-3 mr-1" />
                  }
                  Suggest
                </Button>
              </div>
              <div className="flex flex-wrap gap-1 min-h-8">
                {hashtags.map(tag => (
                  <Badge key={tag} variant="secondary" className="gap-1 cursor-default">
                    #{tag}
                    <button onClick={() => removeHashtag(tag)} className="hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add hashtag..."
                  value={newTag}
                  onChange={e => setNewTag(e.target.value.replace(/\s/g, ""))}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addHashtag() } }}
                />
                <Button variant="outline" size="sm" onClick={addHashtag} disabled={!newTag}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Media */}
            <div className="space-y-2">
              <Label>Media</Label>
              <div
                className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleFileSelect(e.dataTransfer.files) }}
              >
                {uploading ? (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <p className="text-sm">Uploading...</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Upload className="h-6 w-6" />
                    <p className="text-sm">Drag & drop or click to upload images/videos</p>
                    <p className="text-xs">Max 50MB per file</p>
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={e => handleFileSelect(e.target.files)}
              />
              <div className="flex items-center justify-between gap-2 -mt-1">
                <p className="text-[11px] text-muted-foreground">
                  Or generate one with AI — brand-aware, fair-housing compliant
                </p>
                <GenerateImageButton
                  purpose="social_post"
                  defaultPrompt={content?.slice(0, 200) || ""}
                  tags={["social_post"]}
                  variant="outline"
                  label="Generate with AI"
                  onGenerated={(url) => {
                    setMediaUrls(prev => [...prev, url])
                    toast.success("AI image added to post")
                  }}
                />
              </div>
              {mediaUrls.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {mediaUrls.map((url, i) => (
                    <div key={i} className="relative group rounded overflow-hidden aspect-square">
                      <img
                        src={url}
                        alt={`Media ${i + 1}`}
                        className="w-full h-full object-cover"
                        crossOrigin="anonymous"
                      />
                      <button
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => setMediaUrls(prev => prev.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Schedule */}
            <div className="space-y-1">
              <Label>Schedule Date & Time</Label>
              <Input
                type="datetime-local"
                value={scheduledFor}
                min={new Date().toISOString().slice(0, 16)}
                onChange={e => setScheduledFor(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Leave empty to save as draft</p>
            </div>
          </TabsContent>

          <TabsContent value="preview" className="mt-4 flex justify-center">
            {platform && content ? (
              <PlatformPreview
                platform={platform}
                content={content}
                hashtags={hashtags}
                mediaUrl={mediaUrls[0]}
              />
            ) : (
              <p className="text-sm text-muted-foreground py-8">
                Add content and select a platform to see a preview.
              </p>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || overLimit || !platform || !content.trim()}>
            {saving ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
            ) : scheduledFor ? (
              <><Calendar className="h-4 w-4 mr-2" />{isEdit ? "Update" : "Schedule"}</>
            ) : (
              <><Send className="h-4 w-4 mr-2" />{isEdit ? "Save Changes" : "Save as Draft"}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
