import { createServiceClient } from "@/lib/supabase/service"

/**
 * Whisper-bridge status writeback — the WEBHOOK half of what used to be
 * app/actions/voice-call-bridge.ts:updateWhisperBridgeStatus.
 *
 * WHAT WAS BROKEN: that export gated on getAgentContext(), and its ONLY caller
 * was the Twilio status callback (app/api/twiml/whisper-bridge/route.ts POST) —
 * a provider request that carries no user session. The gate refused EVERY real
 * invocation with { success: false, error: "Unauthorized" }, the route never
 * read the resolved refusal (the §3 trap: supabase-js and this action both
 * RESOLVE their refusals), and so voice_calls.status stayed "initiated" forever
 * on every whispered call. The action's own header even directed webhook
 * callers to "use the service client directly" — and its one caller didn't.
 *
 * AUTHORIZATION MODEL (§4, fail closed): the caller MUST have verified the
 * X-Twilio-Signature before invoking this. The signature is the webhook's
 * credential — a stronger one than a session for a caller that is not a
 * browser — and the route rejects unsigned requests before this runs (including
 * when TWILIO_AUTH_TOKEN is unset: no secret → refuse, never pass). The tenant
 * is resolved from the CALL RECORD itself: the CallSid Twilio asserts locates
 * exactly one voice_calls row via vendor_call_id, written when the bridge was
 * placed (app/actions/voice-call-bridge.ts initiateWhisperBridge). No
 * body-supplied tenant is read. This is deliberately NOT a "use server" module:
 * an export here is not a public HTTP endpoint, so dropping the session gate
 * does not open a door — the same pattern the agent_heard stamp one block over
 * in the route already rides.
 */

// voice_calls.status + outcome are enum-constrained; map provider values to the
// allowed sets. (Carried over from the deleted action verbatim.)
const VALID_STATUS = [
  "initiated", "ringing", "in_progress", "completed",
  "failed", "no_answer", "voicemail", "blocked",
]
const VALID_OUTCOME = [
  "appointment_set", "callback_requested", "not_interested", "voicemail_left",
  "no_answer", "transferred", "completed", "authority_blocked",
]

/**
 * PURE: Twilio's status spelling → the voice_calls status vocabulary, or null
 * when this callback carries nothing the ledger can honestly record.
 *
 * Twilio spells its ladder with hyphens ("no-answer", "in-progress"); the
 * ledger spells the same ladder with underscores (§6 — one vocabulary per
 * function, normalized at the boundary the same way agentAnsweredWhisper does
 * in the route). The deleted action compared the RAW spelling against the
 * underscore set, so every hyphenated terminal status — busy, no-answer,
 * canceled — would have fallen through to its "in_progress" fallback and been
 * recorded as a LIVE call, had the dead gate ever let a write through.
 *
 * Module-private: the callback below is this mapper's only caller, and an
 * export with no importer is an orphan the function-level ledger rightly flags.
 */
function mapTwilioCallStatus(raw: string): string | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/-/g, "_")
  if (VALID_STATUS.includes(s)) return s
  if (s === "queued") return "initiated"
  if (s === "answered") return "in_progress"
  if (s === "busy") return "no_answer" // the agent's leg was never answered
  if (s === "canceled" || s === "cancelled") return "failed"
  return null // unknown spelling — leave the stored status alone rather than fabricate one
}

/**
 * Update the whisper-bridge voice_calls row from a VERIFIED Twilio status
 * callback. See the module header for the authorization model.
 */
export async function updateWhisperBridgeStatus(params: {
  callSid: string
  status: string
  duration?: number
  outcome?: string
}): Promise<{ success: boolean; error?: string }> {
  const svc = createServiceClient()
  try {
    const { data: callRow, error: findError } = await svc
      .from("voice_calls")
      .select("id")
      .eq("vendor_call_id", params.callSid)
      .maybeSingle()
    if (findError) {
      return { success: false, error: findError.message }
    }
    if (!callRow) {
      // A signed callback for a sid this ledger never recorded — reported, not
      // swallowed, so the route can log it.
      return { success: false, error: `no voice_calls row carries vendor_call_id ${params.callSid}` }
    }

    const voiceUpdate: Record<string, unknown> = {}
    const status = mapTwilioCallStatus(params.status)
    if (status) voiceUpdate.status = status
    // CallDuration only arrives on the terminal callback. The deleted action
    // wrote `params.duration ?? null`, which would have NULLED a recorded
    // duration on any callback that arrived after the terminal one — only
    // write the column when this callback actually carries a reading.
    if (params.duration != null && Number.isFinite(params.duration)) {
      voiceUpdate.duration_seconds = params.duration
    }
    if (params.outcome) {
      const outcome = params.outcome.trim().toLowerCase().replace(/-/g, "_")
      if (VALID_OUTCOME.includes(outcome)) voiceUpdate.outcome = outcome
    }
    if (Object.keys(voiceUpdate).length === 0) {
      return { success: true } // nothing this callback can honestly write
    }

    // §3: an UPDATE that matches nothing also resolves with a null error, so
    // .select() the write and COUNT what came back. Zero rows here means the
    // row this function just located is gone — a failure, and somebody is told.
    const { data: updated, error } = await svc
      .from("voice_calls")
      .update(voiceUpdate)
      .eq("id", callRow.id)
      .select("id")
    if (error) {
      return { success: false, error: error.message }
    }
    if (!updated || updated.length === 0) {
      return { success: false, error: `voice_calls ${callRow.id} vanished between lookup and update` }
    }

    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) }
  }
}
