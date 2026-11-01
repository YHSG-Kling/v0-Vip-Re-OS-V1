"use client"

/**
 * <IntentAffordance> — THE ONE VOICE / TEXT AFFORDANCE (C17, wave 148, lane 148D).
 *
 * Owner, verbatim: "when trying to create ads, blogs, etc. the actor/user should be able to speak the
 * search and what they want to accomplish in natural language and this should be the case in the whole
 * OS." One component, mounted on every screen INTENT_SCREENS lists (desktop + mobile), posting to ONE
 * door (/api/agentic-os/voice → interpretIntentLive → executeIntent). It is not a second assistant: the
 * always-on shell assistant renders THIS component for any plan the team brain hands back, and the
 * Voice Command Center's kernel-lane card (app/components/dashboard/voice/KernelPlanCard.tsx) is now
 * this component bound to that screen — its plan rendering, confirmation turn and refusal display were
 * merged here first.
 *
 * THE TURN, IN ORDER (the door's rails, shown to the person):
 *   speak or type → what I understood (the plan, in words) → what I still need (asked, never guessed —
 *   the answer is added to the same request) → may you? (the authority answer, in words, never colour
 *   alone) → "Yes, do it" for anything that changes something → what actually happened.
 *   An intent another surface still executes (the team brain, the field mic, the command layer) is handed
 *   to that surface's own door with the same words.
 *
 * ACCESSIBILITY (WCAG 2.2 AA — the accessibility skill): a labelled text input is ALWAYS present (voice is
 * an enhancement, hidden where the browser has no speech recognition); the mic is a real <button> with
 * aria-pressed and a text label; Escape stops listening; every answer lands in an aria-live region; status
 * is said in words on the badge, never by colour alone; controls are ≥ 36px; focus returns to the input
 * when a question is asked.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Loader2, Mic, Square, Send, CheckCircle2, ShieldAlert, HelpCircle, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import type { IntentInterpretation, IntentScreen } from "@/lib/voice-admin/intent-interface"
import type { IntentExecution } from "@/lib/voice-admin/intent-interface-live"

interface DoorResponse {
  utterance: string
  interpretation: IntentInterpretation
  execution: IntentExecution | null
  spokenSummary: string
  /** The legacy surface's own answer when the door handed the words off (command_layer / field_assistant) — run by the route, never by this component. */
  handoff?: { door: string; say: string } | null
}

type SpeechCtor = new () => {
  continuous: boolean; interimResults: boolean; lang: string
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null
  onerror: (() => void) | null; onend: (() => void) | null
  start(): void; stop(): void
}

/** Example requests per screen — placeholders, never sent on their own. */
const SCREEN_EXAMPLES: Record<string, string[]> = {
  ads: ["Create an ad for my new listing", "Make an Instagram ad for 12 Oak Street to get more showings"],
  blog: ["Write a blog on this month's market", "Draft a blog about first-time buyer costs in Frisco"],
  contacts: ["Show me which contacts may need help", "Find buyers interested in acreage"],
  open_houses: ["Schedule a virtual open house for 12 Oak Street Saturday 1 to 3 pm", "Schedule an open house for my new listing"],
  voice_center: ["Spin up a two-week plan for 123 Main and send the seller a reel", "Run a CMA on 412 Oak"],
  mobile: ["Who may need help today?", "Find homes with a big yard for the Hendersons"],
  assistant: ["Create an ad for my new listing", "Who may need help?"],
}

const STATUS_WORDS: Record<IntentExecution["status"], string> = {
  done: "Done",
  needs_confirmation: "Needs your yes",
  needs_info: "Needs one detail",
  refused: "Not allowed",
  handoff: "Handed to its desk",
  failed: "Didn't happen",
}

const STATUS_STYLE: Record<IntentExecution["status"], string> = {
  done: "bg-emerald-100 text-emerald-800 border-emerald-300",
  needs_confirmation: "bg-amber-100 text-amber-900 border-amber-300",
  needs_info: "bg-sky-100 text-sky-900 border-sky-300",
  refused: "bg-red-100 text-red-800 border-red-300",
  handoff: "bg-slate-100 text-slate-700 border-slate-300",
  failed: "bg-red-100 text-red-800 border-red-300",
}

export interface IntentAffordanceProps {
  /** The screen it is mounted on — one of INTENT_SCREENS (guard-held). */
  screen: IntentScreen
  /** What the page is about (a contact, a listing) — a hint the door re-reads under the session tenant. */
  context?: { contactId?: string | null; listingId?: string | null }
  /** A plan another surface already produced (the shell assistant hands the team brain's plan here). */
  seed?: { utterance: string; interpretation: IntentInterpretation | null } | null
  /** Smaller chrome for embedding (inside the assistant panel, a mobile card). */
  compact?: boolean
  title?: string
  className?: string
}

