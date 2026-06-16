// lib/intelligence/offer-signers.ts
//
// OFFER SIGNERS (pure) — the e-sign send should pull the buyer's contact info automatically, not make
// the agent re-type the signer's name + email. This builds the signer list from the offer's linked
// CRM contacts (buyer + optional co-buyer). Grounded only: a contact with no email is SKIPPED (we
// never invent an address to send a legal document to — a missing email is surfaced, not faked).
// Pure (no I/O), unit-tested directly; the runner pulls the contacts.

export interface SignerContact {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}

export interface ResolvedSigner {
  name: string
  email: string
  role: "buyer" | "co_buyer"
}

function fullName(c: SignerContact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim()
}

/** Build the e-sign signer list from the buyer (and optional co-buyer) contact. Skips missing emails. Pure. */
export function buildSignersFromContacts(buyer: SignerContact | null, coBuyer?: SignerContact | null): ResolvedSigner[] {
  const out: ResolvedSigner[] = []
  const buyerEmail = buyer?.email?.trim()
  if (buyerEmail) out.push({ name: fullName(buyer!) || "Buyer", email: buyerEmail, role: "buyer" })
  const coEmail = coBuyer?.email?.trim()
  if (coEmail) out.push({ name: fullName(coBuyer!) || "Co-Buyer", email: coEmail, role: "co_buyer" })
  return out
}
