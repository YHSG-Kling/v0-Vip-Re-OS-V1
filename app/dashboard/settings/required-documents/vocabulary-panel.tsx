"use client"

// THE VOCABULARY PANEL (wave 144, lane 144A; owner ruling 1). Where a person says a contract type, financing
// type, representation, listing type, property type or stage label is MISSING, OBSOLETE, DIFFERENT IN THEIR
// STATE or needs a NEW NAME — and where the brokerage's admins approve the resulting proposal. The panel
// decides nothing: the evaluation, validation, approval, promotion and verification are
// lib/compliance/vocabulary-healing.ts over the controlled-learning kernel, re-checked server-side.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2 } from "lucide-react"
import {
  approveVocabularyProposalAction, attestVocabularyTermAction, rejectVocabularyProposalAction, reportComingSoonPolicyAction, reportVocabularyGapAction,
} from "@/app/actions/compliance/vocabulary"
import type { VocabularyDimension } from "@/lib/compliance/adaptive-vocabulary"

export interface VocabularyPanelDimension {
  key: VocabularyDimension
  label: string
  mode: "extensible" | "label_alias_only"
  jurisdictional: boolean
  /** Every current term (platform + this brokerage's) — the "same as" / "a kind of" choices. */
  terms: Array<{ value: string; label: string; origin: "platform" | "tenant" }>
}

export interface VocabularyPanelProposal {
  id: string
  status: string
  summary: string
  requiresCompliance: boolean
  warnings: string[]
  createdAt: string
}

interface Props {
  dimensions: VocabularyPanelDimension[]
  proposals: VocabularyPanelProposal[]
  pendingAttestation: Array<{ dimension: VocabularyDimension; key: string; label: string; states: string[]; sourceUrl: string | null }>
  canApprove: boolean
  canAttest: boolean
  supportedStates: string[]
  readError: string | null
  /** The MLS coming-soon rules on file (lib/compliance/coming-soon-policy.ts) — attested ones are in force; none = closed. */
  comingSoonRules: Array<{ mlsName: string; states: string[]; summary: string; attested: boolean; sourceUrl: string; ruleRef: string }>
}

const KINDS = [
  { value: "missing", label: "is missing" },
  { value: "different_in_state", label: "is different in my state" },
  { value: "obsolete", label: "is obsolete — retire it" },
  { value: "rename", label: "needs a new name" },
] as const