export function IntentAffordance({ screen, context, seed, compact, title, className }: IntentAffordanceProps) {
  const [text, setText] = useState("")
  const [request, setRequest] = useState<string>(seed?.utterance ?? "")
  const [modality, setModality] = useState<"voice" | "text">("text")
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceOk, setVoiceOk] = useState(false)
  const [answer, setAnswer] = useState<DoorResponse | null>(seed?.interpretation ? { utterance: seed.utterance, interpretation: seed.interpretation, execution: null, spokenSummary: seed.interpretation.plan.summary } : null)
  const [handoffSay, setHandoffSay] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const recRef = useRef<InstanceType<SpeechCtor> | null>(null)
  const inputId = `intent-input-${screen}`
  const liveId = `intent-live-${screen}`

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }
    setVoiceOk(!!(w.SpeechRecognition || w.webkitSpeechRecognition))
    return () => { try { recRef.current?.stop() } catch { /* already stopped */ } }
  }, [])

  const speak = useCallback((say: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis || !say) return
    try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(say)) } catch { /* TTS is an enhancement */ }
  }, [])

  const post = useCallback(async (utterance: string, how: "voice" | "text", confirmed: boolean) => {
    const said = utterance.trim()
    if (!said || busy) return
    setBusy(true)
    setRefusal(null)
    setHandoffSay(null)
    try {
      const res = await fetch("/api/agentic-os/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utterance: said, modality: how, screen, confirmed, context: context ?? {} }),
      })
      const json = (await res.json().catch(() => null)) as (DoorResponse & { error?: string }) | null
      if (!res.ok || !json) {
        // A refusal is the answer — and the previous plan is cleared so it never reads as this one's.
        setAnswer(null)
        setRefusal((json && typeof json.error === "string" && json.error) || `The assistant refused the request (HTTP ${res.status}).`)
        return
      }
      setAnswer(json)
      setRequest(said)
      if (how === "voice") speak(json.spokenSummary)
      if (json.execution?.status === "needs_info") inputRef.current?.focus()
      // An intent a legacy surface still executes: the SAME words to that surface's own door.
      if (json.execution?.status === "handoff" && json.execution.executorDoor) {
        const door = json.execution.executorDoor
        let say: string
        if (door === "team_brain") {
          const r = await fetch("/api/internal/voice-command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: said, modality: how }) })
          const j = (await r.json().catch(() => null)) as { spokenResponse?: string; spoken?: string; error?: string } | null
          say = j?.spokenResponse ?? j?.spoken ?? j?.error ?? `The team desk refused the request (HTTP ${r.status}).`
        } else if (door === "client_portal") {
          say = "That goes through the request card on your portal page, so your agent sees it."
        } else {
          // field_assistant / command_layer: the route already ran that surface's own door (server-side) and answered for it.
          say = json.handoff?.say ?? `That request is handled by the ${door.replace(/_/g, " ")}, which did not answer.`
        }
        setHandoffSay(say)
        if (how === "voice") speak(say)
      }
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : "Couldn't reach the assistant")
    } finally {
      setBusy(false)
    }
  }, [busy, context, screen, speak])

  /** A new sentence — or the answer to the question just asked, added to the same request. */
  const submit = useCallback((said: string, how: "voice" | "text") => {
    const value = said.trim()
    if (!value) return
    setModality(how)
    // A question is open when the door asked one, or when a seeded plan (from the shell assistant) is still missing a detail.
    const asking = answer?.execution?.status === "needs_info" || (!answer?.execution && (answer?.interpretation.missing.length ?? 0) > 0)
    const continuing = asking && request
    const utterance = continuing ? `${request}. ${value}` : value
    setText("")
    void post(utterance, how, false)
  }, [answer, post, request])

  const toggleMic = useCallback(() => {
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }
    const Rec = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!Rec) return
    if (listening) { try { recRef.current?.stop() } catch { /* stopped */ } return }
    const rec = new Rec()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = "en-US"
    let finalText = ""
    rec.onresult = (e) => {
      const parts = Array.from(e.results as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>)
      finalText = parts.map((r) => r[0]?.transcript ?? "").join(" ").trim()
      setText(finalText)
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => { setListening(false); if (finalText) submit(finalText, "voice") }
    recRef.current = rec
    setListening(true)
    try { rec.start() } catch { setListening(false) }
  }, [listening, submit])

  const exec = answer?.execution ?? null
  const interp = answer?.interpretation ?? null
  const examples = SCREEN_EXAMPLES[screen] ?? SCREEN_EXAMPLES.assistant

  return (
    <section
      aria-label={title ?? "Ask the assistant"}
      className={cn("rounded-lg border border-border bg-background", compact ? "p-3 space-y-2" : "p-4 space-y-3", className)}
    >
      {!compact && (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {title ?? "Say or type what you want done"}
          </h2>
          <p className="text-xs text-muted-foreground">
            In your own words — for example &ldquo;{examples[0]}&rdquo;. I&rsquo;ll tell you the plan, ask for anything
            missing, and nothing that changes anything happens until you say yes.
          </p>
        </div>
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => { e.preventDefault(); submit(text, "text") }}
      >
        <label htmlFor={inputId} className="sr-only">Tell the assistant what you want done</label>
        <Input
          id={inputId}
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && listening) { e.preventDefault(); try { recRef.current?.stop() } catch { /* stopped */ } } }}
          placeholder={exec?.status === "needs_info" ? "Your answer…" : examples[examples.length > 1 ? 1 : 0]}
          disabled={busy}
          aria-describedby={liveId}
          className="min-h-9 flex-1"
        />
        <div className="flex gap-2">
          {voiceOk && (
            <Button
              type="button"
              variant={listening ? "destructive" : "outline"}
              onClick={toggleMic}
              aria-pressed={listening}
              aria-label={listening ? "Stop listening" : "Speak your request"}
              disabled={busy}
              className="min-h-9"
            >
              {listening ? <Square className="h-4 w-4" aria-hidden="true" /> : <Mic className="h-4 w-4" aria-hidden="true" />}
              <span className="ml-1.5">{listening ? "Listening…" : "Speak"}</span>
            </Button>
          )}
          <Button type="submit" disabled={busy || !text.trim()} className="min-h-9" aria-label="Send your request">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
            <span className="ml-1.5">{exec?.status === "needs_info" ? "Answer" : "Go"}</span>
          </Button>
        </div>
      </form>

      <div id={liveId} aria-live="polite" className="space-y-2">
        {refusal && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{refusal}</span>
          </div>
        )}

        {answer && interp && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {exec && <Badge className={cn("text-[11px] border", STATUS_STYLE[exec.status])}>{STATUS_WORDS[exec.status]}</Badge>}
              {interp.capability && <Badge variant="outline" className="text-[11px]">{interp.plan.managerSpoken.replace(/^your /, "") || "assistant"}</Badge>}
              {interp.authority_check.approvalRequired && <Badge variant="outline" className="text-[11px]">Approver signs off before publishing</Badge>}
              <span className="text-[11px] text-muted-foreground">{modality === "voice" ? "heard" : "read"}: &ldquo;{answer.utterance}&rdquo;</span>
            </div>

            <p className="text-sm text-foreground">{answer.spokenSummary}</p>

            {exec?.status === "needs_info" && (
              <p className="flex items-start gap-1.5 text-xs text-foreground">
                <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Answer above and I&rsquo;ll add it to the same request{interp.missing.length > 1 ? ` (${interp.missing.length - 1} more after this: ${interp.missing.slice(1).map((m) => m.param.replace(/_/g, " ")).join(", ")})` : ""}.</span>
              </p>
            )}

            {interp.plan.steps.length > 0 && exec?.status !== "done" && (
              <ol className="list-decimal space-y-1 pl-5 text-xs text-foreground" aria-label="The plan">
                {interp.plan.steps.map((s, n) => <li key={n}>{s}</li>)}
              </ol>
            )}

            {interp.notes.length > 0 && (
              <ul className="space-y-1 text-xs text-amber-900" aria-label="Notes">
                {interp.notes.map((n, k) => <li key={k} className="rounded-md border border-amber-300 bg-amber-50 p-2">{n}</li>)}
              </ul>
            )}

            {exec && exec.results.length > 0 && exec.status !== "needs_confirmation" && exec.status !== "needs_info" && (
              <ul className="space-y-1.5" aria-label="Results">
                {exec.results.map((r, k) => (
                  <li key={k} className="rounded-md border border-border p-2 text-xs">
                    {r.href ? <a href={r.href} className="font-medium text-foreground underline underline-offset-2">{r.title}</a> : <span className="font-medium text-foreground">{r.title}</span>}
                    <div className="text-muted-foreground">{r.detail}</div>
                  </li>
                ))}
              </ul>
            )}

            {handoffSay && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs text-foreground">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{handoffSay}</span>
              </div>
            )}

            {exec?.error && exec.status === "failed" && (
              <p className="text-xs text-red-800">Reason: {exec.error}</p>
            )}

            {(exec?.status === "needs_confirmation" || (!exec && interp.plan.needsConfirmation)) && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void post(request || answer.utterance, modality, true)} disabled={busy} className="min-h-9">
                  {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                  Yes, do it
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setAnswer(null); setRequest("") }} disabled={busy} className="min-h-9">
                  Not now
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
