/**
 * <PortalLiveFeed> — customer-facing real-time event feed.
 *
 * Server component. Renders the customer-only rows from
 * portal_event_stream for this contact (RLS gates self-access; the action
 * call doubles as a defense layer). Each row shows the customer_copy,
 * an emoji icon, a relative timestamp, and a severity pill for
 * celebration / high-priority events.
 *
 * Three lifecycle modes route automatically via the contact's data:
 *   - Match (pre-deal)    → friendly "your offer was submitted" style
 *   - Deal (under contract) → milestone-stream
 *   - Forever (post-close)  → equity / refinance / anniversary
 */

import { getCustomerPortalFeed } from "@/app/actions/portal-stream"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Activity } from "lucide-react"
import { cn } from "@/lib/utils"

interface Props {
  contactId: string
  limit?:    number
  /** Compact mode used inside other cards. */
  compact?:  boolean
  /** When embedded inside another card, render nothing if there are no events. */
  hideWhenEmpty?: boolean
}

const SEVERITY_BORDER: Record<string, string> = {
  celebration: "border-emerald-300 bg-emerald-50/60",
  critical:    "border-red-300 bg-red-50/60",
  high:        "border-amber-300 bg-amber-50/60",
  normal:      "border-input bg-card",
}

function relativeTime(iso: string): string {
  const now = Date.now()
  const t = new Date(iso).getTime()
  const diff = (now - t) / 1000
  if (diff < 60)      return "just now"
  if (diff < 3600)    return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400)   return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800)  return `${Math.floor(diff / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export async function PortalLiveFeed({ contactId, limit, compact, hideWhenEmpty }: Props) {
  const res = await getCustomerPortalFeed({ contactId, limit: limit ?? 20 })
  const rows = res.success ? (res.rows ?? []) : []

  if (rows.length === 0) {
    if (hideWhenEmpty) return null
    return (
      <Card>
        <CardContent className="py-6 text-center">
          <Activity className="h-5 w-5 text-muted-foreground mx-auto mb-1.5" />
          <p className="text-sm text-muted-foreground">
            Your live feed will appear here as your deal progresses.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className={cn("pb-3", compact && "pb-2")}>
        <CardTitle className={cn("flex items-center gap-2", compact ? "text-sm" : "text-base")}>
          <Activity className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
          Live updates
        </CardTitle>
      </CardHeader>
      <CardContent className={cn("space-y-2", compact && "space-y-1.5")}>
        {rows.map((r) => (
          <div
            key={r.id}
            className={cn(
              "rounded-lg border p-3 flex items-start gap-3",
              SEVERITY_BORDER[r.severity] ?? SEVERITY_BORDER.normal,
              compact && "p-2 gap-2"
            )}
          >
            <span className={cn("shrink-0", compact ? "text-base" : "text-lg")}>
              {r.customerIcon ?? "•"}
            </span>
            <div className="flex-1 min-w-0">
              <p className={cn("leading-snug", compact ? "text-xs" : "text-sm")}>
                {r.customerCopy}
              </p>
              <p className={cn("text-muted-foreground mt-0.5", compact ? "text-[10px]" : "text-[11px]")}>
                {relativeTime(r.occurredAt)}
              </p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
