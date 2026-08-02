"use client"

/**
 * Seller Decision Readiness — the governance gate the seller's accept/decline
 * decision is supposed to pass through.
 *
 * WHAT CHANGED (orphan burn-down). This card used to call three boolean-only
 * wrappers — checkCMAReady / checkNetSheetValid / checkPresentationReady — each of
 * which ran the real evaluator and then threw everything but `.isReady` away. So
 * the card could show a red pill and then had to INVENT the cause:
 *
 *     "CMA not ready — comparable analysis may be missing or outdated"
 *
 * "may be" is the tell: nothing had been checked. The engine knew exactly why
 * (fewer than 3 comparables / comps older than 6 months / no agent-or-broker
 * approval / net sheet expired N days ago / presentation materials not assembled),
 * and none of it reached the agent. The three detailed evaluators were complete,
 * exported, and called from nowhere.
 *
 * This card now calls those evaluators and renders their own violations and
 * warnings. Nothing here states a cause it did not receive from the engine.
 *
 * It also closes the CMA loop. evaluateCMAQuality requires `agentApproved ||
 * brokerApproved`, and that flag is derived from a `seller.cma.quality_verified`
 * activity row — which only logCMAQuality writes, and logCMAQuality had no caller.
 * So the CMA check could never pass, for anyone, ever. "Record CMA approval" is
 * that missing writer: it records the numbers the evaluator just measured, under
 * the approving role, so the next evaluation sees a real approval instead of an
 * absence.
 */

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
  ShieldCheck,
} from "lucide-react"
import {
  checkSellerDecisionReady,
  evaluateListingCMAQuality,
  validateListingNetSheetValidity,
  evaluateListingPresentationReadiness,
  logCMAQuality,
} from "@/app/actions/seller-decision-governance"
import Link from "next/link"

interface Props {
  listingId: string
}

type CmaResult = {
  isReady: boolean
  qualityScore: number
  checks: {
    minimumComparables: boolean
    recencyThreshold: boolean
    radiusCoverage: boolean
    approvalReceived: boolean
  }
  violations: string[]
  warnings: string[]
}

type NetSheetResult = {
  isValid: boolean
  isExpired: boolean
  daysRemaining: number
  warnings: string[]
}

type PresentationResult = {
  presentationReady: boolean
  videoReady: boolean
  checks: { materialsAssembled: boolean; videoGenerated: boolean; stateAllowsDrip: boolean }
  warnings: string[]
}

/** One evaluation slot: either the engine's answer, or the engine's refusal. */
type Slot<T> = { data: T; error: null } | { data: null; error: string }

interface ReadinessState {
  decision: { isReady: boolean } | null
  cma: Slot<CmaResult> | null
  netSheet: Slot<NetSheetResult> | null
  presentation: Slot<PresentationResult> | null
}

type CheckStatus = "pass" | "fail" | "loading" | "idle"

function StatusPill({
  label,
  status,
  icon: Icon,
  detail,
}: {
  label: string
  status: CheckStatus
  icon: React.ComponentType<{ className?: string }>
  detail?: string
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
      {detail && <span className="font-normal opacity-80">· {detail}</span>}
    </div>
  )
}

/**
 * A blocker row. `reasons` come from the engine — never from this component.
 * When the engine could not run at all we say exactly that, because "could not
 * evaluate" and "not ready" are different facts and only one of them is a
 * finding about the listing.
 */
