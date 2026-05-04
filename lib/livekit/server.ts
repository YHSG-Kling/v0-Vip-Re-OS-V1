/**
 * lib/livekit/server.ts
 *
 * Server-side helpers for issuing LiveKit room access tokens. LiveKit is the
 * realtime voice/video transport for the on-the-go AI talking assistant
 * (Phase A — runs in parallel with the existing VAPI ISA stack and the D-ID
 * avatar chat widget; nothing existing is replaced).
 *
 * Env vars (super-admin configures via System Providers):
 *   LIVEKIT_API_KEY      — server-side API key
 *   LIVEKIT_API_SECRET   — server-side API secret
 *   LIVEKIT_URL          — wss://<your-project>.livekit.cloud (or self-host URL)
 *
 * NOTE: this file MUST stay server-only. The secret never crosses to a client.
 */

import "server-only"
import { AccessToken } from "livekit-server-sdk"

export interface LivekitTokenInput {
  /** Room name — typically `assistant-{userId}-{nanoid}` so each session is isolated. */
  roomName: string
  /** Identity that will appear in the room (must be unique). */
  identity: string
  /** Optional human-readable display name. */
  name?: string
  /** Default 10 min — agent worker keeps the room alive on its own. */
  ttlSeconds?: number
  /** Allow the participant to publish (mic). Defaults to true. */
  canPublish?: boolean
  /** Allow the participant to subscribe (hear the agent). Defaults to true. */
  canSubscribe?: boolean
  /** Arbitrary structured metadata the agent worker can read off the room. */
  metadata?: Record<string, unknown>
}

export interface LivekitTokenResult {
  token: string
  url: string
  roomName: string
  identity: string
  expiresAt: number
}

/**
 * Issues a short-lived LiveKit access token. Throws if env vars are missing —
 * callers should check {@link isLivekitConfigured} first when behavior should
 * be conditional on configuration.
 */
export async function issueLivekitToken(input: LivekitTokenInput): Promise<LivekitTokenResult> {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const url = process.env.LIVEKIT_URL

  if (!apiKey || !apiSecret || !url) {
    throw new Error("LiveKit not configured — missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL")
  }

  const ttl = input.ttlSeconds ?? 600

  const at = new AccessToken(apiKey, apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl,
    metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
  })

  at.addGrant({
    room: input.roomName,
    roomJoin: true,
    canPublish: input.canPublish ?? true,
    canSubscribe: input.canSubscribe ?? true,
    canPublishData: true,
  })

  const token = await at.toJwt()
  return {
    token,
    url,
    roomName: input.roomName,
    identity: input.identity,
    expiresAt: Date.now() + ttl * 1000,
  }
}

export function isLivekitConfigured(): boolean {
  return !!(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_URL)
}
