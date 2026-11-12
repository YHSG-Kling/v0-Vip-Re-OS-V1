// app/api/cron/zoom-transcript-reconcile/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// ZOOM TRANSCRIPT RECONCILIATION SWEEP (lane Z2, 2026-09-02) — the durability
// half the webhook lane never had. app/api/webhooks/zoom/route.ts is the ONLY
// ingest for recording.transcript_completed; a delivery Zoom failed to make
// (endpoint down, secret rotated, subscription not yet activated) was simply
// lost: the calendar event stayed stamped with a meeting_id and never gained
// transcript_attached, and nothing ever went back to ask.
//
// WHAT IT DOES. Over calendar_events that carry metadata.zoom.meeting_id, whose
// start_at is at least RECONCILE_MIN_AGE_MINUTES in the past and within the
// RECONCILE_WINDOW_DAYS lookback, and that have NO metadata.zoom.transcript_attached:
// ask Zoom's recordings API for the meeting, and when a TRANSCRIPT file is
// present hand the response to processZoomRecordingEvent UNCHANGED — the same
// function the webhook calls, so the two ingest paths cannot drift (§6: one
// vocabulary, one attach, one idempotency rule).
//
// CREDENTIALS. The webhook needs none (Zoom's payload carries a short-lived
// download_token). The sweep must act AS the meeting's host: the booking lane
// stamps metadata.zoom.host_owner_type + host_owner_id (lib/ai-isa/
// appointment-scheduler.ts, lib/application/listing-lifecycle.ts) from the
// host cascade, and THIS route loads exactly that owner's credential through
// the existing loadScopedZoomCredential / ensureFreshZoomToken pair — an exact
// (owner_type, owner_id) match, never a cascade, never a different owner.
//
// ZOOM RECORDINGS API SHAPE (established 2026-09-02 from Zoom's published
// docs via web search — developers.zoom.us/docs/api/meetings and the
// zoom/zoom-plugin-codex recording-transcription reference; the docs host is
// egress-blocked from this environment, so the shape is quoted from search
// snippets, not the page):
//   • GET /v2/meetings/{meetingId}/recordings — "Returns all cloud recording
//     files for a specific past meeting, including per-file playback and
//     download URLs"; scope recording:read. A NUMERIC meeting id (what
//     ensureZoomMeetingForAppointment stamps) needs no encoding; a UUID would
//     need double-encoding when it contains '/' — we never send one.
//   • Response: the recording object — id, uuid, topic, start_time, duration,
//     recording_files[] { file_type, file_extension, download_url,
//     recording_type, status } — the SAME object shape the webhook's
//     payload.object carries (ZoomRecordingObject), so pickTranscriptFile and
//     processZoomRecordingEvent read it without translation.
//   • download_url is authenticated with "Authorization: Bearer <OAuth access
//     token>" — so the OAuth token is passed as `download_token`, the field
//     processZoomRecordingEvent already sends as Bearer on the download.
//   • No recording for the meeting → HTTP 404 (Zoom error code 3301). That is
//     "no transcript yet", not a refusal.
//
// BOUNDED AND HONEST. RECONCILE_BATCH events per run; every per-event refusal
// is READ and recorded in the summary, never aborting the sweep; the counted
// result (scanned / attached / already_attached / no_transcript_yet / refused /
// skipped_unresolvable) is returned, logged, and stored on the cron ledger.

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  ZOOM_SCOPES,
  PLATFORM_ZOOM_OWNER_ID,
  loadScopedZoomCredential,
  ensureFreshZoomToken,
  zoomRequest,
  type ZoomScope,
} from "@/lib/connections/zoom"
import {
  processZoomRecordingEvent,
  pickTranscriptFile,
  type ZoomRecordingObject,
} from "@/lib/connections/zoom-transcripts"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/** A meeting must be this old before we ask — Zoom renders transcripts minutes
 *  to an hour after the meeting ends; asking earlier is wasted API calls. */
const RECONCILE_MIN_AGE_MINUTES = 60
/** Lookback: Zoom keeps cloud recordings for months, but a meeting that has
 *  gone this long without a transcript is not going to grow one. */
const RECONCILE_WINDOW_DAYS = 14
/** Events examined per run (each is up to two Zoom calls + one attach). */
const RECONCILE_BATCH = 25
/** Per-event reasons kept in the summary (the counts are always complete). */
const MAX_RECORDED_REASONS = 25

interface ZoomReconcileSummary {
  scanned: number
  attached: number
  already_attached: number
  no_transcript_yet: number
  refused: number
  skipped_unresolvable: number
  window: { min_age_minutes: number; lookback_days: number; batch: number }
  reasons: Array<{ event_id: string; outcome: "refused" | "skipped_unresolvable"; reason: string }>
}

type ZoomMeta = {
  meeting_id?: string | number
  host_owner_type?: string
  host_owner_id?: string
  transcript_attached?: boolean
}

function isZoomScope(v: unknown): v is ZoomScope {
  return typeof v === "string" && (ZOOM_SCOPES as readonly string[]).includes(v)
}

/** The sweep body. Module-private on purpose: route files in this repo export
 *  handlers only (no sibling cron route exports a helper, and Next's route
 *  typing refuses extra exports). If a simulator ever needs to drive it, the
 *  body moves to lib/connections/ beside zoom-transcripts.ts — not into an
 *  export here. */
