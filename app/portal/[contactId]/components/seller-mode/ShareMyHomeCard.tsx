import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Share2, Facebook, Linkedin, Twitter, ExternalLink, Link2 } from "lucide-react"

interface Props {
  listingId: string
  listingAddress: string
}

interface SocialPost {
  id: string
  content: string | null
  platform: string | null
  media_urls: string[] | null
  published_at: string | null
  status: string | null
}

/** The agent-pushed, ready-to-share payload (public link + per-platform copy) the seller portal's
 *  "Share My Home" surface is meant to show. Written by pushListingToSellerPortal; until now nothing
 *  read it, so the pushed copy never reached the seller. */
interface ShareFeedRow {
  public_url: string | null
  share_messages: Record<string, string> | null
  agent_note: string | null
  pushed_at: string | null
}

const SHARE_PLATFORM_ORDER = ["facebook", "linkedin", "twitter", "nextdoor", "instagram", "imessage"] as const

const PLATFORM_ICON: Record<string, React.ReactNode> = {
  facebook: <Facebook className="h-4 w-4" />,
  instagram: <Share2 className="h-4 w-4" />,
  linkedin: <Linkedin className="h-4 w-4" />,
  twitter: <Twitter className="h-4 w-4" />,
  tiktok: <Share2 className="h-4 w-4" />,
}

const SHARE_URLS: Record<string, (text: string) => string> = {
  facebook: (t) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(t)}`,
  twitter: (t) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}`,
  linkedin: (t) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(t)}`,
}

export async function ShareMyHomeCard({ listingId, listingAddress }: Props) {
  const supabase = await createClient()

  // The agent-pushed, ready-to-share payload (public link + per-platform copy) — the purpose-built
  // surface this card exists for. Read it FIRST so the seller actually sees what their agent pushed.
  const { data: shareFeed } = await supabase
    .from("seller_share_feed")
    .select("public_url, share_messages, agent_note, pushed_at")
    .eq("listing_id", listingId)
    .order("pushed_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const feed = (shareFeed as ShareFeedRow | null) ?? null

  // Secondary: the agent's published social posts for this listing's campaigns.
  const { data: campaigns } = await supabase
    .from("marketing_campaigns")
    .select("id")
    .eq("listing_id", listingId)
    .limit(10)
  const campaignIds = (campaigns ?? []).map((c) => c.id)
  const { data: posts } = campaignIds.length
    ? await supabase
        .from("social_posts")
        .select("id, content, platform, media_urls, published_at, status")
        .in("marketing_campaign_id", campaignIds)
        .not("status", "eq", "draft")
        .order("published_at", { ascending: false })
        .limit(6)
    : { data: [] as SocialPost[] }

  // Nothing pushed and nothing published — no surface to show.
  if (!feed && (!posts || posts.length === 0)) {
    return null
  }

  const feedMessages = feed?.share_messages ?? null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Share2 className="h-5 w-5 text-blue-600" />
          Share My Home
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Your home, ready to share with friends and family for {listingAddress}. Your neighbors often
          know exactly who'd love to live nearby.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Agent-pushed share payload — the public link + ready-to-send copy per platform. */}
        {feed && (
          <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 space-y-3">
            {feed.agent_note && (
              <p className="text-sm text-foreground">{feed.agent_note}</p>
            )}
            {feed.public_url && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7" asChild>
                  <a href={feed.public_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" /> Open my listing page
                  </a>
                </Button>
                <code className="text-xs text-muted-foreground break-all flex items-center gap-1">
                  <Link2 className="h-3 w-3 shrink-0" /> {feed.public_url}
                </code>
              </div>
            )}
            {feedMessages && (
              <div className="space-y-2">
                {SHARE_PLATFORM_ORDER.filter((p) => feedMessages[p]?.trim()).map((platform) => {
                  const text = feedMessages[platform]
                  const shareHref = platform === "twitter"
                    ? SHARE_URLS.twitter(text)
                    : (feed.public_url && SHARE_URLS[platform] ? SHARE_URLS[platform](feed.public_url) : null)
                  return (
                    <div key={platform} className="rounded-md border bg-background p-2 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        {PLATFORM_ICON[platform] ?? <Share2 className="h-4 w-4" />}
                        <Badge variant="secondary" className="text-xs capitalize">{platform}</Badge>
                        {shareHref && (
                          <Button size="sm" variant="ghost" className="gap-1.5 text-xs h-6 ml-auto" asChild>
                            <a href={shareHref} target="_blank" rel="noopener noreferrer">
                              <Share2 className="h-3 w-3" /> Share
                            </a>
                          </Button>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground whitespace-pre-line select-all">{text}</p>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {posts && posts.length > 0 && (
          <p className="text-xs font-medium text-muted-foreground pt-1">Posts your agent published</p>
        )}
        {(posts ?? []).map((post: SocialPost) => (
          <div key={post.id} className="rounded-lg border p-3 space-y-2">
            {post.platform && (
              <div className="flex items-center gap-1.5">
                {PLATFORM_ICON[post.platform.toLowerCase()] ?? <Share2 className="h-4 w-4" />}
                <Badge variant="secondary" className="text-xs capitalize">
                  {post.platform}
                </Badge>
                {post.published_at && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(post.published_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            )}

            {post.content && (
              <p className="text-sm text-muted-foreground line-clamp-3">{post.content}</p>
            )}

            {post.media_urls && post.media_urls.length > 0 && (
              <div className="flex gap-2 overflow-x-auto">
                {post.media_urls.slice(0, 3).map((url: string, i: number) => (
                  <img
                    key={i}
                    src={url}
                    alt="Listing media"
                    className="h-16 w-24 rounded object-cover shrink-0"
                  />
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {post.platform && SHARE_URLS[post.platform.toLowerCase()] && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-7"
                  asChild
                >
                  <a
                    href={SHARE_URLS[post.platform.toLowerCase()](
                      `${post.content?.slice(0, 200) ?? listingAddress}`
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Share2 className="h-3 w-3" />
                    Share on {post.platform}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-xs h-7"
                onClick={undefined}
                asChild
              >
                <button
                  onClick={() => {
                    if (typeof navigator !== "undefined" && post.content) {
                      navigator.clipboard.writeText(post.content)
                    }
                  }}
                >
                  Copy Caption
                </button>
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
