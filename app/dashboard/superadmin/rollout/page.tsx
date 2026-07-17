import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { rolloutBucket } from "@/lib/entitlements/resolve"
import { normalizeOverrideType } from "@/lib/kernel/override-vocab"
import { CohortDrill, type CohortTenantRow } from "./cohort-drill"

export const dynamic = "force-dynamic"

// ROLLOUT COHORT BOARD — every feature flag's rollout posture. PLATFORM-GLOBAL
// READ by design (plans-gated, service client): cohorts are DETERMINISTIC, not
// stored — resolveEntitlement step 4 buckets each tenant with
// rolloutBucket(featureKey, brokerageId) (FNV-1a, 0–99) and admits buckets
// below feature_flags.rollout_percentage. This board recomputes those buckets
// with the SAME pure function, overlays brokerage-scoped
// feature_access_overrides (grant_trial pulls a tenant into a partial rollout;
// disable pushes it out), and wires the EXISTING override rails only — the
// rollout_percentage writer lives on the feature-governance board.

interface FlagRow {
  id: string
  feature_key: string
  display_name: string | null
  category: string | null
  enabled: boolean
  deprecated: boolean
  sunset_date: string | null
  superadmin_only: boolean
  rollout_percentage: number | null
}

export default async function SuperadminRolloutPage() {
  const gate = await requirePlatformCapability("plans")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const svc = createServiceClient()
  const [flagsRes, brkRes, ovRes] = await Promise.all([
    svc.from("feature_flags")
      .select("id, feature_key, display_name, category, enabled, deprecated, sunset_date, superadmin_only, rollout_percentage")
      .order("category").order("feature_key").limit(1000),
    svc.from("brokerages").select("id, name").is("deleted_at", null).order("name"),
    // Brokerage-scoped overrides only — the scope the rollout gate consults for whole-office pulls.
    svc.from("feature_access_overrides")
      .select("feature_key, brokerage_id, override_type, trial_ends_at")
      .is("user_id", null).is("team_id", null).limit(2000),
  ])
  const failed = [flagsRes, brkRes, ovRes].find((r) => r.error)
  if (failed?.error) return <div className="p-6 text-red-600">Failed to load rollout board: {failed.error.message}</div>

  const flags = (flagsRes.data ?? []) as FlagRow[]
  const tenants = ((brkRes.data ?? []) as any[]).map((b) => ({ id: b.id as string, name: (b.name as string) ?? "(unnamed)" }))
  const now = new Date()

  // feature_key → brokerage_id → override
  const overrides = new Map<string, Map<string, { type: "grant_trial" | "disable"; trialEndsAt: string | null }>>()
  for (const o of (ovRes.data ?? []) as any[]) {
    const kind = normalizeOverrideType(o.override_type)
    if (!kind) continue
    if (!overrides.has(o.feature_key)) overrides.set(o.feature_key, new Map())
    overrides.get(o.feature_key)!.set(o.brokerage_id, { type: kind, trialEndsAt: o.trial_ends_at ?? null })
  }

  const partial = flags.filter((f) => f.enabled && !f.deprecated && f.rollout_percentage != null && f.rollout_percentage < 100)
  const fullCount = flags.filter((f) => f.enabled && !f.deprecated && (f.rollout_percentage == null || f.rollout_percentage >= 100)).length
  const offCount = flags.filter((f) => !f.enabled || f.deprecated).length

  // Per partial flag: recompute every tenant's deterministic bucket + effective status.
  const partialBoards = partial.map((f) => {
    const pct = f.rollout_percentage ?? 100
    const ovByTenant = overrides.get(f.feature_key)
    const rows: CohortTenantRow[] = tenants.map((t) => {
      const bucket = rolloutBucket(f.feature_key, t.id)
      const inCohort = bucket < Math.max(0, pct)
      const ov = ovByTenant?.get(t.id) ?? null
      const trialActive = ov?.type === "grant_trial" && (!ov.trialEndsAt || new Date(ov.trialEndsAt) > now)
      const disabled = ov?.type === "disable"
      // Effective for THIS gate: in the cohort or explicitly pulled in — an
      // explicit disable wins (resolveEntitlement step 5). Plan/usage gates
      // still apply downstream; this board reports the rollout dimension.
      const effective = !disabled && (inCohort || trialActive)
      return {
        id: t.id, name: t.name, bucket, inCohort,
        override: ov?.type ?? null, trialEndsAt: ov?.trialEndsAt ?? null,
        effective,
      }
    })
    const inCohortCount = rows.filter((r) => r.inCohort).length
    const effectiveCount = rows.filter((r) => r.effective).length
    return { flag: f, rows, inCohortCount, effectiveCount }
  })

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Rollout cohorts</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Percentage rollouts by deterministic tenant cohort (FNV-1a bucket 0–99 per feature × tenant,
            admitted below the flag&apos;s rollout %). Grant-trial overrides pull a tenant in early; the
            rollout % itself is edited on the feature-governance board.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/admin/feature-governance" className="rounded-md border px-3 py-1 text-sm">Feature governance</Link>
          <Link href="/dashboard/superadmin/plans" className="rounded-md border px-3 py-1 text-sm">Plans</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* Rollout posture counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{partial.length}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800">Rolling out (&lt;100%)</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{fullCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-800">Fully rolled out</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{offCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">Off / deprecated</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{tenants.length}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-blue-100 text-blue-800">Tenants</div>
        </div>
      </div>

      {/* Active partial rollouts — cohort definition + per-tenant drill */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Active partial rollouts ({partialBoards.length})</h2>
        {partialBoards.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No partial rollouts — every enabled feature is at 100% (fully rolled out).
          </div>
        ) : (
          <div className="space-y-3">
            {partialBoards.map(({ flag, rows, inCohortCount, effectiveCount }) => {
              const pct = flag.rollout_percentage ?? 100
              const effectivePct = tenants.length > 0 ? Math.round((effectiveCount / tenants.length) * 100) : 0
              return (
                <details key={flag.id} className="rounded-lg border">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-3 p-3 list-none [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium">{flag.display_name ?? flag.feature_key}</span>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{flag.feature_key}</span>
                      {flag.category && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{flag.category}</span>}
                      {flag.superadmin_only && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">superadmin-only</span>}
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">{pct}% configured</span>
                      <span className="text-muted-foreground">
                        cohort: <span className="font-semibold tabular-nums text-foreground">{inCohortCount}</span> in ·{" "}
                        <span className="font-semibold tabular-nums text-foreground">{tenants.length - inCohortCount}</span> out
                      </span>
                      <span className="text-muted-foreground">
                        effective: <span className="font-semibold tabular-nums text-foreground">{effectiveCount}/{tenants.length}</span> ({effectivePct}%)
                      </span>
                      <span className="text-indigo-600 font-medium">Drill ↓</span>
                    </div>
                  </summary>
                  <div className="border-t p-3">
                    {tenants.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No tenants yet — the cohort is empty.</p>
                    ) : (
                      <CohortDrill featureKey={flag.feature_key} tenants={rows} />
                    )}
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </section>

      {/* Every flag — rollout column across the whole catalog */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">All feature flags ({flags.length})</h2>
        {flags.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">No feature flags defined yet.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Feature</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Rollout %</th>
                  <th className="p-2 text-right">Overrides</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((f) => {
                  const pct = f.rollout_percentage ?? 100
                  const off = !f.enabled || f.deprecated
                  const sunset = f.sunset_date && new Date(f.sunset_date) <= now
                  const ovCount = overrides.get(f.feature_key)?.size ?? 0
                  return (
                    <tr key={f.id} className="border-t">
                      <td className="p-2">
                        <div className="font-medium">{f.display_name ?? f.feature_key}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{f.feature_key}</div>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{f.category ?? "—"}</td>
                      <td className="p-2">
                        {sunset ? (
                          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-500">sunset</span>
                        ) : f.deprecated ? (
                          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-500">deprecated</span>
                        ) : !f.enabled ? (
                          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">disabled</span>
                        ) : pct < 100 ? (
                          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800">rolling out</span>
                        ) : (
                          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-800">live</span>
                        )}
                      </td>
                      <td className={"p-2 text-right tabular-nums " + (off ? "text-muted-foreground" : pct < 100 ? "font-semibold text-amber-700" : "")}>{pct}%</td>
                      <td className="p-2 text-right tabular-nums text-xs text-muted-foreground">{ovCount > 0 ? ovCount : "—"}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
