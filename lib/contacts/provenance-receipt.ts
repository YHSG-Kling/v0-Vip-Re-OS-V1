// lib/contacts/provenance-receipt.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE LIFETIME VALUE RECEIPT (approved item 1) — scrape-to-lifetime provenance.
// Every contact carries "how the OS found you, every touch since, and what it
// earned" — composed ENTIRELY from ledgers the OS already writes (contacts,
// leads, activities, isa_outreach_log, agent_client_messages rationale tags,
// transactions + agent_commissions). No new tables, no new writes.
//
// This is the stat the point-solution CRMs structurally cannot produce: their
// attribution ends at "lead source"; ours runs through the whole egress —
// origin → ISA qualification → frontier stories → closed GCI.
//
// No "server-only" pragma: the composer is pure and the loader takes its
// client as a parameter — the simulator exercises both; the only production
// caller (contact-brief) is itself server-only.

export interface ProvenanceFacts {
  /** How the OS found them (contacts.source, or the earliest linked lead's source). */
  originSource: string | null
  /** When the relationship started (earliest of lead / contact created_at). */
  originAt: string | null
  /** Every logged touch on the activities ledger for this contact. */
  loggedTouches: number
  /** ISA outreach sends to this contact's linked lead(s). */
  isaOutreach: number
  /** Frontier stories delivered (agent_client_messages carrying a [TAG] rationale). */
  frontierStories: number
  /** Closed deals where this contact was the buyer or seller. */
  closedDeals: number
  /** Σ gross commission on those closed deals; null when no ledgered commission. */
  earnedGci: number | null
}

export interface LifetimeValueReceipt {
  /** One agent-facing sentence. */
  line: string
  facts: ProvenanceFacts
}

function monthsBetween(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / (30 * 86_400_000)))
}

/** PURE: fold the facts into one honest sentence. Never invents an origin or
 *  a dollar — unknowns stay unknown, zero-history stays "no touches yet". */
export function composeLifetimeValueReceipt(f: ProvenanceFacts, now: Date = new Date()): LifetimeValueReceipt {
  const originBits: string[] = []
  if (f.originSource) originBits.push(`Found via ${f.originSource.replace(/_/g, " ")}`)
  else originBits.push("Origin unrecorded")
  if (f.originAt) {
    const m = monthsBetween(f.originAt, now)
    originBits.push(m === 0 ? "this month" : `${m} month${m === 1 ? "" : "s"} ago`)
  }

  const touchBits: string[] = []
  if (f.loggedTouches > 0) touchBits.push(`${f.loggedTouches} logged touch${f.loggedTouches === 1 ? "" : "es"}`)
  if (f.isaOutreach > 0) touchBits.push(`${f.isaOutreach} ISA outreach send${f.isaOutreach === 1 ? "" : "s"}`)
  if (f.frontierStories > 0) touchBits.push(`${f.frontierStories} frontier stor${f.frontierStories === 1 ? "y" : "ies"}`)

  const valueBits: string[] = []
  if (f.closedDeals > 0) {
    valueBits.push(`${f.closedDeals} closed deal${f.closedDeals === 1 ? "" : "s"}`)
    if (f.earnedGci != null && f.earnedGci > 0) {
      valueBits.push(`$${Math.round(f.earnedGci).toLocaleString()} GCI earned`)
    }
  }

  const middle =
    touchBits.length > 0 ? ` — the OS has logged ${touchBits.join(", ")}` : " — no AI touch history recorded yet"
  const tail = valueBits.length > 0 ? `, producing ${valueBits.join(" and ")}.` : "."

  return { line: `${originBits.join(" ")}${middle}${tail}`, facts: f }
}

type Svc = { from: (table: string) => any }

// ── THE BROKERAGE ROLLUP (approved item 2) — the same provenance fold, aggregated
// to the number the recruiting pitch and the QBR sell with: "the AI pipeline
// sourced N relationships that closed M deals worth $X GCI this window."

export interface BrokerageProvenanceRollup {
  /** Relationships the OS originated (leads that converted to contacts). */
  osFoundRelationships: number
  /** Closed deals in the window on those OS-found relationships. */
  closedDeals: number
  /** Σ gross commission on those deals (agent_commissions ledger); null when none. */
  aiSourcedGci: number | null
}

