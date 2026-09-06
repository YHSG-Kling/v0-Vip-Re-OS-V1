"use client"

import { useState, useCallback, useMemo } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Plus,
  Sparkles,
  FlaskConical,
  BarChart2,
  Copy,
  Pencil,
  Trash2,
  Lock,
  Layers,
  Users,
  CheckCircle2,
  TrendingUp,
} from "lucide-react"
import {
  createCampaignSequence,
  updateCampaignSequence,
  deleteCampaignSequence,
} from "@/app/actions/campaign-sequences"
import { SEQUENCE_TYPES, type CampaignSequence } from "@/lib/campaigns/sequence-constants"
import { precheckSequenceCompliance, type SequenceStepCheck } from "@/app/actions/sequence-step-ai"
import { AlertTriangle, ShieldCheck } from "lucide-react"
import { WORKFLOW_TRIGGERS, groupedTriggers, toTriggerSelectValue, fromTriggerSelectValue } from "@/lib/workflow/triggers"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  sequences: CampaignSequence[]
  brokerageId: string
  userId: string
  openCreate?: boolean
  pageType?: "marketing" | "nurture"
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Keep flat list for backward-compat exports; the grouped version is used in the UI
const TRIGGER_EVENTS = WORKFLOW_TRIGGERS.map(t => ({ value: t.value, label: t.label }))
const GROUPED_TRIGGERS = groupedTriggers()

// SEQUENCE_TYPES moved to lib/campaigns/sequence-constants.ts (imported above)
// — same five values, now shared with app/actions/workflows.ts's drip-drain
// validator instead of being spelled out twice.
//
// TOMBSTONE (orphan doctrine §1.1) — the local CHANNEL_ICONS map that stood here
// is DELETED. It occurred exactly twice in this file: this declaration and the
// re-export at the bottom, commented "so builder can reuse them". It was never
// read in this file, and no file ever imported it — the builder it was written
// for hand-rolled its own six-key copy instead.
//
// SURVIVOR: app/components/campaigns/step-type-select.tsx:47 `stepIcon(channel)`,
// which resolves the icon NAME off lib/workflow/step-palette.ts — the same
// palette saveSequenceSteps uses as its allow-list. Nothing merged, because the
// survivor is strictly more complete: it answers for all 25 live
// `campaign_sequence_steps.channel` CHECK values, where this map held six, and
// one of those six (`voice`) was not a live value at all — the column spells it
// `voice_drop`, so that entry could never have been hit by a stored step.

// ─── Component ────────────────────────────────────────────────────────────────

