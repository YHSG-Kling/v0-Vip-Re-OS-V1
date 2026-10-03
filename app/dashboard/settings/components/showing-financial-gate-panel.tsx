"use client"

/**
 * app/dashboard/settings/components/showing-financial-gate-panel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * WHETHER A BUYER MUST BE FINANCIALLY VERIFIED BEFORE A SHOWING (m377).
 *
 * OWNER RULING: "the gate should be included as a setting choice from the tenant
 * if they want to block the financial verification before setting or scheduling
 * a showing."
 *
 * The verification engine — pre-approval, proof of funds, lender intro, agent
 * confirmation, plus expiry — was already built and was enforced on no path at
 * all. This switch is what makes it real, for this brokerage only.
 *
 * The control reads its own outcome: it loads the saved value, it reports the
 * server's error verbatim when a save is refused, and it only shows the new
 * state after the server confirms it. A toggle that flips optimistically and
 * silently fails to persist is how a brokerage ends up believing its buyers are
 * gated when they are not.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ShieldCheck, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import {
  getShowingFinancialGateSetting,
  setShowingFinancialGateRequired,
} from "@/app/actions/settings/showing-financial-gate-setting"

export function ShowingFinancialGatePanel() {
  const [required, setRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    getShowingFinancialGateSetting().then((r) => {
      if (cancelled) return
      if (!r.ok) {
        // Do not present an unknown value as "off" — say we could not read it.
        setLoadError(r.error ?? "Could not load this setting.")
      } else {
        setRequired(r.required)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  function toggle(next: boolean) {
    startTransition(async () => {
      const res = await setShowingFinancialGateRequired(next)
      if (!res.ok) {
        toast.error(res.error ?? "Could not save this setting.")
        return // state unchanged — the switch still shows what is actually saved
      }
      setRequired(next)
      toast.success(
        next
          ? "Buyers must now be financially verified before a showing can be scheduled."
          : "Showings no longer require financial verification.",
      )
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Showing Requirements
        </CardTitle>
        <CardDescription>
          Whether a buyer must have their financing confirmed before your team can
          set or schedule a showing for them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="require-financial-verification">
              Require financial verification before a showing
            </Label>
            <p className="text-xs text-muted-foreground">
              Counts as verified: a pre-approval letter, proof of funds, a lender
              introduction, or an agent confirming the buyer&apos;s financials —
              and it must not have expired.
            </p>
          </div>
          <Switch
            id="require-financial-verification"
            checked={required}
            onCheckedChange={toggle}
            disabled={loading || isPending || !!loadError}
          />
        </div>

        {/* Turning this on changes live behaviour for real customers. Say so
            plainly and only once it is actually on. */}
        {required && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              This is on. Showing requests, agent-scheduled showings and client
              self-booking are all <strong>refused</strong> for a buyer who is not
              verified. The refusal tells the buyer exactly what is missing, and
              every block is recorded on the buyer&apos;s timeline. Showings
              already on the calendar are not affected.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
