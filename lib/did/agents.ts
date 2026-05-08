/**
 * lib/did/agents.ts
 *
 * D-ID Agents helpers — the conversational, real-time avatar product
 * (replaces the deprecated `talks/streams` and `clips/streams` APIs).
 *
 * Architecture (Track A of the Agents migration):
 *   contact (browser)
 *      │  WebRTC, via @d-id/client-sdk
 *      ▼
 *   D-ID Agents Cloud   ◄─── presenter_id (visual) + voice_id (ElevenLabs clone)
 *      │
 *      │  HTTPS, per-turn chat-completion call
 *      ▼
 *   /api/did/custom-llm  ◄─── our brain. Runs the kernel pre-send pipeline,
 *                              brand voice, persona, contact context, etc.
 *
 * One D-ID Agent is created per real-estate-agent (not per contact). The
 * agent's id is cached on agent_voice_profiles.did_agent_id.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

const DID_API_BASE = "https://api.d-id.com"

export interface EnsureDIDAgentParams {
  agentId: string         // agents.id (NOT users.id)
  presenterId: string     // agent's trained D-ID presenter (did_avatar_id)
  elevenLabsVoiceId?: string | null
  /** Display name shown in the D-ID dashboard. */
  agentName: string
}

export interface EnsureDIDAgentResult {
  ok: true
  didAgentId: string
  /** True when this call created a new D-ID Agent (vs. returning a cached id). */
  created: boolean
}

export interface EnsureDIDAgentError {
  ok: false
  error: string
}

/**
 * Returns the cached D-ID Agent id for this real-estate-agent, creating one
 * lazily if it doesn't exist yet. Idempotent — safe to call on every session
 * boot.
 */
export async function ensureDIDAgent(
  params: EnsureDIDAgentParams,
): Promise<EnsureDIDAgentResult | EnsureDIDAgentError> {
  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return { ok: false, error: "DID_API_KEY not configured" }

  const customLlmKey = process.env.DID_CUSTOM_LLM_KEY
  if (!customLlmKey) return { ok: false, error: "DID_CUSTOM_LLM_KEY not configured" }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not configured" }

  const supabase = createServiceClient()

  // ── 1. Cache hit — return immediately ──────────────────────────────────
  const { data: profile } = await supabase
    .from("agent_voice_profiles")
    .select("did_agent_id")
    .eq("agent_id", params.agentId)
    .maybeSingle()

  if (profile?.did_agent_id) {
    return { ok: true, didAgentId: profile.did_agent_id, created: false }
  }

  // ── 2. Cache miss — create the D-ID Agent ──────────────────────────────
  // We use a clip-type presenter (works for both photo- and video-derived
  // avatars) and bind our /api/did/custom-llm as the brain so brand voice +
  // persona + contact context all stay in our code.
  //
  // ElevenLabs voice is optional — if the agent hasn't cloned a voice yet,
  // D-ID falls back to a default voice. Voice can be patched in later by
  // calling PATCH /agents/{id} once the clone is ready.
  const voice = params.elevenLabsVoiceId
    ? {
        type: "elevenlabs" as const,
        voice_id: params.elevenLabsVoiceId,
        voice_config: { stability: 0.5, similarity_boost: 0.75 },
      }
    : { type: "microsoft" as const, voice_id: "en-US-JennyMultilingualV2Neural" }

  const body = {
    preview_name: params.agentName.slice(0, 40),
    presenter: {
      type: "clip" as const,
      presenter_id: params.presenterId,
      voice,
    },
    llm: {
      provider: "custom" as const,
      type: "basic" as const,
      url: `${appUrl}/api/did/custom-llm`,
      key: customLlmKey,
      streaming: true,
      // Instructions are intentionally minimal here — the *real* persona,
      // brand voice, and contact context are injected by /api/did/custom-llm
      // on every request. See lib/kernel/brand-voice.ts + the route handler.
      instructions:
        "You are the real-estate-agent's AI assistant speaking with one of their clients. " +
        "Defer to the system context provided on each message — it carries the contact's " +
        "name, journey stage, and the agent's brand voice. Keep replies short, warm, and " +
        "natural for a face-to-face conversation.",
    },
  }

  const res = await fetch(`${DID_API_BASE}/agents`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.id) {
    return {
      ok: false,
      error: data?.description ?? data?.message ?? `D-ID create-agent failed (${res.status})`,
    }
  }

  // ── 3. Cache the id ────────────────────────────────────────────────────
  // upsert because the row may not exist yet for agents whose voice/avatar
  // setup hasn't been touched.
  await supabase
    .from("agent_voice_profiles")
    .upsert(
      { agent_id: params.agentId, did_agent_id: data.id },
      { onConflict: "agent_id" },
    )

  return { ok: true, didAgentId: data.id, created: true }
}

export interface IssueClientKeyParams {
  didAgentId: string
  /** Origin host(s) the SDK is allowed to load from — D-ID locks the key
   *  to these. Pass the full origin (https://...) without a trailing slash. */
  allowedOrigins: string[]
}

export interface ClientKeyResult {
  ok: true
  /** Short-lived client key the browser SDK uses for auth. NOT the master key. */
  clientKey: string
  /** Seconds until the key expires (informational). */
  expiresIn?: number
}

/**
 * Issues a short-lived, origin-restricted client_key for the @d-id/client-sdk.
 * The master DID_API_KEY never leaves the server.
 */
export async function issueClientKey(
  params: IssueClientKeyParams,
): Promise<ClientKeyResult | EnsureDIDAgentError> {
  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return { ok: false, error: "DID_API_KEY not configured" }

  const res = await fetch(`${DID_API_BASE}/agents/client-key`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      agent_id: params.didAgentId,
      allowed_origins: params.allowedOrigins,
    }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.client_key) {
    return {
      ok: false,
      error: data?.description ?? data?.message ?? `D-ID client-key issuance failed (${res.status})`,
    }
  }

  return {
    ok: true,
    clientKey: data.client_key,
    expiresIn: data.expires_in,
  }
}
