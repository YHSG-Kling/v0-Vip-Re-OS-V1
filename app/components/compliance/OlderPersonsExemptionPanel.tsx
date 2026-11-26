"use client"

/**
 * app/components/compliance/OlderPersonsExemptionPanel.tsx
 *
 * Where a broker or compliance officer RECORDS the housing-for-older-persons exemption for a community
 * (wave 143, lane 143F). A "55+" / "senior living" claim in a listing, lead magnet, book, video or podcast script
 * passes the fair-housing gate only against a verified record for the community the copy NAMES — this is the writer.
 * The conditions are the law's own (42 U.S.C. § 3607(b)(2)-(3); 24 CFR 100.300-100.308): the 80 percent line over
 * occupied units, published policies, an occupancy survey refreshed at least every two years, and the community's sworn
 * certification. The STATUS is computed on the server from the facts entered — it cannot be ticked. Mounted on
 * /compliance/settings beside the prohibited-phrases panel.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  listOlderPersonsVerificationsAction, recordOlderPersonsVerificationAction, removeOlderPersonsVerificationAction,
} from "@/app/actions/fair-housing-older-persons"

type Listed = Extract<Awaited<ReturnType<typeof listOlderPersonsVerificationsAction>>, { success: true }>
type Basis = "55_plus" | "62_plus" | "federal_state_program"

const BASIS_LABELS: Record<Basis, string> = {
  "55_plus": "55 or older (§ 3607(b)(2)(C))",
  "62_plus": "62 or older (§ 3607(b)(2)(B))",
  federal_state_program: "State / Federal elderly-housing programme (§ 3607(b)(2)(A))",
}

const EMPTY = {
  community_name: "", basis: "55_plus" as Basis, governing_rules: "", occupied_units: "", qualifying_units: "", survey_completed_on: "",
  policies_published: false, policies_reference: "", age_verification_procedures: false, program_name: "", program_determination_ref: "",
  sworn_certification_on_file: false, certifying_representative: "", certification_date: "", state: "", state_law_reviewed: false,
}

export function OlderPersonsExemptionPanel({ className }: { className?: string }) {
  const [data, setData] = useState<Listed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [pending, startTransition] = useTransition()
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [k]: v }))

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await listOlderPersonsVerificationsAction()
      if (r.success) { setData(r); setError(null) } else { setData(null); setError(r.error) }
    })
  }, [])
  useEffect(() => { load() }, [load])

  const submit = () => {
    startTransition(async () => {
      const num = (s: string) => (s.trim() === "" ? null : Number(s))
      const r = await recordOlderPersonsVerificationAction({
        community_name: form.community_name, basis: form.basis, governing_rules: form.governing_rules || null,
        occupied_units: num(form.occupied_units), qualifying_units: num(form.qualifying_units), survey_completed_on: form.survey_completed_on || null,
        policies_published: form.policies_published, policies_reference: form.policies_reference || null,
        age_verification_procedures: form.age_verification_procedures, program_name: form.program_name || null,
        program_determination_ref: form.program_determination_ref || null, sworn_certification_on_file: form.sworn_certification_on_file,
        certifying_representative: form.certifying_representative || null, certification_date: form.certification_date || null,
        state: form.state || null, state_law_reviewed: form.state_law_reviewed,
      })
      if (!r.success) { toast.error(r.error); return }
      if (r.status === "verified") toast.success(`Recorded — verified until ${r.expiresOn ?? "re-verification"}.`)
      else toast.warning(`Recorded, but ${r.unmet.length} condition${r.unmet.length === 1 ? " is" : "s are"} not met — the claim stays held: ${r.unmet.map((u) => u.id).join(", ")}.`)
      setForm(EMPTY)
      load()
    })
  }

  const remove = (id: string | null) => {
    if (!id) return
    startTransition(async () => {
      const r = await removeOlderPersonsVerificationAction(id)
      if (!r.success) toast.error(r.error)
      else { toast.success("Removed — claims naming that community are held again."); load() }
    })
  }

  const canAttest = data?.canAttest === true
  const is55 = form.basis === "55_plus", is62 = form.basis === "62_plus", isProgram = form.basis === "federal_state_program"

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Housing for older persons (55+ / 62+)</CardTitle>
        <CardDescription>
          A &ldquo;55+&rdquo; or &ldquo;senior living&rdquo; claim in public copy, a video or a podcast passes only for a community recorded here as meeting the
          exemption&rsquo;s conditions, and only while the occupancy survey is current (refreshed at least every two years). Nothing is assumed:
          until a community is verified, the AI rewrites around the claim and a person decides. Authority: 42 U.S.C. § 3607(b); 24 CFR 100.300&ndash;100.308.
          Your state&rsquo;s own senior-housing rules may add conditions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        {data && data.records.length === 0 && <p className="text-sm text-muted-foreground">No community recorded. Every age-qualified claim is held for review.</p>}
        {data?.records.map((r) => (
          <div key={r.id ?? r.community_name} className="rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium">{r.community_name} <span className="text-muted-foreground">· {BASIS_LABELS[r.basis]}</span></div>
              <div className="flex items-center gap-2">
                <Badge variant={r.status === "verified" ? "default" : "destructive"}>{r.status === "verified" ? `Verified until ${r.expiresOn ?? "—"}` : "Conditions not met"}</Badge>
                {canAttest && <Button size="icon" variant="ghost" aria-label={`Remove ${r.community_name}`} disabled={pending} onClick={() => remove(r.id)}><Trash2 className="h-4 w-4" /></Button>}
              </div>
            </div>
            {r.unmet.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                {r.unmet.map((u) => <li key={u.id}><span className="font-medium">{u.id.replace(/_/g, " ")}</span> — {u.detail} <span className="opacity-70">({u.authority})</span></li>)}
              </ul>
            )}
          </div>
        ))}

        {data && !canAttest && <p className="text-sm text-muted-foreground">Only a broker, an admin or a compliance officer can attest an exemption.</p>}
        {canAttest && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Label htmlFor="op-name">Community name (as it appears in your copy)</Label><Input id="op-name" value={form.community_name} onChange={(e) => set("community_name", e.target.value)} /></div>
            <div><Label>Basis</Label>
              <Select value={form.basis} onValueChange={(v) => set("basis", v as Basis)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(BASIS_LABELS) as Basis[]).map((b) => <SelectItem key={b} value={b}>{BASIS_LABELS[b]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label htmlFor="op-rules">Governing rules (CC&amp;Rs, HOA / condo declaration)</Label><Input id="op-rules" value={form.governing_rules} onChange={(e) => set("governing_rules", e.target.value)} /></div>
            {(is55 || is62) && <>
              <div><Label htmlFor="op-occ">Occupied units</Label><Input id="op-occ" inputMode="numeric" value={form.occupied_units} onChange={(e) => set("occupied_units", e.target.value)} /></div>
              <div><Label htmlFor="op-q">{is55 ? "Occupied units with a 55+ occupant" : "Occupied units solely occupied by persons 62+"}</Label><Input id="op-q" inputMode="numeric" value={form.qualifying_units} onChange={(e) => set("qualifying_units", e.target.value)} /></div>
              <div><Label htmlFor="op-policy">Published policy (title / URL / recorded restriction)</Label><Input id="op-policy" value={form.policies_reference} onChange={(e) => set("policies_reference", e.target.value)} /></div>
              <div className="flex items-end gap-2"><Switch checked={form.policies_published} onCheckedChange={(v) => set("policies_published", v)} id="op-pub" /><Label htmlFor="op-pub">Policies are published and followed</Label></div>
            </>}
            {isProgram && <>
              <div><Label htmlFor="op-prog">Programme</Label><Input id="op-prog" value={form.program_name} onChange={(e) => set("program_name", e.target.value)} /></div>
              <div><Label htmlFor="op-det">Determination reference</Label><Input id="op-det" value={form.program_determination_ref} onChange={(e) => set("program_determination_ref", e.target.value)} /></div>
            </>}
            <div><Label htmlFor="op-survey">Occupancy survey completed on</Label><Input id="op-survey" type="date" value={form.survey_completed_on} onChange={(e) => set("survey_completed_on", e.target.value)} /></div>
            <div className="flex items-end gap-2"><Switch checked={form.age_verification_procedures} onCheckedChange={(v) => set("age_verification_procedures", v)} id="op-ver" /><Label htmlFor="op-ver">Routine age-verification procedures exist</Label></div>
            <div><Label htmlFor="op-rep">Certified by (authorised representative)</Label><Input id="op-rep" value={form.certifying_representative} onChange={(e) => set("certifying_representative", e.target.value)} /></div>
            <div><Label htmlFor="op-certdate">Sworn certification date</Label><Input id="op-certdate" type="date" value={form.certification_date} onChange={(e) => set("certification_date", e.target.value)} /></div>
            <div className="flex items-end gap-2"><Switch checked={form.sworn_certification_on_file} onCheckedChange={(v) => set("sworn_certification_on_file", v)} id="op-cert" /><Label htmlFor="op-cert">The sworn certification is on file</Label></div>
            <div><Label htmlFor="op-state">State (2 letters)</Label><Input id="op-state" maxLength={2} value={form.state} onChange={(e) => set("state", e.target.value.toUpperCase())} /></div>
            <div className="flex items-end gap-2 sm:col-span-2"><Switch checked={form.state_law_reviewed} onCheckedChange={(v) => set("state_law_reviewed", v)} id="op-st" /><Label htmlFor="op-st">I reviewed this state&rsquo;s own senior-housing rules for this community</Label></div>
            <div className="sm:col-span-2"><Button onClick={submit} disabled={pending || form.community_name.trim().length < 3}>Record verification</Button></div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