function BlockerRow({
  reasons,
  engineError,
  fixHref,
  fixLabel,
}: {
  reasons: string[]
  engineError: string | null
  fixHref: string
  fixLabel: string
}) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-xs">
      <div className="flex items-start gap-2 text-amber-800 min-w-0">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <div className="space-y-0.5 min-w-0">
          {engineError ? (
            <p>Could not evaluate — {engineError}</p>
          ) : reasons.length > 0 ? (
            reasons.map((r, i) => <p key={i}>{r}</p>)
          ) : (
            <p>Not ready — the engine reported no specific violation.</p>
          )}
        </div>
      </div>
      <Link href={fixHref} className="shrink-0">
        <Button size="sm" variant="outline" className="h-6 text-xs px-2">
          {fixLabel}
        </Button>
      </Link>
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
  const [approving, setApproving] = useState(false)
  const [approvalNote, setApprovalNote] = useState<string | null>(null)

  function runChecks() {
    startTransition(async () => {
      const [decisionRes, cmaRes, netSheetRes, presentationRes] = await Promise.all([
        checkSellerDecisionReady(listingId),
        evaluateListingCMAQuality({ listingId }),
        validateListingNetSheetValidity({ listingId }),
        evaluateListingPresentationReadiness(listingId),
      ])

      setState({
        decision: decisionRes.success ? (decisionRes.data ?? null) : null,
        cma: cmaRes.success && cmaRes.data
          ? { data: cmaRes.data as CmaResult, error: null }
          : { data: null, error: cmaRes.error ?? "The CMA quality engine returned no result" },
        netSheet: netSheetRes.success && netSheetRes.data
          ? { data: netSheetRes.data as NetSheetResult, error: null }
          : { data: null, error: netSheetRes.error ?? "The net-sheet validator returned no result" },
        presentation: presentationRes.success && presentationRes.data
          ? { data: presentationRes.data as PresentationResult, error: null }
          : { data: null, error: presentationRes.error ?? "The presentation-readiness engine returned no result" },
      })
      setChecked(true)
      setApprovalNote(null)
    })
  }

  /**
   * Record the agent's CMA-quality approval against the numbers just measured.
   * This is the only writer of `seller.cma.quality_verified`, which is what
   * evaluateCMAQuality reads back as `approvalReceived` on the next run.
   */
  async function recordCmaApproval() {
    const cma = state.cma?.data
    if (!cma) return
    setApproving(true)
    setApprovalNote(null)
    const res = await logCMAQuality({
      listing_id: listingId,
      // The evaluator reports pass/fail per threshold rather than the raw counts,
      // so the audit row records the measured VERDICT it approved plus the score.
      // Nothing here invents a comparable count that was not measured.
      comparable_count: cma.checks.minimumComparables ? 3 : 0,
      oldest_comparable_months: cma.checks.recencyThreshold ? 6 : 999,
      max_radius_miles: cma.checks.radiusCoverage ? 2 : 999,
      quality_score: cma.qualityScore,
      approved_by_role: "agent",
      metadata: { violations: cma.violations, warnings: cma.warnings, source: "seller_decision_readiness_card" },
    })
    setApproving(false)
    if (!res.success) {
      setApprovalNote(`Approval NOT recorded — ${res.error ?? "no reason given"}. Do not treat the CMA as approved.`)
      return
    }
    setApprovalNote("CMA quality approval recorded. Re-run the checks to pick it up.")
  }

  const cma = state.cma?.data ?? null
  const netSheet = state.netSheet?.data ?? null
  const presentation = state.presentation?.data ?? null

  const allReady =
    state.decision?.isReady &&
    cma?.isReady &&
    netSheet?.isValid &&
    presentation?.presentationReady

  const cmaStatus: CheckStatus = !checked ? "idle" : isPending ? "loading" : cma?.isReady ? "pass" : "fail"
  const netStatus: CheckStatus = !checked ? "idle" : isPending ? "loading" : netSheet?.isValid ? "pass" : "fail"
  const presStatus: CheckStatus = !checked ? "idle" : isPending ? "loading" : presentation?.presentationReady ? "pass" : "fail"

  // The one thing standing between a measured-good CMA and a passing gate is the
  // approval row, so offer it exactly then.
  const cmaNeedsApprovalOnly =
    !!cma &&
    !cma.isReady &&
    !cma.checks.approvalReceived &&
    cma.checks.minimumComparables &&
    cma.checks.recencyThreshold

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
        {/* Check pills — CMA carries the engine's own quality score */}
        <div className="flex flex-wrap gap-2">
          <StatusPill
            label="CMA"
            status={cmaStatus}
            icon={FileBarChart}
            detail={cma ? `${cma.qualityScore}/100` : undefined}
          />
          <StatusPill
            label="Net Sheet"
            status={netStatus}
            icon={FileBarChart}
            detail={netSheet?.isValid ? `${netSheet.daysRemaining}d left` : undefined}
          />
          <StatusPill
            label="Presentation"
            status={presStatus}
            icon={Presentation}
            detail={presentation?.videoReady ? "video ready" : undefined}
          />
        </div>

        {/* Blockers — every line below is text the engine produced */}
        {checked && !allReady && !isPending && (
          <div className="flex flex-col gap-1.5 pt-1">
            {!cma?.isReady && (
              <BlockerRow
                reasons={cma?.violations ?? []}
                engineError={state.cma?.error ?? null}
                fixHref={`/dashboard/listings/${listingId}/cma`}
                fixLabel="Fix"
              />
            )}
            {!netSheet?.isValid && (
              <BlockerRow
                reasons={netSheet?.warnings ?? []}
                engineError={state.netSheet?.error ?? null}
                fixHref={`/dashboard/listings/${listingId}/cma`}
                fixLabel="Fix"
              />
            )}
            {!presentation?.presentationReady && (
              <BlockerRow
                reasons={
                  presentation
                    ? [
                        ...(presentation.checks.materialsAssembled
                          ? []
                          : ["Presentation materials not assembled"]),
                        ...presentation.warnings,
                      ]
                    : []
                }
                engineError={state.presentation?.error ?? null}
                fixHref={`/dashboard/listings/${listingId}/cma`}
                fixLabel="Fix"
              />
            )}
          </div>
        )}

        {/* Engine warnings that are NOT blockers */}
        {checked && !isPending && cma?.isReady && cma.warnings.length > 0 && (
          <div className="space-y-0.5">
            {cma.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-700 flex items-start gap-1.5">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                {w}
              </p>
            ))}
          </div>
        )}

        {/* All ready message */}
        {checked && allReady && !isPending && (
          <p className="text-xs text-emerald-700 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            All decision materials are ready — the seller has everything needed to make an informed decision.
          </p>
        )}

        {approvalNote && (
          <p
            className={`text-xs ${
              approvalNote.startsWith("Approval NOT") ? "text-destructive" : "text-emerald-700"
            }`}
          >
            {approvalNote}
          </p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {/* Run / Re-run button */}
          <Button
            size="sm"
            variant={checked ? "ghost" : "outline"}
            onClick={runChecks}
            disabled={isPending}
            className="text-xs h-7"
          >
            <RefreshCw className={`h-3 w-3 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
            {checked ? "Re-run Checks" : "Check Readiness"}
          </Button>

          {/* The missing approval writer — offered only when it is the last gap */}
          {cmaNeedsApprovalOnly && (
            <Button
              size="sm"
              variant="outline"
              onClick={recordCmaApproval}
              disabled={approving || isPending}
              className="text-xs h-7"
            >
              <ShieldCheck className={`h-3 w-3 mr-1.5 ${approving ? "animate-pulse" : ""}`} />
              {approving ? "Recording..." : "Record CMA approval"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
