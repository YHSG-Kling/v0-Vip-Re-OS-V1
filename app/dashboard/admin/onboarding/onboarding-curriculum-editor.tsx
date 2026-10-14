"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { GraduationCap, Plus, Pencil, Trash2, Loader2, AlertCircle, Lock } from "lucide-react"
import {
  listOnboardingCurriculumAction,
  saveOnboardingStepAction,
  deleteOnboardingStepAction,
  type CurriculumStep,
} from "@/app/actions/admin/onboarding-steps"

// The category list and the two numeric bounds are the DATABASE's, not this
// file's. This dropdown offered license / compliance / tech / training /
// practice / brand / other while onboarding_steps_category_check admits only
// system_setup / training / practice / compliance / certification — four of the
// seven options were refused with a raw 23514. The blank form below also
// defaulted Order to "0", which onboarding_steps_step_order_check (>= 1) refuses,
// so the first save of a freshly-opened form failed regardless of the category.
import {
  ONBOARDING_STEP_CATEGORIES,
  onboardingStepCategoryLabel,
  ONBOARDING_STEP_DAY_MIN,
  ONBOARDING_STEP_DAY_MAX,
  ONBOARDING_STEP_ORDER_MIN,
} from "@/lib/onboarding/step-categories"

const ROLES = ["agent", "broker", "admin", "tc", "isa", "team_lead", "compliance_officer"]

const EMPTY = {
  id: null as string | null,
  dayNumber: "1",
  stepOrder: "1",
  stepKey: "",
  stepName: "",
  category: "training",
  required: true,
  estimatedMinutes: "",
  instructions: "",
  videoUrl: "",
  targetRole: [] as string[],
}

export function OnboardingCurriculumEditor() {
  const [steps, setSteps] = useState<CurriculumStep[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const res = await listOnboardingCurriculumAction()
    if (res.ok) setSteps(res.steps)
    else setLoadError(res.error)
    setLoading(false)
  }
  useEffect(() => { void refresh() }, [])

  function startNew() { setForm(EMPTY); setEditing(true); setError(null) }
  function startEdit(s: CurriculumStep) {
    setForm({
      id: s.id, dayNumber: String(s.dayNumber), stepOrder: String(s.stepOrder),
      stepKey: s.stepKey, stepName: s.stepName, category: s.category, required: s.required,
      estimatedMinutes: s.estimatedMinutes != null ? String(s.estimatedMinutes) : "",
      instructions: s.instructions ?? "", videoUrl: s.videoUrl ?? "", targetRole: s.targetRole ?? [],
    })
    setEditing(true); setError(null)
  }

  async function handleSave() {
    setSaving(true); setError(null)
    try {
      const res = await saveOnboardingStepAction({
        id: form.id,
        dayNumber: Number(form.dayNumber), stepOrder: Number(form.stepOrder),
        stepKey: form.stepKey, stepName: form.stepName, category: form.category,
        required: form.required,
        estimatedMinutes: form.estimatedMinutes === "" ? null : Number(form.estimatedMinutes),
        instructions: form.instructions || null, videoUrl: form.videoUrl || null,
        targetRole: form.targetRole.length ? form.targetRole : null,
      })
      if (!res.ok) { setError(res.error); return }
      setEditing(false); await refresh()
    } finally { setSaving(false) }
  }

  async function handleDelete(s: CurriculumStep) {
    if (!window.confirm(`Delete "${s.stepName}"?`)) return
    const res = await deleteOnboardingStepAction(s.id)
    if (!res.ok) { setError(res.error); return }
    await refresh()
  }

  function toggleRole(r: string) {
    setForm((f) => ({ ...f, targetRole: f.targetRole.includes(r) ? f.targetRole.filter((x) => x !== r) : [...f.targetRole, r] }))
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <GraduationCap className="h-4 w-4 text-muted-foreground" />
              Onboarding Curriculum
            </CardTitle>
            <CardDescription className="text-xs">
              Author your brokerage’s onboarding steps. Platform defaults apply to everyone;
              your custom steps are added on top, per role.
            </CardDescription>
          </div>
          {!editing && (
            <Button size="sm" className="gap-1.5" onClick={startNew}>
              <Plus className="h-4 w-4" /> Add step
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : loadError ? (
          <p className="text-sm text-red-600 flex items-center gap-2"><AlertCircle className="h-4 w-4" /> {loadError}</p>
        ) : (
          <>
            {editing && (
              <div className="rounded-md border p-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5"><Label className="text-xs">Step name *</Label>
                    <Input value={form.stepName} onChange={(e) => setForm({ ...form, stepName: e.target.value })} placeholder="Upload your license" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Step key *</Label>
                    <Input value={form.stepKey} onChange={(e) => setForm({ ...form, stepKey: e.target.value })} placeholder="upload_license" /></div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div className="space-y-1.5"><Label className="text-xs">Day</Label>
                    <Input type="number" min={ONBOARDING_STEP_DAY_MIN} max={ONBOARDING_STEP_DAY_MAX} value={form.dayNumber} onChange={(e) => setForm({ ...form, dayNumber: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Order</Label>
                    <Input type="number" min={ONBOARDING_STEP_ORDER_MIN} value={form.stepOrder} onChange={(e) => setForm({ ...form, stepOrder: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Est. minutes</Label>
                    <Input type="number" value={form.estimatedMinutes} onChange={(e) => setForm({ ...form, estimatedMinutes: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Category</Label>
                    <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{ONBOARDING_STEP_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{onboardingStepCategoryLabel(c)}</SelectItem>)}</SelectContent>
                    </Select></div>
                </div>
                <div className="space-y-1.5"><Label className="text-xs">Applies to roles (none = everyone)</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {ROLES.map((r) => (
                      <button key={r} type="button" onClick={() => toggleRole(r)}
                        className={`text-xs rounded border px-2 py-0.5 ${form.targetRole.includes(r) ? "border-blue-500 bg-blue-50 text-blue-700" : "border-border"}`}>{r}</button>
                    ))}
                  </div></div>
                <div className="space-y-1.5"><Label className="text-xs">Instructions</Label>
                  <Textarea rows={2} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div>
                <div className="space-y-1.5"><Label className="text-xs">Video URL (optional)</Label>
                  <Input value={form.videoUrl} onChange={(e) => setForm({ ...form, videoUrl: e.target.value })} /></div>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /> Required step
                </label>
                {error && <p className="text-sm text-red-600 flex items-center gap-2"><AlertCircle className="h-4 w-4" /> {error}</p>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save step"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
                </div>
              </div>
            )}

            <div className="divide-y rounded-md border">
              {steps.length === 0 && <p className="p-3 text-xs text-muted-foreground">No steps yet.</p>}
              {steps.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 p-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{s.stepName}</span>
                      <Badge variant="outline" className="text-[10px]">Day {s.dayNumber}</Badge>
                      <Badge variant="outline" className="text-[10px]">{s.category}</Badge>
                      {s.targetRole?.length ? <Badge variant="outline" className="text-[10px]">{s.targetRole.join(", ")}</Badge> : null}
                      {s.isPlatformDefault && <Badge variant="secondary" className="text-[10px] gap-1"><Lock className="h-2.5 w-2.5" /> platform default</Badge>}
                    </div>
                  </div>
                  {!s.isPlatformDefault && (
                    <div className="flex gap-1 shrink-0">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(s)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete(s)}><Trash2 className="h-3.5 w-3.5 text-red-600" /></Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
