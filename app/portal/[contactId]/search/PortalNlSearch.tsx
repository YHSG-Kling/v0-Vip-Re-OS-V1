"use client"

/**
 * PORTAL NATURAL-LANGUAGE SEARCH (owner rule) — the buyer types what they'd
 * SAY: "3 bed under 600k with a yard near downtown". The intent parser +
 * inventory/RentCast engine the agents already use, now in the buyer's own
 * hands on their portal.
 *
 * WAVE 147C (owner ruling 16, contract C10) — THE CONVERSATION, INSIDE THIS SAME SEARCH.
 * Type or TAP-TO-TALK; each turn goes through buyerConversationTurnAction (criteria with
 * per-field provenance into the one store, "what you didn't say" questions back) and then the
 * ONE search door, portalNaturalSearchAction, which reads that store. Every home shows what
 * matches, what misses, and what the listing data cannot tell (unknowns — never guessed).
 * Save / not-for-me / tour / a note teach the search WITH A REASON the buyer can accept or
 * undo. Voice turn-taking (lib/buyer-search/voice-turn.ts): the portal listens only after a
 * tap, answers short with ONE question, and a tap while it speaks cancels the speech.
 */

import { useEffect, useRef, useState, useTransition } from "react"
import { Search, Loader2, Mic, Square, Heart, ThumbsDown, CalendarPlus, Check, X, HelpCircle, Undo2, MessageCircle } from "lucide-react"
import { portalNaturalSearchAction, type PortalSearchResult } from "@/app/actions/portal-nl-search"
import {
  buyerConversationTurnAction,
  buyerHomeFeedbackAction,
  decideCriteriaChangeAction,
  loadBuyerCriteriaStateAction,
  explainHomeForBuyerAction,
  editBuyerCriteriaAction,
  buyerKeepWatchingAction,
} from "@/app/actions/buyer-search/conversational-search"
import type { CriteriaChip, NextExperience } from "@/lib/buyer-search/conversational-search"
import type { ClarifyingQuestion } from "@/lib/buyer-search/conversation-criteria"
import { voiceTurnPlan } from "@/lib/buyer-search/voice-turn"
import { usdOrDash } from "@/lib/format/money"

// TOMBSTONE (§1.1, 2026-09-08): local `usd` lived here; survivor lib/format/money.ts:usdOrDash
const usd = usdOrDash

interface ChangeLine { id: string | null; field: string; reason: string; status: string }

const PROVENANCE_LABEL: Record<CriteriaChip["provenance"], string> = { said: "you said", inferred: "learned", default: "default" }

