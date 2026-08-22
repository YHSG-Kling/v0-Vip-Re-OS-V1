"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { WORKFLOW_TRIGGERS, toTriggerSelectValue, fromTriggerSelectValue } from "@/lib/workflow/triggers"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Trash2,
  Plus,
  Save,
  Rocket,
  GripVertical,
  ArrowLeft,
  Eye,
} from "lucide-react"
import { toast } from "sonner"
import {
  createCampaignSequence,
  updateCampaignSequence,
  createSequenceStep,
  updateSequenceStep,
  deleteSequenceStep,
  launchCampaignSequence,
} from "@/app/actions/campaign-sequences"
import { cn } from "@/lib/utils"
import { StepTypeSelect, StepTypeDescription, stepIcon } from "@/app/components/campaigns/step-type-select"
import { StepFieldsEditor } from "@/app/components/campaigns/step-fields-editor"
import { STEP_PALETTE, paletteByGroup, stepSpec, type StepGroup } from "@/lib/workflow/step-palette"

// The step list comes from lib/workflow/step-palette.ts. It was a local array of
// eight here while the sequence builder kept its own array of seven — and both
// edit the SAME campaign_sequence_steps rows, so a step created in one was
// invisible in the other and eleven registered adapters had no UI anywhere.
//
// Group tint for the "Add step" rail: colour by what the step DOES, so a
// "Produce an asset" step (which contacts nobody) never looks like a send.
const GROUP_COLOR: Record<StepGroup, string> = {
  deliver:  "bg-blue-100 text-blue-700",
  publish:  "bg-teal-100 text-teal-700",
  produce:  "bg-purple-100 text-purple-700",
  transact: "bg-amber-100 text-amber-700",
  flow:     "bg-gray-100 text-gray-600",
}

// Canonical trigger catalog (KernelEvent-derived WORKFLOW_TRIGGERS) — only triggers that an emitted
// event actually matches. Previously a hardcoded list with values like "showing_completed" /
// "open_house_attended" that no event ever emits, so those selections were silently dead.
const TRIGGER_EVENTS = WORKFLOW_TRIGGERS.map(t => ({ value: t.value, label: t.label }))

/** Any channel the shared palette offers — which is exactly what the CHECK admits. */
type StepChannel = string

interface LocalStep {
  // Carries whatever the selected step type declares in the shared palette; the
  // named fields below are just the ones this file touches directly.
  [field: string]: unknown
  id?: string
  step_number: number
  step_name: string
  channel: StepChannel
  delay_days: number
  delay_hours: number
  subject?: string
  body?: string
  isNew?: boolean
}

interface Props {
  brokerageId: string
  userId: string
  userType: string
  initialSequence: any
  initialSteps: any[]
}

