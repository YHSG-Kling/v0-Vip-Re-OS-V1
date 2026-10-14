// app/portal/[contactId]/components/seller-mode/ShareMyHomeCard.tsx
//
// SHARE MY HOME — the seller's no-OAuth share surface. Two sections:
//   1. The agent-pushed ready-to-share payload (seller_share_feed): public link
//      + per-platform copy the agent wrote.
//   2. The listing's recent PUBLISHED social posts, each with the interactive
//      share rail (native Web Share, FB/X/LinkedIn intents, copy caption,
//      download asset) — rendered by the SellerSharePostsRail client component.
//
// COMPLIANCE: sharing is the SELLER's own action from their own account/browser
// — nothing sends from our infra, so no egress gate applies. Only PUBLISHED
// posts are ever shareable (status='published' enforced below; drafts/scheduled/
// failed posts never reach the seller).
//
// ATTRIBUTION: every share link points at the listing's canonical public page
// (/listing/[slug], the same URL pushListingToSellerPortal resolves) with
// ?ref=seller-share&listing=<id>&utm_source=seller-share&utm_campaign=… so the
// public page's existing logLandingSession() (smart_landing_sessions +
// listing_page_analytics) attributes seller-driven visits — no new tables.

import { createClient } from "@/lib/supabase/server"
import { siteUrl } from "@/lib/platform/site-url"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Share2, Facebook, Linkedin, Twitter, ExternalLink, Link2 } from "lucide-react"
import { SellerSharePostsRail, type SellerSharePost } from "./SellerSharePostsRail"

interface Props {
  listingId: string
  listingAddress: string
  /** The portal's own contact (route param). The feed read is scoped to it —
   *  see the contact_id note on ShareFeedRow below. */
  contactId: string
}

interface PublishedPostRow {
  id: string
  content: string | null
  platform: string | null
  media_urls: string[] | null
  published_at: string | null
  status: string | null
}

/** The agent-pushed, ready-to-share payload (public link + per-platform copy)
 *  written by pushListingToSellerPortal. */
interface ShareFeedRow {
  public_url: string | null
  share_messages: Record<string, string> | null
  agent_note: string | null
  pushed_at: string | null
  /** users.id of the agent who pushed it — the writer stamps the signed-in
   *  user's auth id (app/dashboard/listings/[id]/share/page.tsx → pushListingToSellerPortal);
   *  no FK in scripts/schema-fk-map.ts, so the class is the writer's. */
  pushed_by_user_id: string | null
  /** The tenant the push landed on — the anchor for the name read below. */
  brokerage_id: string | null
  /** WHO the push was addressed to — pushListingToSellerPortal stamps the
   *  listing's own contact_id (app/actions/push-listing-to-seller-portal.ts:78).
   *  Until this card read it, a co-seller on the same listing was served the
   *  push addressed to the OTHER seller. NULL = listing-wide (no addressee was
   *  recorded), which every seller on the listing may see. */
  contact_id: string | null
}

/** Pick the newest feed row this contact is entitled to: addressed to them, or
 *  listing-wide (NULL addressee). A row addressed to a DIFFERENT contact is
 *  skipped rather than rendered. */
function selectFeedForContact(rows: ShareFeedRow[], contactId: string): ShareFeedRow | null {
  return rows.find((r) => r.contact_id === null || r.contact_id === contactId) ?? null
}

/**
 * WHO PUSHED IT — contact-facing (CLAUDE.md §5: the seller sees the agent's
 * DISPLAY NAME and nothing else about them). The name is read anchored on the
 * feed row's own brokerage_id, never on a caller field. Four states, never
 * collapsed and never "the system":
 *   resolved       — a user of that brokerage carries the id
 *   unresolved     — an id is stamped but no user of that brokerage carries it
 *   not_recorded   — the column is NULL
 *   lookup_refused — the name read itself was refused
 */
type PusherState = "resolved" | "unresolved" | "not_recorded" | "lookup_refused"

