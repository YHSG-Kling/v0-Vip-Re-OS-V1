"use client"

// app/settings/campaign-bundles/topic-video-cadence-card.tsx
// The tenant's topic-video cadence (wave 83): how many autonomous topic videos a
// week the OS drafts from the topic pool. Every one still waits for a person's
// approval, so the weekly count IS the weekly approval load — said on the card.
import { useEffect, useState, useTransition } from "react"
import { getTopicVideoCadenceAction, setTopicVideoCadenceAction, type TopicVideoCadenceView } from "@/app/actions/video/topic-video-cadence"

export function TopicVideoCadenceCard() {
  const [v, setV] = useState<TopicVideoCadenceView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    getTopicVideoCadenceAction()
      .then((r) => { if (r.ok) setV(r.view); else setErr(r.error) })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load the topic-video cadence"))
  }, [])

  function save(patch: { perWeek?: number; seasonalLift?: boolean; enabled?: boolean }) {
    setErr(null)
    start(async () => {
      const r = await setTopicVideoCadenceAction(patch)
      if (r.ok) setV(r.view); else setErr(r.error)
    })
  }

  return (
    <section className="rounded-lg border p-4 space-y-2">
      <div>
        <h2 className="text-sm font-semibold">Topic videos per week</h2>
        <p className="text-xs text-muted-foreground">
          The OS drafts short videos from your topic pool, each for one kind of client situation, so your market keeps seeing you.
          Three a week is the recommended minimum to stay visible on short-form video. Each draft waits for your approval.
        </p>
      </div>
      {v && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={v.cadence.enabled} disabled={pending} onChange={(e) => save({ enabled: e.target.checked })} />
            On
          </label>
          <label className="flex items-center gap-1">
            Videos a week
            <select
              className="rounded border px-1 py-0.5"
              value={v.cadence.perWeek}
              disabled={pending || !v.cadence.enabled}
              onChange={(e) => save({ perWeek: Number(e.target.value) })}
            >
              {Array.from({ length: v.bounds.max - v.bounds.min + 1 }, (_, i) => v.bounds.min + i).map((n) => (
                <option key={n} value={n}>{n}{n === v.bounds.default ? " (recommended)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={v.cadence.seasonalLift} disabled={pending || !v.cadence.enabled} onChange={(e) => save({ seasonalLift: e.target.checked })} />
            One extra a week in the spring and summer busy season
          </label>
          <span className="text-muted-foreground">This week: {v.thisWeek} to review.</span>
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </section>
  )
}
