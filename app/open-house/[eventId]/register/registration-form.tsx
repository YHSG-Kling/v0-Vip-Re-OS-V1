"use client"

import { useState } from "react"
import { ConsentBoxes, useConsentBoxes } from "@/app/components/forms/ConsentBoxes"

/**
 * The registration form for every C22 kind routed to registration. Identity (name, email, mobile) + the KIND'S OWN situation
 * questions (lib/open-house/event-registry.ts REGISTRATION_QUESTIONS — closed choices, rendered from the server's list) + the
 * consent boxes.
 *
 * WAVE 149 (lane 149F — owner ruling 16): TOMBSTONE — the free-text "Anything you'd like answered? (optional)" textarea and the
 * hard-coded intent / timeline selects stood here. Every question is now one the kind declares about the situation it serves
 * (what to see on a tour, what a session should cover, what they'd like the host to do, a client gathering's guests and access
 * needs); the server keeps only answers those questions admit (sanitizeEventSituation).
 *
 * CONSENT — THE ONE COMPONENT (C15): service delivery is REQUIRED for the service asked (the confirmation, the join link and —
 * with a mobile number — the text reminders: the `event_registration` door's purposes), marketing is OPTIONAL per channel and
 * unchecked by default. The browser posts only the submission; the server re-renders the words from the same brand.
 */

interface Question { key: string; prompt: string; kind: "single" | "multiple" | "yes_no" | "count"; options: Array<{ value: string; label: string }> }

interface Props {
  event: {
    id: string; kindLabel: string; title: string; headline: string; intro: string | null; bullets: string[]
    dateLabel: string | null; timeLabel: string | null; where: string; hostName: string | null; online: boolean; promisesReplay: boolean
  }
  /** C32: the creating tenant's brand (never the platform's on a tenant event). */
  brand: { name: string | null; logoUrl: string | null; primaryColor: string | null; website: string | null; fairHousingLine: string | null }
  /** THE one brand rule's answer (resolveConsentBrand) — the name the consent words carry, server and page alike. */
  consentBrandName: string
  questions: Question[]
}

