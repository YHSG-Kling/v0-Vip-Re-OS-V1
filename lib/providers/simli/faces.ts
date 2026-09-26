/**
 * lib/providers/simli/faces.ts
 *
 * ensureSimliFaceForAgent — creates/looks up the agent's Simli `faceId` from
 * their ALREADY-CONSENTED D-ID twin source image. NEVER a fresh likeness
 * without the consent row (wave 62 lane brief, verbatim: "read how
 * create-avatar records consent and gate on that row; no consent → no Simli
 * face, return a typed refusal").
 *
 * THE CONSENT GATE IS REUSED, NOT RE-IMPLEMENTED (§1/§6). app/api/did/
 * create-avatar/route.ts's own consent step (lib/did/consent.ts —
 * `agent_did_consents`, one verified row per agent, checked via
 * `findVerifiedConsent`) is the ONE place this OS records that an agent
 * agreed to their own face/voice backing generated video. A Simli twin is
 * still that same agent's likeness driving generated video — it needs the
 * SAME proof, not a second, weaker bar this file invents. This module NEVER
 * touches app/api/did/create-avatar or lib/did/consent.ts's write path — it
 * only READS findVerifiedConsent, exactly as create-avatar's own
 * resolveConsentIdForAvatar does.
 *
 * THE SOURCE IMAGE: agent_avatar_assets.avatar_url — the self-hosted still
 * D-ID's own webhook renders from the twin (lib/did/avatar-completion.ts
 * pickAvatarImageUrl: "the good asset", high-res-first), the same row
 * did_agent_id/did_avatar_id already live on. simli_face_id is cached
 * alongside them there (migration m627, applied live 2026-09-14) rather than on
 * a new table — §1: one twin/profile row per agent, not a second identity
 * table per provider.
 *
 * THE FACE-CREATION CONTRACT (docs.simli.com/api-reference, fetched by the
 * integrator 2026-09-14 — transcribed, not memory; lane 62A's first draft
 * posted to a guessed "/textToFace" and recorded that as UNRESOLVED):
 *   POST https://api.simli.ai/faces/trinity?face_name=<name>&gsVersion=GSA_1.0
 *     header: x-simli-api-key   body: multipart/form-data { image: <binary> }
 *     (JPEG/PNG/WEBP < 5 MB, ≥ 512×512, one camera-facing head ≥ 15 % of the
 *     image height — the /faces/trinity/preprocess endpoint reframes a portrait
 *     to that framing and is NOT called here: the twin's D-ID still is already
 *     a centred head-and-shoulders render.)
 *   GET  https://api.simli.ai/faces/trinity/generation_status?face_id=<id>
 *   Generation is ASYNC — Simli's own "Create Avatar" page says it "can take a
 *   couple of hours". The legacy POST /faces/legacy (ex-/generateFaceID) is
 *   marked deprecated in the spec and is not used. Both endpoints' 200 bodies
 *   are `schema: {}` in the spec (undocumented), so the face id is read from
 *   the first present of face_id / faceId / id / character_uid and a body with
 *   none of them is a typed ProviderError — never a fabricated id.
 *
 * ASYNC CONSEQUENCE: a face minted THIS call is not renderable THIS call.
 * `created: true` tells lib/live-agent/face-render.ts's Simli adapter to fall
 * through to the same-brain text chat for this session (the cached
 * simli_face_id serves the next one) rather than mint a session token on a
 * face Simli would reject with startup_error.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { findVerifiedConsent } from "@/lib/did/consent"
import { SIMLI_BASE } from "./client"

type Svc = ReturnType<typeof createServiceClient>

export interface EnsureSimliFaceResult {
  ok: true
  faceId: string
  /** true = the face was ENQUEUED on this call and is still generating
   *  (see the ASYNC CONSEQUENCE note in the file header) — not yet usable for
   *  a session token. false = cached, generated earlier. */
  created: boolean
}

export interface EnsureSimliFaceRefusal {
  ok: false
  /** Typed so a caller (the session-route fail-over branch, the proof
   *  script) can tell "not configured" from "no consent" from "no image yet"
   *  from a genuine provider error, instead of one opaque string. */
  kind: "NotConfigured" | "ConsentRequired" | "NoTwinImage" | "ProviderError"
  error: string
}

