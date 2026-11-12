// ─── VOICE → MANAGER BUS (the ElevenLabs voice admin joins the one command center) ──
// The text command bar's actions already surface as accountable manager work; the
// ElevenLabs voice overlay's ACTING tools (create_task / log_activity / send_portal_message)
// ran as silent direct CRUD — invisible to the Command Center. This surfaces every such
// voice action on the manager-signals "managers talking" feed as a real, attributed entry:
// the OWNING manager of the action announces it ON THE RECORD to the Data Steward (or to
// the Deal Coordinator when the owner IS the Data Steward). Visibility-only (feed_only) —
// it never triggers an automated consumer; it just makes the voice admin accountable.

import type { ManagerKey } from "@/lib/kernel/manager-registry"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { VOICE_TOOL_MANAGER } from "@/lib/voice/tool-registry"

export type VoiceActionTool =
  | "create_task" | "log_activity" | "send_portal_message" | "accept_offer"
  // Round 36 — the closed voice lanes announce on the same bus:
  | "reject_offer" | "counter_offer" | "withdraw_offer"
  | "convert_lead" | "reassign_contact" | "broadcast_announcement" | "stage_showing"

/** PURE: the manager who OWNS a voice action (the "from" on the bus).
 *  TOMBSTONE (wave 138E): the per-tool switch that lived here MOVED to the one tool → manager table,
 *  VOICE_TOOL_MANAGER (lib/voice/tool-registry.ts), which the assistant reach matrix also reads — two
 *  copies of "who owns this tool" would drift (CLAUDE.md §6). Same answers, typed exhaustive over the union. */
export function ownerManagerForVoiceAction(tool: VoiceActionTool): ManagerKey {
  return VOICE_TOOL_MANAGER[tool]
}

/**
 * PURE: the bus route for a voice action — the owning manager records it with the Data
 * Steward (the on-the-record keeper), or with the Deal Coordinator when the owner already
 * IS the Data Steward. from !== to always holds (required by validSignalRoute).
 */
export function voiceBusRoute(owner: ManagerKey): { from: ManagerKey; to: ManagerKey } {
  const to: ManagerKey = owner === "data_steward" ? "deal_coordinator" : "data_steward"
  return { from: owner, to }
}

/**
 * Surface a COMPLETED voice action on the manager bus (feed-only). Best-effort — never
 * throws, never blocks the tool result. The action already happened; this only makes it
 * visible + attributed in the Command Center's "managers talking" feed.
 */
export async function surfaceVoiceActionOnBus(
  input: {
    brokerageId: string
    tool: VoiceActionTool
    message: string
    entityType?: string | null
    entityId?: string | null
    contactId?: string | null
    payload?: Record<string, unknown>
  },
  client?: Parameters<typeof publishManagerSignal>[1],
): Promise<void> {
  if (!input.brokerageId) return
  const owner = ownerManagerForVoiceAction(input.tool)
  const { from, to } = voiceBusRoute(owner)
  try {
    await publishManagerSignal(
      {
        brokerageId: input.brokerageId,
        fromManager: from,
        toManager: to,
        signalType: "voice_action",
        message: input.message,
        entityType: input.entityType ?? "voice_command",
        entityId: input.entityId ?? null,
        contactId: input.contactId ?? null,
        payload: { tool: input.tool, ...(input.payload ?? {}) },
        dedupe: false, // every spoken action is a distinct event on the feed
      },
      client,
    )
  } catch { /* visibility is best-effort — the action already succeeded */ }
}
