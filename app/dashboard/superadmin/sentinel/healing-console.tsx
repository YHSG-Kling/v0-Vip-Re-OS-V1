/**
 * THE HEALING CONSOLE — platform staff (wave 139, lane 139F). Server component on the OS Sentinel page.
 * Read: app/actions/superadmin/platform-controls.ts getHealingConsoleAction (platform 'sentinel' capability) —
 * one line per incident from the healers' OWN rows (agent_action_ledger os_health / provider_self_heal /
 * law_rule_healing, self_heal_events, connector_healing_proposals, improvement_proposals). Structured
 * diagnosis + cited evidence only — there is no reasoning text to show (the model contract carries none).
 * The ceiling editor writes the platform self-healing ceiling no tenant policy can exceed (superadmin).
 * A tenant admin sees only their own incidents on the brokerage command center (BrokerSelfHealPanel).
 */
import { getHealingConsoleAction } from "@/app/actions/superadmin/platform-controls"
import { HealingCeilingsEditor } from "./healing-ceilings-editor"

const STATE_BADGE: Record<string, string> = {
  healed: "bg-emerald-100 text-emerald-800", verified: "bg-emerald-100 text-emerald-800",
  proposed: "bg-blue-100 text-blue-800", escalated: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800", in_progress: "bg-slate-100 text-slate-700",
}

export async function HealingConsole() {
  const res = await getHealingConsoleAction()
  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Healing console</h2>
        <p className="text-xs text-muted-foreground">
          Every self-healing incident across tenants: what it was, who owns it, the structured diagnosis, the cited research,
          the playbook, attempts, cost, the result and where it ended. Money, cross-tenant and security incidents never act —
          they show the diagnosis and the human they went to.
        </p>
      </div>
      {!res.ok ? (
        <p className="text-sm text-red-700">The healing console could not be read: {res.error}</p>
      ) : (
        <>
          <HealingCeilingsEditor ceiling={res.ceiling} defaults={res.defaults} applied={res.ceilingApplied} actingClasses={res.actingClasses} />
          {res.incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No healing incident in the last {res.windowDays} days.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="p-1">Tenant / subject</th><th className="p-1">Class</th><th className="p-1">Manager · domain</th>
                    <th className="p-1">Provider · capability</th><th className="p-1">Diagnosis</th><th className="p-1">Evidence</th>
                    <th className="p-1">Playbook · attempts</th><th className="p-1">Cost</th><th className="p-1">Action · verification</th>
                    <th className="p-1">Escalation / proposal</th><th className="p-1">State</th>
                  </tr>
                </thead>
                <tbody>
                  {res.incidents.map((i) => (
                    <tr key={i.key} className="border-t align-top">
                      <td className="p-1"><div className="font-mono">{i.brokerageId?.slice(0, 8) ?? "platform"}</div><div className="text-muted-foreground">{i.source} · {i.subject}</div></td>
                      <td className="p-1">{i.classification ?? "—"}</td>
                      <td className="p-1">{i.manager ?? "—"}{i.domain ? ` · ${i.domain}` : ""}</td>
                      <td className="p-1">{i.provider ?? "—"}{i.capability ? ` · ${i.capability}` : ""}</td>
                      <td className="p-1 max-w-xs">{i.diagnosis ? <><div>{i.diagnosis.summary}</div><div className="text-muted-foreground">{i.diagnosis.rootCause ?? "?"}{i.diagnosis.confidence != null ? ` · ${Math.round(i.diagnosis.confidence * 100)}%` : ""}{i.diagnosis.flags.length ? ` · flags ${i.diagnosis.flags.join(", ")}` : ""}</div></> : "—"}</td>
                      <td className="p-1">{i.evidence.length ? i.evidence.map((c) => <div key={c.url}><a className="underline" href={c.url} target="_blank" rel="noreferrer">{c.title ?? c.url}</a></div>) : "—"}</td>
                      <td className="p-1">{i.playbook ?? "—"} · {i.attempts}</td>
                      <td className="p-1 tabular-nums">${i.costUsd.toFixed(4)}</td>
                      <td className="p-1">{i.action ?? "—"}{i.verification ? <div className="text-muted-foreground">{i.verification}</div> : null}</td>
                      <td className="p-1">{i.escalation ? <>{i.escalation.reason ?? ""}{i.escalation.proposalId ? <div className="text-muted-foreground">proposal {i.escalation.proposalId.slice(0, 8)} · {i.escalation.proposalStatus ?? "?"}</div> : null}</> : "—"}</td>
                      <td className="p-1"><span className={`rounded px-1.5 py-0.5 ${STATE_BADGE[i.finalState] ?? ""}`}>{i.finalState}</span>{i.policyRef ? <div className="text-muted-foreground">{i.policyRef}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
