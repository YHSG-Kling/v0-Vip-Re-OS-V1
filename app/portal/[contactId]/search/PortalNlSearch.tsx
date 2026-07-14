"use client"

/**
 * PORTAL NATURAL-LANGUAGE SEARCH (owner rule) — the buyer types what they'd
 * SAY: "3 bed under 600k with a yard near downtown". The intent parser +
 * inventory/RentCast engine the agents already use, now in the buyer's own
 * hands on their portal.
 */

import { useState, useTransition } from "react"
import { Search, Loader2 } from "lucide-react"
import { portalNaturalSearchAction, type PortalSearchResult } from "@/app/actions/portal-nl-search"

const usd = (n: number | null) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`)

export function PortalNlSearch({ contactId }: { contactId: string }) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<PortalSearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const run = () => {
    setError(null)
    startTransition(async () => {
      const r = await portalNaturalSearchAction({ contactId, query })
      if (r.ok) setResults(r.results)
      else { setResults(null); setError(r.error) }
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
          placeholder={`e.g. "3 bed under 600k with a yard near downtown"`}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button
          onClick={run}
          disabled={pending || query.trim().length < 5}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {results !== null && (
        results.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing matches that right now — try widening the price or area, and your agent will keep watching for you.</p>
        ) : (
          <ul className="space-y-2">
            {results.map((m, i) => (
              <li key={i} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{m.address ?? m.city ?? "Listing"}</span>
                  <span className="text-sm font-semibold">{usd(m.price)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {[m.bedrooms != null ? `${m.bedrooms} bd` : null, m.bathrooms != null ? `${m.bathrooms} ba` : null, m.city].filter(Boolean).join(" · ")}
                  {m.source !== "platform" ? " · market listing" : " · our listing"}
                </p>
                {m.headline && <p className="mt-1 text-xs">{m.headline}</p>}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
