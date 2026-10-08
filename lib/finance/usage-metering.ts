// lib/finance/usage-metering.ts
// ─────────────────────────────────────────────────────────────────────────────
// USAGE METERING ROLLUP (burn-down round 4). The Billing Admin usage dashboard
// reads meter_readings (per-meter current period + 6-month trend) and
// cost_allocation (per-agent / per-team cost split) — both writer-less, so the
// meter cards and trend chart rendered empty forever while the RAW sources
// (usage_events, usage_logs, ai_tool_usage) were being written all along.
// This folds the raw streams into the two derived tables per brokerage per
// month. No unique indexes exist on either table (live-verified) — pass-10
// rule: delete-then-insert per (brokerage, period), never a blind onConflict.

import "server-only"

type Svc = { from: (table: string) => any }

export interface UsageMeteringResult { brokerages: number; meterRows: number; allocationRows: number }

export async function runUsageMeteringRollup(svc: Svc, now: Date = new Date()): Promise<UsageMeteringResult> {
  const out: UsageMeteringResult = { brokerages: 0, meterRows: 0, allocationRows: 0 }
  const periodLabel = now.toISOString().slice(0, 7) // YYYY-MM (the page's read key)
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString()

  const { data: brokerages } = await svc.from("brokerages").select("id").limit(2000)
  const { loadFinancialWriterHalt } = await import("@/lib/kernel/os-health")
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    try {
      // WAVE 108C — THE FINANCIAL-WRITER KILL SWITCH. A tenant whose meters the OS health supervisor
      // found doubled / drifting is HALTED until Finance releases it (tenant policy
      // financial_writer_halts). Fails closed: an unreadable halt state skips the tenant, loudly.
      const halt = await loadFinancialWriterHalt(svc, b.id, "usage_metering")
      if (halt.halted) {
        console.warn(`[usage-metering] ${b.id} skipped — usage_metering halted: ${halt.reason ?? "no reason recorded"}`)
        continue
      }
      // ── RAW STREAMS (the written sources) ────────────────────────────────
      const [{ data: events }, { data: logs }, { data: ai }] = await Promise.all([
        svc.from("usage_events")
          .select("metric, quantity, cost_cents, agent_id, team_id")
          .eq("brokerage_id", b.id).gte("created_at", periodStart).lte("created_at", periodEnd).limit(20000),
        svc.from("usage_logs")
          .select("usage_type, units_used, cost_cents, agent_id")
          .eq("brokerage_id", b.id).gte("recorded_at", periodStart).lte("recorded_at", periodEnd).limit(20000),
        svc.from("ai_tool_usage")
          .select("tokens_used, cost_cents, agent_id, team_id")
          .eq("brokerage_id", b.id).gte("created_at", periodStart).lte("created_at", periodEnd).limit(20000),
      ])
      const ev = (events ?? []) as Array<{ metric: string; quantity: number | null; cost_cents: number | null; agent_id: string | null; team_id: string | null }>
      const lg = (logs ?? []) as Array<{ usage_type: string; units_used: number | null; cost_cents: number | null; agent_id: string | null }>
      const at = (ai ?? []) as Array<{ tokens_used: number | null; cost_cents: number | null; agent_id: string | null; team_id: string | null }>
      if (ev.length === 0 && lg.length === 0 && at.length === 0) continue // honest empty
      out.brokerages++

      // ── METER READINGS: one row per meter_type per period ────────────────
      const meters = new Map<string, { units: number; cost: number }>()
      const addMeter = (type: string, units: number, cost: number) => {
        const m = meters.get(type) ?? { units: 0, cost: 0 }
        m.units += units; m.cost += cost
        meters.set(type, m)
      }
      for (const e of ev) addMeter(e.metric || "other", Number(e.quantity) || 0, Number(e.cost_cents) || 0)
      for (const l of lg) addMeter(l.usage_type || "other", Number(l.units_used) || 0, Number(l.cost_cents) || 0)
      for (const a of at) addMeter("ai_tokens", Number(a.tokens_used) || 0, Number(a.cost_cents) || 0)

      // Delete-then-insert. A REFUSED delete followed by the insert would leave two
      // readings for one period — a doubled meter is a doubled invoice line (§5:
      // "a wrong number there is a wrong invoice"). Refused → skip this tenant's
      // meters this run, loudly; the next run recomputes from the raw streams.
      const { error: meterClearErr } = await svc.from("meter_readings").delete().eq("brokerage_id", b.id).gte("period_start", periodStart)
      if (meterClearErr) {
        console.error(`[usage-metering] meter_readings clear refused for ${b.id} — readings NOT rewritten this run: ${meterClearErr.message}`)
        continue
      }
      const meterRows = [...meters.entries()].map(([meter_type, m]) => ({
        brokerage_id: b.id,
        meter_type,
        period_start: periodStart,
        period_end: periodEnd,
        total_units: m.units,
        total_cost_cents: m.cost,
        computed_at: now.toISOString(),
      }))
      if (meterRows.length > 0) {
        const { error } = await svc.from("meter_readings").insert(meterRows)
        if (!error) out.meterRows += meterRows.length
        else console.error(`[usage-metering] meter_readings insert refused for ${b.id}: ${error.message}`)
      }

      // ── COST ALLOCATION: (agent|team, cost_type) → allocated cents ───────
      // Agent and team are SEPARATE allocation rows (books never cross-roll).
      const alloc = new Map<string, { agent_id: string | null; team_id: string | null; cost_type: string; cents: number }>()
      const addAlloc = (agentId: string | null, teamId: string | null, costType: string, cents: number) => {
        if (cents <= 0 || (!agentId && !teamId)) return
        const key = `${agentId ?? ""}|${teamId ?? ""}|${costType}`
        const a = alloc.get(key) ?? { agent_id: agentId, team_id: teamId, cost_type: costType, cents: 0 }
        a.cents += cents
        alloc.set(key, a)
      }
      for (const e of ev) {
        addAlloc(e.agent_id, null, e.metric || "other", Number(e.cost_cents) || 0)
        if (e.team_id) addAlloc(null, e.team_id, e.metric || "other", Number(e.cost_cents) || 0)
      }
      for (const l of lg) addAlloc(l.agent_id, null, l.usage_type || "other", Number(l.cost_cents) || 0)
      for (const a of at) {
        addAlloc(a.agent_id, null, "ai", Number(a.cost_cents) || 0)
        if (a.team_id) addAlloc(null, a.team_id, "ai", Number(a.cost_cents) || 0)
      }

      // Same delete-then-insert hazard as the meters: refused clear → no re-insert.
      const { error: allocClearErr } = await svc.from("cost_allocation").delete().eq("brokerage_id", b.id).eq("period_label", periodLabel)
      if (allocClearErr) {
        console.error(`[usage-metering] cost_allocation clear refused for ${b.id} — allocation NOT rewritten this run: ${allocClearErr.message}`)
        continue
      }
      const allocRows = [...alloc.values()].map((a) => ({
        brokerage_id: b.id,
        agent_id: a.agent_id,
        team_id: a.team_id,
        cost_type: a.cost_type,
        period_label: periodLabel,
        allocated_cost_cents: a.cents,
        computed_at: now.toISOString(),
      }))
      if (allocRows.length > 0) {
        const { error } = await svc.from("cost_allocation").insert(allocRows)
        if (!error) out.allocationRows += allocRows.length
        else console.error(`[usage-metering] cost_allocation insert refused for ${b.id}: ${error.message}`)
      }
    } catch { /* per-brokerage isolation */ }
  }
  return out
}
