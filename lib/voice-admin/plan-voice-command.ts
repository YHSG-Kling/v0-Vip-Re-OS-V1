// lib/voice-admin/plan-voice-command.ts
// ─────────────────────────────────────────────────────────────────────────────
// VOICE IN → A GOVERNED, ATTRIBUTED PLAN ON THE EGRESS.
//
// The direct lane (handleVoiceCommand → COMMAND_EXECUTORS) runs one verb now, and
// keeps doing that. This is the KERNEL lane: an utterance that names several
// capabilities becomes a PLAN, each step attributed to the manager whose charter owns
// it, dispatched as a governed signal rather than an inline call.
//
// Why dispatch instead of execute — the whole differentiator in one paragraph: an
// inline call is three unattributed function invocations with no approval trail and
// nobody accountable if one of them was wrong. The same instruction on the egress is
// three manager signals a broker can see, attribute, and override, and each one lands
// in the domain of the manager that would have done it anyway. A single-assistant
// product cannot do this — not because it lacks a feature, but because it has no
// manager bus to dispatch onto.
//
// NOTHING MUTATING RUNS WITHOUT A YES. buildVoicePlan marks a mutating step
// needs_confirmation, and only a second call carrying confirmed:true dispatches it.
// The plan is therefore safe to build eagerly — building it is how the voice admin
// knows what to say.
//
// Never throws: a voice surface that 500s mid-sentence is worse than one that says
// it could not tell.
//
// ── THE DOOR (orphan burn-down) ───────────────────────────────────────────────
// Both exports below were built complete and referenced by NOTHING, so this whole
// lane — the differentiator lib/kernel/manager-registry.ts:voice_kernel_command_surface
// describes — had no way in. It does now: app/api/agentic-os/voice/route.ts (POST).
//
// THAT DIRECTORY, not a page, because this module's authority source IS the Agentic
// API's: `authorizedActions` over `buildAppActionManifest`, resolved by
// `resolveAgenticCaller`. /api/agentic-os/actions answers "what may this caller do",
// /api/agentic-os/mcp exposes it as tools, and the new route turns a sentence into a
// plan over the same manifest. A different gate would have meant a second authority
// answer for the same capabilities.
//
// ONE HONEST LIMIT, REPORTED RATHER THAN PAPERED OVER: `resolveAgenticCaller` grants
// scopes to an agent TOKEN (from the credential) and to PLATFORM STAFF (`["*"]`), and
// grants a plain tenant session NONE. So a broker signing in today gets a plan whose
// every step reads "You are not able to … from this account" — which is the true
// answer from the scope machinery, not a bug in this file. Widening it is a change to
// lib/agentic-os/agent-credentials.ts, which this lane does not own.
//
// The route also refuses a BEARER TOKEN outright: `spoken_by` below is a users.id and
// the same id goes to the capability resolver as `agentUserId`, and a credential has
// no human behind it. `agents.id` and `users.id` are disjoint spaces, so there is no
// id to substitute that would not be a lie in the audit trail.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { resolveAllAppCapabilities, blockExplanation } from "@/lib/agentic-os/resolve-app-capability"
import { authorizedActions } from "@/lib/agentic-os/agent-scopes"
import { buildAppActionManifest, type AppCapability } from "@/lib/agentic-os/app-capability-registry"
import {
  buildVoicePlan, matchIntents, humanManager, VOICE_COMMAND_SIGNAL,
  type VoicePlan, type PlanStep,
} from "./kernel-command-surface"

// Re-exported so existing callers importing it from the planner keep working.
export { VOICE_COMMAND_SIGNAL }

export interface PlanVoiceCommandInput {
  utterance: string
  brokerageId: string
  /** users.id of the speaker — authority is resolved from their scopes. */
  userId: string
  agentId?: string
  /** The caller's granted scopes (agent token or session). */
  scopes: readonly string[]
  /** True on the second turn, after the speaker said yes. */
  confirmed?: boolean
}

export interface PlanVoiceCommandResult {
  plan: VoicePlan
  /** Steps actually dispatched onto the egress (only on a confirmed turn). */
  dispatched: Array<{ capability: AppCapability; manager: string; signalId?: string }>
  /** Dispatches that FAILED — surfaced, never silently absent. */
  failed: Array<{ capability: AppCapability; reason: string }>
  error: string | null
}

