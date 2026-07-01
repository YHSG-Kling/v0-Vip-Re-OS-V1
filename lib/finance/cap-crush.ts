// lib/finance/cap-crush.ts
//
// AUTONOMOUS CAP-CRUSH MOMENT — the Finance Manager acting on the single biggest financial event in an
// agent's year: they pay off their commission cap and now keep 100%. Today the cap-crush only surfaces
// as a RECRUITING proof (weekly, to the broker) — the AGENT is never told, and nothing fires at the
// MOMENT it happens. This detects the crossing right where the cap ledger updates (the final commission
// calc), celebrates the agent, and hands the recruiting proof to the Recruiting Manager on the bus.
//
// The detector is pure/unit-tested; the celebration does the I/O.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/**
 * PURE: did this commission just CROSS the cap? `crushed` = cap is now met/exceeded; `justCrossed` =
 * this calc is the one that crossed it (before < cap ≤ after) — the moment to celebrate exactly once.
 */
export function detectCapCrush(input: {
  capAmount: number | null | undefined
  paidBefore: number | null | undefined
  paidAfter: number | null | undefined
}): { crushed: boolean; justCrossed: boolean } {
  const cap = Number(input.capAmount ?? 0)
  if (!(cap > 0)) return { crushed: false, justCrossed: false }
  const before = Number(input.paidBefore ?? 0)
  const after = Number(input.paidAfter ?? 0)
  const crushed = after >= cap
  const justCrossed = before < cap && after >= cap
  return { crushed, justCrossed }
}

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

/**
 * Celebrate an agent crushing their cap: an agent-facing notification ("you keep 100% now") + the
 * finance → recruiting agent_crushed_cap signal (live recruiting proof; the bus dedupes the open
 * tuple). Deduped so it fires once per cap year (per anniversary window). Best-effort — never blocks
 * the commission calc.
 */
export async function celebrateCapCrush(
  svc: Svc,
  params: { agentId: string; brokerageId: string; capAmount: number; capPaidToDate: number; anniversaryStart?: string | null },
): Promise<{ celebrated: boolean; signaled: boolean }> {
  // Dedupe: one cap-crush celebration per agent per cap year (since the anniversary start, else 300d).
  const since = params.anniversaryStart
    ? new Date(`${params.anniversaryStart}T00:00:00Z`).toISOString()
    : new Date(Date.now() - 300 * 86_400_000).toISOString()
  const { data: existing } = await svc
    .from("notifications")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("type", "cap_crushed")
    .eq("entity_id", params.agentId)
    .gte("created_at", since)
    .limit(1)
  if (existing && existing.length > 0) return { celebrated: false, signaled: false }

  let celebrated = false
  const { data: agent } = await svc.from("agents").select("user_id").eq("id", params.agentId).maybeSingle()
  const userId = (agent as { user_id?: string | null } | null)?.user_id ?? null
  if (userId) {
    await svc.from("notifications").insert({
      user_id: userId,
      brokerage_id: params.brokerageId,
      type: "cap_crushed",
      title: "🎉 You crushed your cap!",
      body: `You've paid ${usd(params.capAmount)} toward your cap — you now keep 100% of your commission for the rest of your anniversary year. Every deal from here is all yours.`,
      entity_type: "agent",
      entity_id: params.agentId,
      priority: "high",
      channel: "in_app",
    }).then(() => { celebrated = true }, () => {})
  }

  let signaled = false
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId: params.brokerageId,
      fromManager: "finance_manager",
      toManager: "recruiting_manager",
      signalType: "agent_crushed_cap",
      entityType: "agent",
      entityId: params.agentId,
      message: `An agent hit their ${usd(params.capAmount)} cap — live proof for the recruiting pitch that agents here hit and blow past cap.`,
      payload: { agent_id: params.agentId, cap_amount: params.capAmount, cap_paid_to_date: params.capPaidToDate },
    })
    signaled = true
  } catch { /* the bus dedupes; a failure here never blocks the celebration */ }

  return { celebrated, signaled }
}
