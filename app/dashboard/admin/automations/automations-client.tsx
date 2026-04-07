"use client"

import { useState, useTransition } from "react"
import { cn } from "@/lib/utils"
import {
  Zap,
  Plus,
  Play,
  Trash2,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  ToggleLeft,
  ToggleRight,
  ChevronRight,
  X,
  ArrowLeft,
} from "lucide-react"
import { createWorkflowAutomation, executeWorkflow } from "@/app/actions/multi-persona"
import { retryFailedWorkflow } from "@/app/actions/workflows"
import { createClient } from "@/lib/supabase/client"

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkflowAutomation {
  id: string
  workflow_name: string
  workflow_type: string
  trigger_event: string
  trigger_conditions: unknown
  actions: ActionDef[]
  assigned_to_role: string
  created_by: string
  is_active: boolean
  execution_count: number
  last_executed_at: string | null
  created_at: string
}

interface AutomationError {
  id: string
  workflow_name: string
  error_message: string
  severity: "critical" | "high" | "medium" | "low"
  status: string
  context_json?: string
  created_at: string
  resolved_at: string | null
}

interface ActionDef {
  type: string
  [key: string]: unknown
}

interface Props {
  automations: WorkflowAutomation[]
  recentErrors: AutomationError[]
  brokerageId: string
  currentUserId: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TRIGGER_EVENTS = [
  { value: "new_lead_arrives",        label: "New Lead Arrives" },
  { value: "lead_qualified",          label: "Lead Qualified" },
  { value: "contact_stale",           label: "Contact Goes Stale" },
  { value: "offer_submitted",         label: "Offer Submitted" },
  { value: "showing_scheduled",       label: "Showing Scheduled" },
  { value: "transaction_milestone",   label: "Transaction Milestone" },
  { value: "date_anniversary",        label: "Date / Anniversary" },
]

const ACTION_TYPES = [
  { value: "send_email",          label: "Send Email" },
  { value: "send_sms",            label: "Send SMS" },
  { value: "create_task",         label: "Create Task" },
  { value: "assign_agent",        label: "Assign Agent" },
  { value: "add_to_sequence",     label: "Add to Sequence" },
  { value: "notify_admin",        label: "Notify Admin" },
  { value: "update_field",        label: "Update Field" },
  { value: "send_portal_message", label: "Send Portal Message" },
]

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high:     "bg-orange-100 text-orange-700 border-orange-200",
  medium:   "bg-amber-100 text-amber-700 border-amber-200",
  low:      "bg-slate-100 text-slate-700 border-slate-200",
}

const TRIGGER_BADGE_COLORS: Record<string, string> = {
  new_lead_arrives:       "bg-emerald-100 text-emerald-700",
  lead_qualified:         "bg-blue-100 text-blue-700",
  contact_stale:          "bg-amber-100 text-amber-700",
  offer_submitted:        "bg-purple-100 text-purple-700",
  showing_scheduled:      "bg-cyan-100 text-cyan-700",
  transaction_milestone:  "bg-indigo-100 text-indigo-700",
  date_anniversary:       "bg-pink-100 text-pink-700",
}

