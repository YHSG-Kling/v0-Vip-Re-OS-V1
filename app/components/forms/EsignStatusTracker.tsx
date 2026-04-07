"use client"

// app/components/forms/EsignStatusTracker.tsx
// ═══════════════════════════════════════════════════════════════════════════════
// E-SIGN SIGNATURE STATUS TRACKER
// ═══════════════════════════════════════════════════════════════════════════════
//
// EXPLICIT RULES:
//   • Polls /api/esign/status/[transactionId] via SWR every 15s when status < 100
//   • Stops polling when percentComplete === 100 or status === 'completed'
//   • Displays signer progress ring, signer count, and provider name
//   • No direct DB calls — all data from kernel API route
//   • externalTransactionId is required; if null/empty → renders "Not linked" state
//
// EXPLICIT UI BEHAVIOR:
//   • Ring = animated progress circle (0–100%)
//   • "Completed" badge when all signed
//   • "Awaiting signatures" badge when pending > 0
//   • "Not sent" state when externalTransactionId is null
//   • Sync button triggers manual re-fetch (no full page reload)

import useSWR from "swr"
import { CheckCircle, Clock, AlertCircle, RefreshCw, FileSignature } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Skeleton } from "@/app/components/ui/skeleton"
import { cn } from "@/lib/utils"

interface EsignStatusTrackerProps {
  /** The external transaction ID from the forms provider (e.g. Dotloop loop ID). */
  transactionId: string | null | undefined
  /** Deprecated alias — use transactionId */
  externalTransactionId?: string | null | undefined
  formName?: string
  compact?: boolean
  className?: string
}

interface EsignStatus {
  total:           number
  signed:          number
  pending:         number
  percentComplete: number
  provider?:       string
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Failed to fetch status")
    return r.json()
  })

export function EsignStatusTracker({
  transactionId,
  externalTransactionId,
  formName,
  compact = false,
  className,
}: EsignStatusTrackerProps) {
  // Support both prop names for backwards compatibility
  const resolvedId = transactionId ?? externalTransactionId
  const shouldPoll = !!resolvedId

  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; status: EsignStatus }>(
    shouldPoll ? `/api/esign/status/${resolvedId}` : null,
    fetcher,
    {
      refreshInterval: (data) => {
        // Stop polling when fully signed
        if (data?.status?.percentComplete === 100) return 0
        return 15_000 // poll every 15 seconds
      },
      revalidateOnFocus: false,
    }
  )

  const status = data?.status

  // ── Not linked state ──────────────────────────────────────────────────────
  if (!shouldPoll) {
    return (
      <Card className={cn("border-dashed", className)}>
        <CardContent className="flex items-center gap-3 py-4">
          <FileSignature className="h-5 w-5 text-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">Not sent for signature</p>
            <p className="text-xs text-muted-foreground">Launch e-sign to begin the signature process.</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-2 w-full rounded-full" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-6 w-20" />
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error || !status) {
    return (
      <Card className={cn("border-destructive/30", className)}>
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <p className="text-sm text-destructive">Could not fetch signature status</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    )
  }

  const { total, signed, pending, percentComplete, provider } = status
  const isComplete = percentComplete === 100
  const radius     = 28
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (percentComplete / 100) * circumference

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">
              {formName ? `${formName} — Signatures` : "Signature Status"}
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {provider ? `via ${provider}` : "E-sign in progress"}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mutate()}
            className="h-8 w-8 p-0"
            aria-label="Refresh signature status"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Progress ring + counts */}
        <div className="flex items-center gap-5">
          {/* SVG ring */}
          <div className="relative shrink-0">
            <svg width="72" height="72" viewBox="0 0 72 72" className="-rotate-90">
              {/* Track */}
              <circle
                cx="36"
                cy="36"
                r={radius}
                fill="none"
                stroke="hsl(var(--muted))"
                strokeWidth="6"
              />
              {/* Progress */}
              <circle
                cx="36"
                cy="36"
                r={radius}
                fill="none"
                stroke={isComplete ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.7)"}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                style={{ transition: "stroke-dashoffset 0.5s ease" }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              {isComplete ? (
                <CheckCircle className="h-5 w-5 text-primary" />
              ) : (
                <span className="text-sm font-bold">{percentComplete}%</span>
              )}
            </div>
          </div>

          {/* Count breakdown */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-3.5 w-3.5 text-green-500" />
              <span className="text-sm">
                <span className="font-semibold">{signed}</span>
                <span className="text-muted-foreground"> signed</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-sm">
                <span className="font-semibold">{pending}</span>
                <span className="text-muted-foreground"> pending</span>
              </span>
            </div>
            {total > 0 && (
              <div className="flex items-center gap-2">
                <FileSignature className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{total} total documents</span>
              </div>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div>
          {isComplete ? (
            <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-400">
              <CheckCircle className="h-3 w-3 mr-1" />
              All signatures complete
            </Badge>
          ) : pending > 0 ? (
            <Badge variant="outline" className="text-amber-600 border-amber-300">
              <Clock className="h-3 w-3 mr-1" />
              Awaiting {pending} signature{pending !== 1 ? "s" : ""}
            </Badge>
          ) : (
            <Badge variant="secondary">Pending review</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
