"use server"

/**
 * EXTERNAL SERVICES (thin wrappers)
 * All API calls are delegated to lib/providers/*.
 * This file preserves existing function signatures for backward compatibility.
 */

import { callConnector } from "@/lib/agentic-os/connector-gateway"


// ─── AVATAR / EXPLAINER VIDEO ─────────────────────────────────────────────────
// BUSINESS RULE (platform-locked): the avatar/explainer-video engine is D-ID +
// ElevenLabs ONLY — HeyGen is NOT used and there is no HeyGen branch here.
// These were generateHeyGenVideo / getHeyGenVideoStatus until the l39 rename:
// the names outlived the vendor, so the code read as if the platform still paid
// HeyGen while every render went to api.d-id.com. `avatarId` is a D-ID
// source/actor reference, `voiceId` an ElevenLabs voice id. Brokerage scoping is
// resolved from the caller's session.
const DID_API_BASE = "https://api.d-id.com"

// ─── THE TWO SURVIVING EXPORTS ARE NOW GATED ─────────────────────────────────
// The tombstone below records, as its own reason for deleting three exports,
// that "this file is 'use server', so every export is a publicly reachable
// endpoint, and the file has no authentication anywhere in it — no
// getAgentContext, no auth.getUser, no session read." That was true of the two
// exports it KEPT as well, and it stayed true afterwards: an unauthenticated
// caller could spend the platform's D-ID and ElevenLabs budget by POSTing a
// script, and `generateAvatarVideo` took `brokerageId` FROM THE BODY — §4's
// named IDOR shape, on the tenant the render is metered against.
//
// The storage lane then made the second one sharper still: `getAvatarVideoStatus`
// now downloads the finished render and writes it into a Supabase bucket with a
// SERVICE client, so what was an ungated read became an ungated service-client
// write. That is the point at which the pre-existing gap stopped being
// inherited and started being newly load-bearing, so it is closed here rather
// than carried.
//
// Both callers already run inside a session (the Twin/education editor and
// app/actions/video-generation.ts), so the gate costs them nothing. The tenant
// is derived from that session and the body's `brokerageId` is GONE from the
// signature — a parameter that must be ignored is worse than one that does not
// exist, because the next caller will pass it and believe it.
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function generateAvatarVideo(params: {
  avatarId: string
  voiceId: string
  script: string
  contactId?: string
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Not authenticated" }
  }

  const didApiKey = process.env.DID_API_KEY
  const elApiKey = process.env.ELEVENLABS_API_KEY

  if (!didApiKey || !elApiKey) {
    return {
      success: false,
      error: "Video provider (D-ID + ElevenLabs) not configured. Add DID_API_KEY and ELEVENLABS_API_KEY to environment variables.",
      requiresConfiguration: true,
    }
  }

  try {
    const { generateVideo } = await import("@/lib/did")
    const result = await generateVideo({
      script: params.script,
      voiceId: params.voiceId || undefined,
      // avatarId resolves to a D-ID actor (persistent avatar) or null source.
      actorId: params.avatarId || null,
      // FROM THE SESSION, never the body (§4). This is the tenant the D-ID and
      // ElevenLabs spend is metered against.
      brokerageId: ctx.brokerageId ?? "",
    })

    if (result.status === "error") {
      return { success: false, error: result.note ?? "D-ID render failed" }
    }
    // videoId is the D-ID talk/clip id used for downstream status polling.
    return { success: true, videoId: result.videoId, status: result.status === "done" ? "completed" : "processing" }
  } catch (error: any) {
    console.error("[External Services] D-ID video error:", error)
    return { success: false, error: error.message }
  }
}

