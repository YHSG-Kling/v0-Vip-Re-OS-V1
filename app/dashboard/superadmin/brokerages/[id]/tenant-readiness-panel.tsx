"use client"

// The PLATFORM-STAFF door's panel (wave 140B+K): a named tenant's readiness contract on the god-console tenant
// page, beside the setup panel. Reading needs platform 'support'; the repair button is superadmin-only server-side.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ShieldCheck, Loader2, Wrench } from "lucide-react"
import { getTenantReadinessAction, repairTenantReadinessAction } from "@/app/actions/superadmin/tenant-readiness"
import type { TenantReadinessReport } from "@/lib/kernel/tenant-readiness"
import { TenantReadinessView } from "@/app/components/onboarding/tenant-readiness-view"

export function TenantReadinessPanel({ brokerageId }: { brokerageId: string }) {
  const [report, setReport] = useState<TenantReadinessReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, start] = useTransition()

  useEffect(() => {
    getTenantReadinessAction(brokerageId).then((r) => { if (r.ok) setReport(r.report); else setErr(r.error); setLoading(false) })
  }, [brokerageId])

  const repairable = report?.checks.filter((c) => c.status === "REPAIRABLE").length ?? 0
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className={"h-4 w-4 " + (report?.ready ? "text-green-600" : "text-amber-600")} />
          Tenant readiness contract{report ? (report.ready ? " — READY" : ` — ${report.blockers.length} open`) : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
          : err ? <p className="text-sm text-amber-700">{err}</p>
          : report ? (
            <>
              <TenantReadinessView report={report} staff />
              {repairable > 0 && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
                  const r = await repairTenantReadinessAction(brokerageId)
                  if (r.ok) { setReport(r.report); setErr(null) } else setErr(r.error)
                })}>
                  {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
                  Run declared repairs ({repairable}) through self-healing
                </Button>
              )}
            </>
          ) : null}
      </CardContent>
    </Card>
  )
}
