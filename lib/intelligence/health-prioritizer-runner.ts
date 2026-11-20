// lib/intelligence/health-prioritizer-runner.ts
//
// Live side of health reprioritization — compute each contact's relationship health from real
// signals (last inbound reply, reply rate, touch cadence, enrichment freshness) and return the work
// list ranked most-at-risk-first, so the team works the right client first. Read-only.
//
// WAVE 148 (148Z): FAILS CLOSED. This used to say "never throws" and dropped both reads' `{ error }` — a refused
// contacts read returned `[]`, which the one intent interface (C17 contact_care_scan) spoke as "everyone looks well
// looked-after", and a refused executions read ranked everyone as never-replied. A refused read now THROWS
// HealthReadRefusedError (CLAUDE.md §4 — "nobody checked" never renders as "checked and fine"). Every caller already
// runs it inside a try/catch (morning-standup, the steer-my-day action, the voice tool dispatcher, both crons) or, for
// C17, catches it and says the refusal (lib/voice-admin/intent-interface-live.ts contact_care_scan).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { prioritizeByHealth, type HealthRankedItem } from "./relationship-health"

type Svc = ReturnType<typeof createServiceClient>

/** A ranking read the database refused — never ranked as "everyone is fine". */
export class HealthReadRefusedError extends Error {
  readonly table: string
  constructor(table: string, detail: string) {
    super(`relationship-health ranking could not read ${table}: ${detail}`)
    this.name = "HealthReadRefusedError"
    this.table = table
  }
}

const DAY = 86_400_000

export async function getHealthPrioritizedContacts(
  svc: Svc, brokerageId: string, opts?: { limit?: number; agentId?: string; now?: string },
): Promise<HealthRankedItem[]> {
  const nowMs = new Date(opts?.now ?? new Date().toISOString()).getTime()
  let q = svc.from("contacts")
    .select("id, last_contacted_at, last_enriched_at")
    .eq("brokerage_id", brokerageId)
    .neq("status", "archived")
    .limit(opts?.limit ?? 200)
  if (opts?.agentId) q = q.eq("agent_id", opts.agentId)
  const { data: contacts, error: contactsError } = await q
  if (contactsError) throw new HealthReadRefusedError("contacts", contactsError.message)
  const rows = (contacts ?? []) as any[]
  if (rows.length === 0) return []

  // Batch-load step executions for these contacts → last inbound reply + sent/reply counts.
  const ids = rows.map((c) => c.id)
  const { data: execs, error: execsError } = await svc
    .from("sequence_step_executions")
    .select("contact_id, status, replied_at")
    .in("contact_id", ids)
    .limit(20_000)
  if (execsError) throw new HealthReadRefusedError("sequence_step_executions", execsError.message)
  const byContact = new Map<string, { sent: number; replies: number; lastInbound: string | null }>()
  for (const e of (execs ?? []) as any[]) {
    if (!e.contact_id) continue
    const agg = byContact.get(e.contact_id) ?? { sent: 0, replies: 0, lastInbound: null }
    if ((e.status ?? "") === "sent") agg.sent++
    if (e.replied_at) { agg.replies++; if (!agg.lastInbound || e.replied_at > agg.lastInbound) agg.lastInbound = e.replied_at }
    byContact.set(e.contact_id, agg)
  }

  const daysSince = (iso: string | null | undefined): number | null => {
    if (!iso) return null
    const t = new Date(iso).getTime()
    return Number.isFinite(t) ? Math.floor((nowMs - t) / DAY) : null
  }

  const items = rows.map((c) => {
    const agg = byContact.get(c.id)
    return {
      contactId: c.id as string,
      input: {
        daysSinceLastInbound: daysSince(agg?.lastInbound),
        replyRate: agg && agg.sent > 0 ? agg.replies / agg.sent : null,
        daysSinceLastTouch: daysSince(c.last_contacted_at),
        enrichmentAgeDays: daysSince(c.last_enriched_at),
      },
    }
  })
  return prioritizeByHealth(items)
}
