"use client"

// app/components/onboarding/tenant-readiness-card.tsx — the TENANT-ADMIN door's card (wave 140B+K).
// Mounted on the broker dashboard beside the role-aware setup checklist: that card says what the broker
// still CONFIGURES; this one says whether the workspace itself is provisioned and ready to operate, and
// lets the admin run the policy-bounded repairs. Renders nothing for a non-admin seat (the action refuses).
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ShieldCheck, Loader2, Wrench } from "lucide-react"
import { getMyTenantReadiness, repairMyTenantReadiness } from "@/app/actions/admin/tenant-readiness"
import type { TenantReadinessReport } from "@/lib/kernel/tenant-readiness"
import { TenantReadinessView } from "./tenant-readiness-view"

export function TenantReadinessCard() {
  const [report, setReport] = useState<TenantReadinessReport | null>(null)
  const [hidden, setHidden] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    getMyTenantReadiness().then((r) => { if (r.ok) setReport(r.report); else setHidden(true) })
  }, [])

  if (hidden || !report) return null
  const repairable = report.checks.filter((c) => c.status === "REPAIRABLE").length

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className={"h-4 w-4 " + (report.ready ? "text-green-600" : "text-amber-600")} />
          Workspace readiness{report.ready ? " — ready" : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <TenantReadinessView report={report} />
        {repairable > 0 && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
            const r = await repairMyTenantReadiness()
            if (r.ok) { setReport(r.report); setNote(null) } else setNote(r.error)
          })}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
            Repair {repairable} item(s) — fills what is missing, never changes your settings
          </Button>
        )}
        {note && <p className="text-xs text-amber-700">{note}</p>}
      </CardContent>
    </Card>
  )
}
