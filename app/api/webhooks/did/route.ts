/**
 * app/api/webhooks/did/route.ts
 *
 * D-ID COMPLETION WEBHOOK — the avatar loop stops depending on a clock.
 *
 * Until now the ONLY way this OS learned an avatar had finished was the
 * poll-did-avatars cron, every 3 minutes. An agent who has just recorded
 * themselves reading a passcode on camera sits on a spinner for up to three
 * minutes after the work is already done, and the cron burns a provider call
 * per pending row per tick whether or not anything changed. D-ID accepts a
 * `webhook` on the creation call for exactly this; nothing was ever passing one.
 *
 * ── VERIFICATION: D-ID PUBLISHES NO SIGNATURE, AND WE DO NOT PRETEND ────────
 * Their reference documents `webhook` as a URI and nothing else; the
 * securitySchemes block covers only calling D-ID (basic/bearer/client-key), the
 * /docs/webhooks page is empty and /reference/webhooks does not resolve. There
 * is no HMAC header to check. So this uses the shared-secret-in-the-URL pattern
 * that sendgrid-events, lob-events and twilio-sms-status already use here —
 * secret unset means 404, never a silently-open endpoint — and treats the body
 * as an IDENTIFIER, not as authority: the payload can only tell us which of OUR
 * rows finished, and an id that matches nothing is ignored. See lib/did/webhook.ts.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * There is no delivery-once guarantee, the cron still runs as a fallback, and a
 * non-2xx makes D-ID retry. applyAvatarOutcome re-reads the row and refuses to
 * act on one that already reached ready/failed, so a redelivery (or a cron tick
 * that raced this) changes nothing and never doubles the agent's notification.
 *
 * ── SCOPE, STATED ──────────────────────────────────────────────────────────
 * This handles the AVATAR family only. Video renders (/talks, /clips,
 * /expressives) still complete on poll-did-videos, because that path does far
 * more than record a status — it re-hosts the mp4, burns the brokerage overlay
 * with ffmpeg and hands off to Remotion — and duplicating that pipeline into a
 * second entry point is precisely the drift this codebase keeps paying for. A
 * video payload is acknowledged and ignored, out loud, rather than half-handled.
 *
 * ALWAYS ACKS 2xx once the secret checks out: a retry storm on one unparseable
 * body would bury every other completion behind it.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { parseDidWebhook, secretMatches } from "@/lib/did/webhook"
import { applyAvatarOutcome } from "@/lib/did/avatar-completion"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const secret = (process.env.DID_WEBHOOK_SECRET ?? "").trim()
  if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 })
  const given =
    request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-webhook-secret")
  if (!secretMatches(given, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable body" })
  }

  const event = parseDidWebhook(body)
  if (!event.jobId && !event.assetId) {
    return NextResponse.json({ ok: true, ignored: "no job id or user_data correlation" })
  }
  if (!event.status) {
    return NextResponse.json({ ok: true, ignored: "no status", job_id: event.jobId })
  }

  // The video lane is not handled here — see the scope note above.
  if (!event.isAvatar) {
    return NextResponse.json({
      ok: true,
      ignored: "not an avatar payload; video renders complete on poll-did-videos",
      job_id: event.jobId,
      object: event.objectType,
    })
  }

  const supabase = createServiceClient()

  // CORRELATION, in the order of how much we trust it.
  //
  // user_data first: it is the field D-ID designed for this, we set it to
  // `asset:<uuid>` at submit, and it is echoed back verbatim — so it names OUR
  // row directly with no lookup to get wrong. did_avatar_id is the fallback for
  // jobs submitted before the correlation existed, and it is a lookup rather
  // than a claim: an id that matches no row of ours is ignored, which is what
  // makes an unsigned webhook safe to accept.
  let assetId = event.assetId
  if (assetId) {
    const { data: owned } = await supabase
      .from("agent_avatar_assets").select("id").eq("id", assetId).maybeSingle()
    if (!owned) assetId = null
  }
  if (!assetId && event.jobId) {
    const { data: byJob } = await supabase
      .from("agent_avatar_assets").select("id").eq("did_avatar_id", event.jobId).maybeSingle()
    assetId = (byJob?.id as string | undefined) ?? null
  }

  if (!assetId) {
    // A job this OS did not create (a D-ID console test, another environment on
    // the same account). Inventing a row for it would be worse than ignoring it.
    return NextResponse.json({ ok: true, ignored: "no matching avatar asset", job_id: event.jobId })
  }

  try {
    const result = await applyAvatarOutcome(supabase, assetId, body as any)
    if (result.operatorMessage) {
      console.error(`[did-webhook] ${assetId} failed: ${result.operatorMessage}`)
    }
    return NextResponse.json({
      ok: true,
      asset_id: assetId,
      job_id: event.jobId,
      status: event.status,
      outcome: result.outcome,
      applied: result.applied,
      ...(result.reason ? { reason: result.reason } : {}),
    })
  } catch (err: any) {
    // A 500 makes D-ID retry, which is what we want for a genuine write failure
    // — the poll cron is the second net, not the first.
    console.error("[did-webhook] apply failed:", err?.message ?? err)
    return NextResponse.json({ error: "apply failed" }, { status: 500 })
  }
}
