import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, validateTwilioSignature } from "@/lib/voice/twilio-voice"
import { parseRecordingCallback } from "@/lib/voice/call-recording"

export const dynamic = "force-dynamic"

/**
 * TWILIO VOICE — RECORDING STATUS CALLBACK. THE WRITER of
 * `voice_calls.recording_url`.
 *
 * Before this route the column had no writer anywhere in the repo while seven
 * UI surfaces read it and rendered a player — real markup over a column that
 * could not fill. Twilio posts here when a recording finishes (armed at dial
 * time by lib/voice/twilio-outbound.ts for outbound legs, and on the live call
 * by lib/voice/call-recording.ts:startCallRecording for inbound legs), and this
 * handler puts the media URL on the matching ledger row.
 *
 * WHAT IS STORED: the VENDOR URL (api.twilio.com/.../Recordings/<Sid>.mp3),
 * because that is what app/actions/ai-voice-transcription.ts must fetch and what
 * lib/security/audio-source-allowlist.ts rule 3 admits. It is NOT what the
 * browser plays — that media is behind HTTP Basic auth, so the UI plays the
 * authenticated same-origin proxy at /api/voice/recording/[callId] instead.
 *
 * SECURITY: X-Twilio-Signature is validated against the OWNING TENANT's auth
 * token, resolved from the To/From numbers exactly as the status callback does.
 * An unsigned or wrongly-signed post is refused with 403 — this endpoint writes
 * a URL that a later server-side fetch dereferences, so it is not a place to be
 * relaxed about provenance. The RecordingUrl itself is additionally checked
 * against the audio-source allowlist inside parseRecordingCallback.
 *
 * REFUSALS ARE SPOKEN, NOT SWALLOWED. supabase-js RESOLVES a rejected write, so
 * `await svc.from(...).update(...)` alone would report success for a write RLS
 * refused. Every read and write below destructures `error` and logs it; a
 * recording that fails to land says so in the log rather than leaving an
 * operator to wonder why a player is missing.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const svc = createServiceClient()
  const to = params.To ?? ""
  const from = params.From ?? ""
  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twilio/recording`
  const signature = request.headers.get("x-twilio-signature")

  // The tenant owns either end of the leg (To on inbound, From on outbound) —
  // the same resolution order /api/voice/twilio/status uses.
  const ctx = (await resolveInboundContext(svc, to)) ?? (await resolveInboundContext(svc, from))
  if (!ctx) {
    console.warn(
      `[voice/recording] no tenant matched To=${to || "—"} / From=${from || "—"} — recording callback for CallSid ${params.CallSid ?? "—"} DROPPED (recording_url not written)`,
    )
    return NextResponse.json({ ok: true, unmatched: true })
  }
  if (!validateTwilioSignature(ctx.authToken, url, params, signature)) {
    console.warn(`[voice/recording] invalid X-Twilio-Signature for CallSid ${params.CallSid ?? "—"} — refused`)
    return new NextResponse("invalid signature", { status: 403 })
  }

  const parsed = parseRecordingCallback(params)
  if (!parsed.ok) {
    // "absent" and non-terminal statuses land here too. They are NOT errors, but
    // they ARE the reason a call ends up with no player, so they are logged
    // rather than returning a silent 200 that looks like success.
    console.warn(`[voice/recording] nothing stored for CallSid ${params.CallSid ?? "—"}: ${parsed.reason}`)
    return NextResponse.json({ ok: true, stored: false, reason: parsed.reason })
  }

  // Only ever fills a row that is genuinely empty AND belongs to this tenant.
  // `.is("recording_url", null)` makes a re-posted callback idempotent instead
  // of letting a retry overwrite a recording already in hand.
  const { data: updated, error: updErr } = await svc
    .from("voice_calls")
    .update({ recording_url: parsed.recordingUrl })
    .eq("vendor_call_id", parsed.callSid)
    .eq("brokerage_id", ctx.brokerageId)
    .is("recording_url", null)
    .select("id")

  if (updErr) {
    console.error(
      `[voice/recording] WRITE REFUSED for CallSid ${parsed.callSid} (recording ${parsed.recordingSid || "—"}): ${updErr.message} — the recording exists at Twilio but voice_calls.recording_url was NOT written`,
    )
    return NextResponse.json({ ok: false, stored: false, error: updErr.message }, { status: 200 })
  }

  const rows = (updated ?? []) as Array<{ id: string }>
  if (rows.length === 0) {
    console.warn(
      `[voice/recording] no open voice_calls row for CallSid ${parsed.callSid} in brokerage ${ctx.brokerageId} — either the ledger row is missing or recording_url was already set (idempotent re-post)`,
    )
    return NextResponse.json({ ok: true, stored: false, reason: "no matching row with an empty recording_url" })
  }

  console.log(
    `[voice/recording] stored recording ${parsed.recordingSid || "—"} (${parsed.durationSeconds ?? "?"}s) on voice_call ${rows[0].id}`,
  )
  return NextResponse.json({ ok: true, stored: true, voiceCallId: rows[0].id })
}