async function reconcileZoomTranscripts(svc: ReturnType<typeof createServiceClient>): Promise<ZoomReconcileSummary> {
  const now = Date.now()
  const cutoff = new Date(now - RECONCILE_MIN_AGE_MINUTES * 60_000).toISOString()
  const windowStart = new Date(now - RECONCILE_WINDOW_DAYS * 86_400_000).toISOString()

  const summary: ZoomReconcileSummary = {
    scanned: 0,
    attached: 0,
    already_attached: 0,
    no_transcript_yet: 0,
    refused: 0,
    skipped_unresolvable: 0,
    window: { min_age_minutes: RECONCILE_MIN_AGE_MINUTES, lookback_days: RECONCILE_WINDOW_DAYS, batch: RECONCILE_BATCH },
    reasons: [],
  }
  const note = (event_id: string, outcome: "refused" | "skipped_unresolvable", reason: string) => {
    summary[outcome]++
    if (summary.reasons.length < MAX_RECORDED_REASONS) summary.reasons.push({ event_id, outcome, reason })
  }

  // Candidates: stamped with a Zoom meeting, past, not yet attached. The read
  // error is READ — a refused worklist read is a failed sweep, not "nothing
  // to reconcile" (supabase-js resolves refusals).
  const { data: rows, error: listError } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, start_at, metadata")
    .not("metadata->zoom->>meeting_id", "is", null)
    .is("metadata->zoom->>transcript_attached", null)
    .gte("start_at", windowStart)
    .lte("start_at", cutoff)
    .order("start_at", { ascending: false })
    .limit(RECONCILE_BATCH)
  if (listError) throw new Error(`calendar_events worklist read failed: ${listError.message}`)

  // One fresh token per host owner per run (ensureFreshZoomToken persists a
  // rotated refresh token, so refreshing once per owner is also the safe count).
  const tokenByOwner = new Map<string, string>()

  for (const row of (rows ?? []) as Array<{ id: string; brokerage_id: string | null; start_at: string | null; metadata: any }>) {
    summary.scanned++
    const zoom = ((row.metadata ?? {}) as { zoom?: ZoomMeta }).zoom ?? {}
    const meetingId = zoom.meeting_id != null ? String(zoom.meeting_id).trim() : ""

    // Zoom meeting ids are numeric; anything else (the deal-room demo stamps a
    // fictional id) is not a meeting Zoom can be asked about.
    if (!/^\d{6,}$/.test(meetingId)) {
      note(row.id, "skipped_unresolvable", `metadata.zoom.meeting_id "${meetingId || "—"}" is not a Zoom meeting number`)
      continue
    }
    const scope = zoom.host_owner_type
    if (!isZoomScope(scope) || scope === "vendor") {
      note(row.id, "skipped_unresolvable", `host_owner_type "${String(scope ?? "—")}" is not a Zoom host scope, so no credential can be resolved`)
      continue
    }
    const ownerId = scope === "platform" ? PLATFORM_ZOOM_OWNER_ID : (zoom.host_owner_id ?? "").trim()
    if (!ownerId) {
      note(row.id, "skipped_unresolvable", "host_owner_id missing on the calendar event — the host's credential cannot be resolved")
      continue
    }

    try {
      const ownerKey = `${scope}:${ownerId}`
      let accessToken = tokenByOwner.get(ownerKey) ?? null
      if (!accessToken) {
        const cred = await loadScopedZoomCredential(svc, scope, ownerId)
        if (!cred) {
          note(row.id, "refused", `host ${ownerKey} has no active Zoom connection — cannot read its recordings`)
          continue
        }
        accessToken = await ensureFreshZoomToken(svc, cred) // throws on refresh/persist failure → refused below
        tokenByOwner.set(ownerKey, accessToken)
      }

      const res = await zoomRequest<ZoomRecordingObject>({
        accessToken,
        method: "GET",
        path: `/v2/meetings/${meetingId}/recordings`,
      })
      if (res.status === 404) {
        summary.no_transcript_yet++ // no cloud recording for this meeting (Zoom 3301)
        continue
      }
      if (!res.ok || !res.data) {
        note(row.id, "refused", `Zoom recordings read failed (${res.status ?? "—"}): ${res.error ?? "empty body"}`)
        continue
      }
      if (!pickTranscriptFile(res.data)) {
        summary.no_transcript_yet++ // recording exists, transcript not rendered yet
        continue
      }

      // THE SAME ingest as the webhook — the response object IS the webhook's
      // payload.object shape; the OAuth token authenticates download_url.
      const result = await processZoomRecordingEvent(svc, {
        event: "recording.transcript_completed",
        download_token: accessToken,
        payload: { object: res.data },
      })
      if (result.handled && result.reason?.includes("already attached")) summary.already_attached++
      else if (result.handled) summary.attached++
      else note(row.id, "refused", result.reason ?? "processZoomRecordingEvent declined without a reason")
    } catch (e: any) {
      note(row.id, "refused", e?.message ?? "unexpected error")
    }
  }

  return summary
}

export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "zoom-transcript-reconcile",
    cron_path: "/app/api/cron/zoom-transcript-reconcile/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await reconcileZoomTranscripts(createServiceClient())
    console.log("[zoom-transcript-reconcile]", JSON.stringify({ ...summary, reasons: summary.reasons.length }))
    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.attached, metadata: summary as any })
    return NextResponse.json({ message: "Zoom transcript reconciliation complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
