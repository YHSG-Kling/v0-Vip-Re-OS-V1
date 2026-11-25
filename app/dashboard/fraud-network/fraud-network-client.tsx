"use client"

// The Fraud & Trust Network screen (wave 156, lane 156J). Tenant seats: read shared TACTIC warnings, report an incident
// privately, follow their own cases, subscribe to type / place warnings. Platform safety staff: the moderation panel.
// Evidence files never leave the browser: only a SHA-256 fingerprint is computed here and sent (no storage exists yet).

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  submitFraudIncident, listMyFraudCases, getFraudCase, requestFraudEvidenceView, withdrawFraudCase, appealFraudCaseDecision,
  listFraudBulletins, openFraudBulletin, setFraudWarningSubscription, listMyFraudWarningSubscriptions, requestFraudBulletinCorrection,
  addFraudBulletinToTopicPool, getFraudNetworkMetrics, listFraudModerationQueue, addFraudCaseModerationNote, draftFraudBulletinFromCase,
  linkFraudCaseToBulletin, updateFraudBulletinDraft, publishFraudBulletin, correctFraudBulletin, takeDownFraudBulletin,
  recordFraudSubjectCorrection, resolveFraudCorrectionRequest,
} from "@/app/actions/fraud-network"

type Typ = { kind: string; label: string; evidenceChecklist: string[]; protectiveAction: string }
interface Props {
  viewer: { tenant: boolean; reviewer: boolean; staff: boolean }
  typology: Typ[]; channels: string[]; evidenceKinds: string[]; agencies: string[]; claimClasses: string[]; evidenceStorageNote: string
}
type Any = Record<string, any>
const human = (s: string | null | undefined) => String(s ?? "").replace(/_/g, " ")
const sel = "h-9 rounded-md border bg-background px-2 text-sm"

