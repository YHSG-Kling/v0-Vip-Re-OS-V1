"use client"

// THE AGREEMENT DICTATES THE MONEY (wave 145, lane 145C; owner rulings 3, 4 and 6).
// Per agent: the executed agreements and the date each takes effect, the START DATE (from the executed brokerage agreement —
// never account creation), and the commission setup the executed agreement supports: the system PROPOSES the terms from the
// signed form's fields — and, on request, from the doc kernel's AI reading of a stored scan of the executed paper (lower rank:
// the signed form wins a disagreement) — a finance admin VERIFIES them, and only then does the profile name the agreement.
// Rules and writers: lib/agreements/agent-agreements.ts, lib/commission/agreement-onboarding.ts. Nothing here computes money.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  recordAgreementEffectiveDateAction,
  recordAgentAgreementAmendmentAction,
  setAgentStartDateAction,
  proposeAgreementTermsAction,
  verifyAgreementTermsAction,
  type AgentAgreementGovernanceView,
  type AgreementScanView,
} from "@/app/actions/commission-policy/agreements"

const STATE_LABEL: Record<string, string> = {
  from_executed_agreement: "verified against the executed agreement",
  awaiting_verification: "recorded — not yet verified",
  unanswered: "not answered",
  brokerage_setting: "brokerage setting",
  explained: "how the engine works",
  client_agreements: "per client agreement",
}

type Proposal = NonNullable<AgentAgreementGovernanceView["proposal"]>
const termsOf = (p: Proposal | null): Record<string, string> =>
  Object.fromEntries(Object.entries(p?.terms ?? {}).map(([k, t]) => [k, Array.isArray(t?.value) ? (t!.value as string[]).join(", ") : String(t?.value ?? "")]))

