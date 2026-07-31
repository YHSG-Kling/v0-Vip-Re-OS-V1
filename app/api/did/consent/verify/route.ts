/**
 * POST /api/did/consent/verify
 *
 * Submits the agent's recorded consent video to D-ID for verification and
 * records the verdict.
 *
 * D-ID runs three checks on this recording — transcription against the
 * passcode, face recognition against the avatar footage, and voice
 * verification — and the one an agent can actually fix on the spot is the
 * passcode, so ConsentTextSimilarityError gets its own instruction rather than
 * a generic failure.
 *
 * The recording arrives as a URL already hosted by us (the capture component
 * uploads the webcam blob first). It must be a LIVE recording: D-ID does not
 * accept an uploaded file for consent, so the capture surface offers no file
 * picker — that rule is enforced by the UI having no other way in, and stated
 * here so the next reader does not "helpfully" add one.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { uploadConsentVideo } from "@/lib/did/consent"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { data: agent } = await supabase.from("agents")
    .select("id").eq("user_id", auth.userId).maybeSingle()
  if (!agent) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 })

  const body = await request.json().catch(() => ({})) as {
    consent_id?: string; source_url?: string
  }
  if (!body?.consent_id || !body?.source_url) {
    return NextResponse.json({ error: "consent_id and source_url are required" }, { status: 400 })
  }

  // The consent row must belong to THIS agent — otherwise one agent could
  // verify against another's consent and inherit their avatar rights.
  const { data: row } = await supabase.from("agent_did_consents")
    .select("id, agent_id, status")
    .eq("did_consent_id", body.consent_id)
    .maybeSingle()
  if (!row || row.agent_id !== agent.id) {
    return NextResponse.json({ error: "Consent not found" }, { status: 404 })
  }
  if (row.status === "verified") {
    // Already done. Idempotent rather than an error — a double-submit from a
    // flaky network should not look like a failure to the agent.
    return NextResponse.json({ status: "verified" })
  }

  const result = await uploadConsentVideo(body.consent_id, body.source_url)

  if (!result.ok) {
    const failure = result.failure!
    await supabase.from("agent_did_consents").update({
      // A retryable provider blip leaves the row PENDING so the agent can
      // simply try again against the same passcode; only a real rejection
      // marks it failed.
      status: failure.retryable ? "pending" : "failed",
      failure_reason: failure.userMessage,
      source_url: body.source_url,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id)

    return NextResponse.json(
      { error: failure.userMessage, kind: failure.kind, retryable: failure.retryable },
      { status: failure.retryable ? 503 : 422 },
    )
  }

  await supabase.from("agent_did_consents").update({
    status: "verified",
    failure_reason: null,
    source_url: body.source_url,
    verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", row.id)

  return NextResponse.json({ status: "verified", consent_id: body.consent_id })
}
