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
  type MarketActiveListingRow,
  type IncrementalSearchStateRow,
  type SmartSearchSubscriptionRow,
} from "@/app/actions/lead-scraping-config"
import type { ActiveListingSource } from "@/lib/buyer-search/listing-source-order"
// Lane 72C — the operator toggle surface wave 71 flagged: every SourceKey, derived from
// SOURCE_MAP itself (CLAUDE.md §6 — never a hand-copied second list), so a newly-added
// SourceKey is toggleable here the moment source-intent-map.ts defines it, no second edit.
import { ALL_SOURCE_KEYS, type SourceKey } from "@/lib/lead-pipeline/source-intent-map"

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
  /** Lane 72C. NULL means the row has never been configured — the cron falls back to
   *  ["batchdata_motivated"] only (app/api/cron/lead-scraping/route.ts), never "everything". */
  enabled_sources: string[] | null
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

export interface BatchDataFeedView {
  listings: MarketActiveListingRow[]
  searchState: IncrementalSearchStateRow[]
  subscriptions: SmartSearchSubscriptionRow[]
  /** Wave 68 — this brokerage's resolved active-listing source order, so the panel can explain
   *  whether the (billed) on-market pull below is running and why. */
  activeListingSources: ActiveListingSource[]
  error: string | null
}

function usd(n: number | null): string {
  return n == null ? "—" : `$${Math.round(n).toLocaleString()}`
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never"
}

const KEYWORD_TYPES = ["buying_intent", "selling_intent", "life_event", "distress", "custom"]

function num(v: string): number | undefined {
  const n = Number(v)
  return v.trim() === "" || Number.isNaN(n) ? undefined : n
}

/** "new_construction_intent" -> "New construction intent" — no second hand-maintained label
 *  table (CLAUDE.md §6); every SourceKey is self-describing enough to humanize mechanically. */