/** PURE: one selling sentence — honest null when the pipeline hasn't produced yet. */
export function composeAgentValueRollup(r: BrokerageProvenanceRollup, windowLabel: string): string | null {
  if (r.osFoundRelationships === 0) return null
  const bits = [`The AI pipeline sourced ${r.osFoundRelationships} relationship${r.osFoundRelationships === 1 ? "" : "s"}`]
  if (r.closedDeals > 0) {
    bits.push(`that closed ${r.closedDeals} deal${r.closedDeals === 1 ? "" : "s"}`)
    if (r.aiSourcedGci != null && r.aiSourcedGci > 0) {
      bits.push(`worth $${Math.round(r.aiSourcedGci).toLocaleString("en-US")} GCI`)
    }
  }
  return `${bits.join(" ")} ${windowLabel} — measured on the operating ledger, not estimated.`
}

/** Fold the whole brokerage: OS-found contacts (converted leads) → their closed
 *  deals in the window → ledgered GCI. Same tables as the per-contact receipt. */
export async function loadBrokerageProvenanceRollup(
  svc: Svc, brokerageId: string, sinceIso: string,
): Promise<BrokerageProvenanceRollup> {
  const { data: convertedLeads } = await svc
    .from("leads").select("contact_id").eq("brokerage_id", brokerageId)
    .not("contact_id", "is", null).limit(2000)
  const osContactIds = new Set(((convertedLeads ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id))
  if (osContactIds.size === 0) return { osFoundRelationships: 0, closedDeals: 0, aiSourcedGci: null }

  const { data: closed } = await svc
    .from("transactions").select("id, contact_id, buyer_contact_id, seller_contact_id")
    .eq("brokerage_id", brokerageId).eq("status", "closed")
    .gte("close_date", sinceIso.slice(0, 10)).limit(1000)
  const osDealIds = ((closed ?? []) as Array<{ id: string; contact_id: string | null; buyer_contact_id: string | null; seller_contact_id: string | null }>)
    .filter((t) => [t.contact_id, t.buyer_contact_id, t.seller_contact_id].some((c) => c && osContactIds.has(c)))
    .map((t) => t.id)

  let aiSourcedGci: number | null = null
  if (osDealIds.length > 0) {
    const { data: commissions } = await svc
      .from("agent_commissions").select("gross_commission").in("transaction_id", osDealIds)
    const rows = (commissions ?? []) as Array<{ gross_commission: number | null }>
    if (rows.length > 0) aiSourcedGci = rows.reduce((s, r) => s + (Number(r.gross_commission) || 0), 0)
  }

  return { osFoundRelationships: osContactIds.size, closedDeals: osDealIds.length, aiSourcedGci }
}

/** Load the provenance facts from the real ledgers. Every count is a cheap
 *  head-count query; the GCI fold reads agent_commissions on the contact's
 *  closed deals (the canonical commission ledger — never transactions math). */
export async function loadContactProvenanceFacts(svc: Svc, contactId: string): Promise<ProvenanceFacts> {
  const [{ data: contact }, { data: leadRows }] = await Promise.all([
    svc.from("contacts").select("source, created_at").eq("id", contactId).maybeSingle(),
    svc.from("leads").select("id, source, created_at").eq("contact_id", contactId)
      .order("created_at", { ascending: true }).limit(5),
  ])
  const leads = (leadRows ?? []) as Array<{ id: string; source: string | null; created_at: string | null }>
  const leadIds = leads.map((l) => l.id)

  const [touches, outreach, stories, closed] = await Promise.all([
    svc.from("activities").select("id", { count: "exact", head: true }).eq("contact_id", contactId),
    leadIds.length > 0
      ? svc.from("isa_outreach_log").select("id", { count: "exact", head: true }).in("lead_id", leadIds)
      : Promise.resolve({ count: 0 }),
    svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("recipient_contact_id", contactId).ilike("rationale", "[%"),
    svc.from("transactions").select("id")
      .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
      .eq("status", "closed"),
  ])

  const closedIds = ((closed as any).data ?? []).map((t: { id: string }) => t.id)
  let earnedGci: number | null = null
  if (closedIds.length > 0) {
    const { data: commissions } = await svc
      .from("agent_commissions").select("gross_commission").in("transaction_id", closedIds)
    const rows = (commissions ?? []) as Array<{ gross_commission: number | null }>
    if (rows.length > 0) earnedGci = rows.reduce((s, r) => s + (Number(r.gross_commission) || 0), 0)
  }

  return {
    originSource: leads[0]?.source ?? (contact as any)?.source ?? null,
    originAt: leads[0]?.created_at ?? (contact as any)?.created_at ?? null,
    loggedTouches: (touches as any).count ?? 0,
    isaOutreach: (outreach as any).count ?? 0,
    frontierStories: (stories as any).count ?? 0,
    closedDeals: closedIds.length,
    earnedGci,
  }
}
