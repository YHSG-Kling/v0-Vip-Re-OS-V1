// lib/connections/zoom-transcripts.ts
// ─────────────────────────────────────────────────────────────────────────────
// ZOOM TRANSCRIPT → CONTACT/TENANT ATTACH + INSIGHT ENRICHMENT (round 39).
// Consumes REAL Zoom recording webhooks only (recording.transcript_completed /
// recording.completed with a TRANSCRIPT file) — a transcript is never invented.
//
// Attach design (resolveZoomAttachTarget, pure in lib/connections/zoom.ts):
//   • TENANT-hosted meeting (agent/team/brokerage Zoom) → the transcript lands
//     on the CONTACT tied to the calendar event, in the SAME ledger voice
//     transcripts use: a voice_calls row (call_type 'zoom_meeting', vendor call
//     id 'zoom:<uuid>', transcription = parsed VTT), then the EXISTING
//     conversation-intel extractor (lib/voice/call-analysis.ts →
//     analyzeVoiceCallRow — never a fork) writes the same call_analyses insight
//     row the coaching/intelligence loop reads, provenance 'zoom_transcript'.
//   • PLATFORM-hosted meeting → voice_calls is tenant/contact-shaped (l32), so
//     the transcript attaches to the TENANT instead: a communications row
//     (channel 'zoom_transcript', brokerage_id = tenant, contact_id null) with
//     the full transcript + the SAME extractor's insights (extractVoiceIntel —
//     the shared core, not a second prompt) in metadata, provenance
//     'zoom_transcript'.
//
// Idempotent per meeting uuid on both lanes (a webhook redelivery never
// double-attaches or double-analyzes).