/**
 * Returns the cached Simli faceId for this agent's default twin, minting one
 * lazily from the twin's already-rendered avatar image if it doesn't exist
 * yet. Idempotent — safe to call on every fail-over attempt, same contract as
 * lib/did/agents.ts::ensureDIDAgent.
 *
 * Refuses (never throws) when: Simli isn't configured, the agent has no
 * verified D-ID consent on file, or the agent has no twin image yet — each a
 * distinct, actionable reason rather than a single 502.
 */
export async function ensureSimliFaceForAgent(
  agentId: string,
  svc: Svc = createServiceClient(),
): Promise<EnsureSimliFaceResult | EnsureSimliFaceRefusal> {
  const key = (process.env.SIMLI_API_KEY ?? "").trim()
  if (!key) return { ok: false, kind: "NotConfigured", error: "SIMLI_API_KEY not configured" }

  // ── CONSENT GATE — reused, see file header ────────────────────────────────
  const consent = await findVerifiedConsent(svc, agentId)
  if (!consent) {
    return {
      ok: false,
      kind: "ConsentRequired",
      error:
        "This agent has no verified D-ID consent on file — a Simli face " +
        "cannot be created without the same recorded consent the video twin requires.",
    }
  }

  const { data: twin } = await svc
    .from("agent_avatar_assets")
    .select("id, simli_face_id, avatar_url, thumbnail_url, source_url, source_type")
    .eq("agent_id", agentId)
    .eq("is_default", true)
    .maybeSingle()

  // ── Cache hit ──────────────────────────────────────────────────────────
  if (twin?.simli_face_id) {
    return { ok: true, faceId: twin.simli_face_id, created: false }
  }

  // ── ONE IMAGE. avatar_url/thumbnail_url are D-ID's own rendered still —
  // the best single photo on file for ANY twin (video- or photo-sourced).
  // A photo-sourced twin's raw source_url is a fallback for a twin whose
  // D-ID render hasn't completed yet; a VIDEO source_url is never used here
  // — Simli's custom-face intake documented to this lane is one still image,
  // and a video URL is not that. ──────────────────────────────────────────
  const imageUrl =
    twin?.avatar_url ?? twin?.thumbnail_url ?? (twin?.source_type === "photo" ? twin?.source_url ?? null : null)

  if (!twin || !imageUrl) {
    return {
      ok: false,
      kind: "NoTwinImage",
      error: "This agent has no ready twin image yet — Simli needs the same photo the D-ID twin already rendered.",
    }
  }

  // ── Create the Simli face — POST /faces/trinity, multipart image ─────────
  // The bytes come from OUR bucket (the twin's re-hosted still), so this
  // download is a same-tenant storage read, not vendor egress; the only
  // api.simli.ai call is the callConnector below (the one gateway).
  let imageBlob: Blob
  try {
    const dl = await fetch(imageUrl)
    if (!dl.ok) {
      return { ok: false, kind: "NoTwinImage", error: `Twin image could not be read (HTTP ${dl.status})` }
    }
    const bytes = await dl.arrayBuffer()
    if (bytes.byteLength === 0) {
      return { ok: false, kind: "NoTwinImage", error: "Twin image is empty" }
    }
    imageBlob = new Blob([bytes], { type: dl.headers.get("content-type") ?? "image/jpeg" })
  } catch (e) {
    return { ok: false, kind: "NoTwinImage", error: `Twin image download failed: ${(e as Error).message}` }
  }

  const form = new FormData()
  form.append("image", imageBlob, `twin-${twin.id}.jpg`)

  const res = await callConnector<{ face_id?: string; faceId?: string; id?: string; character_uid?: string }>({
    connector: "simli",
    baseUrl: SIMLI_BASE,
    path: "/faces/trinity",
    method: "POST",
    query: { face_name: `agent-${agentId}`, gsVersion: "GSA_1.0" },
    auth: { style: "header", name: "x-simli-api-key", value: key },
    body: form,
    bodyType: "multipart",
  })
  const faceId = res.data?.face_id ?? res.data?.faceId ?? res.data?.id ?? res.data?.character_uid ?? null
  if (!res.ok || !faceId) {
    return { ok: false, kind: "ProviderError", error: res.error ?? `Simli face creation failed (HTTP ${res.status ?? "?"})` }
  }

  await svc
    .from("agent_avatar_assets")
    .update({ simli_face_id: faceId, updated_at: new Date().toISOString() })
    .eq("id", twin.id)

  return { ok: true, faceId, created: true }
}
