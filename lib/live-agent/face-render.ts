/**
 * lib/live-agent/face-render.ts
 *
 * THE FACE-RENDER SEAM (wave 62). Owner ruling, verbatim (2026-09-14):
 * "building Simli as a backup makes more sense than HeyGen." D-ID Express v4
 * stays PRIMARY for the live conversational avatar (portal/embed/site — see
 * docs/live-agent-provider-recommendation-2026-09.md §3); Simli
 * Audio-to-Video is the BACKUP face-render leg. Fail-over order:
 *
 *     D-ID  →  Simli  →  same-brain text chat (wave 60's existing fail-over)
 *
 * PROVIDER-NEUTRAL NAMING (§6 — one vocabulary): "face render" is the
 * concept both D-ID's Agents product and Simli's Audio-to-Video product
 * implement — a WebRTC session that turns a voice turn into a talking face.
 * Neither provider's own name leaks into this type.
 *
 * WHAT THIS FILE DOES vs. WHAT IT DOES NOT DO:
 *   - resolveFaceRenderProvider() is the ONE settings read both session doors
 *     (app/api/did/agents/session, app/api/embed/session) use to learn the
 *     ordered provider list for a brokerage — never a second inline settings
 *     query per route.
 *   - simliFaceRenderAdapter exposes isConfigured()/startSession()/
 *     estimateUsdPerMinute() and is what both session doors call on their
 *     fail-over branch.
 *   - TOMBSTONE (wave 62 integration): a `didFaceRenderAdapter` that WRAPPED
 *     lib/did/agents.ts's ensureDIDAgent + issueClientKey pair was declared
 *     here with no reader — both session doors call that pair directly on
 *     their D-ID PRIMARY path (app/api/did/agents/session/route.ts,
 *     app/api/embed/session/route.ts — proven by scripts/live-agent-identity-
 *     simulator.ts §identity/§metering against that exact shape). Under
 *     CLAUDE.md §1.1 the doors' inline path is the survivor and the wrapper
 *     was the duplicate; deleted. The FaceRenderAdapter interface stays as
 *     the contract any future backup (Anam, Tavus — docs/live-agent-
 *     provider-recommendation-2026-09.md §3) must implement.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  ensureSimliFaceForAgent,
} from "@/lib/providers/simli/faces"
import {
  mintSimliSessionToken,
  simliConfigured,
  SIMLI_DEFAULT_MAX_SESSION_LENGTH_S,
  SIMLI_DEFAULT_MAX_IDLE_TIME_S,
} from "@/lib/providers/simli/client"
import { SIMLI_USD_PER_STREAMING_MINUTE } from "@/lib/video/realism-profile"

/** The two face-render providers this OS supports live. Structurally
 *  identical to lib/video/realism-profile.ts's StreamingFaceProvider (that
 *  file cannot import this one — it is the pricing primitive this seam
 *  depends ON — so the two literal unions are proved equal by
 *  scripts/face-render-seam-simulator.ts rather than sharing an import,
 *  which would create the cycle realism-profile.ts's own comment documents
 *  avoiding). */
export type FaceRenderProvider = "did" | "simli"

/** D-ID primary, Simli backup — the ORDER the owner's ruling states. This is
 *  the fallback when a brokerage has never set its own order (m627,
 *  brokerage_settings.live_agent_face_provider_order — same DEFAULT the
 *  column itself carries, so a row that predates the migration and a row
 *  that has the column but was never customized resolve identically). */
// Module-private: the only readers are the two normalisation branches below;
// the m627 column DEFAULT carries the same order for the database side.
const DEFAULT_FACE_PROVIDER_ORDER: readonly FaceRenderProvider[] = ["did", "simli"]

function normalizeProviderOrder(raw: unknown): FaceRenderProvider[] {
  if (!Array.isArray(raw)) return [...DEFAULT_FACE_PROVIDER_ORDER]
  const cleaned = raw.filter((v): v is FaceRenderProvider => v === "did" || v === "simli")
  return cleaned.length > 0 ? cleaned : [...DEFAULT_FACE_PROVIDER_ORDER]
}

