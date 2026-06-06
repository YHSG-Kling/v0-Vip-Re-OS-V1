"use client"

import { useState, useTransition } from "react"
import {
  saveFarmMailConfig,
  addCompetitorToWatchlist,
  removeCompetitorFromWatchlist,
  type FarmMailConfig,
  type CompetitorWatchlistEntry,
} from "@/app/actions/direct-mail-settings"

export function DirectMailSettingsClient({
  initialConfig,
  initialWatchlist,
}: {
  initialConfig:    FarmMailConfig
  initialWatchlist: CompetitorWatchlistEntry[]
}) {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Direct Mail Settings</h1>
        <p className="text-gray-600 mt-2">
          Brokerage-level configuration for the farm-mail weekly cron and the
          competitive intel ingest. Per-persona size preferences and lifecycle
          event toggles live on their respective sub-pages.
        </p>
      </header>

      <FarmMailSection initialConfig={initialConfig} />
      <CompetitorWatchlistSection initialWatchlist={initialWatchlist} />
    </div>
  )
}

function FarmMailSection({ initialConfig }: { initialConfig: FarmMailConfig }) {
  const [enabled, setEnabled]   = useState(initialConfig.farm_mail_enabled)
  const [maxWeek, setMaxWeek]   = useState<string>(initialConfig.farm_mail_max_per_week?.toString() ?? "")
  const [templateId, setTemplateId] = useState(initialConfig.lob_fallback_template_id ?? "")
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const r = await saveFarmMailConfig({
        farm_mail_enabled:        enabled,
        farm_mail_max_per_week:   maxWeek.trim() ? Number(maxWeek) : null,
        lob_fallback_template_id: templateId.trim() || null,
      })
      if (!r.success) setError(r.error ?? "Save failed")
      else setSaved(true)
    })
  }

  return (
    <section className="border border-gray-200 rounded-lg p-5 bg-white">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Farm Mail (Weekly Cron)</h2>
      <p className="text-sm text-gray-600 mb-4">
        Walks each agent&apos;s farm_territories on Thursday 08:00 UTC, picks a fresh
        persona-targeted topic from the content bank, and dispatches a branded
        postcard per contact through Lob. Fall-through to the template below
        ships when the AI copy gate fails.
      </p>

      <label className="flex items-center gap-3 mb-4">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-5 w-5"
        />
        <span className="font-medium">Enable weekly farm mail</span>
      </label>

      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Max contacts per agent per cycle</span>
          <input
            type="number"
            min={1}
            max={200}
            value={maxWeek}
            onChange={(e) => setMaxWeek(e.target.value)}
            placeholder="50 (default)"
            className="mt-1 block w-40 border border-gray-300 rounded px-3 py-2 text-sm"
          />
          <span className="block text-xs text-gray-500 mt-1">
            At Lob&apos;s ~$0.78/postcard (4×6) the default 50 ≈ $39/agent/week.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Lob fallback template id</span>
          <input
            type="text"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            placeholder="tmpl_..."
            className="mt-1 block w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono"
          />
          <span className="block text-xs text-gray-500 mt-1">
            Required when farm mail is enabled. Used by the orchestrator when
            AI copy + Remotion render fail.
          </span>
        </label>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {saved && <p className="mt-3 text-sm text-green-600">Saved.</p>}

      <button
        onClick={handleSave}
        disabled={pending}
        className="mt-4 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save farm mail config"}
      </button>
    </section>
  )
}

