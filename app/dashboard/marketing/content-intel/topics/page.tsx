/**
 * app/dashboard/marketing/content-intel/topics/page.tsx — THE TOPIC BANK, WITH ITS EVIDENCE (wave 145, lane 145G; owner
 * ruling 22). Every intelligence topic shows WHERE it came from, WHEN, the engagement evidence the source can actually show
 * (and its basis — a public count, a search-ranking proxy, this tenant's own counts), its confidence, what it can become,
 * and where it stands in the ONE approval queue (the campaign idea; the TV approval). Reads through the session door
 * (./topic-actions.ts listTopicIntelligenceAction). The two publication doors are below the table.
 */
import { listTopicIntelligenceAction } from "../topic-actions"
import { TopicDoors } from "./topic-doors"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASIS_LABEL: Record<string, string> = {
  public_counts: "public counts",
  search_rank_proxy: "search-ranking proxy (not interactions)",
  internal_count: "your own records",
  observation_count: "monitor observations",
  none: "no engagement evidence",
}

export default async function TopicBankPage() {
  const result = await listTopicIntelligenceAction()
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Topic bank</h1>
        <p className="mt-2 text-sm text-gray-600">
          Themes from competitor posts and ads, what is outperforming, your clients&apos; questions, education and AI-search gaps,
          local events and news, and your market&apos;s value trends — each with its source and evidence. Themes, never anyone&apos;s
          creative; no result is promised. Every piece made from a topic still goes through its own approval before it is published.
        </p>
      </div>
      {!result.success ? (
        <p className="text-sm text-red-600">{result.error}</p>
      ) : result.topics.length === 0 ? (
        <p className="text-sm text-gray-500">No intelligence topics yet — they appear after the daily pass reads your market, your competitors and your inbox.</p>
      ) : (
        <>
        {/* Phone: one card per topic (the same fields as the table's columns). */}
        <div className="md:hidden space-y-3">
          {result.topics.map((t) => (
            <div key={t.id} className="border rounded-lg p-3 text-sm space-y-2">
              <div>
                <div className="font-medium">{t.title}</div>
                {t.angle && <div className="text-xs text-gray-500 mt-1">{t.angle}</div>}
              </div>
              <div className="text-xs text-gray-600">
                <code className="bg-gray-100 px-1 rounded">{t.sourceClass}</code> · {t.source}
                {t.observedAt ? ` · ${new Date(t.observedAt).toLocaleDateString()}` : ""}
                {t.sourceUrl && <> · <a className="text-blue-600 underline" href={t.sourceUrl} target="_blank" rel="noopener noreferrer">source</a></>}
              </div>
              <div className="text-xs text-gray-600">
                {BASIS_LABEL[t.engagementBasis] ?? t.engagementBasis}
                {Object.entries(t.engagement).map(([k, v]) => <span key={k}> · {k.replace(/_/g, " ")}: {v}</span>)}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>Confidence {t.confidence === null ? "—" : `${Math.round(t.confidence * 100)}%`}</span>
                <span>Idea {t.ideaStatus ?? "—"}</span>
                <span>TV {t.tvStatus ?? "—"}</span>
              </div>
              {t.tvClaims && <div className="text-xs text-gray-500">TV spot may claim: {t.tvClaims.length ? t.tvClaims.join("; ") : "no figure (no verified fact)"}</div>}
              <div className="text-xs text-gray-500 break-all">id {t.id}</div>
            </div>
          ))}
        </div>
        <div className="hidden md:block overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 font-semibold">Topic</th>
                <th className="px-3 py-2 font-semibold">Source</th>
                <th className="px-3 py-2 font-semibold">Evidence</th>
                <th className="px-3 py-2 font-semibold">Confidence</th>
                <th className="px-3 py-2 font-semibold">Idea</th>
                <th className="px-3 py-2 font-semibold">TV</th>
              </tr>
            </thead>
            <tbody>
              {result.topics.map((t) => (
                <tr key={t.id} className="border-t align-top">
                  <td className="px-3 py-2 max-w-md">
                    <div className="font-medium">{t.title}</div>
                    {t.angle && <div className="text-xs text-gray-500 mt-1">{t.angle}</div>}
                    <div className="text-xs text-gray-500 mt-1">id {t.id}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    <div><code className="bg-gray-100 px-1 rounded">{t.sourceClass}</code></div>
                    <div className="mt-1">{t.source}</div>
                    <div className="mt-1">{t.observedAt ? new Date(t.observedAt).toLocaleDateString() : "—"}</div>
                    {t.sourceUrl && <a className="text-blue-600 underline" href={t.sourceUrl} target="_blank" rel="noopener noreferrer">source</a>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    <div>{BASIS_LABEL[t.engagementBasis] ?? t.engagementBasis}</div>
                    {Object.entries(t.engagement).map(([k, v]) => <div key={k}>{k.replace(/_/g, " ")}: {v}</div>)}
                  </td>
                  <td className="px-3 py-2 text-xs">{t.confidence === null ? "—" : `${Math.round(t.confidence * 100)}%`}</td>
                  <td className="px-3 py-2 text-xs">{t.ideaStatus ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{t.tvStatus ?? "—"}</div>
                    {t.tvClaims && <div className="mt-1 text-gray-500">may claim: {t.tvClaims.length ? t.tvClaims.join("; ") : "no figure (no verified fact)"}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      <TopicDoors />
    </div>
  )
}
