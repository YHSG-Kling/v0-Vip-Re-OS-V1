"use client"

// AskYourHomeCard — "Ask your home anything." A self-serve AI assistant scoped to
// the client's OWN home: equity, value, market, vendors, what's in the portal.
// Answers route through the compliance-railed gateway (askHomeAssistant); the
// model is told to defer legal/tax/lending questions to the agent and never
// guarantee future value. A few suggested chips seed the conversation.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sparkles, Loader2, Send } from "lucide-react"
import { askHomeAssistant } from "@/app/actions/portal-lifetime"

const SUGGESTIONS = [
  "How much equity have I built?",
  "Is my neighborhood's market hot right now?",
  "Who can I call for home repairs?",
  "What does my home wealth story mean?",
]

export function AskYourHomeCard({
  contactId,
  agentFirstName,
}: {
  contactId: string
  agentFirstName?: string | null
}) {
  const [q, setQ] = useState("")
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const [asked, setAsked] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function ask(question: string) {
    const text = question.trim()
    if (text.length < 3) { setErr("Please type a question."); return }
    setErr(null)
    setBusy(true)
    setAsked(text)
    setAnswer(null)
    const res = await askHomeAssistant({ contactId, question: text })
    setBusy(false)
    if (res.ok) setAnswer(res.answer ?? "")
    else setErr(res.error ?? "Something went wrong — please try again.")
  }

  return (
    <Card className="shadow-lg border-0 md:col-span-2 lg:col-span-3">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-600" />
          Ask your home anything
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Curious about your equity, your market, or who to call for a repair? Ask away
          {agentFirstName ? ` — and ${agentFirstName} is always here for the big stuff.` : "."}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          onSubmit={(e) => { e.preventDefault(); void ask(q) }}
          className="flex gap-2"
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. How much has my home gone up since I bought it?"
            maxLength={500}
            disabled={busy}
          />
          <Button type="submit" disabled={busy} size="icon" className="shrink-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>

        {!answer && !busy && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => { setQ(s); void ask(s) }}
                className="text-xs rounded-full border border-border px-3 py-1 text-muted-foreground transition-colors hover:border-violet-400 hover:text-violet-700"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {(busy || answer) && asked && (
          <div className="rounded-lg bg-muted/50 p-3 space-y-2">
            <p className="text-xs font-medium text-foreground">{asked}</p>
            {busy ? (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />Thinking…
              </p>
            ) : (
              <p className="text-sm text-foreground whitespace-pre-line">{answer}</p>
            )}
          </div>
        )}

        {err && <p className="text-xs text-destructive">{err}</p>}
        <p className="text-[11px] text-muted-foreground">
          Estimates only — not legal, tax, or lending advice. For those, your agent will point you to the right pro.
        </p>
      </CardContent>
    </Card>
  )
}