export function VocabularyPanel({ dimensions, proposals, pendingAttestation, canApprove, canAttest, supportedStates, readError, comingSoonRules }: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [dimension, setDimension] = useState<VocabularyDimension>(dimensions[0]?.key ?? "contract_subtype")
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("missing")
  const [label, setLabel] = useState("")
  const [relation, setRelation] = useState<"kind_of" | "same_as">("kind_of")
  const [related, setRelated] = useState("")
  const [stateCode, setStateCode] = useState("")
  const [sourceUrl, setSourceUrl] = useState("")
  const [newLabel, setNewLabel] = useState("")
  const [note, setNote] = useState("")
  const [answer, setAnswer] = useState<string | null>(null)
  // The MLS coming-soon rule form — every value is the MLS's own published rule, never a default.
  const [csMls, setCsMls] = useState("")
  const [csStates, setCsStates] = useState("")
  const [csPermitted, setCsPermitted] = useState("")
  const [csMaxDays, setCsMaxDays] = useState("")
  const [csShowings, setCsShowings] = useState("")
  // Owner ruling 1 (wave 145, lane 145Z — lane 145B Outside-lane 13): the MLS's own rule on the street address in
  // Coming Soon advertising — yes / no / unstated. Unstated is recorded as null and the street stays withheld.
  const [csStreet, setCsStreet] = useState("")
  const [csWithin, setCsWithin] = useState("")
  const [csUrl, setCsUrl] = useState("")
  const [csRule, setCsRule] = useState("")
  const spec = dimensions.find((d) => d.key === dimension)
  const platformTerms = (spec?.terms ?? []).filter((t) => t.origin === "platform")

  function report() {
    setAnswer(null)
    start(async () => {
      const r = await reportVocabularyGapAction({
        dimension, label, kind,
        stateCode: stateCode || null,
        sameAs: relation === "same_as" || spec?.mode === "label_alias_only" ? related || null : null,
        rollsUpTo: relation === "kind_of" && spec?.mode === "extensible" ? related || null : null,
        newLabel: kind === "rename" ? newLabel || null : null,
        sourceUrl: sourceUrl || null,
        note: note || null,
      })
      if (!r.ok) { setAnswer(`Not proposed: ${r.error}`); return }
      if (r.outcome === "answered") {
        const e = r.evaluation
        setAnswer(`${e.why}${e.needs.length ? ` — still needed: ${e.needs.join(", ")}` : ""}${e.candidates.length ? ` — similar: ${e.candidates.map((c) => c.label).join(", ")}` : ""}`)
        return
      }
      setAnswer(`${r.existing ? "Already proposed" : "Proposed"} (${r.status ?? "PROPOSED"}): ${r.evaluation.why}${r.validation.requiresCompliance ? " — a compliance approver must approve it." : ""}`)
      setLabel(""); setRelated(""); setNewLabel(""); setNote("")
      router.refresh()
    })
  }

  function decide(id: string, approve: boolean) {
    setAnswer(null)
    start(async () => {
      if (!approve) {
        const rj = await rejectVocabularyProposalAction(id)
        setAnswer(rj.ok ? "Rejected." : `Not rejected: ${rj.error}`)
        if (rj.ok) router.refresh()
        return
      }
      const r = await approveVocabularyProposalAction(id)
      if (!r.ok) { setAnswer(`Not approved: ${r.error}${r.errors?.length ? ` (${r.errors.join("; ")})` : ""}`); return }
      setAnswer(`Applied${r.policyVersionRef ? ` — ${r.policyVersionRef}` : ""}. ${r.verified ? "Verified" : "NOT verified"}: ${r.why}`)
      router.refresh()
    })
  }

  function reportComingSoon() {
    setAnswer(null)
    const yesNo = (v: string) => (v === "yes" ? true : v === "no" ? false : null)
    start(async () => {
      const r = await reportComingSoonPolicyAction({
        mlsName: csMls, stateCodes: csStates.split(/[\s,]+/).filter(Boolean), permitted: yesNo(csPermitted), showingsPermitted: yesNo(csShowings),
        streetAddressDisclosurePermitted: yesNo(csStreet),
        maxDays: csMaxDays || null, mlsSubmissionWithinBusinessDays: csWithin || null, sourceUrl: csUrl || null, ruleRef: csRule || null,
      })
      setAnswer(r.ok ? `${r.existing ? "Already proposed" : "Proposed"} (${r.status ?? "PROPOSED"}) — a compliance approver approves it.` : `Not proposed: ${r.error}${r.errors?.length ? ` (${r.errors.join("; ")})` : ""}`)
      if (r.ok) router.refresh()
    })
  }

  function attest(d: VocabularyDimension, key: string) {
    setAnswer(null)
    start(async () => {
      const r = await attestVocabularyTermAction(d, key)
      setAnswer(r.ok ? r.why : `Not attested: ${r.error}`)
      if (r.ok) router.refresh()
    })
  }

  const open = proposals.filter((p) => ["PROPOSED", "EVALUATED", "APPROVED"].includes(p.status))
  return (
    <Card id="vocabulary">
      <CardHeader><CardTitle>Vocabulary — contract types, financing, representation and more</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Missing a label, or does your state use a different one? Report it here. The data steward compares it with
          the existing vocabulary and proposes an alias, a new term (always a kind of an existing one, so pre-approval,
          offer requirements, reporting and forms keep working), a rename or a retirement. An admin approves it; a
          state-specific term also needs a compliance approver and the official (.gov / .us) source. Nothing is ever
          deleted — old records keep reading their values.
        </p>
        {readError && <p className="text-xs text-red-700">The brokerage vocabulary could not be read: {readError}</p>}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">Vocabulary</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={dimension} onChange={(e) => { setDimension(e.target.value as VocabularyDimension); setRelated("") }}>
              {dimensions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">The label</span>
            <input className="w-full border rounded px-2 py-1.5 text-sm" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Intermediary, FHA 203(k)" />
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">…</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number]["value"])}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
          {(kind === "missing" || kind === "different_in_state") && (
            <>
              <label className="text-sm">
                <span className="block text-xs font-medium mb-1">How it relates</span>
                <select className="w-full border rounded px-2 py-1.5 text-sm" value={spec?.mode === "label_alias_only" ? "same_as" : relation} onChange={(e) => setRelation(e.target.value as "kind_of" | "same_as")} disabled={spec?.mode === "label_alias_only"}>
                  {spec?.mode === "extensible" && <option value="kind_of">It is a kind of…</option>}
                  <option value="same_as">It means the same as…</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-xs font-medium mb-1">{relation === "kind_of" && spec?.mode === "extensible" ? "Existing type it rolls up to" : "Existing term it means"}</span>
                <select className="w-full border rounded px-2 py-1.5 text-sm" value={related} onChange={(e) => setRelated(e.target.value)}>
                  <option value="">Choose…</option>
                  {(relation === "kind_of" && spec?.mode === "extensible" ? platformTerms : spec?.terms ?? []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
            </>
          )}
          {kind === "rename" && (
            <label className="text-sm">
              <span className="block text-xs font-medium mb-1">New label</span>
              <input className="w-full border rounded px-2 py-1.5 text-sm" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            </label>
          )}
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">State {spec?.jurisdictional ? "(required — this varies by state)" : "(only if a state's law is the reason)"}</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
              <option value="">Brokerage-wide</option>
              {supportedStates.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm md:col-span-2">
            <span className="block text-xs font-medium mb-1">Official source (.gov / .us) — required for a state-specific term</span>
            <input className="w-full border rounded px-2 py-1.5 text-sm" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://www.trec.texas.gov/…" />
          </label>
          <label className="text-sm md:col-span-3">
            <span className="block text-xs font-medium mb-1">Note (optional)</span>
            <input className="w-full border rounded px-2 py-1.5 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it is needed" />
          </label>
        </div>
        <Button size="sm" onClick={report} disabled={pending || !label.trim()}>
          {pending ? <Loader2 className="h-3 w-3 mr-2 animate-spin" /> : null}
          Report
        </Button>
        {answer && <p className="text-xs text-muted-foreground">{answer}</p>}

        {open.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">Awaiting a decision</p>
            <ul className="divide-y border rounded">
              {open.map((p) => (
                <li key={p.id} className="p-2 flex items-start gap-2">
                  <Badge variant="outline" className="shrink-0">{p.status}</Badge>
                  <div className="flex-1 min-w-0 text-sm">
                    <p>{p.summary}</p>
                    {p.requiresCompliance && <p className="text-xs text-amber-800">State-specific — a compliance approver approves it and attests the source.</p>}
                    {p.warnings.map((w, i) => <p key={i} className="text-xs text-muted-foreground">{w}</p>)}
                  </div>
                  {canApprove && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => decide(p.id, true)}>Approve</Button>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide(p.id, false)}>Reject</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {pendingAttestation.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">State-specific terms waiting for a compliance attestation (not offered for new work yet)</p>
            <ul className="divide-y border rounded">
              {pendingAttestation.map((t) => (
                <li key={`${t.dimension}:${t.key}`} className="p-2 flex items-center gap-2 text-sm">
                  <span className="flex-1">{t.label} ({t.states.join(", ")}){t.sourceUrl && <> — <a className="text-primary underline underline-offset-2" href={t.sourceUrl} target="_blank" rel="noreferrer">source</a></>}</span>
                  {canAttest && <Button size="sm" variant="outline" disabled={pending} onClick={() => attest(t.dimension, t.key)}>Attest</Button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">MLS coming-soon rules</p>
          <p className="text-xs text-muted-foreground">
            Coming soon is decided by your MLS&apos;s own published rules (whether it is allowed, for how long, whether the home may
            be shown, how soon after public marketing it must be in the MLS). Until a compliance approver records and attests
            your MLS&apos;s rule here, coming soon stays closed — the platform never assumes one.
          </p>
          {comingSoonRules.length > 0 && (
            <ul className="divide-y border rounded">
              {comingSoonRules.map((c) => (
                <li key={c.mlsName} className="p-2 text-sm flex items-center gap-2">
                  <Badge variant={c.attested ? "secondary" : "outline"}>{c.attested ? "in force" : "awaiting attestation"}</Badge>
                  <span className="flex-1">{c.mlsName} ({c.states.join(", ")}): {c.summary} — <a className="text-primary underline underline-offset-2" href={c.sourceUrl} target="_blank" rel="noreferrer">{c.ruleRef}</a></span>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <input className="border rounded px-2 py-1.5 text-sm" value={csMls} onChange={(e) => setCsMls(e.target.value)} placeholder="MLS name" />
            <input className="border rounded px-2 py-1.5 text-sm" value={csStates} onChange={(e) => setCsStates(e.target.value)} placeholder="States (e.g. FL)" />
            <select className="border rounded px-2 py-1.5 text-sm" value={csPermitted} onChange={(e) => setCsPermitted(e.target.value)}>
              <option value="">Coming soon permitted?</option><option value="yes">Permitted</option><option value="no">Not permitted</option>
            </select>
            <select className="border rounded px-2 py-1.5 text-sm" value={csShowings} onChange={(e) => setCsShowings(e.target.value)}>
              <option value="">Showings while coming soon?</option><option value="yes">Showings permitted</option><option value="no">No showings</option>
            </select>
            <select className="border rounded px-2 py-1.5 text-sm" value={csStreet} onChange={(e) => setCsStreet(e.target.value)} aria-label="Street address in Coming Soon advertising">
              <option value="">Street address in Coming Soon ads? (unstated — withheld)</option><option value="yes">Rule permits the street address</option><option value="no">Rule forbids the street address</option>
            </select>
            <input className="border rounded px-2 py-1.5 text-sm" value={csMaxDays} onChange={(e) => setCsMaxDays(e.target.value)} placeholder="Max days (blank = rule states none)" />
            <input className="border rounded px-2 py-1.5 text-sm" value={csWithin} onChange={(e) => setCsWithin(e.target.value)} placeholder="MLS within N business days of marketing" />
            <input className="border rounded px-2 py-1.5 text-sm" value={csUrl} onChange={(e) => setCsUrl(e.target.value)} placeholder="The MLS's published rule (https URL)" />
            <input className="border rounded px-2 py-1.5 text-sm" value={csRule} onChange={(e) => setCsRule(e.target.value)} placeholder="Rule section (e.g. Sec. 1.01)" />
          </div>
          <Button size="sm" variant="outline" onClick={reportComingSoon} disabled={pending || !csMls.trim()}>Propose the MLS rule</Button>
        </div>
      </CardContent>
    </Card>
  )
}
