"use client"

/**
 * Markets setup client (round 42) — the create/toggle UI over the EXISTING
 * lead-scraping-config actions. No new write paths: createScrapingMarket /
 * updateScrapingMarket already sync subscriber_service_areas per zip.
 *
 * ORPHAN BURN-DOWN: the rest of app/actions/lead-scraping-config.ts had no
 * caller at all — the keyword dictionary the social scraper matches on, the
 * per-market property/motivated-seller parameters the ZenRows and BatchData
 * lanes read, the market delete (which is what deactivates the territory's
 * subscriber_service_areas rows), and the job history that is the only place a
 * failed scrape reports itself. All of it was configurable in the database and
 * nowhere in the product. Wired here, on the one page that already owns the
 * scrape territory config. Every call reads its outcome.
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import {
  createScrapingMarket,
  updateScrapingMarket,
  deleteScrapingMarket,
  createScrapingKeyword,
  updateScrapingKeyword,
  deleteScrapingKeyword,
  createPropertyParams,
  updatePropertyParams,
  createMotivatedParams,
  updateMotivatedParams,
} from "@/app/actions/lead-scraping-config"

export interface PropertyParamsRow {
  id: string
  min_price: number | null
  max_price: number | null
  min_beds: number | null
  max_beds: number | null
  is_active: boolean
}

export interface MotivatedParamsRow {
  id: string
  min_equity_percent: number | null
  max_days_on_market: number | null
  include_expired_listings: boolean
  include_fsbo: boolean
  is_active: boolean
}

export interface MarketRow {
  id: string
  name: string
  city: string
  state: string
  zip_codes: string[]
  is_active: boolean
  propertyParams: PropertyParamsRow | null
  motivatedParams: MotivatedParamsRow | null
}

export interface KeywordRow {
  id: string
  keyword: string
  keyword_type: string
  weight: number | null
  is_active: boolean
}

export interface JobRow {
  id: string
  job_type: string
  source: string
  status: string
  leads_found: number | null
  leads_created: number | null
  error_message: string | null
  created_at: string | null
  completed_at: string | null
  market_label: string | null
}

const KEYWORD_TYPES = ["buying_intent", "selling_intent", "life_event", "distress", "custom"]

function num(v: string): number | undefined {
  const n = Number(v)
  return v.trim() === "" || Number.isNaN(n) ? undefined : n
}

export function MarketsSetupClient({
  initialMarkets,
  initialKeywords,
  initialJobs,
  suggestedZip,
}: {
  initialMarkets: MarketRow[]
  initialKeywords: KeywordRow[]
  initialJobs: JobRow[]
  suggestedZip: string | null
}) {
  const [markets, setMarkets] = useState<MarketRow[]>(initialMarkets)
  const [keywords, setKeywords] = useState<KeywordRow[]>(initialKeywords)
  const [name, setName] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [zips, setZips] = useState(suggestedZip ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Per-market parameter editor
  const [openParamsFor, setOpenParamsFor] = useState<string | null>(null)
  const [paramsError, setParamsError] = useState<string | null>(null)
  const [paramsNotice, setParamsNotice] = useState<string | null>(null)
  const [minPrice, setMinPrice] = useState("")
  const [maxPrice, setMaxPrice] = useState("")
  const [minBeds, setMinBeds] = useState("")
  const [maxBeds, setMaxBeds] = useState("")
  const [minEquity, setMinEquity] = useState("")
  const [maxDom, setMaxDom] = useState("")
  const [includeExpired, setIncludeExpired] = useState(true)
  const [includeFsbo, setIncludeFsbo] = useState(true)

  // Keyword composer
  const [kwText, setKwText] = useState("")
  const [kwType, setKwType] = useState(KEYWORD_TYPES[0])
  const [kwWeight, setKwWeight] = useState("2")
  const [kwError, setKwError] = useState<string | null>(null)

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
          zip_codes: Array.isArray(m.zip_codes) ? m.zip_codes : [], is_active: m.is_active !== false,
          propertyParams: null, motivatedParams: null },
        ...prev,
      ])
      setName(""); setCity(""); setState(""); setZips("")
    })
  }

  const toggle = (id: string, active: boolean) => {
    setError(null)
    startTransition(async () => {
      const res = await updateScrapingMarket(id, { is_active: active })
      if (res.success) {
        setMarkets((prev) => prev.map((m) => (m.id === id ? { ...m, is_active: active } : m)))
      } else {
        setError(res.error ?? "Could not change the market's active state.")
      }
    })
  }

  const removeMarket = (id: string) => {
    setError(null)
    startTransition(async () => {
      const res = await deleteScrapingMarket(id)
      if (res.success) {
        setMarkets((prev) => prev.filter((m) => m.id !== id))
        if (openParamsFor === id) setOpenParamsFor(null)
      } else {
        setError(res.error ?? "Could not delete the market.")
      }
    })
  }

  const openParams = (m: MarketRow) => {
    if (openParamsFor === m.id) { setOpenParamsFor(null); return }
    setParamsError(null); setParamsNotice(null)
    setMinPrice(m.propertyParams?.min_price?.toString() ?? "")
    setMaxPrice(m.propertyParams?.max_price?.toString() ?? "")
    setMinBeds(m.propertyParams?.min_beds?.toString() ?? "")
    setMaxBeds(m.propertyParams?.max_beds?.toString() ?? "")
    setMinEquity(m.motivatedParams?.min_equity_percent?.toString() ?? "")
    setMaxDom(m.motivatedParams?.max_days_on_market?.toString() ?? "")
    setIncludeExpired(m.motivatedParams?.include_expired_listings !== false)
    setIncludeFsbo(m.motivatedParams?.include_fsbo !== false)
    setOpenParamsFor(m.id)
  }

  const saveParams = (m: MarketRow) => {
    setParamsError(null); setParamsNotice(null)
    startTransition(async () => {
      const propertyPayload = {
        min_price: num(minPrice), max_price: num(maxPrice),
        min_beds: num(minBeds), max_beds: num(maxBeds),
      }
      const motivatedPayload = {
        min_equity_percent: num(minEquity),
        max_days_on_market: num(maxDom),
        include_expired_listings: includeExpired,
        include_fsbo: includeFsbo,
      }

      const propRes = m.propertyParams
        ? await updatePropertyParams(m.propertyParams.id, propertyPayload as any)
        : await createPropertyParams(m.id, propertyPayload)
      if (!propRes.success) {
        setParamsError(propRes.error ?? "Property search parameters were not saved.")
        return
      }

      const motRes = m.motivatedParams
        ? await updateMotivatedParams(m.motivatedParams.id, motivatedPayload as any)
        : await createMotivatedParams(m.id, motivatedPayload)
      if (!motRes.success) {
        setParamsError(
          `Property parameters saved, but the motivated-seller parameters were not: ${motRes.error ?? "unknown error"}`,
        )
        return
      }

      const savedProp = (propRes as any).params
      const savedMot = (motRes as any).params
      setMarkets((prev) => prev.map((row) => row.id === m.id ? {
        ...row,
        propertyParams: savedProp ? {
          id: savedProp.id, min_price: savedProp.min_price ?? null, max_price: savedProp.max_price ?? null,
          min_beds: savedProp.min_beds ?? null, max_beds: savedProp.max_beds ?? null,
          is_active: savedProp.is_active !== false,
        } : row.propertyParams,
        motivatedParams: savedMot ? {
          id: savedMot.id, min_equity_percent: savedMot.min_equity_percent ?? null,
          max_days_on_market: savedMot.max_days_on_market ?? null,
          include_expired_listings: savedMot.include_expired_listings !== false,
          include_fsbo: savedMot.include_fsbo !== false,
          is_active: savedMot.is_active !== false,
        } : row.motivatedParams,
      } : row))
      setParamsNotice("Scrape parameters saved.")
    })
  }

  const addKeyword = () => {
    setKwError(null)
    if (!kwText.trim()) { setKwError("Enter a keyword or phrase."); return }
    startTransition(async () => {
      const res = await createScrapingKeyword({
        keyword: kwText.trim(),
        category: kwType,
        weight: num(kwWeight) ?? 1,
      })
      if (!res.success || !res.keyword) {
        setKwError(res.error ?? "Keyword was not created.")
        return
      }
      const k = res.keyword as any
      setKeywords((prev) => [
        { id: k.id, keyword: k.keyword, keyword_type: k.keyword_type ?? kwType,
          weight: k.weight ?? null, is_active: k.is_active !== false },
        ...prev,
      ])
      setKwText("")
    })
  }

  const toggleKeyword = (id: string, active: boolean) => {
    setKwError(null)
    startTransition(async () => {
      const res = await updateScrapingKeyword(id, { is_active: active })
      if (res.success) {
        setKeywords((prev) => prev.map((k) => (k.id === id ? { ...k, is_active: active } : k)))
      } else {
        setKwError(res.error ?? "Could not change the keyword's active state.")
      }
    })
  }

  const removeKeyword = (id: string) => {
    setKwError(null)
    startTransition(async () => {
      const res = await deleteScrapingKeyword(id)
      if (res.success) {
        setKeywords((prev) => prev.filter((k) => k.id !== id))
      } else {
        setKwError(res.error ?? "Could not delete the keyword.")
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
              <li key={m.id} className="p-3 text-sm space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{m.name} <span className="text-muted-foreground">— {m.city}, {m.state}</span></p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.zip_codes.length > 0 ? `Zips: ${m.zip_codes.join(", ")}` : "No zips (radius/county scoped)"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {m.propertyParams || m.motivatedParams
                        ? "Scrape parameters configured"
                        : "No scrape parameters — the buyer and motivated-seller lanes run on defaults"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openParams(m)}
                      disabled={pending}
                      className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground"
                    >
                      {openParamsFor === m.id ? "Close" : "Parameters"}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggle(m.id, !m.is_active)}
                      disabled={pending}
                      className={`rounded-md border px-2 py-1 text-xs font-medium ${m.is_active ? "border-emerald-300 text-emerald-700" : "text-muted-foreground"}`}
                    >
                      {m.is_active ? "Active" : "Inactive"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeMarket(m.id)}
                      disabled={pending}
                      className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive"
                      title="Deletes the market and deactivates its claimed service areas"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {openParamsFor === m.id && (
                  <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                    <div>
                      <p className="text-xs font-semibold">Buyer search parameters</p>
                      <p className="text-[11px] text-muted-foreground">
                        What the property-portal scrape looks for in this market.
                      </p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-4">
                        <input className="rounded-md border bg-background px-2 py-1 text-xs" placeholder="Min price"
                          inputMode="numeric" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
                        <input className="rounded-md border bg-background px-2 py-1 text-xs" placeholder="Max price"
                          inputMode="numeric" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
                        <input className="rounded-md border bg-background px-2 py-1 text-xs" placeholder="Min beds"
                          inputMode="numeric" value={minBeds} onChange={(e) => setMinBeds(e.target.value)} />
                        <input className="rounded-md border bg-background px-2 py-1 text-xs" placeholder="Max beds"
                          inputMode="numeric" value={maxBeds} onChange={(e) => setMaxBeds(e.target.value)} />
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold">Motivated-seller parameters</p>
                      <p className="text-[11px] text-muted-foreground">
                        What the property-data lane treats as a motivated owner in this market.
                      </p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <input className="rounded-md border bg-background px-2 py-1 text-xs" placeholder="Min equity %"
                          inputMode="numeric" value={minEquity} onChange={(e) => setMinEquity(e.target.value)} />
                        <input className="rounded-md border bg-background px-2 py-1 text-xs" placeholder="Max days on market"
                          inputMode="numeric" value={maxDom} onChange={(e) => setMaxDom(e.target.value)} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-4 text-xs">
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" checked={includeExpired}
                            onChange={(e) => setIncludeExpired(e.target.checked)} />
                          Include expired listings
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" checked={includeFsbo}
                            onChange={(e) => setIncludeFsbo(e.target.checked)} />
                          Include FSBO
                        </label>
                      </div>
                    </div>

                    {paramsError && <p className="text-xs text-destructive">{paramsError}</p>}
                    {paramsNotice && <p className="text-xs text-emerald-700">{paramsNotice}</p>}
                    <button
                      type="button"
                      onClick={() => saveParams(m)}
                      disabled={pending}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {pending ? "Saving…" : "Save parameters"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b p-3">
          <h2 className="text-sm font-semibold">Intent keywords ({keywords.length})</h2>
          <p className="text-xs text-muted-foreground">
            The phrases the social-signal scrape matches on. Weight raises how strongly a hit scores the lead.
          </p>
        </div>
        <div className="space-y-2 border-b p-3">
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
            <input className="rounded-md border bg-background px-2 py-1.5 text-sm"
              placeholder="Keyword or phrase (e.g. looking to buy)"
              value={kwText} onChange={(e) => setKwText(e.target.value)} />
            <select className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={kwType} onChange={(e) => setKwType(e.target.value)}>
              {KEYWORD_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
              ))}
            </select>
            <input className="w-20 rounded-md border bg-background px-2 py-1.5 text-sm" placeholder="Weight"
              inputMode="numeric" value={kwWeight} onChange={(e) => setKwWeight(e.target.value)} />
          </div>
          {kwError && <p className="text-xs text-destructive">{kwError}</p>}
          <button
            type="button"
            onClick={addKeyword}
            disabled={pending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending ? "Saving…" : "Add keyword"}
          </button>
        </div>
        {keywords.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No keywords defined — the social-signal scrape has nothing to match on.
          </p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {keywords.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-3 p-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{k.keyword}</p>
                  <p className="text-xs text-muted-foreground">
                    {(k.keyword_type ?? "custom").replace(/_/g, " ")}
                    {k.weight != null && ` · weight ${k.weight}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleKeyword(k.id, !k.is_active)}
                    disabled={pending}
                    className={`rounded-md border px-2 py-1 text-xs font-medium ${k.is_active ? "border-emerald-300 text-emerald-700" : "text-muted-foreground"}`}
                  >
                    {k.is_active ? "Active" : "Inactive"}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeKeyword(k.id)}
                    disabled={pending}
                    className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b p-3">
          <h2 className="text-sm font-semibold">Recent scrape jobs ({initialJobs.length})</h2>
          <p className="text-xs text-muted-foreground">
            Every pipeline run and what it produced. A failed run reports its reason here and nowhere else.
          </p>
        </div>
        {initialJobs.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No scrape jobs have run yet.
          </p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {initialJobs.map((j) => (
              <li key={j.id} className="p-2.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {j.job_type.replace(/_/g, " ")}
                      <span className="text-muted-foreground"> · {j.source}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {j.market_label ?? "No market"}
                      {j.created_at && ` · ${new Date(j.created_at).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-xs font-medium ${
                        j.status === "completed" ? "border-emerald-300 text-emerald-700"
                          : j.status === "failed" ? "border-destructive/40 text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {j.status}
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {j.leads_found ?? 0} found · {j.leads_created ?? 0} created
                    </p>
                  </div>
                </div>
                {j.error_message && (
                  <p className="mt-1 text-xs text-destructive">{j.error_message}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
