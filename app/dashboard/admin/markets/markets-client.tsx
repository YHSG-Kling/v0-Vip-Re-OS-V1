"use client"

/**
 * Markets setup client (round 42) — the create/toggle UI over the EXISTING
 * lead-scraping-config actions. No new write paths: createScrapingMarket /
 * updateScrapingMarket already sync subscriber_service_areas per zip.
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import { createScrapingMarket, updateScrapingMarket } from "@/app/actions/lead-scraping-config"

export interface MarketRow {
  id: string
  name: string
  city: string
  state: string
  zip_codes: string[]
  is_active: boolean
}

export function MarketsSetupClient({
  initialMarkets,
  suggestedZip,
}: {
  initialMarkets: MarketRow[]
  suggestedZip: string | null
}) {
  const [markets, setMarkets] = useState<MarketRow[]>(initialMarkets)
  const [name, setName] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [zips, setZips] = useState(suggestedZip ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () => {
    setError(null)
    const zipList = zips.split(/[,\s]+/).map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z))
    if (!name.trim() || !city.trim() || !state.trim()) {
      setError("Name, city, and state are required.")
      return
    }
    startTransition(async () => {
      const res = await createScrapingMarket({
        name: name.trim(), city: city.trim(), state: state.trim().toUpperCase(),
        zip_codes: zipList,
      })
      if (!res.success || !res.market) {
        setError(res.error ?? "Market creation failed.")
        return
      }
      const m = res.market as any
      setMarkets((prev) => [
        { id: m.id, name: m.name, city: m.city, state: m.state,
          zip_codes: Array.isArray(m.zip_codes) ? m.zip_codes : [], is_active: m.is_active !== false },
        ...prev,
      ])
      setName(""); setCity(""); setState(""); setZips("")
    })
  }

  const toggle = (id: string, active: boolean) => {
    startTransition(async () => {
      const res = await updateScrapingMarket(id, { is_active: active })
      if (res.success) {
        setMarkets((prev) => prev.map((m) => (m.id === id ? { ...m, is_active: active } : m)))
      }
    })
  }

  return (
    <div className="space-y-4">
      {suggestedZip && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs text-muted-foreground">
          Prefilled with <span className="font-medium">{suggestedZip}</span> — the zip you searched on the
          pricing page. Nothing was auto-claimed; create the market to claim it.
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Add a market</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          <input className="rounded-md border bg-background px-2 py-1.5 text-sm" placeholder="Market name (e.g. Austin Metro)"
            value={name} onChange={(e) => setName(e.target.value)} />
          <input className="rounded-md border bg-background px-2 py-1.5 text-sm" placeholder="City"
            value={city} onChange={(e) => setCity(e.target.value)} />
          <input className="rounded-md border bg-background px-2 py-1.5 text-sm" placeholder="State (e.g. TX)" maxLength={2}
            value={state} onChange={(e) => setState(e.target.value)} />
        </div>
        <input className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          placeholder="Zip codes, comma-separated (become your claimed service areas)"
          value={zips} onChange={(e) => setZips(e.target.value)} />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Create market"}
        </button>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-semibold">Your markets ({markets.length})</h2>
          <Link href="/dashboard/admin/scrape-diagnostics" className="text-xs underline text-muted-foreground">
            Scrape diagnostics
          </Link>
        </div>
        {markets.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No markets yet — the scrape pipeline is idle until you define one.
          </p>
        ) : (
          <ul className="divide-y">
            {markets.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{m.name} <span className="text-muted-foreground">— {m.city}, {m.state}</span></p>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.zip_codes.length > 0 ? `Zips: ${m.zip_codes.join(", ")}` : "No zips (radius/county scoped)"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(m.id, !m.is_active)}
                  disabled={pending}
                  className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${m.is_active ? "border-emerald-300 text-emerald-700" : "text-muted-foreground"}`}
                >
                  {m.is_active ? "Active" : "Inactive"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
