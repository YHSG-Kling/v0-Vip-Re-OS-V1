/**
 * WORKFORCE THRESHOLDS — the DEDICATED editor (wave 107G; owner: "create dedicated editor") on the
 * Manager Trust governance page, beside the operating constitution that lists the key. Server
 * component: the read is app/actions/admin/improvement-proposals.ts getWorkforceThresholdsEditor
 * (tenant admin, session tenant); the form submits submitWorkforceThresholdsAction — a `policy`
 * proposal on the ONE policy path (improvement_proposals → promoteProposal → mergeBrokerageSettings →
 * appendTenantPolicyVersion). Nothing on this surface writes the setting directly.
 */
import { getWorkforceThresholdsEditor } from "@/app/actions/admin/improvement-proposals"
import { WorkforceThresholdsForm } from "./workforce-thresholds-form"

export async function WorkforceThresholdsEditor() {
  const res = await getWorkforceThresholdsEditor()
  if (!res.ok) {
    return (
      <section id="workforce-thresholds" className="mx-6 mb-8 rounded-lg border border-red-200 p-4 text-sm text-red-700">
        Workforce thresholds could not be loaded: {res.error}
      </section>
    )
  }
  const d = res.data
  return (
    <section id="workforce-thresholds" className="mx-6 mb-8 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Workforce thresholds</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        What makes an agent a strong listing / buyer / investor agent, bilingual, a luxury specialist, overwhelmed,
        underutilized or in development — and when a territory&apos;s rising seller demand becomes a recruiting need.
        {d.source === "policy" ? ` Brokerage policy v${d.version}${d.changedAt ? ` (changed ${new Date(d.changedAt).toLocaleString()})` : ""}.` : " Running on the platform defaults."}
        {" "}A change is a policy proposal: propose it for review, or apply it now (approved and promoted in one step, versioned and ledgered).
        {!d.proposalsAvailable && " The proposal store is not available yet — nothing can be proposed."}
      </p>
      {d.openProposal && (
        <p className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          An open proposal ({d.openProposal.status}, {new Date(d.openProposal.createdAt).toLocaleString()}) is waiting in Improvement proposals below:
          <span className="ml-1 font-mono break-all">{JSON.stringify(d.openProposal.value)}</span>
        </p>
      )}
      <WorkforceThresholdsForm current={d.current} defaults={d.defaults} fields={d.fields} bands={d.bands} />
    </section>
  )
}
