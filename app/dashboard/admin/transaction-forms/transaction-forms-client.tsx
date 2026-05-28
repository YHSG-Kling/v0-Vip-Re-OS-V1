"use client"

/**
 * TransactionFormsClient — list + upload + edit UI for the brokerage
 * transaction-form library. Talks to /api/admin/transaction-forms.
 */

import { useState } from "react"
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
}

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

  const filtered = forms.filter(f =>
    (!filter.state      || f.state === filter.state) &&
    (!filter.packetType || f.packet_type === filter.packetType)
  )

  async function reload() {
    const res = await fetch("/api/admin/transaction-forms")
    if (res.ok) {
      const data = await res.json()
      setForms(data.forms)
    }
  }

  async function deleteForm(id: string) {
    if (!confirm("Deactivate this form? Agents will no longer see it on packet assembly.")) return
    const res = await fetch(`/api/admin/transaction-forms?id=${id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Form deactivated")
      reload()
    } else {
      toast.error("Could not deactivate")
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
                ? "No transaction forms uploaded yet. Click \"Upload Form\" to add your first."
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
                {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
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
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive ml-auto" onClick={() => deleteForm(f.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateFormDialog open={creating} onOpenChange={setCreating} onCreated={reload} />
    </>
  )
}

// ─── Create form dialog ─────────────────────────────────────────────────────

function CreateFormDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [state, setState] = useState("")
  const [packetType, setPacketType] = useState("offer")
  const [fieldSchemaText, setFieldSchemaText] = useState("")
  const [file, setFile] = useState<File | null>(null)

  async function submit() {
    if (!name.trim() || !state) {
      toast.error("Name and state are required")
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append("name", name)
      if (description.trim()) fd.append("description", description)
      fd.append("state", state)
      fd.append("packet_type", packetType)
      if (fieldSchemaText.trim()) {
        // Parse newline or comma-separated list to JSON array
        const fields = fieldSchemaText
          .split(/[\n,]/).map(s => s.trim()).filter(Boolean)
        fd.append("field_schema", JSON.stringify(fields))
      }
      if (file) fd.append("file", file)

      const res = await fetch("/api/admin/transaction-forms", { method: "POST", body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error((err as { error?: string }).error ?? "Upload failed")
        return
      }
      toast.success("Form uploaded")
      onOpenChange(false)
      // Reset form
      setName(""); setDescription(""); setState(""); setPacketType("offer")
      setFieldSchemaText(""); setFile(null)
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
              Up to 10MB. The PDF will be uploaded to your secure storage.
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
