// app/dashboard/meetings/[eventId]/transcript-panel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE TRANSCRIPT, READ BACK TO THE AGENT (lane Z2, 2026-09-02). Until this
// panel the meeting page could only say "Transcript attached … and analyzed"
// — a FACT about a row nobody could open in-product (the writer itself says so
// at lib/connections/zoom-transcripts.ts, "what does not exist is an in-product
// surface that shows a meeting transcript back to the agent"). This is that
// surface. It is a READER only: nothing here writes.
//
// WHICH LANE. `stampTranscriptAttached` (zoom-transcripts.ts) records on the
// calendar event's metadata.zoom exactly three keys — transcript_attached,
// transcript_attached_to ('contact' | 'tenant'), transcript_uuid — and those
// three are the whole lookup:
//   • 'contact' → voice_calls WHERE vendor_call_id = `zoom:<transcript_uuid>`
//                 (the ONE voice-transcript ledger), plus the newest
//                 call_analyses row for that call (summary, intent, next action).
//   • 'tenant'  → communications WHERE metadata->>zoom_uuid = <transcript_uuid>
//                 (channel 'zoom_transcript'; transcript + insights live in
//                 metadata JSONB, contact_id null by design).
//
// TENANT ANCHOR (CLAUDE.md §4). Gate first, then the service client: the page
// resolved the calendar event through the RLS client, and THIS panel takes the
// session's brokerage from getAgentContext and REFUSES unless it equals the
// event's brokerage_id. Every read below carries `.eq("brokerage_id", anchor)`
// — a contact-lane meeting can only resolve to a voice_calls row the session's
// brokerage owns, which is what makes the contact one the brokerage owns.
//
// HONESTY. Every read destructures { data, error } and READS the error: a
// refused read renders "could not load" with the message, never "no
// transcript". Only a clean read that returns no row says "no transcript".
//
// §5. Agent-facing surface for the agent's own meeting. call_analyses is read
// by NAMED columns and `financial_discussions` is deliberately not among them;
// no commission or money field is widened here.

import Link from "next/link"
import { FileText } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { createServiceClient } from "@/lib/supabase/service"

/** What a call_analyses row contributes (the columns this panel selects). */
interface TranscriptSummary {
  summary: string | null
  sentiment: string | null
  intentPrimary: string | null
  suggestedNextAction: string | null
  keyTopics: string[]
  urgencyScore: number | null
  analyzedBy: string | null
}

export type TranscriptLoad =
  | { state: "not_attached" }
  | { state: "refused"; reason: string }
  | { state: "missing"; lane: "contact" | "tenant"; detail: string }
  | {
      state: "loaded"
      lane: "contact" | "tenant"
      transcript: string
      summary: TranscriptSummary | null
      startedAt: string | null
      durationSeconds: number | null
      /** Contact lane only: the ledger row the voice review page opens. */
      voiceCallId: string | null
    }

/** Pure: "Speaker: text" lines (the shape parseZoomVtt emits — speakers kept,
 *  cue timestamps dropped) into rows the panel can label. A line with no
 *  speaker prefix renders as an unlabeled continuation. */
export function splitTranscriptLines(transcript: string): Array<{ speaker: string | null; text: string }> {
  return transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]{1,80}):\s*(.*)$/)
      return m && m[2] ? { speaker: m[1].trim(), text: m[2].trim() } : { speaker: null, text: line }
    })
}

/**
 * Load the transcript the calendar event's metadata.zoom says was attached.
 * `sessionBrokerageId` is the SESSION's tenant (getAgentContext), never a
 * parameter from the request; `eventBrokerageId` is the RLS-resolved event's.
 */
