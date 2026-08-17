"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, Plus } from "lucide-react"
import { seedRequiredDocsForBrokerage } from "@/app/actions/compliance/seed-required-docs"
import { addRequiredDocument } from "@/app/actions/compliance/manage-required-docs"
import {
  ALL_DOCUMENT_CLASSIFICATIONS,
  DOCUMENT_CLASSIFICATION_LABEL,
  SELLER_SIDE_CLASSIFICATIONS,
} from "@/lib/compliance/document-classifications"

// THE PICKER READS THE ONE VOCABULARY. This was a hand-kept THIRD copy of the
// classification list — it had already drifted, missing listing_agreement,
// seller_broker_agreement and preliminary_closing_statement, so a broker could
// not require the document that starts a listing even after the CHECK admitted
// it. The union now lives in a client-safe module, so screen, resolver and
// database read one list.
const CLASSIFICATIONS = ALL_DOCUMENT_CLASSIFICATIONS.map((value) => ({
  value,
  label: DOCUMENT_CLASSIFICATION_LABEL[value],
  seller: SELLER_SIDE_CLASSIFICATIONS.includes(value),
}))

interface Props {
  brokerageId:     string
  teamId:          string | null
  userId:          string
  userType:        string
  supportedStates: string[]
}

export function RequiredDocsSettingsClient({ brokerageId, teamId, userId, userType, supportedStates }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [stateCode, setStateCode] = useState<string>("")
  const [scope, setScope] = useState<"brokerage" | "team" | "agent">("brokerage")
  // WHICH SIDE OF THE DEAL to seed. This was hardcoded "buyer", so the seller
  // stack — the listing agreement above all — was unreachable from the UI, and
  // seeding "seller" would previously have installed buyer paperwork anyway.
  const [seedDealType, setSeedDealType] = useState<"buyer" | "seller" | "dual">("buyer")
  const [result, setResult] = useState<string | null>(null)

  // ── Add-a-custom-rule form state ──
  const [addPending, startAdd] = useTransition()
  const [addClass, setAddClass] = useState<string>("pre_approval_letter")
  const [addDealType, setAddDealType] = useState<"buyer" | "seller" | "dual">("buyer")
  const [addState, setAddState] = useState<string>("")
  const [addScope, setAddScope] = useState<"brokerage" | "team" | "agent">("brokerage")
  const [addBlocking, setAddBlocking] = useState<boolean>(true)
  const [addDesc, setAddDesc] = useState<string>("")
  const [addResult, setAddResult] = useState<string | null>(null)

  // Scope choices depend on the user's role.
  const allowedScopes: ("brokerage" | "team" | "agent")[] = []
  // SCOPE LADDER (kept inline — each rung admits a different tier): 'superadmin'
  // removed from every rung — dead as users.user_type (0 live rows);
  // broker_owner added — storable seat that owns the brokerage.
  if (["broker","broker_owner","broker_admin","admin","compliance_manager","compliance_officer"].includes(userType)) allowedScopes.push("brokerage")
  if (teamId && ["team_lead","broker","broker_owner","broker_admin","admin","compliance_manager","compliance_officer"].includes(userType)) allowedScopes.push("team")
  if (["agent","team_lead","broker","broker_owner","broker_admin","admin","compliance_manager","compliance_officer"].includes(userType)) allowedScopes.push("agent")

  function seed() {
    setResult(null)
    startTransition(async () => {
      const scopeId = scope === "team" ? (teamId ?? "") : scope === "agent" ? userId : brokerageId
      if (scope === "team" && !teamId) {
        setResult("You aren't on a team — choose brokerage or agent scope.")
        return
      }
      const r = await seedRequiredDocsForBrokerage({
        brokerageId,
        scope,
        scopeId,
        stateCode: stateCode || null,
        actorUserId: userId,
        dealType: seedDealType,
      })
      if (r.success) {
        setResult(`Seeded ${r.inserted_count} new ${seedDealType} rule${r.inserted_count === 1 ? "" : "s"} (${r.skipped_count} already on file).`)
        router.refresh()
      } else {
        setResult(`Failed: ${r.error}`)
      }
    })
  }

  function addRule() {
    setAddResult(null)
    const scopeId = addScope === "team" ? (teamId ?? "") : addScope === "agent" ? userId : brokerageId
    if (addScope === "team" && !teamId) { setAddResult("You aren't on a team — choose brokerage or agent scope."); return }
    startAdd(async () => {
      const r = await addRequiredDocument({
        scope: addScope,
        scopeId,
        classification: addClass as any,
        dealType: addDealType,
        stateCode: addState || null,
        blockOnMissing: addBlocking,
        description: addDesc || null,
      })
      if (r.ok) {
        setAddResult(r.duplicate ? "That rule already exists at this scope." : "Added.")
        setAddDesc("")
        router.refresh()
      } else {
        setAddResult(`Failed: ${r.error}`)
      }
    })
  }

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader><CardTitle>Add a custom required document</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Require a document beyond the state preset. Blocking rules refuse "submit to compliance"
          until the document is on file; warning rules flag but pass through.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">Document</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={addClass} onChange={e => setAddClass(e.target.value)}>
              {CLASSIFICATIONS.map(c => (
                <option key={c.value} value={c.value}>{c.label}{c.seller ? " — seller side" : ""}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">Deal type</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={addDealType} onChange={e => setAddDealType(e.target.value as any)}>
              <option value="buyer">Buyer</option>
              <option value="seller">Seller</option>
              <option value="dual">Both (dual)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">Scope</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={addScope} onChange={e => setAddScope(e.target.value as any)}>
              {allowedScopes.includes("brokerage") && <option value="brokerage">Brokerage (everyone here)</option>}
              {allowedScopes.includes("team")      && <option value="team">My team only</option>}
              {allowedScopes.includes("agent")     && <option value="agent">Just me</option>}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">State (optional)</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={addState} onChange={e => setAddState(e.target.value)}>
              <option value="">Any state (US baseline)</option>
              {supportedStates.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm md:col-span-2">
            <span className="block text-xs font-medium mb-1">Description (optional)</span>
            <input className="w-full border rounded px-2 py-1.5 text-sm" value={addDesc} onChange={e => setAddDesc(e.target.value)} placeholder="Why this is required / where it comes from" />
          </label>
        </div>
        <div className="flex items-center gap-4">
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={addBlocking} onChange={e => setAddBlocking(e.target.checked)} />
            <span>Blocking (refuse submit if missing)</span>
          </label>
          <Button onClick={addRule} disabled={addPending} size="sm">
            {addPending ? <Loader2 className="h-3 w-3 mr-2 animate-spin" /> : <Plus className="h-3 w-3 mr-2" />}
            Add rule
          </Button>
        </div>
        {addResult && <p className="text-xs text-muted-foreground">{addResult}</p>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Seed defaults from a per-state preset</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Loads the baseline for the side of the deal you pick, plus the state-specific stack
          (TX, CA, FL, NY, IL, GA, AZ, CO, WA, NC). Existing rules at the same scope are
          skipped — your customizations are preserved.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">Deal side</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={seedDealType} onChange={e => setSeedDealType(e.target.value as any)}>
              <option value="buyer">Buyer side (contract, pre-approval, buyer-broker agreement)</option>
              <option value="seller">Seller side (listing agreement, disclosures, title)</option>
              <option value="dual">Both sides (dual)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">Scope</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={scope} onChange={e => setScope(e.target.value as any)}>
              {allowedScopes.includes("brokerage") && <option value="brokerage">Brokerage (everyone here)</option>}
              {allowedScopes.includes("team")      && <option value="team">My team only</option>}
              {allowedScopes.includes("agent")     && <option value="agent">Just me</option>}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">State (optional)</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={stateCode} onChange={e => setStateCode(e.target.value)}>
              <option value="">US baseline (no state additions)</option>
              {supportedStates.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <Button onClick={seed} disabled={pending} className="w-full">
              {pending ? <Loader2 className="h-3 w-3 mr-2 animate-spin" /> : null}
              Seed defaults
            </Button>
          </div>
        </div>
        {result && <p className="text-xs text-muted-foreground">{result}</p>}
      </CardContent>
    </Card>
    </div>
  )
}
