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
  let lifetimeActions = 0

  try {
    // Brokerages with recent ISA appointments OR open signals.
    // Wave 145 (145F): plus tenants holding an unconsumed contact-arm reactivation signal — the lifetime change action below must
    // reach a signal recorded by a writer other than the bus (e.g. the inbound-intent classifier). DISCOVERY ONLY: 365 days is the
    // clamp ceiling of followup_policy.sphere.lifeEventWindowDays (lib/ai-isa/followup-policy.ts); each tenant's OWN window applies
    // inside runLifetimeChangeActions.
    const [{ data: apptRows }, { data: openRows }, { data: lifetimeRows }] = await Promise.all([
      supabase.from("ai_isa_calls").select("brokerage_id").eq("appointment_set", true)
        .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).limit(2000),
      supabase.from("manager_signals").select("brokerage_id").eq("status", "open").limit(2000),
      supabase.from("signal_reactivations").select("brokerage_id").eq("isa_reactivated", false).not("contact_id", "is", null)
        .gte("triggered_at", new Date(Date.now() - 365 * 86_400_000).toISOString()).limit(2000),
    ])
    const brokerages = Array.from(new Set([
      ...((apptRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id),
      ...((openRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id),
      ...((lifetimeRows ?? []) as Array<{ brokerage_id: string | null }>).map((r) => r.brokerage_id).filter((b): b is string => !!b),
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
        // THE LIFETIME CHANGE ACTION (wave 145, lane 145F — owner ruling 14): the Sphere just answered its life-change lines
        // (respondToLifeChangeSignal → `sphere_signal_recorded`: the signal JOINED signal_reactivations). Each such lifetime signal
        // whose kind puts the home's value in play now gets the in-app equity check (an estimate from verified inputs, via the
        // property_valuation capability) and the homeowner playbook — equity / refinance open ONE governed moment the post-close
        // conductor arbitrates. Ledgered once per signal row; tenant from this loop, never a payload.
        try {
          const { runLifetimeChangeActions } = await import("@/lib/ai-isa/lifetime-change-action")
          const lc = await runLifetimeChangeActions(supabase, brokerageId)
          lifetimeActions += lc.acted
          for (const err of lc.errors.slice(0, 5)) errors.push(`lifetime-change ${brokerageId}: ${err}`)
        } catch (e: any) {
          errors.push(`lifetime-change ${brokerageId}: ${e?.message ?? String(e)}`)
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
        // THE REAPER NET (signals lane) — no signal falls through the cracks: any handoff stuck
        // "open" past its window (handler kept returning null / threw / unhandled) is escalated to a
        // human + expired. Routed through the net so it records to the reaper_runs ledger alongside
        // the proactive-lane reapers (one accountability trail), without double-firing (disjoint lane).
        const { runReaperNet } = await import("@/lib/intelligence/reaper-net")
        const net = await runReaperNet(brokerageId, supabase, { lane: "signals" })
        reaped += net.totals.reaped
        escalated += net.totals.escalated
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    // OS HEALTH & SELF-HEALING (wave 108, lane 108C) — the Cron Manager's health supervisor, the
    // reaper net's "health" lane, on THIS tick over EVERY tenant (the loop above only visits tenants
    // with bus traffic; a tenant whose provider is down or whose reconciler stopped may have none).
    // Each tenant's sweep lands in reaper_runs (domain os_health) — the line the command center reads.
    let healthRecovered = 0, healthEscalated = 0
    try {
      const { data: tenants, error: tenantsErr } = await supabase.from("brokerages").select("id").limit(2000)
      if (tenantsErr) errors.push(`os-health tenants: ${tenantsErr.message}`)
      const { runReaperNet } = await import("@/lib/intelligence/reaper-net")
      // WAVE 147 (lane 147G, contract C14 — owner: "not relying on crons"): completions are watched by their EVENTS and the
      // durable timer (workflows/completion-watch-workflow.ts). This is the NET for what both missed — run BEFORE the health
      // sweep so its stalled_completions detector sees only what the net could not close; everything it recovers is stamped
      // recovered_by = "cron" on the row and in the ledger. Also opens a completion for a support ticket past its SLA (read only).
      const { reconcileOpenCompletions, watchUnresolvedTickets } = await import("@/lib/kernel/completion-tracking")
      // The inbound chain's redriver is handed in HERE, at the composition root (wave 147 integrator): the supervisor no
      // longer imports the chain itself.
      const { inboundCompletionRedrivers } = await import("@/lib/communications/inbound-record")
      const supervision = { redrivers: inboundCompletionRedrivers() }
      for (const t of (tenants ?? []) as Array<{ id: string }>) {
        try {
          const tk = await watchUnresolvedTickets(supabase, t.id)
          if (tk.error) errors.push(`completions ${t.id}: ${tk.error}`)
          const rc = await reconcileOpenCompletions(supabase, t.id, {}, supervision)
          healthRecovered += rc.recovered
          healthEscalated += rc.escalated
          for (const err of rc.errors.slice(0, 3)) errors.push(`completions ${t.id}: ${err}`)
        } catch (e: any) {
          errors.push(`completions ${t.id}: ${e?.message ?? String(e)}`)
        }
        try {
          const h = await runReaperNet(t.id, supabase, { lane: "health" })
          healthRecovered += h.totals.reaped
          healthEscalated += h.totals.escalated
        } catch (e: any) {
          errors.push(`os-health ${t.id}: ${e?.message ?? String(e)}`)
        }
      }
    } catch (e: any) {
      errors.push(`os-health: ${e?.message ?? String(e)}`)
    }
    reaped += healthRecovered
    escalated += healthEscalated

    // CROSS-MANAGEMENT (round 34; registry-driven since round 36) — the referral SWEEP
    // emitters run from the REFERRAL_EMITTERS registry: the Cron Manager's approval-SLA
    // sweep (approval_queue_slo), the AI ISA's lead-quality sweep (lead_quality_spend,
    // deliberative) and the Recruiting Manager's offer-terms sweep
    // (recruiting_offer_economics, deliberative). Cross-tenant + recency-deduped inside
    // each sweep over the bus ledger itself; adding a sweep to the registry auto-joins it
    // here. The referrals published are consumed by the shared referral handler on the
    // NEXT consume pass (deliberative domains escalate to the full argued deliberation).
    try {
      const { runReferralSweeps } = await import("@/lib/managers/cross-referral")
      const sweeps = await runReferralSweeps(supabase)
      published += sweeps.published
      for (const err of sweeps.errors.slice(0, 10)) errors.push(`referral-sweep: ${err}`)
    } catch (e: any) {
      errors.push(`referral-sweeps: ${e?.message ?? String(e)}`)
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: published + consumed,
      metadata: { published, consumed, reaped, escalated, lifetime_actions: lifetimeActions, health_recovered: healthRecovered, health_escalated: healthEscalated, brokerages: brokerages.length, errors: errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, published, consumed, reaped, escalated, lifetimeActions, brokerages: brokerages.length, errors: errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
