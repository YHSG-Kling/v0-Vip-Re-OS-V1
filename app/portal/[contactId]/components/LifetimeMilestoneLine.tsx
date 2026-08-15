/**
 * LifetimeMilestoneLine — gives the lifetime customer the same "where am I"
 * signal that buyer/seller portals have. Computed entirely from
 * close_date deltas (no separate state machine — they're a homeowner).
 *
 *   < 30 days   → "Settling in" + helpful checklist
 *   30-180      → "X month{s} homeowner" + market reminder
 *   ~365        → "1-year anniversary coming up" / "Happy 1-year!"
 *   yearly      → "X-year homeowner" + refinance rate-check nudge
 *
 * If a refinance opportunity is detected (refinance_indicator pre-computed
 * elsewhere, or future), surface that as the priority message.
 */

import Link from "next/link"
import { Badge } from "@/app/components/ui/badge"
import { Card, CardContent } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Calendar, Sparkles, TrendingUp, ArrowRight, Heart } from "lucide-react"

interface Props {
  contactId: string
  closeDate: string | null
  /** When true, surface the refinance lane as the primary CTA. */
  refinanceOpportunity?: boolean
  /** Estimated current value (for equity callout). */
  currentEstimate?: number | null
  /** Original purchase price (for equity callout). */
  purchasePrice?: number | null
}

export function LifetimeMilestoneLine({
  contactId,
  closeDate,
  refinanceOpportunity,
  currentEstimate,
  purchasePrice,
}: Props) {
  if (!closeDate) return null
  const daysSinceClose = Math.floor(
    (Date.now() - new Date(closeDate).getTime()) / 86400000
  )
  if (daysSinceClose < 0) return null

  const summary = deriveSummary(daysSinceClose, refinanceOpportunity)

  const equityDelta =
    currentEstimate != null && purchasePrice != null && purchasePrice > 0
      ? currentEstimate - purchasePrice
      : null

  return (
    <Card className="border-l-4 border-l-emerald-500">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <div className={`p-2 rounded-full shrink-0 ${summary.iconBg}`}>
              <summary.Icon className={`h-4 w-4 ${summary.iconColor}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">{summary.headline}</h3>
                <Badge className={`text-[10px] h-[18px] px-1.5 leading-none ${summary.badgeClass}`}>
                  {summary.badgeLabel}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {summary.body}
              </p>
              {equityDelta != null && equityDelta > 0 && (
                <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
                  <TrendingUp className="h-3 w-3" />
                  Up an estimated ${equityDelta.toLocaleString()} since you bought
                </p>
              )}
            </div>
          </div>

          {summary.cta && (
            <Button size="sm" variant="outline" asChild className="shrink-0">
              <Link href={summary.cta.href}>
                {summary.cta.label}
                <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
              </Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Derive the right message for the current days-since-close ──────────────

function deriveSummary(days: number, refinanceOpportunity?: boolean) {
  // Refinance lane wins when an opportunity is flagged — most monetarily
  // impactful thing the lifetime customer can act on.
  if (refinanceOpportunity) {
    return {
      Icon: TrendingUp,
      iconBg: "bg-amber-100",
      iconColor: "text-amber-700",
      badgeClass: "bg-amber-100 text-amber-800",
      badgeLabel: "Opportunity",
      headline: "Refinance opportunity available",
      body:
        "Current rates may be low enough to save you money. Your portal has a fresh comparison against your original loan.",
      cta: { label: "See savings", href: "#refinance" },
    }
  }

  if (days < 30) {
    return {
      Icon: Heart,
      iconBg: "bg-blue-100",
      iconColor: "text-blue-700",
      badgeClass: "bg-blue-100 text-blue-800",
      badgeLabel: "Settling In",
      headline: "Welcome home",
      body:
        "First few weeks in a new home — change of address, utilities, getting to know the neighborhood. Your agent's vendor list is in the portal if you need help.",
      cta: { label: "Vendors", href: "#vendors" },
    }
  }

  if (days < 90) {
    const months = Math.max(1, Math.floor(days / 30))
    return {
      Icon: Calendar,
      iconBg: "bg-emerald-100",
      iconColor: "text-emerald-700",
      badgeClass: "bg-emerald-100 text-emerald-800",
      badgeLabel: `${months} month${months > 1 ? "s" : ""} in`,
      headline: "Settled into your new home",
      body: "Your home value is being tracked monthly — check the equity card for the latest estimate.",
    }
  }

  if (days < 330) {
    const months = Math.floor(days / 30)
    return {
      Icon: Calendar,
      iconBg: "bg-emerald-100",
      iconColor: "text-emerald-700",
      badgeClass: "bg-emerald-100 text-emerald-800",
      badgeLabel: `${months} months`,
      headline: `${months}-month homeowner`,
      body:
        "Halfway through your first year as a homeowner. Your equity should be growing — your agent will share market updates as they hit.",
    }
  }

  if (days >= 330 && days <= 395) {
    const isAfter = days >= 365
    return {
      Icon: Sparkles,
      iconBg: "bg-amber-100",
      iconColor: "text-amber-700",
      badgeClass: "bg-amber-100 text-amber-800",
      badgeLabel: isAfter ? "1 year" : "Anniversary soon",
      headline: isAfter
        ? "Happy one-year homeowner anniversary!"
        : "One-year anniversary coming up",
      body: isAfter
        ? "One year in your home. Equity has been growing all year — see your latest valuation in the portal."
        : "You're approaching one year as a homeowner. Your agent will reach out with a market update around your anniversary.",
    }
  }

  // Multi-year homeowner
  const years = Math.floor(days / 365)
  return {
    Icon: Calendar,
    iconBg: "bg-purple-100",
    iconColor: "text-purple-700",
    badgeClass: "bg-purple-100 text-purple-800",
    badgeLabel: `${years} years`,
    headline: `${years}-year homeowner`,
    body:
      "Your home has been working for you. Reach out anytime — refinance, neighborhood market updates, vendor recommendations.",
  }
}
