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
import { Bell, ArrowRight, MessageSquare, CheckCircle2 } from "lucide-react"

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
          <article key={u.id} className="rounded-lg border p-3 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium leading-tight">
                  {u.title ?? formatType(u.update_type)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {u.plain_language_summary ?? u.message ?? ""}
                </p>
              </div>
              {u.created_at && (
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {timeAgo(u.created_at)}
                </span>
              )}
            </div>
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
