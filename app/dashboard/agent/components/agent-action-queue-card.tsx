"use client"

/**
 * <AgentActionQueueCard> — Sprint 6.
 *
 * THE morning starting point. One ranked list composed of every
 * actionable signal across the system (portal events, deal-health
 * interventions, listing-health interventions, NPV-due touchpoints).
 *
 * Each row shows:
 *   - title + source attribution (chip)
 *   - contact / property context
 *   - $ impact + priority pill
 *   - severity stripe
 *   - 1-click disposition (3-way) OR deep-link to resolve, depending
 *     on the source's hasInlineDisposition flag
 *
 * Hides on inbox-zero (no flash).
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Loader2,
  Sparkles,
  CheckSquare,
  PlayCircle,
  X,
  ArrowRight,
  TrendingUp,
  AlertCircle,
  Activity,
  Crown,
  Radio,
  ShieldAlert,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  getAgentActionQueue,
} from "@/app/actions/agent-action-queue"
import type {
  AgentActionItem,
  ActionSource,
} from "@/lib/agent-action-queue/composer"
import { dispositionPortalEventAction, type DispositionMode } from "@/app/actions/portal-stream"

const SOURCE_META: Record<ActionSource, { label: string; color: string; icon: typeof Activity }> = {
  portal_event:         { label: "Live event",      color: "bg-blue-100 text-blue-800",     icon: Activity     },
  deal_health:          { label: "Deal Health",     color: "bg-orange-100 text-orange-800", icon: ShieldAlert  },
  listing_health:       { label: "Listing Health",  color: "bg-amber-100 text-amber-800",   icon: Radio        },
  lifetime_npv:         { label: "Lifetime NPV",    color: "bg-violet-100 text-violet-800", icon: Crown        },
  negotiation_strategy: { label: "Negotiation",     color: "bg-emerald-100 text-emerald-800", icon: Sparkles   },
  income_gap:           { label: "Income Truth",    color: "bg-rose-100 text-rose-800",     icon: Sparkles    },
  // The trust-latency rail — a client said yes/asked and it's waiting on you.
  client_decision:      { label: "Client decision", color: "bg-green-100 text-green-800",   icon: AlertCircle },
}

const SEVERITY_STRIPE: Record<string, string> = {
  critical:    "bg-red-500",
  high:        "bg-orange-500",
  medium:      "bg-amber-400",
  low:         "bg-gray-300",
  celebration: "bg-emerald-500",
}

function formatUsd(n: number | null | undefined): string {
  if (!n || n <= 0) return ""
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}

export function AgentActionQueueCard() {
  const router = useRouter()
  const [items, setItems] = useState<AgentActionItem[] | null>(null)
  const [totalImpact, setTotalImpact] = useState(0)
  const [, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAgentActionQueue({ limit: 12 })
      .then((r) => {
        if (cancelled || !r.success) return
        setItems(r.queue?.items ?? [])
        setTotalImpact(r.queue?.totalImpactSum ?? 0)
      })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [])

  async function handleDisposition(item: AgentActionItem, mode: DispositionMode) {
    if (!item.hasInlineDisposition) {
      // Non-portal sources go to their resolution surface — should never hit
      // this path. Defensive fallback.
      if (item.resolveHref) router.push(item.resolveHref)
      return
    }
    setBusyId(item.id)
    startTransition(async () => {
      try {
        const r = await dispositionPortalEventAction({ eventId: item.id, mode })
        if (r.success) {
          const msg: Record<DispositionMode, string> = {
            manual:      "Marked done",
            execute:     "Marked executed",
            ai_delegate: "Delegated to AI",
            dismiss:     "Dismissed",
          }
          toast.success(msg[mode])
          // Optimistic remove
          setItems((prev) => (prev ?? []).filter((x) => x.id !== item.id))
        } else {
          toast.error(r.error ?? "Could not record disposition")
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Disposition failed")
      } finally {
        setBusyId(null)
      }
    })
  }

  if (items === null) return null      // initial load, no flash
  if (items.length === 0) return null  // inbox zero, hide

  return (
    <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-white">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" />
            Today's Action Queue
            <span className="text-[10px] uppercase font-medium text-indigo-700 bg-indigo-100 px-1.5 py-0.5 rounded-full">
              {items.length} ranked
            </span>
          </CardTitle>
          {totalImpact > 0 && (
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pipeline impact</p>
              <p className="text-sm font-bold tabular-nums text-indigo-900">
                <TrendingUp className="h-3 w-3 inline mr-0.5" />
                {formatUsd(totalImpact)}
              </p>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {items.map((item, idx) => {
          const meta = SOURCE_META[item.source]
          const SourceIcon = meta.icon
          const stripe = SEVERITY_STRIPE[item.severity] ?? SEVERITY_STRIPE.low
          return (
            <div
              key={`${item.source}:${item.id}`}
              className="rounded-md border bg-card overflow-hidden flex"
            >
              <div className={cn("w-1 shrink-0", stripe)} />
              <div className="flex-1 p-2.5 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold text-indigo-900 tabular-nums">
                        #{idx + 1}
                      </span>
                      <span className={cn("text-[10px] uppercase font-medium px-1.5 py-0.5 rounded-full flex items-center gap-0.5", meta.color)}>
                        <SourceIcon className="h-2.5 w-2.5" />
                        {meta.label}
                      </span>
                      {item.impactDollars != null && item.impactDollars > 0 && (
                        <span className="text-[10px] uppercase font-medium text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-full">
                          {formatUsd(item.impactDollars)}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        priority {item.priority}
                      </span>
                    </div>
                    <p className="text-sm font-medium leading-snug mt-1">{item.title}</p>
                    {item.contactName && (
                      <p className="text-[11px] text-muted-foreground">
                        {item.contactName}
                      </p>
                    )}
                    {item.detail && item.detail !== item.title && (
                      <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                        {item.detail}
                      </p>
                    )}
                  </div>
                </div>

                {/* Action row */}
                {item.hasInlineDisposition ? (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1"
                      disabled={busyId === item.id}
                      onClick={() => handleDisposition(item, "manual")}
                      title="I already handled this outside the system"
                    >
                      {busyId === item.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <CheckSquare className="h-2.5 w-2.5" />}
                      Done manually
                    </Button>
                    <Button size="sm" variant="default" className="h-6 text-[11px] gap-1"
                      disabled={busyId === item.id}
                      onClick={() => handleDisposition(item, "execute")}
                    >
                      <PlayCircle className="h-2.5 w-2.5" />
                      Do now
                    </Button>
                    <Button size="sm" variant="secondary" className="h-6 text-[11px] gap-1 bg-violet-100 hover:bg-violet-200 text-violet-900"
                      disabled={busyId === item.id}
                      onClick={() => handleDisposition(item, "ai_delegate")}
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      Let AI do it
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1 text-muted-foreground"
                      disabled={busyId === item.id}
                      onClick={() => handleDisposition(item, "dismiss")}
                    >
                      <X className="h-2.5 w-2.5" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={item.resolveHref ?? "#"}
                      className="text-[11px] text-indigo-700 hover:underline inline-flex items-center gap-1"
                    >
                      Open to resolve <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
