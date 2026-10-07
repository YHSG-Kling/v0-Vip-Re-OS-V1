"use client"

/**
 * app/components/skills/skill-marketplace-panel.tsx — the skill registry + marketplace surface (wave 108, lane 108A).
 *
 * mode "tenant"   (Settings → Assistant): every built-in manager skill with its declaration, the tenant's own
 *                 skills (submit a DATA declaration → evaluated at once → approve → publish → revoke) and the
 *                 published third-party skills; a tenant admin may ask a manager to run a runnable skill.
 * mode "platform" (Superadmin → Skill marketplace): the third-party / platform approval queue + intake.
 * Every door is a gated server action in app/actions/skill-marketplace.ts — this panel is a convenience, not
 * the boundary.
 */
import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import {
  getSkillRegistry, submitTenantSkill, decideTenantSkill, runSkillForTenant,
  getPlatformSkillQueue, submitThirdPartySkill, decidePlatformSkill,
} from "@/app/actions/skill-marketplace"
import type { SkillDeclaration } from "@/lib/kernel/skill-registry"
import type { SkillListingRow, SkillDecision } from "@/lib/kernel/skill-marketplace"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

const TEMPLATE: SkillDeclaration = {
  name: "my_skill_name", version: 1, manager_owner: "campaign_orchestrator",
  purpose: "What this skill does for the brokerage.",
  inputs: { fields: [{ name: "campaignId", type: "uuid", required: true }] },
  outputs: { fields: [
    { name: "status", type: "string", required: true, description: "executed | refused" },
    { name: "delegation_ids", type: "array", required: true, description: "one manager_delegations row per required capability" },
    { name: "ledger_entry", type: "string", required: false, description: "agent_action_ledger subject ref skill:<name>@v<version>" },
  ] },
  required_capabilities: ["newsletter_send"], risk_class: "COMMUNICATION", authority_requirement: 3,
  cost_estimate: { usd: 0, tokens: 0, budget: "vendor_spend", basis: "declared" },
  tenant_entitlement: "app.access", evaluation_suite: "skill_eval:contract_v1",
  evaluation_fixtures: [{ campaignId: "00000000-0000-4000-8000-000000000000" }],
}

function nextDecisions(l: SkillListingRow): SkillDecision[] {
  if (l.status === "evaluated") return ["approve"]
  if (l.status === "approved") return ["publish", "revoke"]
  if (l.status === "published") return ["revoke"]
  return []
}

function ListingRow({ l, onDecide, busy }: { l: SkillListingRow; onDecide?: (id: string, d: SkillDecision) => void; busy: boolean }) {
  const failed = l.evaluation_evidence?.checks.filter((c) => !c.ok) ?? []
  return (
    <div className="flex flex-col gap-1 rounded border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{l.skill_id} v{l.version}</span>
        <Badge variant="outline">{l.publisher}{l.publisher_name ? ` · ${l.publisher_name}` : ""}</Badge>
        <Badge variant={l.status === "published" ? "default" : "secondary"}>{l.status}</Badge>
        <span className="text-muted-foreground">{l.declaration.manager_owner} · {l.declaration.risk_class} · rung {l.declaration.authority_requirement}</span>
      </div>
      <p className="text-muted-foreground">{l.declaration.purpose}</p>
      {failed.length > 0 && <p className="text-destructive">Evaluation failed: {failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}</p>}
      {l.revoked_reason && <p className="text-muted-foreground">Revoked: {l.revoked_reason}</p>}
      {onDecide && nextDecisions(l).length > 0 && (
        <div className="flex gap-2">
          {nextDecisions(l).map((d) => <Button key={d} size="sm" variant={d === "revoke" ? "destructive" : "default"} disabled={busy} onClick={() => onDecide(l.id, d)}>{d}</Button>)}
        </div>
      )}
    </div>
  )
}

