import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { checkAudioSourceUrl, platformAudioHostRules } from "@/lib/security/audio-source-allowlist"
// THE tenant roster, defined once — see the tombstone on SUPERVISORY_ROLES.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

/**
 * CALL RECORDING PLAYBACK — the authenticated, tenant-scoped streaming proxy
 * every recording player in the app plays through.
 *
 * ── WHY A PROXY AND NOT THE STORED URL ───────────────────────────────────────
 * `voice_calls.recording_url` holds the VENDOR URL
 * (api.twilio.com/2010-04-01/Accounts/<AccountSid>/Recordings/<Sid>.mp3), which
 * is correct for the column: it is what the audio-source allowlist admits and
 * what app/actions/ai-voice-transcription.ts must fetch. But Twilio serves
 * recording media behind HTTP BASIC AUTH. A browser `<audio src>` pointed at it
 * gets 401. Handing the account SID + auth token to the browser to fix that
 * would publish tenant telephony credentials to every agent's devtools.
 *
 * So the browser asks US for the media by voice_call id, and the server — which
 * already holds the tenant's credentials — fetches and streams it back.
 *
 * ── AUTHORIZATION ────────────────────────────────────────────────────────────
 * This endpoint hands back the audio of a real conversation with a real
 * consumer, so it is gated the same way the review page is gated:
 *   1. authenticated session (getAgentContext), else 401;
 *   2. the call must belong to the CALLER'S OWN brokerage, else 404 — the
 *      tenant boundary, and 404 rather than 403 so the endpoint cannot be used
 *      to probe which call ids exist in other tenants;
 *   3. a plain agent may only hear calls attributed to them — INCLUDING the
 *      unattributed ones, which are the brokerage's own inbound traffic and
 *      belong to nobody in particular; supervisory roles (team_lead / broker /
 *      broker_owner / admin / superadmin / compliance_officer) hear all of their
 *      brokerage's calls. This mirrors the predicate in
 *      app/dashboard/voice/review/[callId]/page.tsx, so the audio is not
 *      reachable by a role that cannot open the page it plays on.
 *
 * The stored URL is re-checked against the audio-source allowlist before it is
 * dereferenced. It was already checked at WRITE time
 * (lib/voice/call-recording.ts:parseRecordingCallback), but this is the code
 * that actually issues the request, and a column is a mutable thing — checking
 * here means no future writer, migration or backfill can turn this route into a
 * server-side fetch of an arbitrary address.
 *
 * Range requests are forwarded so `<audio>` seeking works instead of forcing a
 * full re-download per scrub.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — `SUPERVISORY_ROLES = new Set(["team_lead","broker","broker_owner",
//              "admin","superadmin","compliance_officer"])`
// ═══════════════════════════════════════════════════════════════════════════
// DELETED as a LITERAL (§6, 2026-09-04, lane ROSTER). The owner's 2026-09-04
// ruling ("there is a compliance officer for tenant staff which was not
// included") added the sixth role to TENANT_ADMIN_USER_TYPES, and this list then
// asked the same question as the roster in its own words —
// test:admin-vocabulary's shape scan reported it that day, having reported zero
// the day before.
//
// ── THE SURVIVOR, AT file:line ─────────────────────────────────────────────
//     lib/auth/resolve-user-role.ts  isAdminOrBroker
//
// TWO MEMBERSHIP DIFFERENCES, both stated rather than glossed:
//   · GAINS `broker_admin`. m530 made it a storable user_type and CLAUDE.md §4
//     names it in the tenant roster; a broker admin was refused every call
//     recording in their own brokerage purely because this literal predated the
//     migration.
//   · LOSES `superadmin` AS A user_type. Measured repeatedly on
//     hrvaqgvukzxfskkcrwbt: ZERO rows carry that users.user_type, and the
//     platform's one superadmin is (user_type='admin', platform_role='superadmin')
//     — already admitted here by `admin`. This branch matched nobody, which is
//     why the roster refuses it and answers the platform question through
//     platform_role instead (isPlatformStaffIdentity).

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const { callId } = await params

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  const svc = createServiceClient()

  // supabase-js RESOLVES a refused read — without destructuring `error` a
  // "permission denied" would arrive here indistinguishable from "no such call"
  // and this route would answer 404 for a row that exists.
  const { data: call, error: callErr } = await svc
    .from("voice_calls")
    .select("id, brokerage_id, agent_id, recording_url")
    .eq("id", callId)
    .maybeSingle()

  if (callErr) {
    console.error(`[voice/recording-proxy] voice_calls read REFUSED for call ${callId}: ${callErr.message}`)
    return NextResponse.json(
      { error: "Could not read the call record", detail: callErr.message },
      { status: 500 },
    )
  }
  if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 })

  const row = call as { id: string; brokerage_id: string; agent_id: string | null; recording_url: string | null }

  // Tenant boundary — 404, not 403 (see the header).
  if (row.brokerage_id !== ctx.brokerageId) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 })
  }

  // Per-agent scoping, matching the review page's RBAC.
  //
  // The comparison is deliberately NOT guarded by `row.agent_id &&`. An
  // UNATTRIBUTED call (agent_id NULL) is the brokerage's own inbound traffic —
  // the inbound answer path stores agent_id NULL whenever the dialled number is
  // a brokerage main line rather than an agent's DID — and skipping the check
  // for those rows would let any plain agent in the tenant stream consumer
  // conversations that were never theirs. The review page has always refused
  // that case (`voiceCall.agent_id !== agentId` is TRUE when agent_id is NULL),
  // so anything looser here would make the audio reachable through a route that
  // cannot be opened through its own page.
  const canHearAll = isAdminOrBroker({ user_type: ctx.userType })
  if (!canHearAll && row.agent_id !== ctx.agentId) {
    return NextResponse.json({ error: "You can only play recordings of your own calls" }, { status: 403 })
  }

  if (!row.recording_url) {
    // The honest empty state: the call exists, there is simply no recording —
    // either the brokerage has not opted in, or the recording callback has not
    // landed yet. Never a fake 200 with an empty body a player would spin on.
    return NextResponse.json(
      { error: "No recording for this call", detail: "voice_calls.recording_url is empty" },
      { status: 404 },
    )
  }

  const verdict = checkAudioSourceUrl(row.recording_url, platformAudioHostRules())
  if (!verdict.allowed) {
    console.error(
      `[voice/recording-proxy] REFUSING to fetch recording for call ${callId}: ${verdict.reason} — ${verdict.detail}`,
    )
    return NextResponse.json({ error: "Recording source refused", detail: verdict.detail }, { status: 502 })
  }

  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, row.brokerage_id)
  if (!creds) {
    return NextResponse.json(
      { error: "Twilio is not configured for this brokerage, so its recordings cannot be played" },
      { status: 503 },
    )
  }

  // Forward Range so seeking in the <audio> element works.
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`,
  }
  const range = request.headers.get("range")
  if (range) headers.Range = range

  let upstream: Response
  try {
    upstream = await fetch(row.recording_url, { headers, cache: "no-store" })
  } catch (e: any) {
    console.error(`[voice/recording-proxy] upstream fetch threw for call ${callId}: ${e?.message ?? e}`)
    return NextResponse.json({ error: "Could not reach the recording provider" }, { status: 502 })
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.error(`[voice/recording-proxy] provider returned ${upstream.status} for call ${callId}`)
    return NextResponse.json(
      { error: `The recording provider returned ${upstream.status}` },
      { status: upstream.status === 404 ? 404 : 502 },
    )
  }

  const out = new Headers()
  out.set("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg")
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h)
    if (v) out.set(h, v)
  }
  // A call recording is consumer conversation audio — never cached by a shared
  // cache, never stored by an intermediary.
  out.set("Cache-Control", "private, no-store")

  return new NextResponse(upstream.body, { status: upstream.status, headers: out })
}
