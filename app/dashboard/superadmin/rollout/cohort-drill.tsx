"use client"

// Per-tenant cohort drill for ONE partially-rolled-out flag. The cohort itself
// is deterministic (rolloutBucket — computed server-side, displayed here); the
// only mutations wired are the EXISTING per-tenant override rails
// (setTenantFeatureOverrideAction: grant_trial pulls a tenant into a partial
// rollout, clear removes the override). No new mutation rails.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { setTenantFeatureOverrideAction } from "@/app/actions/superadmin/tenant-entitlements"

export interface CohortTenantRow {
  id: string
  name: string
  bucket: number
  inCohort: boolean
  override: "grant_trial" | "disable" | null
  trialEndsAt: string | null
  effective: boolean
}

export function CohortDrill({ featureKey, tenants }: { featureKey: string; tenants: CohortTenantRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function run(brokerageId: string, action: "grant_trial" | "clear") {
    setBusyId(brokerageId)
    setError(null)
    startTransition(async () => {
      const res = await setTenantFeatureOverrideAction({ brokerageId, featureKey, action })
      setBusyId(null)
      if (!res.ok) setError(res.error ?? "Failed to update override")
      else router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      {error && <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Brokerage</th>
              <th className="p-2 text-right">Bucket</th>
              <th className="p-2">Cohort</th>
              <th className="p-2">Override</th>
              <th className="p-2">Effective</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="p-2 font-medium">{t.name}</td>
                <td className="p-2 text-right tabular-nums text-xs text-muted-foreground">{t.bucket}</td>
                <td className="p-2">
                  <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (t.inCohort ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600")}>
                    {t.inCohort ? "in" : "out"}
                  </span>
                </td>
                <td className="p-2">
                  {t.override === "grant_trial" && (
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-violet-100 text-violet-800">
                      trial{t.trialEndsAt ? ` until ${new Date(t.trialEndsAt).toLocaleDateString()}` : ""}
                    </span>
                  )}
                  {t.override === "disable" && (
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">disabled</span>
                  )}
                  {!t.override && <span className="text-xs text-muted-foreground">—</span>}
                </td>
                <td className="p-2">
                  <span className={"rounded px-1.5 py-0.5 text-[11px] font-semibold " + (t.effective ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600")}>
                    {t.effective ? "enabled" : "off"}
                  </span>
                </td>
                <td className="p-2 text-right">
                  {t.override ? (
                    <button
                      onClick={() => run(t.id, "clear")}
                      disabled={pending}
                      className="rounded border px-2 py-0.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                    >
                      {busyId === t.id ? "…" : "Clear override"}
                    </button>
                  ) : !t.inCohort ? (
                    <button
                      onClick={() => run(t.id, "grant_trial")}
                      disabled={pending}
                      className="rounded border px-2 py-0.5 text-xs font-medium text-indigo-600 hover:bg-muted/50 disabled:opacity-50"
                    >
                      {busyId === t.id ? "…" : "Pull in (30-day trial)"}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