function pusherLine(state: PusherState, name: string | null, pushedAt: string | null): string {
  const when = pushedAt ? new Date(pushedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null
  const on = when ? ` on ${when}` : ""
  switch (state) {
    case "resolved":       return `Sent to your portal by ${name}${on}`
    case "unresolved":     return `Sent to your portal${on} by someone outside your agent's brokerage`
    case "lookup_refused": return `Sent to your portal${on} — the sender's name could not be looked up`
    case "not_recorded":   return `Sent to your portal${on} — sender not recorded`
  }
}

const SHARE_PLATFORM_ORDER = ["facebook", "linkedin", "twitter", "nextdoor", "instagram", "imessage"] as const

const PLATFORM_ICON: Record<string, React.ReactNode> = {
  facebook: <Facebook className="h-4 w-4" />,
  instagram: <Share2 className="h-4 w-4" />,
  linkedin: <Linkedin className="h-4 w-4" />,
  twitter: <Twitter className="h-4 w-4" />,
  tiktok: <Share2 className="h-4 w-4" />,
}

// Feed-section intent links. facebook/linkedin share a URL; twitter shares text.
const SHARE_URLS: Record<string, (t: string) => string> = {
  facebook: (u) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}`,
  twitter: (t) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}`,
  linkedin: (u) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(u)}`,
}

/** Append the seller-share attribution params to any public listing URL. */
function withSellerShareAttribution(url: string, listingId: string): string {
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}ref=seller-share&listing=${listingId}&utm_source=seller-share&utm_campaign=seller_share_${listingId}`
}

