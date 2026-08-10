"use client"

import { useState, useCallback, useRef, useMemo } from "react"
import { useRouter } from "next/navigation"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
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
  ArrowLeft,
  Plus,
  GripVertical,
  Mail,
  MessageSquare,
  Phone,
  Send,
  Layers,
  Video,
  Trash2,
  Lock,
  Wand2,
  ChevronRight,
  FlaskConical,
  GitBranch,
  BarChart2,
  AlignLeft,
} from "lucide-react"
import {
  createSequenceStep,
  updateSequenceStep,
  deleteSequenceStep,
  reorderSequenceSteps,
  updateCampaignSequence,
  cancelEnrollment,
} from "@/app/actions/campaign-sequences"
import type {
  CampaignSequence,
  SequenceStep,
  SequenceEnrollment,
} from "@/lib/campaigns/sequence-constants"
import { ContextualAiAssistBar } from "@/app/components/ai-copilot/contextual-ai-assist-bar"
import { WORKFLOW_TRIGGERS } from "@/lib/workflow/triggers"
import { StepTypeSelect, StepTypeDescription } from "@/app/components/campaigns/step-type-select"
import { StepFieldsEditor } from "@/app/components/campaigns/step-fields-editor"
import { toast } from "sonner"

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmailTemplate {
  id: string
  name: string
  subject: string
  body: string
  template_type: string
}

interface StepExecution {
  step_id: string
  status: string
  channel: string
  sent_at: string | null
}

interface Props {
  sequence:      CampaignSequence
  initialSteps:  SequenceStep[]
  enrollments:   SequenceEnrollment[]
  executions:    StepExecution[]
  emailTemplates: EmailTemplate[]
  featureFlags:  Record<string, boolean>
  brokerageId:   string
  userId:        string
  role:          string
  defaultTab:    "builder" | "analytics"
}

// ─── Constants ────────────────────────────────────────────────────────────────

// The step list lives in lib/workflow/step-palette.ts, rendered here through
// <StepTypeSelect>. It used to be a local CHANNELS array of seven — and the
// workflow builder kept its own array of eight — while both edit the SAME
// campaign_sequence_steps rows. Between them they reached 12 of the 23 the
// executor dispatches, so a step built in one builder was invisible in the
// other, and eleven registered adapters had no UI at all.
//
// The array also once contained "voice", which that column's CHECK rejects
// outright: the real channels are 'voice_drop' (a ringless voicemail) and
// 'ai_call' (a live AI call), separate adapters with separate consent
// implications. Both are TCPA-gated in the executor (TCPA_CHANNELS = sms |
// voice_drop | ai_call), so an unconsented or DNC contact is skipped at run
// time and the picker needs no gate of its own.
//
// scripts/step-palette-consolidation-simulator.ts holds palette == CHECK ==
// adapter registry, so none of the three can drift from the others again.

const PERSONALIZATION_TOKENS = [
  "{{first_name}}",
  "{{last_name}}",
  "{{property_address}}",
  "{{agent_name}}",
  "{{home_value}}",
  "{{days_since_contact}}",
  "{{brokerage_name}}",
]

// Canonical trigger catalog (KernelEvent-derived WORKFLOW_TRIGGERS) — single source of truth shared
// with the sequences list + workflow builder, so a trigger offered here always matches an emitted event.
const TRIGGER_EVENTS = WORKFLOW_TRIGGERS.map(t => ({ value: t.value, label: t.label }))

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  email:       Mail,
  sms:         MessageSquare,
  voice:       Phone,
  in_app:      Layers,
  video:       Video,
  direct_mail: Send,
}

const FUNNEL_COLORS = ["#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#f43f5e", "#f97316"]
const PIE_COLORS   = ["#22c55e", "#f59e0b", "#3b82f6", "#ef4444", "#8b5cf6"]

// ─── Main component ───────────────────────────────────────────────────────────