// ─── Toast helper ─────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<{ msg: string; variant: "success" | "error" } | null>(null)

  function show(msg: string, variant: "success" | "error" = "success") {
    setToast({ msg, variant })
    setTimeout(() => setToast(null), 3500)
  }

  return { toast, show }
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AutomationsClient({ automations: initial, recentErrors: initialErrors, brokerageId, currentUserId }: Props) {
  const [automations, setAutomations] = useState<WorkflowAutomation[]>(initial)
  const [errors, setErrors] = useState<AutomationError[]>(initialErrors)
  const [activeTab, setActiveTab] = useState<"automations" | "errors">("automations")
  const [showSheet, setShowSheet] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { toast, show } = useToast()

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    if (!confirm("Delete this automation? This cannot be undone.")) return
    const supabase = createClient()
    await supabase.from("workflow_automations").delete().eq("id", id)
    setAutomations((prev) => prev.filter((a) => a.id !== id))
    show("Automation deleted")
  }

  // ── Toggle active ───────────────────────────────────────────────────────────

  async function handleToggle(id: string, current: boolean) {
    const supabase = createClient()
    await supabase.from("workflow_automations").update({ is_active: !current }).eq("id", id)
    setAutomations((prev) => prev.map((a) => a.id === id ? { ...a, is_active: !current } : a))
    show(`Automation ${!current ? "enabled" : "disabled"}`)
  }

  // ── Run now ──────────────────────────────────────────────────────────────────

  function handleRunNow(id: string) {
    startTransition(async () => {
      const result = await executeWorkflow(id, { brokerageId })
      if (result.success) {
        show("Workflow triggered manually")
        setAutomations((prev) =>
          prev.map((a) => a.id === id ? { ...a, execution_count: (a.execution_count ?? 0) + 1, last_executed_at: new Date().toISOString() } : a)
        )
      } else {
        show(result.reason ?? "Failed to trigger workflow", "error")
      }
    })
  }

  // ── Retry error ──────────────────────────────────────────────────────────────

  function handleRetry(err: AutomationError) {
    startTransition(async () => {
      show("Retrying...")
      const result = await retryFailedWorkflow(err.id, err.workflow_name, err.context_json ?? "{}")
      if (result.success) {
        show("Retry succeeded — error resolved")
        setErrors((prev) => prev.map((e) => e.id === err.id ? { ...e, status: "resolved" } : e))
      } else {
        show(result.error ?? "Retry failed", "error")
      }
    })
  }

  // ── Mark resolved ────────────────────────────────────────────────────────────

  async function handleMarkResolved(id: string) {
    const supabase = createClient()
    await supabase
      .from("automation_errors")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", id)
    setErrors((prev) => prev.map((e) => e.id === id ? { ...e, status: "resolved" } : e))
    show("Marked as resolved")
  }

  // ── New automation created ───────────────────────────────────────────────────

  function handleCreated(automation: WorkflowAutomation) {
    setAutomations((prev) => [automation, ...prev])
    setShowSheet(false)
    show("Automation created and active")
  }

  const unresolvedErrors = errors.filter((e) => e.status !== "resolved")

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg transition-all",
            toast.variant === "error"
              ? "bg-red-50 border-red-200 text-red-700"
              : "bg-emerald-50 border-emerald-200 text-emerald-700",
          )}
        >
          {toast.variant === "error" ? (
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          )}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Workflow Automations</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {automations.length} automation{automations.length !== 1 ? "s" : ""} configured
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowSheet(true)}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Automation
        </button>
      </div>

      {/* Tabs */}
      <div className="border-b border-border bg-card px-6">
        <div className="flex gap-0">
          {(["automations", "errors"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-3 text-sm font-medium border-b-2 transition-colors capitalize",
                activeTab === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab === "errors" ? "Error Log" : "Active Automations"}
              {tab === "errors" && unresolvedErrors.length > 0 && (
                <span className="ml-2 inline-flex items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-bold text-white leading-none">
                  {unresolvedErrors.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {activeTab === "automations" ? (
          <AutomationsTab
            automations={automations}
            isPending={isPending}
            onRunNow={handleRunNow}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        ) : (
          <ErrorLogTab
            errors={errors}
            isPending={isPending}
            onRetry={handleRetry}
            onMarkResolved={handleMarkResolved}
          />
        )}
      </div>

      {/* Create sheet */}
      {showSheet && (
        <CreateAutomationSheet
          brokerageId={brokerageId}
          currentUserId={currentUserId}
          onClose={() => setShowSheet(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}

// ─── Automations Tab ──────────────────────────────────────────────────────────

function AutomationsTab({
  automations,
  isPending,
  onRunNow,
  onToggle,
  onDelete,
}: {
  automations: WorkflowAutomation[]
  isPending: boolean
  onRunNow: (id: string) => void
  onToggle: (id: string, current: boolean) => void
  onDelete: (id: string) => void
}) {
  if (automations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Zap className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <h3 className="text-lg font-semibold mb-1">No automations yet</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          Create your first automation to start running your business on autopilot.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      {automations.map((a) => (
        <AutomationCard
          key={a.id}
          automation={a}
          isPending={isPending}
          onRunNow={onRunNow}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

function AutomationCard({
  automation: a,
  isPending,
  onRunNow,
  onToggle,
  onDelete,
}: {
  automation: WorkflowAutomation
  isPending: boolean
  onRunNow: (id: string) => void
  onToggle: (id: string, current: boolean) => void
  onDelete: (id: string) => void
}) {
  const triggerLabel = TRIGGER_EVENTS.find((t) => t.value === a.trigger_event)?.label ?? a.trigger_event
  const triggerColor = TRIGGER_BADGE_COLORS[a.trigger_event] ?? "bg-muted text-muted-foreground"
  const actionCount = Array.isArray(a.actions) ? a.actions.length : 0

  return (
    <div className={cn("rounded-lg border bg-card p-4 flex flex-col gap-3 transition-opacity", !a.is_active && "opacity-60")}>
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate">{a.workflow_name}</p>
          <span className={cn("mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", triggerColor)}>
            {triggerLabel}
          </span>
        </div>
        <button
          onClick={() => onToggle(a.id, a.is_active)}
          className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 mt-0.5"
          title={a.is_active ? "Disable" : "Enable"}
        >
          {a.is_active ? (
            <ToggleRight className="h-5 w-5 text-primary" />
          ) : (
            <ToggleLeft className="h-5 w-5" />
          )}
        </button>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>{actionCount} action{actionCount !== 1 ? "s" : ""}</span>
        <span>{a.execution_count ?? 0} run{(a.execution_count ?? 0) !== 1 ? "s" : ""}</span>
        {a.last_executed_at && (
          <span>Last: {new Date(a.last_executed_at).toLocaleDateString()}</span>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-1 border-t border-border mt-auto">
        <button
          onClick={() => onRunNow(a.id)}
          disabled={isPending || !a.is_active}
          className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
        >
          <Play className="h-3 w-3" />
          Run Now
        </button>
        <button
          onClick={() => onDelete(a.id)}
          disabled={isPending}
          className="ml-auto flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors"
        >
          <Trash2 className="h-3 w-3" />
          Delete
        </button>
      </div>
    </div>
  )
}

// ─── Error Log Tab ────────────────────────────────────────────────────────────

function ErrorLogTab({
  errors,
  isPending,
  onRetry,
  onMarkResolved,
}: {
  errors: AutomationError[]
  isPending: boolean
  onRetry: (err: AutomationError) => void
  onMarkResolved: (id: string) => void
}) {
  if (errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <CheckCircle2 className="h-12 w-12 text-emerald-400 mb-4" />
        <h3 className="text-lg font-semibold mb-1">No unresolved errors</h3>
        <p className="text-sm text-muted-foreground">All workflow executions are healthy.</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {["Workflow", "Error", "Severity", "Occurred", "Status", "Actions"].map((col) => (
              <th key={col} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {errors.map((err) => (
            <tr key={err.id} className="border-b border-border last:border-0 hover:bg-muted/20">
              <td className="px-4 py-3 font-medium max-w-[180px] truncate">{err.workflow_name}</td>
              <td className="px-4 py-3 text-muted-foreground max-w-[240px]">
                <span className="line-clamp-2">{err.error_message}</span>
              </td>
              <td className="px-4 py-3">
                <span className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
                  SEVERITY_COLORS[err.severity] ?? SEVERITY_COLORS.low,
                )}>
                  {err.severity}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap text-xs">
                {new Date(err.created_at).toLocaleString()}
              </td>
              <td className="px-4 py-3">
                <span className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                  err.status === "resolved"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-700",
                )}>
                  {err.status}
                </span>
              </td>
              <td className="px-4 py-3">
                {err.status !== "resolved" && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onRetry(err)}
                      disabled={isPending}
                      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </button>
                    <button
                      onClick={() => onMarkResolved(err.id)}
                      disabled={isPending}
                      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 disabled:opacity-40 transition-colors"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Resolve
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Create Automation Sheet ──────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4

interface NewAction {
  type: string
  taskTitle?: string
  taskDescription?: string
  priority?: string
  dueDateOffsetDays?: number
  emailTemplate?: string
  fromName?: string
  sequenceName?: string
}

function CreateAutomationSheet({
  brokerageId,
  currentUserId,
  onClose,
  onCreated,
}: {
  brokerageId: string
  currentUserId: string
  onClose: () => void
  onCreated: (a: WorkflowAutomation) => void
}) {
  const [step, setStep] = useState<Step>(1)
  const [trigger, setTrigger] = useState("")
  const [conditions, setConditions] = useState<string[]>([])
  const [conditionInput, setConditionInput] = useState("")
  const [actions, setActions] = useState<NewAction[]>([{ type: "send_email" }])
  const [automationName, setAutomationName] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addCondition() {
    const v = conditionInput.trim()
    if (v && !conditions.includes(v)) setConditions((prev) => [...prev, v])
    setConditionInput("")
  }

  function removeCondition(c: string) {
    setConditions((prev) => prev.filter((x) => x !== c))
  }

  function addAction() {
    setActions((prev) => [...prev, { type: "create_task" }])
  }

  function removeAction(idx: number) {
    setActions((prev) => prev.filter((_, i) => i !== idx))
  }

  function updateAction(idx: number, patch: Partial<NewAction>) {
    setActions((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)))
  }

  async function handleSave() {
    if (!automationName.trim()) { setError("Please enter an automation name"); return }
    if (!trigger) { setError("Please select a trigger"); return }
    if (actions.length === 0) { setError("Please add at least one action"); return }

    setSaving(true)
    setError(null)

    try {
      const payload = actions.map((a) => {
        const base: Record<string, unknown> = { type: a.type }
        if (a.type === "send_email") { base.emailTemplate = a.emailTemplate; base.fromName = a.fromName }
        if (a.type === "create_task") {
          base.taskTitle = a.taskTitle
          base.taskDescription = a.taskDescription
          base.priority = a.priority ?? "medium"
          base.dueDateOffset = a.dueDateOffsetDays ?? 1
        }
        if (a.type === "add_to_sequence") { base.sequenceName = a.sequenceName }
        return base
      })

      const result = await createWorkflowAutomation({
        workflowName: automationName.trim(),
        workflowType: "trigger_based",
        triggerEvent: trigger,
        triggerConditions: conditions.length > 0 ? conditions : null,
        actions: payload,
        assignedToRole: "agent",
        createdBy: currentUserId,
      })

      onCreated(result as WorkflowAutomation)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save automation")
    } finally {
      setSaving(false)
    }
  }

  const STEPS = ["Trigger", "Conditions", "Actions", "Name & Save"]
  const canNext =
    step === 1 ? !!trigger :
    step === 2 ? true :
    step === 3 ? actions.length > 0 :
    !!automationName.trim()

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-background shadow-2xl border-l border-border">
        {/* Sheet header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Zap className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold">New Automation</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step progress */}
        <div className="flex items-center gap-0 border-b border-border px-6 py-3 bg-muted/30">
          {STEPS.map((label, i) => {
            const stepNum = (i + 1) as Step
            const isActive = step === stepNum
            const isDone = step > stepNum
            return (
              <div key={label} className="flex items-center gap-0">
                <button
                  onClick={() => isDone && setStep(stepNum)}
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded transition-colors",
                    isActive && "text-foreground",
                    isDone && "text-primary cursor-pointer hover:underline",
                    !isActive && !isDone && "text-muted-foreground",
                  )}
                >
                  <span className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
                    isActive && "bg-primary text-primary-foreground",
                    isDone && "bg-primary/20 text-primary",
                    !isActive && !isDone && "bg-muted text-muted-foreground",
                  )}>
                    {isDone ? "✓" : stepNum}
                  </span>
                  {label}
                </button>
                {i < STEPS.length - 1 && (
                  <ChevronRight className="h-3 w-3 text-muted-foreground mx-0.5 flex-shrink-0" />
                )}
              </div>
            )
          })}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {step === 1 && (
            <StepTrigger trigger={trigger} onChange={setTrigger} />
          )}
          {step === 2 && (
            <StepConditions
              conditions={conditions}
              conditionInput={conditionInput}
              onInputChange={setConditionInput}
              onAdd={addCondition}
              onRemove={removeCondition}
            />
          )}
          {step === 3 && (
            <StepActions actions={actions} onAdd={addAction} onRemove={removeAction} onUpdate={updateAction} />
          )}
          {step === 4 && (
            <StepNameSave
              name={automationName}
              onChange={setAutomationName}
              trigger={trigger}
              actions={actions}
              conditions={conditions}
            />
          )}

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-6 py-4 flex items-center justify-between gap-3">
          {step > 1 ? (
            <button
              onClick={() => setStep((s) => (s - 1) as Step)}
              disabled={saving}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          ) : (
            <div />
          )}

          {step < 4 ? (
            <button
              onClick={() => setStep((s) => (s + 1) as Step)}
              disabled={!canNext}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={handleSave}
              disabled={saving || !automationName.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving..." : "Save Automation"}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Step 1: Trigger ──────────────────────────────────────────────────────────

function StepTrigger({ trigger, onChange }: { trigger: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Choose a Trigger</h3>
        <p className="text-xs text-muted-foreground">When should this automation fire?</p>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {TRIGGER_EVENTS.map((t) => (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            className={cn(
              "flex items-center justify-between rounded-md border px-4 py-3 text-sm font-medium text-left transition-colors",
              trigger === t.value
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border hover:border-primary/50 hover:bg-muted/50",
            )}
          >
            {t.label}
            {trigger === t.value && <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Step 2: Conditions ───────────────────────────────────────────────────────

function StepConditions({
  conditions,
  conditionInput,
  onInputChange,
  onAdd,
  onRemove,
}: {
  conditions: string[]
  conditionInput: string
  onInputChange: (v: string) => void
  onAdd: () => void
  onRemove: (c: string) => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Add Conditions (Optional)</h3>
        <p className="text-xs text-muted-foreground">
          Filter when this automation fires. Leave empty to run for all matching events.
        </p>
      </div>

      {/* Condition input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={conditionInput}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
          placeholder='e.g. "Lead score > 70"'
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <button
          onClick={onAdd}
          disabled={!conditionInput.trim()}
          className="rounded-md bg-muted px-3 py-2 text-sm font-medium hover:bg-muted/80 disabled:opacity-40 transition-colors"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Chips */}
      {conditions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {conditions.map((c) => (
            <span
              key={c}
              className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
            >
              {c}
              <button onClick={() => onRemove(c)} className="hover:text-red-500 transition-colors">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {conditions.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">No conditions — automation will fire for all matching triggers</p>
        </div>
      )}
    </div>
  )
}

// ─── Step 3: Actions ──────────────────────────────────────────────────────────

function StepActions({
  actions,
  onAdd,
  onRemove,
  onUpdate,
}: {
  actions: NewAction[]
  onAdd: () => void
  onRemove: (idx: number) => void
  onUpdate: (idx: number, patch: Partial<NewAction>) => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Define Actions</h3>
        <p className="text-xs text-muted-foreground">What should happen when this automation fires?</p>
      </div>

      <div className="space-y-3">
        {actions.map((action, idx) => (
          <div key={idx} className="rounded-md border border-border bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Action {idx + 1}
              </label>
              {actions.length > 1 && (
                <button
                  onClick={() => onRemove(idx)}
                  className="text-muted-foreground hover:text-red-500 transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Action type select */}
            <select
              value={action.type}
              onChange={(e) => onUpdate(idx, { type: e.target.value })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {ACTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>

            {/* Conditional fields */}
            {action.type === "send_email" && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={action.emailTemplate ?? ""}
                  onChange={(e) => onUpdate(idx, { emailTemplate: e.target.value })}
                  placeholder="Email template name"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <input
                  type="text"
                  value={action.fromName ?? ""}
                  onChange={(e) => onUpdate(idx, { fromName: e.target.value })}
                  placeholder="From name"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}

            {action.type === "create_task" && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={action.taskTitle ?? ""}
                  onChange={(e) => onUpdate(idx, { taskTitle: e.target.value })}
                  placeholder="Task title"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <div className="flex gap-2">
                  <select
                    value={action.priority ?? "medium"}
                    onChange={(e) => onUpdate(idx, { priority: e.target.value })}
                    className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="low">Low priority</option>
                    <option value="medium">Medium priority</option>
                    <option value="high">High priority</option>
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={action.dueDateOffsetDays ?? 1}
                    onChange={(e) => onUpdate(idx, { dueDateOffsetDays: Number(e.target.value) })}
                    className="w-24 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    title="Due in (days)"
                    placeholder="Days"
                  />
                </div>
                <p className="text-xs text-muted-foreground">Due in {action.dueDateOffsetDays ?? 1} day(s)</p>
              </div>
            )}

            {action.type === "add_to_sequence" && (
              <input
                type="text"
                value={action.sequenceName ?? ""}
                onChange={(e) => onUpdate(idx, { sequenceName: e.target.value })}
                placeholder="Sequence name"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            )}
          </div>
        ))}
      </div>

      <button
        onClick={onAdd}
        className="flex items-center gap-2 w-full justify-center rounded-md border border-dashed border-border py-2.5 text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
      >
        <Plus className="h-4 w-4" />
        Add Another Action
      </button>
    </div>
  )
}

// ─── Step 4: Name & Save ──────────────────────────────────────────────────────

function StepNameSave({
  name,
  onChange,
  trigger,
  actions,
  conditions,
}: {
  name: string
  onChange: (v: string) => void
  trigger: string
  actions: NewAction[]
  conditions: string[]
}) {
  const triggerLabel = TRIGGER_EVENTS.find((t) => t.value === trigger)?.label ?? trigger

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Name Your Automation</h3>
        <p className="text-xs text-muted-foreground">Give it a clear name so you can find it later.</p>
      </div>

      <input
        type="text"
        value={name}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. New Lead Welcome Sequence"
        autoFocus
        className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
      />

      {/* Summary */}
      <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Summary</p>
        <div className="space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-20 flex-shrink-0">Trigger:</span>
            <span className="font-medium">{triggerLabel}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-20 flex-shrink-0">Conditions:</span>
            <span className="font-medium">
              {conditions.length > 0 ? conditions.join(", ") : "None"}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-20 flex-shrink-0">Actions:</span>
            <span className="font-medium">
              {actions.map((a) => ACTION_TYPES.find((t) => t.value === a.type)?.label ?? a.type).join(", ")}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
