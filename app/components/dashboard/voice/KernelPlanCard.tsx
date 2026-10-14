"use client"

/**
 * <KernelPlanCard> — THE HUMAN DOOR ONTO THE MULTI-STEP VOICE LANE.
 *
 * app/api/agentic-os/voice/route.ts was built to give lib/voice-admin/plan-voice-command.ts
 * a caller, and it closed exactly half the loop: the planner gained an HTTP door and
 * NOTHING IN THE TREE ADDRESSED IT. The route's own header names the reason it cannot be
 * an external door either — it refuses a bearer token outright, because `spoken_by` is a
 * users.id and an agent credential has no human behind it. A session-only endpoint that no
 * session-bearing surface calls is not "unreferenced by design" (CLAUDE.md §1): it is a
 * loop that was never closed. This card closes it.
 *
 * WHY IT SITS BESIDE THE DIRECT LANE RATHER THAN REPLACING IT. WakeWordCard/QuickCommandGrid
 * drive handleVoiceCommand → COMMAND_EXECUTORS: ONE verb, executed now. That lane is
 * untouched and stays the front door for a single command. This is the KERNEL lane —
 * an utterance naming SEVERAL capabilities becomes a plan, one governed manager signal per
 * step, and nothing mutating moves until the speaker says yes. The two lanes answer
 * different questions, so both are on the page.
 *
 * TWO REFUSALS ARE RENDERED, NOT SWALLOWED:
 *   · `error` from the planner (it never throws by contract — a voice surface that 500s
 *     mid-sentence is worse than one that says it could not tell), and
 *   · `failed[]`, the dispatches that did not land. A confirmed turn that says "on it"
 *     about work nobody received is the exact failure this panel exists to prevent.
 *
 * CONFIRMATION IS A SECOND REQUEST — the planner's rule, not this component's. The first
 * POST is always safe to make: building the plan is how the voice admin knows what to say.
 */

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Loader2, ListChecks, ShieldAlert, AlertTriangle, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

/** Exactly the shape app/api/agentic-os/voice/route.ts returns. */
interface PlanLine {
  text: string
  capability: string
  manager: string
  disposition: string
  mutates: boolean
}

interface KernelPlanResponse {
  utterance: string
  confirmed: boolean
  spokenSummary: string
  lines: PlanLine[]
  actionable: boolean
  awaitingConfirmation: number
  dispatched: Array<{ capability: string; manager: string; signalId?: string }>
  failed: Array<{ capability: string; reason: string }>
  error: string | null
}

/** Human label for a machine-facing capability/manager key. */
function humanize(key: string): string {
  return key
    .split("_")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
}

const DISPOSITION_STYLE: Record<string, string> = {
  ready: "bg-emerald-100 text-emerald-800 border-emerald-300",
  needs_confirmation: "bg-amber-100 text-amber-900 border-amber-300",
  not_authorized: "bg-red-100 text-red-800 border-red-300",
  not_operable: "bg-slate-100 text-slate-700 border-slate-300",
}

export function KernelPlanCard() {
  const [utterance, setUtterance] = useState("")
  const [plan, setPlan] = useState<KernelPlanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  /** A transport/auth refusal (401/403/400) — distinct from the planner's own `error`. */
  const [refusal, setRefusal] = useState<string | null>(null)

  async function post(confirmed: boolean) {
    const said = utterance.trim()
    if (!said || busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const res = await fetch("/api/agentic-os/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utterance: said, confirmed }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        // The route answers 401/403/400 with { error }. Show the REASON — the 403 for a
        // bearer token and the 401 for a signed-out tab say different things.
        setRefusal(
          (json && typeof json.error === "string" && json.error) ||
            `The kernel lane refused the request (HTTP ${res.status}).`,
        )
        // CLEAR THE STALE PLAN. Leaving the previous utterance's plan on screen beside
        // a refusal reads as "here is the plan for what you just said" — the refusal
        // means there is no plan for this utterance at all.
        setPlan(null)
        return
      }
      setPlan(json as KernelPlanResponse)
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : "Could not reach the kernel voice lane")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ListChecks className="h-4 w-4" />
          Multi-step command (kernel lane)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Say something that spans several capabilities — &ldquo;spin up a two-week plan for 123 Main
          and send the seller a reel&rdquo;. You get a plan first, attributed to the manager that owns
          each step. Nothing that changes anything runs until you confirm.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={utterance}
            onChange={(e) => setUtterance(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void post(false)
            }}
            placeholder="What do you want the team to do?"
            disabled={busy}
          />
          <Button onClick={() => void post(false)} disabled={busy || !utterance.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Plan"}
          </Button>
        </div>

        {refusal && (
          <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{refusal}</span>
          </div>
        )}

        {plan && (
          <div className="space-y-2">
            <p className="text-sm text-foreground">{plan.spokenSummary}</p>

            {plan.lines.length > 0 && (
              <ul className="space-y-1.5">
                {plan.lines.map((l, i) => (
                  <li
                    key={`${l.capability}-${i}`}
                    className="rounded-md border border-border p-2 text-xs space-y-1"
                  >
                    <div className="text-foreground">{l.text}</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {humanize(l.manager)}
                      </Badge>
                      <Badge
                        className={cn(
                          "text-[10px]",
                          DISPOSITION_STYLE[l.disposition] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {l.disposition.replace(/_/g, " ")}
                      </Badge>
                      {l.mutates && (
                        <Badge variant="outline" className="text-[10px]">
                          changes data
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* The planner never throws; anything it could not do arrives here. */}
            {plan.error && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{plan.error}</span>
              </div>
            )}

            {plan.dispatched.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Sent to{" "}
                  {plan.dispatched.map((d) => humanize(d.manager)).join(", ")} —{" "}
                  {plan.dispatched.length} step{plan.dispatched.length === 1 ? "" : "s"} on the bus.
                </span>
              </div>
            )}

            {/* A dispatch that failed quietly would have the voice admin say "on it"
                about work nobody received. */}
            {plan.failed.length > 0 && (
              <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 space-y-1">
                {plan.failed.map((f, i) => (
                  <div key={`${f.capability}-${i}`}>
                    <span className="font-medium">{humanize(f.capability)}</span> did not go out —{" "}
                    {f.reason}
                  </div>
                ))}
              </div>
            )}

            {plan.awaitingConfirmation > 0 && !plan.confirmed && (
              <Button size="sm" onClick={() => void post(true)} disabled={busy}>
                {busy ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Confirm {plan.awaitingConfirmation} step
                {plan.awaitingConfirmation === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