export function WorkflowBuilderClient({ brokerageId, userId, userType, initialSequence, initialSteps }: Props) {
  const router = useRouter()

  const [sequenceId, setSequenceId] = useState<string | null>(initialSequence?.id ?? null)
  const [name, setName] = useState(initialSequence?.name ?? "")
  const [description, setDescription] = useState(initialSequence?.description ?? "")
  const [triggerEvent, setTriggerEvent] = useState(initialSequence?.trigger_event ?? "manual")
  const [sequenceType, setSequenceType] = useState(initialSequence?.sequence_type ?? "drip")
  const [isActive, setIsActive] = useState(initialSequence?.is_active ?? false)
  const [steps, setSteps] = useState<LocalStep[]>(
    initialSteps.map((s) => ({
      id: s.id,
      step_number: s.step_number,
      step_name: s.step_name,
      channel: s.channel as StepChannel,
      delay_days: s.delay_days ?? 0,
      delay_hours: s.delay_hours ?? 0,
      subject: s.subject ?? "",
      body: s.body ?? "",
      condition_field: s.condition_field ?? "",
      condition_operator: s.condition_operator ?? "",
      condition_value: s.condition_value ?? "",
    }))
  )
  const [editingStep, setEditingStep] = useState<LocalStep | null>(null)
  const [saving, setSaving] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  function addStep(channel: StepChannel) {
    const newStep: LocalStep = {
      step_number: steps.length + 1,
      step_name: stepSpec(channel)?.label ?? "Step",
      channel,
      delay_days: steps.length === 0 ? 0 : 1,
      delay_hours: 0,
      subject: "",
      body: "",
      isNew: true,
    }
    setSteps([...steps, newStep])
    setEditingStep(newStep)
  }

  async function removeStep(index: number) {
    const step = steps[index]
    if (step.id && sequenceId) {
      const res = await deleteSequenceStep(step.id, sequenceId)
      if (!res.success) { toast.error(res.error ?? "Failed to delete step"); return }
    }
    const updated = steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, step_number: i + 1 }))
    setSteps(updated)
    toast.success("Step removed")
  }

  function updateLocalStep(index: number, updates: Partial<LocalStep>) {
    setSteps(steps.map((s, i) => i === index ? { ...s, ...updates } : s))
  }

  async function saveWorkflow() {
    if (!name.trim()) { toast.error("Workflow name is required"); return }
    setSaving(true)
    try {
      let sid = sequenceId

      if (!sid) {
        const res = await createCampaignSequence({
          brokerageId,
          name: name.trim(),
          description: description.trim() || undefined,
          sequence_type: sequenceType,
          trigger_event: triggerEvent,
        })
        if (res.error || !res.sequence?.id) {
          toast.error(res.error ?? "Failed to create workflow"); return
        }
        sid = res.sequence.id
        setSequenceId(sid)
      } else {
        // The create path above checks its result and aborts; this one discarded
        // it entirely. Changing an existing workflow's trigger to a value the
        // column refuses reported "Workflow saved" and changed nothing — the
        // trigger silently stayed whatever it was, so the workflow kept firing on
        // the old signal (or never firing at all).
        const res = await updateCampaignSequence(sid, {
          name: name.trim(),
          description: description.trim() || undefined,
          trigger_event: triggerEvent,
        })
        if (res?.error) {
          toast.error(res.error); return
        }
      }

      // Save steps
      let stepFailed = false
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]
        // Send the WHOLE step. The actions take the palette as their allow-list,
        // so every per-channel field the editor collected is persisted and
        // nothing outside the palette can reach a column. Listing the fields
        // here by hand is what dropped an ad budget or a gift occasion on save.
        const { id: _id, isNew: _isNew, step_number: _n, ...fields } = s
        if (s.isNew || !s.id) {
          const res = await createSequenceStep({
            ...fields,
            sequence_id: sid,
            step_number: i + 1,
            step_name: s.step_name,
            channel: s.channel,
            delay_days: s.delay_days,
            delay_hours: s.delay_hours,
            subject: s.subject || undefined,
            body: s.body || undefined,
          })
          if (res.error) { toast.error(res.error); stepFailed = true }
          if (res.step) {
            setSteps((prev) => prev.map((ps, pi) => pi === i ? { ...ps, id: res.step!.id, isNew: false } : ps))
          }
        } else {
          const res = await updateSequenceStep(s.id, sid, {
            ...fields,
            step_name: s.step_name,
            channel: s.channel,
            delay_days: s.delay_days,
            delay_hours: s.delay_hours,
            subject: s.subject || undefined,
            body: s.body || undefined,
          })
          if (res.error) { toast.error(res.error); stepFailed = true }
        }
      }

      // A step that failed to save used to be toasted and then immediately
      // contradicted by "Workflow saved" — and the redirect took the agent away
      // from the editor holding the only copy of the step that did not persist.
      if (stepFailed) {
        toast.error("Some steps did not save — fix the errors above before leaving this page.")
        return
      }

      toast.success("Workflow saved")
      router.push(`/dashboard/campaigns/workflows?id=${sid}`)
    } finally {
      setSaving(false)
    }
  }

  async function launchWorkflow() {
    if (!sequenceId) { toast.error("Save the workflow first"); return }
    if (steps.length === 0) { toast.error("Add at least one step before launching"); return }
    setLaunching(true)
    try {
      const res = await launchCampaignSequence(sequenceId)
      if (res.success) {
        setIsActive(true)
        toast.success("Workflow is now active and will enroll contacts automatically")
      } else {
        toast.error(res.error ?? "Failed to launch workflow")
      }
    } finally {
      setLaunching(false)
    }
  }

  // Falls back to the palette's first entry only so the canvas can still render a
  // row whose channel predates the palette — never so a bad value looks valid.
  const stepTypeInfo = (channel: StepChannel) => {
    const spec = stepSpec(channel) ?? STEP_PALETTE[0]
    return {
      value: spec.channel,
      label: spec.label,
      icon: stepIcon(spec.channel),
      color: GROUP_COLOR[spec.group],
      description: spec.description,
    }
  }

  const editingIndex = editingStep ? steps.findIndex((s) => s === editingStep || (s.step_number === editingStep?.step_number && !s.id)) : -1

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b bg-background px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/campaigns/sequences")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Workflow Builder</h1>
            <p className="text-xs text-muted-foreground">
              {isActive ? (
                <span className="text-emerald-600 font-medium">Active</span>
              ) : (
                <span className="text-amber-600">Draft</span>
              )}{" "}
              · {steps.length} step{steps.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {steps.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setShowPreview(true)} className="gap-2">
              <Eye className="h-3.5 w-3.5" />
              Preview
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={saveWorkflow} disabled={saving} className="gap-2">
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
          {!isActive && (
            <Button size="sm" onClick={launchWorkflow} disabled={launching || !sequenceId} className="gap-2">
              <Rocket className="h-3.5 w-3.5" />
              {launching ? "Launching…" : "Launch"}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Sequence settings */}
        <aside className="w-72 border-r bg-muted/20 overflow-y-auto p-5 space-y-5 shrink-0">
          <div className="space-y-3">
            <div>
              <Label className="text-xs mb-1 block">Workflow name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Post-Close Follow-up" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this workflow do?" rows={2} />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Trigger</Label>
              <Select
                value={toTriggerSelectValue(triggerEvent)}
                onValueChange={(v) => setTriggerEvent(fromTriggerSelectValue(v))}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_EVENTS.map((t) => (
                    <SelectItem key={toTriggerSelectValue(t.value)} value={toTriggerSelectValue(t.value)} className="text-xs">{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Type</Label>
              <Select value={sequenceType} onValueChange={setSequenceType}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* campaign_sequences.sequence_type admits exactly: drip |
                      nurture | post_close | re_engagement | transaction. Three
                      of the five options here (onboarding, retention, event)
                      were not among them, so choosing any of them produced a
                      workflow the database refused to save — while post_close
                      and re_engagement, the two the business actually runs,
                      could not be chosen at all. */}
                  <SelectItem value="drip" className="text-xs">Drip sequence</SelectItem>
                  <SelectItem value="nurture" className="text-xs">Nurture campaign</SelectItem>
                  <SelectItem value="transaction" className="text-xs">Transaction</SelectItem>
                  <SelectItem value="post_close" className="text-xs">Post-close</SelectItem>
                  <SelectItem value="re_engagement" className="text-xs">Re-engagement</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium mb-2 text-muted-foreground uppercase tracking-wide">Add step</p>
            <div className="space-y-3">
              {paletteByGroup().map((group) => (
                <div key={group.group} className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    {group.label}
                  </p>
                  {group.steps.map((s) => {
                    const Icon = stepIcon(s.channel)
                    return (
                      <button
                        key={s.channel}
                        onClick={() => addStep(s.channel)}
                        title={s.description}
                        className="w-full flex items-center gap-2.5 rounded-md border bg-background px-3 py-2 text-xs hover:bg-muted transition-colors text-left"
                      >
                        <span className={cn("rounded p-1", GROUP_COLOR[s.group])}>
                          <Icon className="h-3 w-3" />
                        </span>
                        {s.label}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Center: Step canvas */}
        <main className="flex-1 overflow-y-auto p-6">
          {steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="rounded-full bg-muted p-4 mb-4">
                <Plus className="h-8 w-8 text-muted-foreground" />
              </div>
              <p className="font-medium mb-1">No steps yet</p>
              <p className="text-sm text-muted-foreground max-w-xs">
                Add your first step from the panel on the left. Each step runs in sequence after the previous one completes.
              </p>
            </div>
          ) : (
            <div className="space-y-3 max-w-xl mx-auto">
              {steps.map((step, index) => {
                const info = stepTypeInfo(step.channel)
                const Icon = info.icon
                return (
                  <div key={`step-${index}`} className="relative">
                    <Card
                      className={cn(
                        "cursor-pointer transition-colors hover:border-primary/50",
                        editingIndex === index && "border-primary"
                      )}
                      onClick={() => setEditingStep(step)}
                    >
                      <CardContent className="flex items-center gap-3 p-4">
                        <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className={cn("rounded p-1.5 shrink-0", info.color)}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{step.step_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {step.delay_days > 0 || step.delay_hours > 0
                              ? `Wait ${step.delay_days}d ${step.delay_hours}h, then `
                              : "Immediately — "}
                            {info.label.toLowerCase()}
                          </p>
                          {step.subject && (
                            <p className="text-xs text-muted-foreground truncate">Subject: {step.subject}</p>
                          )}
                        </div>
                        <Badge variant="outline" className="text-xs shrink-0">
                          Step {step.step_number}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); removeStep(index) }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </CardContent>
                    </Card>
                    {index < steps.length - 1 && (
                      <div className="flex justify-center my-1">
                        <div className="w-px h-4 bg-border" />
                      </div>
                    )}
                  </div>
                )
              })}

              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 text-xs"
                  onClick={() => addStep("email")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add step
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Step edit dialog */}
      <Dialog
        open={!!editingStep}
        onOpenChange={(open) => { if (!open) setEditingStep(null) }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">Edit step</DialogTitle>
          </DialogHeader>
          {editingStep && editingIndex >= 0 && (
            <div className="space-y-4">
              <div>
                <Label className="text-xs mb-1 block">Step name</Label>
                <Input
                  value={editingStep.step_name}
                  onChange={(e) => {
                    const updated = { ...editingStep, step_name: e.target.value }
                    setEditingStep(updated)
                    updateLocalStep(editingIndex, { step_name: e.target.value })
                  }}
                />
              </div>
              <div>
                <Label className="text-xs mb-1 block">Step type</Label>
                <StepTypeSelect
                  value={editingStep.channel}
                  onChange={(ch) => {
                    const updated = { ...editingStep, channel: ch }
                    setEditingStep(updated)
                    updateLocalStep(editingIndex, { channel: ch })
                  }}
                />
                <div className="mt-1">
                  <StepTypeDescription channel={editingStep.channel} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs mb-1 block">Wait days</Label>
                  <Input
                    type="number"
                    min={0}
                    value={editingStep.delay_days}
                    onChange={(e) => {
                      const v = Math.max(0, parseInt(e.target.value) || 0)
                      setEditingStep({ ...editingStep, delay_days: v })
                      updateLocalStep(editingIndex, { delay_days: v })
                    }}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Wait hours</Label>
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={editingStep.delay_hours}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(23, parseInt(e.target.value) || 0))
                      setEditingStep({ ...editingStep, delay_hours: v })
                      updateLocalStep(editingIndex, { delay_hours: v })
                    }}
                  />
                </div>
              </div>
              {/* Per-step fields, rendered from lib/workflow/step-palette.ts.
                  These used to be hand-written per channel, and only for the
                  eight this builder knew about. Two of them wrote to columns
                  that do not exist — task_description and segment_name — so
                  every "Task description" and "Segment name" a broker typed was
                  dropped on save. The real columns are task_title /
                  task_notes_prompt, and the segment adapter reads body. */}
              <StepFieldsEditor
                channel={editingStep.channel}
                values={editingStep as unknown as Record<string, unknown>}
                onChange={(name, value) => {
                  const updated = { ...editingStep, [name]: value }
                  setEditingStep(updated)
                  updateLocalStep(editingIndex, { [name]: value })
                }}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditingStep(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Workflow preview dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Workflow Timeline Preview
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1 py-2">
            <p className="text-xs text-muted-foreground mb-3">
              Simulated timeline for a contact enrolled at Day 0. Trigger: <strong>{TRIGGER_EVENTS.find(t => t.value === triggerEvent)?.label ?? triggerEvent}</strong>
            </p>
            {(() => {
              let cumulativeDays = 0
              return steps.map((step, idx) => {
                const dayOffset = cumulativeDays
                cumulativeDays += step.delay_days + (step.delay_hours > 0 ? 1 : 0)
                const info = stepTypeInfo(step.channel)
                const Icon = info.icon
                return (
                  <div key={idx} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className={cn("rounded p-1.5 mt-0.5 shrink-0", info.color)}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      {idx < steps.length - 1 && <div className="w-px flex-1 bg-border my-1" />}
                    </div>
                    <div className="pb-4 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium">{step.step_name}</span>
                        <Badge variant="outline" className="text-[10px] py-0 h-4">
                          Day {dayOffset}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {step.delay_days > 0 || step.delay_hours > 0
                          ? `After ${step.delay_days > 0 ? `${step.delay_days}d ` : ""}${step.delay_hours > 0 ? `${step.delay_hours}h` : ""}:`
                          : "Immediately:"}
                        {" "}{info.label.toLowerCase()}
                      </p>
                      {step.subject && (
                        <p className="text-xs text-muted-foreground italic mt-0.5 truncate">
                          Subject: "{step.subject}"
                        </p>
                      )}
                      {/* The real columns: task_title (not task_description) and
                          body for the segment (not segment_name). The previews
                          below read what the step actually stores. */}
                      {!!step.task_title && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">Task: {String(step.task_title)}</p>
                      )}
                      {step.channel === "add_to_segment" && !!step.body && (
                        <p className="text-xs text-muted-foreground mt-0.5">→ Segment: <strong>{String(step.body)}</strong></p>
                      )}
                      {!!step.condition_field && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          If {String(step.condition_field)} {String(step.condition_operator ?? "")} {String(step.condition_value || "—")}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })
            })()}
            <div className="border-t pt-3 mt-1">
              <p className="text-xs text-muted-foreground">
                Total estimated duration: <strong>{steps.reduce((d, s) => d + s.delay_days + (s.delay_hours > 0 ? 1 : 0), 0)} days</strong> · {steps.length} steps
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setShowPreview(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