function CompetitorWatchlistSection({ initialWatchlist }: { initialWatchlist: CompetitorWatchlistEntry[] }) {
  const [entries, setEntries] = useState(initialWatchlist)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Add form state
  const [name, setName]                 = useState("")
  const [fbId, setFbId]                 = useState("")
  const [googleId, setGoogleId]         = useState("")
  const [zips, setZips]                 = useState("")
  const [threshold, setThreshold]       = useState("")

  function handleAdd() {
    setError(null)
    if (!name.trim()) return setError("Competitor name required")
    startTransition(async () => {
      const r = await addCompetitorToWatchlist({
        competitor_name:      name,
        facebook_page_id:     fbId.trim() || null,
        google_advertiser_id: googleId.trim() || null,
        watch_zip_codes:      zips.split(",").map((z) => z.trim()).filter(Boolean),
        min_engagement_score: threshold.trim() ? Number(threshold) : null,
      })
      if (!r.success) {
        setError(r.error ?? "Add failed")
        return
      }
      // Optimistic refresh; the page revalidates and the parent will rehydrate
      // on next navigation. For inline UX add a placeholder row.
      setEntries((prev) => [
        {
          id: r.entryId ?? `pending-${Date.now()}`,
          competitor_name: name,
          facebook_page_id: fbId.trim() || null,
          google_advertiser_id: googleId.trim() || null,
          watch_zip_codes: zips.split(",").map((z) => z.trim()).filter(Boolean),
          min_engagement_score: threshold.trim() ? Number(threshold) : null,
          is_active: true,
        },
        ...prev,
      ])
      setName(""); setFbId(""); setGoogleId(""); setZips(""); setThreshold("")
    })
  }

  function handleRemove(id: string) {
    setError(null)
    startTransition(async () => {
      const r = await removeCompetitorFromWatchlist(id)
      if (!r.success) setError(r.error ?? "Remove failed")
      else setEntries((prev) => prev.filter((e) => e.id !== id))
    })
  }

  return (
    <section className="border border-gray-200 rounded-lg p-5 bg-white">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Competitor Watchlist</h2>
      <p className="text-sm text-gray-600 mb-4">
        The daily Exa cron pulls Meta + Google ads for each competitor below,
        scores them by relevance × recency, and promotes the top-performing
        creative into the topic bank tagged{" "}
        <code className="text-xs bg-gray-100 px-1 rounded">competitor_intel</code>{" "}
        so the marketing agent + farm-mail picks see competitor-aware
        candidates next cycle.
      </p>

      {/* Add form */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 p-3 bg-gray-50 rounded">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Competitor name (required)"
          className="border border-gray-300 rounded px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={fbId}
          onChange={(e) => setFbId(e.target.value)}
          placeholder="Facebook Page id (optional)"
          className="border border-gray-300 rounded px-3 py-2 text-sm font-mono"
        />
        <input
          type="text"
          value={googleId}
          onChange={(e) => setGoogleId(e.target.value)}
          placeholder="Google Advertiser id (optional)"
          className="border border-gray-300 rounded px-3 py-2 text-sm font-mono"
        />
        <input
          type="text"
          value={zips}
          onChange={(e) => setZips(e.target.value)}
          placeholder="Watch zip codes, comma-separated (optional)"
          className="border border-gray-300 rounded px-3 py-2 text-sm"
        />
        <input
          type="number"
          min={0}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          placeholder="Min engagement (0-100, blank = default 30)"
          className="border border-gray-300 rounded px-3 py-2 text-sm"
        />
        <button
          onClick={handleAdd}
          disabled={pending}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add to watchlist"}
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {/* List */}
      {entries.filter((e) => e.is_active).length === 0 ? (
        <p className="text-sm text-gray-500 italic">No competitors on watchlist yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.filter((e) => e.is_active).map((e) => (
            <li key={e.id} className="flex items-start justify-between border border-gray-100 rounded p-3 bg-white">
              <div className="flex-1 min-w-0">
                <div className="font-medium">{e.competitor_name}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {e.facebook_page_id && <span className="mr-3">FB: {e.facebook_page_id}</span>}
                  {e.google_advertiser_id && <span className="mr-3">Google: {e.google_advertiser_id}</span>}
                  {e.watch_zip_codes && e.watch_zip_codes.length > 0 && (
                    <span className="mr-3">Zips: {e.watch_zip_codes.join(", ")}</span>
                  )}
                  {e.min_engagement_score !== null && (
                    <span>Min score: {e.min_engagement_score}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleRemove(e.id)}
                disabled={pending}
                className="ml-3 text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
