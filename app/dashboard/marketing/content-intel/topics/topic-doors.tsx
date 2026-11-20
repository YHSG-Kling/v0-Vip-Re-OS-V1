"use client"
/**
 * The topic bank's two publication doors (wave 145, lane 145G): a community / event video made from an APPROVED topic goes
 * public through the YouTube rail, and an APPROVED topic + its creative is staged as a DRAFT streaming-TV spot in the Ads
 * Manager (contract C5). Both run through ../topic-actions.ts (session tenant, admin roster) and show the refusal reason.
 */
import { useState, useTransition } from "react"
import { publishCommunityVideoAction, stageTopicTvSpotAction } from "../topic-actions"

export function TopicDoors() {
  const [pending, start] = useTransition()
  const [videoTopic, setVideoTopic] = useState("")
  const [videoId, setVideoId] = useState("")
  const [tvTopic, setTvTopic] = useState("")
  const [tvAsset, setTvAsset] = useState("")
  const [budget, setBudget] = useState("25")
  const [cities, setCities] = useState("")
  const [message, setMessage] = useState<string | null>(null)

  const publish = () => start(async () => {
    const r = await publishCommunityVideoAction({ videoProjectId: videoId.trim(), topicId: videoTopic.trim() })
    setMessage(r.success ? `Queued for YouTube${r.alreadyQueued ? " (already queued)" : ""} — post ${r.socialPostId}.` : `Not published: ${r.error}`)
  })
  const stageTv = () => start(async () => {
    const r = await stageTopicTvSpotAction({ topicId: tvTopic.trim(), assetId: tvAsset.trim(), dailyBudgetCents: Math.round(Number(budget) * 100), cities: cities.split(",").map((c) => c.trim()).filter(Boolean) })
    setMessage(r.success ? `TV draft staged (campaign ${r.campaignId}) — launch it from the Ads Manager after its own approval.${r.warnings.length ? ` Notes: ${r.warnings.join("; ")}` : ""}` : `Not staged: ${r.error}`)
  })

  return (
    <section className="grid gap-6 md:grid-cols-2">
      <div className="border rounded-lg p-4 space-y-2">
        <h2 className="font-semibold">Publish a community video</h2>
        <p className="text-xs text-gray-500">The topic&apos;s campaign idea must be approved, the video made from it and approved for public release.</p>
        <input className="w-full border rounded px-2 py-1 text-sm" placeholder="Topic id" value={videoTopic} onChange={(e) => setVideoTopic(e.target.value)} />
        <input className="w-full border rounded px-2 py-1 text-sm" placeholder="Video project id" value={videoId} onChange={(e) => setVideoId(e.target.value)} />
        <button type="button" className="h-9 px-3 rounded bg-gray-900 text-white text-sm disabled:opacity-50" disabled={pending || !videoTopic.trim() || !videoId.trim()} onClick={publish}>Publish</button>
      </div>
      <div className="border rounded-lg p-4 space-y-2">
        <h2 className="font-semibold">Stage a TV spot from a topic</h2>
        <p className="text-xs text-gray-500">The topic must be approved for TV; the spot stays a draft until its launch is approved in the Ads Manager.</p>
        <input className="w-full border rounded px-2 py-1 text-sm" placeholder="Topic id" value={tvTopic} onChange={(e) => setTvTopic(e.target.value)} />
        <input className="w-full border rounded px-2 py-1 text-sm" placeholder="Video project id (the spot's creative)" value={tvAsset} onChange={(e) => setTvAsset(e.target.value)} />
        <input className="w-full border rounded px-2 py-1 text-sm" placeholder="Daily budget (USD)" value={budget} onChange={(e) => setBudget(e.target.value)} />
        <input className="w-full border rounded px-2 py-1 text-sm" placeholder="Cities (comma-separated)" value={cities} onChange={(e) => setCities(e.target.value)} />
        <button type="button" className="h-9 px-3 rounded bg-gray-900 text-white text-sm disabled:opacity-50" disabled={pending || !tvTopic.trim() || !tvAsset.trim()} onClick={stageTv}>Stage TV draft</button>
      </div>
      {message && <p className="md:col-span-2 text-sm text-gray-700">{message}</p>}
    </section>
  )
}
