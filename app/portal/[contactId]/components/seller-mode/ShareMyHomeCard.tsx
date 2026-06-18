import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Share2, Facebook, Linkedin, Twitter, ExternalLink } from "lucide-react"

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

  // Find campaigns linked to this listing
  const { data: campaigns } = await supabase
    .from("marketing_campaigns")
    .select("id")
    .eq("listing_id", listingId)
    .limit(10)

  if (!campaigns || campaigns.length === 0) {
    return null
  }

  const campaignIds = campaigns.map((c) => c.id)

  // Get published social posts for these campaigns
  const { data: posts } = await supabase
    .from("social_posts")
    .select("id, content, platform, media_urls, published_at, status")
    .in("marketing_campaign_id", campaignIds)
    .not("status", "eq", "draft")
    .order("published_at", { ascending: false })
    .limit(6)

  if (!posts || posts.length === 0) {
    return null
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Share2 className="h-5 w-5 text-blue-600" />
          Share My Home
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Your agent has created these posts about {listingAddress}. Share them on your social channels
          to reach more potential buyers!
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {posts.map((post: SocialPost) => (
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