export function PortalNlSearch({ contactId }: { contactId: string }) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<PortalSearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chips, setChips] = useState<CriteriaChip[]>([])
  const [changes, setChanges] = useState<ChangeLine[]>([])
  const [proposals, setProposals] = useState<ChangeLine[]>([])
  const [questions, setQuestions] = useState<ClarifyingQuestion[]>([])
  const [nextBest, setNextBest] = useState<NextExperience[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [whyText, setWhyText] = useState<Record<string, string>>({})
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [noteText, setNoteText] = useState("")
  const [voiceOk, setVoiceOk] = useState(false)
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [pending, startTransition] = useTransition()
  const recRef = useRef<any>(null)

  useEffect(() => {
    const w = window as any
    setVoiceOk(!!(w.SpeechRecognition || w.webkitSpeechRecognition))
    loadBuyerCriteriaStateAction({ contactId }).then((s) => {
      if (!s.ok) return
      setChips(s.criteria)
      setProposals(s.proposals.map((p) => ({ id: p.id, field: p.field, reason: p.reason, status: p.status })))
      setChanges(s.recent.map((p) => ({ id: p.id, field: p.field, reason: p.reason, status: p.status })))
      setNotes(s.notes)
    }).catch(() => { /* the search still works without the saved state */ })
  }, [contactId])

  const speak = (text: string) => {
    const w = window as any
    if (!w.speechSynthesis) return
    w.speechSynthesis.cancel()
    const u = new w.SpeechSynthesisUtterance(text)
    u.onend = () => setSpeaking(false)
    setSpeaking(true)
    w.speechSynthesis.speak(u)
  }

  const run = (said: string = query, channel: "portal" | "voice" = "portal") => {
    setError(null)
    startTransition(async () => {
      const t = await buyerConversationTurnAction({ contactId, text: said, channel })
      if (t.ok) {
        setChips(t.criteria)
        setChanges((prev) => [...t.changes.filter((c) => c.id).map((c) => ({ id: c.id, field: c.field, reason: c.reason, status: c.status })), ...prev].slice(0, 8))
        setQuestions(t.clarifications)
        setNextBest(t.nextBest)
        setNotes(t.notes)
      } else {
        setNotes([t.error])
      }
      const r = await portalNaturalSearchAction({ contactId, query: said })
      if (r.ok) { setResults(r.results); if (r.criteria.length) setChips(r.criteria); if (channel === "voice") speak(voiceTurnPlan({ results: r.results.map((m) => ({ label: m.address ?? m.city ?? "A home", price: m.price, fit: m.fit })), clarifications: t.ok ? t.clarifications : [], changedFields: t.ok ? t.changes.map((c) => c.field) : [] }).spoken) }
      else { setResults(null); setError(r.error) }
    })
  }

  const listen = () => {
    const w = window as any
    if (speaking) { w.speechSynthesis?.cancel(); setSpeaking(false) } // barge-in: the buyer has the floor
    if (listening) { recRef.current?.stop(); return }
    const Rec = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!Rec) return
    const rec = new Rec()
    rec.lang = "en-US"
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e: any) => {
      const last = e.results[e.results.length - 1]
      const heard = String(last[0]?.transcript ?? "")
      setQuery(heard)
      if (last.isFinal && heard.trim().length >= 5) run(heard, "voice")
    }
    rec.onerror = () => setNotes(["I couldn't hear that — try again, or type it."])
    rec.onend = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  const react = (m: PortalSearchResult, kind: "saved" | "dismissed" | "tour_requested" | "feedback", note?: string) => {
    if (!m.listingId) return
    startTransition(async () => {
      const f = await buyerHomeFeedbackAction({ contactId, listingId: m.listingId!, kind, note })
      if (!f.ok) { setNotes([f.error]); return }
      if (f.criteria.length) setChips(f.criteria)
      setProposals((prev) => [...f.proposals.filter((p) => p.id).map((p) => ({ id: p.id, field: p.field, reason: p.reason, status: p.status })), ...prev])
      setChanges((prev) => [...f.applied.filter((p) => p.id).map((p) => ({ id: p.id, field: p.field, reason: p.reason, status: p.status })), ...prev].slice(0, 8))
      setNotes([
        kind === "tour_requested" ? "Your agent has been told you'd like to tour it." : kind === "dismissed" ? "Got it — not for you." : kind === "saved" ? "Saved." : "Thanks — noted.",
        ...f.notes,
      ])
      if (f.showingRequestPath) window.location.assign(f.showingRequestPath)
    })
  }

  const decide = (c: ChangeLine, decision: "accept" | "reject") => {
    if (!c.id) return
    startTransition(async () => {
      const d = await decideCriteriaChangeAction({ contactId, changeId: c.id!, decision })
      if (!d.ok) { setNotes([d.error]); return }
      setChips(d.criteria)
      setProposals((prev) => prev.filter((p) => p.id !== c.id))
      setChanges((prev) => prev.filter((p) => p.id !== c.id))
    })
  }

  // The buyer edits their own criteria (a chip): numbers inline, buy/rent toggles, a list clears.
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const NUMERIC = new Set(["minPrice", "maxPrice", "minBeds", "minBaths"])
  const LISTS = new Set(["cities", "zipCodes", "propertyTypes", "mustHaveFeatures", "dealBreakers"])
  const edit = (field: string, value: unknown) => {
    startTransition(async () => {
      const e = await editBuyerCriteriaAction({ contactId, field, value })
      if (!e.ok) { setNotes([e.error]); return }
      setChips(e.criteria)
      setEditing(null)
      setNotes([e.agentNotified ? "Updated — your agent can see the change." : "Updated."])
    })
  }
  const chipAction = (c: CriteriaChip) => {
    if (NUMERIC.has(c.field)) { setEditing(c.field); setEditValue(""); return }
    if (c.field === "listingType") { edit("listingType", /Renting/.test(c.label) ? "sale" : "rent"); return }
    if (LISTS.has(c.field)) edit(c.field, [])
  }

  const why = (m: PortalSearchResult) => {
    if (!m.listingId) return
    startTransition(async () => {
      const x = await explainHomeForBuyerAction({ contactId, listingId: m.listingId! })
      setWhyText((prev) => ({ ...prev, [m.listingId!]: x.ok ? [x.narrative, x.unknownsSentence].filter(Boolean).join(" ") : x.error }))
    })
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <p className="text-sm font-medium">Search homes the way you'd say it</p>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run() }}
          placeholder={`e.g. "3 bed under 600k with lots of light, less yard"`}
          aria-label="Describe the home you want"
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        {voiceOk && (
          <button
            type="button"
            onClick={listen}
            aria-label={listening ? "Stop listening" : "Tap to talk"}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            {listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />} {listening ? "Listening…" : "Talk"}
          </button>
        )}
        <button
          onClick={() => run()}
          disabled={pending || query.trim().length < 5}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Your search criteria">
          {chips.map((c, i) => (
            <button
              type="button"
              key={`${c.field}-${i}`}
              disabled={pending || c.field === "lifestyle"}
              onClick={() => chipAction(c)}
              title={c.field === "lifestyle" ? "Tell me to change these" : NUMERIC.has(c.field) ? "Edit" : c.field === "listingType" ? "Switch buying / renting" : "Clear"}
              className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
            >
              {c.label} <span className="text-[11px] text-muted-foreground">· {PROVENANCE_LABEL[c.provenance]}</span>
            </button>
          ))}
        </div>
      )}
      {editing && (
        <div className="flex gap-1.5">
          <input
            value={editValue}
            onChange={(e) => setEditValue(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="numeric"
            aria-label={`New value for ${editing}`}
            placeholder={editing.endsWith("Price") ? "e.g. 600000" : "e.g. 3"}
            className="h-8 w-40 rounded-md border bg-background px-2 text-xs"
          />
          <button type="button" disabled={pending || editValue === ""} onClick={() => edit(editing, Number(editValue))} className="rounded border px-2 text-xs">Save</button>
          <button type="button" onClick={() => edit(editing, null)} className="rounded border px-2 text-xs">Clear</button>
          <button type="button" onClick={() => setEditing(null)} className="rounded border px-2 text-xs">Cancel</button>
        </div>
      )}

      {questions.length > 0 && (
        <ul className="space-y-1">
          {questions.map((q) => (
            <li key={q.about} className="flex items-center gap-1.5 text-xs text-muted-foreground"><MessageCircle className="h-3.5 w-3.5" /> {q.question}</li>
          ))}
        </ul>
      )}

      {(proposals.length > 0 || changes.length > 0) && (
        <ul className="space-y-1 rounded-md border p-2">
          {proposals.map((p) => (
            <li key={`p-${p.id}`} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>{p.reason}</span>
              <span className="flex gap-1">
                <button type="button" onClick={() => decide(p, "accept")} className="inline-flex items-center gap-1 rounded border px-2 py-0.5"><Check className="h-3 w-3" /> Yes</button>
                <button type="button" onClick={() => decide(p, "reject")} className="inline-flex items-center gap-1 rounded border px-2 py-0.5"><X className="h-3 w-3" /> No thanks</button>
              </span>
            </li>
          ))}
          {changes.map((c) => (
            <li key={`c-${c.id}`} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>Updated {c.field.replace(/([A-Z])/g, " $1").toLowerCase()} — {c.reason}</span>
              <button type="button" onClick={() => decide(c, "reject")} className="inline-flex items-center gap-1 rounded border px-2 py-0.5"><Undo2 className="h-3 w-3" /> Undo</button>
            </li>
          ))}
        </ul>
      )}

      {notes.length > 0 && <p className="text-xs text-muted-foreground">{notes.join(" ")}</p>}

      {nextBest.filter((n) => n.key !== "answer_question" && n.key !== "request_showing").length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="What you can do next">
          {nextBest.map((n) => {
            const cls = "inline-flex items-center rounded border px-2 py-0.5 text-xs"
            if (n.key === "save_alert") {
              return <button key={n.key} type="button" title={n.why} disabled={pending} className={cls} onClick={() => startTransition(async () => {
                const k = await buyerKeepWatchingAction({ contactId })
                setNotes([k.ok ? k.message : k.error])
              })}>{n.label}</button>
            }
            if (n.key === "ask_agent") return <a key={n.key} title={n.why} className={cls} href={`/portal/${contactId}/messages`}>{n.label}</a>
            if (n.key === "compare_homes") return <a key={n.key} title={n.why} className={cls} href={`/portal/${contactId}/properties`}>{n.label}</a>
            return null
          })}
        </div>
      )}

      {results !== null && (
        results.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing matches that right now — try widening the price or area, and your agent will keep watching for you.</p>
        ) : (
          <ul className="space-y-2">
            {results.map((m, i) => (
              <li key={i} className="rounded-md border p-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{m.address ?? m.city ?? "Listing"}</span>
                  <span className="text-sm font-semibold">{usd(m.price)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {[m.bedrooms != null ? `${m.bedrooms} bd` : null, m.bathrooms != null ? `${m.bathrooms} ba` : null, m.city].filter(Boolean).join(" · ")}
                  {m.source !== "platform" ? " · market listing" : " · our listing"}
                </p>
                {m.headline && <p className="text-xs">{m.headline}</p>}
                {m.fit && (
                  <ul className="space-y-0.5 text-xs">
                    {m.fit.matches.map((f, k) => <li key={`m${k}`} className="flex gap-1.5 text-emerald-800"><Check className="mt-0.5 h-3 w-3 shrink-0" /><span><span className="font-medium">{f.ask}:</span> {f.detail}</span></li>)}
                    {m.fit.misses.map((f, k) => <li key={`x${k}`} className="flex gap-1.5 text-destructive"><X className="mt-0.5 h-3 w-3 shrink-0" /><span><span className="font-medium">{f.ask}:</span> {f.detail}</span></li>)}
                    {m.fit.unknowns.map((f, k) => <li key={`u${k}`} className="flex gap-1.5 text-muted-foreground"><HelpCircle className="mt-0.5 h-3 w-3 shrink-0" /><span><span className="font-medium">{f.ask}:</span> unknown — {f.detail}</span></li>)}
                  </ul>
                )}
                {m.explanation && <p className="text-xs text-muted-foreground">{m.listingId && whyText[m.listingId] ? whyText[m.listingId] : m.explanation}</p>}
                {m.listingId && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <button type="button" disabled={pending} onClick={() => react(m, "saved")} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs"><Heart className="h-3 w-3" /> Save</button>
                    <button type="button" disabled={pending} onClick={() => { react(m, "dismissed"); setNoteFor(m.listingId); setNoteText("") }} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs"><ThumbsDown className="h-3 w-3" /> Not for me</button>
                    <button type="button" disabled={pending} onClick={() => react(m, "tour_requested")} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs"><CalendarPlus className="h-3 w-3" /> Tour</button>
                    {m.source === "platform" && <button type="button" disabled={pending} onClick={() => why(m)} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs"><HelpCircle className="h-3 w-3" /> Why this home?</button>}
                  </div>
                )}
                {noteFor && noteFor === m.listingId && (
                  <div className="flex gap-1.5 pt-1">
                    <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="What's off about it? (optional)" aria-label="What's off about this home" className="h-8 flex-1 rounded-md border bg-background px-2 text-xs" />
                    <button type="button" disabled={pending || noteText.trim().length < 2} onClick={() => { react(m, "feedback", noteText); setNoteFor(null) }} className="rounded border px-2 text-xs">Tell me</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
