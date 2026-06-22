"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Progress } from "@/components/ui/progress"
import { ArrowLeft, Award, CheckCircle2, Clock, XCircle, BookOpen } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { markModuleViewed, submitModuleQuiz, type LearnerModuleView, type QuizSubmitResult } from "@/app/actions/academy-learning"

export function ModuleReaderClient({ module: mod }: { module: LearnerModuleView }) {
  const { toast } = useToast()
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<QuizSubmitResult | null>(null)
  const [certified, setCertified] = useState(mod.certified)

  // Record the view once on open (idempotent server-side).
  useEffect(() => {
    void markModuleViewed(mod.id)
  }, [mod.id])

  const allAnswered = mod.questionCount > 0 && Object.keys(answers).length === mod.questionCount

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const r = await submitModuleQuiz(mod.id, answers)
      if (!r.ok) {
        toast({ title: "Could not submit", description: r.error, variant: "destructive" })
        return
      }
      setResult(r)
      if (r.certIssued) setCertified(true)
      toast({
        title: r.passed ? "Passed!" : "Not quite yet",
        description: r.passed
          ? `You scored ${r.score}%${r.certIssued ? " — certification earned." : "."}`
          : `You scored ${r.score}%. ${r.passingScore}% is needed to pass — review and retry.`,
        variant: r.passed ? "default" : "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  const correctness = (idx: number): "correct" | "wrong" | null => {
    if (!result) return null
    const pq = result.perQuestion.find((p) => p.index === idx)
    if (!pq) return null
    return pq.isCorrect ? "correct" : "wrong"
  }

  return (
    <div className="container mx-auto max-w-3xl py-8 space-y-6">
      <Link href="/academy" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Academy
      </Link>

      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-2xl font-bold">{mod.title}</h1>
          {mod.required && <Badge variant="secondary">Required</Badge>}
          {certified && (
            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 gap-1">
              <Award className="h-3 w-3" /> Certified
            </Badge>
          )}
          {!certified && mod.status === "completed" && (
            <Badge className="bg-blue-100 text-blue-700 border-blue-200 gap-1">
              <CheckCircle2 className="h-3 w-3" /> Completed
            </Badge>
          )}
        </div>
        {mod.summary && <p className="text-muted-foreground">{mod.summary}</p>}
        {mod.estimatedMinutes != null && mod.estimatedMinutes > 0 && (
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" /> ~{mod.estimatedMinutes} min
          </p>
        )}
      </div>

      {/* Lesson body */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4" /> Lesson
          </CardTitle>
        </CardHeader>
        <CardContent>
          {mod.body ? (
            <div className="prose prose-sm max-w-none whitespace-pre-wrap leading-relaxed">{mod.body}</div>
          ) : (
            <p className="text-muted-foreground">No written lesson content for this module.</p>
          )}
        </CardContent>
      </Card>

      {/* Quiz */}
      {mod.questionCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Knowledge Check</CardTitle>
            <CardDescription>
              {mod.required
                ? `Pass with ${mod.passingScore}% to earn your certification.`
                : `Score ${mod.passingScore}% to mark this module complete.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {result && (
              <div className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center gap-2">
                  {result.passed ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-600" />
                  )}
                  <span className="font-semibold">
                    {result.correct}/{result.total} correct — {result.score}%
                  </span>
                </div>
                <Progress value={result.score} />
              </div>
            )}

            {mod.questions.map((question, idx) => {
              const state = correctness(idx)
              return (
                <div key={idx} className="space-y-2">
                  <p className="font-medium flex items-start gap-2">
                    <span className="text-muted-foreground">{idx + 1}.</span>
                    <span className="flex-1">{question.q}</span>
                    {state === "correct" && <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-1" />}
                    {state === "wrong" && <XCircle className="h-4 w-4 text-red-600 mt-1" />}
                  </p>
                  <RadioGroup
                    value={answers[idx]?.toString() ?? ""}
                    onValueChange={(v) => setAnswers((a) => ({ ...a, [idx]: Number(v) }))}
                    disabled={submitting || (result?.passed ?? false)}
                  >
                    {question.choices.map((choice, cIdx) => (
                      <div key={cIdx} className="flex items-center gap-2">
                        <RadioGroupItem value={cIdx.toString()} id={`q${idx}-c${cIdx}`} />
                        <label htmlFor={`q${idx}-c${cIdx}`} className="text-sm cursor-pointer">
                          {choice}
                        </label>
                      </div>
                    ))}
                  </RadioGroup>
                  {state === "wrong" && question.explainer && (
                    <p className="text-xs text-muted-foreground border-l-2 border-amber-400 pl-2">{question.explainer}</p>
                  )}
                </div>
              )
            })}

            {!(result?.passed ?? false) && (
              <Button onClick={handleSubmit} disabled={!allAnswered || submitting}>
                {submitting ? "Submitting…" : result ? "Retry Quiz" : "Submit Quiz"}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
