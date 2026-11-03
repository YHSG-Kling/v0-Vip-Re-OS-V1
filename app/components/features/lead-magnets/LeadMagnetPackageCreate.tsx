"use client"

// app/components/features/lead-magnets/LeadMagnetPackageCreate.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE CREATE DOOR FOR THE COMPLETE LEAD-MAGNET PACKAGE (wave 149, lane 149D — owner ruling 9, contract C30): "the agent uses the
// Create button on their dashboard and the AI asks the questions it needs, then completes everything". A thin caller of the
// session-gated createMagnetFunnelAction: the first click returns the questions (nothing is written); the answers build
// the magnet FIRST, then the landing page on the tenant's own website with the situation's questions, then the funnel + QR —
// as a DRAFT a person publishes. Imports a server action only (never lib — the proxy-graph rule). Palette tokens only.

import { useState } from "react"
import { createMagnetFunnelAction } from "@/app/actions/lead-magnets-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Sparkles } from "lucide-react"

type Question = { id: string; label: string; why: string; type: "select" | "text"; options?: Array<{ value: string; label: string }>; required: boolean }

export function LeadMagnetPackageCreate({ onBuilt }: { onBuilt?: (formId: string, slug: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function run() {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await createMagnetFunnelAction(answers)
      if (!res.success && "needsAnswers" in res && res.needsAnswers) { setQuestions(res.questions as Question[]); return }
      if (!res.success) { setError(res.error ?? "The package was not built"); return }
      const p = res.package
      const promised = p.funnel.deliverables.filter((d) => d.promised).map((d) => d.title)
      const bonus = p.funnel.deliverables.filter((d) => !d.promised && (d.status === "ready" || d.status === "staged")).map((d) => d.title)
      setNote(`Built in order — the magnet ("${p.magnet.topic}"), the landing page${p.landing.url ? ` (${p.landing.url})` : ""} and the funnel${p.qr ? " with its QR code" : ""}. The page promises: ${promised.join(", ") || "the magnet"}.${bonus.length ? ` Bonus: ${bonus.join(", ")}.` : ""} Review and publish it.`)
      setQuestions(null)
      onBuilt?.(p.form_id, p.funnel.landing_page.slug)
    } catch (e: any) {
      setError(e?.message ?? "The package was not built")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 pt-2 border-t">
      <p className="text-xs font-medium flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-primary" /> Create the complete package</p>
      <p className="text-[11px] text-muted-foreground">The AI asks a few questions, writes the lead magnet first, then the landing page on your website with the questions that fit the person&apos;s situation, then the funnel and its QR code — as a draft you approve.</p>
      {questions && questions.length > 0 && (
        <div className="space-y-2">
          {questions.map((q) => (
            <div key={q.id} className="space-y-1">
              <Label htmlFor={`lmp-${q.id}`} className="text-xs">{q.label}{q.required ? "" : " (optional)"}</Label>
              {q.type === "select" ? (
                <select id={`lmp-${q.id}`} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}>
                  <option value="">Choose…</option>
                  {(q.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <Input id={`lmp-${q.id}`} value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
              )}
              <p className="text-[11px] text-muted-foreground">{q.why}</p>
            </div>
          ))}
        </div>
      )}
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
        {questions ? "Build the package" : "Create"}
      </Button>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {note && <p className="text-xs text-muted-foreground" role="status">{note}</p>}
    </div>
  )
}
