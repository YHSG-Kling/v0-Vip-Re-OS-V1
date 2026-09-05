"use client"

/**
 * app/portal/listing-plan/[id]/listing-plan-segments.tsx
 *
 * The seller-facing SEGMENT PLAYER for the pre-listing video drip. The owner's
 * question — "the listing-plan route could be the video landing page?" — is
 * answered here: one segment per released presentation_section, played in the
 * order the drip scheduled them.
 *
 * This component is DUMB ON PURPOSE. It receives only what the server page
 * already decided is seller-safe (title, seller-safe note/narrative, on-screen
 * bullets, and a video URL that evaluateRenderReadiness marked 'succeeded').
 * It performs no fetching, holds no ids, and can therefore not widen what a
 * seller sees. Every financial exclusion is enforced upstream in page.tsx.
 *
 * Degradation: a segment whose render is still queued (or failed) arrives with
 * videoUrl === null and reads as a text card — the plan is never blank because
 * a render lagged.
 */

import { useState } from "react"

export interface PlanSegment {
  key:          string
  title:        string
  /** Seller-safe body note (e.g. "Your home's value will be presented at our meeting."). */
  note:         string | null
  /** Price-free market narrative merged into the CMA section by section-drip.ts. */
  narrative:    string | null
  /** On-screen copy from the render's input_props — generated seller-safe by section-narration.ts. */
  bullets:      string[]
  videoUrl:     string | null
  thumbnailUrl: string | null
}

export default function ListingPlanSegments({ segments }: { segments: PlanSegment[] }) {
  const firstWithVideo = segments.findIndex((s) => !!s.videoUrl)
  const [active, setActive] = useState(firstWithVideo >= 0 ? firstWithVideo : 0)
  const current = segments[active]

  if (!current) return null

  const videoCount = segments.filter((s) => !!s.videoUrl).length

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {current.videoUrl ? (
          <video
            key={current.key}
            className="aspect-video w-full bg-black"
            src={current.videoUrl}
            poster={current.thumbnailUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
          />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center bg-slate-100 px-6 text-center dark:bg-slate-800">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              The video for this chapter is still being produced — the details are below.
            </p>
          </div>
        )}

        <div className="p-5">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{current.title}</h2>
          {current.bullets.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {current.bullets.map((b, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
          {current.narrative && (
            <p className="mt-4 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{current.narrative}</p>
          )}
          {current.note && (
            <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {current.note}
            </p>
          )}
        </div>
      </section>

      <nav aria-label="Listing plan chapters" className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {segments.length} chapter{segments.length === 1 ? "" : "s"}
          {videoCount > 0 ? ` · ${videoCount} video${videoCount === 1 ? "" : "s"}` : ""}
        </p>
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {segments.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => setActive(i)}
                aria-current={i === active ? "true" : undefined}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
                  i === active
                    ? "bg-amber-50 dark:bg-amber-950/30"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                }`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                  {i + 1}
                </span>
                <span className="flex-1 text-sm font-medium text-slate-900 dark:text-slate-100">{s.title}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {s.videoUrl ? "Watch" : "Read"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
