/**
 * IMPROVEMENT PROPOSALS — controlled learning on the existing manager-trust governance page
 * (wave 104, lane 104C; m709). Server component: the derived read is
 * app/actions/admin/improvement-proposals.ts listProposals (tenant admin, session tenant). Each
 * proposal shows what the OS wants to change, the evidence it rests on, the deterministic
 * evaluation and who decided; the approve / reject / promote / roll back buttons are the human
 * authority the kernel requires for owner-level and inconclusive changes. No value is edited here —
 * a promotion writes through the subject's own survivor writer and appends a policy version.
 */
import { revalidatePath } from "next/cache"
import { decideProposalAction, listProposals, promoteProposalAction, rollbackProposalAction } from "@/app/actions/admin/improvement-proposals"
import type { ImprovementProposalRow } from "@/lib/kernel/improvement-proposals"

function preview(v: unknown, max = 160): string {
  if (v === null || v === undefined) return "—"
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s.length > max ? `${s.slice(0, max - 3)}…` : s
}

function StatusBadge({ status }: { status: ImprovementProposalRow["status"] }) {
  const tone: Record<ImprovementProposalRow["status"], string> = {
    PROPOSED: "bg-slate-100 text-slate-700", EVALUATED: "bg-amber-100 text-amber-800", APPROVED: "bg-blue-100 text-blue-800",
    REJECTED: "bg-red-100 text-red-800", PROMOTED: "bg-emerald-100 text-emerald-800", ROLLED_BACK: "bg-zinc-200 text-zinc-800",
  }
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone[status] ?? ""}`}>{status}</span>
}

function ActionButton({ label, action }: { label: string; action: () => Promise<unknown> }) {
  return (
    <form action={async () => { "use server"; await action(); revalidatePath("/dashboard/admin/manager-trust") }}>
      <button type="submit" className="rounded border px-2 py-1 text-xs">{label}</button>
    </form>
  )
}

export async function ImprovementProposalsPanel() {
  const res = await listProposals()
  if (!res.ok) {
    return (
      <section id="improvement-proposals" className="mx-6 mb-8 rounded-lg border border-red-200 p-4 text-sm text-red-700">
        Improvement proposals could not be loaded: {res.error}
      </section>
    )
  }
  return (
    <section id="improvement-proposals" className="mx-6 mb-8 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Improvement proposals</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        What the OS proposes to change about itself — copy winners, predictor thresholds, prompt calibrations, policy
        values — each scored by replay or experiment results, never by a model. A manager promotes only what its
        autonomy gate and authority rung allow; owner-level and inconclusive proposals wait here for you. Every
        promotion writes a policy version and a ledger row; roll back restores the previous value as a new version.
        {!res.available && " The proposal store is not available yet (pending migration m709)."}
      </p>
      {res.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No proposals yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3">Subject</th>
                <th className="py-2 pr-3">Proposed change</th>
                <th className="py-2 pr-3">Evaluation</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {res.rows.map((p) => (
                <tr key={p.id} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{p.subject_kind}</div>
                    <div className="font-mono text-xs text-muted-foreground break-all">{p.subject_key}</div>
                    <div className="text-xs text-muted-foreground">by {p.proposer} · {new Date(p.created_at).toLocaleString()} · needs level {p.authority_required}</div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs break-all">
                    {preview(p.proposed_change)}
                    <div className="mt-1 text-muted-foreground">evidence: {preview(p.evidence_refs, 120)}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {p.evaluation ? (
                      <>
                        <div><strong>{p.evaluation.verdict}</strong> · {p.evaluation.evaluator}{p.evaluation.score !== null && p.evaluation.score !== undefined ? ` · ${(p.evaluation.score * 100).toFixed(0)}%` : ""}</div>
                        <div className="text-muted-foreground">{p.evaluation.why}</div>
                      </>
                    ) : <span className="text-muted-foreground">not evaluated yet</span>}
                    {p.decision_reason && <div className="mt-1">decision: {p.decision_reason}</div>}
                    {p.policy_version_ref && <div className="font-mono">promoted → {p.policy_version_ref}</div>}
                    {p.rollback_policy_version_ref && <div className="font-mono">rolled back → {p.rollback_policy_version_ref}</div>}
                  </td>
                  <td className="py-2 pr-3"><StatusBadge status={p.status} /></td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {p.status === "EVALUATED" && <ActionButton label="Approve" action={() => decideProposalAction(p.id, "approve")} />}
                      {(p.status === "PROPOSED" || p.status === "EVALUATED" || p.status === "APPROVED") && <ActionButton label="Reject" action={() => decideProposalAction(p.id, "reject")} />}
                      {p.status === "APPROVED" && <ActionButton label="Promote" action={() => promoteProposalAction(p.id)} />}
                      {p.status === "PROMOTED" && <ActionButton label="Roll back" action={() => rollbackProposalAction(p.id)} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
