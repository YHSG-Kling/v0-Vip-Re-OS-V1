"use client"

/**
 * BookProjectPanel — the AI-written BOOK a lead magnet carries (wave 142, lane 142E;
 * lib/lead-magnets/book-creator.ts). The pipeline is STAGED (research → outline → chapters → fact check →
 * edit → layout → ready for review); each advance runs one stage through the server action, and this panel
 * keeps asking for the next one until the book is ready — the human then reads the chapters, the fact-check
 * and fair-housing trail, downloads the PDF, and approves the lead magnet (publish refuses an unfinished
 * book). "Pause" stops the auto-continue; the daily sweep is the safety net for a closed tab.
 */

import { useEffect, useRef, useState } from "react"
import { advanceBookProjectAction, getBookProjectAction, reviseBookChapterAction } from "@/app/actions/lead-magnets-actions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { BookOpen, Download, Loader2, Pause, Play } from "lucide-react"

type BookSummary = NonNullable<Awaited<ReturnType<typeof getBookProjectAction>> extends { book?: infer B } ? B : never>

const STAGE_LABELS: Record<string, string> = {
  research: "Researching what readers ask",
  outline: "Planning the chapters",
  chapters: "Writing original chapters",
  fact_check: "Fact-checking every claim",
  edit: "Editing (facts + fair housing)",
  layout: "Cover, contents and layout",
  ready_for_review: "Ready for your review",
}

interface Props {
  magnetId: string
  /** Called when the stage changes so the parent can enable publish once the book is ready. */
  onStage?: (stage: string) => void
}

export function BookProjectPanel({ magnetId, onStage }: Props) {
  const [book, setBook] = useState<BookSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(true)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  // THE HUMAN'S REWRITE of an escalated chapter — the AI reached its cap, so the reviewer owns the words now.
  const [revising, setRevising] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<number | null>(null)
  const alive = useRef(true)

  async function handleReviseChapter(n: number) {
    const text = (revising[n] ?? book?.chapters[n - 1]?.body ?? "").trim()
    setSaving(n)
    setError(null)
    try {
      const r = await reviseBookChapterAction(magnetId, n, text)
      if (!alive.current) return
      if (!r.success) { setError(r.error ?? "The revision was not saved"); return }
      setBook(r.book ?? null)
      setPdfUrl(r.book?.pdfUrl ?? null)
      onStage?.(r.stage)
      setRevising((prev) => { const next = { ...prev }; delete next[n]; return next })
      // The corrected book re-lays out (a fresh PDF) — resume the auto-continue.
      setAuto(true)
    } finally {
      if (alive.current) setSaving(null)
    }
  }

  useEffect(() => {
    alive.current = true
    getBookProjectAction(magnetId).then((r) => {
      if (!alive.current) return
      if (!r.success) { setError(r.error ?? "Could not load the book"); return }
      setBook(r.book ?? null)
      setPdfUrl(r.ref?.pdfUrl ?? r.book?.pdfUrl ?? null)
      if (r.book?.stage) onStage?.(r.book.stage)
    })
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magnetId])

  // AUTO-CONTINUE: while the book is unfinished and not paused, ask for the next stage as soon as the last one lands.
  useEffect(() => {
    if (!auto || busy || !book || book.stage === "ready_for_review") return
    let cancelled = false
    setBusy(true)
    setError(null)
    advanceBookProjectAction(magnetId).then((r) => {
      if (cancelled || !alive.current) return
      setBusy(false)
      if (!r.success) { setError(r.error ?? "The stage did not land — continue when ready."); setAuto(false); return }
      setBook(r.book ?? null)
      setPdfUrl(r.book?.pdfUrl ?? null)
      onStage?.(r.stage)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, book?.stage, book?.chapters.length, book?.chapters.filter((c) => c.edited).length])

  if (error && !book) return <p className="text-sm text-destructive" role="alert">{error}</p>
  if (!book) return <p className="text-sm text-muted-foreground">Loading the book…</p>

  const done = book.stage === "ready_for_review"
  const stageIndex = ["research", "outline", "chapters", "fact_check", "edit", "layout", "ready_for_review"].indexOf(book.stage)

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium">{book.title}</p>
          <Badge variant={done ? "default" : "outline"}>{STAGE_LABELS[book.stage] ?? book.stage}</Badge>
        </div>
        {!done && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setAuto((a) => !a)} disabled={busy && auto}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : auto ? <Pause className="h-4 w-4 mr-1" /> : <Play className="h-4 w-4 mr-1" />}
            {busy ? "Working…" : auto ? "Pause" : "Continue writing"}
          </Button>
        )}
      </div>
      {book.subtitle && <p className="text-xs text-muted-foreground">{book.subtitle}</p>}

      <ol className="grid grid-cols-4 sm:grid-cols-7 gap-1 text-[10px] text-muted-foreground" aria-label="Book stages">
        {["Research", "Outline", "Chapters", "Fact check", "Edit", "Layout", "Review"].map((label, i) => (
          <li key={label} className={`rounded px-1 py-1 text-center ${i < stageIndex ? "bg-green-100 text-green-800" : i === stageIndex ? "bg-primary/10 text-primary font-medium" : "bg-muted"}`}>{label}</li>
        ))}
      </ol>

      {book.outline.length > 0 && (
        <ul className="space-y-1">
          {book.outline.map((heading, i) => {
            const ch = book.chapters[i]
            return (
              <li key={heading} className="text-xs flex items-start gap-2">
                <span className="font-mono text-muted-foreground w-6 shrink-0">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{heading}</span>
                  {ch ? <span className="text-muted-foreground"> — {ch.words} words{ch.edited ? ", edited" : ""}</span> : <span className="text-muted-foreground"> — not written yet</span>}
                  {ch?.escalated && <p className="text-destructive">Fair-housing review needed: the AI rewrote this chapter twice and it still mentions {ch.findings.join(", ")} — rewrite it below before publishing.</p>}
                  {ch?.escalated ? (
                    <div className="mt-1 space-y-1">
                      <Textarea rows={8} aria-label={`Rewrite chapter ${i + 1}`} value={revising[i + 1] ?? ch.body ?? ""} onChange={(e) => setRevising((prev) => ({ ...prev, [i + 1]: e.target.value }))} />
                      <Button type="button" size="sm" variant="secondary" disabled={saving === i + 1 || busy} onClick={() => void handleReviseChapter(i + 1)}>
                        {saving === i + 1 ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                        Save corrected chapter
                      </Button>
                    </div>
                  ) : ch?.preview ? <p className="text-muted-foreground line-clamp-2">{ch.preview}</p> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{book.chapters.length} chapter(s)</span>
        <span>{book.factFindings} fact-check finding(s)</span>
        <span>{book.cost.model_calls} model call(s), {book.cost.tokens.toLocaleString()} tokens</span>
        {book.pageCount ? <span>{book.pageCount} pages</span> : null}
      </div>

      {done && pdfUrl && (
        <a href={pdfUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-primary hover:underline">
          <Download className="h-4 w-4" /> Download the finished book (PDF)
        </a>
      )}
      {done && book.needsHumanReview.length > 0 && (
        <p className="text-xs text-destructive">Chapter{book.needsHumanReview.length === 1 ? "" : "s"} {book.needsHumanReview.join(", ")} need{book.needsHumanReview.length === 1 ? "s" : ""} your fair-housing rewrite — the AI reached its two-rewrite cap.</p>
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {book.log.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">What the writer did</summary>
          <ul className="mt-1 space-y-0.5">{book.log.map((l, i) => <li key={i}>{new Date(l.at).toLocaleString()} — {l.note}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
