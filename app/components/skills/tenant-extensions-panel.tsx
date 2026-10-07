"use client"

/**
 * app/components/skills/tenant-extensions-panel.tsx — TENANT EXTENSION CONTROL (wave 137, lane 137D).
 *
 * Read-mostly: every extension visible to this brokerage, whether it runs HERE, and who controls it. A tenant
 * admin may enable / disable an ENABLED global extension for this brokerage (versioned tenant policy
 * `extensions`); platform-only kinds stay platform-controlled; the brokerage's own extensions move through their
 * own lifecycle in the skill panel above. An enabled custom manager can be asked for one allowed capability.
 * Mounted from Settings → Assistant. Every door re-gates server-side (app/actions/skill-marketplace.ts) — this
 * panel is a convenience, not the boundary. No marketplace browsing here.
 */
import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { getTenantExtensions, setTenantExtension, runCustomManagerForTenant } from "@/app/actions/skill-marketplace"
import type { TenantExtensionView } from "@/lib/kernel/skill-marketplace"
import type { CustomManagerDeclaration } from "@/lib/kernel/skill-registry"

function CustomManagerRun({ name, decl, busy, onRun }: { name: string; decl: CustomManagerDeclaration; busy: boolean; onRun: (capability: string, objective: string, inputs: string) => void }) {
  const [capability, setCapability] = useState<string>(decl.allowed_capabilities?.[0] ?? "")
  const [objective, setObjective] = useState("")
  const [inputs, setInputs] = useState("{}")
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={`Capability for ${name}`} className="rounded border px-2 py-1 text-xs" value={capability} onChange={(e) => setCapability(e.target.value)}>
        {(decl.allowed_capabilities ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <Input className="h-8 w-56 text-xs" placeholder="Objective" value={objective} onChange={(e) => setObjective(e.target.value)} />
      <Input className="h-8 w-56 font-mono text-xs" placeholder='Inputs JSON' value={inputs} onChange={(e) => setInputs(e.target.value)} />
      <Button size="sm" variant="outline" disabled={busy || !capability || !objective} onClick={() => onRun(capability, objective, inputs)}>Ask</Button>
    </div>
  )
}

export function TenantExtensionsPanel() {
  const [rows, setRows] = useState<TenantExtensionView[]>([])
  const [canManage, setCanManage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, start] = useTransition()

  const load = useCallback(() => {
    start(async () => {
      const r = await getTenantExtensions()
      setRows(r.extensions); setCanManage(r.canManage); setError(r.ok ? null : r.error ?? "Could not read this brokerage's extensions.")
    })
  }, [])
  useEffect(() => { load() }, [load])

  const toggle = (id: string, enable: boolean) => start(async () => {
    const r = await setTenantExtension(id, enable)
    if (r.ok) toast.success(enable ? "Enabled for this brokerage" : "Disabled for this brokerage"); else toast.error(r.reason)
    load()
  })

  const run = (name: string) => (capability: string, objective: string, inputsJson: string) => start(async () => {
    let inputs: Record<string, unknown>
    try { inputs = JSON.parse(inputsJson) } catch { toast.error("Inputs are not valid JSON."); return }
    const r = await runCustomManagerForTenant(name, capability, inputs, objective)
    if (r.ok) toast.success(`${r.manager} asked for ${capability}`); else toast.error(r.reason)
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Extensions for this brokerage</CardTitle>
        <CardDescription>
          Approved skills and custom managers, and whether each runs here. Suspended or disabled extensions never run. Every run
          still passes your plan, your managers&apos; authority, the usage meter and the action ledger.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {error && <p className="text-destructive">{error}</p>}
        {rows.length === 0 ? <p className="text-muted-foreground">No extensions are available to this brokerage yet.</p> : rows.map((x) => (
          <div key={x.listing.id} className="flex flex-col gap-1 rounded border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{x.listing.skill_id} v{x.listing.version}</span>
              <Badge variant="outline">{x.listing.extension_kind}</Badge>
              <Badge variant="outline">{x.listing.publisher}{x.listing.publisher_name ? ` · ${x.listing.publisher_name}` : ""}</Badge>
              <Badge variant={x.executable ? "default" : "secondary"}>{x.executable ? "runs here" : x.listing.status === "enabled" ? "not enabled here" : x.listing.status}</Badge>
              {x.control === "platform" && <span className="text-xs text-muted-foreground">platform-controlled</span>}
              {x.control === "own_lifecycle" && <span className="text-xs text-muted-foreground">your brokerage&apos;s own — managed in the skill panel</span>}
            </div>
            {canManage && x.control === "tenant" && (
              <div>
                {x.tenantEnabled
                  ? <Button size="sm" variant="destructive" disabled={busy} onClick={() => toggle(x.listing.id, false)}>Disable here</Button>
                  : <Button size="sm" disabled={busy || x.listing.status !== "enabled"} onClick={() => toggle(x.listing.id, true)}>Enable here</Button>}
              </div>
            )}
            {canManage && x.executable && x.listing.extension_kind === "custom_manager" && (
              <CustomManagerRun name={x.listing.skill_id} decl={x.listing.declaration as CustomManagerDeclaration} busy={busy} onRun={run(x.listing.skill_id)} />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
