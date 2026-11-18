"use client"
/**
 * Local events (directive G8) and circle methods (G9) — wave 154, lane 154G3. Every write goes through
 * app/actions/events-and-circles.ts (session-gated); this panel only shows what those doors return.
 */
import { useEffect, useState, useTransition } from "react"
import {
  listEventsAndCirclesAction, registerEventSourceAction, saveTenantEventAction, refreshEventSourcesAction,
  shareCircleTacticAction, revokeCircleTacticAction, evaluateCircleTacticAction, adaptCircleTacticAction,
} from "@/app/actions/events-and-circles"

type Loaded = Extract<Awaited<ReturnType<typeof listEventsAndCirclesAction>>, { success: true }>
const COMPONENTS = ["consumer_question_first_hook", "short_video_faq", "timely_hyperlocal_fact", "personal_close", "market_stat_explainer", "neighborhood_walkthrough", "checklist_format"]
const SOURCE_CLASSES = ["city_county_calendar", "parks_calendar", "library_calendar", "chamber_of_commerce", "tourism_or_venue_organizer", "licensed_event_feed"]
const label = (s: unknown) => String(s ?? "").replace(/_/g, " ")
/** The producer's own basis for a share, as recorded when they opted in — their own campaign counts, never shown to a member. */
const circleBasisText = (b: unknown): string => {
  if (!b || typeof b !== "object") return ""
  const e = b as { windowDays?: number | null; tacticCampaigns?: number | null; cohortCampaigns?: number | null }
  if (typeof e.tacticCampaigns !== "number" || typeof e.cohortCampaigns !== "number") return ""
  return ` (your ${e.tacticCampaigns} campaign${e.tacticCampaigns === 1 ? "" : "s"} with this method against ${e.cohortCampaigns} comparable${typeof e.windowDays === "number" ? `, last ${e.windowDays} days` : ""})`
}
const input = "border rounded px-2 py-1 text-sm"
const btn = "text-xs px-2 py-1 border rounded hover:bg-gray-100 disabled:opacity-50"