/**
 * Plan an utterance, and dispatch its ready steps when the speaker has confirmed.
 *
 * Operability comes from the capability contract (resolveAllAppCapabilities), so the
 * voice admin refuses a dark capability BEFORE promising anything — "I cannot post to
 * Instagram yet, you have not connected an account" instead of accepting the command
 * and failing inside it. Authorization comes from the same scope machinery the Agentic
 * API uses, so voice cannot reach further than a token could.
 */
export async function planVoiceCommand(
  input: PlanVoiceCommandInput,
): Promise<PlanVoiceCommandResult> {
  const result: PlanVoiceCommandResult = {
    plan: { utterance: input.utterance, steps: [], actionable: false, awaitingConfirmation: 0, spokenSummary: "" },
    dispatched: [], failed: [], error: null,
  }

  try {
    // Nothing named → nothing to resolve. Skip the DB work entirely; a mis-heard
    // sentence must not cost a readiness scan.
    const intents = matchIntents(input.utterance)
    if (intents.length === 0) {
      result.plan = buildVoicePlan(input.utterance, { operable: {}, authorized: {} })
      return result
    }

    // ── Operability + authorization, in parallel ──────────────────────────────
    const operable: Partial<Record<AppCapability, boolean>> = {}
    const blockReason: Partial<Record<AppCapability, string>> = {}
    const authorized: Partial<Record<AppCapability, boolean>> = {}

    const [resolutions] = await Promise.all([
      resolveAllAppCapabilities({
        brokerageId: input.brokerageId,
        agentId: input.agentId,
        agentUserId: input.userId,
      }),
    ])
    for (const r of resolutions) {
      operable[r.capability] = r.operable
      const why = blockExplanation(r)
      if (why) blockReason[r.capability] = why
    }

    // Scope check through the SAME machinery the Agentic API uses — a spoken command
    // must never reach further than a token could.
    const allowedActions = new Set(
      authorizedActions(buildAppActionManifest(), input.scopes as string[]).map((a) => a.capability),
    )
    for (const i of intents) authorized[i.capability] = allowedActions.has(i.capability)

    const plan = buildVoicePlan(input.utterance, {
      operable, authorized, blockReason, confirmed: input.confirmed,
    })
    result.plan = plan

    // ── Dispatch, only what is ready ─────────────────────────────────────────
    if (!input.confirmed) return result

    const svc = createServiceClient()
    for (const step of plan.steps.filter((s) => s.disposition === "ready")) {
      const published = await publishManagerSignal({
        brokerageId: input.brokerageId,
        // The Cron Manager is the operations seat: it is what CARRIES a human's
        // spoken instruction onto the bus. Attributing the dispatch to the receiving
        // manager itself would make the signal self-routed and lose who asked.
        fromManager: step.manager === "cron_manager" ? "data_steward" : "cron_manager",
        toManager: step.manager,
        signalType: VOICE_COMMAND_SIGNAL,
        message: `Voice command from the broker: ${step.matchedPhrase}. ${step.say}`,
        entityType: "voice_command",
        // entity_id is a uuid column; a capability name is not one, so it travels in
        // the payload (the lesson from the capability-dark loop).
        entityId: null,
        payload: {
          capability: step.capability,
          utterance: input.utterance,
          matched_phrase: step.matchedPhrase,
          mutates: step.mutates,
          spoken_by: input.userId,
          scope: step.capability,
        },
        dedupe: false,
      }, svc)

      if (published.ok) {
        result.dispatched.push({
          capability: step.capability,
          manager: humanManager(step.manager),
          signalId: published.signalId,
        })
      } else {
        // Counted and returned. A dispatch that fails silently would have the voice
        // admin say "on it" about work nobody received.
        result.failed.push({ capability: step.capability, reason: published.reason ?? "publish failed" })
      }
    }

    // The spoken line must match what actually happened, not what was planned.
    if (result.failed.length > 0) {
      result.plan = {
        ...plan,
        spokenSummary:
          `${result.dispatched.length > 0 ? `${plan.spokenSummary} ` : ""}` +
          `I could not hand off ${result.failed.length} of those — nothing was lost, but they did not start.`,
      }
    }

    return result
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    // Say something true rather than nothing.
    result.plan = {
      ...result.plan,
      spokenSummary: "Something went wrong working that out, so I did not start anything.",
    }
    return result
  }
}

/** PURE-ish helper for the UI: the plan as lines a human can read. */
export function planLines(plan: VoicePlan): Array<{ text: string; step: PlanStep }> {
  return plan.steps.map((step) => ({ text: step.say, step }))
}
