"use client"

import { useState, useTransition } from "react"
import { createContentSource, saveTopicObservationAction, type SourceTypeUI } from "@/app/actions/content-intel/sources"

export function ContentSourceForm() {
  const [type, setType] = useState<SourceTypeUI>("reddit")
  const [label, setLabel] = useState("")
  const [configText, setConfigText] = useState(defaultConfigFor("reddit"))
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "ok"; id: string } | { kind: "err"; message: string }>({ kind: "idle" })
  const [pending, startTransition] = useTransition()

  function onTypeChange(newType: SourceTypeUI) {
    setType(newType)
    setConfigText(defaultConfigFor(newType))
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus({ kind: "idle" })
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(configText)
    } catch {
      setStatus({ kind: "err", message: "Config is not valid JSON" })
      return
    }
    startTransition(async () => {
      const r = await createContentSource({ type, label, config: parsed })
      if (r.ok) {
        setStatus({ kind: "ok", id: r.id })
        setLabel("")
        setConfigText(defaultConfigFor(type))
      } else {
        setStatus({ kind: "err", message: r.error })
      }
    })
  }

  return (
    <form onSubmit={onSubmit} className="border rounded-lg p-4 bg-gray-50 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Source type</label>
          <select
            value={type}
            onChange={(e) => onTypeChange(e.target.value as SourceTypeUI)}
            className="w-full border rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value="reddit">Reddit subreddit</option>
            <option value="exa_query">Exa neural search</option>
            <option value="rss">RSS feed</option>
            <option value="apify_actor">Apify actor (competitor / Instagram / TikTok)</option>
            <option value="manual">Manual seed</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-gray-700 mb-1">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. r/MiamiRealEstate weekly, Local competitor agent, etc."
            className="w-full border rounded px-2 py-1.5 text-sm"
            required
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Config (JSON)</label>
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          rows={6}
          className="w-full border rounded px-2 py-1.5 text-xs font-mono"
          spellCheck={false}
        />
        <p className="text-xs text-gray-500 mt-1">{helperFor(type)}</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="px-4 py-1.5 bg-black text-white text-sm rounded disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add source"}
        </button>
        {status.kind === "ok" && <span className="text-sm text-green-700">Added ✓</span>}
        {status.kind === "err" && <span className="text-sm text-red-700">{status.message}</span>}
      </div>
    </form>
  )
}

function defaultConfigFor(type: SourceTypeUI): string {
  switch (type) {
    case "reddit":
      return JSON.stringify({ subreddit: "MiamiRealEstate", window: "week" }, null, 2)
    case "exa_query":
      return JSON.stringify({ query: "Miami home buyer trends this month", withinDays: 14, type: "neural" }, null, 2)
    case "rss":
      return JSON.stringify({ feed_url: "https://example.com/local-news.xml", source_trust: 70 }, null, 2)
    case "apify_actor":
      return JSON.stringify({
        actor: "apify/instagram-hashtag-scraper",
        input: { hashtags: ["miamirealestate"], resultsLimit: 30 },
        title_field: "caption",
        url_field: "url",
        engagement_fields: ["likesCount", "commentsCount"],
        geo_relevance: { cities: ["Miami"] },
      }, null, 2)
    case "manual":
      return "{}"
  }
}

function helperFor(type: SourceTypeUI): string {
  switch (type) {
    case "reddit":      return "Required: subreddit (no r/ prefix). Optional: window — 'day' | 'week' | 'month'."
    case "exa_query":   return "Required: query (natural language). Optional: withinDays, type ('neural'|'keyword'|'auto'), category ('news' etc.)."
    case "rss":         return "Required: feed_url (http or https). Optional: source_trust 40-90 (higher = trusted news source)."
    case "apify_actor": return "Required: actor (apify/name), input (actor-specific payload), title_field + url_field. Optional: engagement_fields, geo_relevance."
    case "manual":      return "No config required for a hand-seed bucket. For public-post TOPIC research add community_post_urls (public Nextdoor post URLs) and max_run_usd (the per-run budget — no request is made without one); only a reworded topic is stored, never the post or its author."
  }
}

/**
 * WAVE 154 (lane 154G1): save your OWN observation or a permitted link as a topic — through THE ONE intake
 * (app/actions/content-intel/sources.ts saveTopicObservationAction). Your words pass the same exclusion and personal-data
 * screens as every other source; nothing is fetched from the link.
 */
export function SaveTopicObservationForm() {
  const [note, setNote] = useState("")
  const [link, setLink] = useState("")
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "ok"; text: string } | { kind: "err"; message: string }>({ kind: "idle" })
  const [pending, startTransition] = useTransition()
  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus({ kind: "idle" })
    startTransition(async () => {
      const r = await saveTopicObservationAction({ note, link: link.trim() || null })
      if (r.ok && r.inserted + r.merged > 0) { setStatus({ kind: "ok", text: r.merged ? "Added to an existing topic ✓" : "Saved ✓" }); setNote(""); setLink("") }
      else if (r.ok) setStatus({ kind: "err", message: r.excluded.length ? `Not saved. ${r.excluded.map((x) => x.message).join(" ")}` : "Not saved." })
      else setStatus({ kind: "err", message: r.error ?? "Not saved." })
    })
  }
  return (
    <form onSubmit={onSubmit} className="border rounded-lg p-4 bg-gray-50 space-y-3">
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Your topic idea or observation</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={240} required placeholder="e.g. Buyers keep asking how insurance quotes change their closing timeline" className="w-full border rounded px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Link (optional — a page you may cite)</label>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" className="w-full border rounded px-2 py-1.5 text-sm" />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="px-4 py-1.5 bg-black text-white text-sm rounded disabled:opacity-50">{pending ? "Saving…" : "Save topic"}</button>
        {status.kind === "ok" && <span className="text-sm text-green-700">{status.text}</span>}
        {status.kind === "err" && <span className="text-sm text-red-700">{status.message}</span>}
      </div>
    </form>
  )
}
