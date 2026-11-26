"use client"

/**
 * app/components/forms/add-form-or-packet.tsx — "ADD A FORM OR PACKET" (wave 156, lane 156C round 2).
 *
 * Owner (wave 156): the form packet tool must list every available packet "or have the capability for the user or manager to add
 * more". This is that capability on a screen, over the ONE door (app/api/forms/directory → lib/forms/form-directory-intake.ts):
 *   · upload a PDF with its provenance (rights basis, license, purpose, effective / revision date, checklist mapping, signer roles);
 *   · pick a form from the STATE's package (it reads "not configured" until a licensed file or provider form is linked);
 *   · link a form from the connected provider's library by id (a reference — no provider bytes are copied).
 * WHO MAY ADD FOR WHOM is the server's rule (mayManagePacketOwner), read back as `owners`: the oversight class (a solo-tier principal
 * included) sees the brokerage and its offices, a team lead sees their team, every seat sees "for myself" (supplemental custom /
 * disclosure only). On each registered form the seat MANAGES: add a revision (the old one is retired, never offered again) or retire.
 * Every refusal is the server's sentence, with its recovery link when it has one.
 */

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { RefusalNotice, refusalOf } from "./refusal-notice"
import { PacketBundleManager } from "./packet-bundle-manager"

interface Owners { brokerage: boolean; offices: Array<{ id: string; name: string }>; teams: Array<{ id: string; name: string }>; self: true }
interface LibRow { packetId: string; name: string; scope: string; state: string | null; status: string; canManage: boolean; version: number | null; providerFormId: string | null }
export interface ManageView {
  owners: Owners
  library: LibRow[]
  bundles: unknown[]
  /** sourceKinds = lib/forms/form-directory-intake.ts FORM_LIBRARY_SOURCE_KINDS; addModes = the add doors derived FROM it (addModesOffered). */
  vocab: { sourceKinds: string[]; addModes: Array<"upload" | "state_preconfigured" | "provider_form">; rightsBases: string[]; purposes: string[]; signerRoles: string[]; packetTypes: string[]; bundleKinds: string[]; requirementSources: string[] }
}

const sel = "h-8 rounded-md border bg-background px-2 text-xs"
/** The words for each add door; WHICH doors are offered comes from the server's source-kind vocabulary (view.vocab.addModes). */
const MODE_LABEL: Record<"upload" | "state_preconfigured" | "provider_form", string> = { upload: "upload a PDF", state_preconfigured: "pick from the state package", provider_form: "link a provider form by id" }

export function AddFormOrPacket({ defaultState, onAdded }: { defaultState?: string | null; onAdded?: () => void }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<ManageView | null>(null)
  const [loadErr, setLoadErr] = useState<{ message: string | null; href: string | null }>({ message: null, href: null })
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/forms/directory?view=manage")
      const j = await r.json()
      if (!r.ok) { setLoadErr(refusalOf(j)); return }
      const { owners, library, bundles, vocab } = j as ManageView
      setView({ owners, library, bundles, vocab }); setLoadErr({ message: null, href: null })
    } catch (e) { setLoadErr({ message: e instanceof Error ? e.message : "Network error", href: null }) }
  }, [])
  useEffect(() => { if (open && !view) void reload() }, [open, view, reload])
  // Opened from the FormWizard ("Add a form or packet" → /dashboard/forms?add=1&state=TX#add-forms): open with the deal's state.
  const [urlState, setUrlState] = useState<string | null>(null)
  useEffect(() => {
    try { const q = new URLSearchParams(window.location.search); if (q.get("add") === "1") { setOpen(true); setUrlState(q.get("state")) } } catch { /* no window — nothing to read */ }
  }, [])
  const initialState = defaultState ?? urlState

  if (!open) return <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>Add a form or packet</Button>
  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Add a form or packet</p>
        <button type="button" className="text-xs underline" onClick={() => setOpen(false)}>Close</button>
      </div>
      <RefusalNotice message={loadErr.message} href={loadErr.href} />
      {view && <AddForm key={initialState ?? ""} view={view} defaultState={initialState ?? null} onDone={() => { void reload(); onAdded?.() }} />}
      {view && view.library.some((r) => r.canManage) && <LibraryActions rows={view.library.filter((r) => r.canManage)} onDone={() => { void reload(); onAdded?.() }} />}
      {view && (view.owners.brokerage || view.owners.offices.length > 0 || view.owners.teams.length > 0) && <PacketBundleManager initial={view} onChanged={reload} />}
    </div>
  )
}

