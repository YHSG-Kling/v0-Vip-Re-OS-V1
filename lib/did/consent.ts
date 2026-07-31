// lib/did/consent.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CONSENT STEP THAT AVATAR CREATION CANNOT SKIP.
//
// A V3 Instant Avatar — the "build my twin from a short video" flow this OS
// sells — REQUIRES a recorded consent statement. Not a checkbox: D-ID mints a
// short random passcode, the agent must say it aloud on camera, and D-ID then
// runs three checks before the avatar is allowed to exist:
//
//   · transcription — what was said matches the script, including the passcode;
//   · face recognition — the face in the consent matches the avatar footage;
//   · voice verification — the voice in the consent matches the footage.
//
// We had NONE of it. create-avatar posted a source_url with no consent_id, so
// every video-sourced twin was being submitted without the one thing the
// endpoint exists to require. That is the whole avatar loop, open at the front.
//
// ── TWO RULES THAT SHAPE THIS FILE ──────────────────────────────────────────
// THE CONSENT MUST BE RECORDED, NOT UPLOADED. D-ID is explicit that webcam
// capture is required and file upload is not allowed, "for security reasons" —
// the point is to prove a live human said the passcode, and an uploaded file
// proves nothing. So the capture surface deliberately offers no file picker,
// unlike the avatar-footage step next to it.
//
// CONSENT IS REUSABLE, AND SHOULD BE REUSED. Once verified it is saved against
// the account and can back any number of future avatars. Re-prompting an agent
// to perform a passcode on camera every time they re-record a twin would be a
// self-inflicted wound, so the resolver returns an existing verified consent
// before it ever mints a new one.
//
// Transcribed from the D-ID reference (POST /consents, POST /consents/{id}/video,
// GET /consents/{id}) plus their published consent-process article.

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { classifyDidError, consentRequiredFor, type DidFailure, type ConsentLanguage } from "./contract"

// The pure half lives in ./contract so client components and guards can read it
// without importing this server-only module.
export {
  CONSENT_LANGUAGES, normalizeConsentLanguage, consentRequiredFor, CONSENT_INSTRUCTIONS,
} from "./contract"
export type { ConsentLanguage } from "./contract"

const DID_BASE = "https://api.d-id.com"

function didKey(): string {
  const key = process.env.DID_API_KEY
  if (!key) throw new Error("DID_API_KEY is not configured")
  return key
}


export interface MintedConsent {
  ok: true
  consentId: string
  /**
   * The passcode the agent must READ ALOUD. D-ID documents it as "a random text
   * with 3 words"; it is the anti-replay half of the check, so it has to reach
   * the screen verbatim — paraphrasing it fails the transcription step.
   */
  consentText: string
  createdAt: string | null
}

export type ConsentResult = MintedConsent | { ok: false; failure: DidFailure }

/**
 * Mint a consent and get the passcode to display.
 *
 * Cheap and idempotent-ish from our side: a consent that is never completed
 * simply expires unused, so minting one per attempt is safe.
 */
export async function mintConsent(language: ConsentLanguage = "english"): Promise<ConsentResult> {
  try {
    const res = await callConnector<{ id?: string; text?: string; created_at?: string }>({
      connector: "did", baseUrl: DID_BASE, path: "/consents", method: "POST",
      auth: { style: "basic", username: didKey(), password: "" },
      body: { language },
    })
    if (!res.ok || !res.data?.id || !res.data?.text) {
      return { ok: false, failure: classifyDidError(res.status ?? null, res.data ?? { description: res.error }) }
    }
    return { ok: true, consentId: res.data.id, consentText: res.data.text, createdAt: res.data.created_at ?? null }
  } catch (e) {
    return { ok: false, failure: classifyDidError(null, { description: e instanceof Error ? e.message : String(e) }) }
  }
}

export interface ConsentVerifyResult {
  ok: boolean
  /** Set when D-ID rejected the recording. */
  failure?: DidFailure
}

