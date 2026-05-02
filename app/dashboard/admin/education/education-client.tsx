"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { BookOpen, Plus, Sparkles, Trash2, Loader2, CheckCircle2, Users, GraduationCap, ChevronDown, ChevronUp } from "lucide-react"
import {
  getEducationModules,
  createEducationModule,
  deleteEducationModule,
  type EducationModule,
} from "@/app/actions/admin/license-tracking"
import { toast } from "sonner"

const TARGET_ROLES = ["agent", "isa", "tc", "lender", "team_lead", "broker"]

interface Props {
  brokerageId: string
  initialModules: EducationModule[]
}

interface QuizQuestion {
  question: string
  choices: string[]
  correct: number
}

export function EducationContentClient({ brokerageId, initialModules }: Props) {
  const [modules, setModules] = useState<EducationModule[]>(initialModules)
  const [isPending, startTransition] = useTransition()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Form state
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [targetRoles, setTargetRoles] = useState<string[]>(["agent"])
  const [required, setRequired] = useState(false)
  const [contentBody, setContentBody] = useState("")
  const [aiTopic, setAiTopic] = useState("")
  const [aiGenerating, setAiGenerating] = useState(false)
  const [questions, setQuestions] = useState<QuizQuestion[]>([
    { question: "", choices: ["", "", "", ""], correct: 0 },
  ])

  function resetForm() {
    setTitle("")
    setDescription("")
    setTargetRoles(["agent"])
    setRequired(false)
    setContentBody("")
    setAiTopic("")
    setQuestions([{ question: "", choices: ["", "", "", ""], correct: 0 }])
  }

  async function handleAiGenerate() {
    if (!aiTopic.trim()) return
    setAiGenerating(true)
    try {
      const res = await fetch("/api/ai/generate-module-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: aiTopic, targetRoles, brokerageId }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.title) setTitle(data.title)
        if (data.description) setDescription(data.description)
        if (data.content) setContentBody(data.content)
        if (data.questions?.length) setQuestions(data.questions)
        toast.success("Module content generated")
      }
    } catch {
      toast.error("AI generation failed — try again")
    } finally {
      setAiGenerating(false)
    }
  }

  function addQuestion() {
    setQuestions((prev) => [...prev, { question: "", choices: ["", "", "", ""], correct: 0 }])
  }

  function removeQuestion(idx: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== idx))
  }

  function updateQuestion(idx: number, field: keyof QuizQuestion, value: any) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === idx ? { ...q, [field]: value } : q))
    )
  }

  function updateChoice(qIdx: number, cIdx: number, value: string) {
    setQuestions((prev) =>
      prev.map((q, i) =>
        i === qIdx
          ? { ...q, choices: q.choices.map((c, j) => (j === cIdx ? value : c)) }
          : q
      )
    )
  }

  function handleCreate() {
    if (!title.trim() || !contentBody.trim()) {
      toast.error("Title and content body are required")
      return
    }
    startTransition(async () => {
      const result = await createEducationModule({
        brokerageId,
        title: title.trim(),
        description: description.trim(),
        targetRoles,
        required,
        contentBody: contentBody.trim(),
        quizQuestions: questions.filter((q) => q.question.trim()),
      })
      if (result.success) {
        toast.success("Module created")
        setDialogOpen(false)
        resetForm()
        const refresh = await getEducationModules(brokerageId)
        if (!refresh.error) setModules(refresh.modules)
      } else {
        toast.error(result.error ?? "Failed to create module")
      }
    })
  }

  function handleDelete(moduleId: string) {
    startTransition(async () => {
      const result = await deleteEducationModule(moduleId)
      if (result.success) {
        setModules((prev) => prev.filter((m) => m.id !== moduleId))
        toast.success("Module deleted")
      } else {
        toast.error(result.error ?? "Delete failed")
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <GraduationCap className="h-5 w-5 text-primary" />
            Education Content
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create and manage training modules for your agents, ISAs, TCs, and lenders.
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Module
        </Button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-2xl font-bold">{modules.length}</p>
            <p className="text-xs text-muted-foreground">Total Modules</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-2xl font-bold text-red-500">{modules.filter((m) => m.required).length}</p>
            <p className="text-xs text-muted-foreground">Required</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-2xl font-bold text-emerald-500">{modules.filter((m) => !m.required).length}</p>
            <p className="text-xs text-muted-foreground">Optional</p>
          </CardContent>
        </Card>
      </div>

      {/* Module List */}
      {modules.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No education modules yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Create your first module to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {modules.map((mod) => (
            <Card key={mod.id} className="overflow-hidden">
              <CardHeader className="py-3 px-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm">{mod.title}</p>
                      {mod.required && (
                        <Badge variant="destructive" className="text-xs">Required</Badge>
                      )}
                      {(mod.target_roles ?? []).map((r) => (
                        <Badge key={r} variant="outline" className="text-xs capitalize">{r.replace(/_/g, " ")}</Badge>
                      ))}
                    </div>
                    {mod.description && (
                      <p className="text-xs text-muted-foreground mt-1">{mod.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setExpandedId(expandedId === mod.id ? null : mod.id)}
                    >
                      {expandedId === mod.id
                        ? <ChevronUp className="h-4 w-4" />
                        : <ChevronDown className="h-4 w-4" />
                      }
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleDelete(mod.id)}
                      disabled={isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {expandedId === mod.id && (
                <CardContent className="pt-0 px-4 pb-4 border-t space-y-3">
                  {mod.content_body && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Content</p>
                      <p className="text-sm whitespace-pre-wrap line-clamp-6">{mod.content_body}</p>
                    </div>
                  )}
                  {Array.isArray(mod.quiz_questions) && mod.quiz_questions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                        Quiz — {mod.quiz_questions.length} question{mod.quiz_questions.length !== 1 ? "s" : ""}
                      </p>
                      <ol className="space-y-2 text-sm list-decimal pl-4">
                        {mod.quiz_questions.map((q: any, i: number) => (
                          <li key={i}>
                            <p className="font-medium">{q.question}</p>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {(q.choices ?? []).map((c: string, j: number) => (
                                <li key={j} className={j === q.correct ? "text-emerald-600 font-semibold" : ""}>
                                  {j === q.correct && <CheckCircle2 className="inline h-3 w-3 mr-1" />}
                                  {c}
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Create Module Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(v) => { setDialogOpen(v); if (!v) resetForm() }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Education Module</DialogTitle>
          </DialogHeader>

          {/* AI Generate section */}
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-medium flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              AI-Assisted Generation
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="Topic, e.g. Fair Housing Act compliance"
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                className="text-sm h-8"
              />
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 shrink-0"
                onClick={handleAiGenerate}
                disabled={aiGenerating || !aiTopic.trim()}
              >
                {aiGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Generate
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Module Title *</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fair Housing Compliance" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Description</Label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brief description of this module" />
              </div>
            </div>

            {/* Target Roles */}
            <div className="space-y-1">
              <Label className="text-xs">Target Roles</Label>
              <div className="flex flex-wrap gap-2">
                {TARGET_ROLES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() =>
                      setTargetRoles((prev) =>
                        prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
                      )
                    }
                    className={`px-2 py-0.5 rounded-full border text-xs capitalize transition-colors ${
                      targetRoles.includes(r)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-muted-foreground/30 hover:border-primary/50"
                    }`}
                  >
                    {r.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </div>

            {/* Required toggle */}
            <div className="flex items-center gap-3">
              <Switch id="required" checked={required} onCheckedChange={setRequired} />
              <Label htmlFor="required" className="text-sm cursor-pointer">Required module</Label>
            </div>

            {/* Content Body */}
            <div className="space-y-1">
              <Label className="text-xs">Content Body *</Label>
              <Textarea
                value={contentBody}
                onChange={(e) => setContentBody(e.target.value)}
                placeholder="Write or paste the module content here. Supports plain text and markdown."
                rows={8}
                className="text-sm font-mono resize-none"
              />
            </div>

            {/* Quiz Questions */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Quiz Questions</Label>
                <Button size="sm" variant="outline" className="text-xs h-7" onClick={addQuestion}>
                  <Plus className="h-3 w-3 mr-1" /> Add Question
                </Button>
              </div>
              {questions.map((q, qi) => (
                <div key={qi} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <p className="text-xs text-muted-foreground pt-1 shrink-0">Q{qi + 1}</p>
                    <Input
                      value={q.question}
                      onChange={(e) => updateQuestion(qi, "question", e.target.value)}
                      placeholder="Question text"
                      className="text-sm h-8"
                    />
                    {questions.length > 1 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0 text-destructive"
                        onClick={() => removeQuestion(qi)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="space-y-1 pl-5">
                    {q.choices.map((c, ci) => (
                      <div key={ci} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`correct-${qi}`}
                          checked={q.correct === ci}
                          onChange={() => updateQuestion(qi, "correct", ci)}
                          className="h-3 w-3 shrink-0"
                        />
                        <Input
                          value={c}
                          onChange={(e) => updateChoice(qi, ci, e.target.value)}
                          placeholder={`Choice ${ci + 1}`}
                          className="text-xs h-7"
                        />
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">Select the radio button next to the correct answer.</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setDialogOpen(false); resetForm() }}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Create Module
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
