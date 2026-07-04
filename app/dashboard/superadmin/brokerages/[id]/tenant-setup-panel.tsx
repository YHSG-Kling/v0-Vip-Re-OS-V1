"use client"

// STAFF-ASSISTED ONBOARDING — a superadmin/support view of a TENANT's role-aware setup readiness, so the
// staffer who enrolled them can work the checklist on their behalf (the brand/providers/commission/invite
// controls live on this same tenant page).
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ClipboardCheck, Loader2 } from "lucide-react"
import { getTenantSetupReadinessAction } from "@/app/actions/superadmin/tenant-setup"
import type { SetupReadiness } from "@/lib/onboarding/setup-readiness"

export function TenantSetupPanel({ brokerageId }: { brokerageId: string }) {
  const [data, setData] = useState<{ readiness: SetupReadiness; ownerName: string | null; ownerRole: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getTenantSetupReadinessAction(brokerageId).then((r) => {
      if (r.ok) setData({ readiness: r.readiness, ownerName: r.ownerName, ownerRole: r.ownerRole })
      else setErr(r.error)
      setLoading(false)
    })
  }, [brokerageId])

  const r = data?.readiness
  const required = r?.items.filter((i) => i.required) ?? []
  const optional = r?.items.filter((i) => !i.required) ?? []

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-primary" />
          Onboarding setup{r ? ` — ${r.pct}% ready` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : err ? (
          <p className="text-sm text-amber-700">{err}</p>
        ) : r ? (
          <>
            <p className="text-xs text-muted-foreground">
              {data?.ownerName ? `${data.ownerName} · ` : ""}{data?.ownerRole} · {r.requiredDone}/{r.requiredTotal} required done.
              Work the items below on their behalf using the controls on this page.
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className={"h-full rounded-full " + (r.isComplete ? "bg-green-500" : "bg-indigo-500")} style={{ width: `${r.pct}%` }} />
            </div>

            <div className="space-y-1.5">
              {required.map((i) => (
                <div key={i.key} className="flex items-start gap-2 text-sm">
                  <span className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold " + (i.done ? "bg-green-500 text-white" : "border-2 border-red-300 text-transparent")}>✓</span>
                  <div className="min-w-0">
                    <span className={i.done ? "text-muted-foreground line-through" : "font-medium"}>{i.label}</span>
                    {!i.done && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">required</span>}
                    {!i.done && <p className="text-xs text-muted-foreground">{i.why}</p>}
                  </div>
                </div>
              ))}
            </div>

            {optional.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Optional ({optional.filter((i) => i.done).length}/{optional.length})</summary>
                <div className="mt-2 space-y-1">
                  {optional.map((i) => (
                    <div key={i.key} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={i.done ? "text-green-600" : ""}>{i.done ? "✓" : "○"}</span>{i.label}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