export async function loadMeetingTranscript(args: {
  zoom: {
    transcript_attached?: boolean
    transcript_attached_to?: string
    transcript_uuid?: string
  } | null
  eventBrokerageId: string | null
  sessionBrokerageId: string | null
}): Promise<TranscriptLoad> {
  const z = args.zoom
  if (!z?.transcript_attached) return { state: "not_attached" }

  // FAIL CLOSED: no session tenant, or a tenant other than the event's, is a
  // refusal — never a read that happens to return nothing.
  const anchor = (args.sessionBrokerageId ?? "").trim()
  if (!anchor) return { state: "refused", reason: "your session carries no brokerage, so the transcript cannot be tenant-anchored" }
  if (!args.eventBrokerageId || args.eventBrokerageId !== anchor) {
    return { state: "refused", reason: "this meeting belongs to a different brokerage than your session" }
  }

  const lane = z.transcript_attached_to === "tenant" ? "tenant" : z.transcript_attached_to === "contact" ? "contact" : null
  const uuid = typeof z.transcript_uuid === "string" ? z.transcript_uuid.trim() : ""
  if (!lane || !uuid) {
    return {
      state: "refused",
      reason: `the calendar event says a transcript was attached but not where (attached_to=${String(z.transcript_attached_to ?? "—")}, uuid=${uuid || "—"})`,
    }
  }

  const svc = createServiceClient()

  if (lane === "contact") {
    const { data: call, error: callError } = await svc
      .from("voice_calls")
      .select("id, transcription, started_at, duration_seconds")
      .eq("brokerage_id", anchor)
      .eq("vendor_call_id", `zoom:${uuid}`)
      .maybeSingle()
    if (callError) return { state: "refused", reason: `voice_calls read failed: ${callError.message}` }
    if (!call) return { state: "missing", lane, detail: `no voice_calls row carries vendor_call_id zoom:${uuid} for this brokerage` }

    const { data: analysis, error: analysisError } = await svc
      .from("call_analyses")
      .select("summary, sentiment, intent_primary, suggested_next_action, key_topics, urgency_score, analyzed_by, analyzed_at")
      .eq("brokerage_id", anchor)
      .eq("voice_call_id", (call as any).id)
      .order("analyzed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (analysisError) return { state: "refused", reason: `call_analyses read failed: ${analysisError.message}` }

    const transcript = typeof (call as any).transcription === "string" ? (call as any).transcription : ""
    return {
      state: "loaded",
      lane,
      transcript,
      summary: analysis
        ? {
            summary: (analysis as any).summary ?? null,
            sentiment: (analysis as any).sentiment ?? null,
            intentPrimary: (analysis as any).intent_primary ?? null,
            suggestedNextAction: (analysis as any).suggested_next_action ?? null,
            keyTopics: Array.isArray((analysis as any).key_topics) ? (analysis as any).key_topics.map(String) : [],
            urgencyScore: typeof (analysis as any).urgency_score === "number" ? (analysis as any).urgency_score : null,
            analyzedBy: (analysis as any).analyzed_by ?? null,
          }
        : null,
      startedAt: (call as any).started_at ?? null,
      durationSeconds: typeof (call as any).duration_seconds === "number" ? (call as any).duration_seconds : null,
      voiceCallId: (call as any).id as string,
    }
  }

  // tenant lane — communications, channel 'zoom_transcript'
  const { data: comm, error: commError } = await svc
    .from("communications")
    .select("id, sent_at, metadata")
    .eq("brokerage_id", anchor)
    .eq("channel", "zoom_transcript")
    .eq("metadata->>zoom_uuid", uuid)
    .maybeSingle()
  if (commError) return { state: "refused", reason: `communications read failed: ${commError.message}` }
  if (!comm) return { state: "missing", lane, detail: `no communications row carries zoom_uuid ${uuid} for this brokerage` }

  const meta = (((comm as any).metadata ?? {}) as Record<string, any>)
  const insights = (meta.insights ?? null) as Record<string, any> | null
  return {
    state: "loaded",
    lane,
    transcript: typeof meta.transcript === "string" ? meta.transcript : "",
    summary: insights
      ? {
          summary: typeof insights.summary === "string" ? insights.summary : null,
          sentiment: typeof insights.sentiment === "string" ? insights.sentiment : null,
          intentPrimary: typeof insights.intentPrimary === "string" ? insights.intentPrimary : null,
          suggestedNextAction: typeof insights.suggestedNextAction === "string" ? insights.suggestedNextAction : null,
          keyTopics: Array.isArray(insights.keyTopics) ? insights.keyTopics.map(String) : [],
          urgencyScore: typeof insights.urgencyScore === "number" ? insights.urgencyScore : null,
          analyzedBy: typeof meta.provenance === "string" ? meta.provenance : null,
        }
      : null,
    startedAt: (comm as any).sent_at ?? null,
    durationSeconds: typeof meta.duration_seconds === "number" ? meta.duration_seconds : null,
    voiceCallId: null,
  }
}

function fmtDuration(secs: number | null): string | null {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return null
  return secs >= 60 ? `${Math.floor(secs / 60)} min` : `${secs}s`
}

/** Server component: the "Meeting transcript" card. Renders nothing when no
 *  transcript was ever attached (the page's join tier stays uncluttered). */
export function TranscriptPanel({ load }: { load: TranscriptLoad }) {
  if (load.state === "not_attached") return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Meeting transcript
          {load.state === "loaded" && (
            <Badge variant="outline" className="font-normal">
              {load.lane === "tenant" ? "attached to the tenant record" : "attached to the contact"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {load.state === "refused" && (
          <p className="text-red-600">Could not load the transcript — {load.reason}.</p>
        )}

        {load.state === "missing" && (
          <p className="text-muted-foreground">
            The calendar event records a transcript on the {load.lane === "tenant" ? "tenant record" : "contact"}, but the row is not there
            ({load.detail}). This is a gap in the ledger, not a missing recording.
          </p>
        )}

        {load.state === "loaded" && (
          <>
            {/* Summary first — from call_analyses (contact) or metadata.insights (tenant). */}
            {load.summary ? (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase text-muted-foreground">AI summary</div>
                {load.summary.summary ? (
                  <p className="whitespace-pre-wrap">{load.summary.summary}</p>
                ) : (
                  <p className="text-muted-foreground">The analysis row has no summary text.</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {load.summary.sentiment && <Badge variant="secondary">{load.summary.sentiment}</Badge>}
                  {load.summary.intentPrimary && <Badge variant="secondary">intent: {load.summary.intentPrimary}</Badge>}
                  {load.summary.urgencyScore != null && <Badge variant="secondary">urgency {load.summary.urgencyScore}/100</Badge>}
                  {load.summary.keyTopics.slice(0, 6).map((t) => (
                    <Badge key={t} variant="outline">{t}</Badge>
                  ))}
                </div>
                {load.summary.suggestedNextAction && (
                  <p className="text-xs">
                    <span className="text-muted-foreground">Suggested next action: </span>
                    {load.summary.suggestedNextAction}
                  </p>
                )}
                {load.summary.analyzedBy && (
                  <p className="text-[11px] text-muted-foreground">
                    Model-drafted from the transcript (provenance: {load.summary.analyzedBy}). Read the transcript before acting on it.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                The transcript attached but no analysis row exists for it yet, so there is no summary to show.
              </p>
            )}

            {/* The transcript itself — collapsed by default. Speaker names are
                the ones Zoom wrote into the VTT; parseZoomVtt keeps speakers
                and drops cue timestamps, so none are shown here. */}
            <details className="group rounded-md border">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium hover:bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-1">
                Full transcript
                <span className="text-xs font-normal text-muted-foreground">
                  {[
                    load.startedAt ? new Date(load.startedAt).toLocaleString() : null,
                    fmtDuration(load.durationSeconds),
                    `${splitTranscriptLines(load.transcript).length} turns`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </summary>
              <div className="px-3 pb-3 pt-1 space-y-1.5 max-h-[32rem] overflow-y-auto">
                {load.transcript.trim().length === 0 ? (
                  <p className="text-xs text-muted-foreground">The stored transcript is empty.</p>
                ) : (
                  splitTranscriptLines(load.transcript).map((row, i) => (
                    <p key={i} className="text-xs leading-relaxed">
                      {row.speaker && <span className="font-semibold">{row.speaker}: </span>}
                      {row.text}
                    </p>
                  ))
                )}
                <p className="text-[11px] text-muted-foreground pt-2">
                  Speaker labels are as Zoom transcribed them; cue timestamps are not kept by the transcript parser.
                </p>
              </div>
            </details>

            {load.voiceCallId && (
              <Link href={`/dashboard/voice/review/${load.voiceCallId}`} className="inline-block">
                <Button variant="outline" size="sm">Open in call review</Button>
              </Link>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
