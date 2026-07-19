"use client"

// app/portal/[contactId]/components/seller-mode/SellerSharePostsRail.tsx
//
// SELLER SHARE RAIL (no-OAuth) — the seller re-shares their listing's PUBLISHED
// social posts to their OWN channels, from their OWN logged-in browser.
//
// COMPLIANCE NOTE: nothing here sends from our infrastructure — every button is
// either the native Web Share sheet, a public share-intent URL the seller opens
// in their own session, a clipboard copy, or an asset download. No tokens, no
// egress gate needed. Only PUBLISHED posts (never drafts/scheduled) are ever
// passed in — the server mount (ShareMyHomeCard) enforces status='published'.
//
// ATTRIBUTION: the share URL is the listing's public landing page with
// ?ref=seller-share&listing=<id>&utm_source=seller-share&utm_campaign=… already
// appended by the server mount. This component only adds the per-network
// utm_medium, so /listing/[slug]'s existing logLandingSession() attributes
// seller-driven visits with zero new tables.

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Check,
  Copy,
  Download,
  Facebook,
  Linkedin,
  Share2,
  Twitter,
} from "lucide-react"

export interface SellerSharePost {
  id: string
  content: string | null
  platform: string | null
  /** First media asset of the post (image or video URL), if any. */
  mediaUrl: string | null
  publishedAt: string | null
}

interface Props {
  posts: SellerSharePost[]
  /** Public listing URL WITH attribution params already appended (or null when
   *  the listing has no public slug yet — link-based networks are hidden then). */
  shareUrl: string | null
  /** Display address used in the native share title. */
  address: string
}

/** Append the per-network utm_medium to an attribution URL. */
function withMedium(url: string, medium: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}utm_medium=${encodeURIComponent(medium)}`
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)
}

export function SellerSharePostsRail({ posts, shareUrl, address }: Props) {
  // navigator.share only exists on the client (and mostly on mobile) — gate
  // after mount so SSR markup stays stable.
  const [canNativeShare, setCanNativeShare] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      setCanNativeShare(true)
    }
  }, [])

  if (posts.length === 0) return null

  const nativeShare = async (post: SellerSharePost) => {
    try {
      await navigator.share({
        title: `${address} — for sale`,
        text: post.content ?? address,
        ...(shareUrl ? { url: withMedium(shareUrl, "native") } : {}),
      })
    } catch {
      /* user dismissed the share sheet — nothing to do */
    }
  }

  const copyCaption = async (post: SellerSharePost) => {
    const caption = [post.content ?? "", shareUrl ? withMedium(shareUrl, "copy") : ""]
      .filter(Boolean)
      .join("\n\n")
    try {
      await navigator.clipboard.writeText(caption)
      setCopiedId(post.id)
      setTimeout(() => setCopiedId((prev) => (prev === post.id ? null : prev)), 2000)
    } catch {
      /* clipboard unavailable — the caption text below is select-all */
    }
  }

  return (
    <div className="space-y-3">
      {posts.map((post) => {
        const fbHref = shareUrl
          ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(withMedium(shareUrl, "facebook"))}`
          : null
        const xHref = shareUrl
          ? `https://twitter.com/intent/tweet?text=${encodeURIComponent((post.content ?? address).slice(0, 240))}&url=${encodeURIComponent(withMedium(shareUrl, "x"))}`
          : null
        const liHref = shareUrl
          ? `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(withMedium(shareUrl, "linkedin"))}`
          : null

        return (
          <div key={post.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              {post.platform && (
                <Badge variant="secondary" className="text-xs capitalize">
                  {post.platform.replace(/_/g, " ")}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px] text-emerald-700 border-emerald-200">
                Published
              </Badge>
              {post.publishedAt && (
                <span className="text-xs text-muted-foreground ml-auto">
                  {new Date(post.publishedAt).toLocaleDateString()}
                </span>
              )}
            </div>

            {post.mediaUrl && (
              isVideoUrl(post.mediaUrl) ? (
                <video
                  src={post.mediaUrl}
                  className="h-28 w-full max-w-xs rounded object-cover"
                  muted
                  playsInline
                  controls
                  preload="metadata"
                />
              ) : (
                <img
                  src={post.mediaUrl}
                  alt="Post media"
                  className="h-28 w-full max-w-xs rounded object-cover"
                />
              )
            )}

            {post.content && (
              <p className="text-sm text-muted-foreground whitespace-pre-line select-all line-clamp-4">
                {post.content}
              </p>
            )}

            {/* Mobile-first action row: big tap targets, wraps on small screens. */}
            <div className="flex flex-wrap gap-2 pt-1">
              {canNativeShare && (
                <Button size="sm" className="gap-1.5 h-9" onClick={() => nativeShare(post)}>
                  <Share2 className="h-4 w-4" /> Share
                </Button>
              )}
              {fbHref && (
                <Button size="sm" variant="outline" className="gap-1.5 h-9" asChild>
                  <a href={fbHref} target="_blank" rel="noopener noreferrer">
                    <Facebook className="h-4 w-4" /> Facebook
                  </a>
                </Button>
              )}
              {xHref && (
                <Button size="sm" variant="outline" className="gap-1.5 h-9" asChild>
                  <a href={xHref} target="_blank" rel="noopener noreferrer">
                    <Twitter className="h-4 w-4" /> X
                  </a>
                </Button>
              )}
              {liHref && (
                <Button size="sm" variant="outline" className="gap-1.5 h-9" asChild>
                  <a href={liHref} target="_blank" rel="noopener noreferrer">
                    <Linkedin className="h-4 w-4" /> LinkedIn
                  </a>
                </Button>
              )}
              <Button size="sm" variant="ghost" className="gap-1.5 h-9" onClick={() => copyCaption(post)}>
                {copiedId === post.id
                  ? (<><Check className="h-4 w-4 text-emerald-600" /> Copied</>)
                  : (<><Copy className="h-4 w-4" /> Copy caption</>)}
              </Button>
              {post.mediaUrl && (
                <Button size="sm" variant="ghost" className="gap-1.5 h-9" asChild>
                  {/* download attr is best-effort cross-origin; opens the asset
                      full-size either way so the seller can save it. */}
                  <a href={post.mediaUrl} download target="_blank" rel="noopener noreferrer">
                    <Download className="h-4 w-4" /> Save {isVideoUrl(post.mediaUrl) ? "video" : "image"}
                  </a>
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