export function EventsAndCirclesPanel() {
  const [data, setData] = useState<Loaded | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const reload = () => start(async () => { const r = await listEventsAndCirclesAction(); if (r.success) setData(r); else setMsg(r.error) })
  useEffect(reload, [])
  const run = (fn: () => Promise<{ success: boolean; error?: string } & Record<string, unknown>>, ok: string) => start(async () => { const r = await fn(); setMsg(r.success ? ok : (r.error ?? "Not done")); if (r.success) reload() })

  const [src, setSrc] = useState({ label: "", sourceClass: SOURCE_CLASSES[0], url: "", termsNote: "", licenseRef: "", city: "", state: "" })
  const [ev, setEv] = useState({ title: "", url: "", date: "", time: "", timeZone: "", locationKind: "physical" as "physical" | "virtual", venue: "", city: "", state: "", zip: "", virtualUrl: "", relation: "hosted" as "hosted" | "sponsored" })
  const [share, setShare] = useState({ circle: "brokerage:", method: "", explanation: "", components: [] as string[], sourceKind: "producer_outcome" as "producer_outcome" | "competitor_public_idea", campaigns: "", claimedTitle: "" })

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">Local events and shared methods</h2>
      {msg && <p className="text-sm text-gray-700">{msg}</p>}
      {data?.notes.map((n, i) => <p key={i} className="text-sm text-amber-700">{n}</p>)}

      <div className="space-y-2">
        <h3 className="font-medium">Event sources (each with its recorded access right)</h3>
        <ul className="text-sm">{data?.sources.map((s) => <li key={String(s.id)}>{String(s.label)} · {label(s.sourceClass)} · {s.authorized ? "authorized" : `not read: ${label(s.reason)}`}</li>)}</ul>
        <div className="flex flex-wrap gap-2">
          <input className={input} placeholder="Publisher" value={src.label} onChange={(e) => setSrc({ ...src, label: e.target.value })} />
          <select className={input} value={src.sourceClass} onChange={(e) => setSrc({ ...src, sourceClass: e.target.value })}>{SOURCE_CLASSES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
          <input className={input} placeholder="Calendar feed URL (.ics)" value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} />
          <input className={input} placeholder="Terms the access rests on" value={src.termsNote} onChange={(e) => setSrc({ ...src, termsNote: e.target.value })} />
          {src.sourceClass === "licensed_event_feed" && <input className={input} placeholder="LICENSE reference" value={src.licenseRef} onChange={(e) => setSrc({ ...src, licenseRef: e.target.value })} />}
          <input className={input} placeholder="City covered" value={src.city} onChange={(e) => setSrc({ ...src, city: e.target.value })} />
          <input className={input} placeholder="State" value={src.state} onChange={(e) => setSrc({ ...src, state: e.target.value })} />
          <button className={btn} disabled={pending} onClick={() => run(() => registerEventSourceAction({ label: src.label, sourceClass: src.sourceClass, access: src.sourceClass === "licensed_event_feed" ? "licensed_api" : "publisher_syndication_feed", url: src.url || null, termsNote: src.termsNote, licenseRef: src.licenseRef || null, city: src.city || null, state: src.state || null }), "Source recorded")}>Record source</button>
          <button className={btn} disabled={pending} onClick={() => run(refreshEventSourcesAction, "Sources read")}>Read sources now</button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">Your own event (hosted or sponsored — no RSVPs are collected here)</h3>
        <div className="flex flex-wrap gap-2">
          <input className={input} placeholder="Event name" value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} />
          <input className={input} placeholder="Official event page" value={ev.url} onChange={(e) => setEv({ ...ev, url: e.target.value })} />
          <input className={input} type="date" value={ev.date} onChange={(e) => setEv({ ...ev, date: e.target.value })} />
          <input className={input} type="time" value={ev.time} onChange={(e) => setEv({ ...ev, time: e.target.value })} />
          <input className={input} placeholder="Time zone (e.g. America/Chicago)" value={ev.timeZone} onChange={(e) => setEv({ ...ev, timeZone: e.target.value })} />
          <select className={input} value={ev.locationKind} onChange={(e) => setEv({ ...ev, locationKind: e.target.value as "physical" | "virtual" })}><option value="physical">In person</option><option value="virtual">Virtual</option></select>
          {ev.locationKind === "physical" ? <>
            <input className={input} placeholder="Venue" value={ev.venue} onChange={(e) => setEv({ ...ev, venue: e.target.value })} />
            <input className={input} placeholder="City" value={ev.city} onChange={(e) => setEv({ ...ev, city: e.target.value })} />
            <input className={input} placeholder="State" value={ev.state} onChange={(e) => setEv({ ...ev, state: e.target.value })} />
            <input className={input} placeholder="ZIP" value={ev.zip} onChange={(e) => setEv({ ...ev, zip: e.target.value })} />
          </> : <input className={input} placeholder="Join link" value={ev.virtualUrl} onChange={(e) => setEv({ ...ev, virtualUrl: e.target.value })} />}
          <select className={input} value={ev.relation} onChange={(e) => setEv({ ...ev, relation: e.target.value as "hosted" | "sponsored" })}><option value="hosted">We host it</option><option value="sponsored">We sponsor it</option></select>
          <button className={btn} disabled={pending} onClick={() => run(() => saveTenantEventAction({ ...ev, time: ev.time || null, timeZone: ev.timeZone || null }), "Event saved")}>Save event</button>
        </div>
        <ul className="divide-y text-sm">
          {data?.events.map((e) => (
            <li key={String(e.topicId)} className="flex flex-wrap gap-x-4 gap-y-1 py-1"><span className="font-medium">{String(e.title)}</span><span>{label(e.format)}</span><span>{String(e.startDate ?? "")}</span><span>{label(e.listingKind)}</span><span>{e.stale ? "stale — not offered" : String(e.status)}</span></li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">Share a method with a circle you belong to (your opt-in; you can stop at any time)</h3>
        <div className="flex flex-wrap gap-2">
          <select className={input} value={share.circle} onChange={(e) => setShare({ ...share, circle: e.target.value })}>{data?.circles.map((c) => <option key={`${c.kind}:${c.id ?? ""}`} value={`${c.kind}:${c.id ?? ""}`}>{c.label}</option>)}</select>
          <input className={input} placeholder="The method, in general words" value={share.method} onChange={(e) => setShare({ ...share, method: e.target.value })} />
          <input className={input} placeholder="Why it works" value={share.explanation} onChange={(e) => setShare({ ...share, explanation: e.target.value })} />
          <select className={input} value={share.sourceKind} onChange={(e) => setShare({ ...share, sourceKind: e.target.value as "producer_outcome" | "competitor_public_idea" })}><option value="producer_outcome">From my own campaign results</option><option value="competitor_public_idea">A public idea I saw elsewhere</option></select>
          {share.sourceKind === "producer_outcome" && <input className={input} placeholder="Campaign ids that used it (comma separated)" value={share.campaigns} onChange={(e) => setShare({ ...share, campaigns: e.target.value })} />}
          {COMPONENTS.map((c) => <label key={c} className="text-xs"><input type="checkbox" checked={share.components.includes(c)} onChange={(e) => setShare({ ...share, components: e.target.checked ? [...share.components, c] : share.components.filter((x) => x !== c) })} /> {label(c)}</label>)}
          <button className={btn} disabled={pending} onClick={() => { const [kind, id] = share.circle.split(":"); run(() => shareCircleTacticAction({ circleKind: kind as "team" | "mentorship" | "brokerage", circleId: id || null, method: share.method, explanation: share.explanation, components: share.components, sourceKind: share.sourceKind, tacticCampaignIds: share.campaigns.split(",").map((x) => x.trim()).filter(Boolean), claimedTitle: share.claimedTitle || null }), "Shared — each member's fit is decided individually") }}>Share</button>
        </div>
        <ul className="text-sm">{data?.mine.map((m) => <li key={String(m.shareId)}>{String(m.method)} · {label(m.circleKind)} · {label(m.evidenceQuality)}{circleBasisText(m.evidenceBasis)} · {String(m.status)}{m.revokedAt ? ` on ${String(m.revokedAt).slice(0, 10)}` : ""} {m.status === "shared" && <button className={btn} disabled={pending} onClick={() => run(() => revokeCircleTacticAction(String(m.shareId)), "Sharing stopped")}>Stop sharing</button>}</li>)}</ul>
        <h3 className="font-medium">Methods shared with you</h3>
        <ul className="text-sm space-y-1">{data?.tactics.map((t) => (
          <li key={String(t.shareId)}>
            <strong>{String(t.method)}</strong> — {(t.components as string[]).map(label).join(" + ")} · evidence: {label(t.evidenceQuality)} ({label(t.sourceLabel)})
            {t.decision ? <> · {label(t.decision)}</> : <button className={btn} disabled={pending} onClick={() => run(() => evaluateCircleTacticAction(String(t.shareId)), "Evaluated for you")}>Does this fit my market?</button>}
            {(t.decision === "offer" || t.decision === "recommend_adaptation") && !t.adaptedTopicId && <button className={btn} disabled={pending} onClick={() => run(() => adaptCircleTacticAction(String(t.shareId)), "Added to your topics — your writers produce it in your voice")}>Adapt in my voice</button>}
          </li>
        ))}</ul>
      </div>
    </section>
  )
}
