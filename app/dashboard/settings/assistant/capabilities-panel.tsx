"use client"

/**
 * app/dashboard/settings/assistant/capabilities-panel.tsx
 *
 * Lane 75B — owner verbatim (wave 75): "if a brand wants to create a
 * specific tool that should be an option with all of the different
 * capabilities that we have built in this agentic saas os using autonomous
 * ai or we should include a selection of more capabilities like sending a
 * newsletter or market report or maybe even an explainer video of the
 * selling or buying process etc."
 *
 * Lists lib/ai-isa/capability-catalogue.ts's CAPABILITY_CATALOGUE with a
 * per-capability enable/disable toggle, plus a minimal composer for a
 * brand's own custom tool (a label + copy + which existing capabilities it
 * composes — never a brand-authored IMPLEMENTATION, only existing
 * capabilities under new copy). Tenant-admin gated by the server action.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Plus, Trash2, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import {
  getCapabilitiesSettings,
  setCapabilityEnabled,
  saveCustomTool,
  deleteCustomTool,
} from "@/app/actions/ai-agent-capabilities"

interface CatalogueRow {
  id: string
  label: string
  usefulFor: string
  personas: readonly string[] | null
}

interface CustomToolRow {
  id: string
  label: string
  copy: string
  composesCapabilities: string[]
}

const EMPTY_CUSTOM = { id: "", label: "", copy: "", composesCapabilities: [] as string[] }

export function AiAgentCapabilitiesPanel({ className }: { className?: string }) {
  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([])
  const [disabled, setDisabled] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState<CustomToolRow[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(EMPTY_CUSTOM)
  const [isPending, startTransition] = useTransition()

  const load = useCallback(async () => {
    const res = await getCapabilitiesSettings()
    setCanManage(res.canManage)
    if (!res.ok) {
      setLoadError(res.error ?? "AI agent capabilities could not be read.")
      setLoading(false)
      return
    }
    setLoadError(null)
    setCatalogue(res.catalogue as unknown as CatalogueRow[])
    setDisabled(new Set(res.disabled))
    setCustom(res.custom)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function toggle(id: string, enabled: boolean) {
    startTransition(async () => {
      const res = await setCapabilityEnabled(id as never, enabled)
      if (!res.ok) {
        toast.error(res.error ?? "That capability could not be updated.")
        return
      }
      setDisabled((prev) => {
        const next = new Set(prev)
        if (enabled) next.delete(id)
        else next.add(id)
        return next
      })
      toast.success(`${enabled ? "Enabled" : "Disabled"} for this brokerage's AI agents.`)
    })
  }

  function toggleCompose(id: string) {
    setDraft((d) => ({
      ...d,
      composesCapabilities: d.composesCapabilities.includes(id)
        ? d.composesCapabilities.filter((c) => c !== id)
        : [...d.composesCapabilities, id],
    }))
  }

  function submitCustom() {
    const def = {
      id: draft.id.trim() || draft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60),
      label: draft.label.trim(),
      copy: draft.copy.trim(),
      composesCapabilities: draft.composesCapabilities,
    }
    startTransition(async () => {
      const res = await saveCustomTool(def)
      if (!res.ok) {
        toast.error(res.error ?? "That tool could not be saved.")
        return
      }
      toast.success(`"${def.label}" is ready for this brokerage's AI agents.`)
      setDraft(EMPTY_CUSTOM)
      setAdding(false)
      await load()
    })
  }

  function removeCustom(id: string) {
    if (!window.confirm("Remove this custom tool?")) return
    startTransition(async () => {
      const res = await deleteCustomTool(id)
      if (!res.ok) {
        toast.error(res.error ?? "That tool could not be removed.")
        return
      }
      toast.success("Removed.")
      await load()
    })
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          AI Agent Capabilities
        </CardTitle>
        <CardDescription>
          What your AI agents can DO for a customer in chat, email, voice and the client portal —
          newsletters, market reports, explainer videos, listing appointments, and more. Turn any
          off, or compose your own tool from the ones below with your own copy.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {loadError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {catalogue.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{c.label}</span>
                    {c.personas && (
                      <Badge variant="outline" className="text-[10px]">
                        {c.personas.join(", ")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{c.usefulFor}</p>
                </div>
                <Switch
                  checked={!disabled.has(c.id)}
                  onCheckedChange={(v) => toggle(c.id, v)}
                  disabled={isPending || !canManage}
                  aria-label={`${c.label} enabled`}
                />
              </li>
            ))}
          </ul>
        )}

        {!loading && !canManage && !loadError && (
          <p className="text-xs text-muted-foreground">
            Changing these capabilities is limited to a broker, admin or owner.
          </p>
        )}

        {/* ── This brokerage's custom tools ─────────────────────────────── */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Your custom tools{!loading && !loadError ? ` (${custom.length})` : ""}
            </Label>
            {canManage && !adding && (
              <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={isPending}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Compose a tool
              </Button>
            )}
          </div>

          {custom.length === 0 && !adding && (
            <p className="text-sm text-muted-foreground">
              No custom tools yet — every capability above is offered under its own name and copy.
            </p>
          )}

          {custom.length > 0 && (
            <ul className="divide-y rounded-md border">
              {custom.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 space-y-0.5">
                    <span className="text-sm font-medium">{c.label}</span>
                    <p className="text-xs text-muted-foreground">{c.copy}</p>
                    <p className="text-[10px] text-muted-foreground">
                      Composes: {c.composesCapabilities.join(", ")}
                    </p>
                  </div>
                  {canManage && (
                    <Button size="sm" variant="ghost" aria-label={`Remove ${c.label}`} disabled={isPending} onClick={() => removeCustom(c.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canManage && adding && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-label">Name</Label>
                <Input
                  id="custom-tool-label"
                  value={draft.label}
                  placeholder="e.g. Seller Concierge"
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-copy">Description shown to the AI</Label>
                <Textarea
                  id="custom-tool-copy"
                  rows={2}
                  value={draft.copy}
                  placeholder="Our concierge handles the whole seller journey — value, timing, and next steps."
                  onChange={(e) => setDraft((d) => ({ ...d, copy: e.target.value }))}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Composes these existing capabilities</Label>
                <div className="flex flex-wrap gap-2">
                  {catalogue.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCompose(c.id)}
                      disabled={isPending}
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        draft.composesCapabilities.includes(c.id)
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-muted-foreground/30 text-muted-foreground"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  A custom tool only COMPOSES capabilities already built above — it never runs
                  brand-authored logic of its own.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft(EMPTY_CUSTOM) }} disabled={isPending}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={submitCustom}
                  disabled={isPending || !draft.label.trim() || !draft.copy.trim() || draft.composesCapabilities.length === 0}
                >
                  {isPending ? "Saving…" : "Save tool"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