export async function ShareMyHomeCard({ listingId, listingAddress, contactId }: Props) {
  const supabase = await createClient()

  const [{ data: listingRow }, { data: shareFeed, error: shareFeedErr }, { data: campaigns }] = await Promise.all([
    supabase.from("listings").select("id, slug").eq("id", listingId).maybeSingle(),
    // A window, not limit(1): the newest row may be addressed to a CO-SELLER, and
    // the addressee filter runs in selectFeedForContact below (contactId is a route
    // param — keeping it out of a PostgREST `.or()` string keeps it out of the filter
    // grammar entirely).
    supabase
      .from("seller_share_feed")
      .select("public_url, share_messages, agent_note, pushed_at, pushed_by_user_id, brokerage_id, contact_id")
      .eq("listing_id", listingId)
      .order("pushed_at", { ascending: false })
      .limit(10),
    supabase.from("marketing_campaigns").select("id").eq("listing_id", listingId).limit(10),
  ])
  // Read, not swallowed: a refused feed read used to resolve as "nothing pushed"
  // and the card quietly disappeared.
  if (shareFeedErr) console.warn("[ShareMyHomeCard] seller_share_feed read refused:", shareFeedErr.message)
  const feed = selectFeedForContact((shareFeed as unknown as ShareFeedRow[] | null) ?? [], contactId)
  const slug = (listingRow as { slug: string | null } | null)?.slug ?? null

  // Resolve the pushing agent's display name, anchored on the feed row's tenant.
  let pusherState: PusherState = "not_recorded"
  let pusherName: string | null = null
  if (feed?.pushed_by_user_id) {
    if (!feed.brokerage_id) {
      // No tenant to anchor on → a cross-tenant name read is exactly what §4
      // forbids; say the lookup did not run rather than guess.
      pusherState = "lookup_refused"
    } else {
      const { data: pusher, error: pusherErr } = await supabase
        .from("users")
        .select("first_name, last_name")
        .eq("id", feed.pushed_by_user_id)
        .eq("brokerage_id", feed.brokerage_id)
        .maybeSingle()
      if (pusherErr) {
        console.warn("[ShareMyHomeCard] pusher name lookup refused:", pusherErr.message)
        pusherState = "lookup_refused"
      } else {
        const u = pusher as { first_name: string | null; last_name: string | null } | null
        pusherName = u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null
        pusherState = pusherName ? "resolved" : "unresolved"
      }
    }
  }

  // PUBLISHED posts only — the compliance line this surface never crosses.
  // social_posts carries listing_id directly AND via marketing_campaign_id;
  // query both paths and merge (older posts only have the campaign link).
  const campaignIds = (campaigns ?? []).map((c: { id: string }) => c.id)
  const [byListing, byCampaign] = await Promise.all([
    supabase
      .from("social_posts")
      .select("id, content, platform, media_urls, published_at, status")
      .eq("listing_id", listingId)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(6),
    campaignIds.length
      ? supabase
          .from("social_posts")
          .select("id, content, platform, media_urls, published_at, status")
          .in("marketing_campaign_id", campaignIds)
          .eq("status", "published")
          .order("published_at", { ascending: false })
          .limit(6)
      : Promise.resolve({ data: [] as PublishedPostRow[] }),
  ])
  const seen = new Set<string>()
  const publishedPosts: PublishedPostRow[] = [
    ...((byListing.data ?? []) as PublishedPostRow[]),
    ...((byCampaign.data ?? []) as PublishedPostRow[]),
  ]
    .filter((p) => p.status === "published" && !seen.has(p.id) && seen.add(p.id))
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .slice(0, 6)

  // Nothing pushed and nothing published — no surface to show.
  if (!feed && publishedPosts.length === 0) return null

  // Canonical public listing URL (+ attribution). Prefer the slug-derived URL;
  // fall back to the agent-pushed public_url from the share feed.
  const base = slug ? `${siteUrl()}/listing/${slug}` : (feed?.public_url ?? null)
  const shareUrl = base ? withSellerShareAttribution(base, listingId) : null

  const feedMessages = feed?.share_messages ?? null
  const railPosts: SellerSharePost[] = publishedPosts.map((p) => ({
    id: p.id,
    content: p.content,
    platform: p.platform,
    mediaUrl: p.media_urls?.[0] ?? null,
    publishedAt: p.published_at,
  }))

  return (
    // id anchor — the "Share these" nudge on marketing-receipt cards deep-links here.
    <Card id="share-my-home" className="scroll-mt-24">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Share2 className="h-5 w-5 text-blue-600" />
          Share My Home
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Your home, ready to share with friends and family for {listingAddress}. Your neighbors often
          know exactly who&apos;d love to live nearby — every share links back to your home&apos;s page.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Agent-pushed share payload — the public link + ready-to-send copy per platform. */}
        {feed && (
          <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3 space-y-3">
            <p className="text-[11px] text-muted-foreground">{pusherLine(pusherState, pusherName, feed.pushed_at)}</p>
            {feed.agent_note && <p className="text-sm text-foreground">{feed.agent_note}</p>}
            {shareUrl && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7" asChild>
                  <a href={shareUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" /> Open my listing page
                  </a>
                </Button>
                <code className="text-xs text-muted-foreground break-all flex items-center gap-1">
                  <Link2 className="h-3 w-3 shrink-0" /> {shareUrl}
                </code>
              </div>
            )}
            {feedMessages && (
              <div className="space-y-2">
                {SHARE_PLATFORM_ORDER.filter((p) => feedMessages[p]?.trim()).map((platform) => {
                  const text = feedMessages[platform]
                  const shareHref = platform === "twitter"
                    ? SHARE_URLS.twitter(text)
                    : (shareUrl && SHARE_URLS[platform] ? SHARE_URLS[platform](shareUrl) : null)
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

        {/* Published posts + the interactive share rail (client component —
            native Web Share / intents / copy / download live there). */}
        {railPosts.length > 0 && (
          <>
            <p className="text-xs font-medium text-muted-foreground pt-1">
              Posts your team published — share them to your own channels
            </p>
            <SellerSharePostsRail posts={railPosts} shareUrl={shareUrl} address={listingAddress} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
