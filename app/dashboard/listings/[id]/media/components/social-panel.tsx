"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { createSocialPost, approveSocialPost, deleteSocialPost } from "@/app/actions/listing-media"
import { generateSocialPostContent } from "@/app/actions/social/generate-social-post"
import { shareSocialPostWithSeller } from "@/app/actions/portal-messages"
import {
  PlusIcon,
  Share2Icon,
  CheckCircleIcon,
  Trash2Icon,
  ShieldCheckIcon,
  ShieldAlertIcon,
  CalendarIcon,
  Sparkles,
  Send,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/hooks/use-toast"
import { format } from "date-fns"

interface SocialPost {
  id: string
  platform: string
  post_type: string
  content: string | null
  hashtags: string[] | null
  media_urls: string[] | null
  scheduled_for: string | null
  published_at: string | null
  status: string | null
  approval_status: string | null
  brand_compliance_passed: boolean | null
  compliance_checked_at: string | null
  error_message: string | null
  created_at: string
}

interface SocialAccount {
  id: string
  platform: string
  account_name: string
  is_active: boolean
  scope: string | null
}

interface SocialPanelProps {
  listingId: string
  brokerageId: string
  agentId: string
  sellerContactId?: string | null
  posts: SocialPost[]
  accounts: SocialAccount[]
  canApprove: boolean
  onPostsChange: (posts: SocialPost[]) => void
}

const PLATFORMS = ["instagram", "facebook", "linkedin", "twitter", "tiktok", "all"]
const POST_TYPES = ["listing_announcement", "open_house_announcement", "just_listed", "price_reduction", "just_sold", "custom"]

const STATUS_BADGE: Record<string, string> = {
  draft:      "bg-muted text-muted-foreground",
  scheduled:  "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  published:  "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  failed:     "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
}

const APPROVAL_BADGE: Record<string, string> = {
  pending:  "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  approved: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
}

/** Map postType → human-readable brief for AI generation */
function buildBrief(platform: string, postType: string): string {
  const typeMap: Record<string, string> = {
    listing_announcement:    "Announce this listing to potential buyers",
    open_house_announcement: "Invite followers to an upcoming open house",
    just_listed:             "Celebrate a brand-new listing hitting the market",
    price_reduction:         "Share an exciting price improvement on this property",
    just_sold:               "Celebrate a successful sale and thank everyone involved",
    custom:                  "Write a compelling post about this property",
  }
  return typeMap[postType] ?? "Write a compelling real estate post"
}

export function SocialPanel({ listingId, brokerageId, agentId, sellerContactId, posts, accounts, canApprove, onPostsChange }: SocialPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [pushToSellerPortal, setPushToSellerPortal] = useState(false)
  const [form, setForm] = useState({
    platform:        "instagram",
    postType:        "listing_announcement",
    content:         "",
    hashtags:        "",
    mediaUrls:       "",
    scheduledFor:    "",
    socialAccountId: "",
  })

  const handleCreate = () => {
    if (!form.content.trim()) return
    startTransition(async () => {
      const result = await createSocialPost({
        listingId,
        brokerageId,
        platform:        form.platform,
        postType:        form.postType,
        content:         form.content.trim(),
        hashtags:        form.hashtags.split(",").map(h => h.trim()).filter(Boolean),
        mediaUrls:       form.mediaUrls.split(",").map(u => u.trim()).filter(Boolean),
        scheduledFor:    form.scheduledFor || undefined,
        socialAccountId: form.socialAccountId || undefined,
      })
      if (result.error) {
        toast({ title: "Error creating post", description: result.error, variant: "destructive" })
        return
      }
      if (pushToSellerPortal && sellerContactId) {
        // The user ticked "push to seller portal", so a silent failure here means
        // the seller never sees a post the agent believes they were sent.
        const shared = await shareSocialPostWithSeller(sellerContactId).catch(() => null)
        if (!shared?.success) {
          toast({ title: "Post created, but not shared to the seller portal", description: (shared as any)?.error ?? "Share it again from the seller's portal view.", variant: "destructive" })
        }
      }
      const updated = await import("@/app/actions/listing-media").then(m => m.getSocialPosts(listingId))
      onPostsChange(updated.data ?? [])
      setCreateOpen(false)
      setPushToSellerPortal(false)
      setForm({ platform: "instagram", postType: "listing_announcement", content: "", hashtags: "", mediaUrls: "", scheduledFor: "", socialAccountId: "" })
      toast({
        title: "Post created",
        description: pushToSellerPortal && sellerContactId
          ? "Brand compliance check queued. Seller has been notified via portal."
          : "Brand compliance check queued.",
      })
    })
  }

  const handleGenerateContent = async () => {
    setGenerating(true)
    try {
      const result = await generateSocialPostContent({
        brief:       buildBrief(form.platform, form.postType),
        platform:    form.platform,
        contentType: form.postType,
        listingId,
        brokerageId,
        agentId,
      })

      if (!result.success || !result.data) {
        toast({
          title: "Generation failed",
          description: result.error ?? "Failed to generate content",
          variant: "destructive",
        })
        return
      }

      setForm(f => ({
        ...f,
        content:  result.data!.content,
        hashtags: result.data!.hashtags?.join(", ") ?? f.hashtags,
      }))

      toast({ title: "Content generated", description: "Review and edit before posting." })
    } catch (err: any) {
      toast({ title: "Generation error", description: err?.message ?? "Unknown error", variant: "destructive" })
    } finally {
      setGenerating(false)
    }
  }

  const handleApprove = (id: string) => {
    startTransition(async () => {
      const result = await approveSocialPost(id)
      if (!result.success) { toast({ title: "Error", description: result.error, variant: "destructive" }); return }
      onPostsChange(posts.map(p => p.id === id ? { ...p, approval_status: "approved" } : p))
      toast({ title: "Post approved" })
    })
  }

  const handleDelete = (id: string) => {
    startTransition(async () => {
      const result = await deleteSocialPost(id)
      if (!result.success) { toast({ title: "Error", description: result.error, variant: "destructive" }); return }
      onPostsChange(posts.filter(p => p.id !== id))
      toast({ title: "Post deleted" })
    })
  }

  const pendingCount = posts.filter(p => p.approval_status === "pending").length

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {posts.length} post{posts.length !== 1 ? "s" : ""}
          {pendingCount > 0 && (
            <span className="ml-2 text-yellow-600 dark:text-yellow-400">
              · {pendingCount} pending approval
            </span>
          )}
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="flex items-center gap-2">
          <PlusIcon className="w-4 h-4" />
          New Post
        </Button>
      </div>

      {/* Post list */}
      {posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border rounded-lg gap-3">
          <Share2Icon className="w-8 h-8 text-muted-foreground/50" />
          <p className="text-muted-foreground text-sm">No social posts yet.</p>
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            Create first post
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {posts.map(post => (
            <Card key={post.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-xs capitalize">{post.platform}</Badge>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_BADGE[post.status ?? "draft"] ?? STATUS_BADGE.draft}`}>
                      {post.status ?? "draft"}
                    </span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${APPROVAL_BADGE[post.approval_status ?? "pending"] ?? APPROVAL_BADGE.pending}`}>
                      {post.approval_status ?? "pending"}
                    </span>
                    {post.brand_compliance_passed === true && (
                      <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <ShieldCheckIcon className="w-3 h-3" /> Compliance OK
                      </span>
                    )}
                    {post.brand_compliance_passed === false && post.compliance_checked_at && (
                      <span className="flex items-center gap-1 text-xs text-destructive">
                        <ShieldAlertIcon className="w-3 h-3" /> Compliance failed
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {canApprove && post.approval_status === "pending" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => handleApprove(post.id)}
                        disabled={isPending}
                      >
                        <CheckCircleIcon className="w-3 h-3 mr-1" />
                        Approve
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(post.id)}
                      disabled={isPending}
                    >
                      <Trash2Icon className="w-3.5 h-3.5" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 flex flex-col gap-2">
                {post.content && (
                  <p className="text-sm text-foreground line-clamp-3 leading-relaxed">{post.content}</p>
                )}
                {post.hashtags && post.hashtags.length > 0 && (
                  <p className="text-xs text-primary">{post.hashtags.map(h => `#${h}`).join(" ")}</p>
                )}
                {post.scheduled_for && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CalendarIcon className="w-3 h-3" />
                    Scheduled for {format(new Date(post.scheduled_for), "MMM d, yyyy 'at' h:mm a")}
                  </div>
                )}
                {post.error_message && (
                  <p className="text-xs text-destructive">{post.error_message}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Social Post</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="platform">Platform</Label>
                <select
                  id="platform"
                  value={form.platform}
                  onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {PLATFORMS.map(p => (
                    <option key={p} value={p} className="capitalize">{p}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="postType">Post Type</Label>
                <select
                  id="postType"
                  value={form.postType}
                  onChange={e => setForm(f => ({ ...f, postType: e.target.value }))}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {POST_TYPES.map(t => (
                    <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Social account selector */}
            {accounts.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="socialAccount">Account (optional)</Label>
                <select
                  id="socialAccount"
                  value={form.socialAccountId}
                  onChange={e => setForm(f => ({ ...f, socialAccountId: e.target.value }))}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">No account selected</option>
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.platform} — {a.account_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="content">Content <span className="text-destructive">*</span></Label>
              <Textarea
                id="content"
                value={form.content}
                onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                placeholder="Write your post or use AI to generate one..."
                rows={4}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleGenerateContent}
                disabled={generating || isPending}
                className="gap-2 self-start"
              >
                <Sparkles className="h-4 w-4" />
                {generating ? "Generating..." : "Generate with AI"}
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hashtags">Hashtags (comma-separated)</Label>
              <Input
                id="hashtags"
                value={form.hashtags}
                onChange={e => setForm(f => ({ ...f, hashtags: e.target.value }))}
                placeholder="realestate, justlisted, homeforsale"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mediaUrls">Media URLs (comma-separated)</Label>
              <Input
                id="mediaUrls"
                value={form.mediaUrls}
                onChange={e => setForm(f => ({ ...f, mediaUrls: e.target.value }))}
                placeholder="https://..., https://..."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="scheduledFor">Schedule For (optional)</Label>
              <Input
                id="scheduledFor"
                type="datetime-local"
                value={form.scheduledFor}
                onChange={e => setForm(f => ({ ...f, scheduledFor: e.target.value }))}
              />
            </div>
          </div>
          {sellerContactId && (
            <div className="flex items-center gap-3 px-1 py-2 border rounded-lg bg-muted/20">
              <Send className="h-4 w-4 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Push to Seller Portal</p>
                <p className="text-xs text-muted-foreground">Notify seller so they can share on their channels</p>
              </div>
              <Switch checked={pushToSellerPortal} onCheckedChange={setPushToSellerPortal} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={isPending || !form.content.trim()}
            >
              {isPending ? "Creating..." : "Create Post"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
