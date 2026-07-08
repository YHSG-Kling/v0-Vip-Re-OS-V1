// lib/voice/reception-inventory.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE RECEPTION AI KNOWS THE INVENTORY (owner: "voice ai should have access to
// all tools/skills … this includes for sale properties"). Until now the
// receptionist correctly REFUSED to discuss property details (the no-invention
// rule); the stronger posture is ANSWERING from the tenant's LIVE listings —
// price, beds/baths, sqft, the next open house — with the no-invention rule
// scoped to exactly that list. Serverless-shaped tool use: instead of a
// mid-call tool round-trip, a compact LIVE INVENTORY block is composed per
// turn (recent active listings + any listing the caller's words specifically
// match) and injected into the system prompt, so one model call both knows
// the facts and answers. Numbers trace to listings rows; nothing invented;
// no listings → no block (the original refuse-and-offer-agent rule stands).
// Fair Housing note: the block carries FACTS about PROPERTIES only — never
// neighborhood demographics; the brain's steering prohibition is unchanged.

export interface InventoryListing {
  address: string | null
  city: string | null
  list_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  property_type: string | null
  open_house_event_date: string | null
}

/** PURE: pull address-ish tokens from an utterance (street numbers + words
 *  that look like street names) for the specific-listing match. */
export function extractAddressHints(utterance: string): string[] {
  const hints: string[] = []
  const numbers = utterance.match(/\b\d{1,6}\b/g) ?? []
  hints.push(...numbers.filter((n) => n.length >= 2))
  const streetish = utterance.match(/\b(\w+)\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|circle|cir|trail|trl)\b/gi) ?? []
  hints.push(...streetish)
  return hints.slice(0, 4)
}

const money = (n: number | null): string => (n == null ? "price on request" : `$${Math.round(n).toLocaleString("en-US")}`)

/** PURE: the LIVE INVENTORY prompt block — facts only, capped, with the
 *  no-invention rule scoped to the list. Empty inventory → "" (the brain's
 *  original refusal rule applies untouched). */
export function composeInventoryBlock(listings: InventoryListing[]): string {
  const rows = listings.filter((l) => (l.address ?? "").trim()).slice(0, 8)
  if (rows.length === 0) return ""
  const lines = rows.map((l) => {
    const bits = [
      `${l.address}${l.city ? `, ${l.city}` : ""}`,
      money(l.list_price),
      l.bedrooms != null ? `${l.bedrooms}bd` : null,
      l.bathrooms != null ? `${l.bathrooms}ba` : null,
      l.sqft != null ? `${Math.round(l.sqft).toLocaleString("en-US")} sqft` : null,
      l.property_type || null,
      l.open_house_event_date ? `open house ${l.open_house_event_date}` : null,
    ].filter(Boolean)
    return `- ${bits.join(" · ")}`
  })
  return [
    "LIVE INVENTORY — our current for-sale listings. You may share THESE facts freely; for anything not listed here (or any other property), say the agent will confirm — never invent details:",
    ...lines,
  ].join("\n").slice(0, 1600)
}

/** The lifecycle stages a caller may hear about as "on the market" — the
 *  CANONICAL vocabulary from lib/listing-lifecycle/lifecycle-definitions
 *  (live-verified: stages are UPPERCASE stage names, e.g. MLS_ACTIVE). */
export const DISCUSSABLE_STAGES = [
  "COMING_SOON_ACTIVE", "MLS_ACTIVE", "OPEN_HOUSE_MARKETING",
  "OPEN_HOUSE_EVENT", "SHOWINGS_ACTIVE", "OFFERS_RECEIVED", "NEGOTIATION",
] as const

/** Load the inventory block for a turn: recent active listings + any listing
 *  the caller's words specifically match (address hints prioritized). */
export async function loadInventoryContext(svc: any, brokerageId: string, utterance: string): Promise<string> {
  try {
    const select = "address, city, list_price, bedrooms, bathrooms, sqft, property_type, open_house_event_date"
    const active = svc.from("listings").select(select)
      .eq("brokerage_id", brokerageId).is("deleted_at", null)
      .not("list_price", "is", null)
      .in("lifecycle_stage", [...DISCUSSABLE_STAGES])

    const hints = extractAddressHints(utterance)
    const [{ data: recent }, matched] = await Promise.all([
      active.order("created_at", { ascending: false }).limit(6),
      hints.length > 0
        ? svc.from("listings").select(select)
            .eq("brokerage_id", brokerageId).is("deleted_at", null)
            .or(hints.map((h) => `address.ilike.%${h.replace(/[%,]/g, "")}%`).join(","))
            .limit(3)
            .then((r: any) => r.data ?? [], () => [])
        : Promise.resolve([]),
    ])
    // Specific matches first, dedup by address.
    const seen = new Set<string>()
    const merged: InventoryListing[] = []
    for (const l of [...(matched as any[]), ...((recent ?? []) as any[])]) {
      const key = (l.address ?? "").toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(l)
    }
    return composeInventoryBlock(merged)
  } catch {
    return "" // inventory is an enhancement — a read failure never breaks the call
  }
}
