// app/api/agentic-os/voice/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE KERNEL VOICE LANE'S DOOR. An utterance in, a GOVERNED PLAN out — and, on a
// confirmed turn, one manager signal per step on the egress.
//
// `lib/voice-admin/plan-voice-command.ts` was built complete and left with no
// caller: `planVoiceCommand` and its UI helper `planLines` were referenced by
// nothing in the tree, so the entire multi-step, manager-attributed voice lane —
// the thing lib/kernel/manager-registry.ts:voice_kernel_command_surface describes
// as the differentiator a single-assistant product cannot copy — had no way in.
// The DIRECT lane (`handleVoiceCommand` → COMMAND_EXECUTORS, one verb, wired to
// app/dashboard/voice/VoiceCommandCenterClient.tsx) is untouched and stays the
// front door for a single command.
//
// WHY HERE AND NOT A PAGE. The planner's own docblock names its authority source:
// "the same scope machinery the Agentic API uses, so voice cannot reach further
// than a token could". That machinery is `resolveAgenticCaller`, and this
// directory is where it lives — /api/agentic-os/actions discovers what a caller
// may do, /api/agentic-os/mcp exposes it as tools, and this turns a sentence into
// a plan over the same manifest. Putting the planner behind a different gate would
// have meant a second authority answer for the same capabilities.
//
// TWO REFUSALS THAT ARE DELIBERATE, not gaps:
//
//   · A BEARER TOKEN CANNOT SPEAK. `planVoiceCommand` records `spoken_by` (a
//     users.id) on every dispatched signal and passes the same id as
//     `agentUserId` to the capability resolver. An agent credential has a
//     brokerage but no human behind it, and `agents.id` / `users.id` are DISJOINT
//     id spaces — so there is no id to substitute that would not be a lie in the
//     audit trail. Token callers are refused with that reason rather than
//     dispatched anonymously.
//   · THE SPEAKER IS NEVER IN THE BODY. `userId`, `agentId` and `brokerageId` all
//     come from the session; the request supplies only what was SAID. A voice
//     surface is exactly where a caller-supplied identity is most tempting and
//     least defensible — the person talking does not know their uuid, so any id
//     on the wire was invented upstream or hallucinated out of the sentence.
//
// CONFIRMATION IS A SECOND REQUEST, and that is the planner's rule, not this
// route's: buildVoicePlan marks a mutating step `needs_confirmation`, and only a
// call carrying `confirmed: true` dispatches. So a first POST is always safe to
// make — building the plan is how the voice admin knows what to say.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { resolveAgenticCaller } from "@/lib/agentic-os/agent-credentials"
import { planVoiceCommand, planLines } from "@/lib/voice-admin/plan-voice-command"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  // Scopes first. This is the ONLY authority answer in this file — everything
  // below either narrows it or refuses.
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return NextResponse.json(
      { error: "Unauthenticated — sign in to speak a command" },
      { status: 401 },
    )
  }
  if (caller.via === "token") {
    return NextResponse.json(
      {
        error:
          "A spoken command needs a speaker. This endpoint attributes every dispatched " +
          "step to the human who asked, and an agent credential has no human behind it. " +
          "Use /api/agentic-os/actions to invoke a capability with a token.",
      },
      { status: 403 },
    )
  }

  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 })
  }
  const utterance =
    typeof (body as { utterance?: unknown })?.utterance === "string"
      ? ((body as { utterance: string }).utterance).trim()
      : ""
  if (!utterance) {
    return NextResponse.json({ error: "Nothing was said — `utterance` is required" }, { status: 400 })
  }
  const confirmed = (body as { confirmed?: unknown })?.confirmed === true

  // Never throws by contract — a voice surface that 500s mid-sentence is worse
  // than one that says it could not tell. Its `error` field carries anything it
  // could not do, and it is passed through below rather than swallowed.
  const result = await planVoiceCommand({
    utterance,
    brokerageId: auth.brokerageId,
    userId: auth.userId,
    // agents.id, resolved by requireAuth from agents.user_id — NOT the users.id
    // above. The two spaces are disjoint and the capability resolver keys on the
    // agents one.
    agentId: auth.agentId ?? undefined,
    scopes: caller.scopes,
    confirmed,
  })

  return NextResponse.json({
    utterance,
    confirmed,
    // The spoken line, and the same plan as lines a human can read — one entry per
    // step, in the order the planner produced them.
    spokenSummary: result.plan.spokenSummary,
    lines: planLines(result.plan).map((l) => ({
      text: l.text,
      capability: l.step.capability,
      manager: l.step.manager,
      disposition: l.step.disposition,
      mutates: l.step.mutates,
    })),
    actionable: result.plan.actionable,
    awaitingConfirmation: result.plan.awaitingConfirmation,
    dispatched: result.dispatched,
    // Surfaced, never silently absent: a dispatch that failed quietly would have
    // the voice admin say "on it" about work nobody received.
    failed: result.failed,
    error: result.error,
  })
}