import type { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { parseZoomVtt, resolveZoomAttachTarget } from "./zoom"
import { analyzeVoiceCallRow, extractVoiceIntel } from "@/lib/voice/call-analysis"

type ServiceClient = ReturnType<typeof createServiceClient>

export interface ZoomRecordingObject {
  id?: number | string
  uuid?: string
  topic?: string
  start_time?: string
  duration?: number // minutes
  recording_files?: Array<{
    file_type?: string
    file_extension?: string
    download_url?: string
    recording_type?: string
  }>
}

export interface ProcessZoomRecordingResult {
  handled: boolean
  attached?: "contact" | "tenant"
  analyzed?: boolean
  reason?: string
}

/** Pure: pick the transcript file out of a recording payload (Zoom marks the
 *  VTT transcript file_type 'TRANSCRIPT'). */
export function pickTranscriptFile(obj: ZoomRecordingObject): { download_url: string } | null {
  const f = (obj.recording_files ?? []).find(
    (x) => (x.file_type ?? "").toUpperCase() === "TRANSCRIPT" && !!x.download_url,
  )
  return f?.download_url ? { download_url: f.download_url } : null
}

/**
 * Process one verified Zoom recording event: fetch the REAL transcript, find
 * the calendar event the meeting was stamped on, attach by scope, enrich.
 */
export async function processZoomRecordingEvent(
  svc: ServiceClient,
  payload: { event?: string; download_token?: string; payload?: { object?: ZoomRecordingObject } },
): Promise<ProcessZoomRecordingResult> {
  const obj = payload.payload?.object
  if (!obj?.id || !obj.uuid) return { handled: false, reason: "payload missing meeting id/uuid" }
  const meetingId = String(obj.id)
  const meetingUuid = String(obj.uuid)

  const file = pickTranscriptFile(obj)
  if (!file) {
    // recording.completed often arrives before the transcript is rendered —
    // the recording.transcript_completed event carries it. Nothing to invent.
    return { handled: false, reason: "no TRANSCRIPT file in payload (waiting for recording.transcript_completed)" }
  }

  // ── The calendar event this meeting was created for (stamped at booking) ──
  const { data: event } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, agent_user_id, entity_type, entity_id, event_type, title, start_at, metadata")
    .eq("metadata->zoom->>meeting_id", meetingId)
    .maybeSingle()
  if (!event) return { handled: false, reason: `no calendar event carries zoom meeting_id ${meetingId}` }

  const meta = ((event as any).metadata ?? {}) as Record<string, any>
  const zoomMeta = (meta.zoom ?? {}) as Record<string, any>

  // Resolve a lead's linked contact when the event's entity is a lead.
  let leadContactId: string | null = null
  if ((event as any).entity_type === "lead" && (event as any).entity_id) {
    const { data: lead } = await svc.from("leads").select("contact_id").eq("id", (event as any).entity_id).maybeSingle()
    leadContactId = (lead as any)?.contact_id ?? null
  }

  const target = resolveZoomAttachTarget({
    hostOwnerType: (zoomMeta.host_owner_type as string | undefined) ?? null,
    brokerageId: (event as any).brokerage_id ?? null,
    entityType: (event as any).entity_type ?? null,
    entityId: (event as any).entity_id ?? null,
    metadataContactId: (meta.contact_id as string | undefined) ?? null,
    leadContactId,
  })
  if (target.kind === "none") return { handled: false, reason: target.reason }

  // ── Fetch the REAL transcript (VTT) via Zoom's short-lived download token ──
  const dl = await callConnector<string>({
    connector: "zoom-recording-download",
    url: file.download_url,
    method: "GET",
    responseType: "text",
    auth: payload.download_token ? { style: "bearer", token: payload.download_token } : { style: "none" },
  })
  if (!dl.ok || typeof dl.data !== "string" || dl.data.trim().length === 0) {
    return { handled: false, reason: `transcript download failed (${dl.status ?? "—"}): ${dl.error ?? "empty body"}` }
  }
  const transcript = parseZoomVtt(dl.data)
  if (transcript.trim().length < 40) {
    return { handled: false, reason: "transcript too short to attach (parsed VTT under 40 chars)" }
  }

  const startedAt = obj.start_time ?? (event as any).start_at ?? new Date().toISOString()
  const durationSeconds = typeof obj.duration === "number" ? obj.duration * 60 : null
  const topic = obj.topic ?? (event as any).title ?? "Zoom meeting"

  if (target.kind === "tenant") {
    // ── PLATFORM-hosted: attach to the TENANT (communications, GDPR-exported) ─
    const { data: dup } = await svc
      .from("communications")
      .select("id")
      .eq("metadata->>zoom_uuid", meetingUuid)
      .maybeSingle()
    if (dup) return { handled: true, attached: "tenant", analyzed: false, reason: "already attached (idempotent)" }

    // Insight enrichment through THE shared extractor core (no fork).
    let insights: Awaited<ReturnType<typeof extractVoiceIntel>> | null = null
    try {
      insights = await extractVoiceIntel(transcript, "zoom_meeting")
    } catch {
      insights = null // transcript still attaches; enrichment is best-effort
    }

    // ── ADJUDICATION (2026-09-01) — why these columns read as one-sided ────────
    // The wave that deleted a phantom `communications(*)` embed (it joined on
    // contact_id, which this writer sets NULL by design, so it could only ever
    // return []) made this table's columns surface as writer-with-no-reader.
    // They are NOT unread. Their reader is the TENANT DATA EXPORT —
    // lib/platform/tenant-export.ts:54 does `.from(table).select("*")` over
    // TENANT_EXPORT_TABLES, which names "communications" at :18. That is a
    // whole-row read through a LOOP VARIABLE table name, so it is invisible to a
    // column-level census twice over: it names no columns, and the table name is
    // not a literal at the call site. Hence "GDPR-exported" in the header above.
    // §1 is satisfied — the write has a reader, and the departing or auditing
    // tenant is who reads it.
    // NOT a defect, and NOT to be "fixed" by deleting columns: what does not
    // exist is an in-product surface that shows a meeting transcript back to the
    // agent. That is a feature decision, not a broken wire.
    // The pre-check above is the FAST path only (the voice_calls lane's idiom,
    // below): a check-then-insert is a race, and two concurrent redeliveries of
    // the same meeting both read null. m599 (partial UNIQUE on
    // metadata->>'zoom_uuid') is what decides; 23505 from it is the SAME
    // "already attached" answer the pre-check returns, never a failed attach.
    // Until m599 is applied a duplicate is still possible — the arm is inert
    // rather than wrong, and becomes live the moment the index exists.
    const { error } = await svc.from("communications").insert({
      brokerage_id: target.brokerageId,
      contact_id: null,
      channel: "zoom_transcript",
      direction: "inbound",
      subject: `Zoom meeting transcript — ${String(topic).slice(0, 180)}`,
      content_preview: (insights?.summary ?? transcript).slice(0, 1500),
      metadata: {
        provenance: "zoom_transcript",
        zoom_uuid: meetingUuid,
        zoom_meeting_id: meetingId,
        calendar_event_id: (event as any).id,
        transcript,
        duration_seconds: durationSeconds,
        ...(insights ? { insights } : {}),
      },
      sent_at: startedAt,
    })
    if (error) {
      if ((error as any)?.code === "23505") {
        return { handled: true, attached: "tenant", analyzed: false, reason: "already attached (idempotent)" }
      }
      return { handled: false, reason: `communications insert failed: ${error.message}` }
    }

    await stampTranscriptAttached(svc, (event as any).id, meta, meetingUuid, "tenant")
    return { handled: true, attached: "tenant", analyzed: !!insights }
  }

  // ── TENANT-hosted: attach to the CONTACT via the ONE voice-transcript ledger ─
  const vendorCallId = `zoom:${meetingUuid}`
  // The FAST path only. This read answers "has this meeting already been
  // attached?" for the common re-delivery, but it is a check-then-insert and
  // therefore a race — two concurrent deliveries can both read null. m464's
  // uq_voice_calls_vendor_call_id is what actually decides; the insert below
  // reads 23505 as the same "already attached" answer this branch returns, so
  // losing the race costs a round trip and never a duplicate ledger row.
  //
  // The error is checked because supabase-js RESOLVES a rejected read: an
  // unchecked read here would report a refused query as "no such row" and send
  // a duplicate straight at the insert.
  const { data: dupCall, error: dupError } = await svc
    .from("voice_calls")
    .select("id")
    .eq("vendor_call_id", vendorCallId)
    .maybeSingle()
  if (dupError) return { handled: false, reason: `voice_calls duplicate check failed: ${dupError.message}` }
  if (dupCall) return { handled: true, attached: "contact", analyzed: false, reason: "already attached (idempotent)" }

  // voice_calls.agent_id + call_analyses.agent_id carry agents.id — resolve it
  // from the calendar event's agent USER id.
  let agentId: string | null = null
  if ((event as any).agent_user_id) {
    const { data: agent } = await svc.from("agents").select("id").eq("user_id", (event as any).agent_user_id).maybeSingle()
    agentId = (agent as any)?.id ?? null
  }

  const { data: callRow, error: callErr } = await svc
    .from("voice_calls")
    .insert({
      brokerage_id: (event as any).brokerage_id,
      contact_id: target.contactId,
      ...(agentId ? { agent_id: agentId } : {}),
      direction: "outbound", // we (the host) convened the meeting
      call_type: "zoom_meeting",
      status: "completed",
      started_at: startedAt,
      ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
      transcription: transcript.slice(0, 60_000),
      vendor_call_id: vendorCallId, // the ledger's vendor-call-id column (Twilio CallSid or zoom:<uuid>)
    })
    .select("id")
    .single()
  if (callErr || !callRow) {
    // Losing the race above is the SAME answer as winning the fast-path check,
    // not a failure: 23505 on the vendor-call-id unique means another delivery
    // already attached this meeting. Reporting it as a failed attach would make
    // a correctly-idempotent lane look broken.
    if ((callErr as any)?.code === "23505") {
      return { handled: true, attached: "contact", analyzed: false, reason: "already attached (idempotent)" }
    }
    return { handled: false, reason: `voice_calls insert failed: ${callErr?.message ?? "no row"}` }
  }

  // INSIGHT ENRICHMENT — the EXISTING extractor writing the SAME call_analyses
  // insight row the intelligence loop reads, provenance 'zoom_transcript'.
  const analysis = await analyzeVoiceCallRow(
    svc,
    {
      id: (callRow as any).id,
      brokerage_id: (event as any).brokerage_id,
      contact_id: target.contactId,
      agent_id: agentId,
      // The SAME two values the ledger row above carries — never a smear
      // (§6). direction used to carry "zoom_meeting", which the analyzer
      // mapped to call_analyses.call_type "inbound"; the kind now travels in
      // call_type and the analyzer records it verbatim (analysisCallType).
      direction: "outbound",
      call_type: "zoom_meeting",
      duration_seconds: durationSeconds,
      transcription: transcript,
    },
    "zoom_transcript",
  )

  // MEETING-TO-ACTION LOOP (round 40) — the moment the meeting's analysis lands,
  // the ISA ACTS on the extracted intents through the governed rails: sell-first
  // → gated listing-side outreach, financing → gated pre-qual education, stated
  // timeline → follow-up at that horizon, objection → agent coaching note. ONE
  // consumer shared with the hourly voice sweep (lib/ai-isa/meeting-followthrough
  // — proposals only, deduped per meeting, NEVER a direct send). Best-effort:
  // the attach + analysis stand even if follow-through fails.
  if (analysis.ok) {
    try {
      const { runMeetingFollowthroughForCall } = await import("@/lib/ai-isa/meeting-followthrough")
      await runMeetingFollowthroughForCall(svc, (callRow as any).id)
    } catch (e) {
      console.error("[zoom-transcripts] meeting follow-through failed (non-blocking):", e)
    }

    // THE CLIENT MEETING RECAP (round 41) — AFTER follow-through, so "what
    // happens next" can cite the REAL proposals it just created. Composes
    // "what we discussed / what happens next" in the tenant's voice and lands
    // it on the human-approval gate (proposeClientMessage, channel 'portal',
    // status 'proposed') — the client sees the approved card only, NEVER the
    // transcript. One recap per meeting (deduped); best-effort — the attach,
    // analysis, and follow-through stand even if the recap fails.
    try {
      const { composeMeetingRecap } = await import("@/lib/ai-isa/meeting-recap")
      await composeMeetingRecap(svc, (callRow as any).id)
    } catch (e) {
      console.error("[zoom-transcripts] meeting recap failed (non-blocking):", e)
    }
  }

  await stampTranscriptAttached(svc, (event as any).id, meta, meetingUuid, "contact")
  return { handled: true, attached: "contact", analyzed: analysis.ok }
}

/** Mark the calendar event's zoom metadata so the meeting page can show that
 *  the transcript landed (best-effort; never blocks the attach). */
async function stampTranscriptAttached(
  svc: ServiceClient,
  eventId: string,
  meta: Record<string, any>,
  meetingUuid: string,
  attachedTo: "contact" | "tenant",
): Promise<void> {
  try {
    await svc
      .from("calendar_events")
      .update({
        metadata: {
          ...meta,
          zoom: {
            ...((meta.zoom ?? {}) as Record<string, any>),
            transcript_attached: true,
            transcript_attached_to: attachedTo,
            transcript_uuid: meetingUuid,
          },
        },
      })
      .eq("id", eventId)
  } catch {
    /* best-effort */
  }
}
