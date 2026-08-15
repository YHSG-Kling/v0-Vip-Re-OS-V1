/**
 * app/dashboard/marketing/content-intel/page.tsx
 *
 * Wave 19 — brokerage content-intel admin UI. Server component lists every
 * source visible to the caller's brokerage (platform-wide + brokerage-private),
 * with a client-side form to add new sources + toggles to enable/disable.
 *
 * The forms write through the canonical server actions
 * (app/actions/content-intel/sources.ts) which gate on getAgentContext().
 */
import { listContentSources, type ContentSourceRow } from "@/app/actions/content-intel/sources"
import { ContentSourceForm } from "./content-source-form"
import { ToggleButton } from "./toggle-button"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export default async function ContentIntelPage() {
  const result = await listContentSources()
  if (!result.ok) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold">Content Intelligence</h1>
        <p className="mt-4 text-red-600">{result.error}</p>
      </div>
    )
  }

  const platform = result.sources.filter((s) => s.brokerage_id === null)
  const local    = result.sources.filter((s) => s.brokerage_id !== null)

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Content Intelligence</h1>
        <p className="mt-2 text-sm text-gray-600">
          Sources feed your brokerage&apos;s podcast, newsletter video, marketing-agent
          weekly plan, and just-listed reels with VALUE-FIRST topics. Platform-wide
          sources cover real estate broadly; add your own to bring in
          neighborhood-specific Instagram hashtags, competitor handles, or local RSS
          feeds — the topic bank tags them as LOCAL and the picker boosts them +15.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Add a source</h2>
        <ContentSourceForm />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">
          Your sources <span className="text-gray-500 font-normal">({local.length})</span>
        </h2>
        {local.length === 0 ? (
          <p className="text-sm text-gray-500">
            No brokerage-private sources yet. Add one above to start feeding
            local content into your weekly plan.
          </p>
        ) : (
          <SourceTable sources={local} editable />
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">
          Platform-wide sources{" "}
          <span className="text-gray-500 font-normal">({platform.length})</span>
        </h2>
        <p className="text-xs text-gray-500 mb-3">Read-only — these run for every brokerage.</p>
        <SourceTable sources={platform} editable={false} />
      </section>
    </div>
  )
}

function SourceTable({
  sources,
  editable,
}: {
  sources: ContentSourceRow[]
  editable: boolean
}) {
  const list = sources
  return (
    <div className="overflow-x-auto border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left">
          <tr>
            <th className="px-3 py-2 font-semibold">Label</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-3 py-2 font-semibold">Detail</th>
            <th className="px-3 py-2 font-semibold">Last run</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            {editable && <th className="px-3 py-2"></th>}
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id} className="border-t">
              <td className="px-3 py-2">{s.label ?? <span className="text-gray-400">—</span>}</td>
              <td className="px-3 py-2">
                <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                  {s.source_type === "youtube_search" ? "exa_query" : s.source_type}
                </code>
              </td>
              <td className="px-3 py-2 max-w-md truncate text-gray-600">
                {detailFor(s.source_type, s.source_config)}
              </td>
              <td className="px-3 py-2 text-gray-500">
                {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2">
                <span
                  className={
                    s.is_active
                      ? "inline-block px-2 py-0.5 rounded text-xs bg-green-100 text-green-800"
                      : "inline-block px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-600"
                  }
                >
                  {s.is_active ? "active" : "paused"}
                </span>
              </td>
              {editable && (
                <td className="px-3 py-2 text-right">
                  <ToggleButton id={s.id} isActive={s.is_active} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function detailFor(type: string, cfg: Record<string, unknown>): string {
  if (type === "reddit") {
    return `r/${(cfg as { subreddit?: string }).subreddit ?? "?"} · ${(cfg as { window?: string }).window ?? "week"}`
  }
  if (type === "youtube_search") {
    return `Exa: ${((cfg as { query?: string }).query ?? "?").slice(0, 80)}`
  }
  if (type === "rss") {
    return `RSS: ${((cfg as { feed_url?: string }).feed_url ?? "?").replace(/^https?:\/\//, "").slice(0, 80)}`
  }
  if (type === "apify_actor") {
    return `Apify: ${(cfg as { actor?: string }).actor ?? "?"}`
  }
  return JSON.stringify(cfg).slice(0, 80)
}
