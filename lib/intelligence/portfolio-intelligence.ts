// lib/intelligence/portfolio-intelligence.ts
//
// PORTFOLIO INTELLIGENCE (deal_coordinator → broker) — the brokerage-scale
// lens two shine items share (one loader, two composers, no drift):
//   #7 CROSS-PORTFOLIO STRATEGY ADVISOR — "where should I deploy agents,
//      budget, and marketing?" — the regional-VP call.
//   #9 PORTFOLIO RISK & OPPORTUNITY LENS — rising vs declining ZIPs,
//      underused farms, where the book is thin.
//
// OWNER CORRECTION: this is grounded in the agent's MANAGED BOOK — CONTACTS,
// the relationships they own — NOT the platform-paid lead territory
// (territory_metrics is subscription-included lead volume, not the agent's
// book). We aggregate contacts by ZIP and how many CONVERTED to a closed
// deal (contacts → transactions), joined to farm_territories (which ZIPs the
// brokerage actually farms). That is the true "where is our business" map.
//
// HONEST by construction: a ZIP needs MIN_ZIP_CONTACTS before its close rate
// is signal (thin data is never a verdict); no contacts at all → an empty
// read, never invented strategy. Pure composers; the loader is best-effort.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const MIN_ZIP_CONTACTS = 8    // a farm needs a real book before its close rate counts
export const HOT_CLOSE_RATE = 0.10   // ≥10% of the book in a ZIP closing = a lane to lean into
export const COLD_CLOSE_RATE = 0.02  // ≤2% with volume = a book that isn't converting

export interface ZipBook {
  zip: string
  contacts: number
  closedDeals: number
  closeRate: number
  /** Is the brokerage actively farming this ZIP (farm_territories)? */
  farmed: boolean
}

export interface StrategyMove { key: string; zip: string | null; line: string }
export interface RiskOpportunity { kind: "opportunity" | "risk"; zip: string; line: string }

export interface PortfolioRead {
  zips: number
  totalContacts: number
  strategy: StrategyMove[]
  riskOps: RiskOpportunity[]
}

/** PURE: fold contact rows (+ which contact ids closed a deal) into per-ZIP books. */
export function aggregateContactBook(
  contacts: Array<{ id: string; zip: string | null }>,
  closedContactIds: Set<string>,
  farmedZips: Set<string>,
): ZipBook[] {
  const byZip = new Map<string, { contacts: number; closed: number }>()
  for (const c of contacts) {
    const raw = (c.zip ?? "").trim()
    if (!/^\d{5}/.test(raw)) continue
    const z = raw.slice(0, 5)
    const e = byZip.get(z) ?? { contacts: 0, closed: 0 }
    e.contacts += 1
    if (closedContactIds.has(c.id)) e.closed += 1
    byZip.set(z, e)
  }
  return [...byZip.entries()].map(([zip, e]) => ({
    zip,
    contacts: e.contacts,
    closedDeals: e.closed,
    closeRate: e.contacts > 0 ? e.closed / e.contacts : 0,
    farmed: farmedZips.has(zip),
  }))
}

/** PURE #7: deploy-agents/budget moves from the managed book. Sample-gated. */
export function composeStrategyMoves(books: ZipBook[]): StrategyMove[] {
  const proven = books.filter((b) => b.contacts >= MIN_ZIP_CONTACTS)
  const out: StrategyMove[] = []
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

  // Lean IN: a proven-converting ZIP the brokerage is NOT farming = the clearest move.
  const hotUnfarmed = proven.filter((b) => b.closeRate >= HOT_CLOSE_RATE && !b.farmed)
    .sort((a, b) => b.closeRate - a.closeRate)[0]
  if (hotUnfarmed) {
    out.push({
      key: "lean_in", zip: hotUnfarmed.zip,
      line: `Plant your flag in ${hotUnfarmed.zip}: ${hotUnfarmed.closedDeals} of your ${hotUnfarmed.contacts} contacts there have closed (${pct(hotUnfarmed.closeRate)}) and you're not farming it yet — your book is already telling you where the business is.`,
    })
  }

  // BIGGEST BOOK unfarmed: a large relationship base with no farm behind it.
  const bigUnfarmed = proven.filter((b) => !b.farmed).sort((a, b) => b.contacts - a.contacts)[0]
  if (bigUnfarmed && (!hotUnfarmed || bigUnfarmed.zip !== hotUnfarmed.zip)) {
    out.push({
      key: "farm_the_book", zip: bigUnfarmed.zip,
      line: `You have ${bigUnfarmed.contacts} contacts in ${bigUnfarmed.zip} with no farm around them — a monthly touch to a base that size is the cheapest listings you'll ever earn.`,
    })
  }

  // PULL BACK: a farmed ZIP where the book isn't converting = re-examine the spend.
  const coldFarmed = proven.filter((b) => b.closeRate <= COLD_CLOSE_RATE && b.farmed)
    .sort((a, b) => a.closeRate - b.closeRate)[0]
  if (coldFarmed) {
    out.push({
      key: "pull_back", zip: coldFarmed.zip,
      line: `Re-examine ${coldFarmed.zip}: you're farming ${coldFarmed.contacts} contacts there but only ${pct(coldFarmed.closeRate)} have closed — either the book needs nurture or the budget works harder in a proven lane.`,
    })
  }
  return out
}