function labelSourceKey(key: string): string {
  const words = key.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The cron's own fallback when a market has never been configured
 *  (app/api/cron/lead-scraping/route.ts:231/1031) — shown, never silently assumed "everything". */
const DEFAULT_ENABLED_SOURCES: SourceKey[] = ["batchdata_motivated"]

export function MarketsSetupClient({
  initialMarkets,
  initialKeywords,
  initialJobs,
  suggestedZip,
  initialFeed,
}: {
  initialMarkets: MarketRow[]
  initialKeywords: KeywordRow[]
  initialJobs: JobRow[]
  suggestedZip: string | null
  initialFeed: BatchDataFeedView
}) {
  const marketLabel = (marketId: string): string => {
    const m = initialMarkets.find((x) => x.id === marketId)
    return m ? `${m.name} — ${m.city}, ${m.state}` : "Unknown market"
  }
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

  // Lane 72C — per-market source-toggle panel (the operator surface wave 71 flagged).
  const [openSourcesFor, setOpenSourcesFor] = useState<string | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [sourcesPending, setSourcesPending] = useState<string | null>(null)
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
          propertyParams: null, motivatedParams: null,
          enabled_sources: Array.isArray(m.enabled_sources) ? m.enabled_sources : null },
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

  // Lane 72C — toggles ONE SourceKey for ONE market and writes the full resulting array through
  // updateScrapingMarket (the SAME tenant-scoped update path every other market field uses — no
  // second write path onto lead_scraping_markets). Reads back the server row rather than trusting
  // the optimistic array, so a refused write (a wrong-tenant row, a dropped connection) cannot
  // leave the panel showing a state the database never actually holds.
  const toggleSource = (m: MarketRow, key: string, active: boolean) => {
    setSourcesError(null)
    const current = m.enabled_sources ?? DEFAULT_ENABLED_SOURCES
    const next = active
      ? [...new Set([...current, key])]
      : current.filter((k) => k !== key)
    setSourcesPending(`${m.id}:${key}`)
    startTransition(async () => {
      const res = await updateScrapingMarket(m.id, { enabled_sources: next })
      setSourcesPending(null)
      if (!res.success || !res.market) {
        setSourcesError(res.error ?? `Could not change "${labelSourceKey(key)}" for ${m.name}.`)
        return
      }
      const saved = (res.market as { enabled_sources?: string[] | null }).enabled_sources ?? null
      setMarkets((prev) => prev.map((row) => (row.id === m.id ? { ...row, enabled_sources: saved } : row)))
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
                      onClick={() => {
                        setSourcesError(null)
                        setOpenSourcesFor(openSourcesFor === m.id ? null : m.id)
                      }}
                      disabled={pending}
                      className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground"
                    >
                      {openSourcesFor === m.id ? "Close" : `Data sources (${(m.enabled_sources ?? DEFAULT_ENABLED_SOURCES).length})`}
                    </button>
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

                {openSourcesFor === m.id && (
                  <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                    <p className="text-xs font-semibold">Data sources</p>
                    <p className="text-[11px] text-muted-foreground">
                      Which scrape/behavioral sources this market&apos;s tick runs. A market with none configured
                      falls back to {DEFAULT_ENABLED_SOURCES.map(labelSourceKey).join(", ")} only — check the sources
                      you want, uncheck the ones you don&apos;t. Each change saves immediately.
                    </p>
                    {sourcesError && <p className="text-xs text-destructive">{sourcesError}</p>}
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {ALL_SOURCE_KEYS.map((key) => {
                        const active = (m.enabled_sources ?? DEFAULT_ENABLED_SOURCES).includes(key)
                        const busy = sourcesPending === `${m.id}:${key}`
                        return (
                          <label key={key} className="flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox"
                              checked={active}
                              disabled={pending || busy}
                              onChange={(e) => toggleSource(m, key, e.target.checked)}
                            />
                            <span className={busy ? "text-muted-foreground" : undefined}>{labelSourceKey(key)}</span>
                          </label>
                        )
                      })}
                    </div>
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

      {/* Wave 66 — BatchData feed status: the reader half of m635/m636. */}
      <div className="rounded-lg border bg-card">
        <div className="border-b p-3">
          <h2 className="text-sm font-semibold">BatchData feed ({initialFeed.listings.length} listings tracked)</h2>
          <p className="text-xs text-muted-foreground">
            Market-wide active/expired/withdrawn/sold listings BatchData reports inside your territories, the
            incremental-search cursor state per market and lane, and the Property Monitoring subscriptions the
            daily reconcile admitted (five per account — POOLED by quicklist across every active territory, so
            each slot can cover many territories at once; "pooled" shows how many).
          </p>
          {!initialFeed.activeListingSources.includes("batchdata_on_market") && (
            <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              BatchData on-market pull disabled — your IDX feed when connected, otherwise RentCast, serves
              buyer smart search. This feed still runs for territories opted into other BatchData lanes
              (motivated sellers, incremental search); the billed on-market discovery pull specifically is a
              platform-cost decision, off by default — contact support to opt in. See
              docs/lead-acquisition-coverage-2026-09.md for the cost comparison.
            </p>
          )}
        </div>
        {initialFeed.error && (
          <p className="p-3 text-xs text-destructive">{initialFeed.error}</p>
        )}
        <div className="border-b p-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Property Monitoring subscriptions ({initialFeed.subscriptions.length})</h3>
          {initialFeed.subscriptions.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">None registered yet — the daily scrape tick registers one per active market and quicklist once BatchData has provisioned monitoring for the account.</p>
          ) : (
            <ul className="mt-1 divide-y">
              {initialFeed.subscriptions.map((s) => (
                <li key={`${s.market_id}:${s.quicklist}`} className="py-1.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate">
                      <span className="font-medium">{s.quicklist}</span>
                      <span className="text-muted-foreground"> · {marketLabel(s.market_id)} · priority {s.priority ?? 0}</span>
                      {s.pooled && (
                        <span className="ml-1.5 rounded-md border border-sky-300 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-700">
                          pooled{s.geography_count ? ` · ${s.geography_count} territories` : ""}
                        </span>
                      )}
                    </p>
                    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${
                      s.status === "active" ? "border-emerald-300 text-emerald-700"
                        : s.status === "error" ? "border-destructive/40 text-destructive"
                        : "text-muted-foreground"
                    }`}>{s.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.subscription_id ? `id ${s.subscription_id}` : "no provider id"}
                    {s.pool_key ? ` · pool ${s.pool_key}` : ""} · reconciled {when(s.last_reconciled_at)}
                  </p>
                  {s.last_error && <p className="text-xs text-destructive">{s.last_error}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-b p-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Incremental search state ({initialFeed.searchState.length})</h3>
          {initialFeed.searchState.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No incremental pull has run yet.</p>
          ) : (
            <ul className="mt-1 divide-y">
              {initialFeed.searchState.map((s) => (
                <li key={`${s.market_id}:${s.lane}`} className="py-1.5 text-sm">
                  <p className="truncate">
                    <span className="font-medium">{s.lane}</span>
                    <span className="text-muted-foreground"> · {marketLabel(s.market_id)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.results_found ?? 0} results found · {s.has_cursor ? "resumable cursor held" : "no cursor"} ·{" "}
                    {s.session_supported ? "search session on" : "search session unavailable on this key"} · last run {when(s.last_run_at)}
                  </p>
                  {s.last_error && <p className="text-xs text-destructive">{s.last_error}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="p-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Tracked listings</h3>
          {initialFeed.listings.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No listings discovered yet — the on-market pull runs on the daily scrape tick for every active market.</p>
          ) : (
            <ul className="mt-1 max-h-96 divide-y overflow-y-auto">
              {initialFeed.listings.map((l) => (
                <li key={l.id} className="py-1.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate">
                      <span className="font-medium">{l.property_address}</span>
                      <span className="text-muted-foreground">
                        {" "}· {[l.city, l.state, l.zip].filter(Boolean).join(", ") || marketLabel(l.market_id)}
                      </span>
                    </p>
                    <span className="shrink-0 text-xs font-medium">{usd(l.list_price)} · {l.current_status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {(l.beds != null || l.baths != null || l.sqft != null || l.property_type) && (
                      <>
                        {[l.beds != null ? `${l.beds} bd` : null, l.baths != null ? `${l.baths} ba` : null, l.sqft != null ? `${l.sqft.toLocaleString()} sqft` : null, l.property_type].filter(Boolean).join(" · ")}
                        {" · "}
                      </>
                    )}
                    seen {when(l.last_seen_at)} · status changed {when(l.last_status_change_at)}
                    {l.batchdata_quicklists.length > 0 && ` · ${l.batchdata_quicklists.join(", ")}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