export default function SequencesListClient({ sequences: initial, brokerageId, userId, openCreate = false, pageType = "marketing" }: Props) {
  const router = useRouter()
  const [sequences, setSequences]   = useState<CampaignSequence[]>(initial)
  const [showCreate, setShowCreate] = useState(openCreate)
  const [deleting, setDeleting]     = useState<string | null>(null)
  const [busy, setBusy]             = useState(false)
  const [seedingDefaults, setSeedingDefaults] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Default-sequence picker: browse the catalog + choose which to install.
  type CatalogItem = { name: string; description: string; sequenceType: string; triggerLabel: string; stepCount: number; installed: boolean }
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [pickedDefaults, setPickedDefaults] = useState<Set<string>>(new Set())

  const openDefaultsPicker = useCallback(async () => {
    setDefaultsOpen(true)
    setCatalogLoading(true)
    try {
      const { getDefaultSequenceCatalog } = await import("@/app/actions/seed-default-sequences")
      const res = await getDefaultSequenceCatalog(brokerageId)
      if (res.success) {
        setCatalog(res.items)
        // Preselect the ones not yet installed.
        setPickedDefaults(new Set(res.items.filter((i) => !i.installed).map((i) => i.name)))
      } else {
        toast.error(res.error ?? "Could not load defaults")
      }
    } finally {
      setCatalogLoading(false)
    }
  }, [brokerageId])

  const installPickedDefaults = useCallback(async () => {
    const names = [...pickedDefaults]
    if (names.length === 0) return
    setSeedingDefaults(true)
    try {
      const { seedDefaultSequences } = await import("@/app/actions/seed-default-sequences")
      const res = await seedDefaultSequences(brokerageId, names)
      if (res.success) {
        if (res.created > 0) {
          toast.success(`Installed ${res.created} default sequence${res.created === 1 ? "" : "s"}`)
          if (typeof window !== "undefined") window.location.reload()
        } else {
          toast.info("Those defaults are already installed")
          setDefaultsOpen(false)
        }
      } else {
        toast.error(res.error ?? "Install failed")
      }
    } finally {
      setSeedingDefaults(false)
    }
  }, [brokerageId, pickedDefaults])

  // New sequence form state
  const [form, setForm] = useState({
    name:           "",
    trigger_event:  "",
    sequence_type:  "drip",
    is_ab_test:     false,
  })
  const [createError, setCreateError] = useState<string | null>(null)

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const active    = sequences.filter(s => s.is_active).length
    const enrolled  = sequences.reduce((acc, s) => acc + (s.enrollments_total ?? 0), 0)
    const completed = sequences.reduce((acc, s) => acc + (s.completions_total ?? 0), 0)
    const converted = sequences.reduce((acc, s) => acc + (s.conversions_total ?? 0), 0)
    const avgCompletion = enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0
    return { active, enrolled, avgCompletion, converted }
  }, [sequences])

  const [batchNote, setBatchNote] = useState<string | null>(null)

  /**
   * BATCH ACTIVATE BYPASSED THE COMPLIANCE GATE.
   *
   * handleToggleActive runs precheckSequenceCompliance before it will activate a
   * single sequence — the brand-voice / compliance gate that decides whether a
   * sequence may start sending. This batch path called updateCampaignSequence
   * directly, so selecting ten sequences and pressing Activate started all ten
   * WITHOUT the gate the per-row button enforces. The bulk path was the
   * permissive one, which is exactly backwards: bulk is where a mistake is
   * multiplied.
   *
   * It also discarded every result and then optimistically marked all of them
   * active, so a refused update still rendered as activated.
   *
   * Now: deactivation stays immediate (no gate needed to STOP sending), and
   * activation runs the same precheck per sequence. Anything the gate blocks is
   * left OFF and named, so the agent knows which ones need review rather than
   * believing all ten went live.
   */
  const handleBatchToggle = useCallback(async (active: boolean) => {
    setBusy(true)
    setBatchNote(null)
    const ids = Array.from(selectedIds)
    const changedIds: string[] = []
    const blocked: string[] = []
    const failed: string[] = []

    for (const id of ids) {
      const seq = sequences.find(s => s.id === id)
      if (!seq) continue

      if (active) {
        const pre = await precheckSequenceCompliance(id)
        // A precheck that could not RUN is not a pass. Treat it like a block —
        // silence is not consent when the next step is sending to real people.
        if (!pre.success || pre.blocked) {
          blocked.push(seq.name)
          continue
        }
      }

      const res = await updateCampaignSequence(id, { is_active: active })
      // updateCampaignSequence returns {success, error} and does not throw — a
      // refused write must not join the "changed" set.
      if ((res as any)?.success === false) failed.push(seq.name)
      else changedIds.push(id)
    }

    // Only move the rows that actually changed. Tracked by ID, not by name —
    // two sequences can share a name and a name-based filter would move the
    // wrong row.
    const changed = new Set(changedIds)
    setSequences(prev => prev.map(s => changed.has(s.id) ? { ...s, is_active: active } : s))
    setSelectedIds(new Set())
    setBusy(false)

    const parts: string[] = []
    if (changed.size) parts.push(`${changed.size} ${active ? "activated" : "paused"}`)
    if (blocked.length) parts.push(`${blocked.length} held for compliance review: ${blocked.join(", ")}`)
    if (failed.length) parts.push(`${failed.length} failed: ${failed.join(", ")}`)
    setBatchNote(parts.join(" · ") || null)
  }, [selectedIds, sequences])

  const toggleSequenceSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(id)) newSet.delete(id)
      else newSet.add(id)
      return newSet
    })
  }, [])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    if (!form.name.trim()) { setCreateError("Name is required"); return }
    if (!form.sequence_type) { setCreateError("Sequence type is required"); return }
    setBusy(true)
    setCreateError(null)
    const result = await createCampaignSequence({
      brokerageId,
      name: form.name.trim(),
      sequence_type: form.sequence_type,
      trigger_event: form.trigger_event || undefined,
    })
    setBusy(false)
    if (result.error) { setCreateError(result.error); return }
    if (result.sequence) {
      setSequences(prev => [result.sequence!, ...prev])
      setShowCreate(false)
      setForm({ name: "", trigger_event: "", sequence_type: "drip", is_ab_test: false })
      router.push(`/dashboard/campaigns/sequences/${result.sequence.id}`)
    }
  }, [form, brokerageId, router])

  // Compliance precheck dialog state
  const [precheckOpen, setPrecheckOpen] = useState(false)
  const [precheckLoading, setPrecheckLoading] = useState(false)
  const [precheckChecks, setPrecheckChecks] = useState<SequenceStepCheck[]>([])
  const [precheckSequence, setPrecheckSequence] = useState<CampaignSequence | null>(null)

  const handleToggleActive = useCallback(async (seq: CampaignSequence) => {
    const next = !seq.is_active
    if (!next) {
      // Deactivate immediately — no precheck needed.
      setSequences(prev => prev.map(s => s.id === seq.id ? { ...s, is_active: next } : s))
      await updateCampaignSequence(seq.id, { is_active: next })
      return
    }
    // Activating: run brand-voice / compliance gate first.
    setPrecheckSequence(seq)
    setPrecheckOpen(true)
    setPrecheckLoading(true)
    try {
      const result = await precheckSequenceCompliance(seq.id)
      setPrecheckChecks(result.checks ?? [])
      if (result.success && !result.blocked) {
        // Clean — activate now and close dialog.
        setSequences(prev => prev.map(s => s.id === seq.id ? { ...s, is_active: true } : s))
        await updateCampaignSequence(seq.id, { is_active: true })
        setPrecheckOpen(false)
      }
    } finally {
      setPrecheckLoading(false)
    }
  }, [])

  const confirmActivateAfterReview = useCallback(async () => {
    if (!precheckSequence) return
    setSequences(prev => prev.map(s => s.id === precheckSequence.id ? { ...s, is_active: true } : s))
    await updateCampaignSequence(precheckSequence.id, { is_active: true })
    setPrecheckOpen(false)
  }, [precheckSequence])

  const handleDuplicate = useCallback(async (seq: CampaignSequence) => {
    setBusy(true)
    const result = await createCampaignSequence({
      brokerageId,
      name: `${seq.name} (Copy)`,
      sequence_type: seq.sequence_type,
      trigger_event: seq.trigger_event ?? undefined,
    })
    setBusy(false)
    if (result.sequence) {
      setSequences(prev => [result.sequence!, ...prev])
    }
  }, [brokerageId])

  const handleDelete = useCallback(async (id: string) => {
    setBusy(true)
    const result = await deleteCampaignSequence(id)
    setBusy(false)
    if (!result.error) {
      setSequences(prev => prev.filter(s => s.id !== id))
    }
    setDeleting(null)
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="container mx-auto max-w-7xl px-4 py-8 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground text-balance">
            {pageType === "marketing" ? "Campaign Sequences" : "Nurture Sequences"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {pageType === "marketing"
              ? "Event-triggered automations for your listings and marketing campaigns."
              : "Multi-touch nurture sequences for buyers, sellers, and leads (email + SMS + voice drop + AI call)."}
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          New Sequence
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Active Sequences",     value: stats.active,        Icon: CheckCircle2 },
          { label: "Total Enrollments",    value: stats.enrolled,       Icon: Users },
          { label: "Avg Completion",       value: `${stats.avgCompletion}%`, Icon: BarChart2 },
          { label: "Conversions (all)",    value: stats.converted,      Icon: TrendingUp },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4 flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-xl font-semibold text-foreground">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Command Strip with Batch Actions */}
      <div className="flex items-center justify-between rounded-lg border bg-card p-4 mb-6">
        <div className="flex items-center gap-3">
          <Layers className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-medium">{sequences.length} sequences</span>
          {selectedIds.size > 0 && (
            <span className="text-xs text-muted-foreground">• {selectedIds.size} selected</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => handleBatchToggle(true)} disabled={busy}>
                <CheckCircle2 className="h-4 w-4 mr-1" />
                Activate
              </Button>
              {batchNote && (
                <span className="text-xs text-muted-foreground ml-2">{batchNote}</span>
              )}
              <Button size="sm" variant="outline" onClick={() => handleBatchToggle(false)} disabled={busy}>
                <Lock className="h-4 w-4 mr-1" />
                Pause
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                Clear
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Sequence cards */}
      {sequences.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 px-6 text-center space-y-3">
          <p className="text-sm font-medium text-foreground">No sequences yet</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            {pageType === "marketing"
              ? "Create event-triggered automations that fire when listings go live, prices drop, or deals close."
              : "Build multi-touch nurture sequences for buyers, sellers, and leads — email, SMS, voice drop, and AI calls."}
          </p>
          <div className="flex flex-wrap gap-2 justify-center pt-2">
            <Button size="sm" className="gap-1.5" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              New Sequence
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={seedingDefaults}
              onClick={openDefaultsPicker}
            >
              <Sparkles className="h-4 w-4" />
              Browse &amp; install defaults
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/70 max-w-md mx-auto pt-1">
            The defaults are five canonical nurture flows (buyer welcome, under-contract,
            listing-live, seller under-contract, lifetime onboard) that fire automatically
            on the matching kernel events. You can edit, disable, or delete any of them.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sequences.map(seq => (
            <div key={seq.id} className="relative">
              <input
                type="checkbox"
                checked={selectedIds.has(seq.id)}
                onChange={() => toggleSequenceSelection(seq.id)}
                className="absolute top-3 left-3 h-4 w-4 z-10 cursor-pointer"
              />
              <SequenceCard
                sequence={seq}
                onEdit={() => router.push(`/dashboard/campaigns/workflows?id=${seq.id}`)}
                onToggle={() => handleToggleActive(seq)}
                onDuplicate={() => handleDuplicate(seq)}
                onDelete={() => setDeleting(seq.id)}
                onAnalytics={() => router.push(`/dashboard/campaigns/sequences/${seq.id}?tab=analytics`)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      {/* Default-sequence picker — see every canonical flow + choose which to install */}
      <Dialog open={defaultsOpen} onOpenChange={setDefaultsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Install default sequences</DialogTitle>
            <DialogDescription>
              Canonical nurture flows that fire automatically on the matching event. Pick the ones you
              want — already-installed flows are checked and locked. Edit or delete any of them later.
            </DialogDescription>
          </DialogHeader>

          {catalogLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading defaults…</p>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto space-y-2">
              {catalog.map((item) => {
                const checked = item.installed || pickedDefaults.has(item.name)
                return (
                  <label
                    key={item.name}
                    className={`flex items-start gap-3 rounded-lg border p-3 ${item.installed ? "opacity-70" : "cursor-pointer hover:border-primary/50"}`}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={item.installed}
                      onCheckedChange={(v) => {
                        setPickedDefaults((prev) => {
                          const next = new Set(prev)
                          if (v) next.add(item.name)
                          else next.delete(item.name)
                          return next
                        })
                      }}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{item.name}</span>
                        {item.installed && <Badge variant="secondary" className="text-[10px]">Installed</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                        <Badge variant="outline" className="text-[10px]">{item.triggerLabel}</Badge>
                        <span>{item.stepCount} step{item.stepCount === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDefaultsOpen(false)}>Cancel</Button>
            <Button
              onClick={installPickedDefaults}
              disabled={seedingDefaults || pickedDefaults.size === 0}
            >
              {seedingDefaults ? "Installing…" : `Install ${pickedDefaults.size} selected`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Campaign Sequence</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Compliance gate — read-only, always locked */}
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              <Lock className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span>Compliance Gate: <strong className="text-foreground">LOCKED</strong> — always active on all sequences. Cannot be disabled.</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="seq-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="seq-name"
                placeholder="e.g. New Lead Welcome Drip"
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="seq-trigger">Trigger Event</Label>
              <Select
                value={toTriggerSelectValue(form.trigger_event)}
                onValueChange={v => setForm(p => ({ ...p, trigger_event: fromTriggerSelectValue(v) }))}
              >
                <SelectTrigger id="seq-trigger">
                  <SelectValue placeholder="Select a trigger (optional)" />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {Object.entries(GROUPED_TRIGGERS).map(([category, triggers]) => (
                    <SelectGroup key={category}>
                      <SelectLabel className="text-xs text-muted-foreground px-2 py-1">{category}</SelectLabel>
                      {triggers.map(t => (
                        <SelectItem key={toTriggerSelectValue(t.value)} value={toTriggerSelectValue(t.value)}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="seq-type">Sequence Type <span className="text-destructive">*</span></Label>
              <Select value={form.sequence_type} onValueChange={v => setForm(p => ({ ...p, sequence_type: v }))}>
                <SelectTrigger id="seq-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEQUENCE_TYPES.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">A/B Testing</p>
                <p className="text-xs text-muted-foreground">Split enrollments between two variants</p>
              </div>
              <Switch
                checked={form.is_ab_test}
                onCheckedChange={v => setForm(p => ({ ...p, is_ab_test: v }))}
              />
            </div>

            {createError && (
              <p className="text-sm text-destructive">{createError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={busy}>
              {busy ? "Creating..." : "Create Sequence"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleting} onOpenChange={() => setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Sequence?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete the sequence and all its steps. Active enrollments will be unenrolled. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => deleting && handleDelete(deleting)}
            >
              {busy ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Compliance precheck dialog — runs on activation */}
      <Dialog open={precheckOpen} onOpenChange={setPrecheckOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {precheckLoading ? (
                <>
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  Running compliance check…
                </>
              ) : precheckChecks.some(c => c.violations.length > 0) ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Review issues before activating
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  No compliance issues
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {precheckLoading && (
            <p className="text-sm text-muted-foreground py-4">
              Checking each step against your brand voice and fair-housing rules…
            </p>
          )}
          {!precheckLoading && precheckChecks.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">
              No messaging steps to check (sequence has only wait steps).
            </p>
          )}
          {!precheckLoading && precheckChecks.length > 0 && (
            <div className="space-y-3 mt-2">
              {precheckChecks.map((c) => {
                const hasIssues = c.violations.length > 0
                return (
                  <div
                    key={c.stepId}
                    className={`rounded-lg border p-3 ${hasIssues ? "border-amber-300 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-semibold">
                        Step {c.stepNumber} — {c.stepName}{" "}
                        <span className="text-xs font-normal text-muted-foreground">({c.channel})</span>
                      </p>
                      {hasIssues ? (
                        <Badge variant="outline" className="text-amber-900 border-amber-400">
                          {c.violations.length} {c.violations.length === 1 ? "issue" : "issues"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-emerald-900 border-emerald-400">
                          OK
                        </Badge>
                      )}
                    </div>
                    {hasIssues && (
                      <ul className="list-disc pl-5 text-xs text-amber-900 space-y-0.5">
                        {c.violations.map((v, i) => (
                          <li key={i}>{v}</li>
                        ))}
                      </ul>
                    )}
                    {c.notes.length > 0 && (
                      <ul className="list-disc pl-5 text-xs text-blue-900 mt-1 space-y-0.5">
                        {c.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setPrecheckOpen(false)} disabled={precheckLoading}>
              Cancel
            </Button>
            {!precheckLoading && precheckSequence && (
              <>
                {precheckSequence.id && (
                  <Button asChild variant="outline">
                    <Link href={`/dashboard/campaigns/sequences/${precheckSequence.id}/builder`}>
                      Open builder to fix
                    </Link>
                  </Button>
                )}
                {precheckChecks.some(c => c.violations.length > 0) ? (
                  <Button variant="default" onClick={confirmActivateAfterReview}>
                    Activate anyway
                  </Button>
                ) : (
                  <Button variant="default" onClick={confirmActivateAfterReview}>
                    Activate
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

// ─── Sequence Card ────────────────────────────────────────────────────────────

function SequenceCard({
  sequence,
  onEdit,
  onToggle,
  onDuplicate,
  onDelete,
  onAnalytics,
}: {
  sequence: CampaignSequence
  onEdit: () => void
  onToggle: () => void
  onDuplicate: () => void
  onDelete: () => void
  onAnalytics: () => void
}) {
  const completionPct = sequence.enrollments_total > 0
    ? Math.round((sequence.completions_total / sequence.enrollments_total) * 100)
    : 0

  const typeColors: Record<string, string> = {
    drip:          "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    nurture:       "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    re_engagement: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    transaction:   "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    post_close:    "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  }

  const triggerLabel = TRIGGER_EVENTS.find(t => t.value === sequence.trigger_event)?.label

  return (
    <div className="rounded-lg border border-border bg-card flex flex-col gap-0 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-start justify-between gap-2 p-4 pb-3">
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="font-semibold text-foreground text-sm truncate flex items-center gap-1.5">
            {sequence.name}
            {sequence.is_ab_test && (
              <FlaskConical className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            )}
          </h3>
          <div className="flex flex-wrap gap-1 mt-0.5">
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${typeColors[sequence.sequence_type] ?? "bg-muted text-muted-foreground"}`}>
              {SEQUENCE_TYPES.find(t => t.value === sequence.sequence_type)?.label ?? sequence.sequence_type}
            </span>
            {triggerLabel && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                {triggerLabel}
              </span>
            )}
          </div>
        </div>
        <Switch
          checked={sequence.is_active}
          onCheckedChange={onToggle}
          aria-label="Toggle sequence active"
          className="shrink-0 mt-0.5"
        />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 divide-x divide-border border-t border-border text-center">
        <div className="py-2 px-1">
          <p className="text-xs text-muted-foreground">Enrollments</p>
          <p className="text-sm font-semibold text-foreground">{sequence.enrollments_total}</p>
        </div>
        <div className="py-2 px-1">
          <p className="text-xs text-muted-foreground">Completion</p>
          <p className="text-sm font-semibold text-foreground">{completionPct}%</p>
        </div>
        <div className="py-2 px-1">
          <p className="text-xs text-muted-foreground">Conversions</p>
          <p className="text-sm font-semibold text-foreground">{sequence.conversions_total}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between gap-1 border-t border-border px-3 py-2">
        <div className="flex gap-1">
          <button
            onClick={onEdit}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors"
            title="Edit sequence"
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={onDuplicate}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors"
            title="Duplicate"
          >
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={onAnalytics}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors"
            title="Analytics"
          >
            <BarChart2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        <button
          onClick={onDelete}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-destructive/10 transition-colors"
          title="Delete sequence"
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </button>
      </div>
    </div>
  )
}

// TOMBSTONE (orphan doctrine §1.1) — this file used to end with
// `export { TRIGGER_EVENTS, SEQUENCE_TYPES, CHANNEL_ICONS }`, commented
// "Re-export constants so builder can reuse them". Nothing ever imported any of
// the three: the only importer of this module (../sequences/page.tsx:5) takes
// the default export only, and the builder it was written for hand-rolled its
// own copies. Each name now has one home, and the builder can import from there:
//   · TRIGGER_EVENTS  → derived from WORKFLOW_TRIGGERS, lib/workflow/triggers.ts
//                       (already the canonical catalog; this file just maps it)
//   · SEQUENCE_TYPES  → lib/campaigns/sequence-constants.ts
//   · CHANNEL_ICONS   → app/components/campaigns/step-type-select.tsx:47 stepIcon()
