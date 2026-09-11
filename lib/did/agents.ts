/**
 * lib/did/agents.ts
 *
 * D-ID Agents helpers — the conversational, real-time avatar product
 * (replaces the deprecated `talks/streams` and `clips/streams` APIs).
 *
 * RESEARCH (owner ruling, wave 58, verbatim: "we are using d-id express v4 for
 * live agent for website, widget, in portal as options"). Fetched via Exa on
 * 2026-09-11 — every shape below is transcribed from these, not memory:
 *   - https://docs.d-id.com/reference/agents-sdk-overview (fetched 2026-09-11)
 *     — the @d-id/client-sdk contract: createAgentManager(agentId, {auth,
 *     callbacks, streamOptions}); THREE presenter families (Talks V2 / Clips V3
 *     WebRTC, Expressives V4 LiveKit); agentManager.connect() / .speak() /
 *     .chat() / .rate(); speak() accepts `sentiment` + `should_queue_speaks`,
 *     documented "Expressive (V4) agents only."
 *   - https://docs.d-id.com/reference/createagentstream (fetched 2026-09-11)
 *     — POST /agents/{agentId}/streams: InitVideoStreamRequest {fluent,
 *     session_timeout, stream_warmup, compatibility_mode}, InitStreamResponse
 *     {session_id, id, jsep, ice_servers}. Confirms `fluent` and stream options
 *     are the v2/v3 WebRTC contract lib/did/agent-presenter.ts already gates.
 *   - https://www.d-id.com/introducing-v4-expressive-avatars/ (published
 *     2026-02-02, fetched 2026-09-11) — V4 Expressive: <500ms conversational
 *     latency, selectable sentiments (friendly/professional/empathetic/
 *     excited/frustrated), LiveKit transport, "optional camera activation" and
 *     "media display mode" (not wired here — no caller needs them yet, so they
 *     are not fabricated), best paired with an ElevenLabs V3 voice.
 *   - https://apis.io/apis/d-id/d-id-agents-api/ (fetched 2026-09-11, mirrors
 *     the published D-ID Agents OpenAPI) — confirms the FULL Agents CRUD
 *     surface: POST /agents, GET /agents/{id}, PATCH /agents/{id} (body =
 *     the SAME AgentCreateDto as POST — presenter/preview_name/llm/knowledge/
 *     greetings/embed/triggers, partial-update by omission), DELETE /agents/{id}.
 *     PATCH is the update half this module was missing — see syncDIDAgent below.
 *
 * PRICING / RATE LIMITS: no D-ID price table or documented per-tenant rate
 * limit exists in this repo or in the fetched references above (the account
 * page is not machine-readable from here) — recording "unresolved" per
 * CLAUDE.md §2 rather than inventing a number. Usage is capped independently
 * by this app's own `live_avatar_sessions` / `live_avatar_minutes` meters
 * (lib/usage/check-cap.ts), which is the real, tenant-visible limit regardless
 * of whatever D-ID's account-level throttle turns out to be.
 *
 * Architecture (Track A of the Agents migration):
 *   contact (browser)
 *      │  WebRTC/LiveKit, via @d-id/client-sdk
 *      ▼
 *   D-ID Agents Cloud   ◄─── presenter_id (visual) + voice_id (ElevenLabs clone)
 *      │
 *      │  HTTPS, per-turn chat-completion call
 *      ▼
 *   /api/did/custom-llm  ◄─── our brain. Runs the kernel pre-send pipeline,
 *                              brand voice, brokerage knowledge/FAQ, contact
 *                              context, spoken-realism directive, etc.
 *
 * One D-ID Agent is created per TWIN (agent_avatar_assets.did_agent_id), with a
 * legacy per-agent fallback (agent_voice_profiles.did_agent_id) for agents who
 * have not migrated to Twin Studio. THREE SURFACES mint sessions against the
 * SAME agent record — public website (app/site, app/p → SiteChatLauncher →
 * /embed/[publicId] when a live-capable embed is configured), the embeddable
 * widget (/embed/[publicId], third-party sites), and the client portal
 * (AgentsWidget via /api/did/agents/session) — never a second agent-creation
 * path per surface (§6).
 *
 * EGRESS: every D-ID call in this module goes through lib/did/gateway.ts's
 * `didRequest` (Connection OS's single egress path), NOT a bespoke
 * `callConnector` call. It was bespoke before this pass — the direct
 * `callConnector` import bypassed `externalKeyHeader()`, so an agent created
 * or patched with an ElevenLabs-cloned voice never sent our ElevenLabs key:
 * D-ID resolved `voice_id` against ITS OWN account, where our IVC clone does
 * not exist, and the avatar would have spoken in a default/stranger voice
 * with nothing reporting why (gateway.ts's own header names this exact
 * failure mode). lib/did/create-avatar and the two poll crons were already on
 * `didRequest`; this file — the live conversational half — was the one
 * surface still bypassing it. Fixed here, not duplicated (§1: merge onto the
 * gateway survivor).
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { didRequest } from "./gateway"
import { classifyDidError } from "./contract"
import { buildAgentPresenter, presenterTypeForTwin, type DidPresenterType } from "./agent-presenter"
import { SPOKEN_REALISM_DIRECTIVE, scanForAiTells } from "@/lib/video/realism-profile"

// Re-exported so the session routes can report the family to the browser
// without importing this server-only module for a pure lookup.
export { presenterTypeForTwin } from "./agent-presenter"
export type { DidPresenterType } from "./agent-presenter"

export interface EnsureDIDAgentParams {
  agentId: string         // agents.id (NOT users.id)
  presenterId: string     // trained D-ID presenter (did_avatar_id) for this twin
  elevenLabsVoiceId?: string | null
  /** Display name shown in the D-ID dashboard. */
  agentName: string
  /** When set, the D-ID Agent id is cached on this twin row instead of
   *  the per-agent agent_voice_profiles fallback. Each twin gets its own
   *  D-ID Agent so personality + voice + presenter stay locked together. */
  twinId?: string
  /** Free-text personality / tone — appended to the base instructions so
   *  the bundled LLM (or our custom-LLM endpoint) sees it. */
  personality?: string | null
  /** The twin's own opening line — scanned (advisory) for AI-tells before
   *  it ever reaches a real conversation; see the realism note below. */
  greeting?: string | null
}

