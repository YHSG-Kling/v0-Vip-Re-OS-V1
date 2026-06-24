"use client"

import { useState } from "react"
import { X, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react"
import type { StageDefinition } from "@/lib/listing-lifecycle/lifecycle-definitions"

interface Props {
  stage: StageDefinition
  listingId: string
  canOverride: boolean
  isPending: boolean
  onConfirm: (notes: string, isOverride: boolean, overrideReason: string) => void
  onClose: () => void
}

export function StageAdvanceModal({ stage, canOverride, isPending, onConfirm, onClose }: Props) {
  const [notes, setNotes] = useState("")
  const [isOverride, setIsOverride] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")

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
          {/* Readiness checks */}
          {stage.readinessChecks.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Readiness Requirements
              </p>
              <ul className="space-y-1">
                {stage.readinessChecks.map((check) => (
                  <li key={check} className="flex items-center gap-2 text-xs text-foreground">
                    <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    {check.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
            </div>
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
            disabled={isPending || (isOverride && !overrideReason.trim())}
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
