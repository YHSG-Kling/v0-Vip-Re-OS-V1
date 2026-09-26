/**
 * PLATFORM CONTINUITY BOARD (superadmin, 'sentinel' capability) — the owner's
 * oversight seat: "we overlook every subscriber with the ability to expand
 * features but can oversee every feature so the OS is smoothly run." One
 * fleet-wide read of the self-healing OS: per-tenant heal/escalation activity,
 * the quarantine queue waiting on contract fixes, connector shape changes
 * (drift ahead of damage), and each auto-repair's earned/supervised standing.
 * Read-only by design — repairs run themselves; this seat watches the watchers.
 */

import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { loadFlowActionStats, composeRepairAutonomy, EARNED_AUTONOMY_HEALS } from "@/lib/kernel/self-heal-ledger"
import { loadRecentShapeChanges } from "@/lib/kernel/schema-memory"
import { loadSentinelLosses } from "@/lib/kernel/write-sentinel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

export default async function PlatformContinuityPage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok) {
    return <div className="p-8 text-sm text-muted-foreground">Forbidden — this page requires the platform sentinel capability.</div>
  }

  const svc = createServiceClient()
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()

  const [{ data: ledger }, { data: quarantine }, stats, shapeChanges, sentinelLosses, { data: reconciled }] = await Promise.all([
    svc.from("self_heal_events")
      .select("brokerage_id, domain, outcome")
      .gte("created_at", since).limit(5000),
    // ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF (no duplicate existed).
    // `last_attempt_at` was written by every branch of runIngressReconciliation
    // (lib/kernel/ingress-continuity.ts:375-402) and read by NOBODY, so this
    // board showed an attempt COUNT with no way to tell a letter the worker
    // retried four minutes ago from one it has not touched since the cron
    // stopped running — the difference between "healing" and "abandoned by the
    // healer", which is the whole question this card exists to answer.
    svc.from("ingress_dead_letters")
      .select("provider, event_kind, external_ref, attempts, created_at, status, last_attempt_at")
      .eq("status", "pending").order("created_at", { ascending: true }).limit(50),
    loadFlowActionStats(svc),
    loadRecentShapeChanges(svc as any, since),
    loadSentinelLosses(svc, since),
    // §1.2 — `reconciled_at` (ingress-continuity.ts:375) had no reader either:
    // the board counted what is still STUCK and never what the worker actually
    // healed, so a reconciliation rail that fixed forty letters this week and
    // one that has been dead since Tuesday rendered identically.
    svc.from("ingress_dead_letters")
      .select("provider, reconciled_at")
      .eq("status", "reconciled").gte("reconciled_at", since).limit(1000),
  ])

  // Fold the week's ledger per tenant (platform-scoped rows fold under "platform").
  const byTenant = new Map<string, { healed: number; escalated: number; failed: number }>()
  for (const r of ((ledger ?? []) as any[])) {
    const key = r.brokerage_id ?? "platform"
    const t = byTenant.get(key) ?? { healed: 0, escalated: 0, failed: 0 }
    if (r.outcome === "healed") t.healed++
    else if (r.outcome === "escalated") t.escalated++
    else if (r.outcome === "failed") t.failed++
    byTenant.set(key, t)
  }
  const tenantIds = [...byTenant.keys()].filter((k) => k !== "platform")
  const { data: names } = tenantIds.length
    ? await svc.from("brokerages").select("id, name").in("id", tenantIds)
    : { data: [] as any[] }
  const nameById = new Map(((names ?? []) as any[]).map((b) => [b.id, b.name]))
  const tenantRows = [...byTenant.entries()]
    .map(([id, t]) => ({ id, name: id === "platform" ? "Platform (webhooks / pipeline)" : (nameById.get(id) ?? id), ...t }))
    .sort((a, b) => (b.healed + b.escalated + b.failed) - (a.healed + a.escalated + a.failed))

  const repairs = composeRepairAutonomy(stats)
  const quarantineRows = ((quarantine ?? []) as any[])

  // §1.2 — the healed half of the same ledger.
  const reconciledRows = ((reconciled ?? []) as Array<{ provider: string | null; reconciled_at: string | null }>)
  const lastReconciledAt = reconciledRows
    .map((r) => r.reconciled_at)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null
  /** "3m" / "4h" / "6d" since an ISO stamp — or null when there is no stamp. */
  const agoLabel = (iso: string | null | undefined): string | null => {
    if (!iso) return null
    const ms = Date.now() - new Date(iso).getTime()
    if (!Number.isFinite(ms) || ms < 0) return null
    const mins = Math.floor(ms / 60_000)
    if (mins < 60) return `${mins}m`
    const hours = Math.floor(mins / 60)
    if (hours < 48) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Continuity Board</h1>
        <p className="text-sm text-muted-foreground">
          The self-healing OS across every subscriber — last 7 days. Repairs run themselves; this seat watches the watchers.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Fleet activity by subscriber</CardTitle>
          </CardHeader>
          <CardContent>
            {tenantRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">A quiet week — no repairs, no escalations.</p>
            ) : (
              <ul className="space-y-2">
                {tenantRows.slice(0, 15).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{t.name}</span>
                    <span className="flex shrink-0 gap-1.5">
                      <Badge variant="outline" className="border-emerald-300 text-emerald-700">{t.healed} healed</Badge>
                      {t.escalated > 0 && <Badge variant="outline" className="border-amber-300 text-amber-700">{t.escalated} escalated</Badge>}
                      {t.failed > 0 && <Badge variant="outline" className="border-red-300 text-red-700">{t.failed} failed</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Repair autonomy standings</CardTitle>
            <p className="text-xs text-muted-foreground">Earned = runs silently ({EARNED_AUTONOMY_HEALS} clean heals, zero failures). One veto demotes instantly.</p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              {repairs.map((r) => (
                <li key={r.flow} className="flex items-start justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">{r.describes}</span>
                  {r.tier === "escalate" ? (
                    <Badge variant="outline" className="shrink-0">human-routed</Badge>
                  ) : r.earned ? (
                    <Badge variant="outline" className="shrink-0 border-emerald-300 text-emerald-700">earned</Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 border-amber-300 text-amber-700">
                      supervised {Math.min(r.healed, EARNED_AUTONOMY_HEALS)}/{EARNED_AUTONOMY_HEALS}{r.failed > 0 ? ` · ${r.failed} failed` : ""}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Dead letters — parked, replaying every tick</CardTitle>
            <p className="text-xs text-muted-foreground">Orphans replay when their destination appears; schema_drift_quarantine rows drain the moment the contract learns the shape.</p>
          </CardHeader>
          <CardContent>
            {/* §1.2 — the reconciliation worker's OWN pulse, from reconciled_at.
                An empty quarantine and a dead worker used to look the same. */}
            <p className="mb-2 text-xs text-muted-foreground">
              {reconciledRows.length > 0
                ? `Healed this week: ${reconciledRows.length} letter${reconciledRows.length === 1 ? "" : "s"} reconciled${agoLabel(lastReconciledAt) ? ` · last ${agoLabel(lastReconciledAt)} ago` : ""}.`
                : "No letter has been reconciled in the last 7 days — either nothing needed healing, or the reconciliation worker is not running."}
            </p>
            {quarantineRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Empty — every inbound payload is readable.</p>
            ) : (
              <ul className="space-y-1.5">
                {quarantineRows.slice(0, 12).map((q) => (
                  <li key={`${q.provider}:${q.external_ref}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-muted-foreground">{q.provider} · {q.event_kind} · {q.external_ref}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {/* Never tried = the worker has not reached it at all. */}
                      <span className="text-muted-foreground">
                        {agoLabel(q.last_attempt_at) ? `tried ${agoLabel(q.last_attempt_at)} ago` : "never tried"}
                      </span>
                      <Badge variant="outline">{q.attempts ?? 0} tick{(q.attempts ?? 0) === 1 ? "" : "s"}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Silent write losses (7d)</CardTitle>
            <p className="text-xs text-muted-foreground">The write sentinel: best-effort DB writes that were REJECTED and would have vanished silently. Each names the rail + cause so you fix the write, not the symptom.</p>
          </CardHeader>
          <CardContent>
            {sentinelLosses.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">Clean — every tracked best-effort write landed this week.</p>
            ) : (
              <ul className="space-y-1.5">
                {sentinelLosses.groups.slice(0, 12).map((g) => (
                  <li key={`${g.flow}:${g.table}:${g.code}`} className="flex items-start justify-between gap-2 text-xs">
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{g.flow}</span>
                      <span className="text-muted-foreground"> → {g.table}</span>
                      <span className="block text-[11px] text-muted-foreground">{g.hint}{g.tenants > 1 ? ` · ${g.tenants} tenants` : ""}</span>
                    </span>
                    <Badge variant="outline" className="shrink-0 border-red-300 text-red-700">{g.count}× {g.code ?? "err"}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Connector shape changes (7d)</CardTitle>
            <p className="text-xs text-muted-foreground">Drift detected ahead of damage — check the contract before anything quarantines.</p>
          </CardHeader>
          <CardContent>
            {shapeChanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">No provider changed its payload shape this week.</p>
            ) : (
              <ul className="space-y-1.5">
                {shapeChanges.slice(0, 12).map((c) => (
                  <li key={`${c.connector}:${c.fingerprint}`} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{c.connector}</span> / {c.entity} — new shape {c.fingerprint} since {new Date(c.firstSeenAt).toLocaleDateString()}
                    {/* last_seen_at: a shape still arriving is a contract change; one seen
                        once is a blip. Both were stored and neither was shown. */}
                    {c.lastSeenAt && `, last seen ${new Date(c.lastSeenAt).toLocaleDateString()}`}
                    {/* shape_keys diffed against the prior shape — WHICH field moved. */}
                    {c.diffUnavailable ? (
                      <span className="block">changed fields unknown (an earlier shape recorded no key list)</span>
                    ) : (
                      <>
                        {c.removedKeys.length > 0 && (
                          <span className="block text-red-700">dropped: {c.removedKeys.slice(0, 8).join(", ")}{c.removedKeys.length > 8 ? ` +${c.removedKeys.length - 8} more` : ""}</span>
                        )}
                        {c.addedKeys.length > 0 && (
                          <span className="block text-amber-700">added: {c.addedKeys.slice(0, 8).join(", ")}{c.addedKeys.length > 8 ? ` +${c.addedKeys.length - 8} more` : ""}</span>
                        )}
                        {c.removedKeys.length === 0 && c.addedKeys.length === 0 && (
                          <span className="block">no key paths differ — a values-only change</span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