export async function getAvatarVideoStatus(videoId: string) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Not authenticated" }
  }

  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) {
    return { success: false, error: "D-ID API key not configured" }
  }

  // This file is "use server", so `videoId` arrives straight off the network and
  // is interpolated into a URL path below and into an object path further down.
  // Neither may carry a `/` or a `..` (CLAUDE.md §4 — every export here is a
  // public endpoint).
  const safeId = videoId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)
  if (!safeId) {
    return { success: false, error: "Invalid video id" }
  }

  // Poll D-ID /talks/{id}. Clip jobs also resolve through the same id space; the
  // poll-did-videos cron is the canonical async finalizer — this is the sync read.
  const response = await callConnector<{ status?: string; result_url?: string }>({
    connector: "did",
    baseUrl: DID_API_BASE,
    path: `/talks/${safeId}`,
    method: "GET",
    auth: { style: "basic", username: didApiKey, password: "" },
  })

  if (!response.ok || !response.data) {
    return { success: false, error: response.error ?? "D-ID status error" }
  }
  let status = response.data.status === "done" ? "completed" : response.data.status === "error" ? "failed" : "processing"
  let videoUrl: string | undefined = undefined

  // ── THE URL THIS RETURNS IS PERSISTED, SO IT MUST BE OURS ──────────────────
  // This used to be `videoUrl: response.data.result_url` — D-ID's own signed
  // URL, which expires in ~24-48h. Its one caller,
  // app/components/features/education/EducationEditor.tsx, polls until
  // status === "completed", puts that string in state, and `handleSaveVideo`
  // writes it through createResourceAction into the education resource's
  // `content` column — permanently. So the education library filled up with
  // rows whose video link was dead within two days, and nothing anywhere
  // reported a failure, because at save time the link worked.
  //
  // Owner ruling: "the storage of files, images, videos, etc. are to be stored
  // on supabase buckets." The bytes are pulled and re-hosted here, through the
  // one media host (lib/remotion/media-host.ts#hostRenderedMedia → the
  // sanctioned issuer), and the BUCKET URL is what leaves this function.
  //
  // FAIL CLOSED, never a vendor fallback: if the re-host does not succeed the
  // answer stays "processing" rather than "completed", so the caller keeps
  // polling (and eventually times out loudly) instead of saving a link that
  // rots. This is the same ruling lib/did/index.ts and
  // app/api/cron/poll-did-videos apply at their own completion points.
  if (status === "completed") {
    // Not yet completed as far as this caller is concerned until the bytes are
    // OURS. Every arm below that cannot host leaves status at "processing" and
    // videoUrl undefined, so the poller asks again rather than saving a link.
    status = "processing"
    const didUrl = response.data.result_url
    if (didUrl) {
      try {
        const dl = await callConnector<Buffer>({
          connector: "asset-download", baseUrl: "", path: "", url: didUrl,
          method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 60_000,
        })
        if (dl.ok && dl.data) {
          const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
          const { createServiceClient } = await import("@/lib/supabase/service")
          videoUrl = await hostRenderedMedia(
            createServiceClient(),
            `education-video/${safeId}.mp4`,
            dl.data,
            "video/mp4",
          )
          status = "completed"
        } else {
          console.error(`[External Services] D-ID result download failed for ${safeId}: ${dl.error ?? `status ${dl.status}`}`)
        }
      } catch (e: any) {
        // hostRenderedMedia THROWS on a storage refusal — the Vercel Blob
        // fallback that used to swallow exactly this is retired.
        console.error("[External Services] D-ID re-host failed:", e?.message ?? e)
      }
    }
  }

  return { success: true, status, videoUrl }
}

// ─── THREE PUBLIC ENDPOINTS REMOVED — sendTwilioSMS / sendSendGridEmail /
//     createStripeTransfer ─────────────────────────────────────────────────────
//
// COMPARED AGAINST THEIR SURVIVORS FIRST, capability by capability. Nothing was
// dropped on a "no caller" rationale; what each one carried is accounted for
// below.
//
// WHY THEY HAD TO GO AT ALL. This file is "use server", so every export is a
// publicly reachable endpoint, and the file has no authentication anywhere in
// it — no getAgentContext, no auth.getUser, no session read. These three also
// had no caller in the product; they were backward-compat shims (see the header)
// for callers that no longer exist. createStripeTransfer was the sharp one: a
// passthrough taking `amount` and `destinationAccountId` FROM THE CALLER, with
// no gate at all — an unauthenticated endpoint that moves money to an arbitrary
// Stripe account.
//
// ── createStripeTransfer → lib/providers/payment.ts::createTransfer
//    Body was literally `return await createTransfer(params)`. Nothing to merge.
//
// ── sendSendGridEmail → lib/providers/dispatch.ts::dispatchEmail
//    Its one apparent extra was resolving the outbound sender before delegating.
//    REDUNDANT, established from the survivor's own contract rather than by
//    inspection: DispatchEmailParams.from is optional BY DESIGN — "undefined
//    means resolve it downstream, and sendEmail then walks the tenant credential
//    / platform env cascade and REFUSES if neither yields a real address." The
//    shim computed that same value one layer earlier and, via
//    formatSenderOrUndefined, produced `undefined` in exactly the case where the
//    survivor refuses. Same outcome, earlier. Nothing to merge.
//
// ── sendTwilioSMS → lib/providers/dispatch.ts::dispatchSms
//    dispatchSms IS the gate (autonomy, suppression, DNC, quiet hours, opt-out,
//    de-confliction). The shim added only the brokerageId resolution below.
//
// ── resolveBrokerageId — THE ONE REAL CAPABILITY THE SURVIVOR LACKS, AND THE
//    ONE THING THAT WAS DELIBERATELY *NOT* PORTED AS WRITTEN.
//
//    DispatchActorContext declares `brokerageId: string` "(always required)", so
//    deriving the tenant from contacts.brokerage_id when the caller has only a
//    contactId is genuinely something dispatch cannot do. That much is worth
//    having. The implementation was not: it returned "" on EVERY failure path —
//    no contactId, refused read, missing row, thrown error — and handed that ""
//    to the compliance gate as the tenant.
//
//    That is not a lost convenience, it is a compliance bypass.
//    checkSuppression scopes the suppression list with
//    `.eq('brokerage_id', params.brokerageId)` on a uuid column, so "" raises
//    22P02, and that read did not destructure its error: the failure became null
//    rows and the function returned { suppressed: false }. It FAILED OPEN, on
//    precisely the gate dispatch documents as the one that catches LIST-ONLY
//    suppressions the contact-flag gate misses.
//
//    So the class was fixed at the gate instead of the convenience being moved:
//    lib/kernel/compliance/check-suppression.ts now destructures both of its
//    reads and refuses to send when it cannot read consent. No future caller can
//    reproduce this by passing a blank or unresolvable tenant. If a caller ever
//    genuinely needs contact-derived tenancy, it belongs on the dispatch lane as
//    a resolver that returns null and forces a refusal — never "".
//
// generateAvatarVideo and getAvatarVideoStatus REMAIN — they have real consumers
// (EducationEditor, video-generation, create-video-project) and are untouched.
