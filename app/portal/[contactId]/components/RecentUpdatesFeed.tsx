/**
 * RecentUpdatesFeed — surfaces transparency_updates + client_portal_messages
 * on the buyer/seller/lifetime portal home pages.
 *
 * The kernel fans out transparency_update rows automatically when meaningful
 * milestones fire (LISTING_UNDER_CONTRACT, OFFER_ACCEPTED, etc.). Without
 * this component the rows never reach the client.
 */

import Link from "next/link"
import { Badge } from "@/app/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Bell, ArrowRight, MessageSquare, CheckCircle2, Share2, Video } from "lucide-react"

// Marketing-receipt card types whose content the SELLER can re-share from the
// "Share My Home" surface (published posts only). The nudge deep-links to the
// share rail's anchor on the portal home. Seller-only update_types — these
// never appear on buyer/lifetime feeds.
const SHAREABLE_UPDATE_TYPES = new Set(["listing_marketing_week", "listing_launch_seller"])

// THE CLIENT MEETING RECAP (round 41): the human-approved "what we discussed /
// what happens next" card composed after a meeting (agent-client-messages maps
// entity_type 'meeting_recap' → this update_type on approval). Renders as a
// first-class, visually distinct card — the title carries the meeting date; the
// body is the AUTHORED recap only (the meeting transcript itself never reaches
// this surface).
const MEETING_RECAP_UPDATE_TYPE = "meeting_recap"

// THE WELCOME PACKAGE (owner ruling): the personal video from the assigned agent
// must be visible "in the emila and in the portal". The email half rides in the
// send; THIS is the portal half. lib/kernel/client-welcome.ts writes the same
// transparency_updates card every other approved agent message uses and puts the
// resolved, bucket-hosted URL on metadata.welcome_video_url.
//
// `welcome_video_url` is null whenever the agent had no finished personal video,
// and the card then renders with NO video affordance at all — never a "coming
// soon" tile, which would imply a recording the agent never made.
const WELCOME_UPDATE_TYPE = "client_welcome"

/** The playable welcome clip on a card's metadata, or null. */
function welcomeVideoUrl(u: RecentUpdate): string | null {
  const m = u.metadata as Record<string, unknown> | null | undefined
  const url = m && typeof m.welcome_video_url === "string" ? m.welcome_video_url.trim() : ""
  return url ? url : null
}

export interface RecentUpdate {
  id: string
  title: string | null
  plain_language_summary: string | null
  message: string | null
  next_step: string | null
  next_step_date: string | null
  responsible_party: string | null
  responsible_party_name: string | null
  update_type: string | null
  is_visible_to_client: boolean | null
  created_at: string | null
  /** Optional cross-link to a transaction the agent wired the update to */
  transaction_id: string | null
  /** transparency_updates.metadata — carries welcome_video_url on the welcome card. */
  metadata?: Record<string, unknown> | null
}

interface Props {
  contactId: string
  updates: RecentUpdate[]
  /** Limit shown by default. Older updates are accessed via "See all". */
  limit?: number
  /** When true, hides the empty state (so the parent can decide what to render). */
  hideWhenEmpty?: boolean
}

export function RecentUpdatesFeed({ contactId, updates, limit = 4, hideWhenEmpty }: Props) {
  const visible = updates
    .filter(u => u.is_visible_to_client !== false)
    .slice(0, limit)

  if (visible.length === 0) {
    if (hideWhenEmpty) return null
    return (
      <Card className="border-dashed">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
          You're all caught up — your agent will post here when there's news on your deal.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4 text-blue-600" />
          What's new on your deal
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {visible.map(u => (
          <article
            key={u.id}
            className={`rounded-lg border p-3 space-y-1 ${u.update_type === MEETING_RECAP_UPDATE_TYPE ? "border-violet-200 bg-violet-50/50" : ""}`}
          >
            {u.update_type === MEETING_RECAP_UPDATE_TYPE && (
              <div className="flex items-center gap-1.5 pb-0.5">
                <Video className="h-3.5 w-3.5 text-violet-600" />
                <Badge variant="outline" className="text-[10px] border-violet-300 text-violet-700">
                  Meeting recap
                </Badge>
              </div>
            )}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium leading-tight">
                  {u.title ?? formatType(u.update_type)}
                </p>
                <p className={`text-xs text-muted-foreground mt-0.5 ${u.update_type === MEETING_RECAP_UPDATE_TYPE ? "whitespace-pre-line" : ""}`}>
                  {u.plain_language_summary ?? u.message ?? ""}
                </p>
              </div>
              {u.created_at && (
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {timeAgo(u.created_at)}
                </span>
              )}
            </div>
            {/* The agent's personal welcome video — rendered only when a real
                playable clip exists on the card. */}
            {u.update_type === WELCOME_UPDATE_TYPE && welcomeVideoUrl(u) && (
              <div className="pt-2">
                <video
                  controls
                  poster={
                    typeof (u.metadata as Record<string, unknown> | null)?.welcome_video_thumbnail_url === "string"
                      ? ((u.metadata as Record<string, unknown>).welcome_video_thumbnail_url as string)
                      : undefined
                  }
                  className="w-full max-w-md rounded-lg border"
                >
                  <source src={welcomeVideoUrl(u) as string} type="video/mp4" />
                  <a href={welcomeVideoUrl(u) as string} className="text-blue-700 hover:underline">
                    Watch the video from your agent
                  </a>
                </video>
                <p className="text-[11px] text-muted-foreground pt-1 flex items-center gap-1">
                  <Video className="h-3 w-3" />
                  A personal hello from your agent
                </p>
              </div>
            )}
            {u.next_step && (
              <div className="text-xs flex items-center gap-1 pt-1">
                <ArrowRight className="h-3 w-3 text-blue-500" />
                <span className="text-blue-700">
                  Next: {u.next_step}
                  {u.next_step_date ? ` · ${formatDate(u.next_step_date)}` : ""}
                </span>
              </div>
            )}
            {u.responsible_party && (
              <p className="text-[11px] text-muted-foreground">
                Responsible: {u.responsible_party_name ?? cap(u.responsible_party)}
              </p>
            )}
            {SHAREABLE_UPDATE_TYPES.has(u.update_type ?? "") && (
              <Link
                href={`/portal/${contactId}#share-my-home`}
                className="text-xs flex items-center gap-1 pt-1 text-blue-700 hover:underline"
              >
                <Share2 className="h-3 w-3" />
                Share these posts to your own social channels
              </Link>
            )}
          </article>
        ))}
        {updates.length > limit && (
          <Button variant="ghost" size="sm" asChild className="w-full">
            <Link href={`/portal/${contactId}/history`}>
              <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
              See all {updates.length} updates
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatType(t: string | null): string {
  if (!t) return "Update"
  return t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatDate(iso: string): string {
  try {
    return new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, {
      month: "short", day: "numeric",
    })
  } catch { return iso }
}

function timeAgo(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime()
    const s = Math.floor(ms / 1000)
    if (s < 60)  return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60)  return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24)  return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30)  return `${d}d ago`
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  } catch { return "" }
}
