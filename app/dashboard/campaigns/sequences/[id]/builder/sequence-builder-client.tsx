"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, Plus, Trash2, ChevronUp, ChevronDown, Save, Mail, MessageSquare, Phone, Clock, Loader2, Sparkles } from "lucide-react"
import Link from "next/link"
import { saveSequenceSteps, type SequenceBuilderStep as SequenceStep, type CampaignSequence } from "@/app/actions/campaign-sequences"
import { useToast } from "@/hooks/use-toast"

interface Props {
  sequence: CampaignSequence
  initialSteps: SequenceStep[] // SequenceBuilderStep aliased as SequenceStep
  brokerageId: string
  userId: string | null
  role: string | null
}

const STEP_TYPES = [
  { value: "email", label: "Email", icon: Mail, color: "bg-blue-100 text-blue-700 border-blue-200" },
  { value: "sms", label: "SMS", icon: MessageSquare, color: "bg-green-100 text-green-700 border-green-200" },
  { value: "voice_drop", label: "Voice Drop", icon: Phone, color: "bg-purple-100 text-purple-700 border-purple-200" },
  { value: "ai_call", label: "AI Call", icon: Sparkles, color: "bg-amber-100 text-amber-700 border-amber-200" },
  { value: "wait", label: "Wait", icon: Clock, color: "bg-slate-100 text-slate-600 border-slate-200" },
  { value: "direct_mail", label: "Direct Mail", icon: Mail, color: "bg-orange-100 text-orange-700 border-orange-200" },
] as const

function newStep(type: SequenceStep["step_type"], index: number): SequenceStep {
  return { step_number: index + 1, step_type: type, delay_days: type === "wait" ? 3 : 1, delay_hours: 0, body: null, subject: type === "email" ? "" : null, is_active: true }
}

