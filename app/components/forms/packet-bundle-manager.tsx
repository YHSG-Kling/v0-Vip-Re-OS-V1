"use client"

/**
 * app/components/forms/packet-bundle-manager.tsx — THE PACKET BUNDLE MANAGER (wave 156, lane 156C round 2).
 *
 * Create a bundle per STATE for the brokerage, one office or one team (the owners this seat MANAGES — the server's
 * mayManagePacketOwner, read back as `owners`); add items (a library form of the same state, or a named requirement), mark them
 * required or optional and say where the requirement comes from (brokerage / office / team / state policy / county policy); move
 * them up and down; remove what may be removed. Each item shows its status (ready / retired / license expired / not configured) and,
 * when not usable, the place to fix it. A state- or county-policy item cannot be removed here — the server refuses it by name and
 * this screen shows that sentence. Mounted on the admin transaction-forms page and inside "Add a form or packet" (so a solo agent,
 * who is their own principal, and a team lead reach it too).
 */

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { RefusalNotice, refusalOf } from "./refusal-notice"
import type { ManageView } from "./add-form-or-packet"

interface Item { id: string; position: number; required_name: string; is_required: boolean; requirement_source: string; county: string | null; status: string; recoverHref: string | null; library_form_id: string | null }
interface Bundle { id: string; name: string; state: string; bundle_kind: string; team_id: string | null; location_id: string | null; items: Item[] }

const sel = "h-8 rounded-md border bg-background px-2 text-xs"

export function PacketBundleManager({ initial, onChanged }: { initial?: ManageView | null; onChanged?: () => void }) {
  const [view, setView] = useState<ManageView | null>(initial ?? null)
  const [msg, setMsg] = useState<{ message: string | null; href: string | null }>({ message: null, href: null })
  const reload = useCallback(async () => {
    const r = await fetch("/api/forms/directory?view=manage")
    const j = await r.json()
    if (!r.ok) { setMsg(refusalOf(j)); return }
    setView(j); onChanged?.()
  }, [onChanged])
  useEffect(() => { if (!view) void reload() }, [view, reload])
  useEffect(() => { if (initial) setView(initial) }, [initial])
  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/forms/directory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok || j.ok === false) { setMsg(refusalOf(j)); return false }
    setMsg({ message: null, href: null }); await reload(); return true
  }
  if (!view) return <RefusalNotice message={msg.message} href={msg.href} />
  const o = view.owners
  if (!o.brokerage && o.offices.length === 0 && o.teams.length === 0) return null
  const bundles = view.bundles as Bundle[]
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="text-sm font-medium">Packet bundles</p>
      <NewBundle view={view} onCreate={post} />
      {bundles.length === 0 && <p className="text-xs text-muted-foreground">No bundles yet.</p>}
      {bundles.map((b) => <BundleCard key={b.id} b={b} view={view} post={post} />)}
      <RefusalNotice message={msg.message} href={msg.href} />
    </div>
  )
}

function NewBundle({ view, onCreate }: { view: ManageView; onCreate: (b: Record<string, unknown>) => Promise<boolean> }) {
  const o = view.owners
  const [f, setF] = useState({ kind: "listing", name: "", state: "", owner: o.brokerage ? "brokerage" : o.offices[0] ? `office:${o.offices[0].id}` : `team:${o.teams[0]?.id ?? ""}` })
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <select className={sel} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{view.vocab.bundleKinds.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}</select>
      <Input className="h-8 text-xs w-48" placeholder="Bundle name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <Input className="h-8 text-xs w-16" placeholder="TX" maxLength={2} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase() })} />
      <select className={sel} value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>
        {o.brokerage && <option value="brokerage">whole brokerage</option>}
        {o.offices.map((x) => <option key={x.id} value={`office:${x.id}`}>office: {x.name}</option>)}
        {o.teams.map((x) => <option key={x.id} value={`team:${x.id}`}>team: {x.name}</option>)}
      </select>
      <Button type="button" size="sm" variant="outline" onClick={() => void onCreate({ action: "create_bundle", kind: f.kind, name: f.name, state: f.state, team_id: f.owner.startsWith("team:") ? f.owner.slice(5) : null, location_id: f.owner.startsWith("office:") ? f.owner.slice(7) : null })}>Create bundle</Button>
    </div>
  )
}

function BundleCard({ b, view, post }: { b: Bundle; view: ManageView; post: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [it, setIt] = useState({ library_form_id: "", required_name: "", is_required: true, requirement_source: b.team_id ? "team" : b.location_id ? "office" : "brokerage", county: "" })
  const forms = view.library.filter((r) => (r.state ?? "").toUpperCase() === b.state)
  const ids = b.items.map((i) => i.id)
  const move = (i: number, d: -1 | 1) => { const n = [...ids]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; void post({ action: "reorder_bundle", bundle_id: b.id, ordered_ids: n }) }
  return (
    <div className="rounded border p-2 space-y-1">
      <p className="text-xs font-medium">{b.name} · {b.state} · {b.bundle_kind.replace(/_/g, " ")}</p>
      <ol className="space-y-1">
        {b.items.map((i, idx) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-4 text-muted-foreground">{idx + 1}.</span>
            <span className="truncate max-w-[14rem]">{i.required_name}</span>
            <Badge variant={i.is_required ? "default" : "outline"} className="text-[10px]">{i.is_required ? "required" : "optional"}</Badge>
            <Badge variant="outline" className="text-[10px]">{i.requirement_source.replace(/_/g, " ")}{i.county ? ` · ${i.county}` : ""}</Badge>
            <Badge variant={i.status === "ready" ? "secondary" : "destructive"} className="text-[10px]">{i.status.replace(/_/g, " ")}</Badge>
            {i.recoverHref && <a className="underline text-muted-foreground" href={i.recoverHref}>Request access / add licensed file</a>}
            <button type="button" className="underline" onClick={() => move(idx, -1)}>up</button>
            <button type="button" className="underline" onClick={() => move(idx, 1)}>down</button>
            <button type="button" className="underline" onClick={() => void post({ action: "remove_bundle_item", item_id: i.id })}>remove</button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 items-center">
        <select className={sel} value={it.library_form_id} onChange={(e) => { const r = forms.find((x) => x.packetId === e.target.value); setIt({ ...it, library_form_id: e.target.value, required_name: r?.name ?? it.required_name }) }}>
          <option value="">— a named requirement (no form yet) —</option>
          {forms.map((r) => <option key={r.packetId} value={r.packetId}>{r.name}</option>)}
        </select>
        <Input className="h-8 text-xs w-48" placeholder="Item name" value={it.required_name} onChange={(e) => setIt({ ...it, required_name: e.target.value })} />
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={it.is_required} onChange={(e) => setIt({ ...it, is_required: e.target.checked })} />required</label>
        <select className={sel} value={it.requirement_source} onChange={(e) => setIt({ ...it, requirement_source: e.target.value })}>{view.vocab.requirementSources.filter((s) => s !== "user_supplemental").map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select>
        {it.requirement_source === "county_policy" && <Input className="h-8 text-xs w-32" placeholder="County" value={it.county} onChange={(e) => setIt({ ...it, county: e.target.value })} />}
        <Button type="button" size="sm" variant="outline" onClick={() => void post({ action: "add_bundle_item", bundle_id: b.id, library_form_id: it.library_form_id || null, required_name: it.required_name, is_required: it.is_required, requirement_source: it.requirement_source, county: it.county || null })}>Add item</Button>
      </div>
    </div>
  )
}
