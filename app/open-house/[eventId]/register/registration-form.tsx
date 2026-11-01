"use client"

import { useState } from "react"
import { ConsentBoxes, useConsentBoxes } from "@/app/components/forms/ConsentBoxes"

/**
 * The registration form for every C22 kind routed to registration. Identity (name, email, mobile) + situation (what brings them,
 * their timeline BUCKET, whether they already have an agent, their question in their own words) + the consent boxes.
 *
 * CONSENT — THE ONE COMPONENT (C15; wave 148Z replaced the three-box <fieldset data-consent-block> 1:1, lane148H Outside-lane 1):
 * service delivery is REQUIRED for the service asked (the confirmation, the join link and — with a mobile number — the text
 * reminders: the `event_registration` door's purposes), marketing is OPTIONAL per channel and unchecked by default. The browser
 * posts only the submission; the server re-renders the words from the same brand (consentGrantsFromComponent).
 */

interface Props {
  event: {
    id: string; kindLabel: string; title: string; headline: string; intro: string | null; bullets: string[]
    dateLabel: string | null; timeLabel: string | null; where: string; hostName: string | null; online: boolean; promisesReplay: boolean
  }
  brand: { name: string | null; logoUrl: string | null; primaryColor: string | null }
  /** THE one brand rule's answer (resolveConsentBrand) — the name the consent words carry, server and page alike. */
  consentBrandName: string
  intents: string[]
  timelines: string[]
}

const INTENT_LABEL: Record<string, string> = { buying: "Buying a home", selling: "Selling a home", buying_and_selling: "Buying and selling", investing: "Investing", learning: "Just learning for now" }
const TIMELINE_LABEL: Record<string, string> = { immediate: "Ready now", "1-3_months": "In 1–3 months", "3-6_months": "In 3–6 months", "6-12_months": "In 6–12 months", "12+_months": "A year or more out", researching: "No date yet — researching" }

export function RegistrationForm({ event, brand, consentBrandName, intents, timelines }: Props) {
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", intent: "", timeline: "", workingWithAgent: "", question: "" })
  const consent = useConsentBoxes("event_registration", consentBrandName, ["email", "sms"])
  const [state, setState] = useState<{ status: "idle" | "sending" | "done" | "error"; message?: string; joinPath?: string | null; already?: boolean }>({ status: "idle" })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!consent.serviceGiven) { setState({ status: "error", message: "Please tick the first box — it is how your confirmation and join link reach you." }); return }
    setState({ status: "sending" })
    try {
      const res = await fetch("/api/open-house/register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: event.id, firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone || null,
          situation: { intent: f.intent || null, timeline: f.timeline || null, workingWithAgent: f.workingWithAgent === "" ? null : f.workingWithAgent === "yes", question: f.question || null },
          consent: consent.submission, sourceUrl: typeof window !== "undefined" ? window.location.pathname : null,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setState({ status: "error", message: body?.error ?? "Something went wrong — please try again." }); return }
      setState({ status: "done", joinPath: body?.joinPath ?? null, already: body?.alreadyRegistered === true })
    } catch {
      setState({ status: "error", message: "Network error — please try again." })
    }
  }

  const accent = brand.primaryColor ?? undefined
  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <header className="px-6 py-8 text-center bg-primary text-primary-foreground" style={accent ? { backgroundColor: accent } : undefined}>
        {brand.logoUrl ? <img src={brand.logoUrl} alt={brand.name ?? "Brokerage"} className="mx-auto h-10 object-contain" /> : brand.name ? <p className="text-sm font-semibold">{brand.name}</p> : null}
        <p className="mt-3 text-xs uppercase tracking-wide opacity-90">{event.kindLabel}</p>
        <h1 className="mt-1 text-2xl font-bold leading-tight">{event.headline}</h1>
        <p className="mt-2 text-sm opacity-90">{[event.dateLabel, event.timeLabel].filter(Boolean).join(" · ")}</p>
        <p className="text-sm opacity-90">{event.where}</p>
        {event.hostName ? <p className="mt-1 text-sm opacity-90">Hosted by {event.hostName}</p> : null}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm space-y-1"><span>What brings you?</span>
                <select className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.intent} onChange={set("intent")}>
                  <option value="">Choose one (optional)</option>
                  {intents.map((i) => <option key={i} value={i}>{INTENT_LABEL[i] ?? i}</option>)}
                </select>
              </label>
              <label className="text-sm space-y-1"><span>Your timeline</span>
                <select className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.timeline} onChange={set("timeline")}>
                  <option value="">Choose one (optional)</option>
                  {timelines.map((t) => <option key={t} value={t}>{TIMELINE_LABEL[t] ?? t}</option>)}
                </select>
              </label>
            </div>
            <label className="text-sm space-y-1 block"><span>Already working with an agent?</span>
              <select className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.workingWithAgent} onChange={set("workingWithAgent")}>
                <option value="">Prefer not to say</option><option value="yes">Yes</option><option value="no">No</option>
              </select>
            </label>
            <label className="text-sm space-y-1 block"><span>Anything you'd like answered? (optional)</span>
              <textarea rows={3} maxLength={500} className="w-full rounded-md border border-input bg-background px-3 py-2" value={f.question} onChange={set("question")} />
            </label>

            <ConsentBoxes {...consent.boxProps} idPrefix={`event-consent-${event.id}`} />

            {state.status === "error" ? <p className="text-sm text-destructive" role="alert">{state.message}</p> : null}
            <button type="submit" disabled={state.status === "sending"} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60" style={accent ? { backgroundColor: accent } : undefined}>
              {state.status === "sending" ? "Registering…" : `Register for ${event.title}`}
            </button>
          </form>
        )}
      </main>
    </div>
  )
}
