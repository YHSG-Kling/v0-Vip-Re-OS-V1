"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { WORKFLOW_TRIGGERS, toTriggerSelectValue, fromTriggerSelectValue } from "@/lib/workflow/triggers"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  Mail,
  MessageSquare,
  Clock,
  GitBranch,
  Trash2,
  Plus,
  Save,
  Rocket,
  GripVertical,
  ArrowLeft,
  FileText,
  CheckSquare,
  Tag,
  UserMinus,
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

const STEP_TYPES = [
  { value: "email",                 label: "Send Email",           icon: Mail,          color: "bg-blue-100 text-blue-700" },
  { value: "sms",                   label: "Send SMS",             icon: MessageSquare, color: "bg-green-100 text-green-700" },
  { value: "direct_mail",           label: "Send Direct Mail",     icon: FileText,      color: "bg-amber-100 text-amber-700" },
  { value: "wait",                  label: "Wait",                 icon: Clock,         color: "bg-gray-100 text-gray-600" },
  { value: "condition",             label: "Condition",            icon: GitBranch,     color: "bg-purple-100 text-purple-700" },
  { value: "assign_task",           label: "Assign Task",          icon: CheckSquare,   color: "bg-orange-100 text-orange-700" },
  { value: "add_to_segment",        label: "Add to Segment",       icon: Tag,           color: "bg-teal-100 text-teal-700" },
  { value: "remove_from_campaign",  label: "Remove from Campaign", icon: UserMinus,     color: "bg-red-100 text-red-600" },
] as const

// Canonical trigger catalog (KernelEvent-derived WORKFLOW_TRIGGERS) — only triggers that an emitted
// event actually matches. Previously a hardcoded list with values like "showing_completed" /
// "open_house_attended" that no event ever emits, so those selections were silently dead.
const TRIGGER_EVENTS = WORKFLOW_TRIGGERS.map(t => ({ value: t.value, label: t.label }))

type StepChannel = typeof STEP_TYPES[number]["value"]