export default function SequenceStepBuilderClient({ sequence, initialSteps, brokerageId }: Props) {
  const [steps, setSteps] = useState<SequenceStep[]>(initialSteps.length > 0 ? initialSteps : [])
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const addStep = (type: SequenceStep["step_type"]) => {
    const s = newStep(type, steps.length)
    setSteps((prev) => [...prev, s])
    setSelectedIdx(steps.length)
  }

  const removeStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_number: i + 1 })))
    setSelectedIdx(null)
  }

  const moveStep = (idx: number, dir: -1 | 1) => {
    const next = idx + dir
    if (next < 0 || next >= steps.length) return
    const arr = [...steps]
    ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
    setSteps(arr.map((s, i) => ({ ...s, step_number: i + 1 })))
    setSelectedIdx(next)
  }

  const updateStep = (idx: number, patch: Partial<SequenceStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  const handleSave = () => {
    startTransition(async () => {
      const res = await saveSequenceSteps(sequence.id, steps)
      if (res.success) {
        toast({ title: "Sequence saved" })
        router.push("/dashboard/campaigns/sequences")
      } else {
        toast({ title: res.error ?? "Save failed", variant: "destructive" })
      }
    })
  }

  const totalDuration = steps.reduce((acc, s) => acc + s.delay_days + (s.delay_hours / 24), 0)
  const selected = selectedIdx !== null ? steps[selectedIdx] : null
  const StepIcon = selected ? (STEP_TYPES.find((t) => t.value === selected.step_type)?.icon ?? Mail) : Mail

  return (
    <div className="min-h-screen bg-muted/20">
      {/* Header */}
      <div className="border-b bg-background px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/campaigns/sequences">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />Back</Button>
          </Link>
          <div>
            <h1 className="text-lg font-semibold">{sequence.name}</h1>
            <p className="text-xs text-muted-foreground">{steps.length} steps · {Math.ceil(totalDuration)} day sequence</p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={isPending} className="gap-2">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Sequence
        </Button>
      </div>

      <div className="grid grid-cols-12 gap-0 h-[calc(100vh-73px)]">
        {/* Left: Step Library */}
        <div className="col-span-2 border-r bg-background p-4 space-y-2 overflow-y-auto">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Add Step</p>
          {STEP_TYPES.map(({ value, label, icon: Icon, color }) => (
            <button
              key={value}
              onClick={() => addStep(value as SequenceStep["step_type"])}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors hover:opacity-80 ${color}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Center: Timeline */}
        <div className="col-span-5 border-r bg-muted/10 p-6 overflow-y-auto">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">Sequence Timeline</p>
          {steps.length === 0 && (
            <div className="text-center py-16 space-y-3">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                <Plus className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No steps yet</p>
              <p className="text-xs text-muted-foreground">Add steps from the panel on the left to build your sequence.</p>
            </div>
          )}
          <div className="space-y-2">
            {steps.map((step, idx) => {
              const typeConfig = STEP_TYPES.find((t) => t.value === step.step_type)
              const Icon = typeConfig?.icon ?? Mail
              const isSelected = selectedIdx === idx
              return (
                <div key={idx} className="relative">
                  {idx > 0 && (
                    <div className="flex items-center gap-2 mb-2 ml-5">
                      <div className="w-px h-4 bg-border ml-3" />
                      <span className="text-[10px] text-muted-foreground">
                        +{step.delay_days}d{step.delay_hours > 0 ? ` ${step.delay_hours}h` : ""}
                      </span>
                    </div>
                  )}
                  <div
                    onClick={() => setSelectedIdx(isSelected ? null : idx)}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                      isSelected ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-background hover:border-primary/40"
                    }`}
                  >
                    <div className={`h-8 w-8 rounded-full border flex items-center justify-center shrink-0 text-xs font-bold ${typeConfig?.color ?? "bg-muted"}`}>
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Icon className="h-3 w-3" />
                        <span className="text-xs font-medium">{typeConfig?.label}</span>
                      </div>
                      {step.subject && <p className="text-xs font-medium mt-0.5 truncate">{step.subject}</p>}
                      {step.body && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{step.body}</p>}
                      {step.step_type === "wait" && <p className="text-xs text-muted-foreground">Wait {step.delay_days} day{step.delay_days !== 1 ? "s" : ""}</p>}
                    </div>
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button onClick={(e) => { e.stopPropagation(); moveStep(idx, -1) }} className="p-0.5 hover:bg-muted rounded" disabled={idx === 0}>
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); moveStep(idx, 1) }} className="p-0.5 hover:bg-muted rounded" disabled={idx === steps.length - 1}>
                        <ChevronDown className="h-3 w-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); removeStep(idx) }} className="p-0.5 hover:bg-destructive/10 rounded text-destructive">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: Step Editor */}
        <div className="col-span-5 p-6 overflow-y-auto">
          {!selected ? (
            <div className="text-center py-16 text-muted-foreground">
              <StepIcon className="h-8 w-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a step to edit its content</p>
            </div>
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Badge className={`${STEP_TYPES.find((t) => t.value === selected.step_type)?.color ?? ""} border`}>
                    Step {(selectedIdx ?? 0) + 1} — {STEP_TYPES.find((t) => t.value === selected.step_type)?.label}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Delay (days after prev step)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={selected.delay_days}
                      onChange={(e) => updateStep(selectedIdx!, { delay_days: Number(e.target.value) })}
                      className="h-8 text-sm mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Delay (additional hours)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={selected.delay_hours}
                      onChange={(e) => updateStep(selectedIdx!, { delay_hours: Number(e.target.value) })}
                      className="h-8 text-sm mt-1"
                    />
                  </div>
                </div>

                {selected.step_type !== "wait" && (
                  <>
                    {selected.step_type === "email" && (
                      <div>
                        <Label className="text-xs">Subject Line</Label>
                        <Input
                          placeholder="Email subject..."
                          value={selected.subject ?? ""}
                          onChange={(e) => updateStep(selectedIdx!, { subject: e.target.value || null })}
                          className="h-8 text-sm mt-1"
                        />
                      </div>
                    )}
                    <div>
                      <Label className="text-xs">
                        {selected.step_type === "email" ? "Email Body" : selected.step_type === "sms" ? "SMS Message" : selected.step_type === "voice_drop" ? "Voice Script" : selected.step_type === "ai_call" ? "Call Script Outline" : "Mail Copy"}
                      </Label>
                      <Textarea
                        placeholder={`Write your ${selected.step_type === "sms" ? "SMS message" : "content"} here...`}
                        value={selected.body ?? ""}
                        onChange={(e) => updateStep(selectedIdx!, { body: e.target.value || null })}
                        rows={8}
                        className="text-sm mt-1 resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Use {"{{first_name}}"}, {"{{last_name}}"}, {"{{agent_name}}"} as personalization tokens
                      </p>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
