"use client"

/**
 * Wave 39 — composition library admin surface. Read-only inventory
 * of every Composition the brokerage has access to, with:
 *   · Tier reachability per row (greyed when the row is registered
 *     but gated above the brokerage's subscription)
 *   · Last-rendered timestamp per brokerage (freshness signal)
 *   · Cost forecast per render
 *   · Intro/outro bookend status + stock-library health
 *
 * Write actions stay on /dashboard/admin/asset-manager-actions — the
 * Asset Manager agent proposes deprecate / promote and the broker
 * approves through the existing queue. This page is the "what's in
 * my inventory" view that solves the "feature shipped, no visibility"
 * problem the broker hit before.
 */
import { useMemo, useState } from "react"
import type { CompositionLibrarySnapshot, CompositionLibraryRow } from "@/app/actions/composition-library"

const ORIENTATION_LABEL: Record<string, string> = {
  square:      "1:1",
  vertical:    "9:16",
  horizontal:  "16:9",
  static_card: "OG",
  postcard:    "Print",
}

const CATEGORY_LABEL: Record<string, string> = {
  listing:        "Listing",
  explainer:      "Explainer",
  presentation:   "Presentation",
  market_update:  "Market Update",
  testimonial:    "Testimonial",
  open_house:     "Open House",
  coming_soon:    "Coming Soon",
  neighborhood:   "Neighborhood",
  affordability:  "Affordability",
  agent_avatar:   "Agent Avatar",
  lead_magnet:    "Lead Magnet",
  postcard:       "Postcard",
  newsletter:     "Newsletter",
  thumbnail:      "Thumbnail",
}

const ALL_CATEGORIES = Object.keys(CATEGORY_LABEL)

function freshnessLabel(iso: string | null): string {
  if (!iso) return "never"
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30)  return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export function CompositionLibraryClient({ snapshot }: { snapshot: CompositionLibrarySnapshot }) {
  const [category, setCategory] = useState<string | null>(null)
  const [reachableOnly, setReachableOnly] = useState(true)

  const filtered: CompositionLibraryRow[] = useMemo(() => {
    return snapshot.rows.filter((r) => {
      if (reachableOnly && !r.reachable_for_tier) return false
      if (category && r.category !== category) return false
      return true
    })
  }, [snapshot.rows, category, reachableOnly])

  const reachableCount = snapshot.rows.filter((r) => r.reachable_for_tier).length
  const categoriesPresent = ALL_CATEGORIES.filter((cat) =>
    snapshot.rows.some((r) => r.category === cat),
  )

  // Stock inventory thresholds — same as the asset-manager's flag
  // condition so the broker sees the same warning the agent does.
  const stockThin =
    snapshot.stockIntroCount < 2 ||
    snapshot.stockOutroCount < 2 ||
    snapshot.stockBrollCount < 3

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Composition Library</h1>
        <p className="text-gray-600 mt-2 max-w-3xl">
          Every Remotion composition registered for the platform, scoped to your
          subscription tier (<span className="font-mono text-gray-900">{snapshot.brokerageTier}</span>).
          Write actions (deprecate / promote / flag) come from the Asset Manager
          agent and land on the{" "}
          <a href="/dashboard/admin/asset-manager-actions" className="text-blue-600 hover:underline">
            asset-manager actions queue
          </a>.
        </p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="reachable" value={`${reachableCount} / ${snapshot.rows.length}`} />
        <StatCard label="brand intros" value={snapshot.stockIntroCount}
          warn={snapshot.stockIntroCount < 2} />
        <StatCard label="logo outros" value={snapshot.stockOutroCount}
          warn={snapshot.stockOutroCount < 2} />
        <StatCard label="B-roll clips" value={snapshot.stockBrollCount}
          warn={snapshot.stockBrollCount < 3} />
        <StatCard label="categories" value={categoriesPresent.length} />
      </section>

      {stockThin && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm">
          <div className="font-medium text-amber-900 mb-1">Stock video library is thin.</div>
          <p className="text-amber-800 text-xs">
            Bookendable renders may repeat the same clip or fall back to no-intro
            mode. The Asset Manager agent will flag this in its weekly review;
            broker should commission or purchase more stock to clear the warning.
            Comfortable thresholds: ≥ 2 intros, ≥ 2 outros, ≥ 3 B-roll.
          </p>
        </div>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setCategory(null)}
            className={`text-xs px-3 py-1 rounded border ${
              category === null
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
            }`}>
            All ({snapshot.rows.length})
          </button>
          {categoriesPresent.map((cat) => {
            const count = snapshot.rows.filter((r) => r.category === cat).length
            return (
              <button key={cat}
                onClick={() => setCategory(category === cat ? null : cat)}
                className={`text-xs px-3 py-1 rounded border ${
                  category === cat
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
                }`}>
                {CATEGORY_LABEL[cat]} ({count})
              </button>
            )
          })}
          <label className="ml-auto text-xs text-gray-700 flex items-center gap-2">
            <input type="checkbox" checked={reachableOnly}
              onChange={(e) => setReachableOnly(e.target.checked)} />
            reachable only
          </label>
        </div>
      </section>

      <section>
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-xs font-semibold uppercase text-gray-500">
                <th className="px-3 py-2">Composition</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Format</th>
                <th className="px-3 py-2">Tier ≥</th>
                <th className="px-3 py-2">Cost / render</th>
                <th className="px-3 py-2">Used (mine)</th>
                <th className="px-3 py-2">Last (mine)</th>
                <th className="px-3 py-2">Bookends</th>
                <th className="px-3 py-2">D-ID / Voice</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500 italic">
                  No compositions match this filter.
                </td></tr>
              ) : filtered.map((r) => (
                <tr key={r.composition_id}
                  className={`border-b border-gray-100 ${r.reachable_for_tier ? "" : "opacity-40"}`}>
                  <td className="px-3 py-2 font-medium text-gray-900">
                    <div>{r.display_name}</div>
                    <div className="text-[10px] text-gray-400 font-mono">{r.composition_id}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="px-3 py-2 text-gray-700">
                    <span className="font-mono text-xs">{ORIENTATION_LABEL[r.orientation] ?? r.orientation}</span>
                    <span className="text-gray-400"> · {r.width}×{r.height}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-mono">
                      {[...r.tier_access].sort((a, b) => ({
                        solo_agent: 1, team: 2, brokerage: 3, multi_location: 4, platform: 5,
                      })[a as "solo_agent"] - ({
                        solo_agent: 1, team: 2, brokerage: 3, multi_location: 4, platform: 5,
                      })[b as "solo_agent"])[0]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-700">${r.cost_per_render_usd.toFixed(2)}</td>
                  <td className="px-3 py-2 text-gray-700">{r.brokerage_render_count}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{freshnessLabel(r.brokerage_last_rendered)}</td>
                  <td className="px-3 py-2 text-gray-700">
                    {r.supports_bookends
                      ? <span className="text-green-700 text-xs">✓ {r.stock_intro_category ?? "—"} / {r.stock_outro_category ?? "—"}</span>
                      : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-700 text-xs">
                    {r.requires_did_avatar && <span className="mr-1 px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">D-ID</span>}
                    {r.requires_voiceover && <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">Voice</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function StatCard({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`p-3 rounded-lg border ${
      warn ? "bg-amber-50 border-amber-200" : "bg-white border-gray-200"
    }`}>
      <div className={`text-2xl font-bold ${warn ? "text-amber-900" : "text-gray-900"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mt-1">{label}</div>
    </div>
  )
}
