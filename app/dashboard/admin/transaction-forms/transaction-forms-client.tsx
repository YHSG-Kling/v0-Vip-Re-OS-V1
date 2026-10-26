"use client"

/**
 * TransactionFormsClient — list + upload + edit UI for the brokerage
 * transaction-form library. Talks to /api/admin/transaction-forms.
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, Upload, FileText, ExternalLink, Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { ALL_US_STATES } from "@/lib/state-forms/registry"

interface FormRow {
  id:           string
  name:         string
  description:  string | null
  state:        string
  packet_type:  string
  pdf_url:      string | null
  field_schema: string[] | null
  is_active:    boolean
  created_at:   string
  /** m853 (wave 144): null = shared with the whole brokerage; a team id = shared with that team only. */
  team_id?:     string | null
  form_code?:   string | null
  license_note?: string | null
  license_expires_at?: string | null
  /** Set when the packet was added from the VIPAgents catalogue (the copy is the brokerage's own). */
  source_platform_packet_id?: string | null
}

interface ShareTeam { id: string; name: string }
interface CatalogueRow { id: string; name: string; state: string | null; packet_type: string; form_code: string | null; version: number; license_note: string | null; license_expires_at: string | null; preview_url: string | null }

const PACKET_TYPES = [
  { value: "offer",       label: "Offer" },
  { value: "listing",     label: "Listing" },
  { value: "transaction", label: "Transaction" },
  { value: "disclosure",  label: "Disclosure" },
  { value: "custom",      label: "Custom" },
]

