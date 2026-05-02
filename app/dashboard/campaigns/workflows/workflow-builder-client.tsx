"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
  { value: "email",       label: "Send Email",        icon: Mail,          color: "bg-blue-100 text-blue-700" },
  { value: "sms",         label: "Send SMS",          icon: MessageSquare, color: "bg-green-100 text-green-700" },
  { value: "direct_mail", label: "Send Direct Mail",  icon: FileText,      color: "bg-amber-100 text-amber-700" },
  { value: "wait",        label: "Wait",              icon: Clock,         color: "bg-gray-100 text-gray-600" },
  { value: "condition",   label: "Condition",         icon: GitBranch,     color: "bg-purple-100 text-purple-700" },
] as const

const TRIGGER_EVENTS = [
  { value: "contact_created",         label: "Contact Created" },
  { value: "listing_appointment_set", label: "Listing Appointment Scheduled" },
  { value: "showing_completed",       label: "Showing Completed" },
  { value: "offer_submitted",         label: "Offer Submitted" },
  { value: "under_contract",          label: "Under Contract" },
  { value: "transaction_closed",      label: "Transaction Closed" },
  { value: "manual",                  label: "Manual Enrollment" },
  { value: "open_house_attended",     label: "Open House Attended" },
]

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
              <Select value={triggerEvent} onValueChange={setTriggerEvent}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_EVENTS.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>
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
                  <p className="text-xs font-medium">Condition</p>
                  <div className="grid grid-cols-3 gap-2">
                    <Input
                      placeholder="Field"
                      className="text-xs"
                      value={editingStep.condition_field ?? ""}
                      onChange={(e) => {
                        setEditingStep({ ...editingStep, condition_field: e.target.value })
                        updateLocalStep(editingIndex, { condition_field: e.target.value })
                      }}
                    />
                    <Select
                      value={editingStep.condition_operator ?? "equals"}
                      onValueChange={(v) => {
                        setEditingStep({ ...editingStep, condition_operator: v })
                        updateLocalStep(editingIndex, { condition_operator: v })
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="equals" className="text-xs">equals</SelectItem>
                        <SelectItem value="not_equals" className="text-xs">not equals</SelectItem>
                        <SelectItem value="contains" className="text-xs">contains</SelectItem>
                        <SelectItem value="is_true" className="text-xs">is true</SelectItem>
                        <SelectItem value="is_false" className="text-xs">is false</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder="Value"
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
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditingStep(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
