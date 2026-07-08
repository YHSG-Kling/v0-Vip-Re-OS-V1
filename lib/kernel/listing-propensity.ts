// lib/kernel/listing-propensity.ts
// ─────────────────────────────────────────────────────────────────────────────
// LISTING PROPENSITY — the Fello counter, on THEIR home turf, closing OUR
// loop. Fello's edge is daily enrichment answering "who's likely to move";
// this scorer answers it from signals WE ALREADY OWN — no new vendor, no new
// model service, deterministic weights over ledger rows (every point traces
// to a record; nothing predicted from thin air):
//   · checked their home's value recently (home_value_estimates)   — strongest
//   · high estimated equity on that check                          — strong
//   · said "sell"-intent on an AI call (call_analyses.intent_primary)
//   · a seller hand-raise already proposed ([SELLER_LEAD])         — corroborating
//   · equity-trigger touch this quarter ([EQUITY]/anniversary rail)
// Output flows into the EXISTING seller plays: one gated weekly brief per
// agent naming their top ready-to-list homeowners (proposal rail, deduped per
// ISO week) — the Listing Concierge takes it from there. Nothing auto-sends.

export interface PropensitySignals {
  homeValueChecks90d: number
  latestEstimatedEquity: number | null
  sellIntentCalls90d: number
  sellerHandRaises90d: number
  equityTouches90d: number
  isAlreadySeller: boolean
}

export interface PropensityScore {
  score: number // 0–100
  reasons: string[]
}

export const PROPENSITY_BRIEF_THRESHOLD = 55

/** PURE: deterministic weights over owned-ledger signals. */
export function scoreListingPropensity(s: PropensitySignals): PropensityScore {
  if (s.isAlreadySeller) return { score: 0, reasons: ["already an active seller — worked by the listing plays, not scored"] }
  let score = 0
  const reasons: string[] = []
  if (s.homeValueChecks90d > 0) {
    score += Math.min(s.homeValueChecks90d, 3) * 15
    reasons.push(`checked their home's value ${s.homeValueChecks90d}× in 90 days`)
  }
  if ((s.latestEstimatedEquity ?? 0) >= 100_000) {
    score += 20
    reasons.push(`~$${Math.round((s.latestEstimatedEquity ?? 0) / 1000)}k estimated equity`)
  }
  if (s.sellIntentCalls90d > 0) {
    score += 25
    reasons.push(`voiced sell intent on ${s.sellIntentCalls90d} AI call${s.sellIntentCalls90d === 1 ? "" : "s"}`)
  }
  if (s.sellerHandRaises90d > 0) {
    score += 20
    reasons.push("asked what their home is worth (seller hand-raise on record)")
  }
  if (s.equityTouches90d > 0) {
    score += 10
    reasons.push("engaged an equity-anniversary touch this quarter")
  }
  return { score: Math.min(100, score), reasons }
}

/** PURE: the weekly brief line for an agent's ready-to-list homeowners. */
export function composePropensityBrief(rows: Array<{ name: string; score: number; reasons: string[] }>): string {
  if (rows.length === 0) return ""
  const lines = rows.slice(0, 5).map((r) =>
    `${r.name} (${r.score}/100): ${r.reasons.slice(0, 2).join("; ")}`)
  return `${rows.length} homeowner${rows.length === 1 ? "" : "s"} in your database look ready to list — approve and the Listing Concierge starts the pre-list play. Top: ${lines.join(" · ")}`
}

export interface PropensityRunResult { brokerages: number; contactsScored: number; briefsProposed: number; errors: number }

/** Weekly runner: score signal-bearing contacts per brokerage → ONE gated
 *  brief per agent with ready-to-list homeowners (deduped per ISO week). */