export interface EnsureDIDAgentResult {
  ok: true
  didAgentId: string
  /** Which presenter family this agent is — decides what the live widget may
   *  offer (microphone / barge-in / sentiment are not uniform across them). */
  presenterType: DidPresenterType
  /** True when this call created a new D-ID Agent (vs. returning a cached id). */
  created: boolean
  /** AI-tell scanner findings on the greeting, when one was given. Advisory
   *  only (CLAUDE.md §5 — warnings pass through, never a silent block) — a
   *  contact never sees an avatar refuse to exist over its own opening line. */
  realismWarnings?: string[]
}

export interface EnsureDIDAgentError {
  ok: false
  error: string
}

/**
 * THE LIVE-CONVERSATION REALISM DIRECTIVE (owner ruling, wave 55/57: "the
 * video product the os creates needs to look and appear real … this includes
 * ai created videos" — extended here to the LIVE avatar, the highest-stakes
 * surface for "does this sound like a real person"). Reuses
 * lib/video/realism-profile.ts's SPOKEN_REALISM_DIRECTIVE verbatim — ONE
 * spoken-delivery charter for every surface that puts words in the twin's
 * mouth (rendered video AND live conversation), never a second one (§6).
 * Folded into `llm.instructions` (baseline, every turn) rather than only
 * checked post-hoc, matching §5's "compliance-first … not only in the
 * post-hoc scan" ruling — /api/did/custom-llm's per-turn system prompt is
 * the second half (it can react to the ACTUAL conversation; this is the
 * standing instruction D-ID's own bundled LLM sees on the turns our
 * custom-LLM is bypassed for, e.g. a starter/greeting D-ID renders itself).
 */
const LIVE_REALISM_INSTRUCTIONS = SPOKEN_REALISM_DIRECTIVE
  .split("\n")
  .slice(0, 1) // the framing line — "this script will be SPOKEN ALOUD…" — still true live
  .concat([
    "Speak in short, natural sentences a real person would say out loud — contractions always, no stiff written-register phrasing.",
    "Never say you are an AI, a bot, a language model, or that this conversation was generated — you ARE the agent, speaking live.",
    "No stock openers (\"hi, i'm X from Y\") — the contact already knows who they're talking to; get straight to helping them.",
  ])
  .join(" ")