/**
 * Submit the recorded consent video for verification.
 *
 * The documented failure here is ConsentTextSimilarityError — the agent did not
 * say the passcode closely enough. That gets its own message because it is the
 * one failure the agent can fix immediately by recording again, and telling
 * them "consent failed" would send them looking for a settings problem that
 * does not exist.
 */
export async function uploadConsentVideo(
  consentId: string, sourceUrl: string,
): Promise<ConsentVerifyResult> {
  try {
    const res = await callConnector<Record<string, unknown>>({
      connector: "did", baseUrl: DID_BASE, path: `/consents/${encodeURIComponent(consentId)}/video`,
      method: "POST",
      auth: { style: "basic", username: didKey(), password: "" },
      body: { source_url: sourceUrl },
    })
    if (!res.ok) {
      const body = (res.data ?? { description: res.error }) as { kind?: unknown }
      const failure = String(body?.kind ?? "") === "ConsentTextSimilarityError"
        ? {
            ...classifyDidError(res.status ?? null, body),
            kind: "BadRequestError" as const,
            userMessage:
              "We couldn't match the passcode you read to the one on screen. " +
              "Record again and say the three words exactly as they appear, clearly and at a normal pace.",
          }
        : classifyDidError(res.status ?? null, body)
      return { ok: false, failure }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, failure: classifyDidError(null, { description: e instanceof Error ? e.message : String(e) }) }
  }
}

export interface ConsentStatus {
  ok: boolean
  exists: boolean
  /** D-ID's own status string, when it reports one. */
  status: string | null
  failure?: DidFailure
}

/** Read a consent back — used to confirm a stored consent is still good. */
export async function getConsent(consentId: string): Promise<ConsentStatus> {
  try {
    const res = await callConnector<{ status?: string }>({
      connector: "did", baseUrl: DID_BASE, path: `/consents/${encodeURIComponent(consentId)}`,
      method: "GET",
      auth: { style: "basic", username: didKey(), password: "" },
    })
    if (!res.ok) {
      const failure = classifyDidError(res.status ?? null, res.data ?? { description: res.error })
      return { ok: false, exists: res.status !== 404, status: null, failure }
    }
    return { ok: true, exists: true, status: res.data?.status ?? null }
  } catch (e) {
    return { ok: false, exists: false, status: null, failure: classifyDidError(null, { description: e instanceof Error ? e.message : String(e) }) }
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// The stored side — one verified consent per agent, reused forever
// ─────────────────────────────────────────────────────────────────────────────

type AnyClient = { from: (t: string) => any }

export interface StoredConsent {
  id: string
  didConsentId: string
  consentText: string
  status: "pending" | "verified" | "failed"
}

/**
 * The agent's VERIFIED consent, if they have one.
 *
 * D-ID saves a completed consent account-side and lets it back any number of
 * future avatars, so this is checked before anything is minted. The partial
 * unique index on status='verified' guarantees there is at most one.
 */
export async function findVerifiedConsent(
  svc: AnyClient, agentId: string,
): Promise<StoredConsent | null> {
  try {
    const { data } = await svc.from("agent_did_consents")
      .select("id, did_consent_id, consent_text, status")
      .eq("agent_id", agentId).eq("status", "verified")
      .maybeSingle()
    if (!data) return null
    return {
      id: data.id, didConsentId: data.did_consent_id,
      consentText: data.consent_text, status: "verified",
    }
  } catch { return null }
}

/**
 * The consent id to send with an avatar submission, or null.
 *
 * Null is meaningful and is NOT an error here: a photo-sourced V2 avatar does
 * not need consent at all, and a video-sourced one that has no verified consent
 * yet must be stopped by the CALLER with an instruction to record one — not
 * quietly submitted without it, which is exactly what used to happen.
 */
export async function resolveConsentIdForAvatar(
  svc: AnyClient, agentId: string, sourceType: "photo" | "video",
): Promise<string | null> {
  if (!consentRequiredFor(sourceType)) return null
  const existing = await findVerifiedConsent(svc, agentId)
  return existing?.didConsentId ?? null
}