/** PURE #9: rising/declining segments from the managed book. */
export function composeRiskOpportunities(books: ZipBook[]): RiskOpportunity[] {
  const proven = books.filter((b) => b.contacts >= MIN_ZIP_CONTACTS)
  const out: RiskOpportunity[] = []
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`
  for (const b of proven.filter((b) => b.closeRate >= HOT_CLOSE_RATE).sort((a, b) => b.closeRate - a.closeRate).slice(0, 2)) {
    out.push({ kind: "opportunity", zip: b.zip, line: `${b.zip} is your strongest segment — ${pct(b.closeRate)} of your ${b.contacts} contacts there have closed${b.farmed ? "" : ", and it isn't even farmed yet"}.` })
  }
  for (const b of proven.filter((b) => b.closeRate <= COLD_CLOSE_RATE).sort((a, b) => a.closeRate - b.closeRate).slice(0, 2)) {
    out.push({ kind: "risk", zip: b.zip, line: `${b.zip} is underconverting — ${b.contacts} contacts, only ${pct(b.closeRate)} closed; the relationships are there but the business isn't following.` })
  }
  return out
}

/** Load the managed book (contacts + which closed) + farmed ZIPs, then compose both lenses. */
export async function loadPortfolioIntelligence(svc: Svc, brokerageId: string): Promise<PortfolioRead> {
  const [{ data: contactRows }, { data: farms }] = await Promise.all([
    svc.from("contacts").select("id, zip_code, mailing_zip").eq("brokerage_id", brokerageId).limit(20000),
    svc.from("farm_territories").select("zip_codes").eq("brokerage_id", brokerageId).eq("is_active", true).limit(500),
  ])

  const contacts = ((contactRows ?? []) as any[]).map((c) => ({ id: c.id as string, zip: (c.zip_code ?? c.mailing_zip ?? null) as string | null }))

  // Which of these contacts CONVERTED to a closed deal (contacts → transactions).
  const closedContactIds = new Set<string>()
  if (contacts.length > 0) {
    const { data: closed } = await svc.from("transactions")
      .select("contact_id, buyer_contact_id").eq("brokerage_id", brokerageId).eq("status", "closed").limit(20000)
    for (const t of ((closed ?? []) as any[])) {
      if (t.contact_id) closedContactIds.add(t.contact_id)
      if (t.buyer_contact_id) closedContactIds.add(t.buyer_contact_id)
    }
  }

  const farmedZips = new Set<string>()
  for (const f of ((farms ?? []) as any[])) {
    for (const z of ((f.zip_codes ?? []) as string[])) {
      if (typeof z === "string" && /^\d{5}/.test(z)) farmedZips.add(z.slice(0, 5))
    }
  }

  const books = aggregateContactBook(contacts, closedContactIds, farmedZips)
  return {
    zips: books.length,
    totalContacts: contacts.length,
    strategy: composeStrategyMoves(books),
    riskOps: composeRiskOpportunities(books),
  }
}

/** Monthly gated broker brief carrying the top strategy move + top risk. Idempotent per (brokerage, month). */
export async function runPortfolioAdvisor(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<{ proposed: boolean }> {
  const read = await loadPortfolioIntelligence(svc, brokerageId)
  if (read.strategy.length === 0 && read.riskOps.length === 0) return { proposed: false }
  const tag = `portfolio_advisor:${now.toISOString().slice(0, 7)}`
  const { data: dup } = await svc.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).ilike("rationale", `%${tag}%`).limit(1).maybeSingle()
  if (dup) return { proposed: false }

  const body = [
    "This month's portfolio read, from your own book of business (the contacts you manage, not paid leads):",
    "",
    ...read.strategy.map((m, i) => `${i + 1}. ${m.line}`),
    ...read.riskOps.filter((r) => r.kind === "risk").slice(0, 1).map((r) => `• Watch: ${r.line}`),
  ].join("\n")

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  await proposeClientMessage({
    brokerageId, agentKind: "deal_coordinator", entityType: "brokerage", entityId: brokerageId,
    audience: "agent", subject: "Where to deploy next month — your portfolio read",
    body, rationale: `${tag} — cross-portfolio strategy + risk from the managed contact book (${read.zips} ZIPs, ${read.totalContacts} contacts); broker decides, nothing moves automatically.`,
    channel: "portal",
  }).catch(() => {})
  return { proposed: true }
}

/** Autonomous: brokerage/multi-location tiers, monthly (rides the weekly recruit-outreach cron, month-idempotent). */
export async function runPortfolioAdvisorAll(svc: Svc): Promise<{ brokerages: number; proposed: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id, plan_tier").in("plan_tier", ["brokerage", "multi_location"]).limit(500)
  let proposed = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runPortfolioAdvisor(svc, b.id).catch(() => null)
    if (r?.proposed) proposed++
  }
  return { brokerages: (brokerages ?? []).length, proposed }
}