interface LocalStep {
  id?: string
  step_number: number
  step_name: string
  channel: StepChannel
  delay_days: number
  delay_hours: number
  subject?: string
  body?: string
  condition_field?: string
  condition_operator?: string
  condition_value?: string
  task_description?: string
  segment_name?: string
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
      step_name: STEP_TYPES.find((t) => t.value === channel)?.label ?? "Step",
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
        await updateCampaignSequence(sid, {
          name: name.trim(),
          description: description.trim() || undefined,
          trigger_event: triggerEvent,
        })
      }

      // Save steps
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]
        if (s.isNew || !s.id) {
          const res = await createSequenceStep({
            sequence_id: sid,
            step_number: i + 1,
            step_name: s.step_name,
            channel: s.channel,
            delay_days: s.delay_days,
            delay_hours: s.delay_hours,
            subject: s.subject || undefined,
            body: s.body || undefined,
          })
          if (res.step) {
            setSteps((prev) => prev.map((ps, pi) => pi === i ? { ...ps, id: res.step!.id, isNew: false } : ps))
          }
        } else {
          await updateSequenceStep(s.id, sid, {
            step_name: s.step_name,
            channel: s.channel,
            delay_days: s.delay_days,
            delay_hours: s.delay_hours,
            subject: s.subject || undefined,
            body: s.body || undefined,
            condition_field: s.condition_field || undefined,
            condition_operator: s.condition_operator || undefined,
            condition_value: s.condition_value || undefined,
          })
        }
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

  const stepTypeInfo = (channel: StepChannel) =>
    STEP_TYPES.find((t) => t.value === channel) ?? STEP_TYPES[0]

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
                  <SelectItem value="drip" className="text-xs">Drip sequence</SelectItem>
                  <SelectItem value="nurture" className="text-xs">Nurture campaign</SelectItem>
                  <SelectItem value="onboarding" className="text-xs">Onboarding</SelectItem>
                  <SelectItem value="retention" className="text-xs">Retention</SelectItem>
                  <SelectItem value="event" className="text-xs">Event-based</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium mb-2 text-muted-foreground uppercase tracking-wide">Add step</p>
            <div className="space-y-1.5">
              {STEP_TYPES.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.value}
                    onClick={() => addStep(t.value)}
                    className="w-full flex items-center gap-2.5 rounded-md border bg-background px-3 py-2 text-xs hover:bg-muted transition-colors text-left"
                  >
                    <span className={cn("rounded p-1", t.color)}>
                      <Icon className="h-3 w-3" />
                    </span>
                    {t.label}
                  </button>
                )
              })}
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
                <Label className="text-xs mb-1 block">Channel</Label>
                <Select
                  value={editingStep.channel}
                  onValueChange={(v) => {
                    const ch = v as StepChannel
                    const updated = { ...editingStep, channel: ch }
                    setEditingStep(updated)
                    updateLocalStep(editingIndex, { channel: ch })
                  }}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STEP_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              {(editingStep.channel === "email" || editingStep.channel === "sms" || editingStep.channel === "direct_mail") && (
                <>
                  {editingStep.channel === "email" && (
                    <div>
                      <Label className="text-xs mb-1 block">Subject line</Label>
                      <Input
                        value={editingStep.subject ?? ""}
                        onChange={(e) => {
                          setEditingStep({ ...editingStep, subject: e.target.value })
                          updateLocalStep(editingIndex, { subject: e.target.value })
                        }}
                        placeholder="Email subject…"
                      />
                    </div>
                  )}
                  <div>
                    <Label className="text-xs mb-1 block">
                      {editingStep.channel === "email" ? "Email body" : editingStep.channel === "sms" ? "SMS message" : "Mail copy"}
                    </Label>
                    <Textarea
                      rows={6}
                      value={editingStep.body ?? ""}
                      onChange={(e) => {
                        setEditingStep({ ...editingStep, body: e.target.value })
                        updateLocalStep(editingIndex, { body: e.target.value })
                      }}
                      placeholder="Message content… Use {{first_name}}, {{agent_name}}, {{property_address}} as variables"
                    />
                  </div>
                </>
              )}
              {editingStep.channel === "condition" && (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <p className="text-xs font-medium">Condition (if/then branch)</p>
                  <div className="grid grid-cols-3 gap-2">
                    <Select
                      value={editingStep.condition_field ?? "email_opened"}
                      onValueChange={(v) => {
                        setEditingStep({ ...editingStep, condition_field: v })
                        updateLocalStep(editingIndex, { condition_field: v })
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="email_opened" className="text-xs">Opened email</SelectItem>
                        <SelectItem value="replied" className="text-xs">Replied to message</SelectItem>
                        <SelectItem value="stage_changed" className="text-xs">Stage changed</SelectItem>
                        <SelectItem value="tag" className="text-xs">Has tag</SelectItem>
                        <SelectItem value="contact_type" className="text-xs">Contact type</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={editingStep.condition_operator ?? "is_true"}
                      onValueChange={(v) => {
                        setEditingStep({ ...editingStep, condition_operator: v })
                        updateLocalStep(editingIndex, { condition_operator: v })
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="is_true" className="text-xs">is true</SelectItem>
                        <SelectItem value="is_false" className="text-xs">is false</SelectItem>
                        <SelectItem value="equals" className="text-xs">equals</SelectItem>
                        <SelectItem value="not_equals" className="text-xs">not equals</SelectItem>
                        <SelectItem value="contains" className="text-xs">contains</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder="Value (if applicable)"
                      className="text-xs"
                      value={editingStep.condition_value ?? ""}
                      onChange={(e) => {
                        setEditingStep({ ...editingStep, condition_value: e.target.value })
                        updateLocalStep(editingIndex, { condition_value: e.target.value })
                      }}
                    />
                  </div>
                </div>
              )}
              {editingStep.channel === "assign_task" && (
                <div className="space-y-2">
                  <Label className="text-xs mb-1 block">Task description</Label>
                  <Textarea
                    rows={3}
                    placeholder="Describe the task to assign to the agent… e.g., 'Call contact to confirm appointment'"
                    value={editingStep.task_description ?? ""}
                    onChange={(e) => {
                      setEditingStep({ ...editingStep, task_description: e.target.value })
                      updateLocalStep(editingIndex, { task_description: e.target.value })
                    }}
                  />
                  <p className="text-xs text-muted-foreground">The task will appear in the agent's task queue with a due date equal to the step's wait duration.</p>
                </div>
              )}
              {editingStep.channel === "add_to_segment" && (
                <div className="space-y-2">
                  <Label className="text-xs mb-1 block">Segment name or ID</Label>
                  <Input
                    placeholder="e.g., hot-leads, post-close-followup"
                    value={editingStep.segment_name ?? ""}
                    onChange={(e) => {
                      setEditingStep({ ...editingStep, segment_name: e.target.value })
                      updateLocalStep(editingIndex, { segment_name: e.target.value })
                    }}
                  />
                  <p className="text-xs text-muted-foreground">The contact will be added to this segment when this step runs.</p>
                </div>
              )}
              {editingStep.channel === "remove_from_campaign" && (
                <div className="rounded-lg border bg-amber-50 p-3 text-xs text-amber-800">
                  When this step runs, the contact will be unenrolled from this workflow and no further steps will execute. Use as a terminal exit node (e.g., after a conversion goal is met).
                </div>
              )}
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
                      {step.task_description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">Task: {step.task_description}</p>
                      )}
                      {step.segment_name && (
                        <p className="text-xs text-muted-foreground mt-0.5">→ Segment: <strong>{step.segment_name}</strong></p>
                      )}
                      {step.condition_field && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          If {step.condition_field} {step.condition_operator} {step.condition_value || "—"}
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
