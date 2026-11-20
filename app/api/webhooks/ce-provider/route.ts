import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCeSignature, normalizeCeCompletion, sumCeHours, type CeCompletionPayload } from "@/lib/education/ce-provider"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

/**
 * ACCREDITED CE PROVIDER WEBHOOK — the connected provider reports a completed accredited course; the app
 * records the credit into agent_ce_completions and bumps the agent's CE hours so license-readiness sees it.
 * Signature-verified (HMAC-SHA256 with CE_PROVIDER_WEBHOOK_SECRET). The platform never invents CE credit —
 * it only records what an accredited provider verifiably reports.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CE_PROVIDER_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: "CE provider webhook secret not configured" }, { status: 500 })

  const raw = await req.text()
  const sig = req.headers.get("x-ce-signature")
  if (!verifyCeSignature(raw, sig, secret)) {
    return NextResponse.json({ error: "signature verification failed" }, { status: 400 })
  }

  let payload: CeCompletionPayload
  try { payload = JSON.parse(raw) } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }) }

  const agentRef = payload.agent_id ?? payload.agent_external_id
  if (!agentRef || !payload.course_name || !payload.completed_on) {
    return NextResponse.json({ error: "missing agent ref / course / completion date" }, { status: 400 })
  }

  try {
    const svc = createServiceClient()
    const { data: agent } = await svc.from("agents").select("id, brokerage_id").eq("id", agentRef).maybeSingle()
    if (!agent) return NextResponse.json({ ok: true, ignored: true, reason: "unknown agent" })
    const a = agent as { id: string; brokerage_id: string | null }

    // Provider name from the brokerage's connected config (falls back to the payload-declared provider).
    let providerName = "Accredited CE Provider"
    if (a.brokerage_id) {
      const { data: bs } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", a.brokerage_id).maybeSingle()
      const cfg = (((bs as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as any).ce_provider
      if (cfg?.name) providerName = cfg.name
    }

    const result = await recordCeCompletionFromProvider(payload, { agentId: a.id, brokerageId: a.brokerage_id, providerName })
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 })
  }
}

/**
 * Record a verified CE completion the accredited provider reported (called by the webhook). Inserts into
 * agent_ce_completions, then recomputes agents.ce_hours_completed from the full ledger (idempotent) so the
 * license-readiness engine sees the new credit. Never fabricates — only writes what the provider reported.
 * MOVED HERE (wave 155, lane 155R5) from app/actions/ce-provider.ts, where as a "use server" export it was a public endpoint
 * that skipped this route's signature check; now reachable only after verifyCeSignature above.
 */
async function recordCeCompletionFromProvider(
  payload: CeCompletionPayload,
  ctx: { agentId: string; brokerageId: string | null; providerName: string },
): Promise<{ recorded: boolean; ceHoursCompleted: number }> {
  const svc = createServiceClient()
  // CLAUDE.md §4 — the tenant comes from the AGENT ROW the provider named, never from the caller's
  // ctx: the webhook's brokerage claim is shadowed by what the database says about that agent. A
  // refused or empty read fails closed (nothing recorded, nothing emitted).
  const { data: agentRow, error: agentErr } = await svc.from("agents").select("brokerage_id").eq("id", ctx.agentId).maybeSingle()
  if (agentErr || !agentRow?.brokerage_id) return { recorded: false, ceHoursCompleted: 0 }
  const brokerageId: string = agentRow.brokerage_id
  const row = normalizeCeCompletion(payload, { ...ctx, brokerageId })

  // Idempotency: one completion per (agent, course, completed_on).
  const { data: existing } = await svc.from("agent_ce_completions").select("id").eq("agent_id", ctx.agentId).eq("course_name", row.course_name).eq("completed_on", row.completed_on).limit(1).maybeSingle()
  if (!existing) {
    const { data: inserted, error } = await svc.from("agent_ce_completions").insert(row).select("id").single()
    if (error) return { recorded: false, ceHoursCompleted: 0 }
    // CE_COMPLETED (wave 103, lane 103C): the ledger row had no event, so the OS never
    // recognised a completed credit. The reactor awards CE_COMPLETED points once per
    // completion row (lib/gamification/award-points.ts LIFECYCLE_AWARD_RULES).
    if (inserted?.id) {
      try {
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        const { KernelEvent } = await import("@/lib/kernel/events")
        await emitKernelEvent({
          event:       KernelEvent.CE_COMPLETED,
          brokerageId,
          entityType:  "agent_ce_completion",
          entityId:    inserted.id,
          source:      "webhook",
          metadata:    { agent_id: ctx.agentId, course_name: row.course_name, hours: row.hours, provider: ctx.providerName },
        })
      } catch (err) {
        console.error(`[recordCeCompletionFromProvider] CE_COMPLETED did not emit for ${inserted.id}:`, err)
      }
    }
  }

  const { data: all } = await svc.from("agent_ce_completions").select("hours").eq("agent_id", ctx.agentId).limit(500)
  const total = sumCeHours((all ?? []) as Array<{ hours: number | null }>)
  await sentinelWrite(svc, svc.from("agents").update({ ce_hours_completed: total }).eq("id", ctx.agentId), { table: "agents", flow: "agent_ce_hours_cache", reason: "agents.ce_hours_completed is a derived cache of agent_ce_completions (the ledger, already written); recomputed on every completion" })
  return { recorded: true, ceHoursCompleted: total }
}
