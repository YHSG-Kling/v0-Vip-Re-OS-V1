"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  ClipboardCheck,
  FileBarChart,
  Presentation,
} from "lucide-react"
import {
  checkSellerDecisionReady,
  checkCMAReady,
  checkNetSheetValid,
  checkPresentationReady,
} from "@/app/actions/seller-decision-governance"
import Link from "next/link"

interface Props {
  listingId: string
}

interface ReadinessState {
  decision: { isReady: boolean } | null
  cma: { isReady: boolean } | null
  netSheet: { isValid: boolean } | null
  presentation: { isReady: boolean } | null
}

type CheckStatus = "pass" | "fail" | "loading" | "idle"

function StatusPill({
  label,
  status,
  icon: Icon,
}: {
  label: string
  status: CheckStatus
  icon: React.ComponentType<{ className?: string }>
}) {
  const styles: Record<CheckStatus, string> = {
    pass: "bg-emerald-50 border-emerald-200 text-emerald-700",
    fail: "bg-red-50 border-red-200 text-red-700",
    loading: "bg-muted border-border text-muted-foreground animate-pulse",
    idle: "bg-muted border-border text-muted-foreground",
  }

  const IconEl: Record<CheckStatus, React.ComponentType<{ className?: string }>> = {
    pass: CheckCircle2,
    fail: XCircle,
    loading: RefreshCw,
    idle: Icon,
  }

  const Ic = IconEl[status]

  return (
    <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${styles[status]}`}>
      <Ic className={`h-3 w-3 ${status === "loading" ? "animate-spin" : ""}`} />
      {label}
    </div>
  )
}

export function SellerDecisionReadinessCard({ listingId }: Props) {
  const [isPending, startTransition] = useTransition()
  const [state, setState] = useState<ReadinessState>({
    decision: null,
    cma: null,
    netSheet: null,
    presentation: null,
  })
  const [checked, setChecked] = useState(false)

  function runChecks() {
    startTransition(async () => {
      const [decisionRes, cmaRes, netSheetRes, presentationRes] = await Promise.all([
        checkSellerDecisionReady(listingId),
        checkCMAReady(listingId),
        checkNetSheetValid(listingId),
        checkPresentationReady(listingId),
      ])

      setState({
        decision: decisionRes.success ? (decisionRes.data ?? null) : null,
        cma: cmaRes.success ? (cmaRes.data ?? null) : null,
        netSheet: netSheetRes.success ? (netSheetRes.data ?? null) : null,
        presentation: presentationRes.success ? (presentationRes.data ?? null) : null,
      })
      setChecked(true)
    })
  }

  const allReady =
    state.decision?.isReady &&
    state.cma?.isReady &&
    state.netSheet?.isValid &&
    state.presentation?.isReady

  const cmaStatus: CheckStatus = !checked ? "idle" : isPending ? "loading" : state.cma?.isReady ? "pass" : "fail"
  const netStatus: CheckStatus = !checked ? "idle" : isPending ? "loading" : state.netSheet?.isValid ? "pass" : "fail"
  const presStatus: CheckStatus = !checked ? "idle" : isPending ? "loading" : state.presentation?.isReady ? "pass" : "fail"

  return (
    <Card className={`border-l-4 ${allReady ? "border-l-emerald-500" : "border-l-amber-400"}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-indigo-600" />
            Seller Decision Readiness
          </CardTitle>
          {checked && (
            <Badge
              className={
                allReady
                  ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                  : "bg-amber-100 text-amber-800 border border-amber-200"
              }
            >
              {allReady ? "All Ready" : "Action Needed"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Quick check pills */}
        <div className="flex flex-wrap gap-2">
          <StatusPill label="CMA" status={cmaStatus} icon={FileBarChart} />
          <StatusPill label="Net Sheet" status={netStatus} icon={FileBarChart} />
          <StatusPill label="Presentation" status={presStatus} icon={Presentation} />
        </div>

        {/* Not-ready blockers */}
        {checked && !allReady && !isPending && (
          <div className="flex flex-col gap-1.5 pt-1">
            {!state.cma?.isReady && (
              <div className="flex items-center justify-between rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  CMA not ready — comparable analysis may be missing or outdated
                </div>
                <Link href={`/dashboard/listings/${listingId}/cma`}>
                  <Button size="sm" variant="outline" className="h-6 text-xs px-2 shrink-0">
                    Fix
                  </Button>
                </Link>
              </div>
            )}
            {!state.netSheet?.isValid && (
              <div className="flex items-center justify-between rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Net sheet missing or expired — seller needs current proceeds estimate
                </div>
                <Link href={`/dashboard/listings/${listingId}/net-sheet`}>
                  <Button size="sm" variant="outline" className="h-6 text-xs px-2 shrink-0">
                    Fix
                  </Button>
                </Link>
              </div>
            )}
            {!state.presentation?.isReady && (
              <div className="flex items-center justify-between rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Seller presentation not marked ready
                </div>
                <Link href={`/dashboard/listings/${listingId}/presentation`}>
                  <Button size="sm" variant="outline" className="h-6 text-xs px-2 shrink-0">
                    Fix
                  </Button>
                </Link>
              </div>
            )}
          </div>
        )}

        {/* All ready message */}
        {checked && allReady && !isPending && (
          <p className="text-xs text-emerald-700 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            All decision materials are ready — the seller has everything needed to make an informed decision.
          </p>
        )}

        {/* Run / Re-run button */}
        <Button
          size="sm"
          variant={checked ? "ghost" : "outline"}
          onClick={runChecks}
          disabled={isPending}
          className="text-xs h-7"
        >
          {isPending ? (
            <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3 mr-1.5" />
          )}
          {checked ? "Re-run Checks" : "Check Readiness"}
        </Button>
      </CardContent>
    </Card>
  )
}
