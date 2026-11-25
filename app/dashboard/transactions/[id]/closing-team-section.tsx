"use client"

/**
 * THE CLOSING TEAM CARD (wave 156, lane 156D) — ONE deal-team view of who closes this deal.
 *
 * Owner (2026-11-25): "in many states, it is a closing attorney not title." The card shows who conducts the closing (a closing
 * attorney, a title company, an escrow company or another authorized entity) as RECORDED from the contract or the party — never
 * picked for the user; each lawyer and whom they represent (unknown until recorded — never "everyone"); the state's sourced rule with
 * its source; the closing checklist that applies to this deal (party names, counsel contacts, title / escrow numbers, appointment,
 * settlement date, insurance, payoff, HOA / estoppel, recording); and which ACTUAL party owns each closing document. A party that is
 * not on the platform is never given an account: the deal's agent confirms its facts directly and records the evidence here.
 *
 * Every control reports the server's verdict (no optimistic success). The doors are app/actions/transactions.ts (closing team),
 * which hand over to the deal-desk writers. The vocabularies arrive WITH the data (one spelling, CLAUDE.md §6).
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Gavel, ShieldAlert, CheckCircle2, Circle, HelpCircle } from "lucide-react"
import {
  getClosingTeamAction,
  recordClosingPartyAction,
  confirmClosingPartyFactAction,
  setSettlementAgentAction,
  updateClosingChecksAction,
  assignClosingResponsibilityAction,
} from "@/app/actions/transactions"

type Team = Extract<Awaited<ReturnType<typeof getClosingTeamAction>>, { success: true }>

const REP_LABEL: Record<string, string> = { buyer: "the buyer", seller: "the seller", lender: "the lender", neutral_settlement_agent: "neutral (settlement agent)", unknown: "not recorded — ask" }
const words = (s: string) => s.replace(/_/g, " ")

export function ClosingTeamSection({ transactionId }: { transactionId: string }) {
  const [team, setTeam] = useState<Team | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [draft, setDraft] = useState({ party_role: "", represents: "", name: "", company: "", email: "", phone: "", license_number: "" })
  const [agent, setAgent] = useState({ participantId: "", kind: "", basis: "" })
  const [evidence, setEvidence] = useState<Record<string, string>>({})

  const load = () => start(async () => {
    const r = await getClosingTeamAction(transactionId)
    if (r.success) { setTeam(r as Team); setError(null) } else setError(r.error ?? "The closing team could not be read.")
  })
  useEffect(load, [transactionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = (fn: () => Promise<{ success: boolean; error?: string }>, ok: string) => start(async () => {
    const r = await fn()
    if (r.success) { setNotice(ok); setError(null); const again = await getClosingTeamAction(transactionId); if (again.success) setTeam(again as Team) }
    else { setError(r.error ?? "Not saved."); setNotice(null) }
  })

  if (!team) {
    return (
      <Card className="mt-6"><CardHeader><CardTitle className="text-base flex items-center gap-2"><Gavel className="h-4 w-4" />Closing team</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p></CardContent></Card>
    )
  }
  const a = team.assessment
  const parties = team.participants.filter((p) => a.parties.some((x) => x.id === p.id))

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Gavel className="h-4 w-4" />Closing team</CardTitle>
        <CardDescription>
          Who conducts this closing and whom each lawyer represents, as the contract names them or the party confirms — the OS does not choose them.
          {a.financing !== "unknown" && <> This is a <strong>{a.financing}</strong> deal.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {team.schemaPending && <p className="rounded bg-amber-50 p-2 text-amber-900">The closing-party fields are not on this database yet — you can read the team, but changes cannot be saved until the update is applied.</p>}
        {error && <p className="rounded bg-red-50 p-2 text-red-800">{error}</p>}
        {notice && <p className="rounded bg-emerald-50 p-2 text-emerald-900">{notice}</p>}

        <section>
          <h4 className="font-medium">The state's rule</h4>
          <p className="text-muted-foreground">{a.stateNote.note}</p>
          {a.state.policy?.sources.map((s) => (
            <p key={s.url} className="text-xs"><a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.title}</a> — research aid, not legal advice; confirm with the brokerage's counsel.</p>
          ))}
        </section>

        <section>
          <h4 className="font-medium">Settlement agent</h4>
          {a.settlementAgent.kind
            ? <p>{a.settlementAgent.name ?? "Recorded party"} — {words(a.settlementAgent.kind)}{a.settlementAgent.basis ? ` (${words(a.settlementAgent.basis)})` : ""}</p>
            : <p className="text-muted-foreground">Not recorded yet.</p>}
          {parties.length > 0 && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <select aria-label="Party" className="h-9 rounded border px-2" value={agent.participantId} onChange={(e) => setAgent({ ...agent, participantId: e.target.value })}>
                <option value="">Party…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select aria-label="Kind" className="h-9 rounded border px-2" value={agent.kind} onChange={(e) => setAgent({ ...agent, kind: e.target.value })}>
                <option value="">Kind…</option>{team.vocab.settlementKinds.map((k) => <option key={k} value={k}>{words(k)}</option>)}
              </select>
              <select aria-label="Basis" className="h-9 rounded border px-2" value={agent.basis} onChange={(e) => setAgent({ ...agent, basis: e.target.value })}>
                <option value="">Where from…</option>{team.vocab.bases.map((k) => <option key={k} value={k}>{words(k)}</option>)}
              </select>
              <Button size="sm" disabled={pending || !agent.participantId || !agent.kind || !agent.basis} onClick={() => act(() => setSettlementAgentAction(transactionId, agent), "Settlement agent recorded.")}>Record</Button>
            </div>
          )}
        </section>

        <section>
          <h4 className="font-medium">Parties</h4>
          {a.parties.length === 0 && <p className="text-muted-foreground">No closing party recorded yet.</p>}
          <ul className="space-y-2">
            {a.parties.map((p) => (
              <li key={p.id} className="rounded border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  {p.partyRole && <Badge variant="secondary">{team.vocab.partyRoles.find((r) => r.value === p.partyRole)?.label ?? words(p.partyRole)}</Badge>}
                  <span className="text-muted-foreground">represents {REP_LABEL[p.represents] ?? words(p.represents)}</span>
                  <Badge variant="outline">{p.onPlatform ? "on the platform" : "not on the platform"}</Badge>
                  <Badge variant="outline">{p.factsConfirmed ? "confirmed" : "not confirmed"}</Badge>
                </div>
                {(() => { const row = team.participants.find((x) => x.id === p.id); return row?.fact_evidence ? <p className="mt-1 text-xs text-muted-foreground">Confirmed{row.fact_confirmed_at ? ` ${String(row.fact_confirmed_at).slice(0, 10)}` : ""}: {row.fact_evidence}</p> : null })()}
                {!p.factsConfirmed && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Input className="h-8 max-w-md" placeholder="How they confirmed (e.g. email from the attorney, 11/20)" value={evidence[p.id] ?? ""} onChange={(e) => setEvidence({ ...evidence, [p.id]: e.target.value })} />
                    <Button size="sm" variant="outline" disabled={pending || (evidence[p.id] ?? "").trim().length < 5} onClick={() => act(() => confirmClosingPartyFactAction(p.id, { evidence: evidence[p.id] ?? "" }), "Confirmation recorded.")}>Record confirmation</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div><Label>Closing role</Label>
              <select className="h-9 w-full rounded border px-2" value={draft.party_role} onChange={(e) => setDraft({ ...draft, party_role: e.target.value })}>
                <option value="">Choose…</option>{team.vocab.partyRoles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select></div>
            <div><Label>Represents</Label>
              <select className="h-9 w-full rounded border px-2" value={draft.represents} onChange={(e) => setDraft({ ...draft, represents: e.target.value })}>
                <option value="">Not known yet</option>{team.vocab.represents.map((r) => <option key={r} value={r}>{REP_LABEL[r] ?? words(r)}</option>)}
              </select></div>
            <div><Label>Legal / firm name</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <div><Label>Firm</Label><Input value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} /></div>
            <div><Label>Email</Label><Input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></div>
            <div><Label>Phone</Label><Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></div>
            <div><Label>License / bar number</Label><Input value={draft.license_number} onChange={(e) => setDraft({ ...draft, license_number: e.target.value })} /></div>
          </div>
          <Button className="mt-2" size="sm" disabled={pending || !draft.party_role || draft.name.trim().length < 2}
            onClick={() => act(() => recordClosingPartyAction({ transaction_id: transactionId, ...draft, represents: draft.represents || null }), "Party recorded. If they are not on the platform, a task asks you to confirm their details with them.")}>Add party</Button>
          <p className="mt-1 text-xs text-muted-foreground">A vendor already on the platform joins through the deal's vendors first; a party that is not on the platform is never given an account.</p>
        </section>

        <section>
          <h4 className="font-medium">Findings</h4>
          {a.findings.length === 0 ? <p className="text-muted-foreground">Nothing open.</p> : (
            <ul className="space-y-1">
              {a.findings.map((f) => (
                <li key={f.key} className="flex gap-2">
                  {f.severity === "needs_human" ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span>{f.message}{f.source ? <> (<a className="underline" href={f.source.url} target="_blank" rel="noreferrer">source</a>)</> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4 className="font-medium">Closing checklist</h4>
          <ul className="space-y-1">
            {team.checklist.map((c) => (
              <li key={c.key} className="flex gap-2">
                {c.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <Circle className="mt-0.5 h-4 w-4 text-muted-foreground" />}
                <span><strong>{c.label}</strong>{c.applies === "no" ? " — not applicable" : c.applies === "unknown" ? " — applies? not known yet" : ""}. {c.detail}</span>
              </li>
            ))}
          </ul>
          {!team.schemaPending && team.settlement && (
            <div className="mt-2 flex flex-wrap gap-2">
              {(["payoff_status", "hoa_estoppel_status", "recording_status"] as const).map((k) => (
                <select key={k} aria-label={words(k)} className="h-9 rounded border px-2" defaultValue=""
                  onChange={(e) => e.target.value && act(() => updateClosingChecksAction(transactionId, { [k]: e.target.value }), `${words(k)} saved.`)}>
                  <option value="">{words(k.replace("_status", ""))}…</option>{team.vocab.checkStatuses.map((s) => <option key={s} value={s}>{words(s)}</option>)}
                </select>
              ))}
            </div>
          )}
        </section>

        <section>
          <h4 className="font-medium">Who owns each closing document</h4>
          <p className="text-xs text-muted-foreground">The Closing Disclosure and the settlement statement are the lender's and the settlement agent's documents. AI may compare them and propose a correction request; it never issues or fills one.</p>
          <ul className="mt-1 space-y-1">
            {team.documents.map((d, i) => (
              <li key={d.id ?? `${d.docType}-${i}`}>
                <strong>{d.label}</strong> <span className="text-muted-foreground">({words(d.status)})</span> — {d.owner.applies
                  ? (d.owner.participantName ? `${d.owner.participantName}${d.owner.offPlatform ? " (not on the platform)" : ""}` : "unassigned: the deal's agent or coordinator obtains it from the verified party")
                  : d.owner.reason}
                {d.id && !team.schemaPending && parties.length > 0 && (
                  <select aria-label={`Responsible party for ${d.label}`} className="ml-2 h-7 rounded border px-1 text-xs" value={d.responsibleParticipantId ?? ""}
                    onChange={(e) => act(() => assignClosingResponsibilityAction(transactionId, { target: "document", id: d.id as string, participantId: e.target.value || null }), "Responsible party saved.")}>
                    <option value="">Responsible party…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
              </li>
            ))}
          </ul>
        </section>
      </CardContent>
    </Card>
  )
}
