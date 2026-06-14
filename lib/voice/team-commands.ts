// lib/voice/team-commands.ts
//
// SHARED TEAM-COMMAND DISPATCHER — the one place the AI-team coordination commands are mapped to
// their kernel backends, so BOTH voice front-ends call the SAME logic instead of drifting:
//   • the ElevenLabs Conv AI spoken admin  (app/api/agent-assistant/tool-call/route.ts)
//   • the internal voice-command route      (app/api/internal/voice-command/route.ts)
//
// These commands let an agent talk to the whole AI team — "Hey team, what do you know about the
// Hendersons?" / "anything happening near 44 Birch?" / "what should I do today?". Each one fans the
// question across the manager bench (AI ISA, Shopping Agent, Deal Coordinator, Asset Manager, Ads
// Manager, …) and returns ONE manager-attributed spoken answer. Read-only — no compliance gates
// beyond authority; the registry (lib/voice/tool-registry.ts) marks them gates:[].

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface TeamCommandCtx {
  brokerageId: string
  agentUserId: string
  firstName?: string | null
}

export interface TeamCommandResult {
  ok: boolean
  /** The single spoken answer the voice admin reads back. */
  spoken: string
  data?: Record<string, unknown>
}

/** The read-only bullpen commands. */
export const TEAM_QUERY_COMMANDS = new Set<string>(["team_query", "area_query", "morning_standup"])

/** The ACTING commands — each delegates to a backend that enforces its own gate
 *  (proposal→approval + consent re-check for follow-ups; Fair Housing pre-flight for promos;
 *  per-step compliance for marketing enrollment; stand-up items routed to their rail). */
export const TEAM_ACTION_COMMANDS = new Set<string>(["standup_action", "voice_followup", "start_marketing", "cut_promo"])

/** All team-coordination commands this dispatcher routes (read-only + acting). */
export const TEAM_COMMANDS = new Set<string>([...TEAM_QUERY_COMMANDS, ...TEAM_ACTION_COMMANDS])

export function isTeamCommand(name: string): boolean {
  return TEAM_COMMANDS.has(name)
}

/** Resolve a contactId from a structured contact_id param, else from a spoken person name via the
 *  team-query resolver (so both front-ends work — ElevenLabs passes ids, the spoken route passes names). */
async function resolveContactId(params: Record<string, unknown>, brokerageId: string, svc: Svc): Promise<{ contactId: string | null; spoken?: string }> {
  const explicit = params.contact_id ? String(params.contact_id) : null
  if (explicit) return { contactId: explicit }
  const personQuery = String(params.person_query ?? params.query ?? "").trim()
  if (!personQuery) return { contactId: null, spoken: "Who is that for? Give me the name and I'll take it from there." }
  const { runTeamQuery } = await import("@/lib/kernel/team-query")
  const tq = await runTeamQuery(brokerageId, personQuery, {}, svc)
  return tq.found && tq.contactId ? { contactId: tq.contactId } : { contactId: null, spoken: tq.spoken }
}

/**
 * Route a team-coordination command to its kernel backend. Read-only commands compose a spoken
 * answer; ACTING commands delegate to backends that enforce their own compliance gate (the
 * proposal→approval gate re-checks consent — nothing here sends autonomously). Throws on an
 * unknown name (callers gate on isTeamCommand).
 */
export async function dispatchTeamCommand(
  name: string,
  params: Record<string, unknown>,
  ctx: TeamCommandCtx,
  client?: Svc,
): Promise<TeamCommandResult> {
  const svc = client ?? createServiceClient()

  switch (name) {
    case "team_query": {
      const { runTeamQuery } = await import("@/lib/kernel/team-query")
      const r = await runTeamQuery(ctx.brokerageId, String(params.person_query ?? params.query ?? ""), {}, svc)
      return { ok: true, spoken: r.spoken, data: { contactId: r.contactId, contactName: r.contactName, contributions: r.contributions } }
    }
    case "area_query": {
      const { runAreaQuery } = await import("@/lib/kernel/area-query")
      const r = await runAreaQuery(ctx.brokerageId, String(params.area_query ?? params.query ?? ""), svc)
      return { ok: true, spoken: r.spoken, data: { area: r.area, contributions: r.contributions } }
    }
    case "morning_standup": {
      const { runMorningStandup } = await import("@/lib/kernel/morning-standup")
      const r = await runMorningStandup(ctx.brokerageId, ctx.agentUserId, { firstName: ctx.firstName ?? null }, svc)
      return { ok: true, spoken: r.spoken, data: { items: r.items } }
    }

    // ── Acting verbs — the team DOES what you say (each backend enforces its own gate) ──
    case "standup_action": {
      // "Knock out number two" — re-derive the stand-up live and act on item N through its rail
      // (approval → the gate as the agent; reengage → follow-up; fire → never auto-resolved).
      const ordinal = Number(params.ordinal ?? 0)
      if (!ordinal) return { ok: false, spoken: "Which one — number one, two, or three? Say the rank and I'll knock it out." }
      const { runStandupAction } = await import("@/lib/kernel/standup-action")
      const r = await runStandupAction({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, ordinal, firstName: ctx.firstName ?? null }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { ordinal, actedKind: r.actedKind ?? null, entityId: r.entityId ?? null } }
    }
    case "voice_followup": {
      // "Send the Hendersons a follow-up" — propose→approve AS the agent through the SAME gate
      // (consent re-checked). Nothing sends until approved; dictation is carried verbatim.
      const resolved = await resolveContactId(params, ctx.brokerageId, svc)
      if (!resolved.contactId) return { ok: false, spoken: resolved.spoken ?? "Who is that for?" }
      const dictation = params.dictation ? String(params.dictation) : null
      const { voiceFollowUp } = await import("@/lib/kernel/voice-delegation")
      const r = await voiceFollowUp({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, contactId: resolved.contactId, dictation }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { contactId: resolved.contactId, messageId: r.messageId ?? null } }
    }
    case "start_marketing": {
      // "Start marketing for them" — enroll in the best active sequence; each step clears its gate.
      const resolved = await resolveContactId(params, ctx.brokerageId, svc)
      if (!resolved.contactId) return { ok: false, spoken: resolved.spoken ?? "Who is that for?" }
      const { voiceStartMarketing } = await import("@/lib/kernel/voice-delegation")
      const r = await voiceStartMarketing({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, contactId: resolved.contactId }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { contactId: resolved.contactId, enrollmentId: r.enrollmentId ?? null } }
    }
    case "cut_promo": {
      // "Cut a promo reel for 44 Birch" — manual trigger on the canonical Remotion + D-ID rail
      // (Fair Housing pre-flight, cooldown debounce, social drafts still human-approved).
      const addressQuery = String(params.address_query ?? params.query ?? "").trim()
      if (!addressQuery) return { ok: false, spoken: "Which listing? Give me the street number and name and I'll cut the reel." }
      const { voiceCutPromo } = await import("@/lib/kernel/voice-delegation")
      const r = await voiceCutPromo({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, addressQuery }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { addressQuery } }
    }

    default:
      throw new Error(`Unknown team command: ${name}`)
  }
}
