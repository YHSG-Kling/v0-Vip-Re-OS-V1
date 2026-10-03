/**
 * lib/did/avatar-consent-gate.ts
 *
 * THE MISSING HALF OF THE CONSENT GATE (§1.2 — wave 72D avatar/Remotion audit).
 *
 * ── THE GAP ──────────────────────────────────────────────────────────────────
 * `app/api/did/create-avatar/route.ts` refuses (428, `needs_consent: true`) to
 * mint a persistent D-ID avatar from a VIDEO source until the agent has a
 * verified `agent_did_consents` row (lib/did/consent.ts — the passcode-on-
 * camera flow D-ID itself requires for a video-sourced avatar). That row lands
 * on `agent_avatar_assets`, and `lib/video/presenter-media.ts` reads it FIRST.
 *
 * But `agent_avatar_assets` is not the only place an agent's video avatar
 * source can come from. `POST /api/agent/update-video-profile` lets an
 * authenticated agent write `agent_voice_profiles.did_video_url` directly —
 * "public URL of short agent video for D-ID /clips" — with NO consent check
 * at all (that route only validates the field shape). Every one of the
 * following reads that column as a fallback avatar source and hands it
 * straight to D-ID as the face driving a talking-head render:
 *   · lib/video/presenter-media.ts (resolveAgentPresenterMedia — the Director
 *     render worker's presenter resolver, `p?.did_video_url` fallback)
 *   · lib/providers/dispatch.ts (dispatchVideoViaDID — the ISA outreach-email
 *     avatar path, `didProfile.did_video_url ?? didProfile.did_photo_url`)
 *   · lib/kernel/anniversary-equity.ts, lib/repurpose/actions.ts,
 *     lib/video/listing-promo-reactor.ts, lib/video/intro-video-reactor.ts,
 *     lib/video/chapter-video-generator.ts, lib/video/video-identity.ts,
 *     app/actions/creative-playbooks.ts (same column, same fallback pattern).
 *
 * So an agent could set `did_video_url` through the ungated route and every
 * one of those emitters would submit a VIDEO-sourced talking avatar with no
 * passcode verification ever performed — exactly the gap
 * `app/api/did/create-avatar` exists to close, reachable through a side door.
 * The owner's ruling stands across every wave that has touched this file:
 * "the D-ID 428 consent gate is never weakened." A gate reachable through one
 * door and not the other is a weakened gate.
 *
 * ── THE FIX, AND WHY IT DOES NOT TOUCH THE FORBIDDEN FILES ──────────────────
 * This module is NEW and imports only READ functions already exported by
 * lib/did/consent.ts (`findVerifiedConsent`) — it does not modify
 * app/api/did/create-avatar/route.ts or lib/did/consent.ts's write path
 * (mintConsent / uploadConsentVideo), per the standing instruction. The two
 * CALL SITES that actually submit a video-sourced avatar to D-ID
 * (lib/did/index.ts's generateVideo — the Director/autonomous pipeline — and
 * lib/providers/dispatch.ts's dispatchVideoViaDID — the ISA outreach path)
 * call `requireConsentForVideoAvatarSource` before they submit, and refuse
 * (same 428/"needs_consent" shape create-avatar already uses) when no
 * verified consent exists for the agent. A PHOTO source (`consentRequiredFor
 * ("photo") === false`, lib/did/contract.ts:280-282) is unaffected — this
 * gate only fires for a VIDEO-shaped source URL, detected with the ONE
 * extension predicate the repo already trusts for this question
 * (lib/video/broll-url.ts::isVideoUrl — "the most a syntactic check can
 * offer", stated there and true here too).
 *
 * FAIL CLOSED (CLAUDE.md §4): an agent id we cannot resolve is treated as "no
 * consent on file," not "skip the check."
 */
import "server-only"
import { findVerifiedConsent } from "./consent"
import { isVideoUrl } from "@/lib/video/broll-url"

type AnyClient = { from: (t: string) => any }

export interface VideoAvatarConsentRefusal {
  kind: "ConsentRequired"
  status: 428
  needsConsent: true
  message: string
}

export type VideoAvatarConsentCheck =
  | { ok: true }
  | { ok: false; refusal: VideoAvatarConsentRefusal }

const NO_CONSENT_MESSAGE =
  "This agent's avatar source is a recorded video clip, and D-ID requires a " +
  "verified on-camera consent statement (the three-word passcode read aloud) " +
  "before a video can be used to drive a talking avatar. Record consent in " +
  "Settings → Voice & Avatar, or switch to a photo-sourced avatar."

const NO_IDENTITY_MESSAGE =
  "Video-sourced avatar render refused — no agent identity was available to " +
  "check consent against. Fail-closed: an unverifiable consent state is " +
  "treated as unconsented, never as consented."

/**
 * Gate a talking-avatar submission whose source is a VIDEO url. Returns
 * `{ok:true}` immediately for a photo/non-video source (no consent
 * requirement — consentRequiredFor("photo") is false) or a resolved D-ID
 * `actorId`/V4 `avatar_id` path (those already went through
 * app/api/did/create-avatar's own gate when the avatar was minted).
 *
 * `sourceUrl` is the resolved avatar source URL the caller is about to hand
 * D-ID (never the raw column — callers already merge did_video_url /
 * did_photo_url before this point, so this function never re-derives which
 * column won; it only asks "does THIS url look like a video").
 */
export async function requireConsentForVideoAvatarSource(
  svc: AnyClient,
  agentId: string | null,
  sourceUrl: string | null | undefined,
): Promise<VideoAvatarConsentCheck> {
  if (!sourceUrl || !isVideoUrl(sourceUrl)) return { ok: true }

  if (!agentId) {
    return {
      ok: false,
      refusal: { kind: "ConsentRequired", status: 428, needsConsent: true, message: NO_IDENTITY_MESSAGE },
    }
  }

  const consent = await findVerifiedConsent(svc, agentId)
  if (!consent) {
    return {
      ok: false,
      refusal: { kind: "ConsentRequired", status: 428, needsConsent: true, message: NO_CONSENT_MESSAGE },
    }
  }
  return { ok: true }
}