function AddForm({ view, defaultState, onDone }: { view: ManageView; defaultState: string | null; onDone: () => void }) {
  const o = view.owners
  const managesShared = o.brokerage || o.offices.length > 0 || o.teams.length > 0
  const [owner, setOwner] = useState<string>(managesShared ? (o.brokerage ? "brokerage" : o.offices[0] ? `office:${o.offices[0].id}` : `team:${o.teams[0].id}`) : "self")
  const [mode, setMode] = useState<"upload" | "state_preconfigured" | "provider_form">("upload")
  const [f, setF] = useState({ name: "", state: (defaultState ?? "").toUpperCase(), packet_type: managesShared ? "listing" : "custom", purpose: "listing", rights_basis: "own_form", license_note: "", effective_on: "", revision_date: "", checklist_keys: "", county: "", provider_form_id: "" })
  const [roles, setRoles] = useState<string[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<{ message: string | null; href: string | null; ok?: string }>({ message: null, href: null })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const forMyself = owner === "self"
  const packetTypes = forMyself ? ["custom", "disclosure"] : view.vocab.packetTypes

  async function submit() {
    setBusy(true); setOut({ message: null, href: null })
    const meta: Record<string, unknown> = {
      action: "add_form", mode, name: f.name, state: f.state, packet_type: f.packet_type, purpose: f.purpose, rights_basis: f.rights_basis,
      license_note: f.license_note || null, effective_on: f.effective_on, revision_date: f.revision_date || null, county: f.county || null,
      checklist_keys: f.checklist_keys.split(",").map((s) => s.trim()).filter(Boolean), signer_roles: roles, provider_form_id: f.provider_form_id || null,
      for_myself: forMyself, team_id: owner.startsWith("team:") ? owner.slice(5) : null, location_id: owner.startsWith("office:") ? owner.slice(7) : null,
    }
    try {
      let r: Response
      if (mode === "upload") {
        if (!file) { setOut({ message: "Attach the form's PDF.", href: null }); return }
        const fd = new FormData(); fd.set("meta", JSON.stringify(meta)); fd.set("file", file)
        r = await fetch("/api/forms/directory", { method: "POST", body: fd })
      } else {
        r = await fetch("/api/forms/directory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(meta) })
      }
      const j = await r.json()
      if (!r.ok || j.ok === false) { setOut({ message: j.refusal?.message ?? refusalOf(j).message, href: j.refusal?.recoverHref ?? null }); return }
      setOut({ message: null, href: null, ok: j.status === "not_configured" ? "Added — it reads NOT CONFIGURED until a licensed file is uploaded or a provider form is linked." : j.existing ? "Already in your library." : "Added to your library." })
      onDone()
    } catch (e) { setOut({ message: e instanceof Error ? e.message : "Network error", href: null }) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-xs">For
          <select className={`${sel} ml-1`} value={owner} onChange={(e) => { setOwner(e.target.value); if (e.target.value === "self") setF((p) => ({ ...p, packet_type: "custom" })) }}>
            {o.brokerage && <option value="brokerage">the whole brokerage</option>}
            {o.offices.map((x) => <option key={x.id} value={`office:${x.id}`}>office: {x.name}</option>)}
            {o.teams.map((x) => <option key={x.id} value={`team:${x.id}`}>team: {x.name}</option>)}
            <option value="self">myself (supplemental)</option>
          </select>
        </label>
        <label className="text-xs">How
          <select className={`${sel} ml-1`} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {view.vocab.addModes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder={mode === "state_preconfigured" ? "Form name exactly as the state package names it" : "Form name"} value={f.name} onChange={set("name")} className="h-8 text-xs" />
        <Input placeholder="State (TX)" maxLength={2} value={f.state} onChange={set("state")} className="h-8 text-xs" />
        <select className={sel} value={f.packet_type} onChange={set("packet_type")}>{packetTypes.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        <select className={sel} value={f.purpose} onChange={set("purpose")}>{view.vocab.purposes.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select>
        <select className={sel} value={f.rights_basis} onChange={set("rights_basis")}>{view.vocab.rightsBases.map((t) => <option key={t} value={t}>right: {t.replace(/_/g, " ")}</option>)}</select>
        <Input placeholder="License held under (membership / agreement)" value={f.license_note} onChange={set("license_note")} className="h-8 text-xs" />
        <label className="text-[11px] text-muted-foreground">Effective <Input type="date" value={f.effective_on} onChange={set("effective_on")} className="h-8 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground">Revised <Input type="date" value={f.revision_date} onChange={set("revision_date")} className="h-8 text-xs" /></label>
        <Input placeholder="Checklist items (comma separated, e.g. listing.agreement)" value={f.checklist_keys} onChange={set("checklist_keys")} className="h-8 text-xs" />
        <Input placeholder="County (optional)" value={f.county} onChange={set("county")} className="h-8 text-xs" />
        {mode === "provider_form" && <Input placeholder="Provider form id" value={f.provider_form_id} onChange={set("provider_form_id")} className="h-8 text-xs" />}
        {mode === "upload" && <input type="file" accept=".pdf" className="text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        Signers:
        {view.vocab.signerRoles.map((r) => (
          <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles((p) => e.target.checked ? [...p, r] : p.filter((x) => x !== r))} />{r.replace(/_/g, " ")}</label>
        ))}
      </div>
      <Button type="button" size="sm" disabled={busy} onClick={submit}>{busy ? "Adding…" : "Add"}</Button>
      <RefusalNotice message={out.message} href={out.href} />
      {out.ok && <p className="text-xs text-muted-foreground">{out.ok}</p>}
    </div>
  )
}

function LibraryActions({ rows, onDone }: { rows: LibRow[]; onDone: () => void }) {
  const [msg, setMsg] = useState<{ message: string | null; href: string | null }>({ message: null, href: null })
  const [revising, setRevising] = useState<string | null>(null)
  const [dates, setDates] = useState({ revision_date: "", effective_on: "" })
  async function post(body: FormData | Record<string, unknown>) {
    const r = body instanceof FormData ? await fetch("/api/forms/directory", { method: "POST", body }) : await fetch("/api/forms/directory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok || j.ok === false) setMsg(refusalOf(j)); else { setMsg({ message: null, href: null }); onDone() }
  }
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">Forms you manage</p>
      {rows.map((r) => (
        <div key={r.packetId} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="truncate max-w-[14rem]">{r.name}</span>
          <Badge variant="outline" className="text-[10px]">{r.scope}{r.version ? ` · v${r.version}` : ""}</Badge>
          {r.status === "not_configured" && <Badge variant="destructive" className="text-[10px]">not configured</Badge>}
          {!r.providerFormId && <button type="button" className="underline" onClick={() => setRevising(revising === r.packetId ? null : r.packetId)}>Add a revision</button>}
          <button type="button" className="underline" onClick={() => void post({ action: "retire_form", packet_id: r.packetId })}>Retire</button>
          {revising === r.packetId && (
            <span className="flex items-center gap-1">
              <Input type="date" className="h-7 text-xs" value={dates.revision_date} onChange={(e) => setDates((p) => ({ ...p, revision_date: e.target.value }))} />
              <Input type="date" className="h-7 text-xs" value={dates.effective_on} onChange={(e) => setDates((p) => ({ ...p, effective_on: e.target.value }))} />
              <input type="file" accept=".pdf" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; const fd = new FormData(); fd.set("action", "revise_form"); fd.set("packet_id", r.packetId); fd.set("revision_date", dates.revision_date); fd.set("effective_on", dates.effective_on); fd.set("file", file); void post(fd); setRevising(null) }} />
            </span>
          )}
        </div>
      ))}
      <RefusalNotice message={msg.message} href={msg.href} />
    </div>
  )
}