export default function SequenceBuilderClient({
  sequence,
  initialSteps,
  enrollments,
  executions,
  emailTemplates,
  featureFlags,
  brokerageId,
  userId,
  role,
  defaultTab,
}: Props) {
  const router = useRouter()
  const canEdit = role !== "agent"

  const [tab,          setTab]          = useState<"builder" | "analytics">(defaultTab)
  const [steps,        setSteps]        = useState<SequenceStep[]>(initialSteps)
  /** Enrollment ids currently being cancelled — see the Active Enrollments section. */
  const [cancellingEnrollmentId, setCancellingEnrollmentId] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState<SequenceStep | null>(null)
  const [busy,         setBusy]         = useState(false)

  // AI generate modal
  const [showAI,      setShowAI]      = useState(false)
  const [aiPrompt,    setAiPrompt]    = useState("")
  const [aiLoading,   setAiLoading]   = useState(false)
  const [aiPreview,   setAiPreview]   = useState<any[] | null>(null)
  const [aiError,     setAiError]     = useState<string | null>(null)

  // Template importer
  const [showTemplates,  setShowTemplates]  = useState(false)

  // Delete confirm
  const [deletingStep, setDeletingStep] = useState<string | null>(null)

  // Step editor form (local draft)
  const [draft, setDraft] = useState<Partial<SequenceStep>>({})

  const sensors = useSensors(useSensor(PointerSensor))

  // ── Select step ────────────────────────────────────────────────────────────
  const handleSelectStep = useCallback((step: SequenceStep) => {
    setSelectedStep(step)
    setDraft({ ...step })
  }, [])

  // ── Add step ───────────────────────────────────────────────────────────────
  const handleAddStep = useCallback(async () => {
    if (!canEdit) return
    const nextNumber = steps.length + 1
    setBusy(true)
    const result = await createSequenceStep({
      sequence_id:  sequence.id,
      step_number:  nextNumber,
      step_name:    `Step ${nextNumber}`,
      channel:      "email",
      delay_days:   nextNumber === 1 ? 0 : 3,
      delay_hours:  0,
      body:         "",
    })
    setBusy(false)
    // Never swallow the failure. This used to be `if (result.step)` with no
    // else, so a rejected INSERT looked exactly like a working button.
    if (result.error || !result.step) {
      toast.error(result.error ?? "Could not add the step.")
      return
    }
    setSteps(prev => [...prev, result.step!])
    handleSelectStep(result.step!)
  }, [steps, sequence.id, canEdit, handleSelectStep])

  // ── Save step ──────────────────────────────────────────────────────────────
  const handleSaveStep = useCallback(async () => {
    if (!selectedStep || !canEdit) return
    setBusy(true)
    // The whole draft goes through. updateSequenceStep takes the step palette as
    // its allow-list, so every per-channel field the editor collected is saved
    // and nothing outside the palette can reach a column. Naming the fields here
    // by hand is how a gift occasion or an e-sign recipient got dropped.
    const { id: _id, ...draftFields } = draft as Record<string, unknown>
    const res = await updateSequenceStep(selectedStep.id, sequence.id, {
      ...draftFields,
      step_name:   draft.step_name ?? selectedStep.step_name,
      channel:     draft.channel   ?? selectedStep.channel,
      delay_days:  draft.delay_days  ?? 0,
      delay_hours: draft.delay_hours ?? 0,
      subject:     draft.subject   ?? null,
      body:        draft.body      ?? null,
      send_time:   draft.send_time ?? null,
    })
    setBusy(false)
    if (res.error) toast.error(res.error)
    setSteps(prev => prev.map(s =>
      s.id === selectedStep.id ? { ...s, ...draft } as SequenceStep : s
    ))
    setSelectedStep(prev => prev ? { ...prev, ...draft } as SequenceStep : null)
  }, [selectedStep, draft, sequence.id, canEdit])

  // ── Delete step ────────────────────────────────────────────────────────────
  const handleDeleteStep = useCallback(async (stepId: string) => {
    setBusy(true)
    await deleteSequenceStep(stepId, sequence.id)
    setBusy(false)
    const remaining = steps
      .filter(s => s.id !== stepId)
      .map((s, i) => ({ ...s, step_number: i + 1 }))
    setSteps(remaining)
    if (selectedStep?.id === stepId) {
      setSelectedStep(null)
      setDraft({})
    }
    setDeletingStep(null)
    // Reorder
    if (remaining.length > 0) {
      await reorderSequenceSteps(remaining.map(s => ({ id: s.id, step_number: s.step_number })), sequence.id)
    }
  }, [steps, selectedStep, sequence.id])

  // ── Drag end ───────────────────────────────────────────────────────────────
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = steps.findIndex(s => s.id === active.id)
    const newIdx = steps.findIndex(s => s.id === over.id)
    const reordered = arrayMove(steps, oldIdx, newIdx).map((s, i) => ({
      ...s, step_number: i + 1,
    }))
    setSteps(reordered)
    await reorderSequenceSteps(
      reordered.map(s => ({ id: s.id, step_number: s.step_number })),
      sequence.id
    )
  }, [steps, sequence.id])

  // ── AI Generate ────────────────────────────────────────────────────────────
  const handleAIGenerate = useCallback(async () => {
    if (!aiPrompt.trim()) return
    setAiLoading(true)
    setAiError(null)
    setAiPreview(null)

    try {
      const res = await fetch("/api/ai/generate-sequence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt, sequenceId: sequence.id, brokerageId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "AI generation failed")
      setAiPreview(data.steps)
    } catch (err: any) {
      setAiError(err.message)
    } finally {
      setAiLoading(false)
    }
  }, [aiPrompt, sequence.id, brokerageId])

  const handleApplyAISteps = useCallback(async () => {
    if (!aiPreview) return
    setAiLoading(true)
    const created: SequenceStep[] = []
    for (let i = 0; i < aiPreview.length; i++) {
      const s = aiPreview[i]
      const result = await createSequenceStep({
        sequence_id: sequence.id,
        step_number: steps.length + i + 1,
        step_name:   s.step_name ?? `Step ${steps.length + i + 1}`,
        channel:     s.channel ?? "email",
        delay_days:  s.delay_days ?? 0,
        delay_hours: s.delay_hours ?? 0,
        subject:     s.subject ?? undefined,
        body:        s.body ?? "",
        send_time:   s.send_time ?? undefined,
      })
      if (result.step) created.push(result.step)
      else if (result.error) toast.error(`Step ${i + 1}: ${result.error}`)
    }
    setSteps(prev => [...prev, ...created])
    setAiLoading(false)
    setShowAI(false)
    setAiPreview(null)
    setAiPrompt("")
  }, [aiPreview, steps, sequence.id])

  // ── Template import ─────────────────────────────────────────────────────────
  const handleImportTemplate = useCallback((tmpl: EmailTemplate) => {
    setDraft(prev => ({
      ...prev,
      subject: tmpl.subject,
      body:    tmpl.body,
    }))
    setShowTemplates(false)
  }, [])

  // ── Token insert ────────────────────────────────────────────────────────────
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const handleInsertToken = useCallback((token: string) => {
    const el = bodyRef.current
    if (!el) {
      setDraft(prev => ({ ...prev, body: (prev.body ?? "") + token }))
      return
    }
    const start = el.selectionStart
    const end   = el.selectionEnd
    const before = (draft.body ?? "").slice(0, start)
    const after  = (draft.body ?? "").slice(end)
    setDraft(prev => ({ ...prev, body: before + token + after }))
    setTimeout(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    }, 0)
  }, [draft.body])

  // ─────────────────────────────────────────────────────────────────────────
  // ANALYTICS DATA
  // ─────────────────────────────────────────────────────────────────────────

  const analyticsData = useMemo(() => {
    const totalEnrolled  = enrollments.length
    const totalSent      = executions.filter(e => e.status === "sent").length
    const totalDelivered = totalSent // simplification — no bounce tracking yet
    const totalOpened    = steps.reduce((a, s) => a + (s.open_count ?? 0), 0)
    const totalClicked   = steps.reduce((a, s) => a + (s.click_count ?? 0), 0)
    const totalReplied   = steps.reduce((a, s) => a + (s.reply_count ?? 0), 0)
    const totalConverted = sequence.conversions_total ?? 0

    const funnelData = [
      { name: "Enrolled",   value: totalEnrolled },
      { name: "Sent",       value: totalSent },
      { name: "Delivered",  value: totalDelivered },
      { name: "Opened",     value: totalOpened },
      { name: "Clicked",    value: totalClicked },
      { name: "Replied",    value: totalReplied },
      { name: "Converted",  value: totalConverted },
    ]

    const statusCounts: Record<string, number> = {}
    for (const e of enrollments) {
      statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1
    }
    const piData = Object.entries(statusCounts).map(([name, value]) => ({ name, value }))

    const stepRows = steps.map(s => {
      const sent      = executions.filter(e => e.step_id === s.id && e.status === "sent").length
      const openRate  = sent > 0 ? Math.round((s.open_count / sent) * 100) : 0
      const clickRate = sent > 0 ? Math.round((s.click_count / sent) * 100) : 0
      const replyRate = sent > 0 ? Math.round((s.reply_count / sent) * 100) : 0
      return { ...s, sentForStep: sent, openRate, clickRate, replyRate }
    })

    // A/B analytics
    const variantA = enrollments.filter(e => e.ab_variant === "A")
    const variantB = enrollments.filter(e => e.ab_variant === "B")

    return { funnelData, piData, stepRows, variantA, variantB, totalReplied }
  }, [steps, enrollments, executions, sequence])

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <main className="flex flex-col h-screen font-sans bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-4 py-3 gap-3 bg-card">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => router.push("/dashboard/campaigns/sequences")}
            className="h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors shrink-0"
            aria-label="Back to sequences"
          >
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          </button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-foreground truncate">{sequence.name}</h1>
            <p className="text-xs text-muted-foreground hidden sm:block">
              {steps.length} step{steps.length !== 1 ? "s" : ""} &middot; {sequence.sequence_type}
              {sequence.is_ab_test && " · A/B Test"}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          {(["builder", "analytics"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                tab === t
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "builder" ? <AlignLeft className="h-3.5 w-3.5 inline mr-1" /> : <BarChart2 className="h-3.5 w-3.5 inline mr-1" />}
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Compliance badge */}
        <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded-md px-2.5 py-1.5 bg-muted/40 shrink-0">
          <Lock className="h-3 w-3 text-primary" />
          <span>Compliance Gate: <strong className="text-foreground">LOCKED</strong></span>
        </div>
      </header>

      {/* ── BUILDER TAB ────────────────────────────────────────────────────── */}
      {tab === "builder" && (
        <div className="flex flex-1 overflow-hidden">
          {/* LEFT — step flow */}
          <div className="w-72 xl:w-80 flex flex-col border-r border-border bg-muted/20 overflow-y-auto shrink-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Flow</span>
              {canEdit && (
                <button
                  onClick={() => setShowAI(true)}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                  title="AI Generate Sequence"
                >
                  <Wand2 className="h-3.5 w-3.5" /> AI Generate
                </button>
              )}
            </div>

            <div className="flex flex-col gap-0 px-3 py-3">
              {/* Start node */}
              <div className="flex flex-col items-center gap-0">
                <div className="w-full rounded-lg border-2 border-green-500 bg-green-50 dark:bg-green-950/30 px-3 py-2 text-center">
                  <p className="text-xs font-semibold text-green-700 dark:text-green-400">START</p>
                  <p className="text-[11px] text-green-600 dark:text-green-500 mt-0.5">
                    {TRIGGER_EVENTS.find(t => t.value === sequence.trigger_event)?.label ?? "Manual Enroll"}
                  </p>
                </div>
                {steps.length > 0 && <div className="w-px h-3 bg-border" />}
              </div>

              {/* Sortable steps */}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={steps.map(s => s.id)} strategy={verticalListSortingStrategy}>
                  {steps.map((step, idx) => (
                    <div key={step.id} className="flex flex-col items-center gap-0">
                      <StepFlowNode
                        step={step}
                        isSelected={selectedStep?.id === step.id}
                        canEdit={canEdit}
                        showABVariant={sequence.is_ab_test}
                        onClick={() => handleSelectStep(step)}
                        onDelete={() => setDeletingStep(step.id)}
                      />
                      {idx < steps.length - 1 && (
                        <div className="flex flex-col items-center">
                          <div className="w-px h-2 bg-border" />
                          {step.condition_field && (
                            <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                              <GitBranch className="h-3 w-3" />
                              <span>Branch</span>
                            </div>
                          )}
                          <div className="w-px h-2 bg-border" />
                        </div>
                      )}
                    </div>
                  ))}
                </SortableContext>
              </DndContext>

              {/* Add step */}
              {canEdit && (
                <div className="flex flex-col items-center gap-0 mt-1">
                  {steps.length > 0 && <div className="w-px h-3 bg-border" />}
                  <button
                    onClick={handleAddStep}
                    disabled={busy}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded-md px-3 py-2 w-full justify-center hover:bg-muted/50 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add Step
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT — step editor */}
          <div className="flex-1 overflow-y-auto">
            {selectedStep ? (
              <StepEditor
                step={selectedStep}
                draft={draft}
                setDraft={setDraft}
                sequence={sequence}
                featureFlags={featureFlags}
                emailTemplates={emailTemplates}
                onSave={handleSaveStep}
                onShowTemplates={() => setShowTemplates(true)}
                onInsertToken={handleInsertToken}
                bodyRef={bodyRef}
                busy={busy}
                canEdit={canEdit}
                agentId={userId}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-sm text-muted-foreground px-4">
                <AlignLeft className="h-8 w-8 mb-3 opacity-30" />
                <p>Select a step to edit it</p>
                {canEdit && steps.length === 0 && (
                  <Button onClick={handleAddStep} size="sm" className="mt-4" disabled={busy}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add First Step
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ANALYTICS TAB ──────────────────────────────────────────────────── */}
      {tab === "analytics" && (
        <div className="flex-1 overflow-y-auto p-6 space-y-8">

          {/* Funnel bar chart */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-4">Enrollment Funnel</h2>
            <div className="rounded-lg border border-border bg-card p-4" style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analyticsData.funnelData} barSize={36}>
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {analyticsData.funnelData.map((_, i) => (
                      <Cell key={i} fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Step table */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-4">Step Performance</h2>
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    {["Step #", "Name", "Channel", "Sent", "Open Rate", "Click Rate", "Reply Rate"].map(h => (
                      <th key={h} className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {analyticsData.stepRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-8 text-muted-foreground text-xs">
                        No steps yet.
                      </td>
                    </tr>
                  ) : analyticsData.stepRows.map(s => {
                    const Icon = CHANNEL_ICONS[s.channel] ?? Mail
                    return (
                      <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 text-muted-foreground">{s.step_number}</td>
                        <td className="px-4 py-2.5 font-medium text-foreground">{s.step_name}</td>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Icon className="h-3.5 w-3.5" /> {s.channel}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-foreground">{s.sentForStep}</td>
                        <td className="px-4 py-2.5 text-foreground">{s.openRate}%</td>
                        <td className="px-4 py-2.5 text-foreground">{s.clickRate}%</td>
                        <td className="px-4 py-2.5 text-foreground">{s.replyRate}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* A/B Test results */}
          {sequence.is_ab_test && (
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-1.5">
                <FlaskConical className="h-4 w-4 text-amber-500" /> A/B Test Results
              </h2>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: "Variant A", enrollments: analyticsData.variantA },
                  { label: "Variant B", enrollments: analyticsData.variantB },
                ].map(({ label, enrollments: ve }) => {
                  const completed = ve.filter(e => e.status === "completed").length
                  const converted = ve.filter(e => e.converted_at).length
                  const replyRate = ve.length > 0 ? Math.round((converted / ve.length) * 100) : 0
                  return (
                    <div key={label} className="rounded-lg border border-border bg-card p-4">
                      <p className="text-sm font-semibold text-foreground mb-3">{label}</p>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between"><span className="text-muted-foreground">Enrolled</span><span className="font-medium">{ve.length}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Completed</span><span className="font-medium">{completed}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Converted</span><span className="font-medium">{converted}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Conversion rate</span><span className="font-semibold text-foreground">{replyRate}%</span></div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {analyticsData.variantA.filter(e => e.converted_at).length >
                 analyticsData.variantB.filter(e => e.converted_at).length
                  ? "Variant A is currently winning by conversion rate."
                  : analyticsData.variantB.filter(e => e.converted_at).length >
                    analyticsData.variantA.filter(e => e.converted_at).length
                  ? "Variant B is currently winning by conversion rate."
                  : "Variants are tied."}
              </p>
            </section>
          )}

          {/*
            ACTIVE ENROLLMENTS — the door onto `cancelEnrollment`, which had no caller.
            Enrolling a contact starts an automated outbound programme against them;
            without this there was no way to STOP one from the product, only from SQL.
            The action re-verifies the enrollment's brokerage server-side and proves the
            update with `.select("id")`, so this button cannot report a cancellation
            that did not happen.
          */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-4">Active Enrollments</h2>
            <div className="rounded-lg border border-border bg-card divide-y">
              {enrollments.filter((e) => e.status === "active").length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground">No one is currently enrolled in this sequence.</p>
              ) : (
                enrollments
                  .filter((e) => e.status === "active")
                  .map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {[e.contact?.first_name, e.contact?.last_name].filter(Boolean).join(" ") ||
                            e.contact?.email ||
                            (e.lead_id ? "Lead" : "Contact")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Step {e.current_step}
                          {e.next_step_at ? ` · next ${new Date(e.next_step_at).toLocaleDateString()}` : ""}
                          {e.enrolled_at ? ` · enrolled ${new Date(e.enrolled_at).toLocaleDateString()}` : ""}
                        </p>
                      </div>
                      {canEdit && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={cancellingEnrollmentId === e.id}
                          onClick={async () => {
                            setCancellingEnrollmentId(e.id)
                            try {
                              const res = await cancelEnrollment(e.id, sequence.id)
                              if (!res.success) {
                                toast.error(res.error ?? "The enrollment was not cancelled")
                                return
                              }
                              toast.success("Enrollment cancelled — no further steps will send")
                              router.refresh()
                            } catch (err: any) {
                              toast.error(err?.message ?? "The enrollment was not cancelled")
                            } finally {
                              setCancellingEnrollmentId(null)
                            }
                          }}
                        >
                          {cancellingEnrollmentId === e.id ? "Cancelling…" : "Cancel"}
                        </Button>
                      )}
                    </div>
                  ))
              )}
            </div>
          </section>

          {/* Enrollment status pie */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-4">Enrollment Status Distribution</h2>
            <div className="rounded-lg border border-border bg-card p-4 flex items-center justify-center" style={{ height: 260 }}>
              {analyticsData.piData.length === 0 ? (
                <p className="text-xs text-muted-foreground">No enrollments yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={analyticsData.piData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={90}
                      label={((props: any) => `${props.name} ${Math.round((props.percent ?? 0) * 100)}%`) as any}
                    >
                      {analyticsData.piData.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Legend />
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>
        </div>
      )}

      {/* ── AI Generate Modal ────────────────────────────────────────────── */}
      <Dialog open={showAI} onOpenChange={setShowAI}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-primary" /> AI Generate Sequence
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Describe what this sequence should accomplish</Label>
              <Textarea
                rows={4}
                placeholder="e.g. A 5-step drip for new leads who downloaded a buyer guide. Start with a welcome email, follow up with SMS, then a re-engagement email if no reply."
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
              />
            </div>
            {aiError && <p className="text-sm text-destructive">{aiError}</p>}

            {aiPreview && (
              <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2 max-h-60 overflow-y-auto">
                <p className="text-xs font-semibold text-muted-foreground uppercase">Preview ({aiPreview.length} steps)</p>
                {aiPreview.map((s: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="font-medium text-muted-foreground w-6 shrink-0">{i + 1}.</span>
                    <div>
                      <p className="font-medium text-foreground">{s.step_name ?? `Step ${i + 1}`}</p>
                      <p className="text-muted-foreground">{s.channel} &middot; Day {(s.delay_days ?? 0) + (s.delay_hours ?? 0) / 24}</p>
                      {s.subject && <p className="text-muted-foreground truncate">Subject: {s.subject}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => { setShowAI(false); setAiPreview(null); setAiPrompt("") }}>
              Cancel
            </Button>
            {!aiPreview ? (
              <Button onClick={handleAIGenerate} disabled={aiLoading || !aiPrompt.trim()}>
                {aiLoading ? "Generating..." : "Generate"}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setAiPreview(null)}>Regenerate</Button>
                <Button onClick={handleApplyAISteps} disabled={aiLoading}>
                  {aiLoading ? "Saving..." : "Apply Steps"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Template importer modal ───────────────────────────────────────── */}
      <Dialog open={showTemplates} onOpenChange={setShowTemplates}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Email Template</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
            {emailTemplates.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">No email templates found for this brokerage.</p>
            )}
            {emailTemplates.map(tmpl => (
              <button
                key={tmpl.id}
                onClick={() => handleImportTemplate(tmpl)}
                className="text-left rounded-lg border border-border p-3 hover:bg-muted/50 transition-colors flex items-start justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{tmpl.name}</p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{tmpl.subject}</p>
                </div>
                <Badge variant="secondary" className="shrink-0 text-[10px]">{tmpl.template_type}</Badge>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTemplates(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete step confirm ───────────────────────────────────────────── */}
      <Dialog open={!!deletingStep} onOpenChange={() => setDeletingStep(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Delete Step?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently remove this step and reorder remaining steps.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingStep(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => deletingStep && handleDeleteStep(deletingStep)}>
              {busy ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

// ─── StepFlowNode ─────────────────────────────────────────────────────────────

function StepFlowNode({
  step,
  isSelected,
  canEdit,
  showABVariant,
  onClick,
  onDelete,
}: {
  step: SequenceStep
  isSelected: boolean
  canEdit: boolean
  showABVariant: boolean
  onClick: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: step.id, disabled: !canEdit })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const Icon = CHANNEL_ICONS[step.channel] ?? Mail

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`w-full rounded-lg border transition-colors cursor-pointer select-none ${
        isSelected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-primary/40 hover:bg-muted/30"
      }`}
      onClick={onClick}
    >
      <div className="flex items-start gap-2 p-2.5">
        {canEdit && (
          <button
            {...attributes}
            {...listeners}
            className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground shrink-0"
            onClick={e => e.stopPropagation()}
            aria-label="Drag to reorder"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground font-mono">#{step.step_number}</span>
            <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-xs font-medium text-foreground truncate">{step.step_name}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Wait {step.delay_days}d {step.delay_hours}h
          </p>
          {step.subject && (
            <p className="text-[11px] text-muted-foreground truncate">{step.subject.slice(0, 50)}</p>
          )}
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
            <span>{step.sent_count} sent</span>
            <span>{step.open_count} opened</span>
            <span>{step.reply_count} replied</span>
            {showABVariant && step.ab_variant && (
              <span className="text-amber-500 font-medium">Variant {step.ab_variant}</span>
            )}
          </div>
        </div>
        {canEdit && (
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-destructive/10 shrink-0"
            aria-label="Delete step"
          >
            <Trash2 className="h-3 w-3 text-destructive" />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── StepEditor ───────────────────────────────────────────────────────────────

function StepEditor({
  step,
  draft,
  setDraft,
  sequence,
  featureFlags,
  emailTemplates,
  onSave,
  onShowTemplates,
  onInsertToken,
  bodyRef,
  busy,
  canEdit,
  agentId,
}: {
  step: SequenceStep
  draft: Partial<SequenceStep>
  setDraft: React.Dispatch<React.SetStateAction<Partial<SequenceStep>>>
  sequence: CampaignSequence
  featureFlags: Record<string, boolean>
  emailTemplates: EmailTemplate[]
  onSave: () => void
  onShowTemplates: () => void
  onInsertToken: (token: string) => void
  bodyRef: React.RefObject<HTMLTextAreaElement | null>
  busy: boolean
  canEdit: boolean
  agentId: string
}) {
  const [showCondition, setShowCondition] = useState(!!step.condition_field)

  return (
    <div className="p-5 flex flex-col gap-5 max-w-2xl">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          Step {step.step_number} — {step.step_name}
        </h2>
        {canEdit && (
          <Button size="sm" onClick={onSave} disabled={busy}>
            {busy ? "Saving..." : "Save Step"}
          </Button>
        )}
      </div>

      {/* Compliance badge — always locked, read-only */}
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Lock className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span>Compliance Gate: <strong className="text-foreground">LOCKED</strong> — always active. Cannot be disabled.</span>
      </div>

      {/* Step name */}
      <div className="flex flex-col gap-1.5">
        <Label>Step Name</Label>
        <Input
          value={draft.step_name ?? ""}
          onChange={e => setDraft(p => ({ ...p, step_name: e.target.value }))}
          disabled={!canEdit}
        />
      </div>

      {/* Step type — the shared palette, grouped by what the step DOES */}
      <div className="flex flex-col gap-1.5">
        <Label>Step type</Label>
        <StepTypeSelect
          value={draft.channel ?? step.channel}
          onChange={v => setDraft(p => ({ ...p, channel: v }))}
          featureFlags={featureFlags}
          disabled={!canEdit}
        />
        <StepTypeDescription channel={draft.channel ?? step.channel} />
      </div>

      {/* Delay */}
      <div className="flex flex-col gap-1.5">
        <Label>Delay after previous step</Label>
        <div className="flex gap-2">
          <div className="flex items-center gap-1.5 flex-1">
            <Input
              type="number"
              min={0}
              value={draft.delay_days ?? 0}
              onChange={e => setDraft(p => ({ ...p, delay_days: parseInt(e.target.value) || 0 }))}
              disabled={!canEdit}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
          <div className="flex items-center gap-1.5 flex-1">
            <Input
              type="number"
              min={0}
              max={23}
              value={draft.delay_hours ?? 0}
              onChange={e => setDraft(p => ({ ...p, delay_hours: parseInt(e.target.value) || 0 }))}
              disabled={!canEdit}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">hours</span>
          </div>
          <div className="flex items-center gap-1.5 flex-1">
            <Input
              type="time"
              value={draft.send_time ?? ""}
              onChange={e => setDraft(p => ({ ...p, send_time: e.target.value }))}
              disabled={!canEdit}
            />
          </div>
        </div>
      </div>

      {/* A/B Variant — only if sequence is A/B */}
      {sequence.is_ab_test && (
        <div className="flex flex-col gap-1.5">
          <Label>A/B Variant</Label>
          <div className="flex gap-2">
            {["A", "B"].map(v => (
              <button
                key={v}
                onClick={() => canEdit && setDraft(p => ({ ...p, ab_variant: v }))}
                className={`px-4 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                  draft.ab_variant === v
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-border text-muted-foreground hover:border-primary/40"
                }`}
                disabled={!canEdit}
              >
                Variant {v}
              </button>
            ))}
            <button
              onClick={() => canEdit && setDraft(p => ({ ...p, ab_variant: null }))}
              className="px-4 py-1.5 rounded-md text-sm border border-border text-muted-foreground hover:bg-muted/50 transition-colors"
              disabled={!canEdit}
            >
              Both
            </button>
          </div>
        </div>
      )}

      {/* Everything this step type needs, rendered from the shared palette.
          subject and body are omitted because this builder renders richer
          controls for them below (personalization tokens + the AI assist bar);
          the required-field warning still counts them. Before this, the panel
          showed subject and body and nothing else — so a Send Gift step had
          nowhere to set the occasion and an Ad Campaign step no budget, and
          both failed later in a cron rather than here. */}
      <StepFieldsEditor
        channel={draft.channel ?? step.channel}
        values={{ ...step, ...draft } as unknown as Record<string, unknown>}
        onChange={(name, value) => setDraft(p => ({ ...p, [name]: value }))}
        disabled={!canEdit}
        omit={["subject", "body"]}
      />

      {/* Subject (email) */}
      {(draft.channel ?? step.channel) === "email" && (
        <div className="flex flex-col gap-1.5">
          <Label>Subject</Label>
          <Input
            value={draft.subject ?? ""}
            onChange={e => setDraft(p => ({ ...p, subject: e.target.value }))}
            placeholder="e.g. Quick question about your home search"
            disabled={!canEdit}
          />
        </div>
      )}

      {/* Body */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label>Message Body</Label>
          {canEdit && emailTemplates.length > 0 && (
            <button
              onClick={onShowTemplates}
              className="text-xs text-primary hover:underline"
            >
              Import template
            </button>
          )}
        </div>
        <Textarea
          ref={bodyRef as React.RefObject<HTMLTextAreaElement>}
          rows={7}
          value={draft.body ?? ""}
          onChange={e => setDraft(p => ({ ...p, body: e.target.value }))}
          placeholder="Write your message here..."
          disabled={!canEdit}
        />
        {/* Token picker */}
        {canEdit && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {PERSONALIZATION_TOKENS.map(t => (
              <button
                key={t}
                onClick={() => onInsertToken(t)}
                className="text-[10px] font-mono bg-muted px-2 py-1 rounded border border-border hover:bg-primary/10 hover:border-primary/40 transition-colors"
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {/* AI Assist for message drafting */}
        {canEdit && agentId && (
          <ContextualAiAssistBar
            agentId={agentId}
            context={{
              type: "message",
              contactName: sequence?.name || "recipient",
              currentContent: draft.body || "",
            }}
            onAcceptDraft={(accepted) => {
              setDraft(prev => ({ ...prev, body: accepted }))
              if (bodyRef.current) {
                bodyRef.current.value = accepted
                bodyRef.current.dispatchEvent(new Event('input', { bubbles: true }))
              }
            }}
          />
        )}
      </div>

      {/* Condition branch */}
      {canEdit && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Condition Branch</p>
              <p className="text-xs text-muted-foreground">Only execute if contact field matches value</p>
            </div>
            <Switch
              checked={showCondition}
              onCheckedChange={v => {
                setShowCondition(v)
                if (!v) setDraft(p => ({ ...p, condition_field: null, condition_operator: null, condition_value: null }))
              }}
            />
          </div>
          {showCondition && (
            <div className="flex gap-2 flex-wrap">
              <Input
                placeholder="Field (e.g. status)"
                value={draft.condition_field ?? ""}
                onChange={e => setDraft(p => ({ ...p, condition_field: e.target.value }))}
                className="flex-1 min-w-[120px]"
              />
              <Select
                value={draft.condition_operator ?? "eq"}
                onValueChange={v => setDraft(p => ({ ...p, condition_operator: v }))}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="eq">equals</SelectItem>
                  <SelectItem value="neq">not equals</SelectItem>
                  <SelectItem value="contains">contains</SelectItem>
                  <SelectItem value="gt">greater than</SelectItem>
                  <SelectItem value="lt">less than</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Value"
                value={draft.condition_value ?? ""}
                onChange={e => setDraft(p => ({ ...p, condition_value: e.target.value }))}
                className="flex-1 min-w-[120px]"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
