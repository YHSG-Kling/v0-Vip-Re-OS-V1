import { createServiceClient } from "@/lib/supabase/service"
import { runSaasOperations, listPlatformSupportMissions, CAUSE_LABEL, type SaasSignalKey } from "@/lib/platform/saas-operations"
import { SupportMissionDecision } from "./support-mission-decision"

// PLATFORM SELF-OPERATION board (wave 108B) — per-tenant SaaS health signals, each with the reader
// it came from, the blind spots beside them, and the support missions the platform-sentinel cron
// opened for diagnosed anomalies. Rendered inside the gated Sentinel page
// (requirePlatformCapability("sentinel")); read-only here — the board never opens a mission.

const SIGNAL_ORDER: SaasSignalKey[] = ["usage", "churn_risk", "billing", "trial_conversion", "onboarding", "ai_spend", "provider_performance", "support", "feature_adoption", "seats"]
const TONE: Record<string, string> = { ok: "bg-emerald-50 text-emerald-800", watch: "bg-amber-50 text-amber-800", alert: "bg-red-50 text-red-800", unknown: "bg-slate-100 text-slate-600" }

export async function SaasOperationsBoard() {
  const svc = createServiceClient()
  const [report, missions] = await Promise.all([runSaasOperations(svc, new Date(), { write: false }), listPlatformSupportMissions(svc)])
  const nameOf = new Map(report.tenants.map((t) => [t.brokerageId, t.name]))
  const flagged = report.tenants.filter((t) => SIGNAL_ORDER.some((k) => t.signals[k].status === "alert" || t.signals[k].status === "watch"))

  return (
    <section className="rounded-lg border p-4 space-y-4">
      <div>
        <h2 className="text-base font-semibold">SaaS operations — the platform running itself</h2>
        <p className="text-xs text-muted-foreground">
          Per-tenant onboarding, trial conversion, usage (7 days vs the trailing 4-week baseline; −70% is an anomaly), churn risk,
          billing, AI spend vs plan, provider performance, support and feature adoption. A diagnosed anomaly becomes a support
          mission for staff to approve — the tenant is never contacted automatically.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Support missions</h3>
        {missions.refused ? (
          <p className="text-sm text-red-600">Support missions could not be read: {missions.refused}</p>
        ) : missions.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No support missions yet — the daily sweep opens one when a tenant&apos;s usage falls 70% or more below its baseline.</p>
        ) : (
          <ul className="space-y-1.5">
            {missions.rows.map((m) => {
              const dx = (m.evidence as Array<Record<string, unknown>>).filter((e) => e?.kind === "platform_diagnosis").pop()
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] font-medium text-stone-800">{m.state}</span>
                  <span className="text-xs font-medium">{nameOf.get(m.brokerage_id) ?? m.brokerage_id}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={m.objective}>{m.objective}</span>
                  {dx ? <span className="text-[11px] text-muted-foreground">{CAUSE_LABEL[dx.cause as keyof typeof CAUSE_LABEL] ?? String(dx.cause)} · {String(dx.confidence)}</span> : null}
                  {m.state === "PROPOSED" ? <SupportMissionDecision missionId={m.id} /> : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Tenants needing attention ({flagged.length} of {report.counts.tenants}; {report.counts.anomalies} usage anomal{report.counts.anomalies === 1 ? "y" : "ies"})</h3>
        {flagged.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tenant has a watch or alert signal right now.</p>
        ) : (
          <ul className="space-y-2">
            {flagged.map((t) => (
              <li key={t.brokerageId} className="space-y-1">
                <div className="text-sm font-medium">{t.name}{t.diagnosis ? <span className="ml-2 text-xs font-normal text-red-700">diagnosis: {CAUSE_LABEL[t.diagnosis.cause]} ({t.diagnosis.confidence})</span> : null}</div>
                <div className="flex flex-wrap gap-1">
                  {SIGNAL_ORDER.filter((k) => t.signals[k].status !== "ok").map((k) => (
                    <span key={k} className={`rounded px-1.5 py-0.5 text-[11px] ${TONE[t.signals[k].status]}`} title={`${t.signals[k].value} — reader: ${t.signals[k].readers.join(", ")}`}>
                      {k.replace(/_/g, " ")}: {t.signals[k].status}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-medium">Readers and blind spots</h3>
        <ul className="text-[11px] text-muted-foreground space-y-0.5">
          {report.readers.map((r) => (
            <li key={r.reader}>{r.ok ? "✓" : "✗"} {r.reader}: {r.source} — {r.ok ? `${r.rows} row(s)${r.truncated ? " (capped)" : ""}` : `refused: ${r.refused}`}</li>
          ))}
        </ul>
        {report.blindSpots.length > 0 ? (
          <ul className="text-[11px] text-amber-700 space-y-0.5">{report.blindSpots.map((b) => <li key={b}>{b}</li>)}</ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">No blind spots this read.</p>
        )}
      </div>
    </section>
  )
}
