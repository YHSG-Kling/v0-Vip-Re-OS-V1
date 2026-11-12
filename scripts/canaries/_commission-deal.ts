/**
 * scripts/canaries/_commission-deal.ts — the wave-144 money canaries' DEAL FIXTURE (lane 144J).
 *
 * NOT A SECOND ENGINE: it seeds the in-memory client exactly as scripts/agreement-waterfall-guard.ts seeds it (the shape
 * lib/commission/engine.ts calculateCommission reads — the eleven waterfall stages run for real) and calls the ONE engine.
 * Every synthetic tenant carries CANARY_TAG so cleanupCanary deletes it with counts.
 */
import { CANARY_TAG, canaryClient, setSvc, uuid, type CanarySvc } from "./_harness"

export interface CanaryDeal {
  B: string; A: string; U: string; T: string; C: string
  close: string
  price: number
  /** commission_percentage on the deal (3 → 3 %). */
  ratePct: number
  /** the agent's split percent in the agreement version in force. */
  split: number
  /** extra agreement-version terms (royalty_value, cap_amount …) — the agreement is the source of every term. */
  terms?: Record<string, unknown>
  extra?: Record<string, Array<Record<string, unknown>>>
  transaction?: Record<string, unknown>
}

export const newDeal = (over: Partial<CanaryDeal> = {}): CanaryDeal => ({
  B: uuid(), A: uuid(), U: uuid(), T: uuid(), C: uuid(), close: new Date().toISOString().slice(0, 10), price: 400_000, ratePct: 3, split: 70, ...over,
})

export function seedDeal(d: CanaryDeal): Record<string, Array<Record<string, unknown>>> {
  const base: Record<string, Array<Record<string, unknown>>> = {
    brokerages: [{ id: d.B, name: `${CANARY_TAG} Money Brokerage`, revenue_share_enabled: false }],
    agents: [{ id: d.A, brokerage_id: d.B, user_id: d.U, team_id: null }],
    transactions: [{ id: d.T, brokerage_id: d.B, agent_id: d.A, purchase_price: d.price, commission_percentage: d.ratePct, close_date: d.close, status: "closed", contact_id: d.C, ...(d.transaction ?? {}) }],
    commission_structures: [{ id: uuid(), brokerage_id: d.B, is_default: true, is_active: true, base_percentage: d.ratePct }],
    agent_commission_profiles: [{ id: uuid(), agent_id: d.A, brokerage_id: d.B, is_active: true, split_percent: d.split, effective_date: "2020-01-01", ...(d.terms ?? {}) }],
    agent_commission_profile_versions: [{ id: uuid(), agent_id: d.A, brokerage_id: d.B, effective_from: "2020-01-01", terms: { split_percent: d.split, is_active: true, ...(d.terms ?? {}) }, recorded_at: "2020-01-01T00:00:00Z" }],
    commission_adjustments: [],
    referrals: [],
    contract_signatures: [],
  }
  for (const [t, rows] of Object.entries(d.extra ?? {})) base[t] = [...(base[t] ?? []), ...rows]
  return base
}

export type EngineResult = Awaited<ReturnType<typeof import("../../lib/commission/engine").calculateCommission>>

/** Run the REAL engine on the deal in memory; console.warn (the engine's findings) is muted and returned. */
export async function runEngine(d: CanaryDeal, opts: { svc?: CanarySvc; mode?: "final" | "preview" } = {}): Promise<{ r: EngineResult; svc: CanarySvc; warnings: string[] }> {
  const svc = opts.svc ?? canaryClient(seedDeal(d) as never)
  setSvc(svc)
  const { calculateCommission } = await import("../../lib/commission/engine")
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")) }
  try {
    const r = await calculateCommission({ transactionId: d.T, brokerageId: d.B, calculationMode: opts.mode ?? "final", triggeredBy: null })
    return { r, svc, warnings }
  } finally { console.warn = origWarn }
}

export const cents = (n: unknown): number => Math.round(Number(n) * 100)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- in-memory rows
export const rowsOf = (svc: CanarySvc, t: string) => (svc.tables[t] ?? []) as Array<Record<string, any>>