export function RegistrationForm({ event, brand, consentBrandName, questions }: Props) {
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "" })
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const consent = useConsentBoxes("event_registration", consentBrandName, ["email", "sms"])
  const [state, setState] = useState<{ status: "idle" | "sending" | "done" | "error"; message?: string; joinPath?: string | null; already?: boolean }>({ status: "idle" })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const pick = (q: Question, value: string) => setAnswers((p) => {
    if (q.kind !== "multiple") return { ...p, [q.key]: p[q.key] === value ? "" : value }
    const cur = Array.isArray(p[q.key]) ? (p[q.key] as string[]) : []
    return { ...p, [q.key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
  })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!consent.serviceGiven) { setState({ status: "error", message: "Please tick the first box — it is how your confirmation and join link reach you." }); return }
    setState({ status: "sending" })
    const situation: Record<string, unknown> = {}
    for (const q of questions) {
      const v = answers[q.key]
      if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue
      situation[q.key] = q.kind === "count" ? Number(v) : v
    }
    try {
      const res = await fetch("/api/open-house/register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: event.id, firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone || null,
          situation, consent: consent.submission, sourceUrl: typeof window !== "undefined" ? window.location.pathname : null,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setState({ status: "error", message: body?.error ?? "Something went wrong — please try again." }); return }
      setState({ status: "done", joinPath: body?.joinPath ?? null, already: body?.alreadyRegistered === true })
    } catch {
      setState({ status: "error", message: "Network error — please try again." })
    }
  }

  const accent = brand.primaryColor && /^#[0-9a-fA-F]{3,8}$/.test(brand.primaryColor) ? brand.primaryColor : undefined
  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <header className="px-6 py-8 text-center bg-primary text-primary-foreground" style={accent ? { backgroundColor: accent } : undefined}>
        {brand.logoUrl ? <img src={brand.logoUrl} alt={brand.name ?? ""} className="mx-auto h-10 object-contain" /> : brand.name ? <p className="text-sm font-semibold">{brand.name}</p> : null}
        <p className="mt-3 text-xs uppercase tracking-wide opacity-90">{event.kindLabel}</p>
        <h1 className="mt-1 text-2xl font-bold leading-tight">{event.headline}</h1>
        <p className="mt-2 text-sm opacity-90">{[event.dateLabel, event.timeLabel].filter(Boolean).join(" · ")}</p>
        <p className="text-sm opacity-90">{event.where}</p>
        {event.hostName ? <p className="mt-1 text-sm opacity-90">Hosted by {event.hostName}{brand.name ? `, ${brand.name}` : ""}</p> : null}
      </header>

      <main className="mx-auto w-full max-w-xl px-4 py-8 space-y-6">
        {event.intro ? <p className="text-base leading-relaxed">{event.intro}</p> : null}
        {event.bullets.length ? (
          <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">{event.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
        ) : null}

        {state.status === "done" ? (
          <section className="rounded-lg border border-border bg-card p-5 space-y-2" aria-live="polite">
            <h2 className="text-lg font-semibold">{state.already ? "You're already registered" : "You're registered"}</h2>
            <p className="text-sm text-muted-foreground">A confirmation is on its way to {f.email || "your inbox"}.</p>
            {state.joinPath ? <p className="text-sm">Your personal link: <a className="underline font-medium" href={state.joinPath}>join here</a> at the start time. Please keep it to yourself — it is yours.</p> : null}
            {event.promisesReplay ? <p className="text-sm text-muted-foreground">Can't make it after all? We'll send the recording to everyone who registers.</p> : null}
          </section>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm space-y-1"><span>First name *</span><input required className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.firstName} onChange={set("firstName")} autoComplete="given-name" /></label>
              <label className="text-sm space-y-1"><span>Last name *</span><input required className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.lastName} onChange={set("lastName")} autoComplete="family-name" /></label>
            </div>
            <label className="text-sm space-y-1 block"><span>Email *</span><input required type="email" className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.email} onChange={set("email")} autoComplete="email" /></label>
            <label className="text-sm space-y-1 block"><span>Mobile (optional)</span><input type="tel" className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.phone} onChange={set("phone")} autoComplete="tel" /></label>

            {questions.map((q) => (
              <fieldset key={q.key} className="space-y-2">
                <legend className="text-sm">{q.prompt} <span className="text-muted-foreground">(optional{q.kind === "multiple" ? " — choose any" : ""})</span></legend>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((o) => {
                    const v = answers[q.key]
                    const on = Array.isArray(v) ? v.includes(o.value) : v === o.value
                    return (
                      <button key={o.value} type="button" aria-pressed={on} onClick={() => pick(q, o.value)}
                        className={`rounded-full border px-3 py-1.5 text-sm ${on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background"}`}
                        style={on && accent ? { backgroundColor: accent, borderColor: accent } : undefined}>
                        {o.label}
                      </button>
                    )
                  })}
                </div>
              </fieldset>
            ))}

            <ConsentBoxes {...consent.boxProps} idPrefix={`event-consent-${event.id}`} />

            {state.status === "error" ? <p className="text-sm text-destructive" role="alert">{state.message}</p> : null}
            <button type="submit" disabled={state.status === "sending"} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60" style={accent ? { backgroundColor: accent } : undefined}>
              {state.status === "sending" ? "Registering…" : `Register for ${event.title}`}
            </button>
          </form>
        )}
      </main>
      <footer className="px-4 pb-8 text-center text-xs text-muted-foreground">
        {brand.name}{brand.website ? ` · ${brand.website}` : ""}
        {brand.fairHousingLine ? <p className="mt-1">{brand.fairHousingLine}</p> : null}
      </footer>
    </div>
  )
}