/**
 * THE ONE SETTINGS READ. Resolves the ordered face-render provider list for
 * a brokerage (m627's brokerage_settings.live_agent_face_provider_order).
 * `agentId` is accepted for a future per-agent override — none exists yet
 * (this wave's ruling and migration are brokerage-scoped only), so it is
 * presently unused; kept in the signature so a per-agent settings source
 * found later slots in without changing every call site (§6 — one resolver,
 * extended, never a second one added beside it).
 */
export async function resolveFaceRenderProvider(params: {
  brokerageId: string
  agentId?: string | null
}): Promise<FaceRenderProvider[]> {
  void params.agentId // reserved — see doc comment above
  const svc = createServiceClient()
  const { data } = await svc
    .from("brokerage_settings")
    .select("live_agent_face_provider_order")
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  return normalizeProviderOrder(data?.live_agent_face_provider_order)
}

// ─────────────────────────────────────────────────────────────────────────
// Adapters — each exposes isConfigured() / startSession() / estimateUsdPerMinute()
// ─────────────────────────────────────────────────────────────────────────

export interface FaceRenderSessionParams {
  agentId: string
  twinId?: string | null
  presenterId?: string | null
  elevenLabsVoiceId?: string | null
  personality?: string | null
  greeting?: string | null
  agentName: string
  /** D-ID-specific: origins the issued client_key may be used from. Ignored
   *  by the Simli adapter (Simli's session token is not origin-locked). */
  allowedOrigins?: string[]
}

export type FaceRenderSessionResult =
  | {
      ok: true
      provider: FaceRenderProvider
      /** Provider-specific fields — the route spreads this into its JSON
       *  response. did: {didAgentId, clientKey, presenterType,
       *  realismWarnings}. simli: {sessionToken, faceId}. */
      payload: Record<string, unknown>
    }
  | { ok: false; provider: FaceRenderProvider; error: string }

export interface FaceRenderAdapter {
  isConfigured(): boolean
  estimateUsdPerMinute(): number
  startSession(params: FaceRenderSessionParams): Promise<FaceRenderSessionResult>
}

export const simliFaceRenderAdapter: FaceRenderAdapter = {
  isConfigured: simliConfigured,
  estimateUsdPerMinute: () => SIMLI_USD_PER_STREAMING_MINUTE,
  async startSession(params): Promise<FaceRenderSessionResult> {
    const face = await ensureSimliFaceForAgent(params.agentId)
    if (!face.ok) return { ok: false, provider: "simli", error: face.error }
    // A face enqueued on THIS call is still generating on Simli's side (async,
    // "can take a couple of hours" per docs.simli.com) — minting a session
    // token now would only produce a client startup_error. Fall through to the
    // same-brain text chat for this session; the cached id serves the next.
    if (face.created) {
      return { ok: false, provider: "simli", error: "Simli face enqueued for this agent; it is still generating — text chat for this session" }
    }

    const token = await mintSimliSessionToken({
      faceId: face.faceId,
      maxSessionLength: SIMLI_DEFAULT_MAX_SESSION_LENGTH_S,
      maxIdleTime: SIMLI_DEFAULT_MAX_IDLE_TIME_S,
    })
    if (!token.ok) return { ok: false, provider: "simli", error: token.error }

    return {
      ok: true,
      provider: "simli",
      payload: { sessionToken: token.sessionToken, faceId: face.faceId },
    }
  },
}

// TOMBSTONE (wave 62 integration): a `FACE_RENDER_ADAPTERS` provider→adapter
// map was exported here with no importer. Its function — picking the Simli
// adapter once the provider order admits it — lives at the two session doors,
// app/api/did/agents/session/route.ts (the `providerOrder.includes("simli")`
// branch) and app/api/embed/session/route.ts, which import the adapters by
// name. Deleted under CLAUDE.md §1.3; no second lookup table.
