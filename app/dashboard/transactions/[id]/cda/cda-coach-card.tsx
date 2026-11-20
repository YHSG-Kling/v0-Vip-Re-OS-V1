"use client"

// THE AI SPLIT COACH (wave 151, lane 151K). The agent fills the CDA by hand from the brokerage's approved form; the coach explains
// the ORDER and the WHY of the commission waterfall and, in words, where the entered figures disagree with the deterministic check.
// It never proposes a number — any figure the agent did not type and the contract does not state is withheld before it is shown
// (lib/commission/cda-coach-rule.ts). It never fills the CDA.

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { explainCdaArithmeticAction } from "@/app/actions/transactions/cda-coach"

type Loaded = Extract<Awaited<ReturnType<typeof explainCdaArithmeticAction>>, { success: true }>

export function CdaCoachCard({ cdaId }: { cdaId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState("")
  const [pending, startTransition] = useTransition()

  const ask = () => {
    startTransition(async () => {
      const r = await explainCdaArithmeticAction({ cdaId, question: question.trim() || null })
      if (!r.success) { setError(r.error); return }
      setError(null)
      setData(r)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commission coach — the arithmetic, explained</CardTitle>
        <CardDescription>
          You fill the CDA from your brokerage&apos;s approved form. The coach explains each step of the waterfall and where your entries
          disagree with the agreement on file — in words. It never proposes a figure and never fills the CDA.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Optional: what would you like explained? (e.g. why the referral comes off before the split)" rows={2} />
        <Button size="sm" onClick={ask} disabled={pending}>{pending ? "Explaining…" : "Explain the arithmetic"}</Button>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {data && (
          <div className="space-y-2">
            <ul className="list-disc pl-5">{data.sentences.map((s, i) => <li key={i} className={s.startsWith("[a figure was withheld") ? "text-muted-foreground italic" : ""}>{s}</li>)}</ul>
            {data.discrepancies.length > 0 && (
              <p className="text-xs text-muted-foreground">The deterministic check flagged: {data.discrepancies.map((d) => `${d.field.replace(/_/g, " ")} (${d.severity})`).join(", ")} — re-read the agreement and the CDA form; you enter the figure.</p>
            )}
            {data.withheld > 0 && <p className="text-xs text-muted-foreground">{data.withheld} sentence(s) were withheld because they carried a figure you did not enter.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
