import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

/**
 * TWILIO CONVERSATIONAL INTELLIGENCE — TRANSCRIPT WEBHOOK. When an
 * Intelligence Service is attached to the relay lane (TWILIO_INTELLIGENCE_
 * SERVICE_SID on the TwiML), Twilio transcribes + runs language operators
 * natively and posts here when a transcript is ready. We FETCH the transcript
 * + operator results with master creds and MERGE onto the ledger the app
 * already reads: voice_calls.summary / sentiment (only when our own sweep
 * hasn't filled them) and the matching call_analyses.intent_signals (operator
 * results ride along; the sweep's objections/urgency/coaching columns are
 * never overwritten — Twilio's operators COMPLEMENT our analysis, no drift).
 *
 * AUTH: the Intelligence Service's webhook URL is configured in the Twilio
 * console — register it WITH ?token=<RELAY_SHARED_SECRET> (runbook). The
 * token gates this route (timing-safe); no token configured → 404-silent.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.RELAY_SHARED_SECRET
  const given = new URL(request.url).searchParams.get("token") ?? ""
  if (!secret || !given || Buffer.from(secret).length !== Buffer.from(given).length
    || !timingSafeEqual(Buffer.from(secret), Buffer.from(given))) {
    return new NextResponse("not found", { status: 404 })
  }

  const masterSid = process.env.TWILIO_ACCOUNT_SID
  const masterToken = process.env.TWILIO_AUTH_TOKEN
  if (!masterSid || !masterToken) return NextResponse.json({ ok: false, error: "master creds not configured" }, { status: 200 })

  // Twilio posts JSON or form; accept both, need transcript_sid.
  let transcriptSid = ""
  const ct = request.headers.get("content-type") ?? ""
  if (ct.includes("json")) {
    const body = await request.json().catch(() => null) as any
    transcriptSid = String(body?.transcript_sid ?? body?.TranscriptSid ?? "")
  } else {
    const form = await request.formData().catch(() => null)
    transcriptSid = String(form?.get("transcript_sid") ?? form?.get("TranscriptSid") ?? "")
  }
  if (!/^GT[0-9a-fA-F]{32}$/.test(transcriptSid)) return NextResponse.json({ ok: true, ignored: true })

  const svc = createServiceClient()
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const auth = { style: "basic" as const, username: masterSid, password: masterToken }
  const INTEL = "https://intelligence.twilio.com"

  // 1. The transcript → which call it belongs to.
  const t = await callConnector<any>({ connector: "twilio", baseUrl: INTEL, path: `/v2/Transcripts/${transcriptSid}`, method: "GET", auth })
  if (!t.ok || !t.data) return NextResponse.json({ ok: false, error: `transcript fetch failed (${t.status})` }, { status: 200 })
  const callSid: string = t.data?.channel?.media_properties?.reference_sids?.call_sid
    ?? t.data?.channel?.media_properties?.call_sid ?? ""
  if (!callSid) return NextResponse.json({ ok: true, unlinked: true })

  const { data: call } = await svc.from("voice_calls").select("id, summary, sentiment")
    .eq("vapi_call_id", callSid).maybeSingle()
  if (!call) return NextResponse.json({ ok: true, unmatched: true })

  // 2. Operator results (summarization, sentiment, any custom operators).
  const ops = await callConnector<any>({ connector: "twilio", baseUrl: INTEL, path: `/v2/Transcripts/${transcriptSid}/OperatorResults`, method: "GET", auth })
  const results: any[] = ops.ok ? (ops.data?.operator_results ?? []) : []

  let ciSummary: string | null = null
  let ciSentiment: string | null = null
  for (const r of results) {
    const type = String(r?.operator_type ?? "").toLowerCase()
    if (type.includes("summar") && typeof r?.text_generation_results?.result === "string") {
      ciSummary = r.text_generation_results.result.slice(0, 2000)
    }
    if (type.includes("sentiment")) {
      const label = String(r?.predicted_label ?? "").toLowerCase()
      if (["positive", "neutral", "negative", "mixed"].includes(label)) ciSentiment = label
    }
  }

  // 3. Merge — our own sweep's fields always win; Twilio fills the gaps.
  const patch: Record<string, unknown> = {}
  if (ciSummary && !(call as any).summary) patch.summary = ciSummary
  if (ciSentiment && !(call as any).sentiment) patch.sentiment = ciSentiment
  if (Object.keys(patch).length > 0) {
    await svc.from("voice_calls").update(patch).eq("id", (call as any).id).then(undefined, () => {})
  }
  if (results.length > 0) {
    const compact = results.slice(0, 12).map((r) => ({
      operator: r?.name ?? r?.operator_type ?? "unknown",
      label: r?.predicted_label ?? null,
      probability: r?.predicted_probability ?? null,
    }))
    await svc.from("call_analyses")
      .update({ intent_signals: { twilio_ci: compact, transcript_sid: transcriptSid } })
      .eq("voice_call_id", (call as any).id)
      .then(undefined, () => {})
  }

  return NextResponse.json({ ok: true, merged: Object.keys(patch), operators: results.length })
}