/** PURE: the body shared by CREATE (POST) and UPDATE (PATCH) — one builder so
 *  the two calls can never drift (§6). */
function buildAgentBody(params: {
  agentName: string
  presenterId: string
  elevenLabsVoiceId?: string | null
  personality?: string | null
  appUrl: string
  customLlmKey: string
}) {
  const voice = params.elevenLabsVoiceId
    ? {
        type: "elevenlabs" as const,
        voice_id: params.elevenLabsVoiceId,
        voice_config: { stability: 0.5, similarity_boost: 0.75 },
      }
    : { type: "microsoft" as const, voice_id: "en-US-JennyMultilingualV2Neural" }

  return {
    preview_name: params.agentName.slice(0, 40),
    // THE PRESENTER FAMILY IS RESOLVED, NOT HARDCODED — see agent-presenter.ts
    // for the capability matrix and the quoted basis for each line of it.
    presenter: buildAgentPresenter({ presenterId: params.presenterId, voice }),
    llm: {
      provider: "custom" as const,
      type: "basic" as const,
      url: `${params.appUrl}/api/did/custom-llm`,
      key: params.customLlmKey,
      streaming: true,
      // The REAL persona, brand voice, brokerage knowledge/FAQ and contact
      // context are injected by /api/did/custom-llm on every request — this
      // stays a baseline identity + the realism directive, so a fallback D-ID
      // greeting or starter (rendered before our endpoint is ever called)
      // still sounds like a person and never claims to be AI.
      instructions: [
        "You are the real-estate-agent's AI assistant speaking with one of their clients.",
        "Defer to the system context provided on each message — it carries the contact's name, journey stage, and the agent's brand voice.",
        "Keep replies short, warm, and natural for a face-to-face conversation.",
        LIVE_REALISM_INSTRUCTIONS,
        params.personality ? `Personality: ${params.personality}` : null,
      ].filter(Boolean).join(" "),
    },
  }
}

/**
 * Returns the cached D-ID Agent id for this real-estate-agent, creating one
 * lazily if it doesn't exist yet. Idempotent — safe to call on every session
 * boot.
 */
export async function ensureDIDAgent(
  params: EnsureDIDAgentParams,
): Promise<EnsureDIDAgentResult | EnsureDIDAgentError> {
  const customLlmKey = process.env.DID_CUSTOM_LLM_KEY
  if (!customLlmKey) return { ok: false, error: "DID_CUSTOM_LLM_KEY not configured" }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not configured" }

  const supabase = createServiceClient()

  // Realism scan on the greeting — ADVISORY (§5: warnings pass through, never
  // a silent block). A contact never loses a working avatar because the agent
  // wrote "hi, i'm Jordan from Century Realty" as their opening line; it just
  // gets flagged back to the caller so Twin Studio can surface it for a redraft.
  const realismWarnings = params.greeting ? scanForAiTells(params.greeting) : []

  // ── 1. Cache hit — per twin first, then per agent ─────────────────────
  if (params.twinId) {
    const { data: twin } = await supabase
      .from("agent_avatar_assets")
      .select("did_agent_id")
      .eq("id", params.twinId)
      .maybeSingle()
    if (twin?.did_agent_id) {
      return {
        ok: true, didAgentId: twin.did_agent_id, created: false,
        presenterType: presenterTypeForTwin(params.presenterId),
        realismWarnings,
      }
    }
  } else {
    const { data: profile } = await supabase
      .from("agent_voice_profiles")
      .select("did_agent_id")
      .eq("agent_id", params.agentId)
      .maybeSingle()
    if (profile?.did_agent_id) {
      return {
        ok: true, didAgentId: profile.did_agent_id, created: false,
        presenterType: presenterTypeForTwin(params.presenterId),
        realismWarnings,
      }
    }
  }

  // ── 2. Cache miss — create the D-ID Agent ──────────────────────────────
  const body = buildAgentBody({
    agentName: params.agentName,
    presenterId: params.presenterId,
    elevenLabsVoiceId: params.elevenLabsVoiceId,
    personality: params.personality,
    appUrl, customLlmKey,
  })

  const res = await didRequest<{ id?: string }>("/agents", { method: "POST", body })

  if (!res.ok || !res.data?.id) {
    const failure = classifyDidError(res.status, res.data ?? { description: res.error })
    return { ok: false, error: failure.userMessage }
  }
  const didAgentId = res.data.id

  // ── 3. Cache the id ────────────────────────────────────────────────────
  // Twin Studio: cache on the twin row so each twin has its own D-ID Agent.
  // Legacy: cache on agent_voice_profiles for callers without a twinId.
  if (params.twinId) {
    await supabase
      .from("agent_avatar_assets")
      .update({ did_agent_id: didAgentId, updated_at: new Date().toISOString() })
      .eq("id", params.twinId)
  } else {
    await supabase
      .from("agent_voice_profiles")
      .upsert(
        { agent_id: params.agentId, did_agent_id: didAgentId },
        { onConflict: "agent_id" },
      )
  }

  return {
    ok: true, didAgentId, created: true,
    presenterType: presenterTypeForTwin(params.presenterId),
    realismWarnings,
  }
}

