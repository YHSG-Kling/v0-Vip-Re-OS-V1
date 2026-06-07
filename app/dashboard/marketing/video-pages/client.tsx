"use client"

import { useState, useTransition } from "react"
import {
  publishRenderToWeb,
  unpublishRenderFromWeb,
  type PublishableRender,
} from "@/app/actions/video-landing"

export function VideoPagesClient({ renders: initial }: { renders: PublishableRender[] }) {
  const [renders, setRenders] = useState(initial)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const origin = typeof window !== "undefined" ? window.location.origin : ""

  function setRow(id: string, patch: Partial<PublishableRender>) {
    setRenders((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function publish(id: string) {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      const res = await publishRenderToWeb(id)
      if (res.success) setRow(id, { is_published: true, public_slug: res.slug })
      else setError(res.error)
      setPendingId(null)
    })
  }

  function unpublish(id: string) {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      const res = await unpublishRenderFromWeb(id)
      if (res.success) setRow(id, { is_published: false })
      else setError(res.error)
      setPendingId(null)
    })
  }

  function copyLink(slug: string) {
    const url = `${origin}/v/${slug}`
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(slug)
      setTimeout(() => setCopied((c) => (c === slug ? null : c)), 1800)
    })
  }

  const publishedCount = renders.filter((r) => r.is_published).length

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Video Pages</h1>
      <p className="text-gray-600 mb-1">
        Publish a rendered video as a public, AI-search-citable page. Published pages carry your
        listing/market facts as structured data so ChatGPT, Perplexity, and Google AI Overviews can
        cite them — and they auto-include your license &amp; Equal Housing disclosures.
      </p>
      <p className="text-sm text-gray-500 mb-5">
        {publishedCount} published · {renders.length} render{renders.length === 1 ? "" : "s"} available
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {renders.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center text-gray-500">
          No finished video renders yet. Once the agentic OS renders a video for you, it will appear here.
        </div>
      ) : (
        <ul className="space-y-3">
          {renders.map((r) => (
            <li key={r.id} className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-3">
              <div className="h-16 w-28 shrink-0 overflow-hidden rounded bg-gray-900">
                {r.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.thumbnail_url} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-gray-900">{r.display_name}</span>
                  {r.is_published ? (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Published</span>
                  ) : (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Private</span>
                  )}
                  {!r.is_own && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">team</span>
                  )}
                </div>
                {r.is_published && r.public_slug ? (
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <a href={`/v/${r.public_slug}`} target="_blank" rel="noreferrer" className="truncate text-blue-600 hover:underline">
                      /v/{r.public_slug}
                    </a>
                    <button onClick={() => copyLink(r.public_slug!)} className="text-gray-500 hover:text-gray-800">
                      {copied === r.public_slug ? "Copied!" : "Copy link"}
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-gray-400">
                    {r.completed_at ? new Date(r.completed_at).toLocaleDateString() : "Ready to publish"}
                  </div>
                )}
              </div>

              <div className="shrink-0">
                {r.is_published ? (
                  <button
                    onClick={() => unpublish(r.id)}
                    disabled={pendingId === r.id}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {pendingId === r.id ? "…" : "Unpublish"}
                  </button>
                ) : (
                  <button
                    onClick={() => publish(r.id)}
                    disabled={pendingId === r.id}
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                  >
                    {pendingId === r.id ? "Publishing…" : "Publish to web"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
