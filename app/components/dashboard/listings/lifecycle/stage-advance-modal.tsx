"use client"

/**
 * Advance-stage confirmation.
 *
 * WHAT CHANGED (orphan burn-down). This modal listed the target stage's
 * "Readiness Requirements" straight out of the static stage definition, each with
 * the SAME grey tick, whether the requirement was met or not. It was a printed
 * copy of the rulebook, not a report on this listing — so an agent could read a
 * list of ticks, press Advance, and be refused by rules the modal had just
 * appeared to confirm.
 *
 * validateListingTransition evaluates exactly this: it resolves the listing's
 * current stage, runs evaluateReadinessChecks against the target stage's checks,
 * applies the role/stage-machine rules and (for launch stages) the launch-blocker
 * sweep, and returns which checks PASSED, which FAILED, and why the transition
 * would be refused. It executes no transition. It was complete, exported and
 * called only by executeListingTransition — never by anything an agent could see.
 *
 * It now runs when the modal opens, the requirement list shows real pass/fail, and
 * Advance is disabled on a refusal unless an authorised override is supplied.
 * `listingId` was previously destructured away unused; this is what it is for.
 */

import { useEffect, useState } from "react"
import { X, Loader2, AlertTriangle, CheckCircle2, XCircle, Circle } from "lucide-react"
import type { StageDefinition } from "@/lib/listing-lifecycle/lifecycle-definitions"
import { validateListingTransition } from "@/app/actions/listing-lifecycle-core"

interface Props {
  stage: StageDefinition
  listingId: string
  canOverride: boolean
  isPending: boolean
  onConfirm: (notes: string, isOverride: boolean, overrideReason: string) => void
  onClose: () => void
}

interface Validation {
  allowed: boolean
  reason?: string
  warnings?: string[]
  blockers?: string[]
  currentStage?: string | null
  readinessChecks?: { allPassed: boolean; passed: string[]; failed: string[] }
}

export function StageAdvanceModal({ stage, listingId, canOverride, isPending, onConfirm, onClose }: Props) {
  const [notes, setNotes] = useState("")
  const [isOverride, setIsOverride] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")

  const [validation, setValidation] = useState<Validation | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [validating, setValidating] = useState(true)

  useEffect(() => {
    let cancelled = false
    setValidating(true)
    setValidation(null)
    setValidationError(null)
    validateListingTransition({ listingId, targetStage: stage.stage })
      .then((res) => {
        if (cancelled) return
        if (!res.success || !("validation" in res) || !res.validation) {
          // A check that could not RUN is not a pass. Say which one it is.
          setValidationError((res as { error?: string }).error ?? "The transition could not be validated")
          return
        }
        setValidation(res.validation as Validation)
      })
      .catch((e: unknown) => {
        if (!cancelled) setValidationError(e instanceof Error ? e.message : "The transition could not be validated")
      })
      .finally(() => { if (!cancelled) setValidating(false) })
    return () => { cancelled = true }
  }, [listingId, stage.stage])

  const failed = new Set(validation?.readinessChecks?.failed ?? [])
  const passed = new Set(validation?.readinessChecks?.passed ?? [])
  const refused = validation ? !validation.allowed : false
  // A refusal is only overridable by someone with the authority, and an override
  // needs its reason — the server re-checks both.
  const blockedFromAdvancing = refused && !(canOverride && isOverride && overrideReason.trim().length > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card rounded-lg shadow-xl w-full max-w-md border border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="font-semibold text-foreground">Advance to {stage.label}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{stage.description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Readiness checks — evaluated against THIS listing */}
          {stage.readinessChecks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
                Readiness Requirements
                {validating && <Loader2 className="w-3 h-3 animate-spin" />}
              </p>
              <ul className="space-y-1">
                {stage.readinessChecks.map((check) => {
                  const isFailed = failed.has(check)
                  const isPassed = passed.has(check)
                  return (
                    <li
                      key={check}
                      className={`flex items-center gap-2 text-xs ${
                        isFailed ? "text-destructive" : isPassed ? "text-emerald-700" : "text-muted-foreground"
                      }`}
                    >
                      {isFailed ? (
                        <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      ) : isPassed ? (
                        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                      ) : (
                        <Circle className="w-3.5 h-3.5 flex-shrink-0" />
                      )}
                      {check.replace(/_/g, " ")}
                    </li>
                  )
                })}
              </ul>
              {!validating && !validation && !validationError && (
                <p className="mt-1 text-[11px] text-muted-foreground">Not yet evaluated.</p>
              )}
            </div>
          )}

          {/* The engine's verdict */}
          {validationError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
              <p className="text-[11px] text-destructive">
                Readiness could not be evaluated — {validationError}. Advancing may still be refused by the server.
              </p>
            </div>
          )}
          {validation && !validation.allowed && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 space-y-1">
              <p className="text-[11px] font-medium text-destructive">
                {validation.reason ?? "This transition is not allowed from the listing's current stage."}
              </p>
              {(validation.blockers ?? []).length > 0 && (
                <ul className="list-disc pl-4 text-[11px] text-destructive space-y-0.5">
                  {validation.blockers!.map((b) => <li key={b}>{b}</li>)}
                </ul>
              )}
              {canOverride && (
                <p className="text-[11px] text-destructive/80">
                  A broker/admin override below can proceed anyway — it is recorded.
                </p>
              )}
            </div>
          )}
          {validation && validation.allowed && (validation.warnings ?? []).length > 0 && (
            <ul className="list-disc pl-4 text-[11px] text-amber-700 space-y-0.5">
              {validation.warnings!.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}

          {/* Required roles */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Authorized Roles
            </p>
            <div className="flex flex-wrap gap-1">
              {stage.requiredRoles.map((role) => (
                <span
                  key={role}
                  className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs font-medium"
                >
                  {role}
                </span>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="advance-notes" className="block text-xs font-medium text-foreground mb-1">
              Notes (optional)
            </label>
            <textarea
              id="advance-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              placeholder="Add any context for this transition..."
            />
          </div>

          {/* Override toggle — broker/admin/team_lead only */}
          {canOverride && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isOverride}
                  onChange={(e) => setIsOverride(e.target.checked)}
                  className="rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                />
                <span className="text-xs font-medium text-amber-900">
                  Override (skip readiness checks)
                </span>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              </label>
              {isOverride && (
                <input
                  type="text"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Override reason (required)"
                  className="w-full rounded border border-amber-200 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
              )}
            </div>
          )}

          {/* Automations notice — a manual stage change still runs the managers' downstream work, so
              the operator is never surprised that moving a listing kicks off CMA prep, marketing, etc. */}
          <div className="rounded-md border border-blue-200 bg-blue-50 p-2.5 flex gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-blue-900 leading-snug">
              Moving to <strong>{stage.label}</strong> runs this stage&apos;s automations — tasks, marketing,
              and any AI prep your managers handle for it.
              {isOverride && " Overriding skips the readiness checks, but these automations still run."}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(notes, isOverride, overrideReason)}
            disabled={
              isPending ||
              validating ||
              (isOverride && !overrideReason.trim()) ||
              blockedFromAdvancing
            }
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Advance Stage
          </button>
        </div>
      </div>
    </div>
  )
}