export interface SyncDIDAgentParams {
  didAgentId: string
  presenterId: string
  elevenLabsVoiceId?: string | null
  agentName: string
  personality?: string | null
}

export interface SyncDIDAgentResult {
  ok: boolean
  error?: string
}

/**
 * THE UPDATE HALF ensureDIDAgent never had. Owner ruling (wave 58, item 2):
 * "the D-ID agent record is created/updated autonomously when the agent's
 * twin/voice changes." Before this, ensureDIDAgent cached a D-ID Agent id
 * FOREVER on first creation — an agent who re-trained their twin's presenter,
 * cloned a new voice, or edited their personality kept talking through the
 * OLD D-ID Agent record until someone manually deleted the cache row, because
 * nothing ever called PATCH /agents/{id}. This is a plain, idempotent
 * PATCH — safe to call unconditionally (D-ID's contract, confirmed via the
 * OpenAPI mirror above: PATCH takes the SAME AgentCreateDto as POST, full
 * replace of `presenter`/`llm`/`preview_name`), so the caller never has to
 * diff old vs new first. Called from BOTH: app/api/cron/did-agent-sync (the
 * autonomous sweep — catches every write path, not just Twin Studio's own
 * button) and may be called inline by any future writer without duplicating
 * this PATCH body (§6 — buildAgentBody is shared with ensureDIDAgent's
 * create call, so create and update can never drift).
 */
export async function syncDIDAgent(params: SyncDIDAgentParams): Promise<SyncDIDAgentResult> {
  const customLlmKey = process.env.DID_CUSTOM_LLM_KEY
  if (!customLlmKey) return { ok: false, error: "DID_CUSTOM_LLM_KEY not configured" }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not configured" }

  const body = buildAgentBody({
    agentName: params.agentName,
    presenterId: params.presenterId,
    elevenLabsVoiceId: params.elevenLabsVoiceId,
    personality: params.personality,
    appUrl, customLlmKey,
  })

  const res = await didRequest(`/agents/${encodeURIComponent(params.didAgentId)}`, { method: "PATCH", body })
  if (!res.ok) {
    const failure = classifyDidError(res.status, res.data ?? { description: res.error })
    // A 404 here means the cached did_agent_id no longer exists on D-ID's
    // side (deleted out of band) — the caller's job is to notice this and
    // clear the cache so the NEXT ensureDIDAgent re-creates rather than
    // patching a ghost forever; reported as a distinguishable error string
    // rather than swallowed.
    return { ok: false, error: res.status === 404 ? "NOT_FOUND" : failure.userMessage }
  }
  return { ok: true }
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
  const res = await didRequest<{ client_key?: string; expires_in?: number }>(
    "/agents/client-key",
    { method: "POST", body: { agent_id: params.didAgentId, allowed_origins: params.allowedOrigins }, withExternalKey: false },
  )

  if (!res.ok || !res.data?.client_key) {
    const failure = classifyDidError(res.status, res.data ?? { description: res.error })
    return { ok: false, error: failure.userMessage }
  }

  return {
    ok: true,
    clientKey: res.data.client_key,
    expiresIn: res.data.expires_in,
  }
}
