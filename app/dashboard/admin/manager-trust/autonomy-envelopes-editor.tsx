/**
 * AUTONOMY ENVELOPES — the tenant-admin envelope screen (wave 137; owner "approve all": "an envelope admin
 * screen is approved"). Server component on the Manager Trust governance page. The read is
 * app/actions/admin/improvement-proposals.ts getAutonomyEnvelopeEditor (tenant-admin roster, session tenant):
 * the `autonomy_budgets` policy key's current values vs the all-zero default, plus this period's caps and
 * consumption from autonomy_budget_consumptions (the Finance report's own read). The form submits
 * submitAutonomyEnvelopesAction — a `policy` proposal on the ONE versioned path; money envelopes need a
 * commerce-admin seat (TENANT_COMMERCE_ADMIN_USER_TYPES). Nothing here writes the setting directly.
 */
import { getAutonomyEnvelopeEditor } from "@/app/actions/admin/improvement-proposals"
import { AutonomyEnvelopesForm } from "./autonomy-envelopes-form"

export async function AutonomyEnvelopesEditor() {
  const res = await getAutonomyEnvelopeEditor()
  if (!res.ok) {
    return (
      <section id="autonomy-envelopes" className="mx-6 mb-8 rounded-lg border border-red-200 p-4 text-sm text-red-700">
        Autonomy envelopes could not be loaded: {res.error}
      </section>
    )
  }
  const d = res.data
  return (
    <section id="autonomy-envelopes" className="mx-6 mb-8 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Autonomy envelopes</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        How much each manager may spend without asking — per month, per decision or per campaign. Zero means
        recommendation only: every spend waits for a person.
        {d.source === "policy" ? ` Brokerage policy v${d.version}${d.changedAt ? ` (changed ${new Date(d.changedAt).toLocaleString()})` : ""}.` : " Running on the default (all zero)."}
        {!d.mayEditMoney && " Your seat can change the render cap and the Finance alarms; money envelopes need a broker, owner, admin or team lead."}
      </p>
      {d.openProposal && (
        <p className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          An open proposal ({d.openProposal.status}, {new Date(d.openProposal.createdAt).toLocaleString()}) is waiting in Improvement proposals below.
        </p>
      )}
      <div className="mb-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3">Envelope ({d.period})</th>
              <th className="py-2 pr-3">Manager</th>
              <th className="py-2 pr-3">Used</th>
              <th className="py-2 pr-3">Today</th>
              <th className="py-2">Refused today</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.envelope} className="border-b">
                <td className="py-2 pr-3 font-mono text-xs">{l.envelope}</td>
                <td className="py-2 pr-3 text-xs">{l.manager}</td>
                <td className="py-2 pr-3 text-xs">
                  {l.unit === "usd" ? `$${l.consumedPeriod.toLocaleString()}` : `${l.consumedPeriod} ${l.unit}`}
                  {l.cap !== null ? ` of ${l.unit === "usd" ? `$${l.cap.toLocaleString()}` : l.cap}` : ""}
                  {l.utilisation !== null ? ` (${Math.round(l.utilisation * 100)}%)` : ""}
                </td>
                <td className="py-2 pr-3 text-xs">{l.consumedToday}</td>
                <td className="py-2 text-xs">{l.refusalsToday}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.anomalies.length > 0 && (
        <ul className="mb-3 list-disc pl-5 text-xs text-amber-800">{d.anomalies.map((a) => <li key={a}>{a}</li>)}</ul>
      )}
      <AutonomyEnvelopesForm fields={d.fields} mayEditMoney={d.mayEditMoney} />
      <p className="mt-2 text-xs text-muted-foreground">Blind spots: {d.blindSpots.join("; ")}.</p>
    </section>
  )
}
