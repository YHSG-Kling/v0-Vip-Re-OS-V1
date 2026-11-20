"use client"

/**
 * PERSONA PANEL — the contact-card surface for owner ruling 1 (wave 148, lane 148C, 2026-11-01): "the read of protected or
 * prohibited can be used to determine the person's persona so users can create ads and posts, etc. around that persona. The
 * admin, platform, agent, team lead, broker, compliance, support, etc. should be able to read."
 *
 * Wires the session-door actions (app/actions/contact-persona.ts):
 *   loadContactPersona            → the five layers, as stored (research layer = field NAMES only)
 *   deriveContactPersona          → "Study this person" (the AI persona study; its marketing layer is firewalled)
 *   readContactResearchAttributes → "Read research attributes" (purpose + justification; the reader decides by role × purpose ×
 *                                   scope, ledgers both outcomes, and its refusal is shown in words)
 * and the C26 door (app/actions/contact-persona.ts createContactPersonaAudience → lib/ads/persona-audience.ts, on the Ads Manager
 * survivor) → "Create custom audience" on the DERIVED persona — ANY situation persona (wave 149, lane 149A, owner ruling
 * 2026-11-03 "every persona is allowed"; the wave-148 "needs-based by rule" basis refusal is removed). Consent, suppression and
 * the platform's housing delivery rules still run.
 *
 * The layers are shown SEPARATELY on purpose: what the person said, what they did, what is inferred (with confidence), and the
 * marketing-safe persona are different kinds of knowledge, and the research layer never sits beside the marketing persona.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, UserRoundSearch, ShieldCheck, Megaphone } from "lucide-react"
import { loadContactPersona, deriveContactPersona, readContactResearchAttributes, createContactPersonaAudience } from "@/app/actions/contact-persona"
import { MARKETING_NEEDS } from "@/lib/contacts/persona-layers"

type Evidence = { id: string; source: string; summary: string; supports: string | null; confidence: number }
type Need = { need: string; confidence: number; evidenceRefs: string[]; why: string }
type Marketing = { headline: string; needs: Need[]; campaignPersona: string | null; audienceEligible: boolean; messaging: { angles: string[]; educationTopics: string[]; tone: string; platformHooks: Record<string, string>; avoid: string[] } }
type Service = { summary: string; howToHelp: string[]; openQuestions: string[] }
type ResearchRow = { field: string; value: string | null; protectedClass: string | null; basis: string | null; dataRights: string; source: string | null; retrievedAt: string | null }

const PURPOSES: Array<[string, string]> = [
  ["customer_service", "Customer service (accommodations the person told us)"],
  ["persona_derivation", "Persona study (shapes service only)"],
  ["research", "Research (broker / compliance)"],
  ["compliance_audit", "Compliance audit"],
  ["support_investigation", "Support investigation (needs a case reference)"],
]

export function PersonaPanel({ contactId }: { contactId: string }) {
  const [row, setRow] = useState<Record<string, any> | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // C26 preview: the audience the button will build (name / consent basis / platform note), or the platform's refusal.
  const [audiencePlan, setAudiencePlan] = useState<{ ok: true; audienceName: string; consentBasis: string; platformNote: string } | { ok: false; refusal: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [purpose, setPurpose] = useState("customer_service")
  const [justification, setJustification] = useState("")
  const [research, setResearch] = useState<{ rows: ResearchRow[]; withheld: Array<{ field: string; reason: string }>; scope: string; role: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  const load = useCallback(async () => {
    setLoading(true)
    const res = await loadContactPersona({ contactId })
    if (!res.ok) setNote(res.error)
    else { setRow(res.persona); setAudiencePlan("audiencePlan" in res ? (res.audiencePlan ?? null) : null); if (!res.layered && "note" in res) setNote(res.note ?? null) }
    setLoading(false)
  }, [contactId])
  useEffect(() => { void load() }, [load])

  const study = () => startTransition(async () => {
    setNote(null)
    const res = await deriveContactPersona({ contactId })
    if (!res.ok) { setNote(res.error); return }
    setNote(res.contactPersonaWritten ? `Persona derived — this contact now joins "${res.contactPersonaWritten}" persona audiences.` : `Persona derived${res.notes.length ? ` — ${res.notes[0]}` : "."}`)
    await load()
  })

  const readResearch = () => startTransition(async () => {
    setNote(null)
    const res = await readContactResearchAttributes({ contactId, purpose, purposeNote: justification || null })
    if (!res.ok) { setResearch(null); setNote(`Refused: ${res.error}`); return }
    setResearch({ rows: res.attributes, withheld: res.withheld, scope: res.scope, role: res.role })
  })

  const marketing = (row?.marketing_persona ?? null) as Marketing | null
  const service = (row?.service_profile ?? null) as Service | null
  const createPersonaAudience = () => startTransition(async () => {
    if (!marketing?.campaignPersona) return
    setNote(null)
    const res = await createContactPersonaAudience({ persona: marketing.campaignPersona, platform: "facebook", derived: true })
    setNote(res.ok ? `Custom audience "${res.audienceName ?? marketing.headline}" created as a draft — review, approve and sync it in Ads.` : `Audience not created: ${res.error}`)
  })

  const layer = (title: string, items: Evidence[] | undefined) => (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title}</p>
      {(items ?? []).length === 0 ? <p className="text-xs text-muted-foreground">None recorded.</p> : (items ?? []).map((e) => (
        <p key={e.id} className="text-xs text-muted-foreground">{e.summary} <span className="opacity-70">({e.source}, {Math.round(e.confidence * 100)}%)</span></p>
      ))}
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm flex items-center gap-2"><UserRoundSearch className="h-4 w-4 text-primary" />Persona</CardTitle>
            <CardDescription className="text-xs">What they need, kept apart from who they are. Research attributes shape service, never marketing.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={study} disabled={isPending}>
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Study this person"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : !row ? <p className="text-xs text-muted-foreground">No persona yet — study this person to build one.</p> : (
          <>
            {service && (
              <div className="space-y-1">
                <p className="text-xs font-medium">How to help</p>
                <p className="text-xs">{service.summary}</p>
                {service.howToHelp.map((h) => <p key={h} className="text-xs text-muted-foreground">• {h}</p>)}
                {service.openQuestions.map((q) => <p key={q} className="text-xs text-muted-foreground">? {q}</p>)}
              </div>
            )}
            {layer("Stated needs", row.stated_needs)}
            {layer("Behaviour", row.behavioural_evidence)}
            {layer("Inferred interests", row.inferred_interests)}
            {marketing && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  <p className="text-xs font-medium">Marketing persona: {marketing.headline}</p>
                  {marketing.campaignPersona && <Badge variant="secondary">{marketing.campaignPersona}</Badge>}
                </div>
                {marketing.needs.map((n) => <p key={n.need} className="text-xs text-muted-foreground">{(MARKETING_NEEDS as Record<string, { label: string }>)[n.need]?.label ?? n.need.replace(/_/g, " ")} — {Math.round(n.confidence * 100)}% · {n.why}</p>)}
                {marketing.messaging.angles.map((a) => <p key={a} className="text-xs">“{a}”</p>)}
                {Object.entries(marketing.messaging.platformHooks ?? {}).map(([p, h]) => <p key={p} className="text-xs text-muted-foreground">{p}: {h}</p>)}
                <Button size="sm" variant="outline" onClick={createPersonaAudience} disabled={isPending || !marketing.audienceEligible || !marketing.campaignPersona}>
                  <Megaphone className="h-3 w-3 mr-1" />Create custom audience
                </Button>
                {!marketing.audienceEligible && <p className="text-xs text-muted-foreground">Not enough evidence yet for an audience — ask what they need.</p>}
                {audiencePlan?.ok && <p className="text-xs text-muted-foreground">Meta custom audience “{audiencePlan.audienceName}” — {audiencePlan.consentBasis}. {audiencePlan.platformNote}</p>}
                {audiencePlan && !audiencePlan.ok && <p className="text-xs text-muted-foreground">{audiencePlan.refusal}</p>}
              </div>
            )}
          </>
        )}
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium">Research attributes</p>
          <select className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs" value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Purpose of this read">
            {PURPOSES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <input className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs" placeholder="Why are you reading this? (required for support and platform staff)" value={justification} onChange={(e) => setJustification(e.target.value)} aria-label="Justification" />
          <Button size="sm" variant="outline" onClick={readResearch} disabled={isPending}>Read research attributes</Button>
          <p className="text-xs text-muted-foreground">Every read is logged with its purpose. These never choose who sees an ad.</p>
          {research && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Read as {research.role} ({research.scope} scope).</p>
              {research.rows.map((r) => <p key={`${r.field}-${r.source}`} className="text-xs">{r.field}: {r.value ?? "—"} <span className="text-muted-foreground">({r.protectedClass ?? "operational"}, {r.basis ?? "basis unstated"}, {r.dataRights})</span></p>)}
              {research.withheld.map((w) => <p key={w.field} className="text-xs text-muted-foreground">{w.field}: withheld — {w.reason}</p>)}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
