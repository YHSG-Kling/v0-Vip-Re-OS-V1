// app/actions/voice-assistant/core/dispatch-command.ts
// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM 6.1 — Command Dispatcher. INTERNAL ONLY.
//
// THIS FILE USED TO BE `'use server'`. That made `dispatchCommand` a SECOND public
// HTTP endpoint sitting behind handleVoiceCommand's front door — Next.js turns every
// exported async function in a `'use server'` module into its own POST-able action.
// The dispatcher does no session lookup, no authority check and no readiness check, so
// anyone who could reach the app could POST
//
//     { target_action: 'admin_override_financial_gate',
//       parameters: { buyer_id, user_id: <any uuid>, reason: '...' } }
//
// and reach the buyer financial-gate override with a self-declared admin id, entirely
// bypassing the governed lane. `grep -rn dispatchCommand` finds exactly one in-repo
// caller — handleVoiceCommand — so the door had no legitimate traffic on it at all.
//
// It is now a plain server-only module. `handleVoiceCommand` (which IS `'use server'`)
// imports it exactly as before; nothing else can address it. ONE governed path.
//
// IDENTITY IS INJECTED, NEVER ACCEPTED — the owner's ruling:
//
//   "anytime there is someone using voice, they are not going to know what their id
//    is so there has to be another way to check who the user is"
//
// So `identity` is a REQUIRED, SEPARATE argument that the caller resolves from the
// session, and every identity-bearing key is STRIPPED out of `parameters` and
// `entities` before they are merged. `entities` in particular is LLM output parsed
// from a spoken sentence — untrusted by construction. The old merge was
// `{ ...parameters, ...entities }` with entities LAST, which meant a voice-extracted
// entity named `user_id` silently OVERWROTE the session identity handleVoiceCommand
// had just injected; via COMMAND_MAP's `user_id → adminId` mapping that spoken value
// became the admin who overrides a financial gate. Identity is now applied AFTER both
// spreads, so nothing the model produced can displace it.

import "server-only"

import { COMMAND_MAP } from '../helpers/command-map'
import { COMMAND_EXECUTORS } from '../helpers/command-executors'

export interface DispatchResult {
  success: boolean
  result?: any
  error?: string
}

/** The session-resolved actor. Never assembled from caller input. */
export interface DispatchIdentity {
  /** users.id of the authenticated speaker. */
  userId: string
  /** The speaker's brokerage — the tenant every downstream read is scoped to. */
  brokerageId: string
  /** users.user_type, resolved from the session (never a spoken word). */
  role: string
}

export interface DispatchCommandRequest {
  target_system: string
  target_action: string
  /** Intent parameters. Identity keys here are DISCARDED. */
  parameters: Record<string, any>
  /** LLM-extracted entities. Untrusted. Identity keys here are DISCARDED. */
  entities: Record<string, any>
  /** Resolved by the caller from the authenticated session. Required. */
  identity: DispatchIdentity
}

/**
 * Every spelling of "who am I" that any executor or param_mapping in this lane reads.
 * Anything on this list is removed from caller-controlled input before the merge, so
 * the only way these keys can hold a value downstream is the injection below.
 */
const IDENTITY_KEYS = new Set([
  'user_id', 'userId',
  'agent_id', 'agentId',
  'admin_id', 'adminId',
  'lender_id', 'lenderId',
  'brokerage_id', 'brokerageId',
  'role', 'user_role',
])

/** Copy of `src` with every identity-bearing key dropped. Never mutates `src`. */
function stripIdentity(src: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(src ?? {})) {
    if (IDENTITY_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Dispatch a command to its system action.
 *
 * INTERNAL. Only handleVoiceCommand calls this, and only after it has resolved the
 * session, validated the authority matrix, and validated business readiness.
 */
export async function dispatchCommand(request: DispatchCommandRequest): Promise<DispatchResult> {
  const { target_action, parameters, entities, identity } = request

  // Fail closed. A dispatcher with no resolved actor must not run anything — this is
  // the invariant the `'use server'` version could not state.
  if (!identity?.userId || !identity?.brokerageId) {
    return { success: false, error: 'Unauthorized: no resolved identity for dispatch' }
  }

  try {
    // Resolve the param-mapping (for buildActionParams) + the STATIC executor (bundled +
    // build-validated, unlike the old runtime-string import that never resolved on Vercel).
    const mapping = COMMAND_MAP[target_action as keyof typeof COMMAND_MAP]
    const executor = COMMAND_EXECUTORS[target_action as keyof typeof COMMAND_EXECUTORS]

    if (!mapping || !executor) {
      return {
        success: false,
        error: `Command "${target_action}" not mapped to a system action`
      }
    }

    // Build parameters for the action (apply the voice → action param mapping).
    const actionParams = buildActionParams(
      parameters,
      entities,
      identity,
      mapping.param_mapping
    )

    // Execute the action (static import — actually runs on Vercel).
    const result = await executor(actionParams)

    return {
      success: result?.success !== false,
      result,
      error: result?.error
    }

  } catch (error) {
    console.error('[dispatch-command] Error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Command execution failed'
    }
  }
}

/**
 * Build action parameters from voice command data. Module-private on purpose — an
 * exported helper here would be a new orphan export, and this is only ever the second
 * half of dispatchCommand.
 *
 * Order matters and is the whole point:
 *   1. strip identity out of `parameters` (intent output)
 *   2. strip identity out of `entities` (LLM output — the spoken sentence)
 *   3. merge, entities still last so a resolved entity beats a stale parameter
 *   4. apply the SESSION identity last, so neither can displace it
 *   5. only then run COMMAND_MAP's param_mapping, which renames the snake-case
 *      identity onto whatever each action calls it (`user_id → adminId`, etc.)
 *
 * Exported for the guard/simulator scripts; it is pure and does no I/O.
 */
function buildActionParams(
  parameters: Record<string, any>,
  entities: Record<string, any>,
  identity: DispatchIdentity,
  paramMapping?: Record<string, string>
): Record<string, any> {
  const params: Record<string, any> = {
    ...stripIdentity(parameters),
    ...stripIdentity(entities),
  }

  // INJECT — after both spreads, so the session wins unconditionally. Snake-case
  // because that is what COMMAND_MAP's param_mapping keys on; the mapping below
  // renames it to each action's own spelling.
  params.user_id = identity.userId
  params.brokerage_id = identity.brokerageId
  params.role = identity.role

  // Apply parameter mapping if provided
  if (paramMapping) {
    for (const [voiceParam, actionParam] of Object.entries(paramMapping)) {
      if (params[voiceParam]) {
        params[actionParam] = params[voiceParam]
        if (actionParam !== voiceParam) {
          delete params[voiceParam]
        }
      }
    }
  }

  return params
}