export default function TransactionFormsClient({ initialForms }: { initialForms: FormRow[] }) {
  const [forms, setForms] = useState<FormRow[]>(initialForms)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<{ state: string; packetType: string }>({ state: "", packetType: "" })
  // Who this person may share with (the brokerage, and/or the teams they lead or oversee) and what the VIPAgents catalogue offers.
  const [shareTeams, setShareTeams] = useState<ShareTeam[]>([])
  const [mayShareBrokerageWide, setMayShareBrokerageWide] = useState(false)
  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([])
  const [catalogueError, setCatalogueError] = useState<string | null>(null)

  const filtered = forms.filter(f =>
    (!filter.state      || f.state === filter.state) &&
    (!filter.packetType || f.packet_type === filter.packetType)
  )
  const scopeLabel = (f: FormRow) => f.team_id ? (shareTeams.find(t => t.id === f.team_id)?.name ?? "Team") : "Whole brokerage"

  async function reload() {
    const res = await fetch("/api/admin/transaction-forms")
    if (res.ok) {
      const data = await res.json()
      setForms(data.forms)
      setShareTeams(data.share_teams ?? [])
      setMayShareBrokerageWide(data.may_share_brokerage_wide === true)
      setCatalogue(data.platform_catalogue ?? [])
      setCatalogueError(data.platform_catalogue_error ?? null)
    } else {
      const body = await res.json().catch(() => ({}))
      toast.error(body.error ?? "Your form library could not be loaded")
    }
  }
  useEffect(() => { void reload() }, [])

  async function addFromCatalogue(row: CatalogueRow, teamId: string | null, state: string | null) {
    const res = await fetch("/api/admin/transaction-forms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add_from_catalogue", platform_packet_id: row.id, team_id: teamId, state }),
    })
    const body = await res.json().catch(() => ({})) as { error?: string; existing?: boolean }
    if (!res.ok) { toast.error(body.error ?? "Could not add the packet"); return }
    toast.success(body.existing ? `"${row.name}" is already in that library` : `"${row.name}" added to your library`)
    reload()
  }

  async function deleteForm(id: string) {
    if (!confirm("Deactivate this form? Agents will no longer see it on packet assembly.")) return
    const res = await fetch(`/api/admin/transaction-forms?id=${id}`, { method: "DELETE" })
    const { success, error } = await res.json().catch(() => ({}))
    if (res.ok && success) {
      toast.success("Form deactivated")
      reload()
    } else {
      toast.error(error ?? "Could not deactivate")
    }
  }

  // MOUNTED (§1 orphan doctrine — scripts/handler-parity-census.ts,
  // 2026-09-11): the PATCH endpoint at /api/admin/transaction-forms already
  // accepts `is_active`, but nothing in the tree ever called PATCH — a
  // deactivated form (DELETE above only ever sets is_active=false; there is
  // no hard delete) had no way back. This is the missing CALLER for the
  // reactivate half of that same toggle, not a new endpoint.
  async function reactivateForm(id: string) {
    const res = await fetch("/api/admin/transaction-forms", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_active: true }),
    })
    const { success, error } = await res.json().catch(() => ({}))
    if (res.ok && success) {
      toast.success("Form reactivated")
      reload()
    } else {
      toast.error(error ?? "Could not reactivate")
    }
  }

  return (
    <>
      {/* Filters + Create button */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[120px]">
          <Label className="text-xs">Filter by state</Label>
          <Select value={filter.state || "all"} onValueChange={v => setFilter(p => ({ ...p, state: v === "all" ? "" : v }))}>
            <SelectTrigger>
              <SelectValue placeholder="All states" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              {ALL_US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 min-w-[120px]">
          <Label className="text-xs">Filter by type</Label>
          <Select value={filter.packetType || "all"} onValueChange={v => setFilter(p => ({ ...p, packetType: v === "all" ? "" : v }))}>
            <SelectTrigger>
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {PACKET_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Upload Form
        </Button>
      </div>

      {/* Form list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">
              {forms.length === 0
                ? "No legal forms uploaded yet. Click \"Upload Form\" to add your first."
                : "No forms match the current filter."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(f => (
            <Card key={f.id} className={!f.is_active ? "opacity-50" : ""}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-sm flex-1">{f.name}</CardTitle>
                  <div className="flex gap-1 shrink-0">
                    <Badge variant="outline" className="text-[10px]">{f.state}</Badge>
                    <Badge variant="outline" className="text-[10px] capitalize">{f.packet_type}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-1">
                  <Badge variant="secondary" className="text-[10px]">Shared with: {scopeLabel(f)}</Badge>
                  {f.source_platform_packet_id && <Badge variant="outline" className="text-[10px]">From the VIPAgents catalogue</Badge>}
                  {f.form_code && <Badge variant="outline" className="text-[10px]">{f.form_code}</Badge>}
                </div>
                {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
                {f.license_note && (
                  <p className="text-[10px] text-muted-foreground">Licence: {f.license_note}{f.license_expires_at ? ` · expires ${f.license_expires_at}` : ""}</p>
                )}
                {f.field_schema && f.field_schema.length > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {f.field_schema.length} field{f.field_schema.length === 1 ? "" : "s"} mapped
                  </p>
                )}
                <div className="flex items-center gap-1 pt-1">
                  {f.pdf_url && (
                    <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
                      <a href={f.pdf_url} target="_blank" rel="noopener">
                        PDF <ExternalLink className="h-3 w-3" />
                      </a>
                    </Button>
                  )}
                  {f.is_active ? (
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive ml-auto" onClick={() => deleteForm(f.id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" onClick={() => reactivateForm(f.id)}>
                      Reactivate
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CataloguePanel rows={catalogue} error={catalogueError} shareTeams={shareTeams} mayShareBrokerageWide={mayShareBrokerageWide} onAdd={addFromCatalogue} />

      <CreateFormDialog open={creating} onOpenChange={setCreating} onCreated={reload} shareTeams={shareTeams} mayShareBrokerageWide={mayShareBrokerageWide} />
    </>
  )
}

// ─── The VIPAgents catalogue — a SOURCE the brokerage adds from (owner ruling 3: packets are the brokerage's, not the platform's) ──

function CataloguePanel({ rows, error, shareTeams, mayShareBrokerageWide, onAdd }: {
  rows: CatalogueRow[]
  error: string | null
  shareTeams: ShareTeam[]
  mayShareBrokerageWide: boolean
  onAdd: (row: CatalogueRow, teamId: string | null, state: string | null) => void
}) {
  const [scopeFor, setScopeFor] = useState<Record<string, string>>({})
  const [stateFor, setStateFor] = useState<Record<string, string>>({})
  if (!error && rows.length === 0) return null
  const defaultScope = mayShareBrokerageWide ? "brokerage" : (shareTeams[0]?.id ?? "")
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">VIPAgents form catalogue</CardTitle>
        <p className="text-xs text-muted-foreground">
          Licensed fillable packets the platform provides. Agents do not see these until you add one to your own library. The copy
          becomes your brokerage&apos;s packet, shared with the scope you choose, carrying the licence it was provided under.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p className="text-xs text-red-600">The catalogue could not be read: {error}</p>}
        {rows.map(r => {
          const scope = scopeFor[r.id] ?? defaultScope
          return (
            <div key={r.id} className="flex flex-wrap items-center gap-2 border-b pb-2 text-xs">
              <span className="font-medium">{r.name}</span>
              <Badge variant="outline" className="text-[10px]">{r.state ?? "any state"}</Badge>
              <Badge variant="outline" className="text-[10px] capitalize">{r.packet_type}</Badge>
              {r.preview_url && <a href={r.preview_url} target="_blank" rel="noopener" className="underline">Preview</a>}
              <div className="ml-auto flex items-center gap-2">
                {!r.state && (
                  <Select value={stateFor[r.id] ?? ""} onValueChange={v => setStateFor(p => ({ ...p, [r.id]: v }))}>
                    <SelectTrigger className="h-7 w-24 text-xs"><SelectValue placeholder="State" /></SelectTrigger>
                    <SelectContent className="max-h-72">{ALL_US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                  </Select>
                )}
                <Select value={scope} onValueChange={v => setScopeFor(p => ({ ...p, [r.id]: v }))}>
                  <SelectTrigger className="h-7 w-44 text-xs"><SelectValue placeholder="Share with" /></SelectTrigger>
                  <SelectContent>
                    {mayShareBrokerageWide && <SelectItem value="brokerage">Whole brokerage</SelectItem>}
                    {shareTeams.map(t => <SelectItem key={t.id} value={t.id}>Team: {t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" className="text-xs" disabled={!scope || (!r.state && !stateFor[r.id])}
                  onClick={() => onAdd(r, scope === "brokerage" ? null : scope, r.state ? null : (stateFor[r.id] ?? null))}>
                  Add to my library
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ─── Create form dialog ─────────────────────────────────────────────────────

function CreateFormDialog({
  open, onOpenChange, onCreated, shareTeams, mayShareBrokerageWide,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
  shareTeams: ShareTeam[]
  mayShareBrokerageWide: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [state, setState] = useState("")
  const [packetType, setPacketType] = useState("offer")
  const [fieldSchemaText, setFieldSchemaText] = useState("")
  const [file, setFile] = useState<File | null>(null)
  // Who the packet is shared with: the whole brokerage (brokerage admins) or one team (its lead, or a brokerage admin).
  const [shareWith, setShareWith] = useState<string>("")
  const [formCode, setFormCode] = useState("")
  const [licenseNote, setLicenseNote] = useState("")
  const [licenseExpiresAt, setLicenseExpiresAt] = useState("")
  const effectiveShare = shareWith || (mayShareBrokerageWide ? "brokerage" : (shareTeams[0]?.id ?? ""))

  async function submit() {
    if (!name.trim() || !state) {
      toast.error("Name and state are required")
      return
    }
    if (!effectiveShare) {
      toast.error("Choose who the packet is shared with")
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append("name", name)
      if (description.trim()) fd.append("description", description)
      fd.append("state", state)
      fd.append("packet_type", packetType)
      if (effectiveShare && effectiveShare !== "brokerage") fd.append("team_id", effectiveShare)
      if (formCode.trim()) fd.append("form_code", formCode.trim())
      if (licenseNote.trim()) fd.append("license_note", licenseNote.trim())
      if (licenseExpiresAt) fd.append("license_expires_at", licenseExpiresAt)
      if (fieldSchemaText.trim()) {
        // Parse newline or comma-separated list to JSON array
        const fields = fieldSchemaText
          .split(/[\n,]/).map(s => s.trim()).filter(Boolean)
        fd.append("field_schema", JSON.stringify(fields))
      }
      if (file) fd.append("file", file)

      const res = await fetch("/api/admin/transaction-forms", { method: "POST", body: fd })
      const body = await res.json().catch(() => ({})) as { error?: string; form?: { name?: string }; note?: string | null }
      if (!res.ok || !body.form) {
        toast.error(body.error ?? "Upload failed")
        return
      }
      toast.success(`"${body.form.name ?? name}" uploaded`)
      // The route registers the packet even when its preview link could not be minted or recorded; it says so in `note`.
      if (body.note) toast.warning(`Uploaded, but ${body.note}`)
      onOpenChange(false)
      // Reset form
      setName(""); setDescription(""); setState(""); setPacketType("offer")
      setFieldSchemaText(""); setFile(null); setShareWith(""); setFormCode(""); setLicenseNote(""); setLicenseExpiresAt("")
      onCreated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload transaction form</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="form-name">Name *</Label>
            <Input
              id="form-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Custom HOA Disclosure"
            />
          </div>

          <div>
            <Label htmlFor="form-desc">Description</Label>
            <Textarea
              id="form-desc"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="When the AI form-fill engine should attach this form…"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="form-state">State *</Label>
              <Select value={state} onValueChange={setState}>
                <SelectTrigger id="form-state">
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {ALL_US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="form-type">Packet type *</Label>
              <Select value={packetType} onValueChange={setPacketType}>
                <SelectTrigger id="form-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PACKET_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="form-share">Share with *</Label>
              <Select value={effectiveShare} onValueChange={setShareWith}>
                <SelectTrigger id="form-share"><SelectValue placeholder="Choose who sees it" /></SelectTrigger>
                <SelectContent>
                  {mayShareBrokerageWide && <SelectItem value="brokerage">Whole brokerage</SelectItem>}
                  {shareTeams.map(t => <SelectItem key={t.id} value={t.id}>Team: {t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="form-code">Form number</Label>
              <Input id="form-code" value={formCode} onChange={e => setFormCode(e.target.value)} placeholder="e.g., TAR 1601" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <Label htmlFor="form-licence">Licence basis</Label>
              <Input id="form-licence" value={licenseNote} onChange={e => setLicenseNote(e.target.value)} placeholder="e.g., association member licence, forms-provider agreement, our own form" />
            </div>
            <div>
              <Label htmlFor="form-licence-exp">Licence expires</Label>
              <Input id="form-licence-exp" type="date" value={licenseExpiresAt} onChange={e => setLicenseExpiresAt(e.target.value)} />
            </div>
          </div>

          <div>
            <Label htmlFor="form-fields">Field schema (one per line)</Label>
            <Textarea
              id="form-fields"
              value={fieldSchemaText}
              onChange={e => setFieldSchemaText(e.target.value)}
              placeholder={"buyer_full_name\nproperty_address\noffer_price"}
              rows={4}
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              List the field names the form contains. The AI form-fill engine maps intake
              fields (buyerLegalName, offerPrice, …) to these. Leave blank to only attach
              the PDF without prefilling.
            </p>
          </div>

          <div>
            <Label htmlFor="form-pdf">PDF (optional)</Label>
            <Input
              id="form-pdf"
              type="file"
              accept="application/pdf"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Up to 4.5 MB. Stored in your brokerage&apos;s (or the team&apos;s) own private folder. Your logos and branding stay as they are.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
