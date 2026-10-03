"use client"

/**
 * MLS pre-submission check — the UI half lib/listings/mls-rule-check.ts always
 * promised (":19-21 — every rule returns a fixHint the UI can render directly")
 * and never had. One button runs the validator against the saved listing via
 * the runMlsRuleCheck server action (session-gated, tenancy-checked) and the
 * per-rule results render inline with their fixHints, so the agent fixes the
 * avoidable rejections BEFORE the 24-48h MLS resubmit cycle.
 *
 * A failed read renders as a failure — never as "0 violations" (§4).
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ClipboardCheck, AlertTriangle, CheckCircle, Info } from "lucide-react"
import { runMlsRuleCheck, type MlsCheckActionResult } from "@/app/actions/mls-check"

const SEVERITY_BADGE: Record<string, string> = {
  error: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
}

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "error") return <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
  if (severity === "warning") return <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
  return <Info className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
}

export function MlsCheckPanel({ listingId }: { listingId: string }) {
  const [pending, startTransition] = useTransition()
  const [outcome, setOutcome] = useState<MlsCheckActionResult | null>(null)

  const runCheck = () => {
    startTransition(async () => {
      try {
        setOutcome(await runMlsRuleCheck(listingId))
      } catch {
        setOutcome({ ok: false, error: "The MLS check failed to run." })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary" />
            MLS Pre-Submission Check
          </CardTitle>
          <Button size="sm" variant="outline" disabled={pending} onClick={runCheck}>
            {pending ? "Checking…" : outcome ? "Re-check MLS rules" : "Check MLS rules"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Catches the avoidable MLS rejections — required fields, photo minimums,
          fair-housing language, remarks length — before you submit.
        </p>
      </CardHeader>
      {outcome && (
        <CardContent className="space-y-3">
          {!outcome.ok ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 p-3">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-red-600 shrink-0" />
              <p className="text-sm text-red-700 dark:text-red-300">
                The check could not run: {outcome.error}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {outcome.result.passed ? (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    No blocking errors
                  </Badge>
                ) : (
                  <Badge className={SEVERITY_BADGE.error}>
                    {outcome.result.errorCount} error{outcome.result.errorCount === 1 ? "" : "s"} — would be rejected
                  </Badge>
                )}
                {outcome.result.warningCount > 0 && (
                  <Badge className={SEVERITY_BADGE.warning}>
                    {outcome.result.warningCount} warning{outcome.result.warningCount === 1 ? "" : "s"}
                  </Badge>
                )}
                <span className="text-[11px] text-muted-foreground">
                  checked {new Date(outcome.checkedAt).toLocaleTimeString()}
                </span>
              </div>

              {outcome.result.violations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every universal and common MLS rule passed on the saved listing data.
                </p>
              ) : (
                <ul className="space-y-2">
                  {outcome.result.violations.map((v, i) => (
                    <li key={`${v.ruleId}-${i}`} className="rounded-lg border border-border p-3">
                      <div className="flex items-start gap-2">
                        <SeverityIcon severity={v.severity} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{v.message}</span>
                            <Badge className={`text-[10px] ${SEVERITY_BADGE[v.severity] ?? SEVERITY_BADGE.info}`}>
                              {v.severity} · {v.ruleId}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Fix: {v.fixHint}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted-foreground">
                Runs the universal + common rule set against the saved listing. Board-specific
                rules (e.g. NWMLS, BRIGHT) apply once the brokerage's MLS board is configured.
              </p>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
