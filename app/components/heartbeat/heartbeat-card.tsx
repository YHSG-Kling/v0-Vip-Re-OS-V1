"use client"

/**
 * <HeartbeatCard> — universal "what matters here" card.
 *
 * Every dashboard card on every role uses this shape:
 *   - Icon + Title (always)
 *   - 1–3 KPI tiles (large value + small label, optional trend arrow)
 *   - Status line (1 sentence summary or warning)
 *   - 1 primary CTA (and up to 2 secondary)
 *
 * Vision: agent reads any card in 2 seconds. Consistency reduces cognitive
 * load while preserving discoverability. Every dashboard surface should
 * lean on this component instead of bespoke layouts.
 */

import Link from "next/link"
import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Minus, ArrowRight } from "lucide-react"

export type HeartbeatStatus = "ok" | "attention" | "critical" | "neutral"

export interface HeartbeatMetric {
  label: string
  /** Display value — string allows currency, percent, etc. */
  value: string | number
  /** Optional trend indicator */
  trend?: "up" | "down" | "flat"
  /** Optional click-through to a drilldown */
  href?: string
}

export interface HeartbeatCTA {
  label: string
  /** Either an href for navigation OR an onClick action */
  href?: string
  onClick?: () => void
  /** Visual emphasis — primary is the main action */
  variant?: "primary" | "secondary" | "ghost"
  disabled?: boolean
}

export interface HeartbeatCardProps {
  /** Top-left icon (lucide icon already wrapped in JSX) */
  icon: ReactNode
  title: string
  /** Optional subtitle in smaller text under the title */
  subtitle?: string
  /** Status colors the left border + icon background */
  status?: HeartbeatStatus
  /** 1-3 metrics displayed as tiles */
  metrics?: HeartbeatMetric[]
  /** One-sentence status under the metrics — what the agent should know */
  statusLine?: string
  /** Up to 3 CTAs — first one is primary */
  ctas?: HeartbeatCTA[]
  /** Optional empty state */
  emptyMessage?: string
  /** When true the whole card is rendered but content area is dimmed (loading) */
  loading?: boolean
  /** Optional class name passthrough */
  className?: string
}

const STATUS_BORDER: Record<HeartbeatStatus, string> = {
  ok: "border-l-green-400",
  attention: "border-l-amber-400",
  critical: "border-l-red-500",
  neutral: "border-l-slate-200 dark:border-l-slate-700",
}

const STATUS_ICON_BG: Record<HeartbeatStatus, string> = {
  ok: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400",
  attention: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  critical: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
}

export function HeartbeatCard({
  icon,
  title,
  subtitle,
  status = "neutral",
  metrics = [],
  statusLine,
  ctas = [],
  emptyMessage,
  loading,
  className = "",
}: HeartbeatCardProps) {
  const isEmpty = metrics.length === 0 && !statusLine && ctas.length === 0 && !!emptyMessage

  return (
    <Card className={`border-l-4 ${STATUS_BORDER[status]} ${className}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          <div
            className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${STATUS_ICON_BG[status]}`}
          >
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent
        className={`space-y-3 pt-0 ${loading ? "opacity-50 pointer-events-none" : ""}`}
      >
        {isEmpty ? (
          <p className="text-xs text-muted-foreground py-2">{emptyMessage}</p>
        ) : (
          <>
            {metrics.length > 0 && (
              <div
                className={`grid gap-2 ${
                  metrics.length === 1
                    ? "grid-cols-1"
                    : metrics.length === 2
                    ? "grid-cols-2"
                    : "grid-cols-3"
                }`}
              >
                {metrics.map((m, i) => {
                  const Trend = m.trend === "up" ? TrendingUp : m.trend === "down" ? TrendingDown : Minus
                  const trendColor =
                    m.trend === "up"
                      ? "text-green-600"
                      : m.trend === "down"
                      ? "text-red-600"
                      : "text-muted-foreground"

                  const inner = (
                    <div className="space-y-0.5">
                      <div className="text-xl font-bold flex items-baseline gap-1.5">
                        {m.value}
                        {m.trend && (
                          <Trend className={`h-3 w-3 ${trendColor}`} />
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{m.label}</div>
                    </div>
                  )

                  return m.href ? (
                    <Link
                      key={i}
                      href={m.href}
                      className="hover:bg-muted/40 rounded p-1 -m-1 transition-colors"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={i}>{inner}</div>
                  )
                })}
              </div>
            )}

            {statusLine && (
              <p className="text-xs text-muted-foreground border-t pt-2">{statusLine}</p>
            )}

            {ctas.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-1">
                {ctas.map((cta, i) => {
                  const variant = cta.variant ?? (i === 0 ? "primary" : "secondary")
                  const buttonProps = {
                    size: "sm" as const,
                    variant: variant === "primary" ? ("default" as const) : ("outline" as const),
                    className: "h-7 text-xs gap-1",
                    disabled: cta.disabled,
                  }

                  const inner = (
                    <>
                      {cta.label}
                      {variant === "primary" && <ArrowRight className="h-3 w-3" />}
                    </>
                  )

                  return cta.href ? (
                    <Link key={i} href={cta.href}>
                      <Button {...buttonProps}>{inner}</Button>
                    </Link>
                  ) : (
                    <Button key={i} {...buttonProps} onClick={cta.onClick}>
                      {inner}
                    </Button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Compact status-only variant — single number + status line. Useful for
 * very dense overview rows.
 */
export function HeartbeatChip({
  icon,
  label,
  value,
  status = "neutral",
  href,
}: {
  icon: ReactNode
  label: string
  value: string | number
  status?: HeartbeatStatus
  href?: string
}) {
  const inner = (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs ${STATUS_ICON_BG[status]}`}>
      {icon}
      <span className="font-semibold">{value}</span>
      <span className="opacity-80">{label}</span>
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}
