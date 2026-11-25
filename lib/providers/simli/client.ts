/**
 * lib/providers/simli/client.ts
 *
 * SIMLI — THE BACKUP FACE-RENDER PROVIDER (wave 62, owner ruling 2026-09-14:
 * "building Simli as a backup makes more sense than HeyGen"). D-ID Express v4
 * stays PRIMARY (docs/live-agent-provider-recommendation-2026-09.md §3);
 * this module is the fail-over leg only, reached through
 * lib/live-agent/face-render.ts, never called directly by a route.
 *
 * FACTS (docs.simli.com, fetched 2026-09-14 — transcribed, not memory):
 *   POST https://api.simli.ai/compose/token
 *     header: x-simli-api-key: <SIMLI_API_KEY>
 *     body:   { faceId, handleSilence: true, maxSessionLength (s),
 *               maxIdleTime (s), model?: "fasttalk" | "artalk" }
 *     →       { session_token }
 *   Client: `new SimliClient(session_token, videoEl, audioEl, iceServers|null,
 *   LogLevel.INFO, "livekit")` — LiveKit mode needs NO ice-server list and NO
 *   LiveKit infrastructure of OUR own; Simli returns livekit_url/livekit_token
 *   over wss://api.simli.ai/compose/webrtc/livekit internally on connect.
 *   Pricing: pay-as-you-go ≈ $0.009/streamed minute (render leg only, priced
 *   in lib/video/realism-profile.ts SIMLI_USD_PER_STREAMING_MINUTE).
 *
 * THE SINGLE EGRESS PATH (CLAUDE.md architecture rule): every call here goes
 * through lib/agentic-os/connector-gateway.ts's callConnector — the SAME
 * gateway lib/did/gateway.ts and lib/voice/elevenlabs-tts.ts already use for
 * "did" and "elevenlabs" — never a bespoke fetch. `connector: "simli"` is the
 * new entry, declared exactly the way those two are: a base URL + auth style
 * at the call site, not a separate connector-spec registry (this repo has
 * none — didRequest and synthesizeSpeech are the precedent for "how a
 * connector is declared" here).
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export const SIMLI_BASE = "https://api.simli.ai"

/** True when the platform Simli credential is configured at all. Mirrors
 *  lib/did/gateway.ts::didConfigured's shape (§6 — one "is this provider
 *  configured" pattern, not a bespoke truthiness check per provider). */
export function simliConfigured(): boolean {
  return !!(process.env.SIMLI_API_KEY ?? "").trim()
}

export interface MintSimliSessionTokenParams {
  faceId: string
  /** Seconds. Hard cap on the whole session — Simli tears down the render
   *  leg when this elapses regardless of activity. */
  maxSessionLength: number
  /** Seconds of silence Simli tolerates before it treats the session as idle
   *  (docs.simli.com's own idle-state motion weakness — see the realism
   *  seam this backs). */
  maxIdleTime: number
  /** "fasttalk" (default-equivalent, lower latency) | "artalk" — not set by
   *  any caller in this wave; passed through only when a future caller wants
   *  it, never fabricated as a default this file invents. */
  model?: "fasttalk" | "artalk"
  /** Wave 156 (156S): the tenant the session's minutes belong to (the budget / receipt scope). */
  brokerageId?: string | null
}

export type MintSimliSessionTokenResult =
  | { ok: true; sessionToken: string }
  | { ok: false; error: string }

/**
 * Mints a short-lived Simli session token for the browser's `simli-client`
 * SDK to connect with (LiveKit mode — no ICE step, no LiveKit infra of ours).
 * Never throws — a missing key, a network failure and a 4xx all come back as
 * `{ok:false}` so the caller (lib/live-agent/face-render.ts's Simli adapter)
 * can hand a typed refusal up to the session route rather than a 500.
 */
export async function mintSimliSessionToken(
  params: MintSimliSessionTokenParams,
): Promise<MintSimliSessionTokenResult> {
  const key = (process.env.SIMLI_API_KEY ?? "").trim()
  if (!key) return { ok: false, error: "SIMLI_API_KEY is not configured" }

  // THE PAID DOOR (wave 156, lane 156S) — lib/vendor-governance/paid-egress.ts runPaidEgress: a session opens billable
  // minutes, so the tenant's vendor budget is asked BEFORE the token is minted, against the session's worst case (its
  // hard length × the ONE per-minute rate); the mint leaves a receipt and books ONE session unit at price_state
  // 'unknown' (the minutes actually streamed are not known at mint — never the cap booked as spend).
  const { runPaidEgress } = await import("@/lib/vendor-governance/paid-egress")
  const { SIMLI_USD_PER_STREAMING_MINUTE } = await import("@/lib/video/realism-profile")
  type TokenRes = import("@/lib/agentic-os/connector-gateway").GatewayResponse<{ session_token?: string }>
  const paid = await runPaidEgress<TokenRes>({
    brokerageId: params.brokerageId ?? null, vendor: "simli", usageType: "live_session", action: "video.simli_session.open",
    estimatedCostUsd: Math.round((params.maxSessionLength / 60) * SIMLI_USD_PER_STREAMING_MINUTE * 10000) / 10000,
    units: 1, priceUnknown: true, subject: { type: "simli_face", id: null, ref: params.faceId }, systemSource: "live_agent_session",
  }, () => callConnector<{ session_token?: string }>({
    connector: "simli",
    baseUrl: SIMLI_BASE,
    path: "/compose/token",
    method: "POST",
    auth: { style: "header", name: "x-simli-api-key", value: key },
    body: {
      faceId: params.faceId,
      handleSilence: true,
      maxSessionLength: params.maxSessionLength,
      maxIdleTime: params.maxIdleTime,
      ...(params.model ? { model: params.model } : {}),
    },
  }), (r) => ({ ok: r.ok && !!r.data?.session_token, costUsd: 0, error: r.ok ? null : r.error }))
  if (!paid.ran) return { ok: false, error: paid.reason === "budget_refused" ? "Vendor budget exceeded — live face session paused" : paid.detail }
  const res = paid.result

  if (!res.ok || !res.data?.session_token) {
    return { ok: false, error: res.error ?? `Simli token mint failed (HTTP ${res.status ?? "?"})` }
  }
  return { ok: true, sessionToken: res.data.session_token }
}

/** Default session bounds for the live-agent fail-over leg — generous enough
 *  for a real conversation, bounded so an abandoned tab cannot bill forever
 *  (the SAME abuse-hard-cap posture live_agent_sessions/checkUsageCap already
 *  applies to the D-ID leg; Simli enforces its own copy of this ceiling
 *  provider-side via maxSessionLength/maxIdleTime, independent of our sweep). */
export const SIMLI_DEFAULT_MAX_SESSION_LENGTH_S = 60 * 30 // 30 min
export const SIMLI_DEFAULT_MAX_IDLE_TIME_S = 60 * 3 // 3 min