export async function runListingPropensity(svc: any, now: Date = new Date()): Promise<PropensityRunResult> {
  const r: PropensityRunResult = { brokerages: 0, contactsScored: 0, briefsProposed: 0, errors: 0 }
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString()
  const isoWeek = `${now.toISOString().slice(0, 10)}`.slice(0, 7) + `-W${Math.ceil(((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)}`

  const { data: brokerages } = await svc.from("brokerages").select("id").limit(2000)
  for (const b of (brokerages ?? []) as any[]) {
    r.brokerages += 1
    try {
      // Signal-bearing contacts only (home-value checks are the seed set —
      // scoring every contact would be noise, not intelligence).
      const { data: estimates } = await svc.from("home_value_estimates")
        .select("contact_id, estimated_equity, generated_at")
        .eq("brokerage_id", b.id).not("contact_id", "is", null)
        .gte("generated_at", since).limit(1000)
      const byContact = new Map<string, { checks: number; equity: number | null }>()
      for (const e of (estimates ?? []) as any[]) {
        const cur = byContact.get(e.contact_id) ?? { checks: 0, equity: null }
        cur.checks += 1
        cur.equity = Math.max(cur.equity ?? 0, Number(e.estimated_equity ?? 0)) || cur.equity
        byContact.set(e.contact_id, cur)
      }
      if (byContact.size === 0) continue
      const ids = [...byContact.keys()]

      const [{ data: contacts }, { data: intents }, { data: handRaises }] = await Promise.all([
        svc.from("contacts").select("id, first_name, last_name, contact_type, agent_id").eq("brokerage_id", b.id).in("id", ids),
        svc.from("call_analyses").select("contact_id").eq("brokerage_id", b.id).in("contact_id", ids)
          .ilike("intent_primary", "%sell%").gte("created_at", since).limit(500),
        svc.from("agent_client_messages").select("entity_id").eq("brokerage_id", b.id)
          .ilike("rationale", "[SELLER_LEAD]%").in("entity_id", ids).gte("created_at", since).limit(500),
      ])
      const intentSet = new Map<string, number>()
      for (const i of (intents ?? []) as any[]) intentSet.set(i.contact_id, (intentSet.get(i.contact_id) ?? 0) + 1)
      const raiseSet = new Set(((handRaises ?? []) as any[]).map((h) => h.entity_id))

      // Score → group ready-to-list by owning agent.
      const byAgent = new Map<string, Array<{ name: string; score: number; reasons: string[] }>>()
      for (const c of (contacts ?? []) as any[]) {
        r.contactsScored += 1
        const sig = byContact.get(c.id)!
        const { score, reasons } = scoreListingPropensity({
          homeValueChecks90d: sig.checks,
          latestEstimatedEquity: sig.equity,
          sellIntentCalls90d: intentSet.get(c.id) ?? 0,
          sellerHandRaises90d: raiseSet.has(c.id) ? 1 : 0,
          equityTouches90d: 0, // the equity rail corroborates via hand-raises; kept honest at 0 here
          isAlreadySeller: c.contact_type === "seller",
        })
        if (score < PROPENSITY_BRIEF_THRESHOLD || !c.agent_id) continue
        const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "A homeowner"
        const list = byAgent.get(c.agent_id) ?? []
        list.push({ name, score, reasons })
        byAgent.set(c.agent_id, list)
      }

      for (const [agentId, rows] of byAgent.entries()) {
        rows.sort((a, x) => x.score - a.score)
        const tag = `[PROPENSITY] [${agentId}] [${isoWeek}]`
        const { data: dup } = await svc.from("agent_client_messages").select("id")
          .ilike("rationale", `${tag}%`).limit(1).maybeSingle()
        if (dup) continue
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const p = await proposeClientMessage({
          brokerageId: b.id, agentKind: "listing_concierge",
          entityType: "agent", entityId: agentId, audience: "agent",
          subject: `${rows.length} homeowner${rows.length === 1 ? "" : "s"} look ready to list`,
          body: composePropensityBrief(rows),
          rationale: `${tag} — deterministic propensity over owned ledgers (home-value checks, equity, sell-intent calls, hand-raises); every point traces to a record.`,
        }, svc)
        if ((p as any)?.ok !== false) r.briefsProposed += 1
      }
    } catch { r.errors += 1 }
  }
  return r
}
