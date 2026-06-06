// lib/podcast/transistor-client.ts
// Podcast syndication via Transistor (api.transistor.fm/v1). Publishing one episode to a show
// distributes it to Spotify / Apple Podcasts / etc through Transistor's managed RSS — so a single
// per-tier connection covers every channel. All egress goes through the connector-gateway.
//
// Auth: header `x-api-key`. Transistor uses nested form params (episode[...]) like Stripe, so we
// send x-www-form-urlencoded with bracketed keys (gateway bodyType: "form").

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const TRANSISTOR_BASE = "https://api.transistor.fm"

export interface SyndicateEpisodeParams {
  apiKey: string
  showId: string
  title: string
  summary: string
  audioUrl: string
}

export interface SyndicateEpisodeResult {
  ok: boolean
  /** Transistor episode id (the real external id — no placeholders). */
  episodeId?: string
  /** Public share URL Transistor returns once published. */
  shareUrl?: string
  error?: string
}

/**
 * Create + publish an episode on the connected Transistor show. Two gateway calls:
 *   1. POST /v1/episodes        — create the episode pointing at the remote audio URL
 *   2. PATCH /v1/episodes/:id/publish — flip it live (triggers RSS syndication)
 */
export async function syndicateEpisode(params: SyndicateEpisodeParams): Promise<SyndicateEpisodeResult> {
  if (!params.apiKey || !params.showId) return { ok: false, error: "Podcast distributor not connected" }
  if (!params.audioUrl) return { ok: false, error: "Episode has no audio to syndicate" }

  // 1. Create the episode (remote audio_url — Transistor fetches + hosts it).
  const created = await callConnector<{ data?: { id?: string } }>({
    connector: "transistor",
    baseUrl: TRANSISTOR_BASE,
    path: "/v1/episodes",
    method: "POST",
    auth: { style: "header", name: "x-api-key", value: params.apiKey },
    bodyType: "form",
    body: {
      "episode[show_id]": params.showId,
      "episode[title]": params.title,
      "episode[summary]": params.summary,
      "episode[audio_url]": params.audioUrl,
    },
  })
  const episodeId = created.data?.data?.id
  if (!created.ok || !episodeId) {
    return { ok: false, error: created.error ?? `Transistor create failed (${created.status})` }
  }

  // 2. Publish it (status=published → syndicates via the show's RSS feed).
  const published = await callConnector<{ data?: { attributes?: { share_url?: string } } }>({
    connector: "transistor",
    baseUrl: TRANSISTOR_BASE,
    path: `/v1/episodes/${episodeId}/publish`,
    method: "PATCH",
    auth: { style: "header", name: "x-api-key", value: params.apiKey },
    bodyType: "form",
    body: { "episode[status]": "published" },
  })
  if (!published.ok) {
    return { ok: false, episodeId, error: published.error ?? `Transistor publish failed (${published.status})` }
  }

  return { ok: true, episodeId, shareUrl: published.data?.data?.attributes?.share_url }
}
