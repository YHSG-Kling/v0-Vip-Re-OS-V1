"use client"

/**
 * "Command your team" bar — the One Command Center capstone. Type a plain-language instruction
 * ("what should I do today", "what do you know about the Hendersons", "cut a reel for 44 Birch")
 * and it routes through the SAME dispatcher the voice admin uses (runTeamCommand → the shared
 * dispatchTeamCommand). Read-only commands answer inline; acting verbs propose governed work into
 * the approval gate (nothing sends autonomously). Text and voice share one brain.
 */

import { useState, useTransition } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { runTeamCommand } from "@/app/actions/command-center"

const EXAMPLES = [
  "What should I do today?",
  "What do you know about the Hendersons?",
  "Anything happening near 44 Birch?",
  "Cut a reel for 12 Oak Street",
]

export function CommandBar() {
  const [text, setText] = useState("")
  const [pending, start] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; spoken: string; acting?: boolean } | null>(null)

  function submit() {
    const q = text.trim()
    if (!q || pending) return
    setResult(null)
    start(async () => {
      const r = await runTeamCommand(q)
      setResult(r)
    })
  }

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Command your team</h2>
      <Card className="space-y-3 p-4">
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit() }}
            disabled={pending}
            placeholder="Tell the team what to do…"
            aria-label="Command your AI team"
            className="flex-1 rounded-md border border-slate-300 bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60"
          />
          <Button onClick={submit} disabled={pending || !text.trim()}>
            {pending ? "Working…" : "Send"}
          </Button>
        </div>

        {!result && !pending && (
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setText(ex)}
                className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-200"
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {result && (
          <div className={`rounded-md px-3 py-2 text-sm ${result.ok ? "bg-slate-50 text-foreground" : "bg-amber-50 text-amber-800"}`}>
            <p>{result.spoken}</p>
            {result.ok && result.acting && (
              <p className="mt-1 text-xs text-green-700">✓ Proposed into the approval gate — review it below before it sends.</p>
            )}
          </div>
        )}
      </Card>
    </section>
  )
}
