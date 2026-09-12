"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Send } from "lucide-react"
import Link from "next/link"
import { askEducationTutor } from "@/app/actions/education-tutor"

/**
 * <EducationTutorCard> — the client's on-demand education tutor in the portal. Ask a plain-language
 * question ("what does clear to close mean?") and get a calm, client-safe answer + related lessons. Every
 * question feeds the OS's question→curriculum loop.
 */
export function EducationTutorCard({ contactId }: { contactId: string }) {
  const [q, setQ] = useState("")
  const [answer, setAnswer] = useState<string | null>(null)
  const [related, setRelated] = useState<Array<{ id: string; title: string | null }>>([])
  const [busy, setBusy] = useState(false)

  const SUGGESTIONS = ["What happens next?", "What does clear to close mean?", "How does the appraisal work?", "What should I be doing right now?"]

  async function ask(question: string) {
    const text = question.trim()
    if (!text || busy) return
    setBusy(true); setAnswer(null)
    try {
      const res = await askEducationTutor(contactId, text)
      setAnswer(res.answer)
      setRelated(res.relatedModules)
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5" /> Ask anything</CardTitle>
        <CardDescription>Your AI guide explains what's happening and what to expect — in plain language, anytime.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={(e) => { e.preventDefault(); ask(q) }} className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask about your home journey…"
            className="flex-1 border rounded-md px-3 py-2 text-sm"
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || !q.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>

        {!answer && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => { setQ(s); ask(s) }} disabled={busy}
                className="text-xs px-2.5 py-1 rounded-full border text-muted-foreground hover:bg-muted disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
        )}

        {busy && <p className="text-sm text-muted-foreground">Thinking…</p>}

        {answer && (
          <div className="space-y-3">
            <div className="text-sm whitespace-pre-wrap leading-relaxed">{answer}</div>
            {related.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Related lessons</p>
                <div className="flex flex-wrap gap-1.5">
                  {related.map((m) => (
                    // `m.id` is a learning_modules.id. The learn page's client
                    // reads `?module=` and opens that lesson's drawer once
                    // (app/portal/[contactId]/learn/learn-client.tsx). Same
                    // portal, same contactId, so the clicker sees only their
                    // own lessons. Was a bare link to the learn page after the
                    // 2026-09-02 dangling-link repoint, when nothing read a
                    // module id.
                    <Link key={m.id} href={`/portal/${contactId}/learn?module=${m.id}`}>
                      <Badge variant="outline" className="text-xs cursor-pointer hover:bg-muted">{m.title ?? "Lesson"}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
