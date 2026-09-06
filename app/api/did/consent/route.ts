/**
 * /api/did/consent
 *
 * The D-ID consent statement an agent must record before a video twin (V3
 * Instant Avatar) can be built.
 *
 *   GET  — what is this agent's consent situation? Returns an existing VERIFIED
 *          consent (reusable forever, so nobody performs the passcode twice) or
 *          the pending one they were part-way through.
 *   POST — mint a new consent and return the three-word passcode to read aloud.
 *
 * The recording itself is submitted to /api/did/consent/verify. Capture must be
 * live: D-ID does not accept an uploaded file for consent, because an upload
 * proves nothing about who was in front of the camera.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import {
  mintConsent, findVerifiedConsent, normalizeConsentLanguage, CONSENT_INSTRUCTIONS,
} from "@/lib/did/consent"

export const runtime = "nodejs"

async function resolveAgent(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase.from("agents")
    .select("id, brokerage_id").eq("user_id", userId).maybeSingle()
  return data as { id: string; brokerage_id: string | null } | null
}

export async function GET() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const agent = await resolveAgent(supabase, auth.userId)
  if (!agent) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 })

  const verified = await findVerifiedConsent(supabase, agent.id)
  if (verified) {
    return NextResponse.json({
      status: "verified",
      consent_id: verified.didConsentId,
      // The passcode is NOT returned once verified — it has served its purpose
      // and showing it again would only invite a pointless re-record.
      instructions: CONSENT_INSTRUCTIONS,
      // THE PROVENANCE. verified_at / language / source_url are stamped by the
      // verify route and were read by nothing, so the agent could be told
      // "consent verified" with no way to see WHEN they gave it, in WHAT
      // language, or that the recording backing it is on file. On a likeness
      // consent that is the whole record. The URL itself is NOT returned — it
      // is a provider-side asset and the agent needs to know it EXISTS, not to
      // be handed a link to it.
      verified_at: verified.verifiedAt,
      language: verified.language,
      recording_on_file: !!verified.sourceUrl,
    })
  }

  // A pending attempt keeps its ORIGINAL passcode: the agent may be mid-record,
  // and minting fresh words would invalidate what they are already saying.
  const { data: pending } = await supabase.from("agent_did_consents")
    .select("did_consent_id, consent_text, status, failure_reason")
    .eq("agent_id", agent.id).eq("status", "pending")
    .order("created_at", { ascending: false }).limit(1).maybeSingle()

  if (pending) {
    return NextResponse.json({
      status: "pending",
      consent_id: pending.did_consent_id,
      consent_text: pending.consent_text,
      instructions: CONSENT_INSTRUCTIONS,
    })
  }

  const { data: lastFailure } = await supabase.from("agent_did_consents")
    .select("failure_reason").eq("agent_id", agent.id).eq("status", "failed")
    .order("created_at", { ascending: false }).limit(1).maybeSingle()

  return NextResponse.json({
    status: "none",
    instructions: CONSENT_INSTRUCTIONS,
    last_failure: lastFailure?.failure_reason ?? null,
  })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const agent = await resolveAgent(supabase, auth.userId)
  if (!agent) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 })

  // Already verified → hand back the existing one rather than making them do it
  // again. D-ID saves a completed consent account-side precisely so it can back
  // every future avatar.
  const existing = await findVerifiedConsent(supabase, agent.id)
  if (existing) {
    return NextResponse.json({ status: "verified", consent_id: existing.didConsentId })
  }

  const body = await request.json().catch(() => ({})) as { language?: string }
  const language = normalizeConsentLanguage(body?.language)

  const minted = await mintConsent(language)
  if (!minted.ok) {
    return NextResponse.json(
      { error: minted.failure.userMessage, kind: minted.failure.kind },
      { status: minted.failure.retryable ? 503 : 422 },
    )
  }

  const { error } = await supabase.from("agent_did_consents").insert({
    agent_id: agent.id,
    brokerage_id: agent.brokerage_id ?? auth.brokerageId,
    did_consent_id: minted.consentId,
    consent_text: minted.consentText,
    language,
    status: "pending",
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    status: "pending",
    consent_id: minted.consentId,
    consent_text: minted.consentText,
    instructions: CONSENT_INSTRUCTIONS,
  })
}
