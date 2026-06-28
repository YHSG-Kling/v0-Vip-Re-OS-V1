import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { consumeManagerSignals, SIGNAL_HANDLERS } from "@/lib/kernel/manager-signals"
import { publishIsaCallOutcomes } from "@/lib/ai-isa/voice-dial-batch"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

/**
 * MANAGER-SIGNALS cron (every 30 min) — the heartbeat of managers talking to one another.
 * Phase 1 PUBLISH: each producing manager announces fresh outcomes onto the bus (today:
 * AI ISA dial-call appointments → the side-appropriate concierge). Phase 2 CONSUME: every
 * addressed manager reads its open inbox and acts — always by proposing a governed
 * deliverable into the gate, never an autonomous send. Both phases idempotent.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "manager-signals",
    cron_path: "/app/api/cron/manager-signals/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let published = 0
  let consumed = 0
  let reaped = 0
  let escalated = 0

  try {
    // Brokerages with recent ISA appointments OR open signals.
    const [{ data: apptRows }, { data: openRows }] = await Promise.all([
      supabase.from("ai_isa_calls").select("brokerage_id").eq("appointment_set", true)
        .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).limit(2000),
      supabase.from("manager_signals").select("brokerage_id").eq("status", "open").limit(2000),
    ])
    const brokerages = Array.from(new Set([
      ...((apptRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id),
      ...((openRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id),
    ]))

    // The managers that have registered handlers (derived — adding a handler auto-joins).
    const consumers = Array.from(new Set(Object.keys(SIGNAL_HANDLERS).map((k) => k.split(":")[0]))) as ManagerKey[]

    for (const brokerageId of brokerages) {
      try {
        const p = await publishIsaCallOutcomes(brokerageId, supabase)
        published += p.published
        for (const manager of consumers) {
          const c = await consumeManagerSignals({ brokerageId, toManager: manager }, supabase)
          consumed += c.consumed
        }
        // THE HUDDLE — after individual handoffs, convene Team Plays: when ≥2 managers
        // still have open business on the SAME contact, compose ONE coordinated play
        // and supersede the fragments (no more proposal spam for the agent).
        const { runTeamPlays } = await import("@/lib/kernel/team-plays")
        const tp = await runTeamPlays(brokerageId, supabase)
        consumed += tp.fragmentsSuperseded
        // MANAGER DISSENT — after the huddle consolidates, a PEER manager reviews every
        // remaining proposal (Fair Housing, consent, fire-drill timing, spacing) so the
        // human approves pre-vetted work instead of proofreading raw output.
        const { runManagerDissent } = await import("@/lib/kernel/manager-dissent")
        const md = await runManagerDissent(brokerageId, {}, supabase)
        consumed += md.vetoes
        // THE REAPER — no signal falls through the cracks: any handoff stuck "open" past its window
        // (handler kept returning null / threw / unhandled) is escalated to a human + expired, so a
        // real task is never silently lost and the inbox can't accumulate zombie signals forever.
        const { reapStuckManagerSignals } = await import("@/lib/kernel/signal-reaper")
        const rp = await reapStuckManagerSignals(brokerageId, supabase)
        reaped += rp.expired
        escalated += rp.escalated
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: published + consumed,
      metadata: { published, consumed, reaped, escalated, brokerages: brokerages.length, errors: errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, published, consumed, reaped, escalated, brokerages: brokerages.length, errors: errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
