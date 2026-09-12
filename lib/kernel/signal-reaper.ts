// lib/kernel/signal-reaper.ts
// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL REAPER (server) — closes the "signals falling through the cracks" gap. The dispatcher leaves
// any signal whose handler returned null / threw / is missing in "open" forever. This sweeps stuck
// OPEN signals and resolves every one: a HANDLED handoff past its window is escalated to the
// responsible human (a real task that didn't complete is never silently lost) then expired; a
// FEED_ONLY signal past its TTL is expired quietly. After this runs, the invariant holds: no signal
// stays open beyond its window. Best-effort per signal; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { signalSpec } from "./signal-registry"
import { shouldReapSignal, shouldAutoReplaySignal, MAX_HANDLED_OPEN_HOURS, FEED_ONLY_TTL_HOURS } from "./signal-reaper-policy"
import { publishManagerSignal } from "./manager-signals"
import type { ManagerKey } from "./manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export interface ReapResult { scanned: number; expired: number; escalated: number; replayed: number }

export async function reapStuckManagerSignals(brokerageId: string, client?: Svc): Promise<ReapResult> {
  const svc = client ?? createServiceClient()
  const result: ReapResult = { scanned: 0, expired: 0, escalated: 0, replayed: 0 }
  if (!brokerageId) return result

  const now = Date.now()
  // Only consider signals older than the SMALLER window (anything younger can't be reapable yet).
  const minWindowHours = Math.min(MAX_HANDLED_OPEN_HOURS, FEED_ONLY_TTL_HOURS)
  const sinceIso = new Date(now - minWindowHours * 3_600_000).toISOString()

  const { data } = await svc
    .from("manager_signals")
    .select("id, signal_type, from_manager, to_manager, message, entity_type, entity_id, contact_id, payload, created_at")
    .eq("brokerage_id", brokerageId).eq("status", "open")
    .lt("created_at", sinceIso)
    .order("created_at", { ascending: true }).limit(500)

  for (const row of (data ?? []) as Array<{
    id: string; signal_type: string; from_manager: string; to_manager: string; message: string | null
    entity_type: string | null; entity_id: string | null; contact_id: string | null
    payload: Record<string, unknown> | null; created_at: string
  }>) {
    result.scanned += 1
    const ageHours = (now - new Date(row.created_at).getTime()) / 3_600_000
    // Read through the registry's accessor. An UNCATALOGUED signal (signalSpec → undefined)
    // still reaps conservatively as "handled" — escalate to a human, never expire quietly.
    const disposition = signalSpec(row.signal_type)?.disposition ?? "handled"
    const action = shouldReapSignal({ ageHours, disposition })
    if (action === "keep") continue

    // ── AUTOMATIC DEAD-LETTER RETRY ──────────────────────────────────────────
    // A stalled handoff first gets a bounded number of automatic RE-HANDS to the addressed
    // manager (most stalls are a transient handler failure, not a genuinely stuck task).
    // Only after the retries are exhausted does it escalate to a human (below).
    const replays = Number((row.payload as Record<string, unknown> | null)?._replays ?? 0)
    if (shouldAutoReplaySignal({ action, replays })) {
      const republished = await publishManagerSignal({
        brokerageId,
        fromManager: row.from_manager as ManagerKey,
        toManager:   row.to_manager as ManagerKey,
        signalType:  row.signal_type,
        message:     row.message ?? "",
        entityType:  row.entity_type,
        entityId:    row.entity_id,
        contactId:   row.contact_id,
        payload:     { ...((row.payload as Record<string, unknown>) ?? {}), _replays: replays + 1, _replayedFrom: row.id },
        dedupe:      false,
      }, svc)
      if (republished.ok && republished.signalId !== row.id) {
        await svc.from("manager_signals")
          .update({ status: "expired", consumed_at: new Date().toISOString(), consumed_action: `auto-replayed (attempt ${replays + 1}/${2}) — re-handed to ${row.to_manager}` })
          .eq("id", row.id).eq("status", "open")
        result.replayed += 1
        continue
      }
      // republish failed → fall through to escalate + expire so the stall is never lost.
    }

    if (action === "expire_escalate") {
      // A real manager handoff didn't complete in time — alert the responsible human BEFORE expiring
      // so the task isn't silently dropped. Best-effort: if we can't resolve an owner, we still expire
      // (the reliability monitor surfaces systemic stalls).
      try {
        const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
        const agentUserId = await resolveResponsibleAgentUserId(svc, {
          recipient_contact_id: row.contact_id, entity_type: row.entity_type, entity_id: row.entity_id,
        })
        if (agentUserId) {
          await svc.from("notifications").insert({
            user_id: agentUserId, brokerage_id: brokerageId, type: "manager_handoff_stalled",
            title: "⚠️ A team handoff needs your hand",
            body: `${row.from_manager} → ${row.to_manager}: “${row.message ?? "a handoff"}” couldn't complete automatically. Take a look and handle it.`,
            entity_type: row.entity_type, entity_id: row.entity_id, priority: "high", is_read: false,
          })
          result.escalated += 1
        }
      } catch (e) {
        console.error("[signal-reaper] escalation failed:", e)
      }
    }

    const reason = action === "expire_escalate"
      ? "expired: handoff did not complete within window — escalated to a human"
      : "expired: feed display TTL reached"
    await svc.from("manager_signals")
      .update({ status: "expired", consumed_at: new Date().toISOString(), consumed_action: reason })
      .eq("id", row.id).eq("status", "open")
    result.expired += 1
  }

  return result
}