export function SkillMarketplacePanel({ mode }: { mode: "tenant" | "platform" }) {
  const [builtin, setBuiltin] = useState<readonly SkillDeclaration[]>([])
  const [listings, setListings] = useState<SkillListingRow[]>([])
  const [canManage, setCanManage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(JSON.stringify(TEMPLATE, null, 2))
  const [publisherName, setPublisherName] = useState("")
  const [run, setRun] = useState({ skill: "", manager: "ai_isa", inputs: "{}", objective: "" })
  const [busy, start] = useTransition()

  const load = useCallback(() => {
    start(async () => {
      if (mode === "platform") {
        const q = await getPlatformSkillQueue()
        setListings(q.listings); setError(q.ok ? null : q.error ?? "Could not read the queue."); setCanManage(q.ok)
      } else {
        const r = await getSkillRegistry()
        setBuiltin(r.builtin); setListings(r.listings); setCanManage(r.canManage); setError(r.ok ? null : r.error ?? "Could not read the registry.")
      }
    })
  }, [mode])
  useEffect(() => { load() }, [load])

  const submit = () => start(async () => {
    let decl: SkillDeclaration
    try { decl = JSON.parse(draft) } catch { toast.error("The declaration is not valid JSON."); return }
    const r = mode === "platform" ? await submitThirdPartySkill(decl, publisherName) : await submitTenantSkill(decl)
    if (r.ok) toast.success(`Submitted — ${r.listing.status}`)
    else toast.error(`${r.reason}${r.errors ? `: ${r.errors.join(", ")}` : ""}`)
    load()
  })

  const decide = (id: string, d: SkillDecision) => start(async () => {
    const reason = d === "revoke" ? window.prompt("Why is this skill being revoked?") ?? "" : undefined
    const r = mode === "platform" ? await decidePlatformSkill(id, d, reason) : await decideTenantSkill(id, d, reason)
    if (r.ok) toast.success(`${d}: ${r.listing.status}`); else toast.error(r.reason)
    load()
  })

  const runIt = () => start(async () => {
    let inputs: Record<string, unknown>
    try { inputs = JSON.parse(run.inputs) } catch { toast.error("Inputs are not valid JSON."); return }
    const r = await runSkillForTenant(run.skill, run.manager as ManagerKey, inputs, run.objective)
    if (r.ok) toast.success(`Ran ${r.skill}: ${r.delegationIds.length} delegation(s) opened`); else toast.error(r.reason)
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mode === "platform" ? "Skill marketplace — approval queue" : "Manager skills & marketplace"}</CardTitle>
        <CardDescription>
          Skills are declarations, never code: each composes capabilities its manager owns and runs only through the kernel
          (entitlement, authority, metering, audit). A marketplace skill must pass its evaluation suite before it can be approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {mode === "tenant" && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Built-in manager skills ({builtin.length})</h3>
            {builtin.length === 0 ? <p className="text-sm text-muted-foreground">No built-in skills loaded yet.</p> : (
              <div className="grid gap-1 text-xs">
                {builtin.map((s) => (
                  <div key={s.name} className="flex flex-wrap gap-2 rounded border px-2 py-1">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-muted-foreground">{s.manager_owner} · {s.risk_class} · rung {s.authority_requirement} · {s.tenant_entitlement} · {s.evaluation_suite}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{mode === "platform" ? "Third-party & platform listings" : "Marketplace & your brokerage's skills"}</h3>
          {listings.length === 0 ? <p className="text-sm text-muted-foreground">No marketplace skills yet.</p> :
            listings.map((l) => <ListingRow key={l.id} l={l} busy={busy} onDecide={canManage && (mode === "platform" || l.publisher === "tenant") ? decide : undefined} />)}
        </section>
        {canManage && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{mode === "platform" ? "Take in a third-party skill" : "Author a skill for your brokerage"}</h3>
            {mode === "platform" && <Input placeholder="Publisher name" value={publisherName} onChange={(e) => setPublisherName(e.target.value)} />}
            <Textarea rows={12} className="font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <Button disabled={busy} onClick={submit}>Submit for evaluation</Button>
          </section>
        )}
        {mode === "tenant" && canManage && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Ask a manager to run a skill</h3>
            <Input placeholder="Skill name" value={run.skill} onChange={(e) => setRun({ ...run, skill: e.target.value })} />
            <Input placeholder="Requesting manager (e.g. ai_isa)" value={run.manager} onChange={(e) => setRun({ ...run, manager: e.target.value })} />
            <Input placeholder="Objective" value={run.objective} onChange={(e) => setRun({ ...run, objective: e.target.value })} />
            <Textarea rows={3} className="font-mono text-xs" value={run.inputs} onChange={(e) => setRun({ ...run, inputs: e.target.value })} />
            <Button disabled={busy || !run.skill || !run.objective} onClick={runIt}>Run through the kernel</Button>
          </section>
        )}
      </CardContent>
    </Card>
  )
}
