"use client"

/**
 * <AgentActionDispositionQueue> — the user's three-way disposition pattern.
 *
 * Surface for the agent: every open portal_event_stream row that requires
 * the agent's attention shows up here with three quick actions:
 *
 *   ✓ Done manually   — "I already handled this outside the system"
 *   ▶ Do now          — execute in-app (currently logs; future: opens
 *                        the matching Co-Pilot or composer)
 *   🤖 Let AI do it   — delegate to AI ISA / draft generator
 *
 * Plus an X to dismiss when not applicable. Every disposition logs to
 * `activities` and surfaces in the customer's portal feed when relevant.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Loader2,
  CheckSquare,
  PlayCircle,
  Sparkles,
  X,
  Inbox,
  AlertCircle,
} from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"
import { cn } from "@/lib/utils"
import {
  dispositionPortalEventAction,
  type DispositionMode,
  type PortalStreamRow,
} from "@/app/actions/portal-stream"

interface Props {
  rows: PortalStreamRow[]
  /** Compact card view used inside a contact's CRM panel. */
  compact?: boolean
  /** Title override (used when this surfaces under different headings). */
  title?: string
}

const SEVERITY_DOT: Record<string, string> = {
  critical:    "bg-red-500",
  high:        "bg-orange-500",
  celebration: "bg-emerald-500",
  normal:      "bg-blue-400",
}

export function AgentActionDispositionQueue({ rows, compact, title }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function handleDisposition(rowId: string, mode: DispositionMode) {
    setBusyId(rowId)
    startTransition(async () => {
      try {
        const r = await dispositionPortalEventAction({ eventId: rowId, mode })
        if (r.success) {
          const messages: Record<DispositionMode, string> = {
            manual:      "Marked done",
            execute:     "Marked executed",
            ai_delegate: "Delegated to AI",
            dismiss:     "Dismissed",
          }
          toast.success(messages[mode])
          router.refresh()
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

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader className={cn("pb-3", compact && "pb-2")}>
          <CardTitle className={cn("flex items-center gap-2", compact ? "text-sm" : "text-base")}>
            <Inbox className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            {title ?? "Open action items"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-3">
            Inbox zero — no open action items.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className={cn("pb-3", compact && "pb-2")}>
        <CardTitle className={cn("flex items-center justify-between gap-2", compact ? "text-sm" : "text-base")}>
          <span className="flex items-center gap-2">
            <AlertCircle className={cn("text-amber-500", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            {title ?? "Open action items"}
          </span>
          <span className="text-[10px] uppercase font-medium text-muted-foreground">
            {rows.length} open
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className={cn("space-y-2", compact && "space-y-1.5")}>
        {rows.map((r) => (
          <div key={r.id} className={cn(
            "rounded-md border bg-card p-3 space-y-2",
            compact && "p-2 space-y-1.5"
          )}>
            <div className="flex items-start gap-2">
              <span className={cn("inline-block rounded-full mt-1.5 shrink-0", SEVERITY_DOT[r.severity], compact ? "h-1.5 w-1.5" : "h-2 w-2")} />
              <div className="flex-1 min-w-0">
                {r.contactName && (
                  <Link
                    href={`/crm?contact=${r.contactId}`}
                    className={cn("font-medium hover:underline truncate inline-block max-w-full", compact ? "text-xs" : "text-sm")}
                  >
                    {r.contactName}
                  </Link>
                )}
                <p className={cn("leading-snug", compact ? "text-xs" : "text-sm")}>
                  {r.agentActionLabel ?? r.agentCopy}
                </p>
                {r.agentActionLabel && r.agentCopy !== r.agentActionLabel && (
                  <p className={cn("text-muted-foreground leading-snug mt-0.5", compact ? "text-[10px]" : "text-[11px]")}>
                    {r.agentCopy}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px] gap-1"
                disabled={busyId === r.id || isPending}
                onClick={() => handleDisposition(r.id, "manual")}
                title="I already handled this outside the system"
              >
                {busyId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckSquare className="h-3 w-3" />}
                Done manually
              </Button>
              <Button
                size="sm"
                variant="default"
                className="h-7 text-[11px] gap-1"
                disabled={busyId === r.id || isPending}
                onClick={() => handleDisposition(r.id, "execute")}
                title="Mark as done in-app — log activity"
              >
                <PlayCircle className="h-3 w-3" />
                Do now
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-[11px] gap-1 bg-violet-100 hover:bg-violet-200 text-violet-900"
                disabled={busyId === r.id || isPending}
                onClick={() => handleDisposition(r.id, "ai_delegate")}
                title="Let the AI ISA handle it"
              >
                <Sparkles className="h-3 w-3" />
                Let AI do it
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px] gap-1 text-muted-foreground"
                disabled={busyId === r.id || isPending}
                onClick={() => handleDisposition(r.id, "dismiss")}
                title="Not applicable — dismiss"
              >
                <X className="h-3 w-3" />
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