function AgentGovernance({ a, scans }: { a: AgentAgreementGovernanceView; scans: AgreementScanView[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [dates, setDates] = useState<Record<string, string>>({})
  // the proposal on screen: the signed form's fields (server-computed), replaced by the AI-read one when a stored scan is read
  const [proposal, setProposal] = useState<Proposal | null>(a.proposal)
  const [scanId, setScanId] = useState<string>("")
  const [readScan, setReadScan] = useState<string | null>(null)
  const [terms, setTerms] = useState<Record<string, string>>(() => termsOf(a.proposal))
  const [amend, setAmend] = useState({ base: "", executedOn: "", effectiveDate: "", documentUrl: "" })
  const run = (f: () => Promise<{ success: boolean; error?: string }>) =>
    startTransition(async () => { const r = await f(); if (!r.success) { setError(r.error ?? "refused"); return } setError(null); router.refresh() })

  const readStoredScan = () => startTransition(async () => {
    if (!a.termsAgreementInForce || !scanId) return
    const r = await proposeAgreementTermsAction({ contractSignatureId: a.termsAgreementInForce, documentId: scanId })
    if (!r.success) { setError(r.error); return }
    setError(null)
    setProposal(r.proposal)
    setReadScan(scanId)
    // the human's edits stay; terms the scan newly proposes are added for them to confirm or clear
    setTerms((cur) => ({ ...termsOf(r.proposal), ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== "")) }))
  })

  const executed = a.agreements.filter((g) => g.esignStatus === "fully_signed")
  const verified = !!a.termsAgreementInForce && a.termsVerifiedAgainst === a.termsAgreementInForce
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{a.name}</CardTitle>
        <CardDescription>
          Start date: {a.startDate ? <strong>{a.startDate}</strong> : <span>not recorded</span>}
          {a.startDate ? " (from the executed agreement)" : a.seatAnniversaryDate ? ` — the seat was provisioned ${a.seatAnniversaryDate}, which is not a start date` : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {error ? <p className="text-destructive">{error}</p> : null}

        <div className="space-y-2">
          <p className="font-medium">Executed agreements</p>
          {executed.length === 0 ? <p className="text-muted-foreground">No fully signed agreement on file.</p> : null}
          {executed.map((g) => (
            <div key={g.id} className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center">
              <span className="flex-1">
                {g.contractType.replace(/_/g, " ")}{g.amends ? " (amendment)" : ""} · signed {(g.fullySignedAt ?? "").slice(0, 10)} · effective {g.effectiveDate ?? "not recorded"}{g.effectiveDateRecordedAt ? ` (recorded ${g.effectiveDateRecordedAt.slice(0, 10)})` : ""}
                {g.documentUrl ? <> · <a className="underline" href={g.documentUrl} target="_blank" rel="noreferrer">view</a></> : null}
              </span>
              {/* another eligible brokerage agreement than the proposed one — the human may choose it (the writer re-checks C6) */}
              {!g.amends && g.startDateIfSource && a.startDateSource !== g.id && a.startDateProposal.proposal?.contractSignatureId !== g.id ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setAgentStartDateAction({ agentId: a.agentId, contractSignatureId: g.id }))}>
                  Use as start date ({g.startDateIfSource})
                </Button>
              ) : null}
              {!g.effectiveDate ? (
                <span className="flex gap-2">
                  <input type="date" className="rounded-md border px-2 py-1" value={dates[g.id] ?? ""} onChange={(e) => setDates((d) => ({ ...d, [g.id]: e.target.value }))} aria-label="Effective date the agreement states" />
                  <Button size="sm" disabled={pending || !dates[g.id]} onClick={() => run(() => recordAgreementEffectiveDateAction({ contractSignatureId: g.id, effectiveDate: dates[g.id] }))}>Record effective date</Button>
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <p className="font-medium">Start date</p>
          {a.startDateProposal.proposal ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="flex-1">Proposed: {a.startDateProposal.proposal.startDate} — {a.startDateProposal.reason}</span>
              <Button size="sm" disabled={pending || a.startDateSource === a.startDateProposal.proposal.contractSignatureId} onClick={() => run(() => setAgentStartDateAction({ agentId: a.agentId, contractSignatureId: a.startDateProposal.proposal!.contractSignatureId }))}>
                {a.startDateSource === a.startDateProposal.proposal.contractSignatureId ? "Recorded" : "Confirm start date"}
              </Button>
            </div>
          ) : <p className="text-muted-foreground">{a.startDateProposal.reason}</p>}
        </div>

        <div className="space-y-2">
          <p className="font-medium">Commission terms {verified ? <Badge>verified against the executed agreement</Badge> : <Badge variant="secondary">not verified</Badge>}</p>
          {a.termsAgreementInForce && proposal ? (
            <>
              <p className="text-xs text-muted-foreground">
                Proposed from the signed agreement&apos;s own fields{readScan ? " and the AI reading of the stored scan" : ""} (effective {proposal.effectiveDate ?? "— record the effective date first"}). Change any value to what the executed paper says; leave the agreement&apos;s silences empty.
              </p>
              {scans.length > 0 ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <select className="flex-1 rounded-md border px-2 py-1" value={scanId} onChange={(e) => setScanId(e.target.value)} aria-label="Stored scan of the executed agreement">
                    <option value="">Read a stored scan of the executed agreement…</option>
                    {scans.map((d) => <option key={d.id} value={d.id}>{(d.scannedAt ?? "").slice(0, 10)} · {(d.summary ?? "agreement scan").slice(0, 80)}{d.confidence ? ` (${d.confidence})` : ""}</option>)}
                  </select>
                  <Button size="sm" variant="outline" disabled={pending || !scanId} onClick={readStoredScan}>Propose from the scan</Button>
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {Object.keys(terms).map((k) => (
                  <label key={k} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{k.replace(/_/g, " ")} ({proposal.terms[k as keyof typeof proposal.terms]?.source === "ai_extraction" ? "read from the scan — confirm" : proposal.terms[k as keyof typeof proposal.terms] ? "signed form" : "your entry"})</span>
                    <input className="rounded-md border px-2 py-1" value={terms[k]} onChange={(e) => setTerms((t) => ({ ...t, [k]: e.target.value }))} />
                  </label>
                ))}
              </div>
              {proposal.findings.map((f, i) => <p key={i} className="text-xs text-destructive">{f}</p>)}
              <Button size="sm" disabled={pending || !proposal.effectiveDate || Object.keys(terms).length === 0}
                onClick={() => run(() => verifyAgreementTermsAction({ contractSignatureId: a.termsAgreementInForce!, documentId: readScan, terms: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, k === "cap_eligible_contributions" ? v.split(",").map((x) => x.trim()).filter(Boolean) : v])) }))}>
                Verify these terms against the executed agreement
              </Button>
            </>
          ) : <p className="text-muted-foreground">No executed commission agreement to verify terms against.</p>}
        </div>

        <div className="space-y-1">
          <p className="font-medium">Commission setup questions</p>
          <ul className="space-y-1">
            {a.setup.map((q) => (
              <li key={q.key} className="flex flex-col sm:flex-row sm:gap-2">
                <span className="flex-1">{q.question}</span>
                <span className="text-xs text-muted-foreground">{STATE_LABEL[q.state] ?? q.state}</span>
              </li>
            ))}
          </ul>
        </div>

        {executed.length > 0 ? (
          <div className="space-y-2 border-t pt-3">
            <p className="font-medium">Record an executed amendment</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select className="rounded-md border px-2 py-1" value={amend.base} onChange={(e) => setAmend((m) => ({ ...m, base: e.target.value }))} aria-label="Agreement it amends">
                <option value="">Agreement it amends…</option>
                {executed.map((g) => <option key={g.id} value={g.id}>{g.contractType.replace(/_/g, " ")} · {(g.fullySignedAt ?? "").slice(0, 10)}</option>)}
              </select>
              <input className="rounded-md border px-2 py-1" placeholder="Executed document URL" value={amend.documentUrl} onChange={(e) => setAmend((m) => ({ ...m, documentUrl: e.target.value }))} />
              <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Fully signed on</span><input type="date" className="rounded-md border px-2 py-1" value={amend.executedOn} onChange={(e) => setAmend((m) => ({ ...m, executedOn: e.target.value }))} /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Takes effect on</span><input type="date" className="rounded-md border px-2 py-1" value={amend.effectiveDate} onChange={(e) => setAmend((m) => ({ ...m, effectiveDate: e.target.value }))} /></label>
            </div>
            <Button size="sm" disabled={pending || !amend.base || !amend.executedOn || !amend.effectiveDate || !amend.documentUrl}
              onClick={() => run(() => recordAgentAgreementAmendmentAction({ amendsContractSignatureId: amend.base, executedOn: amend.executedOn, effectiveDate: amend.effectiveDate, documentUrl: amend.documentUrl }))}>
              Record amendment
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function AgreementGovernancePanel({ agents, scans }: { agents: AgentAgreementGovernanceView[]; scans: AgreementScanView[] }) {
  // An empty roster SAYS so (lane 145Z — test:rendered-empty-states: this panel returned null on [], the 34th self-hiding
  // widget against a ratchet of 33). No agent agreement is not "nothing to show"; it is the fact the broker needs to read.
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Executed agreements, start dates and verified terms</h2>
        <p className="text-sm text-muted-foreground">The executed agreement dictates the money: its effective date, the agent&apos;s start date and the commission terms — proposed from the signed paper, verified by you.</p>
      </div>
      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agent agreements to govern yet — once an agent&apos;s agreement is executed, its start date and terms appear here for you to verify.</p>
      ) : (
        agents.map((a) => <AgentGovernance key={a.agentId} a={a} scans={scans} />)
      )}
    </div>
  )
}
