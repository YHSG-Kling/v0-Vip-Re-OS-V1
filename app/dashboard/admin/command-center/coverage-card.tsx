"use client"

/**
 * COVERAGE MODE card (forgotten-items #12) — vacation/illness/leave without
 * a dropped ball: pick who's away, who covers, until when. New leads
 * redirect at the assignment terminal; the away agent's book never moves;
 * coverage expires on its own or is cleared here. Principal-gated action.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Umbrella, Loader2, Check } from "lucide-react"
import { setCoverageAction } from "@/app/actions/coverage-mode"

export interface CoverageAgentOption { agentId: string; name: string }
export interface ActiveCoverage { awayName: string; coveringName: string; until: string; awayAgentId: string }

export function CoverageCard({ agents, active }: { agents: CoverageAgentOption[]; active: ActiveCoverage[] }) {
  const [away, setAway] = useState("")
  const [covering, setCovering] = useState("")
  const [until, setUntil] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const save = () => {
    setNote(null)
    startTransition(async () => {
      const r = await setCoverageAction({ awayAgentId: away, coveringAgentId: covering, until: until ? new Date(until).toISOString() : null })
      setNote(r.ok ? "Coverage set — new leads redirect until it expires." : r.error)
    })
  }

  const clear = (awayAgentId: string) => {
    startTransition(async () => {
      const r = await setCoverageAction({ awayAgentId, coveringAgentId: null })
      setNote(r.ok ? "Coverage cleared — they're back." : r.error)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Umbrella className="h-4 w-4 text-sky-700" /> Coverage mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {active.length > 0 && (
          <ul className="space-y-1 text-xs">
            {active.map((c) => (
              <li key={c.awayAgentId} className="flex items-center gap-2">
                <span><span className="font-medium">{c.awayName}</span> is covered by <span className="font-medium">{c.coveringName}</span> until {new Date(c.until).toLocaleDateString()}</span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => clear(c.awayAgentId)}>They're back</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select value={away} onChange={(e) => setAway(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
            <option value="">Who's away…</option>
            {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
          </select>
          <select value={covering} onChange={(e) => setCovering(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
            <option value="">Covered by…</option>
            {agents.filter((a) => a.agentId !== away).map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
          </select>
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs" />
          <Button size="sm" className="h-7 text-xs" onClick={save} disabled={pending || !away || !covering || !until}>
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Set coverage
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Their book stays theirs — only NEW leads redirect while they're out.</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  )
}