async function sha256(file: File): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function FraudNetworkClient(p: Props) {
  const [msg, setMsg] = useState<string | null>(null)
  const say = (r: Any | null | undefined, ok: string) => setMsg(r && r.ok === false ? String(r.error) : ok)
  const labelOf = (k: string) => p.typology.find((t) => t.kind === k)?.label ?? human(k)

  // ── bulletins ──
  const [filter, setFilter] = useState({ typology: "", jurisdiction: "" })
  const [bulletins, setBulletins] = useState<Any[]>([])
  const [open, setOpen] = useState<Any | null>(null)
  const [correction, setCorrection] = useState("")
  const loadBulletins = async () => { const r: Any = await listFraudBulletins({ typology: filter.typology || null, jurisdiction: filter.jurisdiction || null }); if (r.ok) setBulletins(r.bulletins); else setMsg(r.error) }
  // ── cases / subscriptions / metrics ──
  const [cases, setCases] = useState<Any[]>([])
  const [caseView, setCaseView] = useState<Any | null>(null)
  const [appeal, setAppeal] = useState("")
  const [subs, setSubs] = useState<Any[]>([])
  const [sub, setSub] = useState({ typology: "", jurisdiction: "" })
  const [metrics, setMetrics] = useState<Any | null>(null)
  const refresh = async () => {
    await loadBulletins()
    if (p.viewer.tenant) { const c: Any = await listMyFraudCases(); if (c.ok) setCases(c.cases); setSubs(await listMyFraudWarningSubscriptions()) }
    const m: Any = await getFraudNetworkMetrics(); if (m.ok) setMetrics(m.metrics)
    if (p.viewer.staff) await loadQueue()
  }
  useEffect(() => { void refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── report form ──
  const blank = { incidentKind: "", channel: "email", summary: "", eventDate: "", lossOccurred: "unknown", lossAmount: "", stepsTaken: "", agency: "", reference: "", transactionId: "", shareConsent: false }
  const [form, setForm] = useState<Any>(blank)
  const [files, setFiles] = useState<Array<{ kind: string; fingerprint: string; label: string }>>([])
  const [evKind, setEvKind] = useState(p.evidenceKinds[0] ?? "screenshot")
  const addFiles = async (list: FileList | null) => {
    const out = [...files]
    for (const f of Array.from(list ?? [])) out.push({ kind: evKind, fingerprint: await sha256(f), label: f.name.slice(0, 200) })
    setFiles(out)
  }
  const submit = async () => {
    const r: Any = await submitFraudIncident({
      incidentKind: form.incidentKind, channel: form.channel, summary: form.summary, eventDate: form.eventDate || null,
      lossOccurred: form.lossOccurred, lossAmount: form.lossAmount ? Number(form.lossAmount) : null, stepsTaken: form.stepsTaken || null,
      externalReports: form.agency && form.reference ? [{ agency: form.agency, reference: form.reference }] : [],
      transactionId: form.transactionId || null, evidence: files, shareConsent: !!form.shareConsent, clientRequestId: `${Date.now()}`,
    })
    say(r, "Report saved privately. Only your business's case reviewers and platform safety staff can read it.")
    if (r.ok) { setForm(blank); setFiles([]); await refresh() }
  }
  const chosen = p.typology.find((t) => t.kind === form.incidentKind)

  // ── staff ──
  const [queue, setQueue] = useState<Any | null>(null)
  const [edit, setEdit] = useState<Any>({})
  const [pub, setPub] = useState({ attest: false, legal: false, note: "" })
  const [subject, setSubject] = useState({ bulletinId: "", channel: "support_ticket", supportTicketId: "", statement: "" })
  const loadQueue = async () => { const q: Any = await listFraudModerationQueue(); if (q.ok) setQueue(q); else setMsg(q.error) }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Fraud &amp; Trust Network</h1>
        <p className="text-sm text-muted-foreground">Shared warnings describe scam TACTICS and how to verify safely — never a list of people. Reports stay private to your business and platform safety staff. A warning never blocks a deal or a vendor: it asks you to verify through a number you obtained independently.</p>
        {msg && <p className="mt-2 rounded-md border bg-muted p-2 text-sm" role="status">{msg}</p>}
      </div>

      {metrics && (
        <Card><CardHeader><CardTitle className="text-base">Measured results ({metrics.scope})</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div>Published warnings: {metrics.publishedBulletins}</div><div>Warnings read: {metrics.bulletinsRead}</div>
            <div>Verification tasks proposed: {metrics.verificationTasksProposed}</div><div>Verified and acted on: {metrics.verifiedSafetyTasksActed}</div>
            <div>Mean hours to verify: {metrics.meanHoursToVerify ?? "—"}</div><div>Corrections upheld: {metrics.falsePositiveCorrections}</div>
            <div className="col-span-full text-muted-foreground">Losses prevented: {metrics.lossesPreventedNote}</div>
          </CardContent></Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Shared warnings</CardTitle><CardDescription>Moderated by platform safety staff. Reporters are not identified unless they chose to be credited.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select className={sel} value={filter.typology} onChange={(e) => setFilter({ ...filter, typology: e.target.value })}><option value="">Every type</option>{p.typology.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}</select>
            <Input className="w-40" placeholder="State / area" value={filter.jurisdiction} onChange={(e) => setFilter({ ...filter, jurisdiction: e.target.value })} />
            <Button variant="outline" onClick={() => void loadBulletins()}>Filter</Button>
          </div>
          {bulletins.length === 0 && <p className="text-sm text-muted-foreground">No published warnings match.</p>}
          {bulletins.map((b) => (
            <div key={b.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2"><strong>{b.title}</strong><Badge variant="outline">{human(b.claim_class)}</Badge><Badge variant="outline">{b.confidence} confidence</Badge>{b.jurisdiction && <Badge variant="outline">{b.jurisdiction}</Badge>}</div>
              <p className="mt-1 text-sm">{b.tactic_summary}</p>
              {p.viewer.tenant && <Button size="sm" variant="link" onClick={async () => { const r: Any = await openFraudBulletin(b.id); if (r.ok) setOpen(r); else setMsg(r.error) }}>Read how to verify</Button>}
            </div>
          ))}
          {open && (
            <div className="rounded-md border border-primary p-3 text-sm space-y-2">
              <strong>{open.bulletin.title}</strong> <span className="text-muted-foreground">v{open.bulletin.version}</span>
              <p><b>Do this now:</b> {open.protectiveAction}</p>
              <p><b>How to verify safely:</b> {open.bulletin.how_to_verify}</p>
              {(open.bulletin.red_flags ?? []).length > 0 && <ul className="list-disc pl-5">{open.bulletin.red_flags.map((f: string) => <li key={f}>{f}</li>)}</ul>}
              {open.bulletin.named_entity && <p>Official warning names: {open.bulletin.named_entity} — <a className="underline" href={open.bulletin.named_entity_citation_url} target="_blank" rel="noreferrer">source</a></p>}
              {open.bulletin.source_url && <p><a className="underline" href={open.bulletin.source_url} target="_blank" rel="noreferrer">Source</a></p>}
              <p className="text-muted-foreground">Reported by: {open.bulletin.credits?.length ? open.bulletin.credits.join(", ") : "a member business (not identified)"}</p>
              <Textarea placeholder="Something wrong in this warning? Tell platform safety staff." value={correction} onChange={(e) => setCorrection(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={async () => { say(await requestFraudBulletinCorrection(open.bulletin.id, correction), "Correction request sent to platform safety staff."); setCorrection("") }}>Request a correction</Button>
                {p.viewer.reviewer && <Button size="sm" variant="outline" onClick={async () => say(await addFraudBulletinToTopicPool(open.bulletin.id), "Added to your topic pool as a general consumer-protection topic (no details from the warning).")}>Add as a protective education topic</Button>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {p.viewer.tenant && (
        <Card>
          <CardHeader><CardTitle className="text-base">Warning subscriptions</CardTitle><CardDescription>Get an alert when a warning of this type or place is published.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <select className={sel} value={sub.typology} onChange={(e) => setSub({ ...sub, typology: e.target.value })}><option value="">Every type</option>{p.typology.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}</select>
              <Input className="w-40" placeholder="State / area" value={sub.jurisdiction} onChange={(e) => setSub({ ...sub, jurisdiction: e.target.value })} />
              <Button variant="outline" onClick={async () => { say(await setFraudWarningSubscription({ typology: sub.typology || null, jurisdiction: sub.jurisdiction || null, on: true }), "Subscribed."); setSubs(await listMyFraudWarningSubscriptions()) }}>Subscribe</Button>
            </div>
            {subs.map((s) => <div key={s.id} className="flex items-center gap-2 text-sm">{s.typology ? labelOf(s.typology) : "Every type"} · {s.jurisdiction ?? "everywhere"}<Button size="sm" variant="link" onClick={async () => { say(await setFraudWarningSubscription({ typology: s.typology, jurisdiction: s.jurisdiction, on: false }), "Unsubscribed."); setSubs(await listMyFraudWarningSubscriptions()) }}>Remove</Button></div>)}
          </CardContent>
        </Card>
      )}

      {p.viewer.tenant && (
        <Card>
          <CardHeader><CardTitle className="text-base">Report an incident (private)</CardTitle><CardDescription>Never type full account, routing, card or ID numbers. {p.evidenceStorageNote}</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <select className={sel} value={form.incidentKind} onChange={(e) => setForm({ ...form, incidentKind: e.target.value })}><option value="">Incident type…</option>{p.typology.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}</select>
            {chosen && <div className="rounded-md bg-muted p-2 text-sm"><b>Do this now:</b> {chosen.protectiveAction}<br /><b>Gather:</b> {chosen.evidenceChecklist.join(" · ")}</div>}
            <div className="flex flex-wrap gap-2">
              <select className={sel} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>{p.channels.map((c) => <option key={c} value={c}>{human(c)}</option>)}</select>
              <Input type="date" className="w-44" value={form.eventDate} onChange={(e) => setForm({ ...form, eventDate: e.target.value })} />
              <select className={sel} value={form.lossOccurred} onChange={(e) => setForm({ ...form, lossOccurred: e.target.value })}><option value="unknown">Loss unknown</option><option value="no">No loss</option><option value="yes">Loss occurred</option></select>
              {form.lossOccurred === "yes" && <Input className="w-36" inputMode="decimal" placeholder="Amount" value={form.lossAmount} onChange={(e) => setForm({ ...form, lossAmount: e.target.value })} />}
            </div>
            <Textarea placeholder="What happened" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
            <Textarea placeholder="Steps already taken (who was called, how it was verified)" value={form.stepsTaken} onChange={(e) => setForm({ ...form, stepsTaken: e.target.value })} />
            <div className="flex flex-wrap gap-2">
              <select className={sel} value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })}><option value="">Report filed with…</option>{p.agencies.map((a) => <option key={a} value={a}>{human(a)}</option>)}</select>
              <Input className="w-48" placeholder="Report number" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
              <Input className="w-72" placeholder="Deal ID (optional — only a deal you work)" value={form.transactionId} onChange={(e) => setForm({ ...form, transactionId: e.target.value })} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select className={sel} value={evKind} onChange={(e) => setEvKind(e.target.value)}>{p.evidenceKinds.map((k) => <option key={k} value={k}>{human(k)}</option>)}</select>
              <input type="file" multiple onChange={(e) => void addFiles(e.target.files)} aria-label="Evidence files (fingerprint only)" />
              <span className="text-muted-foreground">{files.length} file fingerprint(s) — the files stay on your device</span>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.shareConsent} onChange={(e) => setForm({ ...form, shareConsent: e.target.checked })} />Credit my business by name if a warning is published from this report (otherwise it stays anonymous)</label>
            <Button onClick={() => void submit()}>Submit privately</Button>
          </CardContent>
        </Card>
      )}

      {p.viewer.tenant && (
        <Card>
          <CardHeader><CardTitle className="text-base">{p.viewer.reviewer ? "Your business's cases" : "Your reports"}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {cases.length === 0 && <p className="text-sm text-muted-foreground">No reports yet.</p>}
            {cases.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">{human(c.status)}</Badge>{labelOf(c.incident_kind)} · {String(c.created_at).slice(0, 10)}
                <Button size="sm" variant="link" onClick={async () => { const r: Any = await getFraudCase(c.id); if (r.ok) setCaseView(r); else setMsg(r.error) }}>Open</Button>
              </div>
            ))}
            {caseView && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p>{caseView.case.summary}</p>
                <p className="text-muted-foreground">Evidence fingerprints: {caseView.evidence.length}. Retained until {String(caseView.case.retention_until).slice(0, 10)}.</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={async () => say(await requestFraudEvidenceView(caseView.case.id), "")}>View evidence files</Button>
                  <Button size="sm" variant="outline" onClick={async () => { say(await withdrawFraudCase(caseView.case.id), "Report withdrawn."); await refresh() }}>Withdraw</Button>
                </div>
                <Textarea placeholder="Appeal the moderation outcome" value={appeal} onChange={(e) => setAppeal(e.target.value)} />
                <Button size="sm" variant="outline" onClick={async () => { say(await appealFraudCaseDecision(caseView.case.id, appeal), "Appeal sent."); setAppeal("") }}>Appeal</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {p.viewer.staff && queue && (
        <Card>
          <CardHeader><CardTitle className="text-base">Moderation (platform safety staff)</CardTitle><CardDescription>Publication is a human act. Never name a person from an unverified report; a named entity needs an official government source and legal review.</CardDescription></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="space-y-2"><b>Cases to review ({queue.cases.length})</b>
              {queue.cases.map((c: Any) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{human(c.status)}</Badge>{labelOf(c.incident_kind)} · loss {c.loss_occurred}{c.dispute ? " · appealed" : ""}
                  <Button size="sm" variant="link" onClick={async () => { const r: Any = await getFraudCase(c.id); if (r.ok) setCaseView(r); else setMsg(r.error) }}>Inspect</Button>
                  <Button size="sm" variant="link" onClick={async () => { say(await addFraudCaseModerationNote(c.id, "Under review by platform safety staff.", "under_review"), "Marked under review."); await loadQueue() }}>Start review</Button>
                  <Button size="sm" variant="link" onClick={async () => { say(await addFraudCaseModerationNote(c.id, "Closed: evidence insufficient for a shared warning.", "closed_no_action"), "Closed with no action."); await loadQueue() }}>Close, no action</Button>
                  <Button size="sm" variant="link" onClick={async () => { const r: Any = await draftFraudBulletinFromCase(c.id); say(r, "Draft warning created with a redacted summary — edit before publishing."); await loadQueue() }}>Draft warning</Button>
                </div>
              ))}
            </div>
            <div className="space-y-2"><b>Warnings</b>
              {queue.bulletins.map((b: Any) => (
                <div key={b.id} className="space-y-1 rounded-md border p-2">
                  <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{b.status}</Badge>{b.title} · {human(b.claim_class)} · v{b.version}<Button size="sm" variant="link" onClick={() => setEdit({ id: b.id, status: b.status })}>Edit</Button></div>
                  {edit.id === b.id && (
                    <div className="space-y-1">
                      <Input placeholder="Title" onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                      <Textarea placeholder="Tactic (no names, contacts, accounts or addresses)" onChange={(e) => setEdit({ ...edit, tactic_summary: e.target.value })} />
                      <Textarea placeholder="How to verify safely" onChange={(e) => setEdit({ ...edit, how_to_verify: e.target.value })} />
                      <div className="flex flex-wrap gap-2">
                        <select className={sel} onChange={(e) => setEdit({ ...edit, claim_class: e.target.value })}><option value="">Claim class…</option>{p.claimClasses.map((c) => <option key={c} value={c}>{human(c)}</option>)}</select>
                        <select className={sel} onChange={(e) => setEdit({ ...edit, confidence: e.target.value })}><option value="">Confidence…</option><option>low</option><option>medium</option><option>high</option></select>
                        <Input className="w-40" placeholder="Jurisdiction" onChange={(e) => setEdit({ ...edit, jurisdiction: e.target.value })} />
                        <Input className="w-64" placeholder="Source URL (https)" onChange={(e) => setEdit({ ...edit, source_url: e.target.value })} />
                        <Input className="w-56" placeholder="Look-alike domain (verified only)" onChange={(e) => setEdit({ ...edit, indicators: e.target.value ? [{ kind: "lookalike_domain", value: e.target.value }] : [] })} />
                        <Input className="w-56" placeholder="Official named entity" onChange={(e) => setEdit({ ...edit, named_entity: e.target.value })} />
                        <Input className="w-64" placeholder="Official citation URL (.gov)" onChange={(e) => setEdit({ ...edit, named_entity_citation_url: e.target.value })} />
                        <Input className="w-64" placeholder="Link a case ID" onChange={(e) => setEdit({ ...edit, caseId: e.target.value })} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {b.status === "draft" && <Button size="sm" variant="outline" onClick={async () => { const { id, status, caseId, reason, ...f } = edit; say(await updateFraudBulletinDraft(id, f), "Draft saved."); await loadQueue() }}>Save draft</Button>}
                        {edit.caseId && <Button size="sm" variant="outline" onClick={async () => { const r: Any = await linkFraudCaseToBulletin(b.id, edit.caseId); say(r, `Linked. Independent corroboration: ${r?.corroboration?.independentTenants ?? 0} business(es).`) }}>Link case</Button>}
                      </div>
                      {b.status === "draft" && (
                        <div className="space-y-1">
                          <label className="flex items-center gap-2"><input type="checkbox" checked={pub.attest} onChange={(e) => setPub({ ...pub, attest: e.target.checked })} />I confirm this warning identifies no private person, client, account or home address.</label>
                          <label className="flex items-center gap-2"><input type="checkbox" checked={pub.legal} onChange={(e) => setPub({ ...pub, legal: e.target.checked })} />Legal review is complete for any named entity.</label>
                          <Textarea placeholder="How was it verified?" value={pub.note} onChange={(e) => setPub({ ...pub, note: e.target.value })} />
                          <Button size="sm" onClick={async () => { say(await publishFraudBulletin(b.id, { attestNoPersonIdentified: pub.attest, legalReviewConfirmed: pub.legal, verificationNote: pub.note }), "Published."); await loadQueue(); await loadBulletins() }}>Publish</Button>
                        </div>
                      )}
                      {b.status === "published" && (
                        <div className="space-y-1">
                          <Input placeholder="Reason (kept in the correction history)" onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={async () => { const { id, status, caseId, reason, ...f } = edit; say(await correctFraudBulletin(id, f, reason ?? ""), "Corrected; the previous version is kept."); await loadQueue(); await loadBulletins() }}>Publish correction</Button>
                            <Button size="sm" variant="destructive" onClick={async () => { say(await takeDownFraudBulletin(b.id, edit.reason ?? ""), "Taken down; derived topics withdrawn."); await loadQueue(); await loadBulletins() }}>Take down</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="space-y-2"><b>Correction requests ({queue.corrections.length})</b>
              {queue.corrections.map((c: Any) => (
                <div key={c.id} className="space-y-1 rounded-md border p-2">
                  <div>{human(c.requester_kind)} via {human(c.channel)}: {c.statement}</div>
                  <div className="flex flex-wrap gap-2">
                    {(["rejected", "taken_down"] as const).map((o) => <Button key={o} size="sm" variant="outline" onClick={async () => { say(await resolveFraudCorrectionRequest({ requestId: c.id, outcome: o, resolution: edit.reason || `Resolved: ${human(o)}` }), `Resolved: ${human(o)}.`); await loadQueue() }}>{o === "rejected" ? "Reject" : "Take down"}</Button>)}
                    <Button size="sm" variant="outline" onClick={async () => { const { id, status, caseId, reason, ...f } = edit; say(await resolveFraudCorrectionRequest({ requestId: c.id, outcome: "corrected", resolution: edit.reason || "Corrected after review", changes: f }), "Corrected (use Edit on the warning to set the new text first)."); await loadQueue() }}>Correct with edits</Button>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Input className="w-64" placeholder="Warning ID" value={subject.bulletinId} onChange={(e) => setSubject({ ...subject, bulletinId: e.target.value })} />
                <select className={sel} value={subject.channel} onChange={(e) => setSubject({ ...subject, channel: e.target.value })}>{["support_ticket", "email", "phone", "postal_mail"].map((c) => <option key={c} value={c}>{human(c)}</option>)}</select>
                <Input className="w-64" placeholder="Support ticket ID (optional)" value={subject.supportTicketId} onChange={(e) => setSubject({ ...subject, supportTicketId: e.target.value })} />
              </div>
              <Textarea placeholder="What the named subject asked to correct" value={subject.statement} onChange={(e) => setSubject({ ...subject, statement: e.target.value })} />
              <Button size="sm" variant="outline" onClick={async () => { say(await recordFraudSubjectCorrection({ ...subject, supportTicketId: subject.supportTicketId || null }), "Recorded."); await loadQueue() }}>Record a named subject's request</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
