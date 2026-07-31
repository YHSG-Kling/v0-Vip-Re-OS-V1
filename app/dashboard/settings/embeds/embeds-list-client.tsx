"use client"

import { useState, useTransition, useEffect } from "react"
import { Plus, Globe, Copy, Trash2, Settings, Power, ExternalLink, Check, BarChart2 } from "lucide-react"
import { Card } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/app/components/ui/dialog"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { toast } from "sonner"
import {
  createEmbed, deleteEmbed, updateEmbed, listTwinsForEmbed, type EmbedWidget,
} from "@/app/actions/embed-widgets"
import { EmbedEditor } from "./embed-editor"

interface Props {
  widgets: EmbedWidget[]
  canCreateBrokerageWide: boolean
}

export function EmbedsListClient({ widgets, canCreateBrokerageWide }: Props) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<EmbedWidget | null>(null)
  const [pending, startTransition] = useTransition()

  function toggleActive(w: EmbedWidget) {
    startTransition(async () => {
      const res = await updateEmbed({ id: w.id, isActive: !w.isActive })
      if (res.ok) toast.success(w.isActive ? "Disabled" : "Enabled")
      else toast.error(res.error ?? "Couldn't update")
    })
  }

  function remove(w: EmbedWidget) {
    if (!confirm(`Delete "${w.label}"? Visitors on the site won't see the widget anymore.`)) return
    startTransition(async () => {
      const res = await deleteEmbed(w.id)
      if (res.ok) toast.success("Embed deleted")
      else toast.error(res.error ?? "Couldn't delete")
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" /> New Embed
        </Button>
      </div>

      {widgets.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <div className="space-y-3">
          {widgets.map((w) => (
            <EmbedRow
              key={w.id}
              widget={w}
              pending={pending}
              onEdit={() => setEditing(w)}
              onToggle={() => toggleActive(w)}
              onDelete={() => remove(w)}
            />
          ))}
        </div>
      )}

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        canCreateBrokerageWide={canCreateBrokerageWide}
        onCreated={(w) => {
          setCreateOpen(false)
          setEditing(w)
        }}
      />

      {editing && (
        <EmbedEditor
          widget={editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </div>
  )
}

function EmbedRow({
  widget, pending, onEdit, onToggle, onDelete,
}: {
  widget: EmbedWidget
  pending: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
  // analytics link rendered via <a> to avoid adding a router dependency here
}) {
  const [copied, setCopied] = useState(false)
  const appUrl = typeof window !== "undefined" ? window.location.origin : ""
  const snippet = `<script src="${appUrl}/api/embed/script?id=${widget.publicId}" defer></script>`

  function copySnippet() {
    navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <p className="font-medium text-sm">{widget.label}</p>
            {widget.isActive ? (
              <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 text-xs">Active</Badge>
            ) : (
              <Badge variant="outline" className="text-xs">Disabled</Badge>
            )}
            {widget.agentId === null && (
              <Badge variant="outline" className="text-xs">Brokerage-wide</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {widget.allowedDomains.length === 0
              ? "No domain restriction"
              : `Allowed: ${widget.allowedDomains.join(", ")}`}
            {" • "}
            Modes: {widget.enabledModes.join(", ")}
          </p>

          <div className="mt-2 flex items-center gap-2">
            <code className="bg-muted text-xs px-2 py-1 rounded flex-1 truncate">
              {snippet}
            </code>
            <Button size="sm" variant="outline" onClick={copySnippet} className="gap-1">
              {copied ? <><Check className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy</>}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Button size="sm" variant="ghost" onClick={onEdit} className="gap-1">
            <Settings className="h-3.5 w-3.5" /> Edit
          </Button>
          <a
            href={`/dashboard/settings/embeds/${widget.id}/analytics`}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <BarChart2 className="h-3.5 w-3.5" /> Analytics
          </a>
          <Button size="sm" variant="ghost" onClick={onToggle} disabled={pending} className="gap-1">
            <Power className="h-3.5 w-3.5" /> {widget.isActive ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={pending}
            className="gap-1 text-destructive hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </div>
    </Card>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-dashed py-16 text-center bg-muted/20">
      <Globe className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
      <p className="text-sm font-medium mb-1">No embeds yet</p>
      <p className="text-xs text-muted-foreground max-w-md mx-auto mb-4">
        Set up your first embed to add an AI twin to your website. Visitors chat with you;
        captured leads land in your CRM.
      </p>
      <Button onClick={onCreate}>
        <Plus className="h-4 w-4 mr-1.5" /> Create Your First Embed
      </Button>
    </div>
  )
}

function CreateDialog({
  open, onOpenChange, canCreateBrokerageWide, onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canCreateBrokerageWide: boolean
  onCreated: (w: EmbedWidget) => void
}) {
  const [label, setLabel] = useState("My Website")
  const [scope, setScope] = useState<"personal" | "brokerage">("personal")
  const [twins, setTwins] = useState<{ id: string; label: string; agentName: string | null }[]>([])
  const [twinId, setTwinId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // A BROKERAGE-WIDE EMBED MUST NAME ITS TWIN, HERE. This dialog already told
  // the admin brokerage-wide means "pick a twin from any agent" — but it never
  // collected one, and the session route filled the gap by silently selecting
  // the brokerage's longest-tenured active agent and putting their face and
  // cloned voice on a public website. The picker the copy promised now exists
  // at the moment of the promise; the route's refusal is the backstop, not the
  // first thing an admin meets.
  useEffect(() => {
    if (!open || scope !== "brokerage") return
    let live = true
    listTwinsForEmbed("brokerage").then((res) => { if (live) setTwins(res.twins) })
    return () => { live = false }
  }, [open, scope])

  // A personal embed resolves to the owner agent's own default twin server-side,
  // so only the brokerage-wide scope needs an explicit pick.
  const needsTwin = scope === "brokerage"
  const canCreate = !pending && label.trim().length > 0 && (!needsTwin || !!twinId)

  function handleCreate() {
    startTransition(async () => {
      const res = await createEmbed({ label, scope, defaultTwinId: needsTwin ? twinId : null })
      if (res.ok && res.widget) {
        toast.success("Embed created")
        onCreated(res.widget)
      } else {
        toast.error(res.error ?? "Couldn't create")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Embed</DialogTitle>
          <DialogDescription>
            Each embed gets its own snippet. Use one per site or one per landing page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="embed-label">Label</Label>
            <Input
              id="embed-label" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="My personal site, Brokerage homepage, etc."
              className="mt-1.5" maxLength={64}
            />
          </div>

          {canCreateBrokerageWide && (
            <div>
              <Label>Scope</Label>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                <button
                  type="button" onClick={() => setScope("personal")}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    scope === "personal" ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <p className="font-medium text-sm">Personal</p>
                  <p className="text-xs text-muted-foreground">Uses your default twin.</p>
                </button>
                <button
                  type="button" onClick={() => setScope("brokerage")}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    scope === "brokerage" ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <p className="font-medium text-sm">Brokerage-wide</p>
                  <p className="text-xs text-muted-foreground">Pick a twin from any agent.</p>
                </button>
              </div>
            </div>
          )}

          {needsTwin && (
            <div>
              <Label htmlFor="embed-twin">Twin</Label>
              <select
                id="embed-twin"
                value={twinId ?? ""}
                onChange={(e) => setTwinId(e.target.value || null)}
                className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1.5"
              >
                <option value="">— Select a twin —</option>
                {twins.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}{t.agentName ? ` · ${t.agentName}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {twins.length === 0
                  ? "No ready, approved twins in this brokerage yet — an agent needs to finish Settings → Voice & Avatar first."
                  : "Whose face and voice greets visitors. Only ready + approved twins are listed, and a brokerage-wide embed never borrows one automatically."}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={handleCreate} disabled={!canCreate}>Create</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
