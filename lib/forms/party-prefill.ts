/**
 * lib/forms/party-prefill.ts — PURE: map the deal's PARTIES onto a form's name fields.
 *
 * The Fill step prefilled only the property block (lib/forms/prefill-property-into-pdf.ts),
 * so every listing agreement and offer made the agent re-type the seller/buyer and their
 * own name even though the wizard already holds them (the contact it was opened from and
 * the agent's own profile). This adds exactly those names — never a price, a date, a term
 * or a signature — and only onto fields whose NAME says which party they are for.
 *
 * Grounded: every value is a party the agent confirmed in the wizard; a field whose party
 * is ambiguous (e.g. "Name 1") is left blank. Signature/initial/date/email/phone fields are
 * never touched.
 */

export interface DealParties {
  mode: "offer" | "listing"
  buyers: string[]
  sellers: string[]
  agentName?: string | null
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

const NEVER = /\b(sig|sign|signature|initial|initials|date|dated|email|e mail|phone|tel|fax|address|license|lic|number|no|id|mls|price|amount)\b/

function ordinal(n: string): number {
  const m = n.match(/\b(\d)\b/) ?? n.match(/(\d)\s*$/)
  if (m) return Math.max(0, Number(m[1]) - 1)
  if (/\b(second|2nd|co)\b/.test(n)) return 1
  return 0
}

/** PURE: which party a field names, or null.
 */
function partyForField(fieldName: string, mode: "offer" | "listing"): { party: "buyer" | "seller" | "agent"; index: number } | null {
  const n = norm(fieldName)
  if (!/\bname\b|\bnames\b|\bprinted\b|\bprint\b/.test(n)) return null
  if (NEVER.test(n.replace(/\bname(s)?\b/g, ""))) return null
  const agentWord = /\b(agent|licensee|associate|salesperson|realtor)\b/.test(n)
  if (agentWord) {
    const ourSide = mode === "offer"
      ? /\b(buyer s|buyers|buyer|selling|cooperating)\b/.test(n) || !/\b(listing|seller|sellers)\b/.test(n)
      : /\b(listing|seller s|sellers|seller)\b/.test(n) || !/\b(buyer|buyers|selling|cooperating)\b/.test(n)
    return ourSide ? { party: "agent", index: 0 } : null
  }
  if (/\b(broker|brokerage|firm|company|title|escrow|lender)\b/.test(n)) return null
  if (/\b(buyer|buyers|purchaser|purchasers)\b/.test(n)) return { party: "buyer", index: ordinal(n) }
  if (/\b(seller|sellers|owner|owners)\b/.test(n)) return { party: "seller", index: ordinal(n) }
  return null
}

/** PURE: the { name, value } pairs to fill, and the recognised party fields left blank. */
export function buildPartyPrefill(fieldNames: string[], parties: DealParties): { filled: Array<{ name: string; value: string }>; unresolved: string[] } {
  const filled: Array<{ name: string; value: string }> = []
  const unresolved: string[] = []
  for (const f of fieldNames) {
    const p = partyForField(f, parties.mode)
    if (!p) continue
    const list = p.party === "buyer" ? parties.buyers : p.party === "seller" ? parties.sellers : [parties.agentName ?? ""]
    const plural = /\b(buyers|sellers|purchasers|owners|names)\b/.test(norm(f))
    const value = plural && p.party !== "agent"
      ? list.map((x) => x.trim()).filter(Boolean).join(" and ")
      : (list[p.index] ?? "").trim()
    if (value) filled.push({ name: f, value })
    else unresolved.push(f)
  }
  return { filled, unresolved }
}
