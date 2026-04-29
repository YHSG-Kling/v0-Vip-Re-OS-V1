"use client"

import { useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Plus,
  Mail,
  MessageSquare,
  Phone,
  Send,
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
  type CampaignSequence,
} from "@/app/actions/campaign-sequences"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  sequences: CampaignSequence[]
  brokerageId: string
  userId: string
  openCreate?: boolean
  pageType?: "marketing" | "nurture"
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TRIGGER_EVENTS = [
  { value: "contact_created",        label: "Contact Created" },
  { value: "lead_captured",          label: "Lead Captured" },
  { value: "lead_scored",            label: "Lead Scored" },
  { value: "ghost_lead_detected",    label: "Ghost Lead Detected" },
  { value: "reengagement_started",   label: "Re-engagement Started" },
  { value: "deal_closed",            label: "Deal Closed" },
  { value: "lifetime_customer",      label: "Lifetime Customer" },
  { value: "tour_scheduled",         label: "Tour Scheduled" },
  { value: "offer_submitted",        label: "Offer Submitted" },
  { value: "contract_signed",        label: "Contract Signed" },
  { value: "isa_qualified_lead",     label: "ISA Qualified Lead" },
]

const SEQUENCE_TYPES = [
  { value: "drip",           label: "Drip" },
  { value: "nurture",        label: "Nurture" },
  { value: "re_engagement",  label: "Re-engagement" },
  { value: "transaction",    label: "Transaction" },
  { value: "post_close",     label: "Post-Close" },
]

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  email:       Mail,
  sms:         MessageSquare,
  voice:       Phone,
  direct_mail: Send,
  in_app:      Layers,
  video:       BarChart2,
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SequencesListClient({ sequences: initial, brokerageId, userId, openCreate = false, pageType = "marketing" }: Props) {
  const router = useRouter()
  const [sequences, setSequences]   = useState<CampaignSequence[]>(initial)
  const [showCreate, setShowCreate] = useState(openCreate)
  const [deleting, setDeleting]     = useState<string | null>(null)
  const [busy, setBusy]             = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

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

  const handleBatchToggle = useCallback(async (active: boolean) => {
    for (const id of selectedIds) {
      const seq = sequences.find(s => s.id === id)
      if (seq) {
        await updateCampaignSequence(id, { is_active: active })
      }
    }
    setSequences(prev => prev.map(s => selectedIds.has(s.id) ? { ...s, is_active: active } : s))
    setSelectedIds(new Set())
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

  const handleToggleActive = useCallback(async (seq: CampaignSequence) => {
    const next = !seq.is_active
    setSequences(prev => prev.map(s => s.id === seq.id ? { ...s, is_active: next } : s))
    await updateCampaignSequence(seq.id, { is_active: next })
  }, [])

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
        <div className="rounded-lg border border-dashed border-border py-20 text-center space-y-2">
          <p className="text-sm font-medium text-foreground">No sequences yet</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            {pageType === "marketing"
              ? "Create event-triggered automations that fire when listings go live, prices drop, or deals close."
              : "Build multi-touch nurture sequences for buyers, sellers, and leads — email, SMS, voice drop, and AI calls."}
          </p>
          <Button size="sm" className="gap-1.5 mt-2" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            New Sequence
          </Button>
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
                onEdit={() => router.push(`/dashboard/campaigns/sequences/${seq.id}`)}
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
              <Select value={form.trigger_event} onValueChange={v => setForm(p => ({ ...p, trigger_event: v }))}>
                <SelectTrigger id="seq-trigger">
                  <SelectValue placeholder="Select a trigger (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_EVENTS.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
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

// Re-export constants so builder can reuse them
export { TRIGGER_EVENTS, SEQUENCE_TYPES, CHANNEL_ICONS }
