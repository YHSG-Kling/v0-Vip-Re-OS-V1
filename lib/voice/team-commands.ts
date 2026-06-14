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

/** The read-only bullpen commands this dispatcher currently routes. */
export const TEAM_COMMANDS = new Set<string>(["team_query", "area_query", "morning_standup"])

export function isTeamCommand(name: string): boolean {
  return TEAM_COMMANDS.has(name)
}

/**
 * Route a team-coordination command to its kernel backend. Read-only — composes a spoken answer
 * from what each manager's own tables know. Throws on an unknown name (callers gate on isTeamCommand).
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
    default:
      throw new Error(`Unknown team command: ${name}`)
  }
}
